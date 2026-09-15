"""Pappu 20/8/4 timing, independent legacy settlement, and outcome identities."""
import os
import sys
import types
import unittest
from contextlib import ExitStack
from unittest.mock import AsyncMock, patch

from mongomock_motor import AsyncMongoMockClient

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault('MONGO_URL', 'mongodb://127.0.0.1:27017')
os.environ.setdefault('DB_NAME', 'pappu_timing_import')

from live_engines import (
    LIVE_GAMES, PAPPU_ROUND_ID_BASE, betting_mutation_open,
    fixed_cycle_clock, live_cycle_clock, live_round_start,
)
import routes_live as live
from trusted_game_settlement import GameSettlement


SLUG = 'pappu-pictures'
OUTCOME = {'symbol': 'umbrella', 'multiplier': 8, 'extra_pay': False, 'boosts': {}}


class PappuClockTests(unittest.TestCase):
    def test_exact_20_8_4_phase_boundaries_and_guard(self):
        self.assertEqual(LIVE_GAMES[SLUG], {'bet': 20, 'reveal': 8, 'result': 4, 'kind': 'symbols'})
        for offset, phase, left, round_left in (
            (0, 'BETTING', 20, 32), (19.99, 'BETTING', .01, 12.01),
            (20, 'REVEAL', 8, 12), (27.99, 'REVEAL', .01, 4.01),
            (28, 'RESULT', 4, 4), (31.99, 'RESULT', .01, .01),
            (32, 'BETTING', 20, 32),
        ):
            with self.subTest(offset=offset):
                self.assertEqual(live_cycle_clock(SLUG, offset), (
                    PAPPU_ROUND_ID_BASE + int(offset // 32), phase, left, round_left, 32,
                ))
        for offset, allowed in ((19.59, True), (19.6, False), (19.99, False),
                                (20, False), (28, False), (32, False)):
            rn, phase, left, *_ = live_cycle_clock(SLUG, offset)
            self.assertIs(betting_mutation_open(
                phase, left, rn, expected_round=PAPPU_ROUND_ID_BASE, guard=.4,
            ), allowed)

    def test_namespace_and_deadlines_leave_all_other_games_unchanged(self):
        for now in (1_680_000_000.0, 1_800_000_019.0):
            with self.subTest(now=now):
                rn = live_cycle_clock(SLUG, now)[0]
                self.assertGreaterEqual(rn, PAPPU_ROUND_ID_BASE)
                self.assertLess(int(now // 24), PAPPU_ROUND_ID_BASE)
                self.assertEqual(live_round_start(SLUG, rn), int(now // 32) * 32)
                self.assertEqual(live_round_start(SLUG, int(now // 24)), int(now // 24) * 24)
                for slug, cfg in LIVE_GAMES.items():
                    if slug == SLUG:
                        continue
                    expected = fixed_cycle_clock(now, cfg['bet'], cfg['reveal'], cfg['result'])
                    self.assertEqual(live_cycle_clock(slug, now), expected, slug)
                    self.assertEqual(live_round_start(slug, expected[0]), expected[0] * expected[4], slug)

    def test_trusted_settlement_references_preserve_new_and_legacy_identity(self):
        now = 1_800_000_000
        old_round = int(now // 24)
        new_round = live_cycle_clock(SLUG, now)[0]
        events = [GameSettlement.prize(
            '00000000-0000-4000-8000-000000000001', SLUG,
            str(rn), 'same-test-stake-event', 80,
        ) for rn in (old_round, new_round)]
        for event in events:
            event.validate({SLUG})
        self.assertNotEqual(events[0].idempotency_key, events[1].idempotency_key)
        self.assertEqual(events[1].rpc_payload()['p_round_id'], str(new_round))


class PappuTransitionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = AsyncMongoMockClient()
        self.database = self.client['pappu_timing']
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.addCleanup(self.client.close)
        self.now = 50_000_000 * 32
        self.stack.enter_context(patch.object(live, 'db', self.database))
        self.stack.enter_context(patch.object(live, '_OUTCOME_CACHE', {}))
        self.stack.enter_context(patch.object(live, 'time', types.SimpleNamespace(time=lambda: self.now)))
        self.stack.enter_context(patch.object(live, 'require_playable_game', AsyncMock(return_value={})))

        async def transaction(_client, callback):
            return await callback(None)

        self.stack.enter_context(patch.object(live, 'run_game_transaction', transaction))
        self.credit = self.stack.enter_context(patch.object(live, 'credit_chips', AsyncMock()))
        self.record = self.stack.enter_context(patch.object(live.ledger, 'record_settlement', AsyncMock()))
        self.generate = self.stack.enter_context(patch.object(live, 'generate_outcome', return_value=dict(OUTCOME)))
        self.user = {'id': 'pappu-timing-player'}
        await self.database.users.insert_one({**self.user, 'chip_balance': 100})
        await self.database.live_outcomes.create_index([('slug', 1), ('round_number', 1)], unique=True)

    async def seed_bet(self, rn):
        await self.database.live_bets.insert_one({
            'id': 'timing-stake', 'user_id': self.user['id'], 'slug': SLUG,
            'round_number': rn, 'selection': 'umbrella', 'amount': 10, 'status': 'OPEN',
        })

    async def settle_now(self):
        rn, phase, *_ = live._live_clock(SLUG, self.now)
        return await live._live_settle_user(self.user['id'], SLUG, rn, phase, now=self.now)

    async def test_api_absolute_deadlines_and_20_second_betting_metadata(self):
        start = self.now
        for offset, phase, phase_end in (
            (0, 'BETTING', 20), (19.5, 'BETTING', 20),
            (20, 'REVEAL', 28), (27.9, 'REVEAL', 28),
            (28, 'RESULT', 32), (31.9, 'RESULT', 32), (32, 'BETTING', 52),
        ):
            with self.subTest(offset=offset):
                self.now = start + offset
                state = await live.live_state(SLUG, self.user)
                self.assertEqual(state['phase'], phase)
                self.assertEqual(state['phase_ends_at'], start + phase_end)
                self.assertEqual(state['round_ends_at'], start + (64 if offset == 32 else 32))
                self.assertEqual(state['timings'], {'bet': 20, 'reveal': 8, 'result': 4, 'total': 32})
                self.assertEqual(state['round_number'], PAPPU_ROUND_ID_BASE + int(self.now // 32))
                self.assertEqual(state['clock_sampled_at'], self.now)
                self.assertAlmostEqual(state['phase_ends_at'] - self.now, state['phase_ends_in'], places=5)

    async def test_legacy_bet_settles_at_old_20_second_boundary_only_once(self):
        legacy_round = 70_000_001
        await self.seed_bet(legacy_round)
        await self.database.live_outcomes.insert_one({
            'slug': SLUG, 'round_number': legacy_round, 'outcome': dict(OUTCOME),
        })
        self.now = legacy_round * 24 + 19.99
        self.assertIsNone(await self.settle_now())
        self.credit.assert_not_awaited()
        self.record.assert_not_awaited()
        self.now = legacy_round * 24 + 20
        self.assertEqual(live._live_clock(SLUG, self.now)[1], 'BETTING')
        result = await self.settle_now()
        self.assertEqual(result['round_number'], legacy_round)
        self.assertEqual(result['payout'], 80)
        self.assertIsNone(await self.settle_now())
        self.credit.assert_awaited_once()
        self.record.assert_awaited_once()
        self.assertEqual(self.credit.await_args.kwargs['settlement_ref'], str(legacy_round))
        self.assertEqual(self.credit.await_args.kwargs['source_refs'], ['timing-stake'])
        self.generate.assert_not_called()
        self.assertEqual(await self.database.game_rounds.count_documents({}), 1)

    async def test_new_bet_waits_until_28_second_result_boundary(self):
        start = self.now
        rn = live._live_clock(SLUG, start)[0]
        await self.seed_bet(rn)
        self.now = start + 27.99
        self.assertIsNone(await self.settle_now())
        self.credit.assert_not_awaited()
        self.now = start + 28
        result = await self.settle_now()
        self.assertEqual(result['round_number'], rn)
        self.assertEqual(result['payout'], 80)
        self.assertIsNone(await self.settle_now())
        self.credit.assert_awaited_once()
        self.assertEqual(self.credit.await_args.kwargs['settlement_ref'], str(rn))

    async def test_cache_and_persisted_outcomes_do_not_alias_old_rounds(self):
        legacy_round = int(self.now // 24)
        new_round = live._live_clock(SLUG, self.now)[0]
        old_outcome = {**OUTCOME, 'symbol': 'football'}
        await self.database.live_outcomes.insert_one({
            'slug': SLUG, 'round_number': legacy_round, 'outcome': old_outcome,
        })
        self.assertEqual(await live._live_outcome(SLUG, legacy_round), old_outcome)
        self.assertEqual(await live._live_outcome(SLUG, new_round), OUTCOME)
        self.assertEqual(await live._live_outcome(SLUG, new_round), OUTCOME)
        self.assertEqual(live._OUTCOME_CACHE[(SLUG, legacy_round)], old_outcome)
        self.assertEqual(live._OUTCOME_CACHE[(SLUG, new_round)], OUTCOME)
        self.assertEqual(await self.database.live_outcomes.count_documents({'slug': SLUG}), 2)
        self.generate.assert_called_once_with(SLUG)

    async def test_history_excludes_current_round_of_both_schedules(self):
        # Legacy elapsed=16; new elapsed=24. Both schedules are revealing.
        self.now = 17_500_000 * 96 + 88
        legacy_round = int(self.now // 24)
        current_round = live._live_clock(SLUG, self.now)[0]
        await self.database.live_outcomes.insert_many([
            {'slug': SLUG, 'round_number': rn, 'outcome': dict(OUTCOME)}
            for rn in (legacy_round - 1, legacy_round, current_round - 1, current_round)
        ])
        for offset in (0, 4):
            now = self.now + offset
            rn, phase, *_ = live._live_clock(SLUG, now)
            query = {'slug': SLUG, **live._live_closed_rounds(
                SLUG, rn, phase, now, include_current_result=False,
            )}
            visible = await self.database.live_outcomes.distinct('round_number', query)
            self.assertCountEqual(visible, [legacy_round - 1, current_round - 1])
        now = self.now + 8  # Both schedules are in their next betting round.
        rn, phase, *_ = live._live_clock(SLUG, now)
        query = {'slug': SLUG, **live._live_closed_rounds(
            SLUG, rn, phase, now, include_current_result=False,
        )}
        visible = await self.database.live_outcomes.distinct('round_number', query)
        self.assertCountEqual(visible, [legacy_round - 1, legacy_round, current_round - 1, current_round])

    async def test_api_history_keeps_inflight_legacy_hidden_without_backfill_masking(self):
        self.now = 17_500_000 * 96 + 88
        legacy_round = int(self.now // 24)
        current_round = live._live_clock(SLUG, self.now)[0]
        # A full existing roadmap means synthetic backfill cannot hide a bad
        # history query by pushing the in-flight legacy row off the page.
        await self.database.live_outcomes.insert_many([
            {'slug': SLUG, 'round_number': rn, 'outcome': dict(OUTCOME),
             'summary': {'symbol': 'umbrella', 'multiplier': 8, 'extra_pay': False}}
            for rn in [*(legacy_round - i for i in range(1, 101)), legacy_round, current_round]
        ])
        for increment in (0, 4):
            self.now += increment
            state = await live.live_state(SLUG, self.user)
            self.assertEqual(len(state['last_results']), 100)
            visible = [row['round_number'] for row in state['last_results']]
            self.assertNotIn(legacy_round, visible)
            self.assertNotIn(current_round, visible)
            self.assertIn(legacy_round - 1, visible)
        self.now += 4
        state = await live.live_state(SLUG, self.user)
        self.assertEqual(state['phase'], 'BETTING')
        self.assertIsNone(state['outcome'])
        visible = [row['round_number'] for row in state['last_results']]
        self.assertIn(legacy_round, visible)
        self.assertIn(current_round, visible)
        self.generate.assert_not_called()


if __name__ == '__main__':
    unittest.main()
