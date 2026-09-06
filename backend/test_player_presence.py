"""Live stats are admin-only and tied to fresh, non-revoked player sessions."""
import os
import importlib.util
import unittest
from pathlib import Path
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

os.environ.setdefault('MONGO_URL', 'mongodb://127.0.0.1:27017')
os.environ.setdefault('DB_NAME', 'presence_import')
os.environ.setdefault('JWT_SECRET', 'presence-test-secret-not-for-production')

import httpx
from fastapi import FastAPI, HTTPException
from mongomock_motor import AsyncMongoMockClient
import auth_utils
import routes_auth
import routes_admin
from player_presence import player_login_stats


class PlayerPresenceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = AsyncMongoMockClient()
        self.database = self.client['presence']
        self.now = datetime.now(timezone.utc)

    async def asyncTearDown(self):
        self.client.close()

    def player(self, ident, **fields):
        return {
            'id': ident, 'role': 'PLAYER', 'status': 'ACTIVE',
            'display_name': ident, 'active_session_id': f'sid-{ident}',
            'presence_session_id': f'sid-{ident}',
            'last_seen_at': self.now.isoformat(),
            'last_login_at': self.now.isoformat(), **fields,
        }

    async def test_only_fresh_current_playable_player_sessions_are_online(self):
        await self.database.users.insert_many([
            self.player('online'),
            self.player('verified', status='VERIFIED'),
            self.player('stale', last_seen_at=(self.now - timedelta(seconds=91)).isoformat()),
            self.player('revoked', active_session_id='revoked-123'),
            self.player('replaced', active_session_id='new-session'),
            self.player('suspended', status='SUSPENDED'),
            self.player('pending', status='PENDING'),
            self.player('admin', role='ADMIN'),
            self.player('future', last_seen_at=(self.now + timedelta(minutes=1)).isoformat()),
            {'id': 'never', 'role': 'PLAYER', 'status': 'ACTIVE'},
        ])
        data = await player_login_stats(self.database, now=self.now)
        self.assertEqual(data['online_now'], 2)
        self.assertEqual(data['total_players'], 9)
        self.assertEqual({row['id'] for row in data['online_players']}, {'online', 'verified'})
        for row in data['recent_logins']:
            self.assertNotIn('active_session_id', row)
            self.assertNotIn('presence_session_id', row)
        self.assertNotIn('admin', {row['id'] for row in data['recent_logins']})

    async def test_counts_are_not_truncated_to_table_limit(self):
        await self.database.users.insert_many([self.player(str(i)) for i in range(105)])
        await self.database.users.insert_one(self.player('old', last_login_at=(self.now - timedelta(days=2)).isoformat()))
        data = await player_login_stats(self.database, now=self.now)
        self.assertEqual(data['online_now'], 106)
        self.assertEqual(data['players_logged_in_24h'], 105)
        self.assertEqual(len(data['online_players']), 100)
        self.assertEqual(len(data['recent_logins']), 100)

    async def test_heartbeat_is_session_bound_and_logout_goes_offline(self):
        user = self.player('test', presence_session_id=None, last_seen_at=None)
        await self.database.users.insert_one(user)
        with patch.object(routes_auth, 'db', self.database):
            await routes_auth.player_heartbeat(user)
            self.assertEqual((await player_login_stats(self.database))['online_now'], 1)
            await routes_auth.logout(user)
            self.assertEqual((await player_login_stats(self.database))['online_now'], 0)
            with self.assertRaises(HTTPException) as caught:
                await routes_auth.player_heartbeat(user)
            self.assertEqual(caught.exception.status_code, 401)

    async def test_heartbeat_cannot_restore_suspended_or_replaced_session(self):
        user = self.player('race')
        await self.database.users.insert_one({**user, 'status': 'SUSPENDED'})
        with patch.object(routes_auth, 'db', self.database):
            with self.assertRaises(HTTPException):
                await routes_auth.player_heartbeat(user)
            for changes in ({'role': 'ADMIN'}, {'status': 'PENDING'}, {'active_session_id': 'revoked-x'}):
                with self.assertRaises(HTTPException):
                    await routes_auth.player_heartbeat({**user, **changes})

    async def test_routes_enforce_auth_and_admin_only_stats(self):
        app = FastAPI()
        app.include_router(routes_auth.router)
        app.include_router(routes_admin.router)
        player = self.player('player')
        admin = self.player('admin', role='ADMIN')
        await self.database.users.insert_many([player, admin])
        with patch.object(auth_utils, 'db', self.database), patch.object(routes_admin, 'db', self.database), patch.object(routes_auth, 'db', self.database):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
                self.assertEqual((await client.get('/admin/player-login-stats')).status_code, 401)
                for user, expected in ((player, 403), (admin, 200)):
                    token = auth_utils.create_access_token(user['id'], user['role'], user['active_session_id'])
                    result = await client.get('/admin/player-login-stats', headers={'Authorization': f'Bearer {token}'})
                    self.assertEqual(result.status_code, expected)
                    if expected == 200:
                        self.assertEqual(result.headers['cache-control'], 'no-store')
                        self.assertNotIn('sid-player', result.text)
                self.assertEqual((await client.post('/auth/heartbeat')).status_code, 401)
                token = auth_utils.create_access_token(player['id'], 'PLAYER', 'old-session')
                self.assertEqual((await client.post('/auth/heartbeat', headers={'Authorization': f'Bearer {token}'})).status_code, 401)

    async def test_presence_session_is_not_in_public_profile(self):
        public = auth_utils.public_user(self.player('private'))
        self.assertNotIn('presence_session_id', public)
        self.assertNotIn('active_session_id', public)
        # Other legacy suites install a minimal db module in sys.modules.
        # Load the real serializer independently, without querying its client.
        spec = importlib.util.spec_from_file_location('presence_db_serializer', Path(__file__).with_name('db.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        try:
            self.assertNotIn('presence_session_id', module.serialize_doc(self.player('private')))
        finally:
            module.client.close()
