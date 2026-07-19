"""FunGame API — play-chip-only amusement platform backend.

PLAY CHIPS — NO CASH VALUE. No payments, deposits, withdrawals or transfers exist.
"""
import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI, APIRouter
from starlette.middleware.cors import CORSMiddleware
import os

from db import client, db
from seed import run_seed
import routes_auth
import routes_player
import routes_admin

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await run_seed()
    logger.info('FunGame seed complete — 18 games, admin + test player ready')
    yield
    client.close()


app = FastAPI(title='FunGame API', version='1.0.0', lifespan=lifespan)

api_router = APIRouter(prefix='/api')


@api_router.get('/')
async def root():
    return {'message': 'FunGame API', 'disclaimer': 'PLAY CHIPS — NO CASH VALUE'}


@api_router.get('/health')
async def health():
    return {'status': 'ok'}


api_router.include_router(routes_auth.router)
api_router.include_router(routes_player.router)
api_router.include_router(routes_admin.router)
app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get('CORS_ORIGINS', '*').split(','),
    allow_methods=['*'],
    allow_headers=['*'],
)
