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
    def test_probability_factor_is_read_from_private_environment(self):
        with patch.dict(os.environ, {'AVIATOR_RETURN_FACTOR': '0.8'}), patch.object(
            game_engines, 'RNG', _FixedRandom(0.6)
        ):
            self.assertEqual(game_engines.aviator_crash_point(), 2.0)

    def test_crash_point_is_bounded(self):
        with patch.dict(os.environ, {'AVIATOR_RETURN_FACTOR': '0.8'}), patch.object(
            game_engines, 'RNG', _FixedRandom(0.999999)
        ):
            self.assertEqual(game_engines.aviator_crash_point(), 200.0)

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
