"""Idempotent seed data: admin user, test player, 18 games, announcements, system config."""
import uuid
import logging
from datetime import datetime, timezone
from pymongo.errors import DuplicateKeyError
from db import db
from auth_utils import hash_password

logger = logging.getLogger('seed')


async def _safe_insert(coro):
    """Insert that tolerates a concurrent worker/instance winning the race
    (multi-worker / horizontally-scaled startup) — a duplicate is a no-op."""
    try:
        await coro
    except DuplicateKeyError:
        pass

GAMES = [
    {"slug": "aviator", "name": "Aviator", "category": "Crash", "tagline": "Fly high, ride the multiplier", "featured": True,
     "description": "Watch the plane climb and lock in your play chips before it flies away. The longer it flies, the higher the multiplier.",
     "art": {"from": "#0d1b3e", "to": "#e0353f", "accent": "#ff5964", "icon": "plane", "glyph": "2.4x"}},
    {"slug": "seven-up-down", "name": "Seven-Up-Down", "category": "Dice", "tagline": "Above, below or lucky seven", "featured": False,
     "description": "Two dice roll. Will the total land above seven, below seven, or exactly on the lucky number?",
     "art": {"from": "#123227", "to": "#0b8457", "accent": "#28e0a5", "icon": "dices", "glyph": "7"}},
    {"slug": "andar-bahar", "name": "Andar Bahar", "category": "Cards", "tagline": "The classic Indian card duel", "featured": True,
     "description": "A joker card is drawn. Bet on Andar or Bahar — which side will the matching card appear on first?",
     "art": {"from": "#3d0f24", "to": "#a11d4b", "accent": "#ff6b9d", "icon": "layers", "glyph": "A\u2660"}},
    {"slug": "bingo", "name": "Bingo", "category": "Numbers", "tagline": "Daub your way to full house", "featured": False,
     "description": "Mark the called numbers on your card. Lines, corners and full house all pay in play chips.",
     "art": {"from": "#1a1440", "to": "#5b3bd1", "accent": "#9d7bff", "icon": "grid-3x3", "glyph": "B7"}},
    {"slug": "checker", "name": "Checker", "category": "Board", "tagline": "Classic strategy, chip rewards", "featured": False,
     "description": "The timeless board game reimagined. Outsmart your opponent to win play-chip pots.",
     "art": {"from": "#26160a", "to": "#8a5a2b", "accent": "#e0aa5f", "icon": "crown", "glyph": "\u26c1"}},
    {"slug": "champion-poker", "name": "Champion Poker", "category": "Cards", "tagline": "Hold the winning hand", "featured": False,
     "description": "Five-card video poker with champion payouts. Jacks or better starts the win ladder.",
     "art": {"from": "#0c2231", "to": "#186a8c", "accent": "#3ec6e8", "icon": "trophy", "glyph": "K\u2665"}},
    {"slug": "fever-joker-bonus", "name": "Fever Joker Bonus", "category": "Slots", "tagline": "Feverish spins, joker wilds", "featured": False,
     "description": "A hot three-reel slot where the Joker substitutes everything and triggers fever bonus rounds.",
     "art": {"from": "#33091c", "to": "#c2185b", "accent": "#ff4f9a", "icon": "flame", "glyph": "JKR"}},
    {"slug": "fun-roulette", "name": "Fun Roulette", "category": "Wheel", "tagline": "Spin the wheel of fortune", "featured": True,
     "description": "European-style roulette with play chips. Straight, split, corner and colour bets.",
     "art": {"from": "#101f12", "to": "#1f7a33", "accent": "#4ade80", "icon": "circle-dot", "glyph": "17"}},
    {"slug": "fun-target", "name": "Fun Target", "category": "Numbers", "tagline": "Hit the target number", "featured": False,
     "description": "Pick a number from 0 to 9 and watch the wheel. Direct hits pay big in play chips.",
     "art": {"from": "#2b0d0d", "to": "#b23b3b", "accent": "#ff7b7b", "icon": "target", "glyph": "9"}},
    {"slug": "giant-jackpot", "name": "Giant Jackpot", "category": "Slots", "tagline": "Colossal reels, giant wins", "featured": True,
     "description": "A towering five-reel slot with cascading symbols and a giant progressive play-chip jackpot.",
     "art": {"from": "#241a03", "to": "#a97d0b", "accent": "#ffd447", "icon": "gem", "glyph": "777"}},
    {"slug": "joker-bonus", "name": "Joker Bonus", "category": "Slots", "tagline": "The joker pays the bonus", "featured": False,
     "description": "Classic fruit-style reels where collecting jokers unlocks the bonus wheel.",
     "art": {"from": "#1f0a33", "to": "#7b2fbe", "accent": "#c084fc", "icon": "sparkles", "glyph": "J"}},
    {"slug": "keno", "name": "Keno", "category": "Numbers", "tagline": "Pick your lucky numbers", "featured": False,
     "description": "Choose up to 10 numbers from 80. The more you match, the more play chips you win.",
     "art": {"from": "#0a1e2e", "to": "#20639b", "accent": "#5ab9ea", "icon": "hash", "glyph": "80"}},
    {"slug": "lucky-8-line", "name": "Lucky 8 Line", "category": "Slots", "tagline": "Eight lines of fortune", "featured": False,
     "description": "A retro 8-line slot with lucky red eights and golden ingots across three reels.",
     "art": {"from": "#330b0b", "to": "#c0392b", "accent": "#ffb347", "icon": "infinity", "glyph": "8"}},
    {"slug": "no-hold", "name": "No Hold", "category": "Cards", "tagline": "Fast poker, no holding back", "featured": False,
     "description": "Rapid-fire draw poker — no holds, straight deals, instant play-chip results.",
     "art": {"from": "#0f2419", "to": "#2e8b57", "accent": "#66d9a3", "icon": "zap", "glyph": "Q\u2663"}},
    {"slug": "super-golden-wheel", "name": "Super Golden Wheel", "category": "Wheel", "tagline": "Golden spins, super rewards", "featured": False,
     "description": "Spin the gleaming golden wheel across three reward tiers of play chips.",
     "art": {"from": "#2b2005", "to": "#c9a227", "accent": "#ffe08a", "icon": "sun", "glyph": "\u2726"}},
    {"slug": "triple-fun", "name": "Triple Fun", "category": "Slots", "tagline": "Triple reels, triple fun", "featured": False,
     "description": "Three synced reel sets spinning together — triple the chances every spin.",
     "art": {"from": "#131342", "to": "#4646c8", "accent": "#8f8fff", "icon": "boxes", "glyph": "x3"}},
    {"slug": "poker", "name": "Poker", "category": "Cards", "tagline": "The timeless table classic", "featured": False,
     "description": "Texas-style table poker with play chips. Blinds, raises and showdowns.",
     "art": {"from": "#101820", "to": "#37475a", "accent": "#8fa9c4", "icon": "spade", "glyph": "10\u2660"}},
    {"slug": "teen-patti", "name": "Teen Patti", "category": "Cards", "tagline": "Three cards, boot and blind", "featured": True,
     "description": "The beloved three-card game. Boot, blind, chaal and show — all in play chips.",
     "art": {"from": "#3a1206", "to": "#c05a12", "accent": "#ffa04d", "icon": "club", "glyph": "3\u2666"}},
    {"slug": "ice-fishing", "name": "Ice Fishing", "category": "Wheel", "tagline": "Spin the ice, reel the big catch", "featured": True,
     "description": "A 53-segment money wheel with three cinematic fish bonus games. Bet the leaves for instant pays, or hook Lil' Blues, Big Oranges and Huge Reds for multipliers up to 5000x.",
     "art": {"from": "#0a2a44", "to": "#4aa3d9", "accent": "#bfe6ff", "icon": "fish", "glyph": "\u2744"}},
]

ANNOUNCEMENTS = [
    {"title": "Welcome to FunGame!", "body": "FunGame is a play-chip-only amusement platform. Complete onboarding, get approved, and explore the lobby of 18 upcoming games.", "pinned": True},
    {"title": "18 games are on the way", "body": "Aviator, Teen Patti, Fun Roulette, Giant Jackpot and 14 more original games are in production. Watch this space — statuses update in real time from the server.", "pinned": False},
    {"title": "How play chips work", "body": "Play chips cannot be purchased, redeemed or transferred. Request chips from your Chips wallet and an operator will review your request.", "pinned": False},
]


async def run_seed():
    now = datetime.now(timezone.utc).isoformat()

    # Unique guards must exist before any insert so concurrent seeders can't
    # create duplicates (they'll hit the index and no-op instead).
    await db.system_config.create_index('key', unique=True)
    await db.users.create_index('email', unique=True)

    # System config
    if not await db.system_config.find_one({'key': 'main'}):
        await _safe_insert(db.system_config.insert_one({
            'key': 'main', 'maintenance_mode': False,
            'maintenance_message': 'FunGame is under scheduled maintenance. Please check back soon.',
            'min_client_version': '1.0.0', 'updated_at': now,
        }))

    # Admin user
    if not await db.users.find_one({'email': 'admin@fungame.app'}):
        await _safe_insert(db.users.insert_one({
            'id': str(uuid.uuid4()), 'email': 'admin@fungame.app',
            'password_hash': hash_password('FunGame@Admin2025'),
            'role': 'ADMIN', 'status': 'ACTIVE', 'email_verified': True,
            'display_name': 'FunGame Operator', 'country': 'India', 'avatar': 'crown',
            'chip_balance': 0, 'favorites': [], 'recent_games': [],
            'settings': {'sound_enabled': True, 'music_enabled': True, 'haptics_enabled': True, 'reduced_motion': False, 'high_contrast': False},
            'created_at': now,
        }))

    # Pre-approved test player
    if not await db.users.find_one({'email': 'player@fungame.app'}):
        pid = str(uuid.uuid4())
        await _safe_insert(db.users.insert_one({
            'id': pid, 'email': 'player@fungame.app',
            'password_hash': hash_password('Player@123'),
            'role': 'PLAYER', 'status': 'ACTIVE', 'email_verified': True,
            'display_name': 'Lucky Tester', 'country': 'India', 'avatar': 'star',
            'chip_balance': 5000, 'favorites': ['aviator', 'teen-patti'], 'recent_games': [],
            'settings': {'sound_enabled': True, 'music_enabled': True, 'haptics_enabled': True, 'reduced_motion': False, 'high_contrast': False},
            'created_at': now,
        }))
        await _safe_insert(db.chip_transactions.insert_one({
            'id': str(uuid.uuid4()), 'user_id': pid, 'type': 'CREDIT', 'amount': 5000,
            'balance_after': 5000, 'note': 'Welcome play chips (seed)', 'ref': None, 'created_at': now,
        }))

    # Games — exactly 18
    await db.games.create_index('slug', unique=True)
    count = await db.games.count_documents({})
    if count == 0:
        docs = []
        for i, g in enumerate(GAMES):
            docs.append({
                'id': str(uuid.uuid4()), 'slug': g['slug'], 'name': g['name'],
                'category': g['category'], 'tagline': g['tagline'], 'description': g['description'],
                'status': 'COMING_SOON', 'featured': g['featured'], 'art': g['art'], 'order': i,
                'created_at': now,
            })
        try:
            await db.games.insert_many(docs, ordered=False)
        except Exception as e:
            logger.info(f'games seed race (ok): {e}')

    # Ice Fishing was added after the initial seed — ensure it exists and is
    # playable on already-seeded databases (idempotent; won't clobber edits).
    ice = next((g for g in GAMES if g['slug'] == 'ice-fishing'), None)
    if ice:
        await db.games.update_one(
            {'slug': 'ice-fishing'},
            {'$setOnInsert': {
                'id': str(uuid.uuid4()), 'slug': 'ice-fishing', 'name': ice['name'],
                'category': ice['category'], 'tagline': ice['tagline'], 'description': ice['description'],
                'status': 'ENABLED', 'featured': ice['featured'], 'art': ice['art'], 'order': 99,
                'created_at': now,
            }},
            upsert=True,
        )

    # Announcements
    if await db.announcements.count_documents({}) == 0:
        docs = []
        for a in ANNOUNCEMENTS:
            docs.append({
                'id': str(uuid.uuid4()), 'title': a['title'], 'body': a['body'],
                'pinned': a['pinned'], 'active': True, 'created_by': 'system', 'created_at': now,
            })
        try:
            await db.announcements.insert_many(docs, ordered=False)
        except Exception as e:
            logger.info(f'announcements seed race (ok): {e}')

    # Indexes (idempotent)
    await db.users.create_index('email', unique=True)
    await db.users.create_index('id')
    await db.users.create_index('username')  # fast Login-ID lookups / uniqueness checks
    await db.games.create_index('slug', unique=True)
    await db.chip_transactions.create_index([('user_id', 1), ('created_at', -1)])
    await db.chip_requests.create_index([('user_id', 1), ('created_at', -1)])
    await db.notifications.create_index([('user_id', 1), ('created_at', -1)])
