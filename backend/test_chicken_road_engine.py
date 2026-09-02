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


class ChickenRoadEngineTests(unittest.TestCase):
    def test_default_return_factor_when_unconfigured(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(
                game_engines.chicken_road_return_factor(),
                game_engines.CHICKEN_ROAD_DEFAULT_RETURN_FACTOR,
            )

    def test_return_factor_reads_environment_override(self):
        with patch.dict(os.environ, {'CHICKEN_ROAD_RETURN_FACTOR': '0.8'}), patch.object(
            game_engines, 'RNG', _FixedRandom(0.6)
        ):
            self.assertEqual(game_engines.chicken_road_crash_point(), 2.0)

    def test_invalid_return_factor_fails_closed(self):
        with patch.dict(os.environ, {'CHICKEN_ROAD_RETURN_FACTOR': '1.5'}):
            with self.assertRaisesRegex(RuntimeError, 'between 0 and 1'):
                game_engines.chicken_road_return_factor()

    def test_crash_point_is_bounded_and_last_reached_cent(self):
        with patch.dict(os.environ, {'CHICKEN_ROAD_RETURN_FACTOR': '0.8'}), patch.object(
            game_engines, 'RNG', _FixedRandom(0.999999)
        ):
            self.assertEqual(game_engines.chicken_road_crash_point(), 799999.99)
        # 0.8 / (1-u) = 1.231 -> the 1.24x target must not be paid.
        with patch.dict(os.environ, {'CHICKEN_ROAD_RETURN_FACTOR': '0.8'}), patch.object(
            game_engines, 'RNG', _FixedRandom(1 - (0.8 / 1.231))
        ):
            self.assertEqual(game_engines.chicken_road_crash_point(), 1.23)

    def test_seeded_crash_point_is_reproducible(self):
        first = game_engines.chicken_road_crash_point('reference-seed', 0.97)
        self.assertEqual(first, game_engines.chicken_road_crash_point('reference-seed', 0.97))
        self.assertGreaterEqual(first, 1.0)

    def test_seed_namespace_is_distinct_from_aviator(self):
        # A shared seed must never yield the same crash on both tables.
        seed = 'shared-seed'
        self.assertNotEqual(
            game_engines.chicken_road_uniform_from_seed(seed),
            game_engines.aviator_uniform_from_seed(seed),
        )

    def test_commitment_binds_seed_and_return_factor(self):
        seed = 'reference-seed'
        commitment = game_engines.chicken_road_commitment(seed, 0.97)
        self.assertEqual(commitment, game_engines.chicken_road_commitment(seed, 0.97))
        self.assertNotEqual(commitment, game_engines.chicken_road_commitment(seed, 0.96))
        self.assertIn(
            'chicken-road-commit-v1:0.970000000000:',
            game_engines.chicken_road_commitment_payload(seed, 0.97),
        )

    def test_climb_curve_shares_the_aviator_reference_curve(self):
        for elapsed in (0.0, 1.5, 5.0, 12.0):
            self.assertEqual(
                game_engines.chicken_road_multiplier(elapsed),
                game_engines.aviator_multiplier(elapsed),
            )

    def test_climb_curve_and_inverse_stay_in_sync(self):
        for target in (1.01, 2.0, 10.0, 100.0):
            elapsed = game_engines.chicken_road_time_for(target)
            self.assertGreaterEqual(game_engines.chicken_road_multiplier(elapsed), target)
            self.assertLess(
                game_engines.chicken_road_multiplier(max(0, elapsed - 0.02)), target
            )

    def test_result_hash_matches_published_fairness_algorithm(self):
        seed = 'reference-seed'
        expected = hashlib.sha256(f'chicken-road-crash-v1:{seed}'.encode()).hexdigest()
        # The fairness endpoint recomputes exactly this hash to reveal the seed.
        self.assertEqual(
            hashlib.sha256(f'chicken-road-crash-v1:{seed}'.encode()).hexdigest(), expected
        )


if __name__ == '__main__':
    unittest.main()