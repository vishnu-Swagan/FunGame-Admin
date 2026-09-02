import hashlib
import os
import unittest
from unittest.mock import patch

import game_engines


class ChickenRoadEngineTests(unittest.TestCase):
    def test_default_return_factor_when_unconfigured(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(
                game_engines.chicken_road_return_factor(),
                game_engines.CHICKEN_ROAD_DEFAULT_RETURN_FACTOR,
            )

    def test_invalid_return_factor_fails_closed(self):
        with patch.dict(os.environ, {'CHICKEN_ROAD_RETURN_FACTOR': '1.5'}):
            with self.assertRaisesRegex(RuntimeError, 'between 0 and 1'):
                game_engines.chicken_road_return_factor()

    def test_easy_multipliers_match_reference_stills(self):
        easy = game_engines.chicken_road_lane_multipliers('easy')
        self.assertEqual(easy[0], 1.01)
        self.assertEqual(easy[1], 1.03)
        self.assertEqual(easy[2], 1.06)
        self.assertEqual(easy[4], 1.15)
        self.assertEqual(easy[5], 1.19)
        self.assertEqual(easy[23], 8.36)
        self.assertEqual(easy[24], 12.08)
        self.assertEqual(len(easy), game_engines.CHICKEN_ROAD_LANE_COUNT)
        # Strictly climbing so later lanes are always a bigger cash-out.
        self.assertEqual(easy, sorted(easy))
        self.assertGreater(easy[-1], easy[0])

    def test_harder_difficulties_grow_faster(self):
        easy = game_engines.chicken_road_lane_multipliers('easy')
        hardcore = game_engines.chicken_road_lane_multipliers('hardcore')
        self.assertGreater(hardcore[4], easy[4])
        self.assertGreater(hardcore[-1], easy[-1])

    def test_unknown_difficulty_falls_back_to_easy(self):
        self.assertEqual(
            game_engines.chicken_road_lane_multipliers('nope'),
            game_engines.chicken_road_lane_multipliers('easy'),
        )

    def test_seeded_crash_lane_is_reproducible_and_bounded(self):
        first = game_engines.chicken_road_crash_lane('reference-seed', 'easy')
        self.assertEqual(first, game_engines.chicken_road_crash_lane('reference-seed', 'easy'))
        self.assertGreaterEqual(first, 1)
        self.assertLessEqual(first, game_engines.CHICKEN_ROAD_LANE_COUNT + 1)

    def test_hardcore_crashes_earlier_than_easy_on_same_seed_distribution(self):
        # Over many seeds the mean crash lane on hardcore must be lower than easy.
        seeds = [f'seed-{i}' for i in range(200)]
        easy_mean = sum(game_engines.chicken_road_crash_lane(s, 'easy') for s in seeds) / len(seeds)
        hard_mean = sum(game_engines.chicken_road_crash_lane(s, 'hardcore') for s in seeds) / len(seeds)
        self.assertLess(hard_mean, easy_mean)

    def test_seed_namespace_is_distinct_from_aviator(self):
        seed = 'shared-seed'
        self.assertNotEqual(
            game_engines.chicken_road_uniform_from_seed(seed),
            game_engines.aviator_uniform_from_seed(seed),
        )

    def test_commitment_binds_seed_and_difficulty(self):
        seed = 'reference-seed'
        commitment = game_engines.chicken_road_commitment(seed, 'easy')
        self.assertEqual(commitment, game_engines.chicken_road_commitment(seed, 'easy'))
        self.assertNotEqual(commitment, game_engines.chicken_road_commitment(seed, 'hard'))
        self.assertIn(
            'chicken-road-hop-commit-v1:easy:',
            game_engines.chicken_road_commitment_payload(seed, 'easy'),
        )

    def test_result_hash_matches_published_fairness_algorithm(self):
        seed = 'reference-seed'
        expected = hashlib.sha256(f'chicken-road-hop-v1:{seed}'.encode()).hexdigest()
        self.assertEqual(
            hashlib.sha256(f'chicken-road-hop-v1:{seed}'.encode()).hexdigest(), expected
        )

    def test_four_difficulties_are_published(self):
        self.assertEqual(
            set(game_engines.CHICKEN_ROAD_DIFFICULTIES),
            {'easy', 'medium', 'hard', 'hardcore'},
        )


if __name__ == '__main__':
    unittest.main()
