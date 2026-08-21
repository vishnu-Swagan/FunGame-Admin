"""Fail-closed transaction runner for balance-coupled game mutations."""

import os

from fastapi import HTTPException
from pymongo.errors import ConfigurationError, OperationFailure


_TRANSACTION_UNAVAILABLE_CODES = {20, 303}


def _unavailable_response(exc):
    raise HTTPException(status_code=503, detail={
        "code": "GAME_TRANSACTIONS_UNAVAILABLE",
        "message": "Game transactions are temporarily unavailable.",
    }) from exc


def _allow_nontransactional_tests() -> bool:
    return (
        str(os.environ.get("APP_ENV", "")).strip().lower() == "test"
        and str(os.environ.get("FINANCIAL_ALLOW_NON_TRANSACTIONAL_TESTS", "")).strip().lower() == "true"
    )


def _transaction_unavailable(exc: OperationFailure) -> bool:
    message = str(exc).lower()
    return (
        exc.code in _TRANSACTION_UNAVAILABLE_CODES
        or "transaction numbers are only allowed" in message
        or "transactions are not supported" in message
    )


async def run_game_transaction(client, callback):
    """Run the callback atomically, or fail before calling it in production."""

    try:
        session_cm = await client.start_session()
    except (AttributeError, ConfigurationError, NotImplementedError) as exc:
        if _allow_nontransactional_tests():
            return await callback(None)
        _unavailable_response(exc)
    except OperationFailure as exc:
        if not _transaction_unavailable(exc):
            raise
        if _allow_nontransactional_tests():
            return await callback(None)
        _unavailable_response(exc)
    try:
        async with session_cm as session:
            return await session.with_transaction(callback)
    except (AttributeError, ConfigurationError, NotImplementedError) as exc:
        # Never replay here: a driver may have invoked the callback before it
        # reported missing transaction support. The session context will abort
        # an open transaction; re-running without one could duplicate money.
        _unavailable_response(exc)
    except OperationFailure as exc:
        # Standalone Mongo deployments permit sessions but reject the first
        # transaction statement. Do not replay the callback without a
        # transaction: fail closed before any wallet/bet split can persist.
        if _transaction_unavailable(exc):
            _unavailable_response(exc)
        raise
