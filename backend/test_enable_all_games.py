"""Focused checks for the one-time all-games launch migration."""
import asyncio
import os
import sys
import types

from mongomock_motor import AsyncMongoMockClient

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

client = AsyncMongoMockClient()
database = client['enable_all_games_test']
sys.modules['db'] = types.SimpleNamespace(db=database)

import seed


async def main():
    reviewed_slugs = [game['slug'] for game in seed.GAMES]
    await database.games.insert_many([
        {'slug': slug, 'status': 'COMING_SOON' if index % 2 else 'ENABLED'}
        for index, slug in enumerate(reviewed_slugs)
    ] + [
        {'slug': 'retired-experiment', 'status': 'RETIRED'},
    ])
    await database.system_config.insert_one({'key': 'main'})
    await database.announcements.insert_many([
        {'title': 'Welcome to Chakri.Casino!', 'body': 'old welcome'},
        {'title': '18 games are on the way', 'body': 'old launch notice'},
    ])

    updated = await seed.enable_all_games_for_launch()
    reviewed = await database.games.find(
        {'slug': {'$in': reviewed_slugs}}, {'_id': 0, 'slug': 1, 'status': 1}
    ).to_list(100)
    retired = await database.games.find_one({'slug': 'retired-experiment'})
    config = await database.system_config.find_one({'key': 'main'})
    launch_notice = await database.announcements.find_one({'title': 'All 20 games are live'})

    assert len(reviewed) == 20
    assert updated == 10
    assert all(game['status'] == 'ENABLED' for game in reviewed)
    assert retired['status'] == 'RETIRED'
    assert config['all_games_live_v2'] is True
    assert config.get('updated_at')
    assert 'complete Chakri game catalogue' in launch_notice['body']
    print('all-games launch migration: 7 checks passed')


if __name__ == '__main__':
    asyncio.run(main())
