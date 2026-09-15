"""Deleted-player tombstones cannot authenticate or regain credentials."""
import os
import sys
import unittest
from contextlib import ExitStack
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from mongomock_motor import AsyncMongoMockClient

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault('MONGO_URL', 'mongodb://127.0.0.1:27017')
os.environ.setdefault('DB_NAME', 'deleted_account_auth_import')

import auth_utils
import routes_auth
from models import (
    ForgotPasswordRequest, LoginRequest, ResendVerificationRequest,
    ResetPasswordRequest, VerifyEmailRequest,
)


class DeletedAccountAuthTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = AsyncMongoMockClient()
        self.database = self.client['deleted_account_auth']
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(auth_utils, 'db', self.database))
        self.stack.enter_context(patch.object(routes_auth, 'db', self.database))
        self.stack.enter_context(patch.dict(os.environ, {
            'APP_ENV': 'test',
            'JWT_SECRET': 'deleted-user-test-secret-with-at-least-32-characters',
        }))
        self.stack.enter_context(patch.object(
            routes_auth, 'consume_persistent_limit', AsyncMock(),
        ))
        self.stack.enter_context(patch.object(routes_auth, 'hash_password', return_value='new-hash'))
        self.player = {
            'id': 'deleted-player', 'role': 'PLAYER', 'status': 'ACTIVE',
            'username': 'former-player', 'username_key': 'former-player',
            'email': 'former@example.com', 'email_normalized': 'former@example.com',
            'phone': '+919876543210', 'phone_normalized': '+919876543210',
            'phone_verified': True, 'email_verified': True,
            'password_hash': 'old-hash', 'chip_balance': 750,
        }

    async def asyncTearDown(self):
        self.client.close()

    async def assert_http_error(self, operation, status):
        with self.assertRaises(HTTPException) as caught:
            await operation
        self.assertEqual(caught.exception.status_code, status)
        return caught.exception

    async def test_legacy_and_session_tokens_reject_either_deleted_marker(self):
        for deleted in ({'status': 'DELETED'}, {'deleted_at': '2026-09-15T00:00:00Z'}):
            for sid in (None, 'former-session'):
                await self.database.users.delete_many({})
                row = {**self.player, **deleted}
                if sid:
                    row['active_session_id'] = sid
                await self.database.users.insert_one(row)
                token = auth_utils.create_access_token(row['id'], 'PLAYER', sid)
                await self.assert_http_error(auth_utils.get_current_user(
                    HTTPAuthorizationCredentials(scheme='Bearer', credentials=token),
                ), 401)
                # Settlement/audit can still resolve the original ID and balance.
                stored = await self.database.users.find_one({'id': row['id']})
                self.assertEqual(stored['chip_balance'], 750)

    async def test_live_legacy_session_without_deletion_remains_valid(self):
        await self.database.users.insert_one(self.player)
        token = auth_utils.create_access_token(self.player['id'], 'PLAYER')
        with patch.object(auth_utils, 'maybe_upgrade_legacy_avatar', AsyncMock(return_value=self.player)):
            result = await auth_utils.get_current_user(
                HTTPAuthorizationCredentials(scheme='Bearer', credentials=token),
            )
        self.assertEqual(result['id'], self.player['id'])

    async def test_password_cannot_login_or_repair_deleted_phone_pending_account(self):
        for deleted in ({'status': 'DELETED'}, {'deleted_at': '2026-09-15T00:00:00Z'}):
            await self.database.users.delete_many({})
            row = {
                **self.player, 'registration_source': 'SELF_SERVICE',
                'activation_mode': 'PHONE_OTP',
                'contact_verification_status': 'PHONE_VERIFIED_EMAIL_PENDING',
                **deleted,
            }
            await self.database.users.insert_one(row)
            with patch.object(routes_auth, 'verify_password', return_value=True):
                error = await self.assert_http_error(routes_auth.login(LoginRequest(
                    identifier='former-player', password='Former-Password-9',
                )), 401)
            self.assertEqual(error.detail, routes_auth.INVALID_LOGIN_MESSAGE)
            stored = await self.database.users.find_one({'id': row['id']})
            self.assertNotIn('active_session_id', stored)
            self.assertEqual(stored['status'], row['status'])
            self.assertNotIn('password_failed_attempts', stored)

    async def test_deleted_accounts_do_not_receive_reset_or_activation_codes(self):
        await self.database.users.insert_one({
            **self.player, 'status': 'DELETED', 'phone_verified': False,
        })
        issue = AsyncMock()
        with patch.object(routes_auth, 'issue_challenge', issue), patch.object(
            routes_auth, 'delivery_adapter_ready', return_value=True,
        ):
            resend = await routes_auth.resend_verification(ResendVerificationRequest(
                identifier=self.player['phone'], channel='PHONE',
            ))
            reset = await routes_auth.forgot_password(ForgotPasswordRequest(
                identifier=self.player['email'], channel='EMAIL',
            ))
        issue.assert_not_awaited()
        self.assertEqual(resend['message'], routes_auth.GENERIC_RESEND_MESSAGE)
        self.assertEqual(reset['message'], routes_auth.GENERIC_RESET_MESSAGE)

    def stub_challenge_transaction(self):
        async def run(callback):
            return await callback(None)

        self.stack.enter_context(patch.object(routes_auth, '_run_auth_transaction', run))
        self.stack.enter_context(patch.object(
            routes_auth, 'prepare_challenge_verification', AsyncMock(return_value={'id': 'old-otp'}),
        ))
        self.stack.enter_context(patch.object(
            routes_auth, 'consume_prepared_challenge',
            AsyncMock(return_value={'user_id': self.player['id']}),
        ))
        self.stack.enter_context(patch.object(
            routes_auth, 'report_delivery_completion', AsyncMock(),
        ))

    def activation_request(self):
        return VerifyEmailRequest(
            identifier=self.player['email'], channel='EMAIL', code='123456',
            password='Replacement-Password-9', password_confirmation='Replacement-Password-9',
        )

    def reset_request(self):
        return ResetPasswordRequest(
            identifier=self.player['email'], channel='EMAIL', code='123456',
            new_password='Replacement-Password-9',
        )

    async def test_pre_deletion_activation_code_cannot_recreate_password_or_session(self):
        self.stub_challenge_transaction()
        for deleted in ({'status': 'DELETED'}, {'deleted_at': '2026-09-15T00:00:00Z'}):
            await self.database.users.delete_many({})
            row = {**self.player, 'email_verified': False, **deleted}
            row.pop('password_hash')
            await self.database.users.insert_one(row)
            await self.assert_http_error(routes_auth.verify_contact(self.activation_request()), 400)
            stored = await self.database.users.find_one({'id': row['id']})
            self.assertNotIn('password_hash', stored)
            self.assertNotIn('active_session_id', stored)
            self.assertFalse(stored['email_verified'])

    async def test_pre_deletion_reset_code_cannot_recreate_password(self):
        self.stub_challenge_transaction()
        for deleted in ({'status': 'DELETED'}, {'deleted_at': '2026-09-15T00:00:00Z'}):
            await self.database.users.delete_many({})
            row = {**self.player, **deleted}
            row.pop('password_hash')
            await self.database.users.insert_one(row)
            await self.assert_http_error(routes_auth.reset_password(self.reset_request()), 400)
            stored = await self.database.users.find_one({'id': row['id']})
            self.assertNotIn('password_hash', stored)
            self.assertNotIn('active_session_id', stored)

    async def test_deletion_between_password_check_and_login_commit_wins(self):
        await self.database.users.insert_one(self.player)

        async def delete_during_screen(user):
            await self.database.users.update_one({'id': user['id']}, {
                '$set': {'deleted_at': '2026-09-15T00:00:00Z'},
            })

        with patch.object(routes_auth, 'verify_password', return_value=True), patch.object(
            routes_auth, '_telesign_sign_in_screen', delete_during_screen,
        ):
            await self.assert_http_error(routes_auth.login(LoginRequest(
                identifier='former-player', password='Former-Password-9',
            )), 401)
        self.assertNotIn('active_session_id', await self.database.users.find_one({'id': self.player['id']}))

    async def test_deletion_after_otp_lookup_prevents_activation_and_reset_writes(self):
        self.stub_challenge_transaction()
        for operation, request, verified in (
            (routes_auth.verify_contact, self.activation_request, False),
            (routes_auth.reset_password, self.reset_request, True),
        ):
            for deleted in ({'status': 'DELETED'}, {'deleted_at': '2026-09-15T00:00:00Z'}):
                await self.database.users.delete_many({})
                await self.database.users.insert_one({**self.player, 'email_verified': verified})

                async def stale_identity(identity, **kwargs):
                    snapshot = await self.database.users.find_one({'id': self.player['id']})
                    await self.database.users.update_one({'id': self.player['id']}, {
                        '$set': deleted, '$unset': {'password_hash': ''},
                    })
                    return snapshot

                with patch.object(routes_auth, '_find_identity_user', stale_identity):
                    await self.assert_http_error(operation(request()), 400)
                stored = await self.database.users.find_one({'id': self.player['id']})
                self.assertNotIn('password_hash', stored)
                self.assertNotIn('active_session_id', stored)
                self.assertEqual(stored['email_verified'], verified)

    async def test_legacy_phone_repair_does_not_reactivate_stale_deleted_snapshot(self):
        snapshot = {
            **self.player, 'status': 'PENDING', 'registration_source': 'SELF_SERVICE',
            'activation_mode': 'PHONE_OTP',
            'contact_verification_status': 'PHONE_VERIFIED_EMAIL_PENDING',
        }
        await self.database.users.insert_one({
            **snapshot, 'status': 'DELETED', 'deleted_at': '2026-09-15T00:00:00Z',
        })
        result = await routes_auth._repair_phone_otp_email_pending(snapshot)
        self.assertEqual(result['status'], 'DELETED')
        self.assertFalse(routes_auth._phone_otp_email_pending_repair_needed(result))


if __name__ == '__main__':
    unittest.main()
