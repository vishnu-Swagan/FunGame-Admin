"""Focused settlement invariants for operator-reviewed chip requests."""
from __future__ import annotations

import os
import sys
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from mongomock_motor import AsyncMongoMockClient


HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault('MONGO_URL', 'mongodb://127.0.0.1:27017')
os.environ.setdefault('DB_NAME', 'chip_request_atomicity_import')
os.environ['APP_ENV'] = 'test'
os.environ['AUTH_ALLOW_NON_TRANSACTIONAL_TESTS'] = 'true'
os.environ['REAL_MONEY_ENABLED'] = 'false'

import routes_admin
from models import AdminChipRequestAction


class ChipRequestAtomicityTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = AsyncMongoMockClient()
        self.database = self.client['chip_request_atomicity']
        self.original_database = routes_admin.db
        self.original_ledger_database = routes_admin.ledger.db
        routes_admin.db = self.database
        routes_admin.ledger.db = self.database
        self.admin = {
            'id': 'operator-1', 'role': 'ADMIN', 'status': 'ACTIVE',
            'email': 'operator@example.com',
        }
        self.player = {
            'id': 'player-1', 'role': 'PLAYER', 'status': 'ACTIVE',
            'email': 'player@example.com', 'chip_balance': 100,
            'points_balance': 0,
        }
        await self.database.users.insert_one(self.player)

    async def asyncTearDown(self):
        routes_admin.db = self.original_database
        routes_admin.ledger.db = self.original_ledger_database
        self.client.close()

    @staticmethod
    async def run_without_session(callback):
        return await callback(None)

    async def insert_request(self, request_type='BUY', amount=500):
        counter_key = f'chip-request:{self.player["id"]}:{request_type}'
        await self.database.chip_request_pending_counters.insert_one({
            '_id': counter_key, 'user_id': self.player['id'],
            'request_type': request_type, 'count': 1,
        })
        request = {
            'id': f'request-{request_type.lower()}',
            'user_id': self.player['id'], 'type': request_type,
            'amount': amount, 'status': 'PENDING',
            'pending_counter_key': counter_key,
        }
        await self.database.chip_requests.insert_one(request)
        return request

    async def test_buy_approval_commits_balance_ledger_request_notification_and_cap(self):
        request = await self.insert_request('BUY', 500)
        with (
            patch.object(
                routes_admin, '_run_account_transaction',
                side_effect=self.run_without_session,
            ),
            patch.object(
                routes_admin.compliance, 'check_deposit', new=AsyncMock(),
            ),
        ):
            response = await routes_admin.approve_chip_request(
                request['id'], AdminChipRequestAction(note='Approved'), self.admin,
            )

        self.assertEqual(response['balance_after'], 600)
        stored = await self.database.chip_requests.find_one({'id': request['id']})
        self.assertEqual(stored['status'], 'APPROVED')
        self.assertEqual(stored['resolved_by'], self.admin['id'])
        player = await self.database.users.find_one({'id': self.player['id']})
        self.assertEqual(player['chip_balance'], 600)
        ledger_row = await self.database.chip_transactions.find_one({
            'user_id': self.player['id'], 'ref': request['id'],
        })
        self.assertEqual(ledger_row['kind'], routes_admin.ledger.DEPOSIT)
        self.assertEqual(ledger_row['amount'], 500)
        self.assertEqual(
            await self.database.notifications.count_documents({
                'user_id': self.player['id'], 'type': 'CHIPS',
            }),
            1,
        )
        counter = await self.database.chip_request_pending_counters.find_one({
            '_id': request['pending_counter_key'],
        })
        self.assertEqual(counter['count'], 0)

    async def test_failed_credit_does_not_premark_request_or_release_cap(self):
        request = await self.insert_request('BUY', 500)
        with (
            patch.object(
                routes_admin, '_run_account_transaction',
                side_effect=self.run_without_session,
            ),
            patch.object(
                routes_admin.compliance, 'check_deposit', new=AsyncMock(),
            ),
            patch.object(
                routes_admin.ledger, 'credit_chips',
                new=AsyncMock(side_effect=RuntimeError('ledger unavailable')),
            ),
        ):
            with self.assertRaises(RuntimeError):
                await routes_admin.approve_chip_request(
                    request['id'], None, self.admin,
                )

        stored = await self.database.chip_requests.find_one({'id': request['id']})
        self.assertEqual(stored['status'], 'PENDING')
        player = await self.database.users.find_one({'id': self.player['id']})
        self.assertEqual(player['chip_balance'], 100)
        self.assertEqual(await self.database.notifications.count_documents({}), 0)
        counter = await self.database.chip_request_pending_counters.find_one({
            '_id': request['pending_counter_key'],
        })
        self.assertEqual(counter['count'], 1)

    async def test_denial_and_counter_release_are_one_transactional_callback(self):
        request = await self.insert_request('BUY', 500)

        async def run_with_marker(callback):
            # mongomock does not implement sessions; the assertion below proves
            # the route delegates one callback, while the production runner
            # supplies the real Mongo transaction/session.
            self.assertTrue(callable(callback))
            return await callback(None)

        with patch.object(
            routes_admin, '_run_account_transaction', side_effect=run_with_marker,
        ) as transaction_runner:
            response = await routes_admin.deny_chip_request(
                request['id'], AdminChipRequestAction(note='Not approved'), self.admin,
            )
        self.assertEqual(response['message'], 'Request denied')
        self.assertEqual(transaction_runner.await_count, 1)
        stored = await self.database.chip_requests.find_one({'id': request['id']})
        self.assertEqual(stored['status'], 'DENIED')
        counter = await self.database.chip_request_pending_counters.find_one({
            '_id': request['pending_counter_key'],
        })
        self.assertEqual(counter['count'], 0)

    async def test_invalid_request_type_fails_closed_without_mutation(self):
        request = await self.insert_request('UNKNOWN', 500)
        with patch.object(
            routes_admin, '_run_account_transaction',
            side_effect=self.run_without_session,
        ):
            with self.assertRaises(HTTPException) as caught:
                await routes_admin.approve_chip_request(
                    request['id'], None, self.admin,
                )
        self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(
            caught.exception.detail.get('code'), 'INVALID_CHIP_REQUEST_TYPE',
        )
        stored = await self.database.chip_requests.find_one({'id': request['id']})
        self.assertEqual(stored['status'], 'PENDING')

    async def test_legacy_deferred_reactivation_never_grants_welcome_bonus_again(self):
        await self.database.users.insert_one({
            'id': 'deferred-player', 'role': 'PLAYER', 'status': 'SUSPENDED',
            'registration_source': 'SELF_SERVICE',
            'activation_mode': 'SELF_SERVICE_NO_OTP',
            'contact_verification_status': 'VERIFIED',
            'contact_verified': True, 'email_verified': True,
            'phone_verified': False, 'accepted_terms': True,
            'country': 'India', 'date_of_birth': '1990-01-01',
            'chip_balance': 0,
        })
        credit = AsyncMock()
        with (
            patch.object(
                routes_admin, '_run_account_transaction',
                side_effect=self.run_without_session,
            ),
            patch.object(
                routes_admin.compliance, 'check_eligibility',
                new=AsyncMock(return_value=(True, None, None)),
            ),
            patch.object(routes_admin, '_credit_chips', new=credit),
        ):
            response = await routes_admin.approve_user(
                'deferred-player', None, self.admin,
            )
        self.assertEqual(response['user']['status'], 'ACTIVE')
        credit.assert_not_awaited()


if __name__ == '__main__':
    unittest.main(verbosity=2)
