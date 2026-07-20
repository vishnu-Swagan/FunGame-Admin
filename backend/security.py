"""Security middleware: response headers + IP-based rate limiting on sensitive endpoints.

Rate limiting is in-memory (fine for a single Render instance). Keyed on the
real client IP taken from X-Forwarded-For (Render sits behind a proxy).
"""
import time
import logging
from collections import defaultdict, deque
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

logger = logging.getLogger(__name__)

# path prefix -> (max_requests, window_seconds). Only auth/abuse-prone routes.
RATE_LIMITS = {
    '/api/auth/login': (8, 300),               # 8 tries / 5 min — brute-force guard
    '/api/auth/forgot-password': (5, 900),     # 5 / 15 min
    '/api/auth/reset-password': (10, 900),
    '/api/auth/verify-email': (10, 900),
    '/api/auth/resend-verification': (5, 900),
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
