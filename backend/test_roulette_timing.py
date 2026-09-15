"""70-second roulette timing and legacy-round transition regressions.

All route storage and ledger calls are isolated test doubles; no live service,
provider, wallet, or production database is accessed.
"""
import os
import sys
import types
import unittest
from contextlib import ExitStack
from unittest.mock import AsyncMock, patch

from mongomock_motor import AsyncMongoMockClient

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault('MONGO_URL', 'mongodb://127.0.0.1:27017')
os.environ.setdefault('DB_NAME', 'roulette_timing_import')

from live_engines import (
    ROULETTE_ROUND_ID_BASE,
    ROULETTE_TIMING,
    betting_mutation_open,
    roulette_cycle_clock,
    roulette_round_start,
)
import routes_games as roulette


class RouletteClockTests(unittest.TestCase):
    def test_exact_50_10_10_phase_boundaries(self):
        self.assertEqual(ROULETTE_TIMING, {'bet': 50, 'spin': 10, 'result': 10})
        for offset, phase, phase_left, round_left in (
            (0, 'BETTING', 50, 70),
            (49.99, 'BETTING', .01, 20.01),
            (50, 'SPINNING', 10, 20),
            (59.99, 'SPINNING', .01, 10.01),
            (60, 'RESULT', 10, 10),
            (69.99, 'RESULT', .01, .01),
            (70, 'BETTING', 50, 70),
        ):
            with self.subTest(offset=offset):
                actual = roulette_cycle_clock(offset)
                self.assertEqual(actual, (
                    ROULETTE_ROUND_ID_BASE + int(offset // 70), phase,
                    phase_left, round_left, 70,
                ))

    def test_new_ids_do_not_reuse_legacy_ids_and_resolve_real_deadlines(self):
        for now in (1_680_000_000.0, 1_800_000_005.0, 2_000_000_019.0):
            with self.subTest(now=now):
                round_number = roulette_cycle_clock(now)[0]
                self.assertGreaterEqual(round_number, ROULETTE_ROUND_ID_BASE)
                self.assertLess(int(now // 60), ROULETTE_ROUND_ID_BASE)
                self.assertNotEqual(round_number, int(now // 60))
                self.assertEqual(roulette_round_start(round_number), int(now // 70) * 70)
                self.assertEqual(roulette_round_start(int(now // 60)), int(now // 60) * 60)

    def test_bet_mutation_guard_and_round_rollover(self):
        for elapsed, allowed in ((49.59, True), (49.60, False), (49.99, False),
                                 (50, False), (60, False), (70, False)):
            with self.subTest(elapsed=elapsed):
                round_number, phase, left, *_ = roulette_cycle_clock(elapsed)
                self.assertIs(betting_mutation_open(
                    phase, left, round_number,
                    expected_round=ROULETTE_ROUND_ID_BASE, guard=.4,
                ), allowed)


class RouletteTransitionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = AsyncMongoMockClient()
        self.database = self.client['roulette_timing']
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.addCleanup(self.client.close)
        self.now = 25_000_000 * 70
        self.stack.enter_context(patch.object(roulette, 'db', self.database))
        self.stack.enter_context(patch.object(
            roulette, 'time', types.SimpleNamespace(time=lambda: self.now),
        ))
        self.stack.enter_context(patch.object(
            roulette, 'require_playable_game', AsyncMock(return_value={}),
        ))

        async def transaction(_client, callback):
            return await callback(None)

        self.stack.enter_context(patch.object(roulette, 'run_game_transaction', transaction))
        self.credit = self.stack.enter_context(patch.object(roulette, 'credit_chips', AsyncMock()))
        self.record = self.stack.enter_context(patch.object(roulette.ledger, 'record_settlement', AsyncMock()))
        self.draw = self.stack.enter_context(patch.object(roulette.RNG, 'choice', return_value='7'))
        await self.database.roulette_rounds.create_index('round_number', unique=True)
        await self.database.users.insert_one({'id': 'timing-player', 'chip_balance': 40})
        self.user = {'id': 'timing-player'}

    async def seed_bet(self, round_number, *, bet_id='timing-bet'):
        await self.database.roulette_bets.insert_one({
            'id': bet_id, 'user_id': self.user['id'], 'slug': 'fun-roulette-bet',
            'round_number': round_number, 'bet_type': 'straight', 'value': '7',
            'amount': 10, 'status': 'OPEN',
        })

    async def settle_at_current_clock(self):
        round_number, phase, *_ = roulette._roulette_clock(self.now)
        return await roulette._roulette_settle_user(
            self.user['id'], round_number, phase, now=self.now,
        )

    async def test_api_absolute_deadlines_and_duration_metadata(self):
        start = self.now
        for elapsed, expected_phase, phase_end in (
            (0, 'BETTING', 50), (49.5, 'BETTING', 50),
            (50, 'SPINNING', 60), (59.9, 'SPINNING', 60),
            (60, 'RESULT', 70), (69.9, 'RESULT', 70),
            (70, 'BETTING', 120),
        ):
            with self.subTest(elapsed=elapsed):
                self.now = start + elapsed
                state = await roulette.roulette_state(self.user)
                self.assertEqual(state['phase'], expected_phase)
                self.assertEqual(state['phase_ends_at'], start + phase_end)
                self.assertEqual(state['round_ends_at'], start + (140 if elapsed == 70 else 70))
                self.assertEqual(state['clock_sampled_at'], self.now)
                self.assertEqual(state['server_now'], self.now)
                self.assertEqual(state['betting_seconds'], 50)
                self.assertEqual(state['spin_seconds'], 10)
                self.assertEqual(state['round_seconds'], 70)
                self.assertAlmostEqual(state['phase_ends_at'] - self.now, state['phase_ends_in'], places=5)
                self.assertAlmostEqual(state['round_ends_at'] - self.now, state['next_round_in'], places=5)
                self.assertEqual(state['round_number'], ROULETTE_ROUND_ID_BASE + int(self.now // 70))

    async def test_legacy_bet_waits_for_its_own_result_then_settles_once(self):
        legacy_round = 29_000_001
        await self.seed_bet(legacy_round)
        await self.database.roulette_rounds.insert_one({
            'round_number': legacy_round, 'winning_number': '7', 'color': 'red',
        })
        self.now = legacy_round * 60 + 49.99
        self.assertIsNone(await self.settle_at_current_clock())
        self.credit.assert_not_awaited()
        self.record.assert_not_awaited()
        self.assertEqual((await self.database.roulette_bets.find_one({'id': 'timing-bet'}))['status'], 'OPEN')

        self.now = legacy_round * 60 + 50
        self.assertEqual(roulette._roulette_clock(self.now)[1], 'BETTING')
        settled = await self.settle_at_current_clock()
        self.assertEqual(settled['round_number'], legacy_round)
        self.assertEqual(settled['payout'], 360)
        self.assertIsNone(await self.settle_at_current_clock())
        self.credit.assert_awaited_once()
        self.record.assert_awaited_once()
        self.assertEqual(self.credit.await_args.kwargs['source_refs'], ['timing-bet'])
        self.assertEqual(await self.database.game_rounds.count_documents({}), 1)
        self.draw.assert_not_called()

    async def test_new_round_does_not_settle_until_60_second_result_boundary(self):
        start = self.now
        round_number = roulette._roulette_clock(start)[0]
        await self.seed_bet(round_number)
        self.now = start + 59.99
        self.assertIsNone(await self.settle_at_current_clock())
        self.credit.assert_not_awaited()
        self.assertEqual(await self.database.roulette_rounds.count_documents({}), 0)
        self.now = start + 60
        settled = await self.settle_at_current_clock()
        self.assertEqual(settled['round_number'], round_number)
        self.assertEqual(settled['payout'], 360)
        self.assertIsNone(await self.settle_at_current_clock())
        self.credit.assert_awaited_once()
        self.draw.assert_called_once()

    async def test_history_gates_legacy_and_new_rounds_independently(self):
        # At this instant legacy elapsed=35 and new elapsed=55: both spin.
        self.now = 4_000_000 * 420 + 335
        legacy_round = int(self.now // 60)
        current_round = roulette._roulette_clock(self.now)[0]
        await self.database.roulette_rounds.insert_many([
            {'round_number': rn, 'winning_number': number, 'color': 'red'}
            for rn, number in (
                (legacy_round - 1, '8'), (legacy_round, '9'),
                (current_round - 1, '6'), (current_round, '7'),
            )
        ])
        state = await roulette.roulette_state(self.user)
        self.assertEqual(state['phase'], 'SPINNING')
        self.assertEqual(state['winning_number'], '7')
        self.assertEqual([row['round_number'] for row in state['last_results']],
                         [current_round - 1, legacy_round - 1])

        self.now += 5  # New RESULT, legacy still SPINNING.
        state = await roulette.roulette_state(self.user)
        self.assertEqual(state['phase'], 'RESULT')
        self.assertEqual([row['round_number'] for row in state['last_results']],
                         [current_round, current_round - 1, legacy_round - 1])

        self.now += 10  # New BETTING, legacy has now reached RESULT.
        state = await roulette.roulette_state(self.user)
        self.assertEqual(state['phase'], 'BETTING')
        self.assertIsNone(state['winning_number'])
        self.assertEqual([row['round_number'] for row in state['last_results']],
                         [current_round, current_round - 1, legacy_round, legacy_round - 1])


if __name__ == '__main__':
    unittest.main()
