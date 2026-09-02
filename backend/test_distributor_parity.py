"""Distributor CRM parity, credential hygiene and role-isolation checks."""
import asyncio
import json
import os
import sys
import types
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault('APP_ENV', 'test')
os.environ.setdefault('AUTH_ALLOW_NON_TRANSACTIONAL_TESTS', 'true')
os.environ.setdefault('OTP_PEPPER', 'test-only-otp-pepper-with-at-least-32-characters')
os.environ.setdefault('OTP_SMS_ADAPTER', 'mock')
os.environ.setdefault('OTP_EMAIL_ADAPTER', 'mock')
os.environ.setdefault('OTP_EXPOSE_DEV_CODE', 'true')

from fastapi import HTTPException, Response
from mongomock_motor import AsyncMongoMockClient
from pydantic import ValidationError


client = AsyncMongoMockClient()
database = client['test']
sys.modules['db'] = types.SimpleNamespace(
    db=database,
    serialize_doc=lambda value: value,
)

import auth_utils
import crm
import otp_service
import routes_admin
import routes_auth
from models import (AdminCreateUser, AdminSignupApprove, AdminStepUpStart,
                    AdminStepUpVerify, ChangePasswordRequest, LoginRequest)
from models import (DistributorCreate, DistributorLogin, DistributorRate,
                    DistributorStatus, DistributorUpdate)


PASS = FAIL = 0


def T(name, condition):
    global PASS, FAIL
    print(("  PASS  " if condition else "  FAIL  ") + name)
    if condition:
        PASS += 1
    else:
        FAIL += 1


async def raises(coro, code=None):
    try:
        await coro
        return False
    except HTTPException as exc:
        if code is None:
            return True
        detail = exc.detail if isinstance(exc.detail, dict) else {'message': str(exc.detail)}
        return detail.get('code') == code


async def main():
    await otp_service.ensure_indexes()
    await crm.ensure_indexes()
    admin = {
        'id': 'admin-1', 'role': 'ADMIN', 'status': 'ACTIVE',
        'admin_role': 'SUPER_ADMIN',
        'phone': '+919876543210', 'phone_normalized': '+919876543210',
        'phone_verified': True, 'active_session_id': 'admin-session',
        'password_hash': auth_utils.hash_password('ADMIN-PASSWORD-12'),
    }
    await database.users.insert_one(dict(admin))
    step_up = await routes_admin.start_admin_step_up(
        AdminStepUpStart(current_password='ADMIN-PASSWORD-12'), admin,
    )
    await routes_admin.verify_admin_step_up(
        AdminStepUpVerify(
            challenge_id=step_up['challenge_id'], code=step_up['dev_code'],
        ), admin,
    )
    admin = await database.users.find_one({'id': 'admin-1'})
    T('server-owned password plus one-time-code flow enables admin step-up',
      admin.get('mfa_enabled') is True
      and admin.get('mfa_verified_at') is not None
      and admin.get('reauthenticated_at') is not None
      and admin.get('admin_step_up_session_id') == admin.get('active_session_id'))

    fallback_admin = {
        'id': 'admin-fallback', 'role': 'ADMIN', 'status': 'ACTIVE',
        'phone': '+919999999999', 'phone_normalized': '+919999999999',
        'phone_verified': True,
        'email': 'admin-fallback@example.com',
        'email_normalized': 'admin-fallback@example.com',
        'email_verified': True, 'active_session_id': 'fallback-session',
        'password_hash': auth_utils.hash_password('ADMIN-PASSWORD-12'),
    }
    await database.users.insert_one(dict(fallback_admin))
    for _ in range(5):
        await otp_service.consume_persistent_limit(
            'admin_step_up_password', fallback_admin['id'], limit=5,
            window_seconds=15 * 60,
        )
    delivery_channels = []

    async def issue_with_sms_failure(user, identity, purpose):
        delivery_channels.append(identity.channel)
        if identity.channel == 'SMS':
            raise otp_service.OtpConfigurationError('SMS provider rejected delivery')
        return {'challenge_id': 'fallback-challenge', 'channel': 'EMAIL'}

    with patch.object(routes_admin, 'issue_challenge', side_effect=issue_with_sms_failure):
        fallback = await routes_admin.start_admin_step_up(
            AdminStepUpStart(current_password='ADMIN-PASSWORD-12'), fallback_admin,
        )
    T('admin step-up falls back to a verified email when SMS delivery fails',
      fallback['channel'] == 'EMAIL' and delivery_channels == ['SMS', 'EMAIL'])
    T('correct admin password is not blocked by exhausted failed-password attempts',
      fallback['challenge_id'] == 'fallback-challenge')
    T('admin step-up verification resolves the channel used by its challenge',
      routes_admin._admin_step_up_identity(
          fallback_admin, channel='EMAIL',
      ).value == 'admin-fallback@example.com')

    enrollment_admin = {
        'id': 'admin-email-enrollment', 'role': 'ADMIN', 'status': 'ACTIVE',
        'email': 'admin-enrollment@example.com',
        'email_normalized': 'admin-enrollment@example.com',
        'email_verified': False, 'active_session_id': 'enrollment-session',
        'password_hash': auth_utils.hash_password('ADMIN-PASSWORD-12'),
    }
    await database.users.insert_one(dict(enrollment_admin))
    enrollment = await routes_admin.start_admin_step_up(
        AdminStepUpStart(current_password='ADMIN-PASSWORD-12'), enrollment_admin,
    )
    await routes_admin.verify_admin_step_up(
        AdminStepUpVerify(
            challenge_id=enrollment['challenge_id'], code=enrollment['dev_code'],
        ), enrollment_admin,
    )
    enrolled = await database.users.find_one({'id': enrollment_admin['id']})
    T('password-confirmed admin can enroll its stored email through the OTP',
      enrollment['channel'] == 'EMAIL'
      and enrolled.get('email_verified') is True
      and enrolled.get('mfa_enabled') is True)
    wrong_session_admin = {**admin, 'active_session_id': 'replacement-session'}
    T('administrator step-up cannot be inherited by a replacement session',
      await raises(asyncio.to_thread(
          auth_utils.require_recent_admin_step_up, wrong_session_admin,
      ), 'ADMIN_STEP_UP_REQUIRED'))

    otp_down_admin = {
        'id': 'admin-otp-down', 'role': 'ADMIN', 'status': 'ACTIVE',
        'phone': '+919111111111', 'phone_normalized': '+919111111111',
        'phone_verified': True, 'active_session_id': 'otp-down-session',
        'password_hash': auth_utils.hash_password('ADMIN-PASSWORD-12'),
    }
    await database.users.insert_one(dict(otp_down_admin))
    with patch.object(routes_admin, 'delivery_adapter_ready', return_value=False):
        otp_down = await routes_admin.start_admin_step_up(
            AdminStepUpStart(current_password='ADMIN-PASSWORD-12'), otp_down_admin,
        )
    otp_down_row = await database.users.find_one({'id': 'admin-otp-down'})
    T('CRM KYC step-up completes on password when OTP delivery is unavailable',
      otp_down.get('password_only') is True and otp_down.get('verified') is True)
    T('password-only step-up records the MFA window for KYC',
      otp_down_row.get('mfa_enabled') is True
      and otp_down_row.get('admin_step_up_session_id') == 'otp-down-session')

    created = await routes_admin.create_distributor(DistributorCreate(
        name='Northern Network', code='NRTH1', rate_bps=2500,
        email='north@example.com', phone='+441234567890',
        note='Do not place this note in exports', username='north.partner',
    ), admin)
    dist = created['distributor']
    T('create preserves full CRM profile for the admin',
      dist['phone'] == '+441234567890' and dist['note'].startswith('Do not'))
    T('reserved portal username is independent',
      dist['login_username'] == 'north.partner' and dist['code'] == 'NRTH1')

    reservation_race = await asyncio.gather(
        crm.reserve_login_id('cross.collection.race', 'USER', 'race-user'),
        crm.reserve_login_id('cross.collection.race', 'DISTRIBUTOR', 'race-dist'),
        return_exceptions=True,
    )
    T('one shared unique reservation closes users-versus-distributors races',
      sum(not isinstance(result, Exception) for result in reservation_race) == 1
      and sum(isinstance(result, ValueError) for result in reservation_race) == 1)

    with patch.object(
        routes_admin, '_issue_username', side_effect=['NRTH1', 'GK9999999'],
    ):
        player_created = await routes_admin.admin_create_user(
            AdminCreateUser(full_name='Reserved ID check', starting_chips=0), admin,
        )
    T('automatic player allocation skips distributor referral-code reservations',
      player_created['username'] == 'GK9999999')
    await database.signup_requests.insert_one({
        'id': 'reserved-login-request', 'status': 'PENDING',
        'email': 'reserved.player@example.com', 'full_name': 'Reserved Player',
    })
    reserved_player_refused = False
    try:
        await routes_admin.approve_signup_request(
            'reserved-login-request', AdminSignupApprove(
                username='north.partner', password='PLAYER-PASSWORD-12',
                starting_chips=0,
            ), admin,
        )
    except HTTPException as exc:
        reserved_player_refused = exc.status_code == 409
    T('manual player approval cannot consume an independent distributor Login ID',
      reserved_player_refused)
    reserved_request = await database.signup_requests.find_one({
        'id': 'reserved-login-request',
    })
    T('a reserved-ID rejection leaves the signup request pending',
      reserved_request.get('status') == 'PENDING')

    listing = await routes_admin.list_distributors(
        q='north.partner', status='ACTIVE', limit=500, admin=admin,
    )
    T('admin search covers portal username',
      listing['total'] == 1 and listing['distributors'][0]['id'] == dist['id'])

    updated = await routes_admin.update_distributor(
        dist['id'], DistributorUpdate(
            name='Northern Partners', phone='+449999999999',
            note='Updated internal note', username='north.network',
            expected_version=dist['record_version'],
        ), admin,
    )
    T('profile update leaves referral code unchanged',
      updated['distributor']['code'] == 'NRTH1')
    T('profile and independent Login ID update together',
      updated['distributor']['phone'] == '+449999999999'
      and updated['distributor']['login_username'] == 'north.network')
    T('profile mutation advances the public optimistic-lock version',
      updated['distributor']['record_version'] == dist['record_version'] + 1)
    T('a stale CRM edit is rejected instead of silently overwriting',
      await raises(routes_admin.update_distributor(
          dist['id'], DistributorUpdate(
              name='Stale overwrite', expected_version=dist['record_version'],
          ), admin,
      ), 'DISTRIBUTOR_VERSION_CONFLICT'))
    after_stale_edit = await database.distributors.find_one({'id': dist['id']})
    T('stale edit rejection preserves the committed CRM profile',
      after_stale_edit['name'] == 'Northern Partners')

    short_refused = False
    try:
        DistributorLogin(email='north@example.com', password='too-short')
    except ValidationError:
        short_refused = True
    T('temporary password must contain at least 12 characters', short_refused)
    forced_change_cannot_be_disabled = False
    try:
        DistributorLogin(
            email='north@example.com', password='TEMPORARY-12',
            must_change_password=False,
        )
    except ValidationError:
        forced_change_cannot_be_disabled = True
    T('first-login password change cannot be disabled', forced_change_cannot_be_disabled)

    await database.login_id_reservations.drop_index(crm.LOGIN_ID_RESERVATION_INDEX)
    T('credential mutation fails closed when a uniqueness index is missing',
      await raises(routes_admin.issue_distributor_login(
          dist['id'], DistributorLogin(
              email='north@example.com', username='north.network',
              password='TEMPORARY-12',
          ), Response(), admin,
      ), 'DISTRIBUTOR_IDENTITY_NOT_READY'))
    await database.login_id_reservations.create_index(
        'key', unique=True, name=crm.LOGIN_ID_RESERVATION_INDEX,
    )

    T('credential issuance fails closed without administrator MFA',
      await raises(routes_admin.issue_distributor_login(
          dist['id'], DistributorLogin(
              email='north@example.com', username='north.network',
              password='TEMPORARY-12',
          ), Response(), {
              'id': 'legacy-admin', 'role': 'ADMIN', 'status': 'ACTIVE',
              'admin_role': 'SUPER_ADMIN',
          },
      ), 'ADMIN_MFA_REQUIRED'))

    credential_response = Response()
    issued = await routes_admin.issue_distributor_login(
        dist['id'], DistributorLogin(
            email='north@example.com', username='north.network',
            password='TEMPORARY-12', must_change_password=True,
        ), credential_response, admin,
    )
    T('credential response is one-time and marks forced change',
      issued['login_id'] == 'north.network'
      and issued['must_change_password'] is True)
    T('plaintext credential response cannot be cached',
      credential_response.headers.get('cache-control', '').startswith('no-store'))
    detail = await routes_admin.distributor_detail(dist['id'], admin)
    detail_text = json.dumps(detail, default=str)
    T('admin detail exposes status but never credential material',
      detail['distributor']['login']['password_change_required'] is True
      and 'password_hash' not in detail_text
      and 'active_session_id' not in detail_text
      and 'TEMPORARY-12' not in detail_text)

    login_user = await database.users.find_one({'id': detail['distributor']['user_id']})
    public_login_user = auth_utils.public_user(login_user)
    T('signed-in responses omit internal identity and provisioning fields',
      'username_key' not in public_login_user
      and 'active_session_id' not in public_login_user
      and 'password_provisioned_by' not in public_login_user)
    await database.users.update_one({'id': login_user['id']}, {'$set': {
        'password_failed_attempts': 5,
        'locked_until': '2099-01-01T00:00:00+00:00',
    }})
    await routes_admin.issue_distributor_login(
        dist['id'], DistributorLogin(
            email='north@example.com', username='north.network',
            password='TEMPORARY-12',
        ), Response(), admin,
    )
    login_user = await database.users.find_one({'id': login_user['id']})
    T('administrator credential reset clears login lockout state',
      login_user.get('password_failed_attempts') == 0
      and 'locked_until' not in login_user)
    T('partner credential cannot enter player routes',
      await raises(auth_utils.require_active_player(login_user), 'NOT_A_PLAYER'))
    T('forced-change credential cannot enter partner data routes',
      await raises(auth_utils.require_distributor(login_user), 'PASSWORD_CHANGE_REQUIRED'))
    T('forced-change credential cannot enter shared signed-in routes',
      await raises(auth_utils.require_password_ready_user(login_user), 'PASSWORD_CHANGE_REQUIRED'))
    T('player login surface rejects a distributor before session minting',
      await raises(routes_auth.login(LoginRequest(
          identity='north.network', password='TEMPORARY-12',
          login_surface='PLAYER',
      )), 'LOGIN_SURFACE_MISMATCH'))
    after_surface_mismatch = await database.users.find_one({'id': login_user['id']})
    T('surface mismatch does not replace the current session',
      after_surface_mismatch.get('active_session_id') == login_user.get('active_session_id'))

    player_password = auth_utils.hash_password('PLAYER-PASSWORD-12')
    await database.users.insert_one({
        'id': 'surface-player', 'username': 'surface.player',
        'username_key': 'surface.player', 'password_hash': player_password,
        'role': 'PLAYER', 'status': 'ACTIVE', 'active_session_id': 'player-session',
    })
    T('distributor login surface rejects a player before session minting',
      await raises(routes_auth.login(LoginRequest(
          identity='surface.player', password='PLAYER-PASSWORD-12',
          login_surface='DISTRIBUTOR',
      )), 'LOGIN_SURFACE_MISMATCH'))
    surface_player = await database.users.find_one({'id': 'surface-player'})
    T('player session also survives a wrong distributor surface',
      surface_player.get('active_session_id') == 'player-session')

    class RacingUsers:
        def __init__(self, collection):
            self.collection = collection
            self.raced = False

        def __getattr__(self, name):
            return getattr(self.collection, name)

        async def find_one_and_update(self, query, update, *args, **kwargs):
            if not self.raced and update.get('$set', {}).get('active_session_id'):
                self.raced = True
                await self.collection.update_one({'id': login_user['id']}, {'$set': {
                    'password_hash': auth_utils.hash_password('ADMIN-RESET-PASSWORD'),
                    'active_session_id': 'revoked-by-admin',
                }})
            return await self.collection.find_one_and_update(query, update, *args, **kwargs)

    class RacingDatabase:
        def __init__(self, underlying):
            self.underlying = underlying
            self.users = RacingUsers(underlying.users)

        def __getattr__(self, name):
            return getattr(self.underlying, name)

    original_auth_database = routes_auth.db
    routes_auth.db = RacingDatabase(database)
    old_password_login_blocked = False
    try:
        await routes_auth.login(LoginRequest(
            identity='north.network', password='TEMPORARY-12',
        ))
    except HTTPException as exc:
        old_password_login_blocked = exc.status_code == 401
    finally:
        routes_auth.db = original_auth_database
    T('admin reset wins against an in-flight old-password login', old_password_login_blocked)

    await database.users.update_one({'id': login_user['id']}, {
        '$set': {
            'password_hash': login_user['password_hash'],
            'password_change_required': True,
        },
        '$unset': {'active_session_id': ''},
    })
    stale_user = await database.users.find_one({'id': login_user['id']})
    await database.users.update_one({'id': login_user['id']}, {'$set': {
        'password_hash': auth_utils.hash_password('SECOND-ADMIN-RESET'),
        'active_session_id': 'second-admin-revocation',
    }})
    T('admin reset wins against an in-flight password change',
      await raises(routes_auth.change_password(ChangePasswordRequest(
          current_password='TEMPORARY-12', new_password='DIFFERENT-PASSWORD-13',
      ), stale_user), 'CREDENTIALS_CHANGED'))
    await database.users.update_one({'id': login_user['id']}, {
        '$set': {
            'password_hash': login_user['password_hash'],
            'password_change_required': True,
        },
        '$unset': {'active_session_id': ''},
    })
    login_user = await database.users.find_one({'id': login_user['id']})
    T('partner cannot replace the temporary secret with whitespace',
      await raises(routes_auth.change_password(ChangePasswordRequest(
          current_password='TEMPORARY-12', new_password='        ',
      ), login_user), 'DISTRIBUTOR_PASSWORD_TOO_WEAK'))
    T('temporary password cannot be submitted as its own replacement',
      await raises(routes_auth.change_password(ChangePasswordRequest(
          current_password='TEMPORARY-12', new_password='TEMPORARY-12',
      ), login_user), 'NEW_PASSWORD_MUST_DIFFER'))
    await routes_auth.change_password(ChangePasswordRequest(
        current_password='TEMPORARY-12', new_password='DIFFERENT-PASSWORD-13',
    ), login_user)
    changed_user = await database.users.find_one({'id': login_user['id']})
    T('a genuinely new password clears forced-change and revokes the session',
      changed_user['password_change_required'] is False
      and changed_user['active_session_id'].startswith('revoked-'))

    await routes_admin.change_rate(
        dist['id'], DistributorRate(rate_bps=2750, note='New period'), admin,
    )
    rates = await routes_admin.distributor_rate_history(dist['id'], admin)
    T('effective-dated rate history is exposed without overwriting',
      rates['count'] == 2
      and rates['rates'][0]['rate_bps'] == 2750
      and rates['rates'][1]['rate_bps'] == 2500)

    await database.users.update_one(
        {'id': login_user['id']},
        {'$set': {'active_session_id': 'live-session', 'password_change_required': False}},
    )
    await routes_admin.set_distributor_status(
        dist['id'], DistributorStatus(status='disabled'), admin,
    )
    disabled = await database.users.find_one({'id': login_user['id']})
    T('DISABLED revokes the current partner session',
      disabled['status'] == 'DISABLED'
      and disabled['active_session_id'].startswith('revoked-'))
    T('disabled credential remains outside the portal',
      await raises(auth_utils.require_distributor(disabled), 'DISTRIBUTOR_LOGIN_DISABLED'))

    exported = await routes_admin.export_distributors(admin)
    csv_text = exported.body.decode()
    T('admin export includes operating fields', 'NRTH1' in csv_text and 'DISABLED' in csv_text)
    T('admin export omits private contacts and notes',
      'north@example.com' not in csv_text
      and '+449999999999' not in csv_text
      and 'Updated internal note' not in csv_text)

    audit = await routes_admin.distributor_audit(dist['id'], admin)
    audit_text = json.dumps(audit, default=str)
    T('every mutation has an additive audit event', audit['count'] >= 5)
    T('audit contains no password or contact values',
      'TEMPORARY-12' not in audit_text
      and 'north@example.com' not in audit_text
      and '+449999999999' not in audit_text
      and 'Updated internal note' not in audit_text)

    revoked_admin = {
        'id': 'admin-2', 'role': 'ADMIN', 'status': 'ACTIVE',
        'admin_permissions': [],
    }
    T('explicitly revoked admin cannot read distributor records',
      await raises(routes_admin.list_distributors(
          q=None, status=None, limit=500, admin=revoked_admin,
      ), 'ADMIN_PERMISSION_REQUIRED'))

    print(f"\n  {PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
else:
    # The canonical backend suite executes legacy script-style checks in an
    # isolated subprocess. Keep an explicit-file pytest invocation safe too:
    # importing this module must never raise SystemExit inside an xdist worker.
    def test_distributor_parity_script():
        import subprocess

        completed = subprocess.run(
            [sys.executable, __file__],
            cwd=os.path.dirname(os.path.dirname(__file__)),
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        assert completed.returncode == 0, (
            f'parity script exited with {completed.returncode}\n'
            f'stdout:\n{completed.stdout}\nstderr:\n{completed.stderr}'
        )
