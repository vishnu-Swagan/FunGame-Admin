"""Server-authoritative chip ledger helpers (integer amounts only)."""
import uuid
from datetime import datetime, timezone
from db import db


def _now():
    return datetime.now(timezone.utc).isoformat()


class InsufficientChips(Exception):
    pass


async def credit_chips(user_id: str, amount: int, note: str, ref: str = None):
    amount = int(amount)
    result = await db.users.find_one_and_update(
        {'id': user_id}, {'$inc': {'chip_balance': amount}}, return_document=True,
    )
    balance_after = result.get('chip_balance', 0) if result else 0
    await db.chip_transactions.insert_one({
        'id': str(uuid.uuid4()), 'user_id': user_id, 'type': 'CREDIT', 'amount': amount,
        'balance_after': balance_after, 'note': note, 'ref': ref, 'created_at': _now(),
    })
    return balance_after


async def debit_chips(user_id: str, amount: int, note: str, ref: str = None):
    amount = int(amount)
    result = await db.users.find_one_and_update(
        {'id': user_id, 'chip_balance': {'$gte': amount}},
        {'$inc': {'chip_balance': -amount}},
        return_document=True,
    )
    if result is None:
        raise InsufficientChips()
    balance_after = result.get('chip_balance', 0)
    await db.chip_transactions.insert_one({
        'id': str(uuid.uuid4()), 'user_id': user_id, 'type': 'DEBIT', 'amount': amount,
        'balance_after': balance_after, 'note': note, 'ref': ref, 'created_at': _now(),
    })
    return balance_after
