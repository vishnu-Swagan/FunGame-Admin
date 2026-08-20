"""Public game catalogue exposes only the reviewed CRM projection."""
import asyncio
import os
import sys
import types

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fastapi import Response
from fastapi import HTTPException
from mongomock_motor import AsyncMongoMockClient


client = AsyncMongoMockClient()
db = client['test']
sys.modules['db'] = types.SimpleNamespace(db=db, serialize_doc=lambda value: value)

import routes_player


async def main():
    await db.games.insert_many([
        {
            'slug': 'aviator',
            'name': 'Aviator',
            'category': 'Crash',
            'tagline': 'Fly high',
            'description': 'CRM description',
            'status': 'ENABLED',
            'featured': True,
            'order': 1,
            'internal_provider_key': 'must-not-leak',
        },
        {
            'slug': 'blackjack',
            'name': 'Blackjack',
            'category': 'Cards',
            'status': 'COMING_SOON',
            'featured': False,
            'order': 2,
        },
        {
            'slug': 'bingo',
            'name': 'Bingo',
            'category': 'Numbers',
            # Simulates an old broad-enable migration. The record remains in
            # the catalogue but must be projected authoritatively as soon.
            'status': 'ENABLED',
            'featured': False,
            'order': 3,
        },
        {
            'slug': 'disabled-title',
            'name': 'Disabled Title',
            'category': 'Cards',
            'status': 'DISABLED',
            'featured': False,
            'order': 4,
        },
        {
            'slug': '../private-record',
            'name': 'Invalid public path',
            'category': 'Cards',
            'status': 'ENABLED',
            'featured': False,
            'order': 'not-a-number',
        },
    ])
    player = {'id': 'player-1', 'favorites': [], 'recent_games': []}
    await db.users.insert_one(player)

    response = Response()
    payload = await routes_player.public_game_catalog(response)

    assert response.headers['cache-control'] == 'public, max-age=30, s-maxage=60, stale-while-revalidate=300'
    assert payload['source'] == 'Chakri CRM game database'
    assert payload['count'] == 3
    assert [game['slug'] for game in payload['games']] == ['aviator', 'blackjack', 'bingo']
    assert payload['games'][0]['artwork_url'] == 'https://fungame-web.onrender.com/game-art/aviator.png'
    assert payload['games'][1]['artwork_url'] is None
    assert payload['games'][2]['status'] == 'COMING_SOON'
    assert 'internal_provider_key' not in payload['games'][0]
    assert 'password_hash' not in str(payload)

    authenticated = await routes_player.list_games(player)
    authenticated_by_slug = {game['slug']: game for game in authenticated['games']}
    assert authenticated_by_slug['aviator']['status'] == 'ENABLED'
    assert authenticated_by_slug['blackjack']['status'] == 'COMING_SOON'
    assert authenticated_by_slug['bingo']['status'] == 'COMING_SOON'
    assert authenticated_by_slug['disabled-title']['status'] == 'COMING_SOON'

    for action in (
        routes_player.game_detail('bingo', player),
        routes_player.toggle_favorite('bingo', player),
    ):
        try:
            await action
            raise AssertionError('Coming Soon game action unexpectedly succeeded')
        except HTTPException as exc:
            assert exc.status_code == 409
            assert exc.detail['code'] == 'GAME_COMING_SOON'

    # Rejected direct URLs do not pollute recents or favorites, while a
    # reviewed enabled game still follows the legacy response contract.
    stored_player = await db.users.find_one({'id': player['id']})
    assert stored_player['recent_games'] == [] and stored_player['favorites'] == []
    detail = await routes_player.game_detail('AVIATOR', player)
    assert detail['game']['slug'] == 'aviator'
    favorite = await routes_player.toggle_favorite('AVIATOR', player)
    assert favorite['action'] == 'added' and favorite['favorites'] == ['aviator']
    print('public catalogue and direct availability gates: focused checks passed')


if __name__ == '__main__':
    asyncio.run(main())
