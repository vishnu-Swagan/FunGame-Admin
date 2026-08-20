"""Chakri.Casino API.

The deployed default remains play-chip-only. Financial routes are present but
fail closed behind explicit readiness flags, reviewed source accounting, a
transaction-capable database, and an installed real payment-provider adapter.
"""
import os
import time
import uuid
import asyncio
import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI, APIRouter, HTTPException
from starlette.middleware.cors import CORSMiddleware
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from db import client, db
from game_access import reconcile_game_availability
from seed import run_seed
import crm
import revenue
import commission
import payouts
import compliance
import routes_auth
import routes_player
import routes_admin
import routes_distributor
import routes_compliance
import routes_games
import routes_live
import routes_blackjack
import routes_security
import routes_migration_export
import routes_game_settlement
import routes_payments
import financial_wallet
from payment_providers import load_payment_provider

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


_WORKER_ID = f'{os.getpid()}-{uuid.uuid4().hex[:6]}'


async def _hold_keepalive_lock():
    """Best-effort single-leader lock: only one worker/instance drives the
    Aviator machine. Advancing is idempotent anyway, but at scale this avoids
    every worker doing the same work each tick. Fails over via a short TTL."""
    now = time.time()
    ttl = 4.0
    try:
        doc = await db.system_locks.find_one_and_update(
            {'_id': 'aviator_keepalive', '$or': [{'expires_at': {'$lt': now}}, {'holder': _WORKER_ID}]},
            {'$set': {'holder': _WORKER_ID, 'expires_at': now + ttl}},
            upsert=True, return_document=ReturnDocument.AFTER,
        )
        return bool(doc) and doc.get('holder') == _WORKER_ID
    except DuplicateKeyError:
        return False  # another worker currently holds the lock


async def _aviator_keepalive():
    """Keep the universal Aviator round machine ticking 24/7 (leader only)."""
    from routes_live import advance_aviator
    while True:
        try:
            if await _hold_keepalive_lock():
                await advance_aviator()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.warning(f'aviator keepalive: {e}')
        await asyncio.sleep(0.7)


async def _financial_worker():
    """Dormant-by-default outbox runner and bounded reconciliation loop."""
    last_reconciliation = 0.0
    while True:
        try:
            status = financial_wallet.financial_status()
            if status['ready'] and status['features']['real_money']:
                leader = await financial_wallet.acquire_financial_worker_lease(
                    f'financial-{_WORKER_ID}', ttl_seconds=45,
                )
                if leader:
                    provider = load_payment_provider()
                    if status['features']['automatic_withdrawals']:
                        outbox = await financial_wallet.process_outbox_batch(provider, limit=10)
                        if any(outbox.values()):
                            logger.info('financial outbox result: %s', outbox)
                    current = time.monotonic()
                    if current - last_reconciliation >= 60:
                        result = await financial_wallet.reconcile_financial_records(
                            provider, limit=50,
                        )
                        last_reconciliation = current
                        if any(result.values()):
                            logger.info('financial reconciliation result: %s', result)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - worker retries; money remains held
            logger.error('financial worker failed safely (%s)', type(exc).__name__)
        await asyncio.sleep(3)


async def _migrate_nocash_wording():
    await db.announcements.update_many({}, [{'$set': {'body': {
        '$replaceAll': {
            'input': {'$replaceAll': {'input': '$body', 'find': ' PLAY CHIPS — NO CASH VALUE.', 'replacement': ''}},
            'find': 'have no cash value and ', 'replacement': ''}}}}])
    await db.notifications.update_many(
        {'body': {'$regex': 'NO CASH VALUE'}},
        [{'$set': {'body': {'$replaceAll': {'input': '$body', 'find': ' PLAY CHIPS — NO CASH VALUE.', 'replacement': ''}}}}])
    await db.system_config.update_one({'key': 'main'}, {'$set': {'nocash_wording_stripped': True}})
    logger.info('Stripped legacy no-cash-value wording from existing announcements/notifications')


async def _core_indexes():
    await db.game_rounds.create_index([('user_id', 1), ('slug', 1), ('created_at', -1)])
    # Live "winners feed": recent settled wins per game (payout>0), newest first.
    await db.game_rounds.create_index([('slug', 1), ('settled_at', -1)])
    await db.roulette_rounds.create_index('round_number', unique=True)
    await db.roulette_bets.create_index([('user_id', 1), ('round_number', 1), ('status', 1)])
    await db.live_outcomes.create_index([('slug', 1), ('round_number', 1)], unique=True)
    await db.live_bets.create_index([('user_id', 1), ('slug', 1), ('status', 1)])
    await db.live_bets.create_index([('slug', 1), ('round_number', 1)])
    await db.aviator_rounds.create_index('round_number', unique=True)
    await db.aviator_bets.create_index([('round_number', 1), ('status', 1)])
    await db.aviator_bets.create_index([('user_id', 1), ('round_number', 1)])
    await db.aviator_bets.create_index(
        [('user_id', 1), ('round_number', 1), ('panel', 1)],
        unique=True,
        partialFilterExpression={'active': True},
        name='aviator_one_active_bet_per_panel',
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Start the service, then do the housekeeping — in that order of importance.

    Everything below is bootstrap: seeding, one-off migrations, index creation.
    None of it is needed to answer a request, and all of it was able to kill the
    process. Startup ran thirty-six index creations in sequence against a remote
    database, and one raised exception anywhere in that chain exits uvicorn with
    a status code and no service at all — a deploy that fails completely because
    an index could not be built is the wrong trade every time.

    Each step is now isolated and logged by name, so a failure degrades to a
    missing index and a line in the log saying which one, instead of an outage.
    """

    async def step(name, coro):
        try:
            await coro
        except Exception as e:                       # noqa: BLE001 - bootstrap must not be fatal
            logger.error('startup step %r failed (continuing): %s: %s',
                         name, type(e).__name__, e)

    await step('seed', run_seed())

    try:
        cfg = await db.system_config.find_one({'key': 'main'})
    except Exception as e:
        logger.error('startup: could not read system_config (%s); skipping migrations', e)
        cfg = None

    if cfg and not cfg.get('nocash_wording_stripped'):
        await step('migrate:nocash_wording', _migrate_nocash_wording())

    await step('indexes:crm', crm.ensure_indexes())
    await step('crm:house_account', crm.ensure_house_account())
    await step('indexes:revenue', revenue.ensure_indexes())
    await step('indexes:commission', commission.ensure_indexes())
    await step('indexes:payouts', payouts.ensure_indexes())
    await step('indexes:compliance', compliance.ensure_indexes())
    await step('indexes:core', _core_indexes())
    # Disabled by default; this creates no collection or index until the
    # separately reviewed Supabase game-settlement bridge is explicitly enabled.
    await step('indexes:game_settlement', routes_game_settlement.ensure_indexes())

    # Payment indexes and transaction support are a hard readiness gate for
    # money routes.  Unlike ordinary bootstrap steps this failure is retained
    # by the financial module and makes /health return 503 whenever a payment
    # flag was explicitly requested; no partially initialized money path opens.
    financial = await financial_wallet.prepare_financial_core()
    if financial_wallet.financial_flags_requested() and not financial['ready']:
        logger.error('financial core requested but not ready: %s', financial['errors'])
    # This is deliberately the final catalogue mutation at startup. Static API
    # gates still fail closed if reconciliation itself cannot reach Mongo.
    await step('games:reviewed-availability', reconcile_game_availability())

    keepalive = asyncio.create_task(_aviator_keepalive())
    financial_worker = asyncio.create_task(_financial_worker())
    logger.info(
        'Chakri.Casino ready - nine reviewed games available; '
        'remaining catalogue coming soon'
    )
    yield
    keepalive.cancel()
    financial_worker.cancel()
    client.close()


app = FastAPI(title='Chakri.Casino API', version='1.0.0', lifespan=lifespan)

api_router = APIRouter(prefix='/api')


@api_router.get('/')
async def root():
    """Public root. Carries a small build fingerprint on purpose.

    Every endpoint that would reveal which build is running needs auth, so when a
    deploy silently does not happen there is no way to tell from outside — which
    is exactly the situation that costs an afternoon. The roulette pocket count
    is the cheapest honest signal: 38 means the American changeover is live, 37
    means it is not.
    """
    from game_engines import KENO_DRAW, KENO_POOL, ROULETTE_POCKETS
    return {
        'message': 'Chakri.Casino API',
        'disclaimer': 'PLAY CHIPS ONLY',
        'build': {
            'roulette_pockets': len(ROULETTE_POCKETS),
            # Public release fingerprint only. The private Keno price profile
            # remains server-side; these two values simply prove the matching
            # 36-ball/10-draw build reached Render.
            'keno_pool': KENO_POOL,
            'keno_draw': KENO_DRAW,
        },
    }


@api_router.get('/health')
async def health():
    # Keep the private probability setting on the server, but fail the health
    # gate when it is missing or invalid so a bad release never receives traffic.
    from game_engines import aviator_return_factor
    try:
        aviator_return_factor()
    except (RuntimeError, ValueError) as exc:
        raise HTTPException(
            status_code=503, detail='Aviator configuration unavailable'
        ) from exc
    financial = financial_wallet.financial_status()
    if financial_wallet.financial_flags_requested() and not financial['ready']:
        raise HTTPException(
            status_code=503,
            detail={'code': 'FINANCIAL_NOT_READY', 'message': 'Financial services are not ready.'},
        )
    return {'status': 'ok', 'financial_ready': bool(financial['ready'])}


api_router.include_router(routes_auth.router)
api_router.include_router(routes_live.router)
api_router.include_router(routes_games.router)
api_router.include_router(routes_blackjack.router)
api_router.include_router(routes_player.router)
api_router.include_router(routes_admin.router)
api_router.include_router(routes_distributor.router)
api_router.include_router(routes_compliance.router)
api_router.include_router(routes_compliance.admin_router)
api_router.include_router(routes_security.router)
# Kept hidden from OpenAPI and disabled unless a short-lived, HMAC-protected
# migration window is explicitly configured.  See routes_migration_export.py.
api_router.include_router(routes_migration_export.router)
api_router.include_router(routes_game_settlement.router)
api_router.include_router(routes_payments.router)
api_router.include_router(routes_payments.admin_router)
app.include_router(api_router)

# --- Security middleware ---
# Order matters: last-added runs first. We want CORS outermost, then rate limit,
# then security headers on the way out.
from security import RateLimitMiddleware, SecurityHeadersMiddleware

app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(RateLimitMiddleware)

# CORS locked to explicit origins in production. Wildcard is refused when
# credentials are allowed, so we only enable credentials for a concrete allowlist.
_cors_origins = [o.strip() for o in os.environ.get('CORS_ORIGINS', '*').split(',') if o.strip()]
_wildcard = _cors_origins == ['*']
app.add_middleware(
    CORSMiddleware,
    allow_credentials=not _wildcard,
    allow_origins=_cors_origins,
    allow_methods=['*'],
    allow_headers=['*'],
)
if _wildcard:
    logger.warning('CORS is wildcard (*). Set CORS_ORIGINS to your frontend origin in production.')
