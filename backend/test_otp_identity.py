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

import otp_service
import auth_utils
import compliance
import routes_auth
import routes_admin
import routes_compliance
from models import (
    AgeVerify,
    AdminExclusion,
    AdminUserAction,
    ComplianceConfigUpdate,
    LoginRequest,
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
    capabilities = await routes_auth.authentication_capabilities()
    assert capabilities['registration_enabled'] is True
    assert capabilities['email_registration'] is True
    assert capabilities['phone_registration'] is True

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

    # Real registration contract: UI aliases, contact verification and PENDING
    # review state. Contact OTP must never grant KYC identity verification.
    registration = await routes_auth.register(RegisterRequest(
        channel='EMAIL', identifier='player@example.com', email='player@example.com',
        password='Attacker-Planted-9', full_name='Player One',
        date_of_birth='1990-01-01', country='India',
    ))
    assert registration['channel'] == 'EMAIL'
    assert registration['verification_id'] == registration['challenge_id']
    assert registration['destination_masked'] == registration['destination']
    assert registration['expires_in_seconds'] == 900
    assert registration['resend_after_seconds'] == 60

    # Re-registering an existing contact is opaque regardless of whether the
    # account is verified. In particular, an active OTP cooldown must not leak
    # the unverified state as a 429 response or replace the real challenge.
    duplicate_unverified = await routes_auth.register(RegisterRequest(
        channel='EMAIL', identifier='player@example.com', email='player@example.com',
        password='A-Different-Password-9', full_name='Someone Else',
        date_of_birth='1990-01-01', country='India',
    ))
    assert duplicate_unverified['message'] == routes_auth.GENERIC_REGISTER_MESSAGE
    assert 'dev_code' not in duplicate_unverified
    assert duplicate_unverified['challenge_id'] != registration['challenge_id']
    assert await database.otp_challenges.count_documents({}) == 1
    assert await database.otp_challenges.count_documents({
        'id': registration['challenge_id'], 'active': True,
    }) == 1

    player = await database.users.find_one({'email_normalized': 'player@example.com'})
    assert player['registration_source'] == 'SELF_SERVICE'
    assert player['status'] == 'PENDING'
    assert player['identity_verified'] is False
    assert 'password_hash' not in player

    stored = await database.otp_challenges.find_one({'id': registration['challenge_id']})
    assert 'code' not in stored
    assert 'player@example.com' not in repr(stored)
    assert stored['code_hash'] != hashlib.sha256(registration['dev_code'].encode()).hexdigest()

    verification = await routes_auth.verify_contact(VerifyEmailRequest(
        channel='EMAIL', identifier='player@example.com', email='player@example.com',
        # Real clients may have replaced the server's real id with the opaque
        # duplicate-registration id. Omitting it intentionally selects the
        # one active purpose-bound challenge.
        code=registration['dev_code'],
        password='Victim-Owned-Password-9',
    ))
    assert verification['access_token']
    player = await database.users.find_one({'id': player['id']})
    assert player['contact_verified'] is True
    assert player['email_verified'] is True
    assert player['identity_verified'] is False
    assert player['status'] == 'PENDING'

    # Verified, unknown and locked challenge state all use the same opaque
    # invalid-code contract. A verified contact must never be an existence
    # oracle on the public verification endpoint.
    verified_error = await expect_http_error(
        routes_auth.verify_contact(VerifyEmailRequest(
            channel='EMAIL', identifier='player@example.com',
            email='player@example.com', code='000000',
            password='Victim-Owned-Password-9',
        )),
        400, 'OTP_INVALID',
    )
    unknown_error = await expect_http_error(
        routes_auth.verify_contact(VerifyEmailRequest(
            channel='EMAIL', identifier='nobody@example.com',
            email='nobody@example.com', code='000000',
            password='Victim-Owned-Password-9',
        )),
        400, 'OTP_INVALID',
    )
    assert verified_error.detail == unknown_error.detail

    duplicate_verified = await routes_auth.register(RegisterRequest(
        channel='EMAIL', identifier='player@example.com', email='player@example.com',
        password='Another-Different-9', full_name='Another Name',
        date_of_birth='1990-01-01', country='India',
    ))
    assert set(duplicate_verified) == set(duplicate_unverified)
    assert duplicate_verified['message'] == duplicate_unverified['message']
    assert duplicate_verified['channel'] == duplicate_unverified['channel']
    assert duplicate_verified['destination'] == duplicate_unverified['destination']

    planted_password = await expect_http_error(routes_auth.login(LoginRequest(
        identifier='player@example.com', email='player@example.com',
        password='Attacker-Planted-9',
    )), 401)
    assert planted_password.detail == routes_auth.INVALID_LOGIN_MESSAGE
    login = await routes_auth.login(LoginRequest(
        identifier='player@example.com', email='player@example.com',
        password='Victim-Owned-Password-9',
    ))
    assert login['access_token']
    assert 'active_session_id' not in login['user']

    phone_registration = await routes_auth.register(RegisterRequest(
        channel='PHONE', identifier='+919999888877', phone='+919999888877',
        password='Phone-Password-9', full_name='Phone Player',
        date_of_birth='1990-01-01', country='India',
    ))
    assert phone_registration['channel'] == 'PHONE'
    phone_cooldown = await routes_auth.resend_verification(ResendVerificationRequest(
        channel='PHONE', identifier='+919999888877', phone='+919999888877',
    ))
    assert 'dev_code' not in phone_cooldown
    assert phone_cooldown['challenge_id'] != phone_registration['challenge_id']
    # A cooldown response intentionally carries an opaque id. Verification
    # without an id still accepts the original active code.
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
            otp_service.normalize_identity('player@example.com'),
            registration['dev_code'], otp_service.VERIFY_CONTACT,
            challenge_id=registration['challenge_id'], database=database,
        ),
        'OTP_INVALID',
    )

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
        player, otp_service.normalize_identity('player@example.com'),
        otp_service.RESET_PASSWORD, database=database,
    )
    await routes_auth.reset_password(ResetPasswordRequest(
        identifier='player@example.com', email='player@example.com',
        verification_id=reset['verification_id'], code=reset['dev_code'],
        new_password='A-New-Password-10',
    ))
    changed = await routes_auth.login(LoginRequest(
        identifier='player@example.com', email='player@example.com',
        password='A-New-Password-10',
    ))
    assert changed['access_token']

    # Password checks use a persistent per-account lock while returning the
    # same public 401 for wrong, unknown and temporarily locked accounts.
    for _ in range(routes_auth.PASSWORD_FAILURE_LIMIT):
        failure = await expect_http_error(routes_auth.login(LoginRequest(
            identifier='player@example.com', email='player@example.com',
            password='Definitely-Wrong-10',
        )), 401)
        assert failure.detail == routes_auth.INVALID_LOGIN_MESSAGE
    locked_login = await expect_http_error(routes_auth.login(LoginRequest(
        identifier='player@example.com', email='player@example.com',
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
        identifier='player@example.com', email='player@example.com',
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
    existing_eligibility = await expect_http_error(
        routes_auth.signup_request(existing_signup), 403,
    )
    new_eligibility = await expect_http_error(
        routes_auth.signup_request(new_signup), 403,
    )
    assert existing_eligibility.detail == new_eligibility.detail

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
        opaque_resend = await routes_auth.resend_verification(ResendVerificationRequest(
            channel='EMAIL', identifier=resilient_identity.value,
            email=resilient_identity.value,
        ))
        assert 'dev_code' not in opaque_resend
    finally:
        otp_service.delivery_adapter = original_adapter
    restored = await database.otp_challenges.find_one({'id': resilient['challenge_id']})
    assert restored['active'] is True and restored['status'] == 'PENDING'
    await otp_service.verify_challenge(
        resilient_identity, resilient['dev_code'], otp_service.VERIFY_CONTACT,
        challenge_id=resilient['challenge_id'], database=database,
    )

    # Self-service admin approval refuses unverified contact, unknown country,
    # and missing DOB before any chips or account status can change.
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
        'contact_verified': True, 'phone_verified': True, 'country': 'unknown place',
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
    production_capabilities = await routes_auth.authentication_capabilities()
    assert production_capabilities['registration_enabled'] is False
    assert production_capabilities['email_registration'] is False
    disabled_registration = RegisterRequest(
        channel='EMAIL', identifier='provider-disabled@example.com',
        email='provider-disabled@example.com', password='Strong-Password-10',
        full_name='Disabled Provider', date_of_birth='1990-01-01', country='India',
    )
    await expect_http_error(
        routes_auth.register(disabled_registration), 503, 'OTP_UNAVAILABLE',
    )
    await database.users.insert_one({
        'id': 'provider-disabled-existing', 'role': 'PLAYER', 'status': 'PENDING',
        'email': 'provider-disabled@example.com',
        'email_normalized': 'provider-disabled@example.com',
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
