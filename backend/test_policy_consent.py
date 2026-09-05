"""Versioned registration-policy acceptance and compatibility checks."""
from __future__ import annotations

import hashlib
import json
import os
import sys
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from mongomock_motor import AsyncMongoMockClient


HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault('MONGO_URL', 'mongodb://127.0.0.1:27017')
os.environ.setdefault('DB_NAME', 'policy_consent_test_import')
os.environ.setdefault(
    'JWT_SECRET', 'policy-test-jwt-secret-with-at-least-32-characters',
)

import routes_auth
from models import RegisterRequest


CURRENT_POLICY_ENV = {
    'CURRENT_TERMS_VERSION': 'account-terms-2026.09',
    'CURRENT_PRIVACY_VERSION': 'privacy-2026.09',
    'TERMS_PUBLIC_URL': '/terms/account-terms-2026.09',
    'PRIVACY_PUBLIC_URL': 'https://legal.example.test/privacy-2026.09',
    'TERMS_EFFECTIVE_AT': '2026-09-02T00:00:00+05:30',
    'PRIVACY_EFFECTIVE_AT': '2026-09-02T00:00:00Z',
    'TERMS_CONTENT_SHA256': 'a' * 64,
    'PRIVACY_CONTENT_SHA256': 'b' * 64,
}


def registration(**overrides) -> RegisterRequest:
    values = {
        'channel': 'PHONE',
        'identifier': '+919876543210',
        'phone': '+919876543210',
        'email': 'policy.player@example.com',
        'username': 'Policy.Player',
        'full_name': 'Policy Player',
        'date_of_birth': '1990-01-01',
        'country': 'India',
        'accepted_terms': True,
        'accepted_privacy': True,
        'terms_version': CURRENT_POLICY_ENV['CURRENT_TERMS_VERSION'],
        'privacy_version': CURRENT_POLICY_ENV['CURRENT_PRIVACY_VERSION'],
        'password': 'Strong-Password-9',
        'password_confirmation': 'Strong-Password-9',
    }
    values.update(overrides)
    return RegisterRequest(**values)


class PolicyConsentTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = AsyncMongoMockClient()
        self.database = self.client['policy_consent_test']

    async def asyncTearDown(self):
        self.client.close()

    async def test_public_metadata_contains_no_invented_operator_facts(self):
        with patch.dict(os.environ, {
            **CURRENT_POLICY_ENV,
            'POLICY_EXPLICIT_VERSION_ACK_REQUIRED': 'true',
        }, clear=False):
            metadata = await routes_auth.current_policy_metadata()

        self.assertEqual(metadata['schema_version'], 1)
        self.assertEqual(
            metadata['documents']['terms']['version'], 'account-terms-2026.09',
        )
        self.assertEqual(
            metadata['documents']['terms']['effective_at'],
            '2026-09-01T18:30:00+00:00',
        )
        self.assertEqual(
            metadata['documents']['privacy']['content_sha256'], 'b' * 64,
        )
        self.assertTrue(metadata['acceptance']['explicit_versions_required'])
        self.assertFalse(
            metadata['acceptance']['legacy_single_checkbox_supported'],
        )
        rendered = json.dumps(metadata).lower()
        for absent in ('licence_number', 'regulator', 'operator_entity'):
            self.assertNotIn(absent, rendered)

    def test_compatibility_mode_snapshots_current_server_versions(self):
        legacy_body = registration(
            accepted_privacy=None, terms_version=None, privacy_version=None,
        )
        with patch.dict(os.environ, {
            **CURRENT_POLICY_ENV,
            'POLICY_EXPLICIT_VERSION_ACK_REQUIRED': 'false',
        }, clear=False):
            acceptance = routes_auth._registration_policy_acceptance(
                legacy_body, routes_auth.ADMIN_REVIEW_ACTIVATION_MODE,
            )

        self.assertEqual(
            acceptance['capture']['method'],
            'LEGACY_SINGLE_CHECKBOX_CURRENT_VERSION',
        )
        self.assertEqual(acceptance['policy_versions'], {
            'terms': 'account-terms-2026.09',
            'privacy': 'privacy-2026.09',
        })
        self.assertEqual(acceptance['affirmations'], {
            'terms': True, 'privacy': True,
        })

    def test_explicit_mode_rejects_missing_partial_and_stale_versions(self):
        with patch.dict(os.environ, {
            **CURRENT_POLICY_ENV,
            'POLICY_EXPLICIT_VERSION_ACK_REQUIRED': 'true',
        }, clear=False):
            with self.assertRaises(HTTPException) as missing:
                routes_auth._registration_policy_acceptance(
                    registration(
                        accepted_privacy=None,
                        terms_version=None,
                        privacy_version=None,
                    ),
                    routes_auth.ADMIN_REVIEW_ACTIVATION_MODE,
                )
            self.assertEqual(missing.exception.status_code, 422)
            self.assertEqual(
                missing.exception.detail['code'], 'POLICY_VERSIONS_REQUIRED',
            )

            with self.assertRaises(HTTPException) as partial:
                routes_auth._registration_policy_acceptance(
                    registration(privacy_version=None),
                    routes_auth.ADMIN_REVIEW_ACTIVATION_MODE,
                )
            self.assertEqual(
                partial.exception.detail['code'], 'POLICY_VERSIONS_REQUIRED',
            )

            with self.assertRaises(HTTPException) as stale:
                routes_auth._registration_policy_acceptance(
                    registration(terms_version='account-terms-2026.08'),
                    routes_auth.ADMIN_REVIEW_ACTIVATION_MODE,
                )
            self.assertEqual(stale.exception.status_code, 409)
            self.assertEqual(
                stale.exception.detail['code'], 'POLICY_VERSION_MISMATCH',
            )
            self.assertEqual(stale.exception.detail['current_versions'], {
                'terms': 'account-terms-2026.09',
                'privacy': 'privacy-2026.09',
            })

    def test_invalid_publication_metadata_fails_closed(self):
        with patch.dict(os.environ, {
            **CURRENT_POLICY_ENV,
            'TERMS_PUBLIC_URL': 'javascript:alert(1)',
        }, clear=False):
            with self.assertRaises(HTTPException) as raised:
                routes_auth._public_policy_metadata()
        self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(
            raised.exception.detail['code'], 'POLICY_CONFIG_UNAVAILABLE',
        )

        with patch.dict(os.environ, {
            **CURRENT_POLICY_ENV,
            'POLICY_EXPLICIT_VERSION_ACK_REQUIRED': 'true',
            'PRIVACY_CONTENT_SHA256': '',
        }, clear=False):
            with self.assertRaises(HTTPException) as incomplete:
                routes_auth._public_policy_metadata()
        self.assertEqual(incomplete.exception.status_code, 503)
        self.assertEqual(
            incomplete.exception.detail['code'], 'POLICY_CONFIG_UNAVAILABLE',
        )

    async def test_registration_persists_insert_only_versioned_evidence(self):
        async def run_without_session(callback):
            return await callback(None)

        with (
            patch.dict(os.environ, {
                **CURRENT_POLICY_ENV,
                'APP_ENV': 'test',
                'OTP_PEPPER': (
                    'policy-test-only-otp-pepper-with-at-least-32-characters'
                ),
                'POLICY_EXPLICIT_VERSION_ACK_REQUIRED': 'true',
            }, clear=False),
            patch.object(routes_auth, 'db', self.database),
            patch.object(
                routes_auth, 'require_identity_indexes', new=AsyncMock(),
            ),
            patch.object(
                routes_auth, 'require_registration_transactions', new=AsyncMock(),
            ),
            patch.object(
                routes_auth.crm,
                'require_registration_attribution_readiness',
                new=AsyncMock(),
            ),
            patch.object(
                routes_auth.crm,
                'require_portal_identity_readiness',
                new=AsyncMock(),
            ),
            patch.object(
                routes_auth.crm,
                'assert_player_login_id_available',
                new=AsyncMock(),
            ),
            patch.object(routes_auth.crm, 'attribute_user', new=AsyncMock()),
            patch.object(
                routes_auth.compliance, 'check_eligibility',
                new=AsyncMock(return_value=(True, None, None)),
            ),
            patch.object(
                routes_auth, '_telesign_onboarding_screen',
                new=AsyncMock(return_value=None),
            ),
            patch.object(routes_auth, 'hash_password', return_value='hashed'),
            patch.object(
                routes_auth, '_run_auth_transaction',
                side_effect=run_without_session,
            ),
        ):
            await routes_auth._register_for_admin_review(registration())

        user = await self.database.users.find_one({
            'pending_email': 'policy.player@example.com',
        })
        self.assertTrue(user['accepted_terms'])
        self.assertTrue(user['accepted_privacy'])
        self.assertEqual(user['accepted_terms_at'], user['accepted_privacy_at'])
        self.assertEqual(user['accepted_policy_versions'], {
            'terms': 'account-terms-2026.09',
            'privacy': 'privacy-2026.09',
        })

        evidence = await self.database.policy_acceptances.find_one({
            '_id': user['policy_acceptance_id'],
        })
        self.assertEqual(evidence['user_id'], user['id'])
        self.assertEqual(evidence['purpose'], 'ACCOUNT_REGISTRATION')
        self.assertEqual(evidence['jurisdiction'], 'IN')
        self.assertEqual(
            evidence['capture']['method'], 'EXPLICIT_VERSIONED',
        )
        self.assertEqual(
            evidence['policy_snapshot']['terms']['url'],
            '/terms/account-terms-2026.09',
        )
        self.assertNotIn('ip', json.dumps(evidence).lower())
        self.assertNotIn('user_agent', json.dumps(evidence).lower())

        evidence_payload = {
            key: value for key, value in evidence.items()
            if key not in ('_id', 'evidence_sha256')
        }
        expected_hash = hashlib.sha256(json.dumps(
            evidence_payload, sort_keys=True, separators=(',', ':'),
        ).encode('utf-8')).hexdigest()
        self.assertEqual(evidence['evidence_sha256'], expected_hash)

        # Changing the current configuration changes future acknowledgements,
        # never the immutable snapshot already stored for this player.
        with patch.dict(os.environ, {
            **CURRENT_POLICY_ENV,
            'CURRENT_TERMS_VERSION': 'account-terms-2026.10',
        }, clear=False):
            current = routes_auth._public_policy_metadata()
        stored_again = await self.database.policy_acceptances.find_one({
            '_id': user['policy_acceptance_id'],
        })
        self.assertEqual(
            current['documents']['terms']['version'], 'account-terms-2026.10',
        )
        self.assertEqual(
            stored_again['policy_versions']['terms'], 'account-terms-2026.09',
        )


if __name__ == '__main__':
    unittest.main()
