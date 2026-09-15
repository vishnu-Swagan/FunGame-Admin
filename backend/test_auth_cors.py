"""The deployed CORS policy exposes OTP retry timing, not sensitive headers."""
import ast
from pathlib import Path
import unittest

import httpx
from fastapi import FastAPI
from starlette.middleware.cors import CORSMiddleware
from starlette.responses import JSONResponse


class AuthRetryCorsTests(unittest.IsolatedAsyncioTestCase):
    def app(self):
        source = ast.parse(Path(__file__).with_name('server.py').read_text())
        middleware = next(node for node in ast.walk(source)
                          if isinstance(node, ast.Call)
                          and isinstance(node.func, ast.Attribute)
                          and node.func.attr == 'add_middleware'
                          and node.args and isinstance(node.args[0], ast.Name)
                          and node.args[0].id == 'CORSMiddleware')
        exposed = next(ast.literal_eval(item.value) for item in middleware.keywords
                       if item.arg == 'expose_headers')
        self.assertEqual(exposed, ['Retry-After'])
        app = FastAPI()

        @app.post('/api/auth/resend-otp')
        async def limited():
            return JSONResponse({'detail': {'code': 'RATE_LIMITED'}},
                                status_code=429, headers={'Retry-After': '1800'})

        app.add_middleware(CORSMiddleware, allow_origins=['https://chakri.casino'],
                           allow_methods=['*'], allow_headers=['*'], expose_headers=exposed)
        return app

    async def test_signup_origin_can_read_real_cooldown(self):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app()),
                                    base_url='https://api.chakri.casino') as client:
            response = await client.post('/api/auth/resend-otp',
                                         headers={'Origin': 'https://chakri.casino'})
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.headers['retry-after'], '1800')
        self.assertEqual(response.headers['access-control-allow-origin'], 'https://chakri.casino')
        self.assertEqual(response.headers['access-control-expose-headers'], 'Retry-After')

    async def test_untrusted_origin_is_not_granted_access(self):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app()),
                                    base_url='https://api.chakri.casino') as client:
            response = await client.post('/api/auth/resend-otp',
                                         headers={'Origin': 'https://untrusted.example'})
        self.assertNotIn('access-control-allow-origin', response.headers)


if __name__ == '__main__':
    unittest.main()
