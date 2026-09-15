"""Only delivery attempts, not cooldown retries, spend the OTP send quota."""
import asyncio
import os
import sys
import unittest
from contextlib import ExitStack
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from fastapi import HTTPException
from mongomock_motor import AsyncMongoMockClient

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault('MONGO_URL', 'mongodb://127.0.0.1:27017')
os.environ.setdefault('DB_NAME', 'otp_send_quota_import')

import otp_service as otp
import routes_auth
from models import ResendVerificationRequest


class RecordingAdapter:
    def __init__(self):
        self.calls = []
        self.failure = None

    async def send(self, identity, code, purpose):
        self.calls.append((identity, code, purpose))
        if self.failure == 'uncertain':
            raise TimeoutError('Mock provider reply timed out')
        return {'sent': self.failure is None, 'provider': 'mock'}


class SynchronizedChallengeReads:
    """Force two requests to observe the same active-challenge snapshot."""
    def __init__(self, collection):
        self.collection = collection
        self.reads = 0
        self.ready = asyncio.Event()

    def __getattr__(self, name):
        return getattr(self.collection, name)

    async def find_one(self, query, *args, **kwargs):
        snapshot = await self.collection.find_one(query, *args, **kwargs)
        if self.reads < 2 and query.get('active') is True and query.get('identity_hash'):
            self.reads += 1
            if self.reads == 2:
                self.ready.set()
            await self.ready.wait()
        return snapshot


class RacingDatabase:
    def __init__(self, database):
        self.database = database
        self.otp_challenges = SynchronizedChallengeReads(database.otp_challenges)

    def __getattr__(self, name):
        return getattr(self.database, name)


class ExhaustedQuotaRace:
    """Force the old cleanup/restore race; revised code needs neither write.

    A clears its failed reservation; B sees no active challenge and reserves;
    A cannot restore the old code; B fails quota with no previous code to restore.
    If quota rejection occurs before mutation, release B immediately instead.
    """
    def __init__(self, database, previous_id):
        self.database = database
        self.otp_challenges = self
        self.collection = database.otp_challenges
        self.previous_id = previous_id
        self.start_second = asyncio.Event()
        self.second_reserved = asyncio.Event()
        self.first_restore_finished = asyncio.Event()
        self.finds = 0
        self.inserts = 0
        self.cleanups = 0
        self.quota_failures = 0

    def __getattr__(self, name):
        return getattr(self.database, name)

    async def find_one(self, query, *args, **kwargs):
        if query.get('active') is True and query.get('identity_hash'):
            self.finds += 1
            if self.finds == 2:
                await self.start_second.wait()
        return await self.collection.find_one(query, *args, **kwargs)

    async def insert_one(self, *args, **kwargs):
        result = await self.collection.insert_one(*args, **kwargs)
        self.inserts += 1
        if self.inserts == 2:
            self.second_reserved.set()
        return result

    async def update_one(self, query, update, *args, **kwargs):
        new_status = update.get('$set', {}).get('status')
        if new_status == 'NOT_SENT':
            self.cleanups += 1
            result = await self.collection.update_one(query, update, *args, **kwargs)
            if self.cleanups == 1:
                self.start_second.set()
                await self.second_reserved.wait()
            return result
        if new_status == 'PENDING' and query.get('id') == self.previous_id:
            try:
                return await self.collection.update_one(query, update, *args, **kwargs)
            finally:
                self.first_restore_finished.set()
        return await self.collection.update_one(query, update, *args, **kwargs)

    async def consume_limit(self, real_consume, *args, **kwargs):
        try:
            return await real_consume(*args, **kwargs)
        except otp.OtpError as exc:
            if exc.code != 'RATE_LIMITED':
                raise
            self.quota_failures += 1
            active = await self.collection.find_one({'active': True})
            if active and active['id'] == self.previous_id:
                # Revised implementation has not mutated the usable OTP.
                self.start_second.set()
            elif self.quota_failures == 2:
                await self.first_restore_finished.wait()
            raise


class CompetingInsertDatabase:
    def __init__(self, database, competing_insert):
        self.database = database
        self.otp_challenges = self
        self.auth_rate_limits = database.auth_rate_limits
        self.competing_insert = competing_insert

    def __getattr__(self, name):
        if name == 'find_one':
            return self.database.otp_challenges.find_one
        return getattr(self.database, name)

    async def insert_one(self, doc):
        await self.competing_insert()
        return await self.database.otp_challenges.insert_one(doc)


class OtpSendQuotaTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = AsyncMongoMockClient()
        self.database = self.client['otp_send_quota']
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.addCleanup(self.client.close)
        # Keep the Mongo TTL fixture in the future and inside one UTC hour.
        self.now = (datetime.now(timezone.utc) + timedelta(days=1)).replace(
            minute=10, second=0, microsecond=0,
        )
        self.stack.enter_context(patch.dict(os.environ, {
            'APP_ENV': 'test',
            'OTP_PEPPER': 'otp-send-quota-test-pepper-with-at-least-32-characters',
            'OTP_EXPOSE_DEV_CODE': 'false',
        }))
        self.stack.enter_context(patch.object(otp, '_now', lambda: self.now))
        self.stack.enter_context(patch.object(otp, 'db', self.database))
        self.stack.enter_context(patch.object(routes_auth, 'db', self.database))
        self.adapter = RecordingAdapter()
        self.stack.enter_context(patch.object(otp, 'delivery_adapter', lambda channel: self.adapter))
        await otp.ensure_indexes(database=self.database)
        self.identity = otp.Identity('SMS', '+919800000001')
        self.user = {
            'id': 'pending-player', 'role': 'PLAYER', 'status': 'PENDING',
            'phone': self.identity.value, 'phone_normalized': self.identity.value,
            'phone_verified': False, 'registration_source': 'SELF_SERVICE',
            'activation_mode': 'PHONE_OTP',
        }
        await self.database.users.insert_one(dict(self.user))

    async def issue(self, database=None):
        return await otp.issue_challenge(
            self.user, self.identity, otp.VERIFY_CONTACT,
            database=database if database is not None else self.database,
        )

    async def quota(self):
        rows = await self.database.auth_rate_limits.find({
            'action': 'otp_issue:VERIFY_CONTACT',
        }).to_list(length=None)
        return sum(row['count'] for row in rows)

    async def assert_otp_error(self, operation, code):
        with self.assertRaises(otp.OtpError) as caught:
            await operation
        self.assertEqual(caught.exception.code, code)
        return caught.exception

    async def test_cooldown_clicks_do_not_spend_five_send_allowances(self):
        await self.issue()
        for _ in range(10):
            self.now += timedelta(seconds=1)
            await self.assert_otp_error(self.issue(), 'OTP_RESEND_COOLDOWN')
        self.assertEqual(await self.quota(), 1)
        self.assertEqual(len(self.adapter.calls), 1)

        for _ in range(4):
            self.now += timedelta(seconds=61)
            await self.issue()
        self.assertEqual(await self.quota(), 5)
        self.assertEqual(len(self.adapter.calls), 5)
        self.now += timedelta(seconds=61)
        await self.assert_otp_error(self.issue(), 'RATE_LIMITED')
        self.assertEqual(len(self.adapter.calls), 5)

    async def test_fifth_delivery_limit_preserves_last_real_code_and_one_use(self):
        last = None
        for _ in range(5):
            last = await self.issue()
            self.now += timedelta(seconds=61)
        await self.assert_otp_error(self.issue(), 'RATE_LIMITED')
        active = await self.database.otp_challenges.find_one({'active': True})
        self.assertEqual(active['id'], last['challenge_id'])
        self.assertEqual(active['status'], 'PENDING')
        self.assertEqual(await self.database.otp_challenges.count_documents({}), 5)

        code = self.adapter.calls[-1][1]
        prepared = await otp.prepare_challenge_verification(
            self.identity, code, otp.VERIFY_CONTACT,
            challenge_id=last['challenge_id'], database=self.database,
        )
        await otp.consume_prepared_challenge(
            prepared, self.identity, code, otp.VERIFY_CONTACT, database=self.database,
        )
        await self.assert_otp_error(otp.consume_prepared_challenge(
            prepared, self.identity, code, otp.VERIFY_CONTACT, database=self.database,
        ), 'OTP_INVALID')

    async def test_exhausted_concurrent_resends_preserve_last_delivered_code(self):
        for _ in range(5):
            last = await self.issue()
            self.now += timedelta(seconds=61)
        database = ExhaustedQuotaRace(self.database, last['challenge_id'])
        real_consume = otp.consume_persistent_limit

        async def interleaved_consume(*args, **kwargs):
            return await database.consume_limit(real_consume, *args, **kwargs)

        with patch.object(otp, 'consume_persistent_limit', interleaved_consume):
            results = await asyncio.wait_for(asyncio.gather(
                self.issue(database), self.issue(database), return_exceptions=True,
            ), timeout=2)
        self.assertEqual([result.code for result in results], ['RATE_LIMITED', 'RATE_LIMITED'])
        active = await self.database.otp_challenges.find_one({'active': True})
        self.assertIsNotNone(active)
        self.assertEqual(active['id'], last['challenge_id'])
        self.assertEqual(await self.quota(), 5)
        self.assertEqual(len(self.adapter.calls), 5)
        self.assertEqual(database.inserts, 0)
        code = self.adapter.calls[-1][1]
        prepared = await otp.prepare_challenge_verification(
            self.identity, code, otp.VERIFY_CONTACT,
            challenge_id=last['challenge_id'], database=self.database,
        )
        await otp.consume_prepared_challenge(
            prepared, self.identity, code, otp.VERIFY_CONTACT, database=self.database,
        )

    async def test_failed_and_uncertain_delivery_attempts_still_spend_quota(self):
        for failure in ('rejected', 'uncertain', 'rejected', 'uncertain', 'rejected'):
            self.adapter.failure = failure
            await self.assert_otp_error(self.issue(), 'OTP_UNAVAILABLE')
        self.assertEqual(await self.quota(), 5)
        self.assertEqual(len(self.adapter.calls), 5)
        await self.assert_otp_error(self.issue(), 'RATE_LIMITED')
        self.assertEqual(len(self.adapter.calls), 5)
        self.assertEqual(await self.database.otp_challenges.count_documents({'active': True}), 0)

    async def test_concurrent_new_challenges_charge_only_reservation_winner(self):
        database = RacingDatabase(self.database)
        results = await asyncio.gather(self.issue(database), self.issue(database), return_exceptions=True)
        self.assertEqual(sum(isinstance(result, dict) for result in results), 1)
        errors = [result for result in results if isinstance(result, otp.OtpError)]
        self.assertEqual([error.code for error in errors], ['OTP_RESEND_COOLDOWN'])
        self.assertEqual(await self.quota(), 1)
        self.assertEqual(len(self.adapter.calls), 1)
        self.assertEqual(await self.database.otp_challenges.count_documents({'active': True}), 1)

    async def test_concurrent_resends_charge_only_reservation_winner(self):
        first = await self.issue()
        self.now += timedelta(seconds=61)
        database = RacingDatabase(self.database)
        results = await asyncio.gather(self.issue(database), self.issue(database), return_exceptions=True)
        self.assertEqual(sum(isinstance(result, dict) for result in results), 1)
        self.assertEqual(await self.quota(), 2)
        self.assertEqual(len(self.adapter.calls), 2)
        active = await self.database.otp_challenges.find_one({'active': True})
        self.assertNotEqual(active['id'], first['challenge_id'])
        self.assertEqual(await self.database.otp_challenges.count_documents({'active': True}), 1)

    async def test_collision_refunds_original_bucket_across_hour_boundary(self):
        self.now = self.now.replace(minute=59, second=59)
        original_window = self.now.replace(minute=0, second=0)

        async def compete_in_next_window():
            self.now += timedelta(seconds=2)
            await self.issue()

        database = CompetingInsertDatabase(self.database, compete_in_next_window)
        await self.assert_otp_error(self.issue(database), 'OTP_RESEND_COOLDOWN')
        rows = await self.database.auth_rate_limits.find({}).to_list(length=None)
        by_window = {otp._as_utc(row['window_started_at']): row['count'] for row in rows}
        self.assertEqual(by_window, {
            original_window: 0,
            original_window + timedelta(hours=1): 1,
        })
        self.assertEqual(len(self.adapter.calls), 1)
        self.assertEqual(await self.database.otp_challenges.count_documents({'active': True}), 1)

    async def test_uncertain_collision_refund_is_not_retried(self):
        async def compete():
            await self.issue()

        database = CompetingInsertDatabase(self.database, compete)
        with patch.object(database.auth_rate_limits, 'update_one',
                          side_effect=TimeoutError('Uncertain refund')) as refund:
            await self.assert_otp_error(self.issue(database), 'OTP_RESEND_COOLDOWN')
        self.assertEqual(refund.call_count, 1)
        self.assertEqual(await self.quota(), 2)
        self.assertEqual(len(self.adapter.calls), 1)

    async def test_public_resend_does_not_charge_route_quota_before_cooldown(self):
        body = ResendVerificationRequest(identifier=self.identity.value, channel='PHONE')
        await routes_auth.resend_verification(body)
        for _ in range(8):
            with self.assertRaises(HTTPException) as caught:
                await routes_auth.resend_verification(body)
            self.assertEqual(caught.exception.status_code, 429)
            self.assertEqual(caught.exception.detail['code'], 'OTP_RESEND_COOLDOWN')
        self.assertEqual(await self.quota(), 1)
        self.now += timedelta(seconds=61)
        await routes_auth.resend_verification(body)
        self.assertEqual(await self.quota(), 2)
        self.assertEqual(len(self.adapter.calls), 2)

    async def test_opaque_unknown_verified_deleted_resends_keep_request_limit(self):
        body = ResendVerificationRequest(identifier=self.identity.value, channel='PHONE')
        for state in ('UNKNOWN', 'VERIFIED', 'DELETED'):
            await self.database.auth_rate_limits.delete_many({})
            await self.database.users.delete_many({})
            if state != 'UNKNOWN':
                row = {**self.user, 'phone_verified': state == 'VERIFIED'}
                if state == 'DELETED':
                    row['status'] = 'DELETED'
                await self.database.users.insert_one(row)
            for _ in range(5):
                response = await routes_auth.resend_verification(body)
                self.assertEqual(response['message'], routes_auth.GENERIC_RESEND_MESSAGE)
            with self.assertRaises(HTTPException) as caught:
                await routes_auth.resend_verification(body)
            self.assertEqual(caught.exception.status_code, 429)
            self.assertEqual(caught.exception.detail['code'], 'RATE_LIMITED')
            self.assertEqual(await self.quota(), 5)
        self.assertEqual(self.adapter.calls, [])


if __name__ == '__main__':
    unittest.main()
