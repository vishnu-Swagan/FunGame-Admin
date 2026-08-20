"""Security middleware: response headers + persistent auth rate limiting."""
import time
import logging
import hashlib
from datetime import datetime, timedelta, timezone
from collections import defaultdict, deque
from pymongo.errors import DuplicateKeyError
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse
from db import db

logger = logging.getLogger(__name__)

# path prefix -> (max_requests, window_seconds). Only auth/abuse-prone routes.
RATE_LIMITS = {
    '/api/auth/login': (8, 300),               # 8 tries / 5 min — brute-force guard
    '/api/auth/register': (5, 3600),
    '/api/auth/forgot-password': (5, 900),     # 5 / 15 min
    '/api/auth/reset-password': (10, 900),
    '/api/auth/verify-email': (10, 900),
    '/api/auth/verify-otp': (10, 900),
    '/api/auth/resend-verification': (5, 900),
    '/api/auth/resend-otp': (5, 900),
    '/api/auth/signup-request': (5, 3600),     # 5 / hour
    '/api/security/integrity': (30, 300),
}

# key (ip|path) -> deque[timestamps]
_hits: dict[str, deque] = defaultdict(deque)
_last_prune = [time.time()]


def _client_ip(request) -> str:
    xff = request.headers.get('x-forwarded-for')
    if xff:
        return xff.split(',')[0].strip()
    return request.client.host if request.client else 'unknown'


def _prune(now: float):
    # occasional global prune so the dict can't grow unbounded
    if now - _last_prune[0] < 300:
        return
    _last_prune[0] = now
    for key in list(_hits.keys()):
        dq = _hits[key]
        while dq and now - dq[0] > 3600:
            dq.popleft()
        if not dq:
            del _hits[key]


async def _consume_persistent_ip_limit(ip: str, prefix: str, limit: int,
                                       window: int, now: float) -> bool:
    """Return false when this IP/path bucket has exhausted its allowance."""
    bucket = int(now) // window
    subject = hashlib.sha256(ip.encode('utf-8')).hexdigest()
    key = f'ip:{prefix}:{subject}:{bucket}'
    try:
        await db.auth_rate_limits.find_one_and_update(
            {'_id': key, 'count': {'$lt': limit}},
            {
                '$inc': {'count': 1},
                '$setOnInsert': {
                    'action': f'ip:{prefix}', 'subject_hash': subject,
                    'window_started_at': datetime.fromtimestamp(bucket * window, timezone.utc),
                    'expires_at': datetime.now(timezone.utc) + timedelta(seconds=window * 2),
                },
            },
            upsert=True,
        )
        return True
    except DuplicateKeyError:
        return False


class RateLimitMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        path = request.url.path
        rule = None
        for prefix, cfg in RATE_LIMITS.items():
            if path == prefix or path.startswith(prefix + '/'):
                rule = cfg
                break
        if rule is None:
            return await call_next(request)

        limit, window = rule
        now = time.time()
        key = f'{_client_ip(request)}|{prefix}'
        dq = _hits[key]
        while dq and now - dq[0] > window:
            dq.popleft()
        if len(dq) >= limit:
            retry = int(window - (now - dq[0])) + 1
            logger.warning(f'rate limit hit ip={_client_ip(request)} path={path}')
            return JSONResponse(
                status_code=429,
                content={'detail': 'Too many attempts. Please slow down and try again later.'},
                headers={'Retry-After': str(retry)},
            )
        try:
            allowed = await _consume_persistent_ip_limit(
                _client_ip(request), prefix, limit, window, now,
            )
        except Exception as exc:  # authentication controls fail closed
            logger.error('persistent auth rate limiter unavailable: %s', type(exc).__name__)
            return JSONResponse(
                status_code=503,
                content={'detail': {
                    'code': 'AUTH_TEMPORARILY_UNAVAILABLE',
                    'message': 'Authentication is temporarily unavailable.',
                }},
            )
        if not allowed:
            retry = window - (int(now) % window)
            logger.warning('persistent rate limit hit path=%s', path)
            return JSONResponse(
                status_code=429,
                content={'detail': 'Too many attempts. Please slow down and try again later.'},
                headers={'Retry-After': str(max(1, retry))},
            )
        dq.append(now)
        _prune(now)
        return await call_next(request)


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        resp = await call_next(request)
        resp.headers['X-Content-Type-Options'] = 'nosniff'
        resp.headers['X-Frame-Options'] = 'DENY'
        resp.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin'
        resp.headers['Permissions-Policy'] = 'geolocation=(), microphone=(), camera=()'
        resp.headers['Cross-Origin-Opener-Policy'] = 'same-origin'
        return resp
