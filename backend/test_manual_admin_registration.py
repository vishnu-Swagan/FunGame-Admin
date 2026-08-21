"""Focused checks for temporary administrator-reviewed self-registration."""
import asyncio
import os
import sys
import types

from fastapi import HTTPException
from mongomock_motor import AsyncMongoMockClient
from pydantic import ValidationError


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
    await otp_service.ensure_identity_indexes(database=database)
    await crm.ensure_indexes()
    await crm.ensure_house_account()

    capabilities = await routes_auth.authentication_capabilities()
    assert capabilities == {
        'registration_enabled': True,
        'email_registration': True,
        'phone_registration': True,
        'phone_verification_required': False,
        'email_password_reset': False,
        'phone_password_reset': False,
        'verification_required': False,
        'manual_admin_review': True,
        'registration_mode': routes_auth.ADMIN_REVIEW_ACTIVATION_MODE,
    }

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

    player = await database.users.find_one({'email_normalized': 'new.player@example.com'})
    assert player['status'] == 'PENDING'
    assert player['activation_mode'] == routes_auth.ADMIN_REVIEW_ACTIVATION_MODE
    assert player['contact_verification_status'] == routes_auth.ADMIN_REVIEW_PENDING
    assert player['manual_contact_reviewed'] is False
    assert player['contact_verified'] is False
    assert player['email_verified'] is False
    assert player['phone_verified'] is False
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
    assert listed_player['phone'] == '+919876543210'
    assert listed_player['email'] == 'new.player@example.com'
    assert 'password_hash' not in listed_player

    # A collision cannot disclose which contact matched and cannot overwrite
    # the original password or create a second CRM attribution.
    collision = await routes_auth.register(registration(
        identifier='+919876543211', phone='+919876543211',
        password='Replacement-Password-9',
        password_confirmation='Replacement-Password-9',
    ))
    assert set(collision) == set(response)
    assert collision['message'] == response['message']
    assert await database.users.count_documents({}) == 1
    assert await database.player_attribution.count_documents({'user_id': player['id']}) == 1
    player = await database.users.find_one({'id': player['id']})
    assert auth_utils.verify_password('Strong-Password-9', player['password_hash'])
    assert not auth_utils.verify_password('Replacement-Password-9', player['password_hash'])

    wrong = await expect_http_error(routes_auth.login(LoginRequest(
        identifier='new.player@example.com', email='new.player@example.com',
        password='Wrong-Password-9',
    )), 401)
    assert wrong.detail == routes_auth.INVALID_LOGIN_MESSAGE
    await expect_http_error(routes_auth.login(LoginRequest(
        identifier='new.player@example.com', email='new.player@example.com',
        password='Strong-Password-9',
    )), 403, 'ACCOUNT_PENDING_REVIEW')

    admin = {'id': 'admin-1', 'role': 'ADMIN', 'status': 'ACTIVE'}
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

    # Restoring PHONE_OTP is configuration-only; no provider claim is made
    # while its adapter remains disabled.
    os.environ['REGISTRATION_MODE'] = 'PHONE_OTP'
    otp_capabilities = await routes_auth.authentication_capabilities()
    assert otp_capabilities['registration_enabled'] is False
    assert otp_capabilities['registration_mode'] == 'PHONE_OTP'

    print('Manual admin registration: all focused checks passed')


if __name__ == '__main__':
    asyncio.run(main())
