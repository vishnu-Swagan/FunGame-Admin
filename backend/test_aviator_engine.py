import hashlib
import os
import unittest
from unittest.mock import patch

import game_engines


class _FixedRandom:
    def __init__(self, value):
        self.value = value

    def random(self):
        return self.value


class AviatorEngineTests(unittest.TestCase):
    def test_payout_uses_integer_half_up_math(self):
        self.assertEqual(game_engines.aviator_payout_chips(50, 1.01), 51)
        self.assertEqual(game_engines.aviator_payout_chips(1, 1.01), 1)
        self.assertEqual(game_engines.aviator_payout_chips(100_000, 1000), 100_000_000)
        self.assertEqual(game_engines.aviator_multiplier_hundredths(1.015), 102)

    def test_payout_rejects_invalid_money_inputs(self):
        for stake in (0, -1, 1.5, True):
            with self.assertRaises(ValueError):
                game_engines.aviator_payout_chips(stake, 2)
        for multiplier in (0.99, float('nan'), float('inf'), True):
            with self.assertRaises(ValueError):
                game_engines.aviator_payout_chips(10, multiplier)

    def test_probability_factor_is_read_from_private_environment(self):
        with patch.dict(os.environ, {'AVIATOR_RETURN_FACTOR': '0.8'}), patch.object(
            game_engines, 'RNG', _FixedRandom(0.6)
        ):
            self.assertEqual(game_engines.aviator_crash_point(), 2.0)

    def test_crash_point_is_bounded(self):
        with patch.dict(os.environ, {'AVIATOR_RETURN_FACTOR': '0.8'}), patch.object(
            game_engines, 'RNG', _FixedRandom(0.999999)
        ):
            self.assertEqual(game_engines.aviator_crash_point(), 799999.99)

    def test_seeded_crash_point_is_reproducible(self):
        with patch.dict(os.environ, {'AVIATOR_RETURN_FACTOR': '0.8'}):
            first = game_engines.aviator_crash_point('reference-seed')
            self.assertEqual(first, game_engines.aviator_crash_point('reference-seed'))
            self.assertGreaterEqual(first, 1.0)

    def test_v2_commitment_binds_seed_and_return_factor(self):
        seed = 'reference-seed'
        commitment = game_engines.aviator_commitment(seed, 0.8)
        self.assertEqual(commitment, game_engines.aviator_commitment(seed, 0.8))
        self.assertNotEqual(commitment, game_engines.aviator_commitment(seed, 0.81))
        self.assertIn(
            'aviator-commit-v2:0.800000000000:',
            game_engines.aviator_commitment_payload(seed, 0.8),
        )

    def test_legacy_commitment_remains_verifiable(self):
        seed = 'legacy-seed'
        expected = hashlib.sha256(seed.encode()).hexdigest()
        self.assertEqual(game_engines.aviator_commitment(seed, 0.8, version=1), expected)

    def test_crash_point_is_last_reached_cent(self):
        # 0.8 / (1-u) = 1.231, so a 1.24x auto target must not be paid.
        with patch.dict(os.environ, {'AVIATOR_RETURN_FACTOR': '0.8'}), patch.object(
            game_engines, 'RNG', _FixedRandom(1 - (0.8 / 1.231))
        ):
            self.assertEqual(game_engines.aviator_crash_point(), 1.23)

    def test_reference_flight_curve_and_inverse_stay_in_sync(self):
        samples = [1.01, 2.0, 10.0, 100.0]
        for target in samples:
            elapsed = game_engines.aviator_time_for(target)
            self.assertGreaterEqual(game_engines.aviator_multiplier(elapsed), target)
            self.assertLess(game_engines.aviator_multiplier(max(0, elapsed - 0.02)), target)

    def test_missing_probability_configuration_fails_closed(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(RuntimeError, 'not configured'):
                game_engines.aviator_crash_point()

    def test_invalid_probability_configuration_fails_closed(self):
        with patch.dict(os.environ, {'AVIATOR_RETURN_FACTOR': '1.2'}):
            with self.assertRaisesRegex(RuntimeError, 'between 0 and 1'):
                game_engines.aviator_crash_point()


if __name__ == '__main__':
    unittest.main()
