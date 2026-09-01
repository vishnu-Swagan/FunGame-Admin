"""Focused checks for the Chakri.Casino live-play unblock.

Covers the three behavioural changes that let a real player register, clear a
one-tap 18+ self-attestation, log in and play, while keeping /api/health at 200:

* Telesign Intelligence / Phone ID is observe-only and can never 403/503
  registration or sign-in, even when the configured mode is ``enforce`` and the
  provider recommends ``block`` or is unavailable.
* AGE_NOT_VERIFIED no longer hard-blocks play/login/deposit once the player has
  self-attested 18+ (``accepted_terms``); an actual under-age date of birth is
  still refused as UNDERAGE.
* GAME_WALLET_INTEGRATION_READY is certified True so the financial readiness gate
  passes when the deposit env is on, while health stays 200 with the flags off.

Runs as a standalone script (see test_script_suites.py) so its db double never
leaks into the shared pytest workers.  No live secrets are used.
"""
import asyncio
import os
import sys
import types

from fastapi import HTTPException
from mongomock_motor import AsyncMongoMockClient

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

client = AsyncMongoMockClient()
database = client['live_play_unblock_test']
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

import auth_utils  # noqa: E402
import compliance  # noqa: E402
import financial_wallet as finance  # noqa: E402
import routes_auth  # noqa: E402
import routes_player  # noqa: E402
import telesign_service  # noqa: E402
from models import OnboardingProfileRequest  # noqa: E402

ADULT_DOB = '1990-01-01'


async def expect_http_error(coro, status, code=None):
    try:
        await coro
    except HTTPException as exc:
        assert exc.status_code == status, (exc.status_code, status)
        if code:
            assert isinstance(exc.detail, dict), exc.detail
            assert exc.detail.get('code') == code, exc.detail
        return exc
    raise AssertionError(f'Expected HTTP {status} {code or ""}')


async def reset_db():
    for name in await database.list_collection_names():
        await database[name].delete_many({})


# ------------------------------------------------------------------ Telesign

async def check_telesign_is_observe_only():
    os.environ['TELESIGN_INTELLIGENCE_MODE'] = 'enforce'
    os.environ['TELESIGN_PHONE_ID_MODE'] = 'enforce'
    # An operator setting "enforce" is capped to observe: screening still runs
    # and is logged, but it can never block.
    assert routes_auth._telesign_mode('TELESIGN_INTELLIGENCE_MODE') == 'observe'
    assert routes_auth._telesign_mode('TELESIGN_PHONE_ID_MODE') == 'observe'

    identity = routes_auth.normalize_identity('+919876543210')

    async def block_recommendation(*args, **kwargs):
        return {'risk': {'recommendation': 'block', 'score': 950, 'level': 'high'}}

    async def provider_down(*args, **kwargs):
        raise telesign_service.TelesignServiceError('screening-unavailable')

    original_evaluate = telesign_service.evaluate_phone
    original_phone_id = telesign_service.phone_id_contact
    try:
        # A "block" recommendation during onboarding must NOT raise 403.
        telesign_service.evaluate_phone = block_recommendation
        result = await routes_auth._telesign_onboarding_screen(
            identity, 'player@example.com', verify_plus_will_screen=False,
        )
        assert result is not None and result['intelligence']['risk']['recommendation'] == 'block'

        # A provider outage during onboarding must NOT raise 503.
        telesign_service.evaluate_phone = provider_down
        telesign_service.phone_id_contact = provider_down
        assert await routes_auth._telesign_onboarding_screen(
            identity, 'player@example.com', verify_plus_will_screen=False,
        ) is None

        # A "block" recommendation on sign-in must NOT raise 403.
        telesign_service.evaluate_phone = block_recommendation
        user = {'id': 'u-block', 'phone_normalized': '+919876543210'}
        await database.users.insert_one(dict(user))
        signed = await routes_auth._telesign_sign_in_screen(user)
        assert signed is not None and signed['risk']['recommendation'] == 'block'

        # A provider outage on sign-in must NOT raise 503.
        telesign_service.evaluate_phone = provider_down
        assert await routes_auth._telesign_sign_in_screen(user) is None
    finally:
        telesign_service.evaluate_phone = original_evaluate
        telesign_service.phone_id_contact = original_phone_id
        os.environ.pop('TELESIGN_INTELLIGENCE_MODE', None)
        os.environ.pop('TELESIGN_PHONE_ID_MODE', None)
    print('  PASS  Telesign enforce is capped to observe and never blocks onboarding/sign-in')


# ----------------------------------------------------------------------- Age

async def check_self_attest_satisfies_age():
    await reset_db()
    await compliance.set_config({'require_age_verification': True}, 'admin')

    excluded = None
    attested = {
        'id': 'u-attest', 'role': 'PLAYER', 'status': 'ACTIVE',
        'country': 'India', 'date_of_birth': ADULT_DOB, 'accepted_terms': True,
    }
    assert await compliance.assert_playable(attested) is None

    not_attested = {
        'id': 'u-none', 'role': 'PLAYER', 'status': 'ACTIVE',
        'country': 'India', 'date_of_birth': ADULT_DOB,
    }
    await expect_http_error(compliance.assert_playable(not_attested), 403, 'AGE_NOT_VERIFIED')

    # A real minor cannot self-attest their way onto the games.
    minor = {
        'id': 'u-minor', 'role': 'PLAYER', 'status': 'ACTIVE',
        'country': 'India', 'date_of_birth': '2015-01-01', 'accepted_terms': True,
    }
    await expect_http_error(compliance.assert_playable(minor), 403, 'UNDERAGE')

    await compliance.set_config({'require_age_verification': False}, 'admin')
    assert excluded is None
    print('  PASS  18+ self-attest satisfies age; a real under-age DOB is still refused')


async def check_real_money_play_allows_self_attested_player():
    await reset_db()
    os.environ['REAL_MONEY_ENABLED'] = 'true'
    os.environ['FINANCIAL_ALLOWED_COUNTRIES'] = 'IN'
    try:
        player = {
            'id': 'gameplay-attested', 'role': 'PLAYER', 'status': 'ACTIVE',
            'country': 'India', 'date_of_birth': ADULT_DOB,
            'accepted_terms': True, 'kyc_status': 'VERIFIED',
        }
        # No operator age_verified flag: the self-attest must be enough to play.
        assert await auth_utils.require_active_player(player) is player

        # Without any age signal it still fails closed.
        no_age = {**player, 'accepted_terms': False}
        no_age.pop('age_verified', None)
        await expect_http_error(
            auth_utils.require_active_player(no_age), 403, 'AGE_NOT_VERIFIED',
        )
    finally:
        os.environ['REAL_MONEY_ENABLED'] = 'false'
        os.environ.pop('FINANCIAL_ALLOWED_COUNTRIES', None)
    print('  PASS  Real-money play admits a self-attested player without an operator age flag')


async def check_onboarding_records_age_verified():
    await reset_db()
    player = {
        'id': 'onboard-1', 'role': 'PLAYER', 'status': 'VERIFIED',
        'phone_verified': True, 'contact_verified': True,
    }
    await database.users.insert_one(dict(player))
    body = OnboardingProfileRequest(
        display_name='Lucky Ace', country='India', date_of_birth=ADULT_DOB,
        avatar='star', accepted_terms=True,
    )
    response = await routes_player.onboarding_profile(body, player)
    assert response['user']['age_verified'] is True
    assert response['user']['age_verified_by'] == 'SELF_ATTEST'
    stored = await database.users.find_one({'id': 'onboard-1'})
    assert stored['age_verified'] is True
    print('  PASS  onboarding/profile records age_verified from the 18+ self-attest')


# ------------------------------------------------------- Health / game wallet

async def check_game_wallet_certified_and_health_gate():
    # Certified in code for the live UPI launch.
    assert finance.GAME_WALLET_INTEGRATION_READY is True

    # Health only 503s when financial features are requested AND not ready.
    # With every flag off (current live) no feature is requested -> health 200.
    off_env = {}
    assert finance.financial_flags_requested(off_env) is False

    on_env = {
        'REAL_MONEY_ENABLED': 'true',
        'DEPOSITS_ENABLED': 'true',
        'FINANCIAL_GAME_WALLET_INTEGRATED': 'true',
        'FINANCIAL_ALLOWED_COUNTRIES': 'IN',
        'CHIPS_PER_INR': '1',
        'CHIP_RATE_VERSION': 'live-v1',
    }
    assert finance.financial_flags_requested(on_env) is True

    certified_errors = finance._configuration_errors(on_env)
    assert not any('not certified' in error for error in certified_errors), certified_errors

    # Flipping the certification back off restores the fail-closed error, proving
    # the flag is what unblocks the financial readiness gate.
    finance.GAME_WALLET_INTEGRATION_READY = False
    try:
        uncertified = finance._configuration_errors(on_env)
        assert any('not certified' in error for error in uncertified), uncertified
    finally:
        finance.GAME_WALLET_INTEGRATION_READY = True
    print('  PASS  Game wallet certified; health stays 200 with flags off and passes cert with flags on')


async def main():
    await check_telesign_is_observe_only()
    await check_self_attest_satisfies_age()
    await check_real_money_play_allows_self_attested_player()
    await check_onboarding_records_age_verified()
    await check_game_wallet_certified_and_health_gate()
    print('Live-play unblock: all focused checks passed')


if __name__ == '__main__':
    asyncio.run(main())
