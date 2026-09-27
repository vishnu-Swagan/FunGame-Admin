"""Offline stdlib tests for unapproved Chicken Road proposal math and fairness."""

from fractions import Fraction
import hashlib
import hmac
import json
import unittest
from unittest.mock import patch

import chicken_road_engine as engine


TABLES = {
    "easy": (106, 113, 120, 127, 134, 142, 151, 160, 169, 180, 190, 202, 214),
    "medium": (112, 128, 147, 170, 198, 233, 276, 332, 403, 496, 620, 691, 890),
    "hard": (135, 183, 247, 333, 449, 606, 818, 1104, 1490, 2011, 2715, 3665, 4947),
    "hardcore": (150, 225, 338, 507, 760, 1140, 1709, 2563, 3845, 5767, 8650, 12975, 19462),
}
SERVER = "0123456789abcdef" * 4
CLIENT = "f" * 64
NONCE = "123e4567-e89b-12d3-a456-426614174000"
COMMITMENT_ID = "round-commitment-001"
UINT256_RANGE = 1 << 256


def independent_lane(difficulty, lane, server=SERVER, client=CLIENT, nonce=NONCE,
                     version="chicken-road-proposal-v2", target=90):
    """Reference derivation with literal protocol fields, independent of helpers."""
    denominator = TABLES[difficulty][lane - 1]
    threshold = target if lane == 1 else TABLES[difficulty][lane - 2]
    counter = 0
    while True:
        message = json.dumps([
            "chicken-road:lane", version, "chicken-road-hmac-v1",
            difficulty, lane, nonce, counter, client,
        ], ensure_ascii=True, separators=(",", ":")).encode("utf-8")
        digest = hmac.new(bytes.fromhex(server), message, hashlib.sha256).digest()
        candidate = int.from_bytes(digest, "big")
        if candidate < (UINT256_RANGE // denominator) * denominator:
            return candidate % denominator < threshold
        counter += 1


class ProposalMathTests(unittest.TestCase):
    def test_constants_and_authoritative_tables(self):
        self.assertEqual(engine.RULES_VERSION, "chicken-road-proposal-v2")
        self.assertEqual(engine.FAIRNESS_VERSION, "chicken-road-hmac-v1")
        self.assertEqual((engine.MIN_STAKE, engine.MAX_STAKE, engine.STAKE_STEP), (100, 1000, 100))
        self.assertEqual((engine.MAX_LANES, engine.EXPIRY_SECONDS), (13, 900))
        self.assertEqual(engine.LADDER_HUNDREDTHS, TABLES)
        for difficulty, values in TABLES.items():
            self.assertIsInstance(engine.LADDER_HUNDREDTHS[difficulty], tuple)
            for lane, value in enumerate(values, 1):
                self.assertEqual(engine.multiplier_hundredths(difficulty, lane), value)

    def test_new_difficulties_match_exact_rational_growth(self):
        for difficulty, growth in (("easy", Fraction(106, 100)), ("hard", Fraction(135, 100)), ("hardcore", Fraction(150, 100))):
            for lane in range(1, 14):
                raw = 100 * growth ** lane
                ceiling = (raw.numerator + raw.denominator - 1) // raw.denominator
                self.assertEqual(engine.multiplier_hundredths(difficulty, lane), ceiling)

    def test_exact_rtp_for_every_difficulty_lane_and_supported_stake(self):
        checked = 0
        for version, target in (("chicken-road-proposal-v1", 97), ("chicken-road-proposal-v2", 90)):
            for row in engine.rules_payload(version)["difficulties"]:
                difficulty, values = row["id"], TABLES[row["id"]]
                reach_probability = Fraction(1)
                previous = target
                for lane, (value, collision) in enumerate(zip(values, row["collision_fractions"]), 1):
                    survival = 1 - Fraction(collision["numerator"], collision["denominator"])
                    self.assertEqual(survival, Fraction(previous, value))
                    reach_probability *= survival
                    self.assertEqual(reach_probability, Fraction(target, value))
                    for stake in range(100, 1001, 100):
                        with self.subTest(version=version, difficulty=difficulty, lane=lane, stake=stake):
                            payout = engine.payout_chips(stake, difficulty, lane, rules_version=version)
                            self.assertIs(type(payout), int)
                            self.assertEqual((stake * value) % 100, 0)
                            self.assertEqual(Fraction(payout), Fraction(stake * value, 100))
                            self.assertEqual(reach_probability * payout / stake, Fraction(target, 100))
                            checked += 1
                    previous = value
        self.assertEqual(checked, 1040)
        self.assertEqual(engine.payout_chips(1000, "hardcore", 13), 194620)

    def test_conditional_risk_order_at_every_lane(self):
        for lane in range(1, 14):
            risks = []
            for values in TABLES.values():
                value = values[lane - 1]
                previous = 90 if lane == 1 else values[lane - 2]
                risks.append(Fraction(value - previous, value))
            self.assertTrue(all(left < right for left, right in zip(risks, risks[1:])))
        # Medium's captured lane 12 is a lower conditional risk than lane 11.
        self.assertLess(Fraction(71, 691), Fraction(124, 620))

    def test_rules_payload_is_unapproved_exact_and_json_safe(self):
        rules = engine.rules_payload()
        self.assertEqual(set(rules), {"version", "approval", "rtp_bps", "min_stake", "max_stake", "stake_step", "max_lanes", "difficulties"})
        self.assertEqual(rules["approval"], "UNAPPROVED")
        self.assertEqual(rules["version"], "chicken-road-proposal-v2")
        self.assertEqual(rules["rtp_bps"], 9000)
        self.assertEqual((rules["min_stake"], rules["max_stake"], rules["stake_step"], rules["max_lanes"]), (100, 1000, 100, 13))
        self.assertEqual([row["id"] for row in rules["difficulties"]], list(TABLES))
        for row in rules["difficulties"]:
            self.assertEqual(row["label"], row["id"].capitalize())
            self.assertEqual(row["multipliers_hundredths"], list(TABLES[row["id"]]))
            previous = 90
            for value, risk in zip(TABLES[row["id"]], row["collision_fractions"]):
                self.assertEqual(risk, {"numerator": value - previous, "denominator": value})
                previous = value
            self.assertEqual(len(row["collision_fractions"]), 13)
        self.assertEqual(json.loads(json.dumps(rules)), rules)

    def test_rules_payload_returns_fresh_nested_values(self):
        rules = engine.rules_payload()
        rules["approval"] = "APPROVED"
        rules["difficulties"][0]["multipliers_hundredths"][0] = 1
        rules["difficulties"][0]["collision_fractions"][0]["numerator"] = 0
        rules["difficulties"].pop()
        fresh = engine.rules_payload()
        self.assertEqual(fresh["approval"], "UNAPPROVED")
        self.assertEqual(len(fresh["difficulties"]), 4)
        self.assertEqual(fresh["difficulties"][0]["multipliers_hundredths"][0], 106)
        self.assertEqual(fresh["difficulties"][0]["collision_fractions"][0], {"numerator": 16, "denominator": 106})

    def test_version_upgrade_changes_only_first_lane_probability_and_rtp(self):
        old, current = engine.rules_payload("chicken-road-proposal-v1"), engine.rules_payload()
        self.assertEqual((old["rtp_bps"], current["rtp_bps"]), (9700, 9000))
        self.assertEqual(old["approval"], current["approval"])
        for previous, revised in zip(old["difficulties"], current["difficulties"]):
            self.assertEqual(previous["multipliers_hundredths"], revised["multipliers_hundredths"])
            self.assertEqual(previous["collision_fractions"][1:], revised["collision_fractions"][1:])
            self.assertEqual(revised["collision_fractions"][0]["numerator"] -
                             previous["collision_fractions"][0]["numerator"], 7)
        for field in ("min_stake", "max_stake", "stake_step", "max_lanes"):
            self.assertEqual(old[field], current[field])

    def test_locked_rules_require_known_version_pair_and_exact_integer_snapshot(self):
        for version in ("chicken-road-proposal-v1", "chicken-road-proposal-v2"):
            for difficulty, ladder in TABLES.items():
                self.assertIsNone(engine.validate_locked_rules(version, "chicken-road-hmac-v1", difficulty, list(ladder)))
        for version, fairness, difficulty, ladder in (
            (None, "chicken-road-hmac-v1", "medium", list(TABLES["medium"])),
            ("unknown", "chicken-road-hmac-v1", "medium", list(TABLES["medium"])),
            (engine.RULES_VERSION, "unknown", "medium", list(TABLES["medium"])),
            (engine.RULES_VERSION, "chicken-road-hmac-v1", "expert", list(TABLES["medium"])),
            (engine.RULES_VERSION, "chicken-road-hmac-v1", "medium", [112] * 13),
            (engine.RULES_VERSION, "chicken-road-hmac-v1", "medium", [112.0] + list(TABLES["medium"][1:])),
            (engine.RULES_VERSION, "chicken-road-hmac-v1", "medium", TABLES["medium"]),
        ):
            with self.subTest(version=version, fairness=fairness, difficulty=difficulty, ladder=ladder):
                with self.assertRaises(ValueError):
                    engine.validate_locked_rules(version, fairness, difficulty, ladder)

    def test_archived_ladders_cannot_be_mutated_or_rebound_through_current_export(self):
        with self.assertRaises(TypeError):
            engine.LADDER_HUNDREDTHS["medium"] = (112,) * 13
        with self.assertRaises(TypeError):
            engine._RULESETS["chicken-road-proposal-v1"] = (90, "bad", {})
        with patch.object(engine, "LADDER_HUNDREDTHS", {"medium": (999,) * 13}):
            for version in ("chicken-road-proposal-v1", "chicken-road-proposal-v2"):
                self.assertEqual(engine.payout_chips(300, "medium", 1, rules_version=version), 336)
                self.assertIsNone(engine.validate_locked_rules(version, "chicken-road-hmac-v1", "medium", list(TABLES["medium"])))

    def test_unknown_rules_fail_closed_in_every_consumer(self):
        for version in ("", "future-rules", 2, True, [], {}):
            with self.subTest(version=version), patch.object(engine, "_hmac_sha256") as draw:
                for call in (
                    lambda: engine.rules_payload(version),
                    lambda: engine.multiplier_hundredths("medium", 1, rules_version=version),
                    lambda: engine.payout_chips(300, "medium", 1, rules_version=version),
                    lambda: engine.seed_commitment(SERVER, COMMITMENT_ID, rules_version=version),
                    lambda: engine.lane_survives(SERVER, CLIENT, NONCE, "medium", 1, rules_version=version),
                ):
                    with self.assertRaises(ValueError):
                        call()
                draw.assert_not_called()

    def test_valid_stakes_and_difficulties_return_without_coercion(self):
        for stake in range(100, 1001, 100):
            self.assertEqual(engine.validate_stake(stake), stake)
        for difficulty in TABLES:
            self.assertEqual(engine.validate_difficulty(difficulty), difficulty)

    def test_invalid_stakes_rejected(self):
        for stake in (True, False, 100.0, 100.5, float("nan"), float("inf"), "100", None, [], {}, -100, 0, 99, 101, 999, 1001, 1100):
            with self.subTest(stake=stake):
                with self.assertRaises(ValueError):
                    engine.validate_stake(stake)
                with self.assertRaises(ValueError):
                    engine.payout_chips(stake, "medium", 1)

    def test_invalid_difficulties_rejected(self):
        for difficulty in ("", "Medium", " medium", "MEDIUM", "expert", None, True, 1, [], {}):
            with self.subTest(difficulty=difficulty):
                with self.assertRaises(ValueError):
                    engine.validate_difficulty(difficulty)
                with self.assertRaises(ValueError):
                    engine.multiplier_hundredths(difficulty, 1)
                with self.assertRaises(ValueError):
                    engine.lane_survives(SERVER, CLIENT, NONCE, difficulty, 1)

    def test_invalid_lanes_rejected_in_all_consumers(self):
        for lane in (True, False, 1.0, "1", None, [], {}, -1, 0, 14):
            with self.subTest(lane=lane):
                for call in (
                    lambda: engine.multiplier_hundredths("medium", lane),
                    lambda: engine.payout_chips(100, "medium", lane),
                    lambda: engine.lane_survives(SERVER, CLIENT, NONCE, "medium", lane),
                ):
                    with self.assertRaises(ValueError):
                        call()

    def test_malformed_ladders_fail_closed(self):
        invalid_ladders = (
            None, list(TABLES["medium"]), (), TABLES["medium"][:-1],
            (90,) + TABLES["medium"][1:],
            (True,) + TABLES["medium"][1:],
            (112.0,) + TABLES["medium"][1:],
            ("112",) + TABLES["medium"][1:],
            (112, 112) + TABLES["medium"][2:],
            TABLES["medium"][:-1] + (UINT256_RANGE,),
        )
        for ladder in invalid_ladders:
            invalid_rules = {engine.RULES_VERSION: (90, engine.FAIRNESS_VERSION, {**TABLES, "medium": ladder})}
            with self.subTest(ladder=ladder), patch.object(engine, "_RULESETS", invalid_rules):
                for call in (
                    engine.rules_payload,
                    lambda: engine.multiplier_hundredths("medium", 1),
                    lambda: engine.payout_chips(100, "medium", 1),
                    lambda: engine.lane_survives(SERVER, CLIENT, NONCE, "medium", 1),
                ):
                    with self.assertRaises(ValueError):
                        call()
        with patch.object(engine, "_RULESETS", {engine.RULES_VERSION: (90, engine.FAIRNESS_VERSION, {})}):
            with self.assertRaises(ValueError):
                engine.rules_payload()


class FairnessTests(unittest.TestCase):
    def test_commitment_matches_independent_and_fixed_derivation(self):
        wire = ('["chicken-road:seed-commitment","chicken-road-proposal-v2",'
                '"chicken-road-hmac-v1","round-commitment-001",'
                '"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"]')
        expected = "94dbb913e70141b3d9fbffcf0d98136c2c80f8e8eb30794a8702df2c1d5c0eeb"
        self.assertEqual(hashlib.sha256(wire.encode("utf-8")).hexdigest(), expected)
        self.assertEqual(engine.seed_commitment(SERVER, COMMITMENT_ID), expected)

    def test_commitment_binds_seed_identity_and_both_versions(self):
        original = engine.seed_commitment(SERVER, COMMITMENT_ID)
        self.assertNotEqual(original, engine.seed_commitment("0" * 64, COMMITMENT_ID))
        self.assertNotEqual(original, engine.seed_commitment(SERVER, COMMITMENT_ID + "-2"))
        legacy = engine.seed_commitment(SERVER, COMMITMENT_ID, rules_version="chicken-road-proposal-v1")
        self.assertEqual(legacy, "b498afde0591b4d72b7dc2cf1426e12dab823696435add65e97138596858dbdf")
        self.assertNotEqual(original, legacy)
        # Historical commitments use the archived fairness version, not a
        # deployment's later defaults. Its literal wire hash is frozen above.
        with patch.object(engine, "RULES_VERSION", "future-rules"), patch.object(engine, "FAIRNESS_VERSION", "future-fairness"):
            self.assertEqual(legacy, engine.seed_commitment(SERVER, COMMITMENT_ID, rules_version="chicken-road-proposal-v1"))
            self.assertEqual(original, engine.seed_commitment(SERVER, COMMITMENT_ID, rules_version="chicken-road-proposal-v2"))

    def test_canonical_identifiers_are_unambiguous_and_ascii_escaped(self):
        identifier = 'round:|["\\\n\u2603'
        expected_wire = json.dumps([
            "chicken-road:seed-commitment", "chicken-road-proposal-v2", "chicken-road-hmac-v1", identifier, SERVER,
        ], ensure_ascii=True, separators=(",", ":")).encode("utf-8")
        self.assertEqual(engine.seed_commitment(SERVER, identifier), hashlib.sha256(expected_wire).hexdigest())
        with patch.object(engine, "_hmac_sha256", return_value=bytes(32)) as digest:
            engine.lane_survives(SERVER, CLIENT, identifier, "easy", 1)
        parts = json.loads(digest.call_args.args[1])
        self.assertEqual(parts[5], identifier)
        self.assertIn(b"\\u2603", digest.call_args.args[1])

    def test_legacy_fixed_lane_outcome_and_digest_fixtures_are_unchanged(self):
        fixtures = (
            ("easy", 1, "0c4b97b6c2dce072d5c8d9882edbb29d6dee230a37b2de59b9364677d494e97a", 104, False),
            ("medium", 1, "0ee43c3fcef1b72a1f92d3918013818bf70202f3a4a07a8335fb80319061635d", 93, True),
            ("medium", 12, "2b1d510899e2fbfb47d309d06edd84bed82887b2164b7fda5f2490f7f8552de5", 260, True),
            ("medium", 13, "9546b21d55c7f39494587ab59451674c7f80042c5e8565ec16fd64af4eaf3ed8", 416, True),
            ("hard", 2, "58a9a49c4dcd085903a4c3ad210594257126c598853256898ed12909b9511666", 123, True),
            ("hardcore", 1, "3c514cd8f5f0a678814f68ee9cabc0c09a7fc3ae100f1cac9eab6ab599e12a28", 102, False),
            ("hardcore", 13, "ef70732e441ebd4d2c4daa2c395cf3762150bad368bf6ba780e3708e28541f90", 18374, False),
        )
        for difficulty, lane, digest_hex, draw, survives in fixtures:
            with self.subTest(difficulty=difficulty, lane=lane):
                wire = json.dumps([
                    "chicken-road:lane", "chicken-road-proposal-v1", "chicken-road-hmac-v1",
                    difficulty, lane, NONCE, 0, CLIENT,
                ], separators=(",", ":")).encode("utf-8")
                self.assertEqual(hmac.new(bytes.fromhex(SERVER), wire, hashlib.sha256).hexdigest(), digest_hex)
                self.assertEqual(int(digest_hex, 16) % TABLES[difficulty][lane - 1], draw)
                self.assertIs(engine.lane_survives(SERVER, CLIENT, NONCE, difficulty, lane,
                                                 rules_version="chicken-road-proposal-v1"), survives)

    def test_current_fixed_lane_outcome_and_digest_fixtures(self):
        fixtures = (
            ("easy", 1, "9af8637cde835ec331b08cb9347264731633105c9073eb6319914af6609a15bd", 87, True),
            ("medium", 1, "e54567793983d1eb75b23be11ddce6d68b52150399f6f9b04d9eb4cf27bf1aef", 63, True),
            ("medium", 12, "43aba19b0468dfc3acc1c515d86c2069e3f241350907398bc331905dae548a1e", 166, True),
            ("medium", 13, "5f437ae1dd00634b1dc4bcc23cc3d2a67a42ced98ccb2a7a9ebd96871b6f343f", 85, True),
            ("hard", 2, "511726c82cc66f47d03523c89e51703b61d3f77b66dda5010b1712c01dae191c", 48, True),
            ("hardcore", 1, "86c07afe398a96a5ef3e7bae028d9063129df90a8f391e2721233325495679eb", 15, True),
            ("hardcore", 13, "8930cdb281003296cb6841b5c76b49d250d9509ea9661a7993d5a1aae73b39f4", 14452, False),
        )
        for difficulty, lane, digest_hex, draw, survives in fixtures:
            with self.subTest(difficulty=difficulty, lane=lane):
                wire = json.dumps([
                    "chicken-road:lane", "chicken-road-proposal-v2", "chicken-road-hmac-v1",
                    difficulty, lane, NONCE, 0, CLIENT,
                ], separators=(",", ":")).encode("utf-8")
                self.assertEqual(hmac.new(bytes.fromhex(SERVER), wire, hashlib.sha256).hexdigest(), digest_hex)
                self.assertEqual(int(digest_hex, 16) % TABLES[difficulty][lane - 1], draw)
                self.assertIs(engine.lane_survives(SERVER, CLIENT, NONCE, difficulty, lane), survives)

    def test_all_lanes_match_independent_derivation_and_retry_replays(self):
        for version, target in (("chicken-road-proposal-v1", 97), ("chicken-road-proposal-v2", 90)):
            for difficulty in TABLES:
                for lane in range(1, 14):
                    for nonce in (NONCE, "another-round"):
                        expected = independent_lane(difficulty, lane, nonce=nonce, version=version, target=target)
                        for _ in range(2):
                            self.assertIs(engine.lane_survives(SERVER, CLIENT, nonce, difficulty, lane,
                                                             rules_version=version), expected)

    def test_each_lane_survival_threshold_and_its_exact_boundary(self):
        for version, target in (("chicken-road-proposal-v1", 97), ("chicken-road-proposal-v2", 90)):
            for difficulty, values in TABLES.items():
                for lane, upper_bound in enumerate(values, 1):
                    threshold = target if lane == 1 else values[lane - 2]
                    for value, survives in ((0, True), (threshold - 1, True), (threshold, False), (upper_bound - 1, False)):
                        with self.subTest(version=version, difficulty=difficulty, lane=lane, value=value):
                            with patch.object(engine, "_hmac_sha256", return_value=value.to_bytes(32, "big")):
                                self.assertIs(engine.lane_survives(SERVER, CLIENT, NONCE, difficulty, lane,
                                                                 rules_version=version), survives)

    def test_exhaustive_first_lane_residues_have_exact_90_or_97_survivors(self):
        for version, target in (("chicken-road-proposal-v1", 97), ("chicken-road-proposal-v2", 90)):
            for difficulty, values in TABLES.items():
                with self.subTest(version=version, difficulty=difficulty):
                    samples = [value.to_bytes(32, "big") for value in range(values[0])]
                    with patch.object(engine, "_hmac_sha256", side_effect=samples):
                        outcomes = [engine.lane_survives(SERVER, CLIENT, NONCE, difficulty, 1,
                                                        rules_version=version) for _ in samples]
                    self.assertEqual(sum(outcomes), target)

    def test_rejected_values_advance_bound_counter_and_use_fresh_hmac(self):
        upper_bound = 112
        limit = (UINT256_RANGE // upper_bound) * upper_bound
        self.assertGreater(UINT256_RANGE, limit)
        samples = (UINT256_RANGE - 1, limit, 89)
        with patch.object(engine, "_hmac_sha256", side_effect=[sample.to_bytes(32, "big") for sample in samples]) as digest:
            self.assertTrue(engine.lane_survives(SERVER, CLIENT, NONCE, "medium", 1))
        self.assertEqual(digest.call_count, 3)
        for counter, call in enumerate(digest.call_args_list):
            self.assertEqual(call.args[0], bytes.fromhex(SERVER))
            self.assertEqual(json.loads(call.args[1]), [
                "chicken-road:lane", "chicken-road-proposal-v2", "chicken-road-hmac-v1",
                "medium", 1, NONCE, counter, CLIENT,
            ])

    def test_rejection_avoids_modulo_bias_at_full_width_upper_boundary(self):
        # The final accepted block has one of every residue. The next value
        # would repeat residue zero, so it must cause a fresh counter draw.
        denominator = 3
        limit = (UINT256_RANGE // denominator) * denominator
        draws = []
        for sample in range(limit - denominator, limit):
            with patch.object(engine, "_hmac_sha256", return_value=sample.to_bytes(32, "big")):
                draws.append(engine._draw_lane(bytes.fromhex(SERVER), CLIENT, NONCE, "easy", 1, denominator))
        self.assertEqual(draws, [0, 1, 2])
        with patch.object(engine, "_hmac_sha256", side_effect=[limit.to_bytes(32, "big"), (2).to_bytes(32, "big")]) as digest:
            self.assertEqual(engine._draw_lane(bytes.fromhex(SERVER), CLIENT, NONCE, "easy", 1, denominator), 2)
        self.assertEqual(digest.call_count, 2)

    def test_divisor_of_digest_range_does_not_discard_maximum_sample(self):
        # Medium lane 2 has range 128, which exactly divides the digest space.
        with patch.object(engine, "_hmac_sha256", return_value=(UINT256_RANGE - 1).to_bytes(32, "big")) as digest:
            self.assertFalse(engine.lane_survives(SERVER, CLIENT, NONCE, "medium", 2))
        self.assertEqual(digest.call_count, 1)

    def test_every_stream_field_is_bound_in_hmac_input(self):
        cases = (
            (SERVER, CLIENT, NONCE, "medium", 1),
            ("0" * 64, CLIENT, NONCE, "medium", 1),
            (SERVER, "e" * 64, NONCE, "medium", 1),
            (SERVER, CLIENT, NONCE + "-2", "medium", 1),
            (SERVER, CLIENT, NONCE, "hard", 1),
            (SERVER, CLIENT, NONCE, "medium", 2),
        )
        calls = []
        for args in cases:
            with patch.object(engine, "_hmac_sha256", return_value=bytes(32)) as digest:
                engine.lane_survives(*args)
                calls.append(digest.call_args.args)
        self.assertEqual(len(set(calls)), len(cases))
        with patch.object(engine, "_hmac_sha256", return_value=bytes(32)) as digest:
            engine.lane_survives(*cases[0], rules_version="chicken-road-proposal-v1")
            self.assertNotEqual(digest.call_args.args, calls[0])
            self.assertEqual(json.loads(digest.call_args.args[1])[1:3],
                             ["chicken-road-proposal-v1", "chicken-road-hmac-v1"])

    def test_invalid_seed_forms_rejected_before_drawing(self):
        invalid = (None, True, 0, bytes(32), [], {}, "", "0" * 63, "0" * 65, "g" * 64, "A" * 64, "0" * 63 + "\n")
        with patch.object(engine, "_hmac_sha256") as digest:
            for seed in invalid:
                with self.subTest(seed=seed):
                    with self.assertRaises(ValueError):
                        engine.seed_commitment(seed, COMMITMENT_ID)
                    with self.assertRaises(ValueError):
                        engine.lane_survives(seed, CLIENT, NONCE, "medium", 1)
                    with self.assertRaises(ValueError):
                        engine.lane_survives(SERVER, seed, NONCE, "medium", 1)
            digest.assert_not_called()

    def test_nonce_and_commitment_identifier_bounds(self):
        for identifier in (None, True, 123, [], {}, b"nonce", "", "a" * 129):
            with self.subTest(identifier=identifier):
                with self.assertRaises(ValueError):
                    engine.seed_commitment(SERVER, identifier)
                with self.assertRaises(ValueError):
                    engine.lane_survives(SERVER, CLIENT, identifier, "easy", 1)
        self.assertEqual(len(engine.seed_commitment(SERVER, "a" * 128)), 64)
        self.assertIs(type(engine.lane_survives(SERVER, CLIENT, "a" * 128, "easy", 1)), bool)


if __name__ == "__main__":
    unittest.main()
