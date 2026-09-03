"""Focused executable checks for contact OTP and self-service identities."""
import asyncio
import hashlib
import os
import sys
import types
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from mongomock_motor import AsyncMongoMockClient
from pymongo.errors import DuplicateKeyError

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

client = AsyncMongoMockClient()
database = client['otp_identity_test']
sys.modules['db'] = types.SimpleNamespace(
    db=database,
    client=client,
    serialize_doc=lambda value: {
        key: item for key, item in value.items()
        if key not in ('_id', 'password_hash')
    } if isinstance(value, dict) else value,
)

os.environ['APP_ENV'] = 'test'
os.environ['OTP_PEPPER'] = 'test-only-otp-pepper-with-at-least-32-characters'
os.environ['JWT_SECRET'] = 'test-only-jwt-secret-with-at-least-32-characters'
os.environ['OTP_EMAIL_ADAPTER'] = 'mock'
os.environ['OTP_SMS_ADAPTER'] = 'mock'
os.environ['OTP_EXPOSE_DEV_CODE'] = 'true'
os.environ['AUTH_ALLOW_NON_TRANSACTIONAL_TESTS'] = 'true'
os.environ['REGISTRATION_MODE'] = 'PHONE_OTP'

import otp_service
import auth_utils
import compliance
import crm
import routes_auth
import routes_admin
import routes_compliance
import routes_player
from models import (
    AgeVerify,
    AdminVerificationRequest,
    AdminExclusion,
    AdminUserAction,
    AuthenticatedOtpVerify,
    ComplianceConfigUpdate,
    LoginRequest,
    OnboardingProfileRequest,
    RegisterRequest,
    ResendVerificationRequest,
    ResetPasswordRequest,
    SignupRequestCreate,
    VerifyEmailRequest,
)


async def expect_otp_error(coro, code):
    try:
        await coro
    except otp_service.OtpError as exc:
        assert exc.code == code, (exc.code, code)
        return exc
    raise AssertionError(f'Expected OTP error {code}')


async def expect_http_error(coro, status, code=None):
    try:
        await coro
    except HTTPException as exc:
        assert exc.status_code == status, (exc.status_code, status)
        if code:
            assert isinstance(exc.detail, dict)
            assert exc.detail.get('code') == code, exc.detail
        return exc
    raise AssertionError(f'Expected HTTP {status}')


async def main():
    await otp_service.ensure_identity_indexes(database=database)
    await otp_service.require_identity_indexes(database=database)
    await otp_service.ensure_indexes(database=database)
    await crm.ensure_indexes()
    await crm.ensure_house_account()
    await crm.require_registration_attribution_readiness()
    capabilities = await routes_auth.authentication_capabilities()
    assert capabilities['registration_enabled'] is True
    assert capabilities['email_registration'] is False
    assert capabilities['phone_registration'] is True
    assert capabilities['phone_verification_required'] is True
    assert capabilities['verification_required'] is True
    assert capabilities['registration_mode'] == routes_auth.PHONE_OTP_ACTIVATION_MODE

    # Public capability discovery requires an explicit pepper and every exact
    # identity/OTP index, not merely a configured delivery adapter.
    pepper = os.environ.pop('OTP_PEPPER')
    assert (await routes_auth.authentication_capabilities())['registration_enabled'] is False
    os.environ['OTP_PEPPER'] = pepper
    await database.users.drop_index('users_phone_normalized_unique')
    await database.users.create_index(
        'phone_normalized', name='users_phone_normalized_unique', unique=False,
        partialFilterExpression={'phone_normalized': {'$type': 'string'}},
    )
    assert (await routes_auth.authentication_capabilities())['registration_enabled'] is False
    await database.users.drop_index('users_phone_normalized_unique')
    await otp_service.ensure_identity_indexes(database=database)
    await database.otp_challenges.drop_index('id_1')
    await database.otp_challenges.create_index(
        'id', unique=True,
        partialFilterExpression={'id': {'$type': 'string'}},
    )
    assert (await routes_auth.authentication_capabilities())['registration_enabled'] is False
    await database.otp_challenges.drop_index('id_1')
    await otp_service.ensure_indexes(database=database)
    await database.otp_challenges.drop_index('expires_at_1')
    await database.otp_challenges.create_index('expires_at', expireAfterSeconds=60)
    assert (await routes_auth.authentication_capabilities())['registration_enabled'] is False
    await expect_http_error(
        routes_auth.register(RegisterRequest(
            channel='PHONE', identifier='+919100000000', phone='+919100000000',
            email='missing-index@example.com',
            full_name='Missing Index', date_of_birth='1990-01-01', country='India',
            accepted_terms=True,
        )),
        503, 'OTP_UNAVAILABLE',
    )
    assert await database.users.count_documents({
        'email_normalized': 'missing-index@example.com',
    }) == 0
    await database.otp_challenges.drop_index('expires_at_1')
    await otp_service.ensure_indexes(database=database)
    await database.player_attribution.drop_index(crm.ACTIVE_ATTRIBUTION_INDEX)
    await database.player_attribution.create_index(
        [('user_id', 1)], name=crm.ACTIVE_ATTRIBUTION_INDEX, unique=False,
        partialFilterExpression=crm.ACTIVE_ATTRIBUTION_PARTIAL,
    )
    assert (await routes_auth.authentication_capabilities())['registration_enabled'] is False
    await database.player_attribution.drop_index(crm.ACTIVE_ATTRIBUTION_INDEX)
    await crm.ensure_indexes()
    assert (await routes_auth.authentication_capabilities())['registration_enabled'] is True

    # Partial normalized indexes protect both identity channels.
    await database.users.insert_one({
        'id': 'existing-email', 'email': 'Owner@Example.com',
        'email_normalized': 'owner@example.com',
    })
    try:
        await database.users.insert_one({
            'id': 'duplicate-email', 'email_normalized': 'owner@example.com',
        })
        raise AssertionError('duplicate normalized email inserted')
    except DuplicateKeyError:
        pass
    await database.users.delete_many({})

    # Real registration contract: SMS is the sole activation proof, optional
    # email remains unverified, and the complete eligible profile activates as
    # soon as the phone challenge is consumed.
    registration = await routes_auth.register(RegisterRequest(
        channel='PHONE', identifier='+919100000001', phone='+919100000001',
        email='player@example.com', username='Player.One', full_name='Player One',
        date_of_birth='1990-01-01', country='India',
        accepted_terms=True,
    ))
    assert registration['channel'] == 'PHONE'
    assert registration['verification_required'] is True
    assert registration['verification_id'] == registration['challenge_id']
    assert registration['destination_masked'] == registration['destination']
    assert registration['expires_in_seconds'] == 900
    assert registration['resend_after_seconds'] == 60

    # Restarting a pending registration reuses the actual live challenge and
    # never fabricates or sends a second delivery.
    duplicate_unverified = await routes_auth.register(RegisterRequest(
        channel='PHONE', identifier='+919100000001', phone='+919100000001',
        email='player@example.com', username='Player.One', full_name='Someone Else',
        date_of_birth='1990-01-01', country='India', accepted_terms=True,
    ))
    assert duplicate_unverified['message'] == routes_auth.GENERIC_REGISTER_MESSAGE
    assert duplicate_unverified['challenge_id'] == registration['challenge_id']
    assert 'dev_code' not in duplicate_unverified
    assert await database.otp_challenges.count_documents({}) == 1
    assert await database.otp_challenges.count_documents({
        'id': registration['challenge_id'], 'active': True,
    }) == 1

    player = await database.users.find_one({'email_normalized': 'player@example.com'})
    assert player['registration_source'] == 'SELF_SERVICE'
    assert player['status'] == 'PENDING'
    assert player['identity_verified'] is False
    assert 'password_hash' not in player
    assert player['distributor_code'] == crm.HOUSE_CODE
    assert await database.player_attribution.count_documents({
        'user_id': player['id'], 'active': True,
    }) == 1

    # Registration and CRM attribution live in the same transaction callback:
    # an attribution failure must roll the newly inserted account back rather
    # than leave a login-capable but CRM-invisible player.
    original_auth_runner = routes_auth._run_auth_transaction
    original_attribute_user = crm.attribute_user
    failed_registration_ids = []

    async def failing_attribution(user_id, raw_code, actor='system', *, session=None):
        failed_registration_ids.append(user_id)
        await database.player_attribution.insert_one({
            'id': f'partial-{user_id}', 'user_id': user_id, 'active': True,
        })
        raise RuntimeError('simulated attribution failure')

    async def rollback_test_transaction(callback):
        try:
            return await callback(None)
        except Exception as exc:
            for failed_id in failed_registration_ids:
                await database.users.delete_many({'id': failed_id})
                await database.player_attribution.delete_many({'user_id': failed_id})
            raise HTTPException(status_code=503, detail={
                'code': 'AUTH_TEMPORARILY_UNAVAILABLE',
                'message': 'Authentication is temporarily unavailable.',
            }) from exc

    routes_auth._run_auth_transaction = rollback_test_transaction
    crm.attribute_user = failing_attribution
    try:
        await expect_http_error(
            routes_auth.register(RegisterRequest(
                channel='PHONE', identifier='+919100000002', phone='+919100000002',
                email='crm-failure@example.com', username='CRM.Failure.Player',
                full_name='CRM Failure', date_of_birth='1990-01-01', country='India',
                accepted_terms=True,
            )),
            503, 'AUTH_TEMPORARILY_UNAVAILABLE',
        )
    finally:
        routes_auth._run_auth_transaction = original_auth_runner
        crm.attribute_user = original_attribute_user
    assert await database.users.count_documents({
        'email_normalized': 'crm-failure@example.com',
    }) == 0
    for failed_id in failed_registration_ids:
        assert await database.player_attribution.count_documents({
            'user_id': failed_id,
        }) == 0

    stored = await database.otp_challenges.find_one({'id': registration['challenge_id']})
    assert 'code' not in stored
    assert 'player@example.com' not in repr(stored)
    assert '+919100000001' not in repr(stored)
    assert stored['code_hash'] != hashlib.sha256(registration['dev_code'].encode()).hexdigest()

    verification = await routes_auth.verify_contact(VerifyEmailRequest(
        channel='PHONE', identifier='+919100000001', phone='+919100000001',
        code=registration['dev_code'],
        password='Victim-Owned-Password-9',
    ))
    assert verification['access_token']
    player = await database.users.find_one({'id': player['id']})
    assert player['contact_verified'] is True
    assert player['phone_verified'] is True
    assert player['email_verified'] is False
    assert player['identity_verified'] is False
    assert player['status'] == 'ACTIVE'
    assert player['approved_by'] == 'SELF_SERVICE_PHONE_OTP'
    assert player['approved_at'] == player['activated_at']
    assert verification['user']['status'] == 'ACTIVE'

    # Verified, unknown and locked challenge state all use the same opaque
    # invalid-code contract. A verified contact must never be an existence
    # oracle on the public verification endpoint.
    verified_error = await expect_http_error(
        routes_auth.verify_contact(VerifyEmailRequest(
            channel='PHONE', identifier='+919100000001',
            phone='+919100000001', code='000000',
            password='Victim-Owned-Password-9',
        )),
        400, 'OTP_INVALID',
    )
    unknown_error = await expect_http_error(
        routes_auth.verify_contact(VerifyEmailRequest(
            channel='PHONE', identifier='+919100009999',
            phone='+919100009999', code='000000',
            password='Victim-Owned-Password-9',
        )),
        400, 'OTP_INVALID',
    )
    assert verified_error.detail == unknown_error.detail

    duplicate_verified = await expect_http_error(routes_auth.register(RegisterRequest(
        channel='PHONE', identifier='+919100000001', phone='+919100000001',
        email='player@example.com', username='Player.One', full_name='Another Name',
        date_of_birth='1990-01-01', country='India', accepted_terms=True,
    )), 409, 'LOGIN_ID_UNAVAILABLE')
    duplicate_unknown = await expect_http_error(routes_auth.register(RegisterRequest(
        channel='PHONE', identifier='+919100000099', phone='+919100000099',
        email='unknown-contact@example.com', username='Player.One',
        full_name='Unknown Contact', date_of_birth='1990-01-01', country='India',
        accepted_terms=True,
    )), 409, 'LOGIN_ID_UNAVAILABLE')
    assert duplicate_verified.detail == duplicate_unknown.detail

    planted_password = await expect_http_error(routes_auth.login(LoginRequest(
        identifier='player@example.com', email='player@example.com',
        password='Attacker-Planted-9',
    )), 401)
    assert planted_password.detail == routes_auth.INVALID_LOGIN_MESSAGE
    unverified_email_login = await expect_http_error(routes_auth.login(LoginRequest(
        identifier='player@example.com', email='player@example.com',
        password='Victim-Owned-Password-9',
    )), 401)
    assert unverified_email_login.detail == routes_auth.INVALID_LOGIN_MESSAGE
    login = await routes_auth.login(LoginRequest(
        identifier='+919100000001', phone='+919100000001',
        password='Victim-Owned-Password-9',
    ))
    assert login['access_token']
    assert 'active_session_id' not in login['user']

    # Accounts contact-verified before the state-machine fix are repaired on
    # login so they reach profile/terms rather than remaining stuck in review.
    await database.users.insert_one({
        'id': 'legacy-contact-verified', 'role': 'PLAYER', 'status': 'PENDING',
        'registration_source': 'SELF_SERVICE',
        'email_verified': True, 'email': 'legacy-verified@example.com',
        'email_normalized': 'legacy-verified@example.com',
        'primary_identity': 'legacy-verified@example.com',
        'password_hash': auth_utils.hash_password('Legacy-Password-9'),
    })
    repaired_login = await routes_auth.login(LoginRequest(
        identifier='legacy-verified@example.com', email='legacy-verified@example.com',
        password='Legacy-Password-9',
    ))
    assert repaired_login['user']['status'] == 'VERIFIED'
    repaired = await database.users.find_one({'id': 'legacy-contact-verified'})
    assert repaired['status'] == 'VERIFIED' and repaired['contact_verified'] is True

    # Historical operator-provisioned ACTIVE players can still log in when the
    # verification columns did not exist yet. The successful password check
    # repairs the missing flags once; self-service or explicitly-false rows
    # remain fail-closed.
    await database.users.insert_one({
        'id': 'legacy-operator-active', 'role': 'PLAYER', 'status': 'ACTIVE',
        'email': 'legacy-operator@example.com',
        'email_normalized': 'legacy-operator@example.com',
        'username': 'GK7654321',
        'password_hash': auth_utils.hash_password('Legacy-Operator-Password-9'),
    })
    operator_login = await routes_auth.login(LoginRequest(
        identifier='GK7654321', email='GK7654321',
        password='Legacy-Operator-Password-9',
    ))
    assert operator_login['access_token']
    operator_row = await database.users.find_one({'id': 'legacy-operator-active'})
    assert operator_row['email_verified'] is True
    assert operator_row['contact_verified'] is True
    assert operator_row['contact_verification_repair'] == 'LEGACY_OPERATOR_ACTIVE'

    for legacy_id, email, extra in (
        ('legacy-self-service-active', 'legacy-self@example.com', {
            'registration_source': 'SELF_SERVICE',
        }),
        ('legacy-explicit-false', 'legacy-false@example.com', {
            'email_verified': False,
        }),
    ):
        await database.users.insert_one({
            'id': legacy_id, 'role': 'PLAYER', 'status': 'ACTIVE',
            'email': email, 'email_normalized': email,
            'password_hash': auth_utils.hash_password('Legacy-Denied-Password-9'),
            **extra,
        })
        denied = await expect_http_error(routes_auth.login(LoginRequest(
            identifier=email, email=email, password='Legacy-Denied-Password-9',
        )), 403, 'CONTACT_NOT_VERIFIED')
        assert denied.detail['identifier'] == email
        assert denied.detail['channel'] == 'EMAIL'

    await database.users.insert_one({
        'id': 'legacy-repair-race', 'role': 'PLAYER', 'status': 'ACTIVE',
        'email': 'legacy-race@example.com',
        'email_normalized': 'legacy-race@example.com',
        'password_hash': auth_utils.hash_password('Legacy-Race-Password-9'),
    })
    users_collection_type = type(database.users)
    original_login_update = users_collection_type.find_one_and_update

    async def explicit_verification_wins(collection, query, update, *args, **kwargs):
        if (query.get('id') == 'legacy-repair-race'
                and query.get('contact_verified') == {'$exists': False}):
            await database.users.update_one(
                {'id': 'legacy-repair-race'}, {'$set': {'email_verified': False}},
            )
        return await original_login_update(collection, query, update, *args, **kwargs)

    users_collection_type.find_one_and_update = explicit_verification_wins
    try:
        await expect_http_error(routes_auth.login(LoginRequest(
            identifier='legacy-race@example.com', email='legacy-race@example.com',
            password='Legacy-Race-Password-9',
        )), 403, 'CONTACT_NOT_VERIFIED')
    finally:
        users_collection_type.find_one_and_update = original_login_update
    raced_legacy = await database.users.find_one({'id': 'legacy-repair-race'})
    assert raced_legacy['email_verified'] is False
    assert not raced_legacy.get('contact_verified')

    # Login ID is the usual existing-user subject. The 403 must name the
    # stored mobile so /auth/resend-otp can deliver SMS instead of 422.
    await database.users.insert_one({
        'id': 'existing-login-id-otp',
        'role': 'PLAYER',
        'status': 'PENDING',
        'registration_source': 'SELF_SERVICE',
        'activation_mode': routes_auth.PHONE_OTP_ACTIVATION_MODE,
        'contact_verified': False,
        'phone_verified': False,
        'phone': '+919100000321',
        'phone_normalized': '+919100000321',
        'email': 'existing.loginid@example.com',
        'email_normalized': 'existing.loginid@example.com',
        'username': 'Lobby.Player',
        'username_key': 'lobby.player',
        'password_hash': auth_utils.hash_password('Lobby-Player-9'),
    })
    login_id_blocked = await expect_http_error(routes_auth.login(LoginRequest(
        identifier='Lobby.Player', email='Lobby.Player',
        password='Lobby-Player-9',
    )), 403, 'CONTACT_NOT_VERIFIED')
    assert login_id_blocked.detail['channel'] == 'PHONE'
    assert login_id_blocked.detail['identifier'] == '+919100000321'
    assert login_id_blocked.detail['login_id'] == 'Lobby.Player'
    login_id_resend = await routes_auth.resend_verification(ResendVerificationRequest(
        channel='PHONE', identifier='Lobby.Player',
    ))
    assert login_id_resend['channel'] == 'PHONE'
    assert login_id_resend['challenge_id']
    assert 'dev_code' in login_id_resend
    login_id_challenge = await database.otp_challenges.find_one({
        'id': login_id_resend['challenge_id'],
    })
    assert login_id_challenge['user_id'] == 'existing-login-id-otp'
    assert login_id_challenge['channel'] == 'SMS'
    assert login_id_challenge['active'] is True

    phone_registration = await routes_auth.register(RegisterRequest(
        channel='PHONE', identifier='+919999888877', phone='+919999888877',
        email='phone.player@example.com',
        username='Phone.Player', full_name='Phone Player', date_of_birth='1990-01-01', country='India',
        accepted_terms=True,
    ))
    assert phone_registration['channel'] == 'PHONE'
    await expect_http_error(routes_auth.resend_verification(ResendVerificationRequest(
        channel='PHONE', identifier='+919999888877', phone='+919999888877',
    )), 429, 'OTP_RESEND_COOLDOWN')
    await routes_auth.verify_contact(VerifyEmailRequest(
        channel='PHONE', identifier='+919999888877', phone='+919999888877',
        code=phone_registration['dev_code'],
        password='Phone-Owner-Password-9',
    ))
    phone_player = await database.users.find_one({'phone_normalized': '+919999888877'})
    assert phone_player['phone_verified'] is True
    assert phone_player['email_verified'] is False
    assert phone_player['contact_verified'] is True
    assert phone_player['identity_verified'] is False

    # Reusing a verified challenge is impossible.
    await expect_otp_error(
        otp_service.verify_challenge(
            otp_service.normalize_identity('+919100000001'),
            registration['dev_code'], otp_service.VERIFY_CONTACT,
            challenge_id=registration['challenge_id'], database=database,
        ),
        'OTP_INVALID',
    )

    race_registration = await routes_auth.register(RegisterRequest(
        channel='PHONE', identifier='+919100000003', phone='+919100000003',
        email='race@example.com', username='Race.Player', full_name='Race Player',
        date_of_birth='1990-01-01', country='India', accepted_terms=True,
    ))
    race_request = VerifyEmailRequest(
        channel='PHONE', identifier='+919100000003', phone='+919100000003',
        code=race_registration['dev_code'], password='Race-Owner-Password-9',
    )
    race_results = await asyncio.gather(
        routes_auth.verify_contact(race_request),
        routes_auth.verify_contact(race_request),
        return_exceptions=True,
    )
    assert sum(isinstance(value, dict) for value in race_results) == 1
    race_errors = [value for value in race_results if isinstance(value, HTTPException)]
    assert len(race_errors) == 1 and race_errors[0].detail['code'] == 'OTP_INVALID'
    race_player = await database.users.find_one({'email_normalized': 'race@example.com'})
    assert race_player['status'] == 'ACTIVE' and race_player['contact_verified'] is True

    # Phone registration returns PHONE publicly while retaining SMS internally.
    phone_user = {'id': 'phone-user'}
    phone_identity = otp_service.normalize_identity('+919876543210')
    await database.users.insert_one({
        **phone_user,
        'role': 'PLAYER',
        'status': 'PENDING',
        'phone': phone_identity.value,
        'phone_normalized': phone_identity.value,
        'phone_verified': False,
        'contact_verified': False,
    })
    phone_challenge = await otp_service.issue_challenge(
        phone_user, phone_identity, otp_service.VERIFY_CONTACT, database=database,
    )
    assert phone_challenge['channel'] == 'PHONE'
    assert (await database.otp_challenges.find_one({
        'id': phone_challenge['challenge_id'],
    }))['channel'] == 'SMS'
    cooldown = await expect_otp_error(
        otp_service.issue_challenge(
            phone_user, phone_identity, otp_service.VERIFY_CONTACT, database=database,
        ),
        'OTP_RESEND_COOLDOWN',
    )
    assert cooldown.status_code == 429 and cooldown.retry_after > 0
    await database.otp_challenges.update_one(
        {'id': phone_challenge['challenge_id']},
        {'$set': {'resend_not_before': datetime.now(timezone.utc) - timedelta(seconds=1)}},
    )
    allowed_resend = await routes_auth.resend_verification(ResendVerificationRequest(
        channel='PHONE', identifier=phone_identity.value, phone=phone_identity.value,
    ))
    assert allowed_resend['dev_code']
    assert allowed_resend['challenge_id'] != phone_challenge['challenge_id']
    superseded = await database.otp_challenges.find_one({'id': phone_challenge['challenge_id']})
    assert superseded['status'] == 'SUPERSEDED' and superseded['active'] is False

    # Five bad attempts CAS-lock a challenge; the right code cannot revive it.
    locked_identity = otp_service.normalize_identity('locked@example.com')
    locked_challenge = await otp_service.issue_challenge(
        {'id': 'locked-user'}, locked_identity, otp_service.VERIFY_CONTACT,
        database=database,
    )
    for attempt in range(otp_service.OTP_MAX_ATTEMPTS):
        expected = 'OTP_LOCKED' if attempt == otp_service.OTP_MAX_ATTEMPTS - 1 else 'OTP_INVALID'
        await expect_otp_error(
            otp_service.verify_challenge(
                locked_identity, '000000', otp_service.VERIFY_CONTACT,
                challenge_id=locked_challenge['challenge_id'], database=database,
            ),
            expected,
        )
    locked_doc = await database.otp_challenges.find_one({'id': locked_challenge['challenge_id']})
    assert locked_doc['status'] == 'LOCKED' and locked_doc['active'] is False
    await expect_otp_error(
        otp_service.verify_challenge(
            locked_identity, locked_challenge['dev_code'], otp_service.VERIFY_CONTACT,
            challenge_id=locked_challenge['challenge_id'], database=database,
        ),
        'OTP_INVALID',
    )

    # Expiry is enforced by application CAS even before Mongo's TTL sweeper runs.
    expired_identity = otp_service.normalize_identity('expired@example.com')
    expired = await otp_service.issue_challenge(
        {'id': 'expired-user'}, expired_identity, otp_service.VERIFY_CONTACT,
        database=database,
    )
    expired_doc = await database.otp_challenges.find_one({'id': expired['challenge_id']})
    await expect_otp_error(
        otp_service.verify_challenge(
            expired_identity, expired['dev_code'], otp_service.VERIFY_CONTACT,
            challenge_id=expired['challenge_id'], database=database,
            now=expired_doc['expires_at'] + timedelta(seconds=1),
        ),
        'OTP_INVALID',
    )

    # Password reset consumes a separate, one-use purpose-bound challenge.
    reset = await otp_service.issue_challenge(
        player, otp_service.normalize_identity('+919100000001'),
        otp_service.RESET_PASSWORD, database=database,
    )
    await routes_auth.reset_password(ResetPasswordRequest(
        identifier='+919100000001', phone='+919100000001',
        verification_id=reset['verification_id'], code=reset['dev_code'],
        new_password='A-New-Password-10',
    ))
    changed = await routes_auth.login(LoginRequest(
        identifier='+919100000001', phone='+919100000001',
        password='A-New-Password-10',
    ))
    assert changed['access_token']

    # Password checks use a persistent per-account lock while returning the
    # same public 401 for wrong, unknown and temporarily locked accounts.
    for _ in range(routes_auth.PASSWORD_FAILURE_LIMIT):
        failure = await expect_http_error(routes_auth.login(LoginRequest(
            identifier='+919100000001', phone='+919100000001',
            password='Definitely-Wrong-10',
        )), 401)
        assert failure.detail == routes_auth.INVALID_LOGIN_MESSAGE
    locked_login = await expect_http_error(routes_auth.login(LoginRequest(
        identifier='+919100000001', phone='+919100000001',
        password='A-New-Password-10',
    )), 401)
    assert locked_login.detail == routes_auth.INVALID_LOGIN_MESSAGE
    locked_player = await database.users.find_one({'id': player['id']})
    assert locked_player['password_failed_attempts'] >= routes_auth.PASSWORD_FAILURE_LIMIT
    assert locked_player.get('locked_until')
    await database.users.update_one({'id': player['id']}, {'$set': {
        'locked_until': (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat(),
    }})
    unlocked = await routes_auth.login(LoginRequest(
        identifier='+919100000001', phone='+919100000001',
        password='A-New-Password-10',
    ))
    assert unlocked['access_token']

    unknown_login = await expect_http_error(routes_auth.login(LoginRequest(
        identifier='missing@example.com', email='missing@example.com',
        password='Definitely-Wrong-10',
    )), 401)
    assert unknown_login.detail == routes_auth.INVALID_LOGIN_MESSAGE

    # Legacy signup eligibility is evaluated before existence, so an existing
    # contact cannot bypass or reveal an underage/ineligible request branch.
    existing_signup = SignupRequestCreate(
        full_name='Under Age', email='player@example.com',
        phone='+919111222233', date_of_birth='2020-01-01', country='India',
    )
    new_signup = SignupRequestCreate(
        full_name='Under Age', email='new-underage@example.com',
        phone='+919111222244', date_of_birth='2020-01-01', country='India',
    )
    os.environ['LEGACY_SIGNUP_REQUESTS_ENABLED'] = 'true'
    existing_eligibility = await expect_http_error(
        routes_auth.signup_request(existing_signup), 403,
    )
    new_eligibility = await expect_http_error(
        routes_auth.signup_request(new_signup), 403,
    )
    os.environ.pop('LEGACY_SIGNUP_REQUESTS_ENABLED', None)
    assert existing_eligibility.detail == new_eligibility.detail
    retired_signup = SignupRequestCreate(
        full_name='Eligible Player', email='legacy-retired@example.com',
        phone='+919111222255', date_of_birth='1990-01-01', country='India',
    )
    await expect_http_error(
        routes_auth.signup_request(retired_signup), 410,
        'LEGACY_REGISTRATION_DISABLED',
    )
    assert await database.signup_requests.count_documents({
        'email': 'legacy-retired@example.com',
    }) == 0

    # A provider failure during resend cannot invalidate the previously
    # delivered, unexpired code.
    resilient_identity = otp_service.normalize_identity('resilient@example.com')
    await database.users.insert_one({
        'id': 'resilient-user', 'role': 'PLAYER', 'status': 'PENDING',
        'email': resilient_identity.value,
        'email_normalized': resilient_identity.value,
        'email_verified': False,
    })
    resilient = await otp_service.issue_challenge(
        {'id': 'resilient-user'}, resilient_identity, otp_service.VERIFY_CONTACT,
        database=database,
    )
    await database.otp_challenges.update_one(
        {'id': resilient['challenge_id']},
        {'$set': {'resend_not_before': datetime.now(timezone.utc) - timedelta(seconds=1)}},
    )

    class FailingAdapter:
        async def send(self, identity, code, purpose):
            return {'sent': False, 'provider': 'test-failure'}

    original_adapter = otp_service.delivery_adapter
    otp_service.delivery_adapter = lambda channel: FailingAdapter()
    try:
        await expect_http_error(routes_auth.resend_verification(ResendVerificationRequest(
            channel='EMAIL', identifier=resilient_identity.value,
            email=resilient_identity.value,
        )), 503, 'OTP_UNAVAILABLE')
    finally:
        otp_service.delivery_adapter = original_adapter
    restored = await database.otp_challenges.find_one({'id': resilient['challenge_id']})
    assert restored['active'] is True and restored['status'] == 'PENDING'
    await otp_service.verify_challenge(
        resilient_identity, resilient['dev_code'], otp_service.VERIFY_CONTACT,
        challenge_id=resilient['challenge_id'], database=database,
    )

    # Stale onboarding requests cannot overwrite an approval that has already
    # made the persisted row ACTIVE.
    profile_race_id = 'onboarding-profile-race'
    await database.users.insert_one({
        'id': profile_race_id, 'role': 'PLAYER', 'status': 'ACTIVE',
        'contact_verified': True, 'email_verified': True,
        'country': 'India', 'date_of_birth': '1990-01-01',
    })
    stale_profile_user = {
        'id': profile_race_id, 'role': 'PLAYER', 'status': 'PENDING',
        'contact_verified': True, 'email_verified': True,
        'country': 'India', 'date_of_birth': '1990-01-01',
    }
    await expect_http_error(routes_player.onboarding_profile(
        OnboardingProfileRequest(
            display_name='Race Player', country='India',
            date_of_birth='1990-01-01', avatar='star', accepted_terms=True,
        ),
        stale_profile_user,
    ), 409, 'ACCOUNT_STATE_CHANGED')
    assert (await database.users.find_one({'id': profile_race_id}))['status'] == 'ACTIVE'

    submit_race_id = 'onboarding-submit-race'
    await database.users.insert_one({
        'id': submit_race_id, 'role': 'PLAYER', 'status': 'ACTIVE',
        'contact_verified': True, 'email_verified': True,
        'accepted_terms': True,
    })
    stale_submit_user = {
        'id': submit_race_id, 'role': 'PLAYER', 'status': 'PROFILE_SUBMITTED',
        'contact_verified': True, 'email_verified': True,
        'accepted_terms': True,
    }
    await expect_http_error(
        routes_player.onboarding_submit(stale_submit_user),
        409, 'ACCOUNT_STATE_CHANGED',
    )
    assert (await database.users.find_one({'id': submit_race_id}))['status'] == 'ACTIVE'
    assert await database.notifications.count_documents({
        'user_id': submit_race_id, 'type': 'ONBOARDING',
    }) == 0

    # Submission status and its under-review notification execute inside the
    # same transaction callback, so an approval cannot be interposed between
    # those writes.
    atomic_submit_id = 'onboarding-submit-atomic'
    await database.users.insert_one({
        'id': atomic_submit_id, 'role': 'PLAYER', 'status': 'PROFILE_SUBMITTED',
        'contact_verified': True, 'email_verified': True,
        'accepted_terms': True,
    })
    original_onboarding_runner = routes_player._run_onboarding_transaction
    original_player_notify = routes_player._notify
    inside_submission_transaction = {'value': False}

    async def observing_onboarding_runner(callback):
        inside_submission_transaction['value'] = True
        try:
            return await callback(None)
        finally:
            inside_submission_transaction['value'] = False

    async def observing_player_notify(*args, **kwargs):
        assert inside_submission_transaction['value'] is True
        return await original_player_notify(*args, **kwargs)

    routes_player._run_onboarding_transaction = observing_onboarding_runner
    routes_player._notify = observing_player_notify
    try:
        submitted = await routes_player.onboarding_submit({
            'id': atomic_submit_id, 'role': 'PLAYER',
            'status': 'PROFILE_SUBMITTED', 'contact_verified': True,
            'email_verified': True, 'accepted_terms': True,
        })
    finally:
        routes_player._run_onboarding_transaction = original_onboarding_runner
        routes_player._notify = original_player_notify
    assert submitted['user']['status'] == 'PENDING'
    assert await database.notifications.count_documents({
        'user_id': atomic_submit_id, 'type': 'ONBOARDING',
    }) == 1

    reject_race_id = 'onboarding-reject-race'
    await database.users.insert_one({
        'id': reject_race_id, 'role': 'PLAYER', 'status': 'PENDING',
    })
    original_account_runner = routes_admin._run_account_transaction

    async def approval_wins_reject_race(callback):
        await database.users.update_one(
            {'id': reject_race_id}, {'$set': {'status': 'ACTIVE'}},
        )
        return await callback(None)

    routes_admin._run_account_transaction = approval_wins_reject_race
    try:
        await expect_http_error(
            routes_admin.reject_user(
                reject_race_id, AdminUserAction(note='stale rejection'),
                {'id': 'admin-1', 'role': 'ADMIN', 'status': 'ACTIVE'},
            ),
            409, 'ACCOUNT_STATE_CHANGED',
        )
    finally:
        routes_admin._run_account_transaction = original_account_runner
    assert (await database.users.find_one({'id': reject_race_id}))['status'] == 'ACTIVE'
    assert await database.notifications.count_documents({
        'user_id': reject_race_id, 'type': 'REJECTION',
    }) == 0

    # Self-service admin approval cannot bypass contact verification, accepted
    # terms, profile submission, jurisdiction, or age review.
    await database.users.insert_one({
        'id': 'approval-user', 'role': 'PLAYER', 'status': 'PENDING',
        'registration_source': 'SELF_SERVICE', 'contact_verified': False,
        'country': 'India', 'date_of_birth': '1990-01-01',
    })
    admin = {'id': 'admin-1', 'role': 'ADMIN', 'status': 'ACTIVE'}
    await expect_http_error(
        routes_admin.approve_user('approval-user', AdminUserAction(), admin),
        403, 'CONTACT_NOT_VERIFIED',
    )
    await database.users.update_one({'id': 'approval-user'}, {'$set': {
        'contact_verified': True, 'phone_verified': True,
    }})
    await expect_http_error(
        routes_admin.approve_user('approval-user', AdminUserAction(), admin),
        403, 'TERMS_NOT_ACCEPTED',
    )
    await database.users.update_one({'id': 'approval-user'}, {'$set': {
        'accepted_terms': True,
    }})
    await expect_http_error(
        routes_admin.approve_user('approval-user', AdminUserAction(), admin),
        403, 'ONBOARDING_NOT_SUBMITTED',
    )
    await database.users.update_one({'id': 'approval-user'}, {'$set': {
        'submitted_at': datetime.now(timezone.utc).isoformat(),
        'country': 'unknown place',
    }})
    await expect_http_error(
        routes_admin.approve_user('approval-user', AdminUserAction(), admin),
        403, 'COUNTRY_UNKNOWN',
    )
    await database.users.update_one({'id': 'approval-user'}, {'$set': {
        'country': 'India', 'date_of_birth': None,
    }})
    age_error = await expect_http_error(
        routes_admin.approve_user('approval-user', AdminUserAction(), admin), 403,
    )
    assert 'AGE_UNKNOWN' in str(age_error.detail)
    await database.users.update_one({'id': 'approval-user'}, {'$set': {
        'date_of_birth': '1990-01-01',
    }})
    approved = await routes_admin.approve_user(
        'approval-user', AdminUserAction(), admin,
    )
    assert approved['user']['status'] == 'ACTIVE'
    assert approved['user']['chip_balance'] == routes_admin.WELCOME_BONUS
    await expect_http_error(
        routes_admin.approve_user('approval-user', AdminUserAction(), admin), 400,
    )
    assert await database.chip_transactions.count_documents({
        'user_id': 'approval-user',
        'ref': 'account-approval:approval-user',
    }) == 1

    # Play-chip operation remains backward-compatible. If real-money mode is
    # explicitly enabled later, every game dependency fails closed on age,
    # KYC and the registered-country allowlist before gameplay can begin.
    gameplay_user = {
        'id': 'gameplay-user', 'role': 'PLAYER', 'status': 'ACTIVE',
        'country': 'India', 'date_of_birth': '1990-01-01',
    }
    os.environ['REAL_MONEY_ENABLED'] = 'false'
    os.environ.pop('FINANCIAL_ALLOWED_COUNTRIES', None)
    assert await auth_utils.require_active_player(gameplay_user) is gameplay_user

    os.environ['REAL_MONEY_ENABLED'] = 'true'
    gameplay_user['financial_status'] = 'REVIEW_REQUIRED'
    await expect_http_error(
        auth_utils.require_active_player(gameplay_user), 403,
        'FINANCIAL_ACCOUNT_RESTRICTED',
    )
    gameplay_user['financial_status'] = 'ACTIVE'
    legacy_error = await expect_http_error(
        asyncio.to_thread(auth_utils.require_legacy_chip_mutation_allowed),
        409, 'LEGACY_CHIP_FLOW_DISABLED',
    )
    assert legacy_error.detail['code'] == 'LEGACY_CHIP_FLOW_DISABLED'
    await expect_http_error(
        auth_utils.require_active_player(gameplay_user), 403, 'AGE_NOT_VERIFIED',
    )
    gameplay_user['age_verified'] = True
    await expect_http_error(
        auth_utils.require_active_player(gameplay_user), 403, 'KYC_REQUIRED',
    )
    gameplay_user['kyc_status'] = 'VERIFIED'
    os.environ['FINANCIAL_ALLOWED_COUNTRIES'] = 'GB'
    await expect_http_error(
        auth_utils.require_active_player(gameplay_user), 403, 'FINANCIAL_MARKET_BLOCKED',
    )
    os.environ['FINANCIAL_ALLOWED_COUNTRIES'] = 'GB, IN'
    assert await auth_utils.require_active_player(gameplay_user) is gameplay_user
    os.environ['REAL_MONEY_ENABLED'] = 'false'

    # Age trust is a dedicated, audited KYC privilege. Empty canonical
    # permissions never revive a stale legacy grant, and underage accounts can
    # never be marked verified.
    await database.users.insert_many([
        {
            'id': 'adult-age-review', 'role': 'PLAYER', 'status': 'PENDING',
            'country': 'India', 'date_of_birth': '1990-01-01',
            'age_verified': False,
        },
        {
            'id': 'minor-age-review', 'role': 'PLAYER', 'status': 'PENDING',
            'country': 'India', 'date_of_birth': '2020-01-01',
            'age_verified': False,
        },
    ])
    revoked_admin = {
        'id': 'revoked-admin', 'role': 'ADMIN', 'status': 'ACTIVE',
        'admin_permissions': [], 'permissions': ['KYC_REVIEW'],
    }
    await expect_http_error(
        routes_compliance.verify_age(
            'adult-age-review', AgeVerify(verified=True, note='Evidence checked'),
            revoked_admin,
        ),
        403, 'ADMIN_PERMISSION_REQUIRED',
    )
    bootstrap_admin = {
        'id': 'bootstrap-admin', 'role': 'ADMIN', 'status': 'ACTIVE',
        'admin_permissions': [],
    }
    await expect_http_error(
        routes_compliance.verify_age(
            'adult-age-review', AgeVerify(verified=True, note='Evidence checked'),
            bootstrap_admin,
        ),
        403, 'ADMIN_MFA_REQUIRED',
    )
    kyc_admin = {
        'id': 'kyc-admin', 'role': 'ADMIN', 'status': 'ACTIVE',
        'admin_permissions': ['KYC_REVIEW'],
    }
    await expect_http_error(
        routes_compliance.verify_age(
            'adult-age-review', AgeVerify(verified=True, note='Evidence checked'),
            kyc_admin,
        ),
        403, 'ADMIN_MFA_REQUIRED',
    )
    kyc_admin.update({
        'mfa_enabled': True,
        'mfa_verified_at': datetime.now(timezone.utc),
        'reauthenticated_at': datetime.now(timezone.utc),
        'active_session_id': 'kyc-admin-session',
        'admin_step_up_session_id': 'kyc-admin-session',
    })
    await expect_http_error(
        routes_compliance.verify_age(
            'minor-age-review', AgeVerify(verified=True, note='Evidence checked'),
            kyc_admin,
        ),
        403, 'UNDERAGE',
    )
    reviewed = await routes_compliance.verify_age(
        'adult-age-review', AgeVerify(verified=True, note='Passport checked'),
        kyc_admin,
    )
    assert reviewed['age'] >= 18
    adult = await database.users.find_one({'id': 'adult-age-review'})
    assert adult['age_verified'] is True and adult['age_verified_by'] == 'kyc-admin'
    age_audit = await database.financial_audit.find_one({
        'target_id': 'adult-age-review', 'action': 'AGE_VERIFIED',
    })
    assert age_audit['before']['age_verified'] is False
    assert age_audit['after']['age_verified'] is True

    # Existing active players can complete mobile OTP without registering a
    # second account, while an authorised step-up admin can request or record
    # a manual review with a durable audit trail.
    await database.users.insert_one({
        'id': 'mobile-review-player', 'role': 'PLAYER', 'status': 'ACTIVE',
        'phone': '+919876543219', 'phone_normalized': '+919876543219',
        'phone_verified': False, 'country': 'India',
        'date_of_birth': '1990-01-01',
    })
    mobile_request = await routes_auth.request_my_mobile_verification(
        await database.users.find_one({'id': 'mobile-review-player'}),
    )
    mobile_confirm = await routes_auth.confirm_my_mobile_verification(
        AuthenticatedOtpVerify(
            challenge_id=mobile_request['challenge_id'],
            code=mobile_request['dev_code'],
        ),
        await database.users.find_one({'id': 'mobile-review-player'}),
    )
    assert mobile_confirm['user']['phone_verified'] is True
    await routes_compliance.admin_request_verification(
        'mobile-review-player',
        AdminVerificationRequest(kind='MOBILE', note='Please reconfirm this mobile'),
        kyc_admin,
    )
    requested = await database.verification_requests.find_one({
        'id': 'mobile-review-player:MOBILE',
    })
    assert requested['status'] == 'REQUESTED' and requested['requested_by'] == 'kyc-admin'
    await routes_compliance.verify_mobile_manually(
        'mobile-review-player', AgeVerify(verified=True, note='Carrier record checked'),
        kyc_admin,
    )
    mobile_player = await database.users.find_one({'id': 'mobile-review-player'})
    assert mobile_player['mobile_review_status'] == 'ADMIN_APPROVED'
    assert mobile_player['mobile_review_phone_snapshot'] == '+919876543219'
    mobile_audit = await database.financial_audit.find_one({
        'target_id': 'mobile-review-player', 'action': 'MOBILE_MANUALLY_VERIFIED',
    })
    assert mobile_audit['reason'] == 'Carrier record checked'

    # The age floor is not a mutable business setting. A corrupt historical
    # config is clamped to 18, and both default and country-specific attempts
    # to lower it are rejected before any audited write occurs.
    assert compliance.min_age_for({'min_age': 16}, 'IN') == 18
    assert compliance.min_age_for({
        'min_age': 18, 'min_age_by_country': {'IN': 16},
    }, 'IN') == 18
    await database.compliance_config.update_one(
        {'key': compliance.CONFIG_KEY},
        {'$set': {'key': compliance.CONFIG_KEY, 'min_age': 16,
                  'enforce_market_on_login': False}},
        upsert=True,
    )
    today = datetime.now(timezone.utc).date()
    seventeen_dob = today.replace(year=today.year - 18) + timedelta(days=1)
    await expect_http_error(
        compliance.assert_playable({
            'id': 'seventeen-hard-floor',
            'date_of_birth': seventeen_dob.isoformat(),
            'country': 'India',
        }),
        403, 'UNDERAGE',
    )

    revoked_compliance_admin = {
        'id': 'revoked-compliance-admin', 'role': 'ADMIN', 'status': 'ACTIVE',
        'admin_permissions': [], 'permissions': ['COMPLIANCE_ADMIN'],
        'mfa_enabled': True,
        'mfa_verified_at': datetime.now(timezone.utc),
        'reauthenticated_at': datetime.now(timezone.utc),
    }
    await expect_http_error(
        routes_compliance.patch_config(
            ComplianceConfigUpdate(min_age=19), revoked_compliance_admin),
        403, 'ADMIN_PERMISSION_REQUIRED',
    )
    compliance_admin = {
        'id': 'compliance-admin', 'role': 'ADMIN', 'status': 'ACTIVE',
        'admin_permissions': ['COMPLIANCE_ADMIN'],
    }
    await expect_http_error(
        routes_compliance.patch_config(
            ComplianceConfigUpdate(min_age=19), compliance_admin),
        403, 'ADMIN_MFA_REQUIRED',
    )
    compliance_admin.update({
        'mfa_enabled': True,
        'mfa_verified_at': datetime.now(timezone.utc),
        'reauthenticated_at': datetime.now(timezone.utc),
        'active_session_id': 'compliance-admin-session',
        'admin_step_up_session_id': 'compliance-admin-session',
    })
    await expect_http_error(
        routes_compliance.patch_config(
            ComplianceConfigUpdate(min_age=16), compliance_admin),
        400,
    )
    await expect_http_error(
        routes_compliance.patch_config(
            ComplianceConfigUpdate(min_age_by_country={'GB': 16}),
            compliance_admin,
        ),
        400,
    )
    changed_config = await routes_compliance.patch_config(
        ComplianceConfigUpdate(
            min_age=19, min_age_by_country={'United Kingdom': 21, 'India': 18}),
        compliance_admin,
    )
    assert changed_config['config']['min_age'] == 19
    assert changed_config['config']['min_age_by_country'] == {'GB': 21, 'IN': 18}
    config_audit = await database.financial_audit.find_one({
        'action': 'COMPLIANCE_CONFIG_CHANGED', 'actor_id': 'compliance-admin',
    })
    assert config_audit['before']['min_age'] == 16
    assert config_audit['after']['min_age'] == 19
    assert config_audit['metadata']['changed_fields'] == [
        'min_age', 'min_age_by_country',
    ]

    # Overriding a player's self-exclusion has the same exact privilege and
    # recent MFA/reauth requirements, and the lift plus audit commit together.
    await compliance.exclude(
        'adult-age-review', compliance.SELF_EXCLUSION, days=None,
        source='PLAYER', reason='Player requested permanent exclusion',
    )
    no_step_up = {
        'id': 'compliance-admin', 'role': 'ADMIN', 'status': 'ACTIVE',
        'admin_permissions': ['COMPLIANCE_ADMIN'],
    }
    await expect_http_error(
        routes_compliance.admin_lift(
            'adult-age-review',
            AdminExclusion(reason='Reviewed player request'),
            no_step_up,
        ),
        403, 'ADMIN_MFA_REQUIRED',
    )
    assert await compliance.active_exclusion('adult-age-review') is not None
    lifted = await routes_compliance.admin_lift(
        'adult-age-review',
        AdminExclusion(reason='Reviewed player request'),
        compliance_admin,
    )
    assert lifted['exclusion']['status'] == 'LIFTED'
    lift_audit = await database.financial_audit.find_one({
        'action': 'SELF_EXCLUSION_LIFTED', 'target_id': 'adult-age-review',
    })
    assert lift_audit['before']['status'] == 'ACTIVE'
    assert lift_audit['after']['status'] == 'LIFTED'

    # Mock delivery is a local/test adapter only. Production fails closed and
    # the failed challenge can never be verified.
    os.environ['APP_ENV'] = 'production'
    strong_jwt_secret = os.environ['JWT_SECRET']
    os.environ['JWT_SECRET'] = 'short'
    try:
        auth_utils.create_access_token('production-user', 'PLAYER')
        raise AssertionError('weak production JWT secret was accepted')
    except RuntimeError as exc:
        assert '32 bytes' in str(exc)
    finally:
        os.environ['JWT_SECRET'] = strong_jwt_secret

    class NoSessionClient:
        async def start_session(self):
            raise NotImplementedError('transactions unavailable')

    async def should_not_run(_session):
        raise AssertionError('non-transactional production callback ran')

    auth_database = routes_auth.db
    routes_auth.db = types.SimpleNamespace(client=NoSessionClient())
    try:
        await expect_http_error(
            routes_auth._run_auth_transaction(should_not_run),
            503, 'AUTH_TEMPORARILY_UNAVAILABLE',
        )
    finally:
        routes_auth.db = auth_database

    production_capabilities = await routes_auth.authentication_capabilities()
    assert production_capabilities['registration_enabled'] is False
    assert production_capabilities['email_registration'] is False
    disabled_registration = RegisterRequest(
        channel='PHONE', identifier='+919100000004', phone='+919100000004',
        email='provider-disabled@example.com',
        full_name='Disabled Provider', date_of_birth='1990-01-01', country='India',
        accepted_terms=True,
    )
    await expect_http_error(
        routes_auth.register(disabled_registration), 503, 'OTP_UNAVAILABLE',
    )
    await database.users.insert_one({
        'id': 'provider-disabled-existing', 'role': 'PLAYER', 'status': 'PENDING',
        'phone': '+919100000004', 'phone_normalized': '+919100000004',
    })
    await expect_http_error(
        routes_auth.register(disabled_registration), 503, 'OTP_UNAVAILABLE',
    )
    production_identity = otp_service.normalize_identity('prod@example.com')
    error = await expect_otp_error(
        otp_service.issue_challenge(
            {'id': 'prod-user'}, production_identity, otp_service.VERIFY_CONTACT,
            database=database,
        ),
        'OTP_UNAVAILABLE',
    )
    assert error.status_code == 503
    failed = await database.otp_challenges.find_one({
        'user_id': 'prod-user', 'purpose': otp_service.VERIFY_CONTACT,
    })
    assert failed['status'] == 'DELIVERY_FAILED' and failed['active'] is False

    print('OTP identity: all focused checks passed')


if __name__ == '__main__':
    asyncio.run(main())
