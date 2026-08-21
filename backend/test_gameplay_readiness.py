"""Focused tests for the gameplay readiness and health gates."""
from __future__ import annotations

import asyncio
import os
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException


HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("MONGO_URL", "mongodb://127.0.0.1:27017")
os.environ.setdefault("DB_NAME", "gameplay_readiness_test")
os.environ.setdefault("AVIATOR_RETURN_FACTOR", "0.945")

import game_engines  # noqa: E402
import server  # noqa: E402


class GameplayReadinessTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.original_ready = server._GAMEPLAY_READY
        self.original_lock = server._GAMEPLAY_READINESS_LOCK
        server._GAMEPLAY_READY = False
        server._GAMEPLAY_READINESS_LOCK = asyncio.Lock()

    async def asyncTearDown(self):
        server._GAMEPLAY_READY = self.original_ready
        server._GAMEPLAY_READINESS_LOCK = self.original_lock

    @staticmethod
    def _database():
        return SimpleNamespace(
            command=AsyncMock(return_value={"ok": 1}),
            system_config=SimpleNamespace(find_one=AsyncMock(return_value={"key": "main"})),
        )

    async def test_prepare_gameplay_core_verifies_indexes_and_transaction(self):
        database = self._database()
        indexes = AsyncMock()
        transaction_sessions = []

        async def run_transaction(client, callback):
            session = object()
            transaction_sessions.append((client, session))
            return await callback(session)

        with (
            patch.object(server, "db", database),
            patch.object(server, "_core_indexes", indexes),
            patch.object(server, "run_game_transaction", side_effect=run_transaction) as transaction,
        ):
            await server._prepare_gameplay_core()

        indexes.assert_awaited_once_with()
        transaction.assert_awaited_once()
        self.assertIs(transaction_sessions[0][0], server.client)
        database.system_config.find_one.assert_awaited_once_with(
            {"key": "main"}, session=transaction_sessions[0][1]
        )
        self.assertTrue(server._GAMEPLAY_READY)

    async def test_health_returns_503_when_gameplay_preparation_fails(self):
        database = self._database()
        indexes = AsyncMock(side_effect=RuntimeError("index unavailable"))

        with (
            patch.object(server, "db", database),
            patch.object(server, "_core_indexes", indexes),
            patch.object(server, "run_game_transaction", new_callable=AsyncMock) as transaction,
            patch.object(game_engines, "aviator_return_factor", return_value=0.945),
            patch.object(server.financial_wallet, "financial_status", return_value={"ready": False}),
            patch.object(server.financial_wallet, "financial_flags_requested", return_value=False),
        ):
            with self.assertRaises(HTTPException) as raised:
                await server.health()

        self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(raised.exception.detail["code"], "GAMEPLAY_NOT_READY")
        self.assertFalse(server._GAMEPLAY_READY)
        database.command.assert_awaited_once_with("ping")
        indexes.assert_awaited_once_with()
        transaction.assert_not_awaited()

    async def test_health_retry_recovers_after_transient_transaction_failure(self):
        database = self._database()
        indexes = AsyncMock()
        attempts = 0

        async def run_transaction(_client, callback):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise RuntimeError("transactions temporarily unavailable")
            return await callback(object())

        with (
            patch.object(server, "db", database),
            patch.object(server, "_core_indexes", indexes),
            patch.object(server, "run_game_transaction", side_effect=run_transaction),
            patch.object(game_engines, "aviator_return_factor", return_value=0.945),
            patch.object(server.financial_wallet, "financial_status", return_value={"ready": True}),
            patch.object(server.financial_wallet, "financial_flags_requested", return_value=False),
        ):
            with self.assertRaises(RuntimeError):
                await server._prepare_gameplay_core()

            self.assertFalse(server._GAMEPLAY_READY)

            response = await server.health()

        self.assertEqual(attempts, 2)
        self.assertEqual(indexes.await_count, 2)
        database.command.assert_awaited_once_with("ping")
        self.assertEqual(
            response,
            {"status": "ok", "gameplay_ready": True, "financial_ready": True},
        )
        self.assertTrue(server._GAMEPLAY_READY)

    async def test_health_revalidates_transactions_after_startup_success(self):
        database = self._database()
        server._GAMEPLAY_READY = True

        with (
            patch.object(server, "db", database),
            patch.object(
                server, "_probe_gameplay_transaction",
                new_callable=AsyncMock,
                side_effect=RuntimeError("transactions unavailable"),
            ) as transaction_probe,
            patch.object(game_engines, "aviator_return_factor", return_value=0.945),
            patch.object(server.financial_wallet, "financial_status", return_value={"ready": False}),
            patch.object(server.financial_wallet, "financial_flags_requested", return_value=False),
        ):
            with self.assertRaises(HTTPException) as raised:
                await server.health()

        self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(raised.exception.detail["code"], "GAMEPLAY_NOT_READY")
        database.command.assert_awaited_once_with("ping")
        transaction_probe.assert_awaited_once_with()


if __name__ == "__main__":
    unittest.main()
