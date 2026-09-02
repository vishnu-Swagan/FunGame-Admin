"""Focused checks for the one-time reviewed-game availability migration."""
import asyncio
import ast
import os
import sys
import types

from mongomock_motor import AsyncMongoMockClient

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

client = AsyncMongoMockClient()
database = client['reviewed_games_test']
sys.modules['db'] = types.SimpleNamespace(db=database)

import game_access
import seed


async def main():
    reviewed_slugs = sorted(game_access.PLAYABLE_GAME_SLUGS)
    all_slugs = [game['slug'] for game in seed.GAMES]
    await database.games.insert_many([
        {
            'slug': slug,
            'status': 'COMING_SOON' if slug in reviewed_slugs else 'ENABLED',
            'operator_copy': f'preserve:{slug}',
        }
        for slug in all_slugs
    ] + [
        {'slug': 'retired-experiment', 'status': 'RETIRED', 'history_marker': 42},
    ])
    await database.system_config.insert_one({'key': 'main'})
    await database.announcements.insert_many([
        {'title': 'Welcome to Chakri.Casino!', 'body': 'old welcome'},
        {'title': '18 games are on the way', 'body': 'old launch notice'},
    ])

    updated = await seed.enable_all_games_for_launch()
    rows = await database.games.find({}, {'_id': 0}).to_list(100)
    by_slug = {row['slug']: row for row in rows}
    config = await database.system_config.find_one({'key': 'main'})

    assert updated == len(rows)
    assert len(reviewed_slugs) == 11
    assert all(by_slug[slug]['status'] == 'ENABLED' for slug in reviewed_slugs)
    assert all(
        by_slug[slug]['status'] == 'COMING_SOON'
        for slug in by_slug if slug not in reviewed_slugs
    )
    assert by_slug['retired-experiment']['history_marker'] == 42
    assert all(by_slug[slug]['operator_copy'] == f'preserve:{slug}' for slug in all_slugs)
    assert config['reviewed_game_set_v1'] is True
    assert config['gameplay_v1_migrated'] is True
    assert config['all_games_live_v2'] is True

    # The migration is one-time. A later operator maintenance decision for a
    # reviewed game must survive an application restart.
    await database.games.update_one(
        {'slug': 'aviator'}, {'$set': {'status': 'MAINTENANCE'}},
    )
    # A stale process or manual database write must not republish an
    # unreviewed game after the one-time migration flag has been set.
    await database.games.update_one(
        {'slug': 'bingo'}, {'$set': {'status': 'ENABLED'}},
    )
    second = await game_access.reconcile_game_availability(database=database)
    assert second['already_applied'] is True
    assert (await database.games.find_one({'slug': 'aviator'}))['status'] == 'MAINTENANCE'
    assert (await database.games.find_one({'slug': 'bingo'}))['status'] == 'COMING_SOON'

    from fastapi import HTTPException
    for slug in ('bingo', 'retired-experiment', 'does-not-exist', 'aviator'):
        try:
            await game_access.require_playable_game(slug, database=database)
            raise AssertionError(f'{slug} unexpectedly playable')
        except HTTPException as exc:
            assert exc.status_code == 409
            assert exc.detail['code'] == 'GAME_COMING_SOON'
    try:
        game_access.assert_admin_status_change_allowed('bingo', 'ENABLED')
        raise AssertionError('admin unexpectedly enabled an unreviewed game')
    except HTTPException as exc:
        assert exc.status_code == 409
        assert exc.detail['code'] == 'GAME_COMING_SOON'

    # Every public gameplay entry point must call the centralized guard.
    expected = {
        'routes_games.py': {
            'play_game', 'roulette_state', 'roulette_place_bet',
            'roulette_clear_bets', 'roulette_undo_bet',
            'recent_game_winners', 'game_history',
        },
        'routes_live.py': {
            'aviator_state', 'aviator_round_fairness', 'aviator_top',
            'aviator_place_bet', 'aviator_cancel_bet', 'aviator_cashout',
            'live_state', 'live_place_bet', 'live_clear_bets', 'live_undo_bet',
        },
        'routes_chicken_road.py': {
            'chicken_road_state', 'chicken_road_round_fairness', 'chicken_road_top',
            'chicken_road_place_bet', 'chicken_road_cancel_bet', 'chicken_road_cashout',
        },
        'routes_blackjack.py': {'bj_state', 'bj_deal', 'bj_insurance', 'bj_action'},
        'routes_rummy.py': {
            'rummy_categories', 'rummy_join', 'rummy_room_state', 'rummy_action',
        },
        'routes_player.py': {'game_detail', 'toggle_favorite'},
    }
    backend_dir = os.path.dirname(os.path.abspath(__file__))
    for filename, functions in expected.items():
        tree = ast.parse(open(os.path.join(backend_dir, filename), encoding='utf-8').read())
        definitions = {
            node.name: ast.unparse(node)
            for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        }
        assert functions <= definitions.keys()
        for function in functions:
            assert 'require_playable_game(' in definitions[function], function

    server_source = open(os.path.join(backend_dir, 'server.py'), encoding='utf-8').read()
    assert '_migrate_gameplay_v1' not in server_source
    assert 'enable_all_games_for_launch' not in server_source
    assert "games:reviewed-availability" in server_source
    assert '21 games' not in server_source
    print('reviewed-game migration and route gates: focused checks passed')


if __name__ == '__main__':
    asyncio.run(main())
