"""Authorization, retention and safety checks for admin player deletion."""

from __future__ import annotations

import os
import sys
import unittest

from fastapi import HTTPException
from mongomock_motor import AsyncMongoMockClient


HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault('MONGO_URL', 'mongodb://127.0.0.1:27017')
os.environ.setdefault('DB_NAME', 'admin_account_deletion_import')
os.environ['APP_ENV'] = 'test'
os.environ['AUTH_ALLOW_NON_TRANSACTIONAL_TESTS'] = 'true'

import routes_admin


class AdminAccountDeletionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = AsyncMongoMockClient()
        self.database = self.client['admin_account_deletion']
        self.original_database = routes_admin.db
        routes_admin.db = self.database
        self.admin = {
            'id': 'admin-1', 'role': 'ADMIN', 'status': 'ACTIVE',
            'email': 'operator@example.test',
        }

    async def asyncTearDown(self):
        routes_admin.db = self.original_database
        self.client.close()

    async def _player(self, user_id='player-1', **overrides):
        row = {
            'id': user_id, 'role': 'PLAYER', 'status': 'ACTIVE',
            'username': 'GK1234567', 'email': 'player@example.test',
            'registration_source': 'OPERATOR', 'chip_balance': 1000,
            'points_balance': 10,
        }
        row.update(overrides)
        await self.database.users.insert_one(row)
        return row

    async def test_deletes_player_login_and_ephemeral_rows_but_retains_history(self):
        player = await self._player(password_hash='old-secret', active_session_id='old-session')
        await self.database.otp_challenges.insert_one({'id': 'otp-1', 'user_id': player['id']})
        await self.database.notifications.insert_one({'id': 'notice-1', 'user_id': player['id']})
        await self.database.verification_requests.insert_one({'id': 'verify-1', 'user_id': player['id']})
        await self.database.chip_request_pending_counters.insert_one({'_id': 'counter-1', 'user_id': player['id']})
        await self.database.avatar_uploads.insert_one({'_id': player['id'], 'id': 'upload-1'})
        await self.database.login_id_reservations.insert_many([
            {'id': 'reservation-1', 'owner_type': 'USER', 'owner_id': player['id']},
            {'id': 'reservation-other', 'owner_type': 'USER', 'owner_id': 'other-player'},
        ])
        await self.database.player_attribution.insert_one({
            'id': 'attribution-1', 'user_id': player['id'], 'active': True,
        })
        await self.database.live_bets.insert_one({
            'id': 'settled-bet', 'user_id': player['id'], 'status': 'SETTLED',
        })
        await self.database.chip_transactions.insert_one({
            'id': 'historical-ledger', 'user_id': player['id'], 'type': 'CREDIT',
        })

        response = await routes_admin.delete_user_account(player['id'], self.admin)

        self.assertEqual(response['deleted_user_id'], player['id'])
        tombstone = await self.database.users.find_one({'id': player['id']})
        self.assertEqual(tombstone['status'], 'DELETED')
        self.assertEqual(tombstone['deleted_by'], self.admin['id'])
        self.assertEqual(tombstone['deletion_previous_status'], 'ACTIVE')
        self.assertTrue(tombstone['deleted_at'])
        self.assertEqual(tombstone['chip_balance'], 1000)
        self.assertNotIn('password_hash', tombstone)
        self.assertNotEqual(tombstone['active_session_id'], 'old-session')
        for collection in ('otp_challenges', 'notifications', 'verification_requests', 'chip_request_pending_counters'):
            self.assertEqual(await self.database[collection].count_documents({'user_id': player['id']}), 0)
        self.assertEqual(await self.database.avatar_uploads.count_documents({'_id': player['id']}), 0)
        # Identity reservations remain linked to the retained financial owner.
        self.assertEqual(await self.database.login_id_reservations.count_documents({'owner_id': player['id']}), 1)
        self.assertEqual(await self.database.login_id_reservations.count_documents({'owner_id': 'other-player'}), 1)
        attribution = await self.database.player_attribution.find_one({'user_id': player['id']})
        self.assertFalse(attribution['active'])
        self.assertEqual(attribution['close_reason'], 'ACCOUNT_DELETED')
        self.assertEqual(await self.database.live_bets.count_documents({'id': 'settled-bet'}), 1)
        self.assertEqual(await self.database.chip_transactions.count_documents({'id': 'historical-ledger'}), 1)
        audit = await self.database.admin_audit.find_one({
            'action': 'PLAYER_ACCOUNT_DELETED', 'target_id': player['id'],
        })
        self.assertIsNotNone(audit)
        self.assertNotIn('email', audit['before'])

    async def test_refuses_admin_and_distributor_targets(self):
        await self.database.users.insert_many([
            {'id': 'admin-target', 'role': 'ADMIN', 'status': 'ACTIVE'},
            {'id': 'partner-target', 'role': 'DISTRIBUTOR', 'status': 'ACTIVE'},
        ])
        for target in ('admin-target', 'partner-target'):
            with self.assertRaises(HTTPException) as caught:
                await routes_admin.delete_user_account(target, self.admin)
            self.assertEqual(caught.exception.status_code, 403)
            self.assertIsNotNone(await self.database.users.find_one({'id': target}))

    async def test_all_financial_history_balances_and_open_activity_allow_deletion(self):
        await self._player('financial-player', username='GK7654321', chip_balance=99000)
        rows = {
            'deposit_orders': 'PENDING', 'withdrawal_requests': 'APPROVED',
            'operator_payment_requests': 'PENDING', 'payout_methods': 'ACTIVE',
            'aviator_bets': 'OPEN', 'live_bets': 'OPEN', 'game_rounds': 'OPEN',
            'blackjack_games': 'playing', 'rummy_seats': 'ACTIVE',
        }
        for collection, status in rows.items():
            await self.database[collection].insert_one({'id': collection, 'user_id': 'financial-player', 'status': status})
        await self.database.chip_requests.insert_one({'id': 'chip-request', 'user_id': 'financial-player', 'status': 'PENDING'})

        result = await routes_admin.delete_user_account('financial-player', self.admin)

        self.assertTrue(result['history_retained'])
        self.assertTrue(result['reconciliation_required'])
        self.assertIn('open Aviator bets', result['retained_activity'])
        stored = await self.database.users.find_one({'id': 'financial-player'})
        self.assertEqual(stored['status'], 'DELETED')
        self.assertEqual(stored['chip_balance'], 99000)
        for collection, status in rows.items():
            row = await self.database[collection].find_one({'user_id': 'financial-player'})
            self.assertEqual(row['status'], status, collection)
        chip_request = await self.database.chip_requests.find_one({'id': 'chip-request'})
        self.assertEqual(chip_request['status'], 'REJECTED')
        self.assertEqual(await self.database.admin_audit.count_documents({'action': 'PLAYER_ACCOUNT_DELETED'}), 1)

    async def test_every_registration_source_and_status_can_be_deleted(self):
        for source in ('OPERATOR', 'SELF_SERVICE'):
            for status in ('PENDING', 'ACTIVE', 'REJECTED', 'SUSPENDED', 'VERIFIED', 'PROFILE_SUBMITTED'):
                user_id = f'{source}-{status}'
                await self._player(user_id, username=user_id, status=status, registration_source=source)
                result = await routes_admin.delete_user_account(user_id, self.admin)
                self.assertEqual(result['deleted_user_id'], user_id)
                self.assertEqual((await self.database.users.find_one({'id': user_id}))['status'], 'DELETED')

    async def test_approved_deposit_is_terminal_but_approved_withdrawal_needs_reconciliation(self):
        await self._player('deposit-player')
        await self._player('withdrawal-player', username='withdrawal-player')
        await self.database.operator_payment_requests.insert_many([
            {'id': 'deposit', 'user_id': 'deposit-player', 'kind': 'DEPOSIT', 'status': 'APPROVED'},
            {'id': 'withdrawal', 'user_id': 'withdrawal-player', 'kind': 'WITHDRAWAL', 'status': 'APPROVED'},
        ])
        deposit_result = await routes_admin.delete_user_account('deposit-player', self.admin)
        self.assertFalse(deposit_result['reconciliation_required'])
        withdrawal_result = await routes_admin.delete_user_account('withdrawal-player', self.admin)
        self.assertIn('pending operator payments', withdrawal_result['retained_activity'])

    async def test_repeat_deletion_is_idempotent_and_deleted_players_stay_out_of_lists(self):
        await self._player('deleted-player', username='delete-me')
        await self._player('kept-player', username='keep-me')
        await routes_admin.delete_user_account('deleted-player', self.admin)
        result = await routes_admin.delete_user_account('deleted-player', self.admin)
        self.assertTrue(result['already_deleted'])
        self.assertEqual(await self.database.admin_audit.count_documents({'action': 'PLAYER_ACCOUNT_DELETED'}), 1)
        all_players = await routes_admin.list_users(status=None, admin=self.admin)
        self.assertEqual([row['id'] for row in all_players['users']], ['kept-player'])
        deleted_filter = await routes_admin.list_users(status='DELETED', admin=self.admin)
        self.assertEqual(deleted_filter['users'], [])
        self.assertEqual((await self.database.users.find_one({'id': 'kept-player'}))['status'], 'ACTIVE')

    async def test_deleted_accounts_cannot_be_reapproved_or_have_credentials_reset(self):
        await self._player()
        await routes_admin.delete_user_account('player-1', self.admin)
        with self.assertRaises(HTTPException) as caught:
            await routes_admin.approve_user('player-1', None, self.admin)
        self.assertEqual(caught.exception.status_code, 404)
        with self.assertRaises(HTTPException):
            routes_admin._require_player_credential_target(await self.database.users.find_one({'id': 'player-1'}))


if __name__ == '__main__':
    unittest.main(verbosity=2)
