"""Focused checks for temporary administrator-reviewed self-registration."""
import asyncio
import os
import sys
import types

from fastapi import HTTPException
from mongomock_motor import AsyncMongoMockClient
from pydantic import ValidationError
from pymongo.errors import DuplicateKeyError


sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

client = AsyncMongoMockClient()
database = client['manual_admin_registration_test']
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
os.environ['OTP_SMS_ADAPTER'] = 'disabled'
os.environ['AUTH_ALLOW_NON_TRANSACTIONAL_TESTS'] = 'true'
os.environ['REGISTRATION_MODE'] = 'ADMIN_REVIEW'
os.environ['REAL_MONEY_ENABLED'] = 'false'

import auth_utils
import crm
import otp_service
import routes_admin
import routes_auth
from models import AdminUserAction, LoginRequest, RegisterRequest


async def expect_http_error(coro, status, code=None):
    try:
        await coro
    except HTTPException as exc:
        assert exc.status_code == status, (exc.status_code, status, exc.detail)
        if code:
            assert isinstance(exc.detail, dict), exc.detail
            assert exc.detail.get('code') == code, exc.detail
        return exc
    raise AssertionError(f'Expected HTTP {status}')


def registration(**overrides):
    values = {
        'channel': 'PHONE',
        'identifier': '+919876543210',
        'phone': '+919876543210',
        'email': 'new.player@example.com',
        'full_name': 'New Player',
        'date_of_birth': '1990-01-01',
        'country': 'India',
        'accepted_terms': True,
        'password': 'Strong-Password-9',
        'password_confirmation': 'Strong-Password-9',
    }
    values.update(overrides)
    return RegisterRequest(**values)


async def main():
    # Only normalized-contact guards, transactional storage and immutable CRM
    # attribution are needed. OTP indexes and delivery adapters stay absent.
    await database.users.insert_one({
        'id': 'legacy-manual-application', 'role': 'PLAYER', 'status': 'REJECTED',
        'registration_source': 'SELF_SERVICE', 'activation_mode': 'ADMIN_REVIEW',
        'manual_contact_reviewed': False,
        'email': 'legacy.manual@example.com',
        'email_normalized': 'legacy.manual@example.com',
        'phone': '+919876543299', 'phone_normalized': '+919876543299',
        'primary_identity': '+919876543299', 'primary_identity_channel': 'PHONE',
    })
    await otp_service.ensure_identity_indexes(database=database)
    migrated = await database.users.find_one({'id': 'legacy-manual-application'})
    assert migrated['pending_email'] == 'legacy.manual@example.com'
    assert migrated['pending_phone'] == '+919876543299'
    assert migrated['email'].endswith('.manual.invalid')
    assert 'email_normalized' not in migrated
    assert 'phone' not in migrated
    assert 'phone_normalized' not in migrated
    await database.users.delete_one({'id': migrated['id']})
    await crm.ensure_indexes()
    await crm.ensure_house_account()

    capabilities = await routes_auth.authentication_capabilities()
    assert capabilities == {
        'registration_enabled': True,
        'email_registration': True,
        'phone_registration': True,
        'phone_verification_required': False,
        'email_contact_verification': False,
        'phone_contact_verification': False,
        'email_password_reset': False,
        'phone_password_reset': False,
        'verification_required': False,
        'manual_admin_review': True,
        'registration_mode': routes_auth.ADMIN_REVIEW_ACTIVATION_MODE,
    }

    pepper = os.environ.pop('OTP_PEPPER')
    assert (await routes_auth.authentication_capabilities())['registration_enabled'] is False
    await expect_http_error(
        routes_auth.register(registration(email='pepper@example.com')),
        503, 'OTP_UNAVAILABLE',
    )
    os.environ['OTP_PEPPER'] = pepper

    await expect_http_error(
        routes_auth.register(registration(email=None)), 422, 'EMAIL_REQUIRED',
    )
    await expect_http_error(
        routes_auth.register(registration(password=None, password_confirmation=None)),
        422, 'PASSWORD_REQUIRED',
    )
    await expect_http_error(
        routes_auth.register(registration(accepted_terms=False)), 422, 'TERMS_REQUIRED',
    )
    try:
        registration(password_confirmation='Different-Password-9')
        raise AssertionError('Mismatched password confirmation was accepted')
    except ValidationError:
        pass

    response = await routes_auth.register(registration())
    assert response['review_required'] is True
    assert response['verification_required'] is False
    assert response['registration_mode'] == routes_auth.ADMIN_REVIEW_ACTIVATION_MODE
    assert 'access_token' not in response
    assert 'challenge_id' not in response
    assert 'verification_id' not in response
    assert 'dev_code' not in response

    player = await database.users.find_one({'pending_email': 'new.player@example.com'})
    assert player['status'] == 'PENDING'
    assert player['activation_mode'] == routes_auth.ADMIN_REVIEW_ACTIVATION_MODE
    assert player['contact_verification_status'] == routes_auth.ADMIN_REVIEW_PENDING
    assert player['manual_contact_reviewed'] is False
    assert player['contact_verified'] is False
    assert player['email_verified'] is False
    assert player['phone_verified'] is False
    assert player['pending_email'] == 'new.player@example.com'
    assert player['pending_phone'] == '+919876543210'
    assert player['email'].endswith('.manual.invalid')
    assert 'email_normalized' not in player
    assert 'phone_normalized' not in player
    assert player['submitted_at'] == player['created_at']
    assert player['accepted_terms'] is True
    assert player['chip_balance'] == 0
    assert auth_utils.verify_password('Strong-Password-9', player['password_hash'])
    assert await database.player_attribution.count_documents({
        'user_id': player['id'],
        'active': True,
        'distributor_code': crm.HOUSE_CODE,
        'attributed_by': 'self-registration-admin-review',
    }) == 1

    listed = await routes_admin.list_users(
        status='PENDING', admin={'id': 'admin-1', 'role': 'ADMIN', 'status': 'ACTIVE'},
    )
    listed_player = next(item for item in listed['users'] if item['id'] == player['id'])
    assert listed_player['pending_phone'] == '+919876543210'
    assert listed_player['pending_email'] == 'new.player@example.com'
    assert listed_player['phone'] == '+919876543210'
    assert listed_player['email'] == 'new.player@example.com'
    assert 'password_hash' not in listed_player

    try:
        await database.users.insert_one({
            'id': 'concurrent-duplicate', 'role': 'PLAYER', 'status': 'PENDING',
            'email': 'application-concurrent@account.manual.invalid',
            'pending_email': 'new.player@example.com',
            'pending_phone': '+919876543211',
        })
        raise AssertionError('concurrent duplicate pending email inserted')
    except DuplicateKeyError:
        pass

    # Reusing either submitted contact returns the same opaque response but
    # cannot fill the finite administrator queue with duplicate applications.
    collision = await routes_auth.register(registration(
        identifier='+919876543211', phone='+919876543211',
        password='Replacement-Password-9',
        password_confirmation='Replacement-Password-9',
    ))
    assert set(collision) == set(response)
    assert collision['message'] == response['message']
    assert await database.users.count_documents({}) == 1
    assert await database.player_attribution.count_documents({'user_id': player['id']}) == 1
    assert await database.users.find_one({'pending_phone': '+919876543211'}) is None
    player = await database.users.find_one({'id': player['id']})
    assert auth_utils.verify_password('Strong-Password-9', player['password_hash'])
    assert not auth_utils.verify_password('Replacement-Password-9', player['password_hash'])

    wrong = await expect_http_error(routes_auth.login(LoginRequest(
        identifier='new.player@example.com', email='new.player@example.com',
        password='Wrong-Password-9',
    )), 401)
    assert wrong.detail == routes_auth.INVALID_LOGIN_MESSAGE
    pending = await expect_http_error(routes_auth.login(LoginRequest(
        identifier='new.player@example.com', email='new.player@example.com',
        password='Strong-Password-9',
    )), 401)
    assert pending.detail == routes_auth.INVALID_LOGIN_MESSAGE

    admin = {'id': 'admin-1', 'role': 'ADMIN', 'status': 'ACTIVE'}
    # A contact claimed by an approved account after application submission is
    # still rejected atomically before the provisional fields are promoted.
    await database.users.insert_one({
        'id': 'contact-owner', 'role': 'PLAYER', 'status': 'ACTIVE',
        'email': 'new.player@example.com',
        'email_normalized': 'new.player@example.com',
    })
    await expect_http_error(
        routes_admin.approve_user(player['id'], AdminUserAction(), admin),
        409, 'MANUAL_CONTACT_CONFLICT',
    )
    await database.users.delete_one({'id': 'contact-owner'})
    approved = await routes_admin.approve_user(
        player['id'], AdminUserAction(), admin,
    )
    assert approved['user']['status'] == 'ACTIVE'
    assert approved['user']['approved_by'] == admin['id']
    assert approved['user']['manual_contact_reviewed'] is True
    assert approved['user']['manual_contact_reviewed_by'] == admin['id']
    assert approved['user']['contact_verification_status'] == routes_auth.ADMIN_REVIEW_APPROVED
    assert approved['user']['contact_verified'] is False
    assert approved['user']['email_verified'] is False
    assert approved['user']['phone_verified'] is False
    assert approved['user']['email'] == 'new.player@example.com'
    assert approved['user']['phone'] == '+919876543210'
    assert 'pending_email' not in approved['user']
    assert 'pending_phone' not in approved['user']
    # Registration starts at zero; the existing explicit approval action is
    # still the only place that awards the configured play-chip welcome bonus.
    assert approved['user']['chip_balance'] == routes_admin.WELCOME_BONUS

    email_login = await routes_auth.login(LoginRequest(
        identifier='new.player@example.com', email='new.player@example.com',
        password='Strong-Password-9',
    ))
    assert email_login['access_token']
    phone_login = await routes_auth.login(LoginRequest(
        identifier='+919876543210', phone='+919876543210',
        password='Strong-Password-9',
    ))
    assert phone_login['access_token']
    active = await database.users.find_one({'id': player['id']})
    assert await auth_utils.require_active_player(active) is active

    # Rejecting releases the provisional guard for a fresh application, while
    # the stale rejected row can no longer override that newer pending request.
    stale_values = {
        'identifier': '+919876543212', 'phone': '+919876543212',
        'email': 'resubmitted.player@example.com',
    }
    await routes_auth.register(registration(**stale_values))
    stale = await database.users.find_one({
        'status': 'PENDING', 'pending_email': stale_values['email'],
    })
    await routes_admin.reject_user(
        stale['id'], AdminUserAction(note='Please resubmit'), admin,
    )
    await routes_auth.register(registration(
        **stale_values,
        password='Resubmitted-Password-9',
        password_confirmation='Resubmitted-Password-9',
    ))
    replacement = await database.users.find_one({
        'status': 'PENDING', 'pending_email': stale_values['email'],
    })
    assert replacement['id'] != stale['id']
    await expect_http_error(
        routes_admin.approve_user(stale['id'], AdminUserAction(), admin),
        409, 'MANUAL_CONTACT_CONFLICT',
    )

    # Restoring PHONE_OTP is configuration-only; no provider claim is made
    # while its adapter remains disabled.
    os.environ['REGISTRATION_MODE'] = 'PHONE_OTP'
    otp_capabilities = await routes_auth.authentication_capabilities()
    assert otp_capabilities['registration_enabled'] is False
    assert otp_capabilities['registration_mode'] == 'PHONE_OTP'

    # CRM attribution readiness gates new registration only; healthy OTP
    # delivery must remain available for recovery and legacy verification.
    await otp_service.ensure_indexes(database=database)
    os.environ['OTP_EMAIL_ADAPTER'] = 'mock'
    original_attribution_ready = routes_auth.crm.registration_attribution_ready

    async def attribution_unavailable():
        return False

    routes_auth.crm.registration_attribution_ready = attribution_unavailable
    recovery_only = await routes_auth.authentication_capabilities()
    assert recovery_only['registration_enabled'] is False
    assert recovery_only['email_contact_verification'] is True
    assert recovery_only['email_password_reset'] is True
    routes_auth.crm.registration_attribution_ready = original_attribution_ready

    print('Manual admin registration: all focused checks passed')


if __name__ == '__main__':
    asyncio.run(main())
