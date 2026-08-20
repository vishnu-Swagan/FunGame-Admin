"""Single server-side authority for game publication and API availability.

The catalogue may contain any number of historical or planned games, but only
the reviewed slugs below can become playable.  Keeping this list in backend
code prevents an accidental CRM toggle (or a stale database migration) from
publishing an unreviewed game engine.
"""
from datetime import datetime, timezone

from fastapi import HTTPException

from db import db


PLAYABLE_GAME_SLUGS = frozenset({
    'aviator',
    'seven-up-down',
    'fun-roulette',
    'keno',
    'pappu-pictures',
    'andar-bahar',
    'teen-patti',
    'poker',
    'blackjack',
})

GAME_COMING_SOON = 'GAME_COMING_SOON'


def normalise_game_slug(slug: str) -> str:
    return str(slug or '').strip().lower()


def is_reviewed_game(slug: str) -> bool:
    return normalise_game_slug(slug) in PLAYABLE_GAME_SLUGS


def project_catalogue_game(game: dict) -> dict:
    """Return the user-facing availability without trusting stale DB state.

    Catalogue records stay visible, but an old ``ENABLED`` value can never
    advertise an unreviewed engine as playable while startup reconciliation is
    pending or temporarily unavailable.
    """
    projected = dict(game)
    if not is_reviewed_game(projected.get('slug')):
        projected['status'] = 'COMING_SOON'
    return projected


def coming_soon_error(slug: str, name: str | None = None) -> HTTPException:
    label = (name or normalise_game_slug(slug).replace('-', ' ').title() or 'This game')
    return HTTPException(
        status_code=409,
        detail={
            'code': GAME_COMING_SOON,
            'message': f'{label} is coming soon.',
        },
    )


async def require_playable_game(slug: str, *, database=None) -> dict:
    """Return the enabled catalogue record or raise one stable public error.

    The allow-list check deliberately happens before the database lookup.  A
    direct request therefore cannot make an unreviewed route usable even when
    an old migration left its database record as ``ENABLED``.
    """
    if database is None:
        database = db
    canonical_slug = normalise_game_slug(slug)
    if canonical_slug not in PLAYABLE_GAME_SLUGS:
        raise coming_soon_error(canonical_slug)

    game = await database.games.find_one({'slug': canonical_slug})
    if not game or game.get('status') != 'ENABLED':
        raise coming_soon_error(canonical_slug, (game or {}).get('name'))
    return game


async def reconcile_game_availability(*, database=None) -> dict:
    """Idempotently publish the reviewed nine and retire no catalogue data.

    Only ``status`` and migration metadata are changed.  Round histories,
    game records, artwork and operator-authored catalogue copy are preserved.
    """
    if database is None:
        database = db
    config = await database.system_config.find_one({'key': 'main'})
    if config and config.get('reviewed_game_set_v1'):
        # Keep the boundary self-healing without undoing an operator's later
        # MAINTENANCE/DISABLED choice for one of the reviewed games.
        now = datetime.now(timezone.utc).isoformat()
        hidden = await database.games.update_many(
            {
                'slug': {'$nin': sorted(PLAYABLE_GAME_SLUGS)},
                'status': {'$ne': 'COMING_SOON'},
            },
            {'$set': {'status': 'COMING_SOON', 'updated_at': now}},
        )
        return {
            'enabled': 0,
            'coming_soon': hidden.modified_count,
            'playable_slugs': sorted(PLAYABLE_GAME_SLUGS),
            'already_applied': True,
        }
    now = datetime.now(timezone.utc).isoformat()
    reviewed = sorted(PLAYABLE_GAME_SLUGS)

    enabled = await database.games.update_many(
        {'slug': {'$in': reviewed}, 'status': {'$ne': 'ENABLED'}},
        {'$set': {'status': 'ENABLED', 'updated_at': now}},
    )
    hidden = await database.games.update_many(
        {'slug': {'$nin': reviewed}, 'status': {'$ne': 'COMING_SOON'}},
        {'$set': {'status': 'COMING_SOON', 'updated_at': now}},
    )
    await database.system_config.update_one(
        {'key': 'main'},
        {'$set': {
            # Mark the two superseded broad migrations complete so startup in
            # server.py cannot re-enable the rest of the catalogue afterwards.
            'gameplay_v1_migrated': True,
            'all_games_live_v2': True,
            'reviewed_game_set_v1': True,
            'reviewed_game_set_updated_at': now,
        }},
        upsert=True,
    )
    return {
        'enabled': enabled.modified_count,
        'coming_soon': hidden.modified_count,
        'playable_slugs': reviewed,
        'already_applied': False,
    }


def assert_admin_status_change_allowed(slug: str, status: str | None) -> None:
    """Prevent CRM users from publishing anything outside the reviewed set."""
    if status is not None and not is_reviewed_game(slug) and status != 'COMING_SOON':
        raise coming_soon_error(slug)
