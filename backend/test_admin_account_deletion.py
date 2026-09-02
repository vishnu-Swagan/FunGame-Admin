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
        player = await self._player()
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
        self.assertIsNone(await self.database.users.find_one({'id': player['id']}))
        for collection in ('otp_challenges', 'notifications', 'verification_requests', 'chip_request_pending_counters'):
            self.assertEqual(await self.database[collection].count_documents({'user_id': player['id']}), 0)
        self.assertEqual(await self.database.avatar_uploads.count_documents({'_id': player['id']}), 0)
        self.assertEqual(await self.database.login_id_reservations.count_documents({'owner_id': player['id']}), 0)
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

    async def test_refuses_financial_history_and_open_activity_without_mutation(self):
        await self._player('financial-player', username='GK7654321')
        await self.database.deposit_orders.insert_one({
            'id': 'deposit-1', 'user_id': 'financial-player', 'status': 'CREDITED',
        })
        await self._player('active-player', username='GK1111111')
        await self.database.aviator_bets.insert_one({
            'id': 'bet-1', 'user_id': 'active-player', 'status': 'OPEN',
        })

        for target in ('financial-player', 'active-player'):
            with self.assertRaises(HTTPException) as caught:
                await routes_admin.delete_user_account(target, self.admin)
            self.assertEqual(caught.exception.status_code, 409)
            self.assertEqual(caught.exception.detail['code'], 'ACCOUNT_DELETE_BLOCKED')
            stored = await self.database.users.find_one({'id': target})
            self.assertEqual(stored['status'], 'ACTIVE')
        self.assertEqual(await self.database.admin_audit.count_documents({}), 0)


if __name__ == '__main__':
    unittest.main(verbosity=2)
