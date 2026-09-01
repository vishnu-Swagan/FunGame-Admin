"""Pytest collection rules for legacy focused backend suites.

Several focused suites predate pytest and intentionally execute their checks
when run as scripts.  Importing those files during pytest collection would run
``sys.exit`` inside an xdist worker.  The subprocess-backed cases in
``test_script_suites.py`` keep each suite isolated and preserve every existing
assertion and exit status.
"""


collect_ignore = [
    "test_commission.py",
    "test_compliance.py",
    "test_crm.py",
    "test_distributor_parity.py",
    "test_enable_all_games.py",
    "test_game_transactions.py",
    "test_live_play_unblock.py",
    "test_migration_export.py",
    "test_otp_identity.py",
    "test_payments.py",
    "test_payouts.py",
    "test_portal.py",
    "test_public_catalog.py",
    "test_purge_legacy_game_data.py",
    "test_retire_legacy_demo_accounts.py",
    "test_revenue.py",
    "test_trusted_game_settlement.py",
]
