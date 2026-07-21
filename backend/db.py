"""Shared MongoDB connection."""
import os
from pathlib import Path
from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

mongo_url = os.environ['MONGO_URL']
# Connection pool + fail-fast timeouts so a slow/unreachable DB errors quickly
# instead of hanging worker request slots (the classic "server stuck" under load).
client = AsyncIOMotorClient(
    mongo_url,
    maxPoolSize=int(os.environ.get('MONGO_MAX_POOL', '200')),
    minPoolSize=int(os.environ.get('MONGO_MIN_POOL', '10')),
    maxIdleTimeMS=60_000,
    serverSelectionTimeoutMS=6000,
    connectTimeoutMS=6000,
    socketTimeoutMS=30_000,
    waitQueueTimeoutMS=8000,   # don't block forever waiting for a pooled connection
    retryWrites=True,
    retryReads=True,
    appname='fungame-api',
)
db = client[os.environ['DB_NAME']]


def serialize_doc(doc):
    """Recursively make a Mongo document JSON-safe (strip _id, convert datetimes)."""
    from datetime import datetime, date
    if doc is None:
        return None
    if isinstance(doc, list):
        return [serialize_doc(d) for d in doc]
    if isinstance(doc, dict):
        return {k: serialize_doc(v) for k, v in doc.items() if k not in ('_id', 'password_hash', 'verification_code_hash', 'reset_code_hash')}
    if isinstance(doc, (datetime, date)):
        return doc.isoformat()
    return doc
