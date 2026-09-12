"""Exercise real live-route imports and round lifecycle against an isolated DB."""
import hashlib
import os
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI, HTTPException
from httpx import ASGITransport, AsyncClient
from mongomock_motor import AsyncMongoMockClient
from starlette.middleware.cors import CORSMiddleware

os.environ.setdefault('MONGO_URL', 'mongodb://127.0.0.1:27017')
os.environ.setdefault('DB_NAME', 'aviator_live_test')

import game_engines
import routes_live


class AviatorLiveTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = AsyncMongoMockClient()
        self.db = self.client['aviator_live_test']
        await self.db.aviator_rounds.create_index('round_number', unique=True)
        for patcher in (
            patch.object(routes_live, 'db', self.db),
            patch.object(routes_live, 'require_playable_game', new_callable=AsyncMock),
            patch.dict(os.environ, {'AVIATOR_RETURN_FACTOR': '0.8'}),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    async def test_first_round_uses_real_fairness_imports(self):
        with patch.object(routes_live.time, 'time', return_value=1000.0):
            result = await routes_live.advance_aviator()
        self.assertEqual(result['round_number'], 1)
        self.assertEqual(result['fairness_version'], game_engines.AVIATOR_FAIRNESS_VERSION)
        self.assertEqual(result['server_seed_hash'], game_engines.aviator_commitment(
            result['server_seed'], result['verification_factor'], result['fairness_version'],
        ))
        self.assertEqual(await self.db.aviator_rounds.count_documents({}), 1)

    async def test_expired_round_settles_and_advances_without_bets(self):
        previous = await routes_live._av_create_round(41, 1000.0)
        with patch.object(routes_live.time, 'time', return_value=previous['ends_at'] + 1):
            current = await routes_live.advance_aviator()
            repeated = await routes_live.advance_aviator()
        self.assertEqual(current['round_number'], 42)
        self.assertEqual(repeated['server_seed_hash'], current['server_seed_hash'])
        self.assertEqual((await self.db.aviator_rounds.find_one({'round_number': 41}))['status'], 'SETTLED')
        self.assertEqual(await self.db.aviator_rounds.count_documents({}), 2)

    async def test_duplicate_round_returns_persisted_commitment(self):
        winner = await routes_live._av_create_round(1, 1000.0)
        repeated = await routes_live._av_create_round(1, 1000.0)
        self.assertEqual(repeated['server_seed_hash'], winner['server_seed_hash'])
        self.assertEqual(repeated['server_seed'], winner['server_seed'])
        self.assertEqual(await self.db.aviator_rounds.count_documents({}), 1)

    async def test_state_http_response_does_not_reveal_private_inputs(self):
        app = FastAPI()
        app.include_router(routes_live.router, prefix='/api')
        app.dependency_overrides[routes_live.require_active_player] = lambda: {'id': 'test-player'}
        async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
            response = await client.get('/api/live/aviator/state')
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data['phase'], 'BETTING')
        self.assertEqual(len(data['server_seed_hash']), 64)
        for key in ('server_seed', 'verification_factor', 'crash_point'):
            self.assertNotIn(key, data)

    async def test_transient_state_failure_has_cors_and_recovers(self):
        app = FastAPI()
        app.add_middleware(CORSMiddleware, allow_origins=['https://chakri.casino'])
        app.include_router(routes_live.router, prefix='/api')
        app.dependency_overrides[routes_live.require_active_player] = lambda: {'id': 'test-player'}
        async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
            with patch.object(routes_live, 'advance_aviator', side_effect=RuntimeError('private diagnostic')):
                failed = await client.get('/api/live/aviator/state', headers={'Origin': 'https://chakri.casino'})
            recovered = await client.get('/api/live/aviator/state')
        self.assertEqual(failed.status_code, 503)
        self.assertEqual(failed.headers['access-control-allow-origin'], 'https://chakri.casino')
        self.assertEqual(failed.headers['retry-after'], '2')
        self.assertEqual(failed.json()['detail']['code'], 'AVIATOR_UNAVAILABLE')
        self.assertNotIn('private diagnostic', failed.text)
        self.assertEqual(recovered.status_code, 200)

    async def test_readiness_document_does_not_persist_a_round(self):
        routes_live._av_round_document(0, 0.0)
        self.assertEqual(await self.db.aviator_rounds.count_documents({}), 0)

    async def test_fairness_remains_hidden_before_settlement(self):
        await routes_live._av_create_round(1, 1000.0)
        with self.assertRaises(HTTPException) as raised:
            await routes_live.aviator_round_fairness(1, {'id': 'test-player'})
        self.assertEqual(raised.exception.status_code, 409)

    async def test_invalid_configuration_never_persists_a_round(self):
        with patch.dict(os.environ, {'AVIATOR_RETURN_FACTOR': ''}):
            with self.assertRaises(RuntimeError):
                await routes_live._av_create_round(1, 1000.0)
        self.assertEqual(await self.db.aviator_rounds.count_documents({}), 0)

    async def test_settled_fairness_route_supports_current_and_legacy_rounds(self):
        for version in (1, game_engines.AVIATOR_FAIRNESS_VERSION):
            with self.subTest(version=version):
                result = await routes_live._av_create_round(version, 1000.0)
                commitment = game_engines.aviator_commitment(result['server_seed'], 0.8, version)
                await self.db.aviator_rounds.update_one({'round_number': version}, {'$set': {
                    'status': 'SETTLED', 'fairness_version': version, 'server_seed_hash': commitment,
                }})
                proof = await routes_live.aviator_round_fairness(version, {'id': 'test-player'})
                self.assertEqual(proof['fairnessVersion'], version)
                self.assertEqual(proof['verificationFactorText'], '0.800000000000')
                self.assertEqual(hashlib.sha256(proof['commitmentPayload'].encode()).hexdigest(), commitment)
