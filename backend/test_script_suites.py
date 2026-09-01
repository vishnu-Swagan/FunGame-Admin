"""Run the legacy self-executing safety suites in isolated processes."""

import os
from pathlib import Path
import subprocess
import sys

import pytest


BACKEND_DIR = Path(__file__).resolve().parent
SCRIPT_SUITES = (
    "test_commission.py",
    "test_compliance.py",
    "test_crm.py",
    "test_distributor_parity.py",
    "test_enable_all_games.py",
    "test_game_transactions.py",
    "test_manual_admin_registration.py",
    "test_migration_export.py",
    "test_otp_identity.py",
    "test_payments.py",
    "test_payouts.py",
    "test_portal.py",
    "test_phone_otp_registration.py",
    "test_public_catalog.py",
    "test_purge_legacy_game_data.py",
    "test_retire_legacy_demo_accounts.py",
    "test_revenue.py",
    "test_trusted_game_settlement.py",
)


@pytest.mark.parametrize("script_name", SCRIPT_SUITES)
def test_script_suite(script_name):
    environment = dict(os.environ)
    environment["PYTHONDONTWRITEBYTECODE"] = "1"
    completed = subprocess.run(
        [sys.executable, str(BACKEND_DIR / script_name)],
        cwd=BACKEND_DIR.parent,
        env=environment,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert completed.returncode == 0, (
        f"{script_name} exited with {completed.returncode}\n"
        f"stdout:\n{completed.stdout}\n"
        f"stderr:\n{completed.stderr}"
    )
