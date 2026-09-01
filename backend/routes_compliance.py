"""Responsible play — the player's own controls, and the operator's oversight.

The player routes deliberately hang off `get_current_user` rather than
`require_active_player`. That dependency is where exclusion is enforced, so
using it here would mean an excluded player could not reach the screen that
tells them they are excluded, or the one where they ask to come back. The tools
somebody needs when they have shut themselves out have to keep working after
they have.
"""
import logging
import os
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pymongo import ReturnDocument

import compliance
import ledger
from auth_utils import get_current_user, public_user, require_admin, require_recent_admin_step_up
from db import db, serialize_doc
from models import (LimitSet, ExclusionCreate, ComplianceConfigUpdate,
                    AgeVerify, AdminExclusion, AdminVerificationRequest,
                    PlayerVerificationRequest)
from otp_service import normalize_identity

logger = logging.getLogger('compliance')

router = APIRouter(prefix='/responsible', tags=['responsible play'])
admin_router = APIRouter(prefix='/admin/compliance', tags=['admin compliance'])

# Typing this exactly is the last chance to notice what is being agreed to.
PERMANENT_PHRASE = 'CLOSE MY ACCOUNT PERMANENTLY'


def _admin_permissions(admin: dict) -> set[str]:
    # An explicitly empty canonical list means revoked. Only genuinely legacy
    # records that lack the canonical field may fall back to `permissions`.
    pre_rbac = (
        not str(admin.get('admin_role') or '').strip()
        and 'permissions' not in admin
        and (
            'admin_permissions' not in admin
            or not bool(admin.get('admin_permissions') or [])
        )
    )
    if pre_rbac:
        # The bootstrap production operator predates RBAC migration. Manual
        # approvals remain protected by the same mandatory recent step-up.
        return {'KYC_VIEW', 'KYC_REVIEW'}
    values = (
        admin.get('admin_permissions')
        if 'admin_permissions' in admin
        else admin.get('permissions', [])
    )
    return {str(value).strip().upper() for value in (values or []) if value}


def _require_kyc_review(admin: dict) -> None:
    super_admin = str(admin.get('admin_role') or '').upper() == 'SUPER_ADMIN'
    if not super_admin and 'KYC_REVIEW' not in _admin_permissions(admin):
        raise HTTPException(status_code=403, detail={
            'code': 'ADMIN_PERMISSION_REQUIRED',
            'message': 'Missing permission: KYC_REVIEW.',
        })


def _require_compliance_admin(admin: dict) -> None:
    """Guard trust-changing responsible-play actions with one exact grant."""
    super_admin = str(admin.get('admin_role') or '').upper() == 'SUPER_ADMIN'
    if not super_admin and 'COMPLIANCE_ADMIN' not in _admin_permissions(admin):
        raise HTTPException(status_code=403, detail={
            'code': 'ADMIN_PERMISSION_REQUIRED',
            'message': 'Missing permission: COMPLIANCE_ADMIN.',
        })
    # A Super Admin may bypass the named grant, never the step-up ceremony.
    require_recent_admin_step_up(admin)


async def _transactional_audited_update(callback):
    """A compliance trust change and its audit record commit together."""
    try:
        session_cm = await db.client.start_session()
    except (AttributeError, NotImplementedError):
        if (os.environ.get('APP_ENV') or '').strip().lower() == 'test':
            return await callback(None)
        raise HTTPException(status_code=503, detail={
            'code': 'AUDITED_UPDATE_UNAVAILABLE',
            'message': 'Audited compliance updates are temporarily unavailable.',
        })
    async with session_cm as session:
        return await session.with_transaction(callback)


async def _spend_summary(user_id):
    """What each period has used, whether or not a limit is set on it.

    Shown even with no limit, because seeing the number is what prompts somebody
    to set one — a limits page that is blank until you already care is a page
    for people who already care.
    """
    out = {}
    for period in compliance.PERIODS:
        out[period] = {
            'deposited': await compliance.deposits_in(user_id, period),
            'lost': await compliance.net_loss_in(user_id, period),
            'from': compliance.window_start(period),
        }
    return out


# ------------------------------------------------------------------- player

@router.get('/me')
async def my_controls(user: dict = Depends(get_current_user)):
    if user.get('role') != 'PLAYER':
        raise HTTPException(status_code=403, detail='Only players have play limits')
    exclusion = await compliance.active_exclusion(user['id'])
    cfg = await compliance.get_config()
    return {
        'limits': serialize_doc(await compliance.limits_for(user['id'])),
        'usage': await _spend_summary(user['id']),
        'exclusion': serialize_doc(exclusion),
        'increase_delay_hours': cfg['limit_increase_delay_hours'],
        'reactivation_cooling_hours': cfg['reactivation_cooling_hours'],
        'permanent_phrase': PERMANENT_PHRASE,
    }


@router.post('/age-verification/request')
async def request_age_verification(
    body: PlayerVerificationRequest,
    user: dict = Depends(get_current_user),
):
    if user.get('role') != 'PLAYER' or user.get('status') != 'ACTIVE':
        raise HTTPException(status_code=403, detail={
            'code': 'ACTIVE_PLAYER_REQUIRED',
            'message': 'An active player account is required.',
        })
    if user.get('age_verified') is True or user.get('accepted_terms') is True:
        return {
            'message': 'Your 18+ confirmation is already recorded.',
            'user': public_user(user),
        }
    ok, code, message = await compliance.check_eligibility(
        user.get('country'), user.get('date_of_birth'), require_dob=True,
    )
    if not ok:
        raise HTTPException(status_code=403, detail={'code': code, 'message': message})
    now = compliance.now_iso()
    note = str(body.note or '').strip()
    await db.verification_requests.update_one(
        {'id': f"{user['id']}:AGE"},
        {'$set': {
            'id': f"{user['id']}:AGE", 'user_id': user['id'], 'kind': 'AGE',
            'status': 'PENDING', 'requested_by': user['id'],
            'request_source': 'PLAYER', 'note': note or None,
            'requested_at': now, 'updated_at': now,
        }, '$setOnInsert': {'created_at': now}},
        upsert=True,
    )
    updated = await db.users.find_one_and_update(
        {'id': user['id'], 'role': 'PLAYER', 'status': 'ACTIVE'},
        {'$set': {
            'age_verification_status': 'PENDING',
            'age_verification_requested_at': now,
            'age_verification_request_source': 'PLAYER',
        }},
        return_document=ReturnDocument.AFTER,
    )
    return {
        'message': 'Age verification request submitted for admin review.',
        'user': public_user(updated or user),
    }


@router.post('/limits')
async def set_my_limit(body: LimitSet, user: dict = Depends(get_current_user)):
    if user.get('role') != 'PLAYER':
        raise HTTPException(status_code=403, detail='Only players have play limits')
    try:
        result = await compliance.set_limit(
            user['id'], body.kind.upper(), body.period.upper(), body.amount, actor='PLAYER')
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if result['outcome'] == 'IMMEDIATE':
        message = 'Limit set. It applies from now.'
    else:
        message = (f"Your request is recorded and takes effect in "
                   f"{result['delay_hours']} hours. Your current limit stays in "
                   f"place until then, and you can cancel the change at any time.")
    return {'message': message, **result}


@router.delete('/limits/{kind}/{period}/pending')
async def cancel_my_pending(kind: str, period: str, user: dict = Depends(get_current_user)):
    row = await compliance.cancel_pending(user['id'], kind.upper(), period.upper())
    return {'message': 'Change cancelled. Your current limit stays in place.',
            'limit': serialize_doc(row)}


@router.post('/exclusion')
async def take_a_break(body: ExclusionCreate, user: dict = Depends(get_current_user)):
    """Start a break or self-exclude. One-way until it expires."""
    if user.get('role') != 'PLAYER':
        raise HTTPException(status_code=403, detail='Only players can self-exclude')
    kind = (body.kind or compliance.BREAK).upper()
    if body.days is None:
        # Permanent. The confirmation phrase is the point: a permanent closure
        # reached by tapping through a dialogue is one somebody will reach by
        # accident.
        if kind != compliance.SELF_EXCLUSION:
            raise HTTPException(status_code=400, detail='A break has to have a length')
        if (body.confirm or '').strip().upper() != PERMANENT_PHRASE:
            raise HTTPException(status_code=400, detail={
                'code': 'CONFIRM_REQUIRED',
                'message': f'To close permanently, type: {PERMANENT_PHRASE}',
            })
    try:
        doc = await compliance.exclude(user['id'], kind=kind, days=body.days,
                                       source='PLAYER', reason=body.reason)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # End the session immediately. Leaving a live token would mean the account
    # keeps playing until the next request happens to hit the guard.
    await db.users.update_one({'id': user['id']}, {'$set': {
        'active_session_id': f"excluded-{doc['id']}"}})
    logger.info('player %s excluded (%s, days=%s)', user['id'], kind, body.days)
    ends = doc['ends_at']
    return {'message': ('Your account is now closed to play.'
                        + (f" It reopens after {ends[:10]}." if ends else
                           ' This closure is permanent.')),
            'exclusion': serialize_doc(doc)}


@router.post('/reactivate')
async def reactivate(user: dict = Depends(get_current_user)):
    try:
        return await compliance.request_reactivation(user['id'])
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


# -------------------------------------------------------------------- admin

@admin_router.get('/config')
async def get_config(admin: dict = Depends(require_admin)):
    cfg = await compliance.get_config()
    return {'config': cfg, 'modes': list(compliance.MARKET_MODES),
            'known_countries': sorted(set(compliance._COUNTRY_NAMES.values()))}


@admin_router.patch('/config')
async def patch_config(body: ComplianceConfigUpdate, admin: dict = Depends(require_admin)):
    _require_compliance_admin(admin)
    patch = {k: v for k, v in body.model_dump().items() if v is not None}
    if not patch:
        raise HTTPException(status_code=400, detail='Nothing to change')

    async def apply(session):
        kwargs = {'session': session} if session is not None else {}
        before = await compliance.get_config(session=session)
        try:
            cfg = await compliance.set_config(patch, admin['id'], session=session)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        changed = sorted(patch)
        await db.financial_audit.insert_one({
            'id': str(uuid.uuid4()),
            'actor_id': admin['id'],
            'action': 'COMPLIANCE_CONFIG_CHANGED',
            'target_type': 'COMPLIANCE_CONFIG',
            'target_id': compliance.CONFIG_KEY,
            'reason': 'Compliance configuration changed through the operator CRM.',
            'before': {key: before.get(key) for key in changed},
            'after': {key: cfg.get(key) for key in changed},
            'metadata': {'changed_fields': changed},
            'created_at': compliance.now(),
        }, **kwargs)
        return cfg

    cfg = await _transactional_audited_update(apply)
    logger.info('compliance config changed by %s: %s', admin['id'], sorted(patch))
    return {'message': 'Compliance settings saved', 'config': cfg}


@admin_router.get('/review')
async def review(admin: dict = Depends(require_admin)):
    """Who the CURRENT settings would exclude — before anything is enforced."""
    cfg = await compliance.get_config()
    result = await compliance.review_players(cfg)
    return {**result, 'enforcing': bool(cfg.get('enforce_market_on_login')),
            'market_mode': cfg['market_mode']}


@admin_router.get('/preview')
async def preview(market_mode: str = None, markets: str = None,
                  min_age: int = None, admin: dict = Depends(require_admin)):
    """The same report against settings that have NOT been saved.

    Turning on an allow-list is the one action here that can lock real players
    out of a real balance, so it should be possible to ask what it would do
    before doing it.
    """
    cfg = await compliance.get_config()
    if market_mode:
        cfg = {**cfg, 'market_mode': market_mode.upper()}
    if markets is not None:
        cfg = {**cfg, 'markets': [c for c in
                                  (compliance.normalise_country(x) for x in markets.split(',')) if c]}
    if min_age:
        cfg = {**cfg, 'min_age': int(min_age)}
    result = await compliance.review_players(cfg)
    return {**result, 'would_apply': {'market_mode': cfg['market_mode'],
                                      'markets': cfg['markets'], 'min_age': cfg['min_age']}}


@admin_router.get('/exclusions')
async def list_exclusions(admin: dict = Depends(require_admin)):
    rows = await db.exclusions.find({}, {'_id': 0}).sort('created_at', -1).to_list(300)
    ids = list({r['user_id'] for r in rows})
    users = await db.users.find({'id': {'$in': ids}},
                                {'_id': 0, 'id': 1, 'username': 1, 'chip_balance': 1}).to_list(300)
    by_id = {u['id']: u for u in users}
    for r in rows:
        u = by_id.get(r['user_id'], {})
        r['login_id'] = u.get('username')
        r['chip_balance'] = u.get('chip_balance', 0)
        r['in_force'] = bool(await compliance.active_exclusion(r['user_id'])) and r['status'] == 'ACTIVE'
    return {'exclusions': serialize_doc(rows),
            'active': sum(1 for r in rows if r['in_force'])}


@admin_router.post('/players/{user_id}/exclusion')
async def admin_exclude(user_id: str, body: AdminExclusion,
                        admin: dict = Depends(require_admin)):
    """The operator excluding a player — for a concern the player has not raised."""
    if not await db.users.find_one({'id': user_id}):
        raise HTTPException(status_code=404, detail='Player not found')
    if not body.reason:
        raise HTTPException(status_code=400, detail='An operator exclusion has to have a reason recorded')
    kind = compliance.SELF_EXCLUSION if body.days is None else compliance.BREAK
    try:
        doc = await compliance.exclude(user_id, kind=kind, days=body.days,
                                       source='ADMIN', reason=body.reason)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    await db.users.update_one({'id': user_id}, {'$set': {
        'active_session_id': f"excluded-{doc['id']}"}})
    return {'message': 'Player excluded and signed out', 'exclusion': serialize_doc(doc)}


@admin_router.post('/players/{user_id}/exclusion/lift')
async def admin_lift(user_id: str, body: AdminExclusion, admin: dict = Depends(require_admin)):
    _require_compliance_admin(admin)
    reason = str(body.reason or '').strip()
    if len(reason) < 5:
        raise HTTPException(status_code=422, detail={
            'code': 'AUDIT_REASON_REQUIRED',
            'message': 'Record an audit reason of at least 5 characters.',
        })

    async def apply(session):
        kwargs = {'session': session} if session is not None else {}
        before = await db.exclusions.find_one(
            {'user_id': user_id, 'status': 'ACTIVE'},
            {'_id': 0},
            sort=[('created_at', -1)],
            **kwargs,
        )
        if not before:
            raise HTTPException(status_code=400, detail='This account has no active exclusion')
        try:
            doc = await compliance.admin_lift(
                user_id, admin['id'], reason, session=session)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        await db.financial_audit.insert_one({
            'id': str(uuid.uuid4()),
            'actor_id': admin['id'],
            'action': 'SELF_EXCLUSION_LIFTED',
            'target_type': 'PLAYER',
            'target_id': user_id,
            'reason': reason,
            'before': {
                'exclusion_id': before.get('id'),
                'status': before.get('status'),
                'kind': before.get('kind'),
                'ends_at': before.get('ends_at'),
            },
            'after': {
                'exclusion_id': doc.get('id'),
                'status': doc.get('status'),
                'lifted_at': doc.get('lifted_at'),
                'lifted_by': doc.get('lifted_by'),
            },
            'metadata': {'source': before.get('source')},
            'created_at': compliance.now(),
        }, **kwargs)
        return doc

    doc = await _transactional_audited_update(apply)
    return {'message': 'Exclusion lifted', 'exclusion': serialize_doc(doc)}


@admin_router.post('/players/{user_id}/verification-request')
async def admin_request_verification(
    user_id: str,
    body: AdminVerificationRequest,
    admin: dict = Depends(require_admin),
):
    _require_kyc_review(admin)
    kind = body.kind.upper()
    now = compliance.now_iso()

    async def apply(session):
        kwargs = {'session': session} if session is not None else {}
        user = await db.users.find_one(
            {'id': user_id, 'role': 'PLAYER'}, {'_id': 0}, **kwargs,
        )
        if not user:
            raise HTTPException(status_code=404, detail='Player not found')
        if kind == 'MOBILE':
            try:
                identity = normalize_identity(user.get('phone_normalized') or user.get('phone'))
            except ValueError as exc:
                raise HTTPException(status_code=422, detail={
                    'code': 'MOBILE_UNAVAILABLE',
                    'message': 'No valid mobile number is recorded for this player.',
                }) from exc
            if identity.channel != 'SMS':
                raise HTTPException(status_code=422, detail='A valid mobile number is required')
        await db.verification_requests.update_one(
            {'id': f'{user_id}:{kind}'},
            {'$set': {
                'id': f'{user_id}:{kind}', 'user_id': user_id, 'kind': kind,
                'status': 'REQUESTED', 'requested_by': admin['id'],
                'request_source': 'ADMIN', 'note': body.note.strip(),
                'requested_at': now, 'updated_at': now,
            }, '$setOnInsert': {'created_at': now}},
            upsert=True, **kwargs,
        )
        prefix = 'age' if kind == 'AGE' else 'mobile'
        await db.users.update_one({'id': user_id}, {'$set': {
            f'{prefix}_verification_status': 'REQUESTED',
            f'{prefix}_verification_requested_at': now,
            f'{prefix}_verification_requested_by': admin['id'],
            f'{prefix}_verification_request_note': body.note.strip(),
        }}, **kwargs)
        await db.notifications.insert_one({
            'id': str(uuid.uuid4()), 'user_id': user_id,
            'title': f'{kind.title()} verification requested',
            'body': body.note.strip(), 'type': 'VERIFICATION', 'read': False,
            'created_at': now,
        }, **kwargs)
        return {'message': f'{kind.title()} verification requested from player.'}

    return await _transactional_audited_update(apply)


@admin_router.post('/players/{user_id}/mobile-verify')
async def verify_mobile_manually(
    user_id: str,
    body: AgeVerify,
    admin: dict = Depends(require_admin),
):
    _require_kyc_review(admin)
    require_recent_admin_step_up(admin)
    reason = str(body.note or '').strip()
    if len(reason) < 5:
        raise HTTPException(status_code=422, detail={
            'code': 'AUDIT_REASON_REQUIRED',
            'message': 'Record an audit reason of at least 5 characters.',
        })
    async def apply(session):
        kwargs = {'session': session} if session is not None else {}
        user = await db.users.find_one(
            {'id': user_id, 'role': 'PLAYER'}, {'_id': 0}, **kwargs,
        )
        if not user:
            raise HTTPException(status_code=404, detail='Player not found')
        try:
            identity = normalize_identity(user.get('phone_normalized') or user.get('phone'))
        except ValueError as exc:
            raise HTTPException(status_code=422, detail={
                'code': 'MOBILE_UNAVAILABLE',
                'message': 'No valid mobile number is recorded for this player.',
            }) from exc
        if identity.channel != 'SMS':
            raise HTTPException(status_code=422, detail='A valid mobile number is required')
        now = compliance.now_iso()
        approved = bool(body.verified)
        after = {
            'phone_normalized': identity.value,
            'mobile_review_status': 'ADMIN_APPROVED' if approved else 'REVOKED',
            'mobile_verification_status': 'MANUALLY_VERIFIED' if approved else 'REVOKED',
            'mobile_reviewed_at': now,
            'mobile_reviewed_by': admin['id'],
            'mobile_review_note': reason,
            'mobile_review_phone_snapshot': identity.value,
        }
        await db.users.update_one({'id': user_id}, {'$set': after}, **kwargs)
        await db.verification_requests.update_one(
            {'id': f'{user_id}:MOBILE'},
            {'$set': {
                'id': f'{user_id}:MOBILE', 'user_id': user_id, 'kind': 'MOBILE',
                'status': 'APPROVED' if approved else 'REVOKED',
                'resolved_at': now, 'resolved_by': admin['id'], 'updated_at': now,
            }, '$setOnInsert': {'created_at': now}},
            upsert=True, **kwargs,
        )
        await db.financial_audit.insert_one({
            'id': str(uuid.uuid4()), 'actor_id': admin['id'],
            'action': 'MOBILE_MANUALLY_VERIFIED' if approved else 'MOBILE_MANUAL_VERIFICATION_WITHDRAWN',
            'target_type': 'PLAYER', 'target_id': user_id, 'reason': reason,
            'before': {'mobile_review_status': user.get('mobile_review_status')},
            'after': after, 'created_at': compliance.now(),
        }, **kwargs)
        await db.notifications.insert_one({
            'id': str(uuid.uuid4()), 'user_id': user_id,
            'title': 'Mobile verification updated',
            'body': 'An administrator approved your mobile number.' if approved else 'Manual mobile approval was withdrawn.',
            'type': 'VERIFICATION', 'read': False, 'created_at': now,
        }, **kwargs)
        return {'message': 'Mobile verification recorded.' if approved else 'Mobile verification withdrawn.'}

    return await _transactional_audited_update(apply)


@admin_router.post('/players/{user_id}/age-verify')
async def verify_age(user_id: str, body: AgeVerify, admin: dict = Depends(require_admin)):
    _require_kyc_review(admin)
    require_recent_admin_step_up(admin)
    reason = str(body.note or '').strip()
    if len(reason) < 5:
        raise HTTPException(status_code=422, detail={
            'code': 'AUDIT_REASON_REQUIRED',
            'message': 'Record an audit reason of at least 5 characters.',
        })

    async def apply(session):
        kwargs = {'session': session} if session is not None else {}
        user = await db.users.find_one({'id': user_id}, **kwargs)
        if not user or user.get('role') != 'PLAYER':
            raise HTTPException(status_code=404, detail='Player not found')
        cfg = await db.compliance_config.find_one(
            {'key': compliance.CONFIG_KEY}, {'_id': 0}, **kwargs,
        )
        cfg = {**compliance.DEFAULTS, **(cfg or {})}
        country_code = compliance.normalise_country(user.get('country'))
        age = compliance.age_on(user.get('date_of_birth'))
        minimum = compliance.min_age_for(cfg, country_code or compliance.UNKNOWN)
        if body.verified:
            if not country_code:
                raise HTTPException(status_code=400, detail={
                    'code': 'COUNTRY_UNKNOWN',
                    'message': 'Record a recognised country before verifying age.',
                })
            if age is None:
                raise HTTPException(status_code=400, detail={
                    'code': 'AGE_UNKNOWN',
                    'message': 'Record a valid date of birth before verifying age.',
                })
            if age < minimum:
                raise HTTPException(status_code=403, detail={
                    'code': 'UNDERAGE',
                    'message': f'The player must be at least {minimum}.',
                })
            if not compliance.market_allows(cfg, country_code):
                raise HTTPException(status_code=403, detail={
                    'code': 'MARKET_BLOCKED',
                    'message': 'The registered country is outside the configured market.',
                })

        before = {
            'age_verified': bool(user.get('age_verified')),
            'age_verified_at': user.get('age_verified_at'),
            'age_verified_by': user.get('age_verified_by'),
            'age_verified_note': user.get('age_verified_note'),
        }
        after = {
            'age_verified': bool(body.verified),
            'age_verified_at': compliance.now_iso() if body.verified else None,
            'age_verified_by': admin['id'] if body.verified else None,
            'age_verified_note': reason,
        }
        after['age_verification_status'] = 'VERIFIED' if body.verified else 'REVOKED'
        await db.users.update_one({'id': user_id}, {'$set': after}, **kwargs)
        await db.verification_requests.update_one(
            {'id': f'{user_id}:AGE'},
            {'$set': {
                'id': f'{user_id}:AGE', 'user_id': user_id, 'kind': 'AGE',
                'status': 'APPROVED' if body.verified else 'REVOKED',
                'resolved_at': compliance.now_iso(), 'resolved_by': admin['id'],
                'updated_at': compliance.now_iso(),
            }, '$setOnInsert': {'created_at': compliance.now_iso()}},
            upsert=True, **kwargs,
        )
        await db.financial_audit.insert_one({
            'id': str(uuid.uuid4()),
            'actor_id': admin['id'],
            'action': 'AGE_VERIFIED' if body.verified else 'AGE_VERIFICATION_WITHDRAWN',
            'target_type': 'PLAYER',
            'target_id': user_id,
            'reason': reason,
            'before': before,
            'after': after,
            'metadata': {
                'age': age, 'minimum_age': minimum, 'country_code': country_code,
            },
            'created_at': compliance.now(),
        }, **kwargs)
        await db.notifications.insert_one({
            'id': str(uuid.uuid4()), 'user_id': user_id,
            'title': 'Age verification updated',
            'body': 'Your age verification was approved.' if body.verified else 'Your age verification approval was withdrawn.',
            'type': 'VERIFICATION', 'read': False,
            'created_at': compliance.now_iso(),
        }, **kwargs)
        return {
            'message': 'Age verified' if body.verified else 'Age verification withdrawn',
            'age': age,
        }

    return await _transactional_audited_update(apply)


@admin_router.get('/players/{user_id}')
async def player_detail(user_id: str, admin: dict = Depends(require_admin)):
    user = await db.users.find_one(
        {'id': user_id},
        {'_id': 0, 'id': 1, 'username': 1, 'country': 1, 'date_of_birth': 1,
         'age_verified': 1, 'age_verified_at': 1, 'status': 1, 'chip_balance': 1})
    if not user:
        raise HTTPException(status_code=404, detail='Player not found')
    return {
        'player': serialize_doc(user),
        'age': compliance.age_on(user.get('date_of_birth')),
        'country_code': compliance.normalise_country(user.get('country')) or compliance.UNKNOWN,
        'limits': serialize_doc(await compliance.limits_for(user_id)),
        'usage': await _spend_summary(user_id),
        'exclusion': serialize_doc(await compliance.active_exclusion(user_id)),
    }


@admin_router.post('/players/{user_id}/limits')
async def admin_set_limit(user_id: str, body: LimitSet, admin: dict = Depends(require_admin)):
    """An operator-imposed limit. Tightening applies at once, like the player's.

    An operator RAISING a player's limit waits exactly as long as the player
    would. The delay protects against a decision made in the moment, and an
    operator asked to lift it in the moment is the same decision.
    """
    try:
        result = await compliance.set_limit(user_id, body.kind.upper(),
                                            body.period.upper(), body.amount,
                                            actor=f"admin:{admin['id']}")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {'message': 'Limit set' if result['outcome'] == 'IMMEDIATE'
            else f"Increase queued — it applies in {result['delay_hours']} hours", **result}
