"""Focused transaction, rollback, and exactly-once tests for Blackjack."""
from __future__ import annotations

import asyncio
import copy
import os
import sys
import unittest
from types import SimpleNamespace

from fastapi import HTTPException
from pymongo.errors import OperationFailure


HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault('MONGO_URL', 'mongodb://127.0.0.1:27017')
os.environ.setdefault('DB_NAME', 'blackjack_atomicity_test')

import ledger  # noqa: E402
import routes_blackjack as route  # noqa: E402


class _Result:
    def __init__(self, modified=0):
        self.modified_count = modified


def _matches(doc, query):
    for key, expected in query.items():
        actual = doc.get(key)
        if isinstance(expected, dict) and any(str(op).startswith('$') for op in expected):
            if '$exists' in expected and (key in doc) != bool(expected['$exists']):
                return False
            if '$gte' in expected and (actual is None or actual < expected['$gte']):
                return False
        elif actual != expected:
            return False
    return True


class _Collection:
    def __init__(self, database, name):
        self.database = database
        self.name = name

    @property
    def rows(self):
        return self.database.rows.setdefault(self.name, [])

    def _mutation(self, operation, session):
        self.database.mutations.append((self.name, operation, session))
        marker = (self.name, operation)
        if self.database.failure == marker:
            self.database.failure = None
            raise RuntimeError(f'injected {self.name}.{operation} failure')

    async def find_one(self, query, projection=None, **kwargs):
        for row in self.rows:
            if _matches(row, query):
                return copy.deepcopy(row)
        return None

    async def find_one_and_update(self, query, update, return_document=None, session=None, **kwargs):
        self._mutation('find_one_and_update', session)
        for row in self.rows:
            if _matches(row, query):
                for key, value in update.get('$inc', {}).items():
                    row[key] = row.get(key, 0) + value
                for key, value in update.get('$set', {}).items():
                    row[key] = copy.deepcopy(value)
                return copy.deepcopy(row)
        return None

    async def replace_one(self, query, replacement, upsert=False, session=None, **kwargs):
        self._mutation('replace_one', session)
        for index, row in enumerate(self.rows):
            if _matches(row, query):
                self.rows[index] = copy.deepcopy(replacement)
                return _Result(1)
        if upsert:
            self.rows.append(copy.deepcopy(replacement))
            return _Result(1)
        return _Result()

    async def update_one(self, query, update, upsert=False, session=None, **kwargs):
        self._mutation('update_one', session)
        for row in self.rows:
            if _matches(row, query):
                for key, value in update.get('$set', {}).items():
                    row[key] = copy.deepcopy(value)
                for key, value in update.get('$inc', {}).items():
                    row[key] = row.get(key, 0) + value
                return _Result(1)
        return _Result()

    async def insert_one(self, document, session=None, **kwargs):
        self._mutation('insert_one', session)
        if '_id' in document and any(row.get('_id') == document['_id'] for row in self.rows):
            raise RuntimeError('duplicate _id')
        self.rows.append(copy.deepcopy(document))
        return SimpleNamespace(inserted_id=document.get('_id'))

    async def count_documents(self, query):
        return sum(1 for row in self.rows if _matches(row, query))


class _Session:
    def __init__(self, database):
        self.database = database

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def with_transaction(self, callback):
        async with self.database.lock:
            snapshot = copy.deepcopy(self.database.rows)
            try:
                result = await callback(self)
                if self.database.retry_callback_once:
                    # Model the driver's TransientTransactionError behavior:
                    # the first transaction is aborted and the callback is
                    # invoked again against the original database snapshot.
                    self.database.retry_callback_once = False
                    self.database.rows = snapshot
                    return await callback(self)
                return result
            except Exception:
                self.database.rows = snapshot
                raise


class _Client:
    def __init__(self, database):
        self.database = database
        self.available = True

    async def start_session(self):
        if not self.available:
            raise NotImplementedError('transactions disabled')
        return _Session(self.database)


class _Database:
    def __init__(self):
        self.rows = {}
        self.collections = {}
        self.client = _Client(self)
        self.lock = asyncio.Lock()
        self.failure = None
        self.mutations = []
        self.retry_callback_once = False

    def __getattr__(self, name):
        if name.startswith('_'):
            raise AttributeError(name)
        return self.collections.setdefault(name, _Collection(self, name))

    def seed(self, collection, *documents):
        self.rows[collection] = [copy.deepcopy(document) for document in documents]

    def fail_next(self, collection, operation):
        self.failure = (collection, operation)


def _game(*, game_id='hand-1', status='player_turn', player=None, dealer=None,
          shoe=None, total_payout=0):
    game = {
        'user_id': 'player-1', 'id': game_id, 'status': status, 'active': 0,
        'shoe': copy.deepcopy(shoe or []),
        'dealer': copy.deepcopy(dealer or [[10, 'C'], [7, 'D']]),
        'hands': [{
            'bet': 20, 'cards': copy.deepcopy(player or [[10, 'S'], [8, 'H']]),
            'done': status == 'done', 'outcome': 'WIN' if status == 'done' else None,
            'payout': 40 if status == 'done' else 0, 'doubled': False,
            'from_split_aces': False, 'pp': 0, 't3': 0,
        }],
        'total_staked': 20, 'total_payout': total_payout,
        'insurance_offered': status == 'insurance', 'insurance_bet': 0,
        'revision': 1, 'created_at': '2026-08-21T00:00:00+00:00',
    }
    if status == 'done':
        game['settled_at'] = '2026-08-21T00:01:00+00:00'
    return game


def _settled_round(game, **overrides):
    row = {
        'id': 'legacy-round-1',
        'user_id': game['user_id'],
        'slug': 'blackjack',
        'game_name': 'Blackjack',
        'bet': game['total_staked'],
        'payout': game['total_payout'],
        'status': 'SETTLED',
        'outcome': route._history_outcome(game),
        'created_at': '2026-08-21T00:01:01+00:00',
        'settled_at': '2026-08-21T00:01:01+00:00',
    }
    row.update(overrides)
    return row


class BlackjackAtomicityTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.database = _Database()
        self.database.seed('users', {'id': 'player-1', 'chip_balance': 100})
        self.database.seed('games', {'slug': 'blackjack', 'name': 'Blackjack'})
        self.original_route_db = route.db
        self.original_ledger_db = ledger.db
        self.original_access = route.require_playable_game
        self.original_shoe = route.bj.new_shoe
        self.original_runner = route._run_transaction
        self.original_guards = list(ledger._stake_guards)
        route.db = self.database
        ledger.db = self.database
        ledger._stake_guards.clear()

        async def allow(_slug):
            return None

        route.require_playable_game = allow
        # Pop order: player 10, dealer 9, player 7, dealer 7.
        route.bj.new_shoe = lambda _decks=6: [
            (7, 'C'), (7, 'D'), (9, 'H'), (10, 'S'),
        ]

    async def asyncTearDown(self):
        route.db = self.original_route_db
        ledger.db = self.original_ledger_db
        route.require_playable_game = self.original_access
        route.bj.new_shoe = self.original_shoe
        route._run_transaction = self.original_runner
        ledger._stake_guards[:] = self.original_guards

    async def test_deal_rolls_back_wallet_and_ledger_when_game_save_fails(self):
        self.database.fail_next('blackjack_games', 'replace_one')
        with self.assertRaisesRegex(RuntimeError, 'injected'):
            await route.bj_deal(
                route.DealBody(hands=[route.HandBet(bet=20)]),
                user={'id': 'player-1'},
            )
        self.assertEqual(self.database.rows['users'][0]['chip_balance'], 100)
        self.assertEqual(self.database.rows.get('chip_transactions', []), [])
        self.assertEqual(self.database.rows.get('blackjack_games', []), [])

    async def test_driver_callback_retry_does_not_double_debit_deal(self):
        self.database.retry_callback_once = True
        result = await route.bj_deal(
            route.DealBody(hands=[route.HandBet(bet=20)]),
            user={'id': 'player-1'},
        )
        self.assertEqual(result['balance'], 80)
        self.assertEqual(len(self.database.rows['blackjack_games']), 1)
        self.assertEqual(len(self.database.rows['chip_transactions']), 1)
        self.assertEqual(self.database.rows['chip_transactions'][0]['amount'], 20)

    async def test_proven_legacy_done_hand_allows_next_deal_without_repaying(self):
        legacy = _game(status='done', total_payout=40)
        self.database.seed('blackjack_games', legacy)
        self.database.seed('game_rounds', _settled_round(legacy))

        result = await route.bj_deal(
            route.DealBody(hands=[route.HandBet(bet=20)]),
            user={'id': 'player-1'},
        )

        self.assertEqual(result['status'], 'player_turn')
        self.assertEqual(result['balance'], 80)
        current = self.database.rows['blackjack_games'][0]
        self.assertNotEqual(current['id'], legacy['id'])
        self.assertEqual(len(self.database.rows['game_rounds']), 1)
        self.assertEqual(len(self.database.rows['chip_transactions']), 1)
        self.assertEqual(self.database.rows['chip_transactions'][0]['kind'], ledger.STAKE)
        self.assertEqual(self.database.rows['chip_transactions'][0]['amount'], 20)
        self.assertTrue(all(session is not None for _, _, session in self.database.mutations))

    async def test_ambiguous_legacy_partial_finalization_is_preserved(self):
        legacy = _game(status='done', total_payout=40)
        self.database.seed('blackjack_games', legacy)
        # Legacy payout happened before history. Its presence cannot prove the
        # old finalizer reached the final game_rounds insert.
        partial_payout = {
            'id': 'legacy-payout', 'user_id': 'player-1', 'ref': legacy['id'],
            'kind': ledger.PAYOUT, 'game': 'blackjack', 'amount': 40,
        }
        self.database.seed('chip_transactions', partial_payout)

        with self.assertRaises(HTTPException) as raised:
            await route.bj_deal(
                route.DealBody(hands=[route.HandBet(bet=20)]),
                user={'id': 'player-1'},
            )

        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(
            raised.exception.detail['code'], 'LEGACY_HAND_REVIEW_REQUIRED',
        )
        self.assertEqual(self.database.rows['blackjack_games'][0], legacy)
        self.assertEqual(self.database.rows['users'][0]['chip_balance'], 100)
        self.assertEqual(self.database.rows['chip_transactions'], [partial_payout])
        self.assertTrue(all(session is not None for _, _, session in self.database.mutations))

    async def test_legacy_round_with_different_outcome_does_not_unlock_hand(self):
        legacy = _game(status='done', total_payout=40)
        mismatched = _settled_round(legacy)
        mismatched['outcome'] = copy.deepcopy(mismatched['outcome'])
        mismatched['outcome']['dealer'] = 'A♠7♦'
        self.database.seed('blackjack_games', legacy)
        self.database.seed('game_rounds', mismatched)

        with self.assertRaises(HTTPException) as raised:
            await route.bj_deal(
                route.DealBody(hands=[route.HandBet(bet=20)]),
                user={'id': 'player-1'},
            )

        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(
            raised.exception.detail['code'], 'LEGACY_HAND_REVIEW_REQUIRED',
        )
        self.assertEqual(self.database.rows['blackjack_games'][0], legacy)
        self.assertEqual(self.database.rows['users'][0]['chip_balance'], 100)
        self.assertEqual(self.database.rows.get('chip_transactions', []), [])

    async def test_insurance_rolls_back_debit_when_state_save_fails(self):
        game = _game(status='insurance', dealer=[[14, 'S'], [5, 'H']])
        self.database.seed('blackjack_games', game)
        self.database.fail_next('blackjack_games', 'replace_one')
        with self.assertRaisesRegex(RuntimeError, 'injected'):
            await route.bj_insurance(route.InsuranceBody(take=True), user={'id': 'player-1'})
        self.assertEqual(self.database.rows['users'][0]['chip_balance'], 100)
        self.assertEqual(self.database.rows['blackjack_games'][0], game)
        self.assertEqual(self.database.rows.get('chip_transactions', []), [])

    async def test_double_and_split_roll_back_extra_stake_when_save_fails(self):
        cases = {
            'double': _game(player=[[5, 'S'], [6, 'H']], shoe=[[10, 'D']]),
            'split': _game(player=[[8, 'S'], [8, 'H']], shoe=[[3, 'D'], [2, 'C']]),
        }
        for action, game in cases.items():
            with self.subTest(action=action):
                self.database.seed('users', {'id': 'player-1', 'chip_balance': 100})
                self.database.seed('blackjack_games', game)
                self.database.rows['chip_transactions'] = []
                self.database.fail_next('blackjack_games', 'replace_one')
                with self.assertRaisesRegex(RuntimeError, 'injected'):
                    await route.bj_action(route.ActionBody(action=action), user={'id': 'player-1'})
                self.assertEqual(self.database.rows['users'][0]['chip_balance'], 100)
                self.assertEqual(self.database.rows['blackjack_games'][0], game)
                self.assertEqual(self.database.rows['chip_transactions'], [])

    async def test_final_history_failure_rolls_back_payout_then_retry_settles_once(self):
        game = _game()
        self.database.seed('users', {'id': 'player-1', 'chip_balance': 80})
        self.database.seed('blackjack_games', game)
        self.database.fail_next('game_rounds', 'insert_one')
        with self.assertRaisesRegex(RuntimeError, 'injected'):
            await route.bj_action(route.ActionBody(action='stand'), user={'id': 'player-1'})
        self.assertEqual(self.database.rows['users'][0]['chip_balance'], 80)
        self.assertEqual(self.database.rows['blackjack_games'][0], game)
        self.assertEqual(self.database.rows.get('chip_transactions', []), [])

        result = await route.bj_action(route.ActionBody(action='stand'), user={'id': 'player-1'})
        self.assertEqual(result['status'], 'done')
        self.assertEqual(result['balance'], 120)
        self.assertEqual(len(self.database.rows['chip_transactions']), 1)
        self.assertEqual(len(self.database.rows['game_rounds']), 1)
        self.assertIn('finalized_at', self.database.rows['blackjack_games'][0])

    async def test_concurrent_finalize_credits_and_writes_history_once(self):
        game = _game(status='done', total_payout=40)
        self.database.seed('users', {'id': 'player-1', 'chip_balance': 80})
        self.database.seed('blackjack_games', game)

        async def finalize():
            async def transaction(session):
                current = await route._load('player-1', session=session)
                return await route._finalize(
                    current, 'player-1', 'hand-1', session=session,
                )
            return await route._run_transaction(transaction)

        results = await asyncio.gather(finalize(), finalize())
        self.assertEqual(sorted(results), [False, True])
        self.assertEqual(self.database.rows['users'][0]['chip_balance'], 120)
        self.assertEqual(len(self.database.rows['chip_transactions']), 1)
        self.assertEqual(len(self.database.rows['game_rounds']), 1)
        self.assertTrue(all(session is not None for _, _, session in self.database.mutations))

    async def test_concurrent_stand_requests_settle_endpoint_exactly_once(self):
        game = _game()
        self.database.seed('users', {'id': 'player-1', 'chip_balance': 80})
        self.database.seed('blackjack_games', game)
        ready = 0
        gate = asyncio.Event()

        async def synchronized_runner(callback):
            nonlocal ready
            ready += 1
            if ready == 2:
                gate.set()
            await gate.wait()
            return await self.original_runner(callback)

        route._run_transaction = synchronized_runner
        results = await asyncio.gather(
            route.bj_action(route.ActionBody(action='stand'), user={'id': 'player-1'}),
            route.bj_action(route.ActionBody(action='stand'), user={'id': 'player-1'}),
            return_exceptions=True,
        )

        successes = [result for result in results if isinstance(result, dict)]
        conflicts = [result for result in results if isinstance(result, HTTPException)]
        self.assertEqual(len(successes), 1)
        self.assertEqual(successes[0]['status'], 'done')
        self.assertEqual(len(conflicts), 1)
        self.assertEqual(conflicts[0].status_code, 409)
        self.assertEqual(self.database.rows['users'][0]['chip_balance'], 120)
        self.assertEqual(len(self.database.rows['chip_transactions']), 1)
        self.assertEqual(len(self.database.rows['game_rounds']), 1)

    async def test_missing_transaction_support_fails_closed(self):
        self.database.client.available = False
        called = False

        async def callback(_session):
            nonlocal called
            called = True

        with self.assertRaises(HTTPException) as raised:
            await route._run_transaction(callback)
        self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(raised.exception.detail['code'], 'GAME_TRANSACTIONS_UNAVAILABLE')
        self.assertFalse(called)

    async def test_server_rejecting_transactions_fails_closed_before_callback(self):
        database = self.database

        class UnsupportedSession(_Session):
            async def with_transaction(self, callback):
                raise OperationFailure(
                    'Transaction numbers are only allowed on a replica set member',
                    code=20,
                )

        class UnsupportedClient:
            async def start_session(self):
                return UnsupportedSession(database)

        self.database.client = UnsupportedClient()
        called = False

        async def callback(_session):
            nonlocal called
            called = True

        with self.assertRaises(HTTPException) as raised:
            await route._run_transaction(callback)
        self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(raised.exception.detail['code'], 'GAME_TRANSACTIONS_UNAVAILABLE')
        self.assertFalse(called)


if __name__ == '__main__':
    unittest.main()
