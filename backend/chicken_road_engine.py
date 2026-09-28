"""Pure, versioned Chicken Road math; runtime release controls game approval.

The paytables originate in ``docs/chicken-road-live-rules-proposal.md``. They
are an original proposal, not recovered or certified provider rules. All
accounting and probability calculations below use integers only.

Fairness wire format: compact JSON arrays with ASCII escaping, encoded as
UTF-8. The commitment contains the domain, rules version, fairness version,
commitment ID, and literal lowercase hexadecimal server seed, in that order.
Lane HMAC messages contain the lane domain, rules version, fairness version,
difficulty, lane, nonce, rejection counter (starting at zero), and client seed.
The HMAC key is the 32 bytes decoded from the server seed; the entire SHA-256
digest is interpreted as an unsigned big-endian integer. These details are
part of FAIRNESS_VERSION and must match any separately published verifier.
"""

import hashlib
import hmac
import json
import re
from types import MappingProxyType


RULES_VERSION = "chicken-road-proposal-v2"
FAIRNESS_VERSION = "chicken-road-hmac-v1"
MIN_STAKE = 100
MAX_STAKE = 1000
STAKE_STEP = 100
MAX_LANES = 13
EXPIRY_SECONDS = 900

# Both proposals use these unchanged paytables. Keep this archive immutable:
# future paytable changes need a new snapshot and rules version, never edits
# to a profile that may already be bound to a commitment or accepted round.
LADDER_HUNDREDTHS = MappingProxyType({
    "easy": (106, 113, 120, 127, 134, 142, 151, 160, 169, 180, 190, 202, 214),
    "medium": (112, 128, 147, 170, 198, 233, 276, 332, 403, 496, 620, 691, 890),
    "hard": (135, 183, 247, 333, 449, 606, 818, 1104, 1490, 2011, 2715, 3665, 4947),
    "hardcore": (150, 225, 338, 507, 760, 1140, 1709, 2563, 3845, 5767, 8650, 12975, 19462),
})
_RULESETS = MappingProxyType({
    "chicken-road-proposal-v1": (97, "chicken-road-hmac-v1", LADDER_HUNDREDTHS),
    "chicken-road-proposal-v2": (90, "chicken-road-hmac-v1", LADDER_HUNDREDTHS),
})

_DIFFICULTIES = ("easy", "medium", "hard", "hardcore")
_COMMITMENT_DOMAIN = "chicken-road:seed-commitment"
_LANE_DOMAIN = "chicken-road:lane"
_UINT256_RANGE = 1 << 256
_SEED_PATTERN = re.compile(r"[0-9a-f]{64}")


def validate_stake(amount):
    """Return a whole-chip proposal stake, or raise ValueError without coercion."""
    if type(amount) is not int or not MIN_STAKE <= amount <= MAX_STAKE or amount % STAKE_STEP:
        raise ValueError("stake must be an integer from 100 to 1000 in increments of 100")
    return amount


def validate_difficulty(difficulty):
    """Return an exact, lowercase difficulty ID, or raise ValueError."""
    if type(difficulty) is not str or difficulty not in _DIFFICULTIES:
        raise ValueError("difficulty must be easy, medium, hard, or hardcore")
    return difficulty


def _validate_lane(lane):
    if type(lane) is not int or not 1 <= lane <= MAX_LANES:
        raise ValueError("lane must be an integer from 1 to 13")
    return lane


def _rules(rules_version=None):
    version = RULES_VERSION if rules_version is None else rules_version
    if type(version) is not str or version not in _RULESETS:
        raise ValueError("unsupported Chicken Road rules version")
    return version, _RULESETS[version]


def _ladder(difficulty, rules_version=None):
    validate_difficulty(difficulty)
    _, (target, _, ladders) = _rules(rules_version)
    ladder = ladders.get(difficulty)
    if not isinstance(ladder, tuple) or len(ladder) != MAX_LANES:
        raise ValueError("invalid proposal ladder")
    previous = target
    for value in ladder:
        if type(value) is not int or not previous < value < _UINT256_RANGE:
            raise ValueError("invalid proposal ladder")
        previous = value
    return ladder


def validate_locked_rules(rules_version, fairness_version, difficulty, multipliers_hundredths):
    """Reject unknown versions or altered round snapshots before settlement."""
    if type(rules_version) is not str:
        raise ValueError("locked Chicken Road rules must specify their version")
    _, (_, expected_fairness, _) = _rules(rules_version)
    ladder = _ladder(difficulty, rules_version)
    if (fairness_version != expected_fairness
            or type(multipliers_hundredths) is not list
            or any(type(value) is not int for value in multipliers_hundredths)
            or multipliers_hundredths != list(ladder)):
        raise ValueError("locked Chicken Road rules do not match their version")


def multiplier_hundredths(difficulty, lane, *, rules_version=None):
    """Return the exact gross multiplier numerator for a safe lane (1–13)."""
    _validate_lane(lane)
    return _ladder(difficulty, rules_version)[lane - 1]


def payout_chips(amount, difficulty, lane, *, rules_version=None):
    """Return the exact gross whole-chip payout, including the original stake."""
    validate_stake(amount)
    return amount * multiplier_hundredths(difficulty, lane, rules_version=rules_version) // 100


def rules_payload(rules_version=None):
    """Return a fresh JSON-safe description; approval is always UNAPPROVED."""
    version, (target, _, _) = _rules(rules_version)
    difficulties = []
    for difficulty in _DIFFICULTIES:
        ladder = _ladder(difficulty, version)
        previous = target
        collision_fractions = []
        for value in ladder:
            collision_fractions.append({"numerator": value - previous, "denominator": value})
            previous = value
        difficulties.append({
            "id": difficulty,
            "label": difficulty.capitalize(),
            "multipliers_hundredths": list(ladder),
            "collision_fractions": collision_fractions,
        })
    return {
        "version": version,
        "approval": "UNAPPROVED",
        "rtp_bps": target * 100,
        "min_stake": MIN_STAKE,
        "max_stake": MAX_STAKE,
        "stake_step": STAKE_STEP,
        "max_lanes": MAX_LANES,
        "difficulties": difficulties,
    }


def _validate_seed(seed, name):
    if type(seed) is not str or _SEED_PATTERN.fullmatch(seed) is None:
        raise ValueError(f"{name} must be exactly 64 lowercase hexadecimal characters")
    return seed


def _validate_identifier(value, name):
    if type(value) is not str or not value or len(value) > 128:
        raise ValueError(f"{name} must be a nonempty string of at most 128 characters")
    return value


def _canonical_bytes(parts):
    return json.dumps(parts, ensure_ascii=True, separators=(",", ":")).encode("utf-8")


def seed_commitment(server_seed, commitment_id, *, rules_version=None):
    """Commit to a seed and its identity before a client seed/stake is accepted."""
    _validate_seed(server_seed, "server_seed")
    _validate_identifier(commitment_id, "commitment_id")
    version, (_, fairness_version, _) = _rules(rules_version)
    return hashlib.sha256(_canonical_bytes([
        _COMMITMENT_DOMAIN, version, fairness_version, commitment_id, server_seed,
    ])).hexdigest()


def _hmac_sha256(key, message):
    """Small deterministic seam for independent sampling-boundary tests."""
    return hmac.new(key, message, hashlib.sha256).digest()


def _draw_lane(key, client_seed, nonce, difficulty, lane, upper_bound, *, rules_version=None):
    version, (_, fairness_version, _) = _rules(rules_version)
    # Only this complete multiple of upper_bound has equally sized residues.
    limit = _UINT256_RANGE - (_UINT256_RANGE % upper_bound)
    counter = 0
    while True:
        message = _canonical_bytes([
            _LANE_DOMAIN, version, fairness_version, difficulty, lane,
            nonce, counter, client_seed,
        ])
        sample = int.from_bytes(_hmac_sha256(key, message), "big")
        if sample < limit:
            return sample % upper_bound
        counter += 1


def lane_survives(server_seed, client_seed, nonce, difficulty, lane, *, rules_version=None):
    """Reproduce one proposal lane outcome with exact unbiased integer sampling.

    This pure function does not enforce commitment ordering, seed freshness,
    settlement, or secrecy. The calling service must enforce those guarantees.
    """
    _validate_seed(server_seed, "server_seed")
    _validate_seed(client_seed, "client_seed")
    _validate_identifier(nonce, "nonce")
    _validate_lane(lane)
    version, (target, _, _) = _rules(rules_version)
    ladder = _ladder(difficulty, version)
    threshold = target if lane == 1 else ladder[lane - 2]
    draw = _draw_lane(bytes.fromhex(server_seed), client_seed, nonce, difficulty, lane,
                      ladder[lane - 1], rules_version=version)
    return draw < threshold
