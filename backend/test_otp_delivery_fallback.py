"""OTP delivery outage: no 500s, keep signup, safe reset, password fallback."""
from __future__ import annotations

import os
import sys
import types
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from mongomock_motor import AsyncMongoMockClient


HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

client = AsyncMongoMockClient()
database = client['otp_delivery_fallback']
sys.modules['db'] = types.SimpleNamespace(
    db=database,
    client=client,
    serialize_doc=lambda value: {
        key: item for key, item in value.items()
        if key not in ('_id', 'password_hash')
    } if isinstance(value, dict) else value,
)

os.environ['APP_ENV'] = 'test'
os.environ['JWT_SECRET'] = 'test-only-jwt-secret-with-at-least-32-characters'
os.environ['OTP_PEPPER'] = 'test-only-otp-pepper-with-at-least-32-characters'
os.environ['OTP_EMAIL_ADAPTER'] = 'disabled'
os.environ['OTP_SMS_ADAPTER'] = 'mock'
os.environ['OTP_EXPOSE_DEV_CODE'] = 'true'
os.environ['AUTH_ALLOW_NON_TRANSACTIONAL_TESTS'] = 'true'
os.environ['REGISTRATION_MODE'] = 'PHONE_OTP'
os.environ['REAL_MONEY_ENABLED'] = 'false'

import auth_utils
import crm
import otp_service
import routes_admin
import routes_auth
from models import (
    ForgotPasswordRequest,
    LoginRequest,
    PlayerMobileVerificationFallback,
    RegisterRequest,
    ResendVerificationRequest,
    VerifyEmailRequest,
)


class FailingSmsAdapter:
    async def send(self, identity, code, purpose):
        return {'sent': False, 'provider': 'test-failure'}


class RaisingSmsAdapter:
    async def send(self, identity, code, purpose):
        raise RuntimeError('provider exploded')


def _bind_test_database():
    """Keep this module's Mongo stub even if another auth test imported first."""
    routes_auth.db = database
    routes_admin.db = database
    otp_service.db = database
    crm.db = database


class OtpDeliveryFallbackTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        _bind_test_database()
        for name in (
            'users', 'otp_challenges', 'auth_rate_limits', 'player_attribution',
            'login_id_reservations', 'financial_audit', 'distributors',
            'compliance_config',
        ):
            await database[name].delete_many({})
        await otp_service.ensure_identity_indexes(database=database)
        await otp_service.ensure_indexes(database=database)
        await crm.ensure_indexes()
        await crm.ensure_house_account()

    def _registration(self, **overrides):
        values = {
            'channel': 'PHONE',
            'identifier': '+919800000001',
            'phone': '+919800000001',
            'email': 'pending.player@example.com',
            'username': 'Pending.Player_1',
            'full_name': 'Pending Player',
            'date_of_birth': '1990-01-01',
            'country': 'India',
            'accepted_terms': True,
        }
        values.update(overrides)
        return RegisterRequest(**values)

    async def test_issue_challenge_delivery_failure_is_unavailable_not_500(self):
        with patch.object(otp_service, 'delivery_adapter', lambda channel: FailingSmsAdapter()):
            with self.assertRaises(otp_service.OtpError) as caught:
                await otp_service.issue_challenge(
                    {'id': 'player-1'},
                    otp_service.Identity('SMS', '+919800000099'),
                    otp_service.VERIFY_CONTACT,
                    database=database,
                    consume_limit=False,
                )
        self.assertEqual(caught.exception.code, 'OTP_UNAVAILABLE')
        self.assertEqual(caught.exception.status_code, 503)
        failed = await database.otp_challenges.find_one({'user_id': 'player-1'})
        self.assertEqual(failed['status'], 'DELIVERY_FAILED')
        self.assertIs(failed['active'], False)

    async def test_issue_challenge_unexpected_adapter_error_is_unavailable_not_500(self):
        with patch.object(otp_service, 'delivery_adapter', lambda channel: RaisingSmsAdapter()):
            with self.assertRaises(otp_service.OtpError) as caught:
                await otp_service.issue_challenge(
                    {'id': 'player-2'},
                    otp_service.Identity('SMS', '+919800000098'),
                    otp_service.VERIFY_CONTACT,
                    database=database,
                    consume_limit=False,
                )
        self.assertEqual(caught.exception.code, 'OTP_UNAVAILABLE')
        self.assertEqual(caught.exception.status_code, 503)

    async def test_forgot_password_returns_safe_message_when_delivery_fails(self):
        hashed = auth_utils.hash_password('Known-Password-9')
        await database.users.insert_one({
            'id': 'reset-player',
            'role': 'PLAYER',
            'status': 'ACTIVE',
            'phone': '+919800000010',
            'phone_normalized': '+919800000010',
            'phone_verified': True,
            'password_hash': hashed,
        })
        with patch.object(otp_service, 'delivery_adapter', lambda channel: FailingSmsAdapter()):
            response = await routes_auth.forgot_password(ForgotPasswordRequest(
                identifier='+919800000010', phone='+919800000010',
            ))
        self.assertEqual(response['message'], routes_auth.GENERIC_RESET_MESSAGE)
        self.assertTrue(response['delivery_available'])
        self.assertNotIn('code', response)
        self.assertNotIn('dev_code', str(response))

    async def test_forgot_password_reports_unavailable_when_no_adapter_is_ready(self):
        original_sms = os.environ.get('OTP_SMS_ADAPTER')
        original_email = os.environ.get('OTP_EMAIL_ADAPTER')
        os.environ['OTP_SMS_ADAPTER'] = 'disabled'
        os.environ['OTP_EMAIL_ADAPTER'] = 'disabled'
        try:
            response = await routes_auth.forgot_password(ForgotPasswordRequest(
                identifier='+919800000011', phone='+919800000011',
            ))
        finally:
            os.environ['OTP_SMS_ADAPTER'] = original_sms
            os.environ['OTP_EMAIL_ADAPTER'] = original_email
        self.assertEqual(response['message'], routes_auth.RESET_UNAVAILABLE_MESSAGE)
        self.assertIs(response['delivery_available'], False)

    async def test_forgot_password_does_not_use_email_when_sms_is_unavailable(self):
        original_sms = os.environ.get('OTP_SMS_ADAPTER')
        original_email = os.environ.get('OTP_EMAIL_ADAPTER')
        os.environ['OTP_SMS_ADAPTER'] = 'disabled'
        os.environ['OTP_EMAIL_ADAPTER'] = 'mock'
        try:
            response = await routes_auth.forgot_password(ForgotPasswordRequest(
                identifier='+919800000011', phone='+919800000011',
            ))
        finally:
            os.environ['OTP_SMS_ADAPTER'] = original_sms
            os.environ['OTP_EMAIL_ADAPTER'] = original_email
        self.assertEqual(response['message'], routes_auth.RESET_UNAVAILABLE_MESSAGE)
        self.assertIs(response['delivery_available'], False)

    async def test_signup_keeps_pending_user_when_otp_cannot_be_sent(self):
        with patch.object(otp_service, 'delivery_adapter', lambda channel: FailingSmsAdapter()):
            response = await routes_auth.register(self._registration())
        self.assertEqual(response['message'], routes_auth.GENERIC_REGISTER_MESSAGE)
        self.assertIs(response['verification_required'], True)
        self.assertNotIn('access_token', response)
        player = await database.users.find_one({
            'phone_normalized': '+919800000001',
        })
        self.assertIsNotNone(player)
        self.assertEqual(player['status'], 'PENDING')
        self.assertEqual(player['activation_mode'], routes_auth.PHONE_OTP_ACTIVATION_MODE)
        self.assertIs(player['phone_verified'], False)
        self.assertNotIn('password_hash', player)

    async def test_authenticated_verification_password_fallback_does_not_verify_phone(self):
        hashed = auth_utils.hash_password('Active-Password-9')
        player = {
            'id': 'active-player',
            'role': 'PLAYER',
            'status': 'ACTIVE',
            'phone': '+919800000020',
            'phone_normalized': '+919800000020',
            'phone_verified': False,
            'password_hash': hashed,
            'active_session_id': 'sess-1',
        }
        await database.users.insert_one(player)
        with patch.object(otp_service, 'delivery_adapter', lambda channel: FailingSmsAdapter()):
            request = await routes_auth.request_my_mobile_verification(player)
        self.assertIs(request['verified'], False)
        self.assertIs(request['otp_unavailable'], True)
        self.assertIs(request['password_fallback'], True)
        self.assertNotIn('challenge_id', request)

        fallback = await routes_auth.player_mobile_verification_password_fallback(
            PlayerMobileVerificationFallback(current_password='Active-Password-9'),
            player,
        )
        self.assertIs(fallback['verified'], False)
        self.assertIs(fallback['password_only'], True)
        self.assertIs(fallback['otp_unavailable'], True)
        stored = await database.users.find_one({'id': 'active-player'})
        self.assertIs(stored['phone_verified'], False)
        self.assertEqual(stored['mobile_verification_status'], 'OTP_UNAVAILABLE')
        audit = await database.financial_audit.find_one({
            'target_id': 'active-player', 'action': 'MOBILE_OTP_UNAVAILABLE',
        })
        self.assertIsNotNone(audit)
        self.assertIs(audit['after']['phone_verified'], False)

        with self.assertRaises(HTTPException) as caught:
            await routes_auth.player_mobile_verification_password_fallback(
                PlayerMobileVerificationFallback(current_password='Wrong-Password-9'),
                player,
            )
        self.assertEqual(caught.exception.status_code, 401)
        self.assertEqual(caught.exception.detail['code'], 'PLAYER_REAUTH_FAILED')


class RecordingSmsAdapter:
    def __init__(self):
        self.calls = []

    async def send(self, identity, code, purpose):
        self.calls.append({
            'channel': identity.channel,
            'value': identity.value,
            'purpose': purpose,
            'code': code,
        })
        return {
            'sent': True,
            'provider': 'telesign',
            'status_code': 290,
            'reference_id': f'ref-{len(self.calls)}',
        }


class ClassifiedFailingSmsAdapter:
    async def send(self, identity, code, purpose):
        return {
            'sent': False,
            'provider': 'telesign',
            'error': 'trial_unverified_destination',
        }


class LoginVerificationOtpTests(unittest.IsolatedAsyncioTestCase):
    """Existing-account login must invoke SMS OTP instead of a dummy resend."""

    async def asyncSetUp(self):
        _bind_test_database()
        for name in (
            'users', 'otp_challenges', 'auth_rate_limits', 'player_attribution',
            'login_id_reservations', 'financial_audit', 'distributors',
            'compliance_config',
        ):
            await database[name].delete_many({})
        await otp_service.ensure_identity_indexes(database=database)
        await otp_service.ensure_indexes(database=database)
        await crm.ensure_indexes()
        await crm.ensure_house_account()

    async def _unverified_player(self, **overrides):
        phone = overrides.pop('phone', '+919800000101')
        user = {
            'id': overrides.pop('id', 'existing-unverified'),
            'role': 'PLAYER',
            'status': 'ACTIVE',
            'registration_source': 'SELF_SERVICE',
            'activation_mode': routes_auth.PHONE_OTP_ACTIVATION_MODE,
            'primary_identity': phone,
            'primary_identity_channel': 'PHONE',
            'phone': phone,
            'phone_normalized': phone,
            'phone_verified': False,
            'contact_verified': False,
            'email': overrides.pop('email', 'existing.player@example.com'),
            'email_normalized': overrides.pop(
                'email_normalized', 'existing.player@example.com',
            ),
            'email_verified': False,
            'username': overrides.pop('username', 'Existing.Player'),
            'username_key': overrides.pop('username_key', 'existing.player'),
            'password_hash': auth_utils.hash_password('Known-Password-9'),
            'accepted_terms': True,
        }
        user.update(overrides)
        await database.users.insert_one(user)
        return user

    async def test_login_id_issues_sms_and_returns_phone_identifier(self):
        await self._unverified_player()
        adapter = RecordingSmsAdapter()
        with patch.object(otp_service, 'delivery_adapter', lambda channel: adapter):
            with self.assertRaises(HTTPException) as caught:
                await routes_auth.login(LoginRequest(
                    identifier='Existing.Player',
                    email='Existing.Player',
                    password='Known-Password-9',
                ))
        detail = caught.exception.detail
        self.assertEqual(caught.exception.status_code, 403)
        self.assertEqual(detail['code'], 'CONTACT_NOT_VERIFIED')
        self.assertEqual(detail['channel'], 'PHONE')
        self.assertEqual(detail['identifier'], '+919800000101')
        self.assertTrue(detail.get('challenge_id'))
        self.assertNotIn('dev_code', detail)
        self.assertEqual(len(adapter.calls), 1)
        self.assertEqual(adapter.calls[0]['value'], '+919800000101')
        self.assertEqual(adapter.calls[0]['purpose'], otp_service.VERIFY_CONTACT)
        stored = await database.otp_challenges.find_one({
            'id': detail['challenge_id'],
        })
        self.assertEqual(stored['delivery_provider'], 'telesign')
        self.assertEqual(stored['purpose'], otp_service.VERIFY_CONTACT)

    async def test_email_login_recovers_via_stored_mobile(self):
        await self._unverified_player(
            id='legacy-email-player',
            username='Legacy.Email',
            username_key='legacy.email',
        )
        await database.users.update_one(
            {'id': 'legacy-email-player'},
            {'$unset': {'activation_mode': ''}},
        )
        adapter = RecordingSmsAdapter()
        with patch.object(otp_service, 'delivery_adapter', lambda channel: adapter):
            with self.assertRaises(HTTPException) as caught:
                await routes_auth.login(LoginRequest(
                    identifier='existing.player@example.com',
                    email='existing.player@example.com',
                    password='Known-Password-9',
                ))
        detail = caught.exception.detail
        self.assertEqual(detail['code'], 'CONTACT_NOT_VERIFIED')
        self.assertEqual(detail['channel'], 'PHONE')
        self.assertEqual(detail['identifier'], '+919800000101')
        self.assertEqual(len(adapter.calls), 1)

    async def test_resend_during_cooldown_reuses_live_challenge(self):
        await self._unverified_player()
        adapter = RecordingSmsAdapter()
        with patch.object(otp_service, 'delivery_adapter', lambda channel: adapter):
            with self.assertRaises(HTTPException) as caught:
                await routes_auth.login(LoginRequest(
                    identifier='+919800000101',
                    phone='+919800000101',
                    password='Known-Password-9',
                ))
            resend = await routes_auth.resend_verification(ResendVerificationRequest(
                channel='PHONE',
                identifier='+919800000101',
                phone='+919800000101',
            ))
        self.assertEqual(resend['challenge_id'], caught.exception.detail['challenge_id'])
        self.assertGreater(resend.get('resend_after_seconds', 0), 0)
        self.assertEqual(len(adapter.calls), 1)

    async def test_verified_login_does_not_send_otp(self):
        await self._unverified_player(
            id='already-verified',
            phone_verified=True,
            contact_verified=True,
            username='Verified.Player',
            username_key='verified.player',
        )
        adapter = RecordingSmsAdapter()
        with patch.object(otp_service, 'delivery_adapter', lambda channel: adapter):
            result = await routes_auth.login(LoginRequest(
                identifier='Verified.Player',
                email='Verified.Player',
                password='Known-Password-9',
            ))
        self.assertTrue(result['access_token'])
        self.assertEqual(adapter.calls, [])

    async def test_delivery_failure_persists_reason_and_still_returns_403(self):
        await self._unverified_player(
            id='failed-send', username='Failed.Player', username_key='failed.player',
        )
        with patch.object(
            otp_service, 'delivery_adapter',
            lambda channel: ClassifiedFailingSmsAdapter(),
        ):
            with self.assertRaises(HTTPException) as caught:
                await routes_auth.login(LoginRequest(
                    identifier='Failed.Player',
                    email='Failed.Player',
                    password='Known-Password-9',
                ))
        self.assertEqual(caught.exception.status_code, 403)
        self.assertEqual(caught.exception.detail['identifier'], '+919800000101')
        self.assertNotIn('challenge_id', caught.exception.detail)
        failed = await database.otp_challenges.find_one({
            'user_id': 'failed-send', 'status': 'DELIVERY_FAILED',
        })
        self.assertIsNotNone(failed)
        self.assertEqual(failed['delivery_provider'], 'telesign')
        self.assertEqual(failed['delivery_error'], 'trial_unverified_destination')
        usage = await routes_admin.get_telesign_status(
            {'id': 'admin-1', 'role': 'ADMIN', 'status': 'ACTIVE'},
        )
        self.assertGreaterEqual(usage['usage']['sms_verify_failed'], 1)

    async def test_phone_otp_active_account_can_confirm_login_otp(self):
        await self._unverified_player(
            id='active-unverified',
            username='Active.Unverified',
            username_key='active.unverified',
        )
        adapter = RecordingSmsAdapter()
        with patch.object(otp_service, 'delivery_adapter', lambda channel: adapter):
            with self.assertRaises(HTTPException) as caught:
                await routes_auth.login(LoginRequest(
                    identifier='Active.Unverified',
                    email='Active.Unverified',
                    password='Known-Password-9',
                ))
            challenge = await database.otp_challenges.find_one({
                'id': caught.exception.detail['challenge_id'],
            })
            verified = await routes_auth.verify_contact(VerifyEmailRequest(
                channel='PHONE',
                identifier='+919800000101',
                phone='+919800000101',
                code=adapter.calls[0]['code'],
                password='Replacement-Password-9',
                challenge_id=challenge['id'],
                verification_id=challenge['id'],
            ))
        self.assertTrue(verified['access_token'])
        stored = await database.users.find_one({'id': 'active-unverified'})
        self.assertTrue(stored['phone_verified'])
        self.assertEqual(stored['status'], 'ACTIVE')


if __name__ == '__main__':
    unittest.main()
