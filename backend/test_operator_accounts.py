"""Operator provisioning must never create a player wallet or leak a password."""
import asyncio
import os
import sys
import types

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fastapi import HTTPException
from mongomock_motor import AsyncMongoMockClient

client = AsyncMongoMockClient()


def _serialize(doc):
    if isinstance(doc, list):
        return [_serialize(item) for item in doc]
    if isinstance(doc, dict):
        return {k: _serialize(v) for k, v in doc.items()
                if k not in {'_id', 'password_hash'}}
    return doc


sys.modules['db'] = types.SimpleNamespace(
    db=client['operator_test'],
    serialize_doc=_serialize,
)

import routes_admin as admin_routes
import routes_compliance as compliance_routes
import routes_auth as auth_routes
from auth_utils import hash_password, verify_password
from models import (AdminCreateOperator, AdminExclusion, AdminSetEmail,
                    AdminSetPassword, AgeVerify, LimitSet, PlayerReassign,
                    SupportMessageCreate, AdminSignupApprove,
                    ForgotPasswordRequest, ResetPasswordRequest)

db = client['operator_test']
PASS = FAIL = 0


def check(name, condition):
    global PASS, FAIL
    print(("  PASS  " if condition else "  FAIL  ") + name)
    if condition:
        PASS += 1
    else:
        FAIL += 1


async def main():
    await db.users.create_index('login_key', unique=True, sparse=True)
    owner = {
        'id': 'owner-1', 'email': 'owner@mydgp.casino', 'role': 'ADMIN',
        'username': 'owner', 'password_hash': hash_password('OwnerFixture@2026'),
        'status': 'ACTIVE', 'active_session_id': 'owner-live',
    }
    await db.users.insert_one(owner)
    payload = AdminCreateOperator(username='Test.operator', password='TestOperator@2026')
    response = await admin_routes.admin_create_operator(payload, owner)
    row = await db.users.find_one({'username': 'Test.operator'})

    check('operator is active administrator', row['role'] == 'ADMIN' and row['status'] == 'ACTIVE')
    check('operator has no play wallet', row['chip_balance'] == 0 and row['points_balance'] == 0)
    check('password is never returned', 'password' not in response and 'password_hash' not in response['operator'])
    check('password is hashed', row['password_hash'] != 'TestOperator@2026' and verify_password('TestOperator@2026', row['password_hash']))
    check('operator has a canonical login key', row['login_key'] == 'test.operator')
    audit = await db.admin_audit.find_one({'target_id': row['id'], 'action': 'OPERATOR_CREATED'})
    check('provisioning is audited', audit is not None and audit['actor_id'] == owner['id'])

    listed = await admin_routes.admin_list_operators(owner)
    check('primary can inventory delegated operators',
          len(listed['operators']) == 1 and listed['operators'][0]['id'] == row['id'])

    duplicate = False
    try:
        await admin_routes.admin_create_operator(
            AdminCreateOperator(username='test.operator', password='TestOperator@2026'), owner)
    except HTTPException as exc:
        duplicate = exc.status_code == 409
    check('operator IDs are case-insensitively unique', duplicate)

    junior = {'id': row['id'], 'email': row['email'], 'role': 'ADMIN', 'operator_created_by': owner['id']}
    blocked = False
    try:
        await admin_routes.admin_create_operator(
            AdminCreateOperator(username='Second.admin', password='Another@2026'), junior)
    except HTTPException as exc:
        blocked = exc.status_code == 403
    check('a delegated operator cannot create another operator', blocked)

    delegated_inventory = False
    try:
        await admin_routes.admin_list_operators(junior)
    except HTTPException as exc:
        delegated_inventory = exc.status_code == 403
    check('a delegated operator cannot inventory administrators', delegated_inventory)

    primary_password_hash = owner['password_hash']
    protected_password = False
    try:
        await admin_routes.admin_reset_password(
            owner['id'], AdminSetPassword(password='ChangedOwner@2026'), junior)
    except HTTPException as exc:
        protected_password = exc.status_code == 403
    owner_after_reset = await db.users.find_one({'id': owner['id']})
    check('a delegated operator cannot reset a primary admin password',
          protected_password and owner_after_reset['password_hash'] == primary_password_hash)

    primary_email = owner['email']
    protected_email = False
    try:
        await admin_routes.admin_change_email(
            owner['id'], AdminSetEmail(email='changed-owner@mydgp.casino'), junior)
    except HTTPException as exc:
        protected_email = exc.status_code == 403
    owner_after_email = await db.users.find_one({'id': owner['id']})
    check('a delegated operator cannot change a primary admin email',
          protected_email and owner_after_email['email'] == primary_email)

    forgot_response = await auth_routes.forgot_password(ForgotPasswordRequest(email=row['email']))
    row_after_forgot = await db.users.find_one({'id': row['id']})
    reset_blocked = False
    try:
        await auth_routes.reset_password(ResetPasswordRequest(
            email=row['email'], code='000000', new_password='ResetFixture@2026'))
    except HTTPException as exc:
        reset_blocked = exc.status_code == 400
    check('public email recovery is disabled for administrators',
          'dev_code' not in forgot_response and 'reset_code_hash' not in row_after_forgot and reset_blocked)

    # Every endpoint labelled /players/{id} rejects non-player identities
    # before it can mutate their session, limits, support thread or attribution.
    async def rejects_admin_target(coro):
        try:
            await coro
        except HTTPException as exc:
            return exc.status_code == 404
        return False

    await db.support_messages.insert_one({
        'id': 'owner-support', 'user_id': owner['id'], 'sender': 'USER',
        'read_admin': False, 'body': 'private operator record',
    })
    player_target_results = [
        await rejects_admin_target(compliance_routes.admin_exclude(
            owner['id'], AdminExclusion(days=1, reason='fixture'), junior)),
        await rejects_admin_target(compliance_routes.admin_lift(
            owner['id'], AdminExclusion(reason='fixture'), junior)),
        await rejects_admin_target(compliance_routes.verify_age(
            owner['id'], AgeVerify(verified=True), junior)),
        await rejects_admin_target(compliance_routes.player_detail(owner['id'], junior)),
        await rejects_admin_target(compliance_routes.admin_set_limit(
            owner['id'], LimitSet(kind='LOSS', period='DAY', amount=5), junior)),
        await rejects_admin_target(admin_routes.move_player(
            owner['id'], PlayerReassign(distributor_id='dist-1'), junior)),
        await rejects_admin_target(admin_routes.support_thread_detail(owner['id'], junior)),
        await rejects_admin_target(admin_routes.support_reply(
            owner['id'], SupportMessageCreate(body='fixture'), junior)),
    ]
    owner_after_targeting = await db.users.find_one({'id': owner['id']})
    owner_support = await db.support_messages.find_one({'id': 'owner-support'})
    check('player-only admin routes reject administrator targets', all(player_target_results))
    check('rejected administrator targeting cannot revoke a primary session',
          owner_after_targeting['active_session_id'] == 'owner-live')
    check('rejected support targeting cannot mark an admin thread read',
          owner_support['read_admin'] is False)

    # Signup IDs are lowercase while operator IDs preserve their display case.
    # The canonical key makes those two representations one login namespace.
    await db.signup_requests.insert_one({
        'id': 'signup-clash', 'status': 'PENDING', 'email': 'candidate@example.test',
        'full_name': 'Candidate', 'date_of_birth': '1990-01-01', 'phone': '+14155552671',
    })
    signup_collision = False
    try:
        await admin_routes.approve_signup_request(
            'signup-clash',
            AdminSignupApprove(username='test.operator', password='Candidate@2026'),
            owner,
        )
    except HTTPException as exc:
        signup_collision = exc.status_code == 409
    signup_after_collision = await db.signup_requests.find_one({'id': 'signup-clash'})
    check('player provisioning cannot shadow an operator login ID', signup_collision)
    check('a collision leaves the signup request pending', signup_after_collision['status'] == 'PENDING')

    revoke = await admin_routes.admin_revoke_operator(row['id'], owner)
    revoked = await db.users.find_one({'id': row['id']})
    revoke_audit = await db.admin_audit.find_one({'target_id': row['id'], 'action': 'OPERATOR_REVOKED'})
    check('primary can revoke a delegated operator immediately',
          revoke['message'] == 'Administrator access revoked'
          and revoked['status'] == 'SUSPENDED'
          and revoked['active_session_id'].startswith('revoked-'))
    check('revocation is audited', revoke_audit is not None)

    print(f"\n  {PASS} passed, {FAIL} failed")
    return FAIL


sys.exit(asyncio.run(main()))
