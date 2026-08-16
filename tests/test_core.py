"""Test-only smoke check for live-only account provisioning.

The public account-creation route must stay closed: a player account is created
only by an authenticated administrator in the live control plane.  This check
does not contain credentials, seed an account, or make a gameplay request.

Run only against a disposable environment:

    FUNGAME_TEST_BASE_URL=https://test.example/api python tests/test_core.py
"""

import os
import sys

import requests


BASE = os.environ.get("FUNGAME_TEST_BASE_URL", "").rstrip("/")


def main() -> int:
    if not BASE:
        print("Set FUNGAME_TEST_BASE_URL for a disposable test environment.")
        return 2

    response = requests.post(
        f"{BASE}/auth/register",
        json={"email": "closed-signup@example.test", "password": "NotARealAccount123!"},
        timeout=10,
    )
    if response.status_code != 410:
        print(f"FAIL: public registration must be closed (got {response.status_code})")
        return 1

    print("PASS: public registration is closed; accounts require administrator provisioning.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
