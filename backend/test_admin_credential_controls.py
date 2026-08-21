"""Focused authorization checks for admin-initiated credential mutations."""
from __future__ import annotations

import os
import sys
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from mongomock_motor import AsyncMongoMockClient


HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

# Import-time database configuration only. Every test replaces the route's
# database handle with an isolated in-memory Mongo instance before exercising
# any code, so no connection to this address is attempted.
os.environ.setdefault('MONGO_URL', 'mongodb://127.0.0.1:27017')
os.environ.setdefault('DB_NAME', 'admin_credential_controls_import')

import routes_admin
from models import AdminSetEmail, AdminSetPassword


class AdminCredentialControlTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = AsyncMongoMockClient()
        self.database = self.client['admin_credential_controls']
        self.original_database = routes_admin.db
        routes_admin.db = self.database
        self.operator = {
            'id': 'operator-1',
            'email': 'operator@example.com',
            'role': 'ADMIN',
            'status': 'ACTIVE',
            'admin_role': 'OPERATIONS',
        }

    async def asyncTearDown(self):
        routes_admin.db = self.original_database
        self.client.close()

    async def assert_forbidden(self, awaitable):
        with self.assertRaises(HTTPException) as caught:
            await awaitable
        self.assertEqual(caught.exception.status_code, 403)
        self.assertEqual(
            caught.exception.detail.get('code'),
            'CREDENTIAL_TARGET_FORBIDDEN',
        )

    async def test_player_management_cannot_mutate_any_admin_credentials(self):
        targets = [
            {
                'id': self.operator['id'],
                'email': self.operator['email'],
                'email_normalized': self.operator['email'],
                'password_hash': 'self-original',
                'active_session_id': 'self-session',
                'role': 'ADMIN',
                'admin_role': 'OPERATIONS',
            },
            {
                'id': 'peer-admin',
                'email': 'peer@example.com',
                'email_normalized': 'peer@example.com',
                'password_hash': 'peer-original',
                'active_session_id': 'peer-session',
                'role': 'ADMIN',
                'admin_role': 'OPERATIONS',
            },
            {
                'id': 'super-admin',
                'email': 'super@example.com',
                'email_normalized': 'super@example.com',
                'password_hash': 'super-original',
                'active_session_id': 'super-session',
                'role': 'ADMIN',
                'admin_role': 'SUPER_ADMIN',
            },
            {
                'id': 'distributor-1',
                'email': 'partner@example.com',
                'email_normalized': 'partner@example.com',
                'password_hash': 'partner-original',
                'active_session_id': 'partner-session',
                'role': 'DISTRIBUTOR',
            },
        ]
        await self.database.users.insert_many(targets)

        with patch.object(routes_admin, 'hash_password') as password_hasher:
            for target in targets:
                await self.assert_forbidden(routes_admin.admin_reset_password(
                    target['id'], AdminSetPassword(password='Replacement-Password-9'),
                    self.operator,
                ))
            password_hasher.assert_not_called()

        for target in targets:
            await self.assert_forbidden(routes_admin.admin_change_email(
                target['id'], AdminSetEmail(email=f"changed-{target['id']}@example.com"),
                self.operator,
            ))

        for target in targets:
            stored = await self.database.users.find_one({'id': target['id']})
            self.assertEqual(stored['password_hash'], target['password_hash'])
            self.assertEqual(stored['email'], target['email'])
            self.assertEqual(stored['active_session_id'], target['active_session_id'])
        self.assertEqual(await self.database.notifications.count_documents({}), 0)

    async def test_role_flip_between_read_and_write_fails_closed(self):
        users = self.database.users
        await users.insert_many([
            {
                'id': 'password-race',
                'email': 'password-race@example.com',
                'email_normalized': 'password-race@example.com',
                'password_hash': 'original-hash',
                'active_session_id': 'password-session',
                'role': 'PLAYER',
            },
            {
                'id': 'email-race',
                'email': 'email-race@example.com',
                'email_normalized': 'email-race@example.com',
                'active_session_id': 'email-session',
                'role': 'PLAYER',
            },
        ])
        class RoleFlippingUsers:
            def __init__(self, collection, target_id):
                self.collection = collection
                self.target_id = target_id
                self.flipped = False

            def __getattr__(self, name):
                return getattr(self.collection, name)

            async def update_one(self, query, update, *args, **kwargs):
                if (not self.flipped
                        and query.get('id') == self.target_id
                        and query.get('role') == 'PLAYER'):
                    self.flipped = True
                    await self.collection.update_one(
                        {'id': self.target_id}, {'$set': {'role': 'ADMIN'}},
                    )
                return await self.collection.update_one(query, update, *args, **kwargs)

        class RacingDatabase:
            def __init__(self, database, target_id):
                self.database = database
                self.users = RoleFlippingUsers(database.users, target_id)

            def __getattr__(self, name):
                return getattr(self.database, name)

        routes_admin.db = RacingDatabase(self.database, 'password-race')
        try:
            with patch.object(routes_admin, 'hash_password', return_value='new-hash'):
                with self.assertRaises(HTTPException) as password_error:
                    await routes_admin.admin_reset_password(
                        'password-race',
                        AdminSetPassword(password='Replacement-Password-9'),
                        self.operator,
                    )
        finally:
            routes_admin.db = self.database
        self.assertEqual(password_error.exception.status_code, 409)
        self.assertEqual(
            password_error.exception.detail.get('code'), 'ACCOUNT_STATE_CHANGED',
        )
        password_target = await users.find_one({'id': 'password-race'})
        self.assertEqual(password_target['role'], 'ADMIN')
        self.assertEqual(password_target['password_hash'], 'original-hash')
        self.assertEqual(password_target['active_session_id'], 'password-session')

        routes_admin.db = RacingDatabase(self.database, 'email-race')
        try:
            with self.assertRaises(HTTPException) as email_error:
                await routes_admin.admin_change_email(
                    'email-race', AdminSetEmail(email='changed@example.com'),
                    self.operator,
                )
        finally:
            routes_admin.db = self.database
        self.assertEqual(email_error.exception.status_code, 409)
        self.assertEqual(
            email_error.exception.detail.get('code'), 'ACCOUNT_STATE_CHANGED',
        )
        email_target = await users.find_one({'id': 'email-race'})
        self.assertEqual(email_target['role'], 'ADMIN')
        self.assertEqual(email_target['email'], 'email-race@example.com')
        self.assertEqual(email_target['active_session_id'], 'email-session')
        self.assertEqual(await self.database.notifications.count_documents({}), 0)

    async def test_player_password_reset_remains_available_and_revokes_sessions(self):
        await self.database.users.insert_one({
            'id': 'player-1',
            'email': 'player@example.com',
            'email_normalized': 'player@example.com',
            'password_hash': 'old-hash',
            'reset_code_hash': 'retired-reset-code',
            'reset_expires_at': 'retired-expiry',
            'active_session_id': 'player-session',
            'role': 'PLAYER',
        })

        with patch.object(routes_admin, 'hash_password', return_value='new-hash'):
            response = await routes_admin.admin_reset_password(
                'player-1', AdminSetPassword(password='Replacement-Password-9'),
                self.operator,
            )

        self.assertIn('Password reset', response['message'])
        stored = await self.database.users.find_one({'id': 'player-1'})
        self.assertEqual(stored['password_hash'], 'new-hash')
        self.assertTrue(stored['active_session_id'].startswith('revoked-'))
        self.assertNotIn('reset_code_hash', stored)
        self.assertNotIn('reset_expires_at', stored)
        self.assertEqual(
            await self.database.notifications.count_documents({'user_id': 'player-1'}),
            1,
        )

    async def test_player_email_change_remains_available_and_revokes_sessions(self):
        await self.database.users.insert_one({
            'id': 'player-1',
            'email': 'old@example.com',
            'email_normalized': 'old@example.com',
            'email_verified': True,
            'active_session_id': 'player-session',
            'role': 'PLAYER',
        })

        response = await routes_admin.admin_change_email(
            'player-1', AdminSetEmail(email='New.Address@Example.COM'), self.operator,
        )

        self.assertEqual(response['email'], 'new.address@example.com')
        stored = await self.database.users.find_one({'id': 'player-1'})
        self.assertEqual(stored['email'], 'new.address@example.com')
        self.assertEqual(stored['email_normalized'], 'new.address@example.com')
        self.assertEqual(stored['previous_email'], 'old@example.com')
        self.assertEqual(stored['email_changed_by'], self.operator['id'])
        self.assertTrue(stored['email_verified'])
        self.assertTrue(stored['active_session_id'].startswith('revoked-'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
