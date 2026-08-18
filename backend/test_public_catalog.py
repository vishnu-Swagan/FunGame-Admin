"""Public game catalogue exposes only the reviewed CRM projection."""
import asyncio
import os
import sys
import types

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fastapi import Response
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
            'slug': 'disabled-title',
            'name': 'Disabled Title',
            'category': 'Cards',
            'status': 'DISABLED',
            'featured': False,
            'order': 3,
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

    response = Response()
    payload = await routes_player.public_game_catalog(response)

    assert response.headers['cache-control'] == 'public, max-age=30, s-maxage=60, stale-while-revalidate=300'
    assert payload['source'] == 'Chakri CRM game database'
    assert payload['count'] == 2
    assert [game['slug'] for game in payload['games']] == ['aviator', 'blackjack']
    assert payload['games'][0]['artwork_url'] == 'https://fungame-web.onrender.com/game-art/aviator.png'
    assert payload['games'][1]['artwork_url'] is None
    assert 'internal_provider_key' not in payload['games'][0]
    assert 'password_hash' not in str(payload)
    print('public catalogue: 10 checks passed')


if __name__ == '__main__':
    asyncio.run(main())
