"""Short-lived, authenticated player presence; never expose session identifiers."""
import asyncio
from datetime import datetime, timedelta, timezone

ONLINE_WINDOW_SECONDS = 90
PLAYER_LIST_LIMIT = 100


def _is_online(user, since, now):
    seen = str(user.get('last_seen_at') or '')
    sid = user.get('active_session_id')
    return bool(
        user.get('status') in ('ACTIVE', 'VERIFIED')
        and isinstance(sid, str) and sid and not sid.startswith('revoked-')
        and sid == user.get('presence_session_id')
        and since <= seen <= now
    )


async def player_login_stats(database, *, now=None):
    now = now or datetime.now(timezone.utc)
    current = now.isoformat()
    since = (now - timedelta(seconds=ONLINE_WINDOW_SECONDS)).isoformat()
    yesterday = (now - timedelta(hours=24)).isoformat()
    players = {'role': 'PLAYER'}
    online = {
        **players,
        'status': {'$in': ['ACTIVE', 'VERIFIED']},
        'last_seen_at': {'$gte': since, '$lte': current},
        'active_session_id': {'$type': 'string', '$nin': ['', None], '$not': {'$regex': '^revoked-'}},
        '$expr': {'$eq': ['$active_session_id', '$presence_session_id']},
    }
    projection = {key: 1 for key in (
        'id', 'display_name', 'username', 'status', 'last_login_at',
        'last_seen_at', 'active_session_id', 'presence_session_id',
    )}
    projection['_id'] = 0
    total, online_count, recent_count, online_rows, recent_rows = await asyncio.gather(
        database.users.count_documents(players),
        database.users.count_documents(online),
        database.users.count_documents({**players, 'last_login_at': {'$gte': yesterday, '$lte': current}}),
        database.users.find(online, projection).sort('last_seen_at', -1).to_list(PLAYER_LIST_LIMIT),
        database.users.find({**players, 'last_login_at': {'$type': 'string', '$lte': current}}, projection)
            .sort('last_login_at', -1).to_list(PLAYER_LIST_LIMIT),
    )

    def public_row(user):
        return {
            **{key: user.get(key) for key in (
                'id', 'display_name', 'username', 'status', 'last_login_at', 'last_seen_at',
            )},
            'online': _is_online(user, since, current),
        }

    return {
        'generated_at': current,
        'online_window_seconds': ONLINE_WINDOW_SECONDS,
        'list_limit': PLAYER_LIST_LIMIT,
        'total_players': total,
        'online_now': online_count,
        'players_logged_in_24h': recent_count,
        'online_players': [public_row(row) for row in online_rows],
        'recent_logins': [public_row(row) for row in recent_rows],
    }
