"""Idempotent system configuration seed data.

Only shared, non-account records belong in application startup.  Player and
administrator accounts are always provisioned through the live control plane;
startup must never create a usable login identity.
"""
import uuid
import logging
from datetime import datetime, timezone
from pymongo.errors import DuplicateKeyError
from db import db
from game_access import PLAYABLE_GAME_SLUGS, reconcile_game_availability
from otp_service import ensure_identity_indexes, ensure_indexes as ensure_otp_indexes

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
    {"slug": "chicken-road", "name": "Chicken Road", "category": "Crash", "tagline": "Cross the highway, cash out before the crash", "featured": True,
     "description": "Guide the chicken across a busy night highway. The multiplier climbs with every lane - cash out your play chips before a vehicle hits it.",
     "art": {"from": "#1a1206", "to": "#c98a1e", "accent": "#ffd447", "icon": "bird", "glyph": "4.8x"}},
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
    {"slug": "fun-roulette", "name": "American Roulette", "category": "Wheel", "tagline": "Double zero, one synchronized table", "featured": True,
     "description": "American double-zero roulette with live synchronized rounds, neighbour bets, inside bets and classic outside chances.",
     "art": {"from": "#101f12", "to": "#1f7a33", "accent": "#4ade80", "icon": "circle-dot", "glyph": "00"}},
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
     "description": "Choose up to 10 numbers from 36 in one synchronized live draw. The more you match, the more play chips you win.",
     "art": {"from": "#52001f", "to": "#be0045", "accent": "#ff9a1e", "icon": "hash", "glyph": "36"}},
    {"slug": "pappu-pictures", "name": "Pappu Pictures", "category": "Pictures", "tagline": "Pick a picture, reveal the winner", "featured": True,
     "description": "Choose from twelve colourful pictures and watch one shared live card reveal. Extra Pay rounds can boost the winning picture up to 200x.",
     "art": {"from": "#004b31", "to": "#00a466", "accent": "#ffe34b", "icon": "images", "glyph": "12"}},
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
     "description": "A 53-segment virtual-chip prize wheel with three cinematic fish bonus games. Choose the leaves for instant chip awards, or hook Lil' Blues, Big Oranges and Huge Reds for multipliers up to 5000x.",
     "art": {"from": "#0a2a44", "to": "#4aa3d9", "accent": "#bfe6ff", "icon": "fish", "glyph": "\u2744"}},
    {"slug": "blackjack", "name": "Blackjack", "category": "Cards", "tagline": "Hit, stand, beat the dealer", "featured": True,
     "description": "First Person Blackjack \u2014 up to 5 hands, Perfect Pairs & 21+3 side options, insurance, and blackjack awards 3:2 in virtual chips.",
     "art": {"from": "#08331a", "to": "#1d8a4f", "accent": "#ffd447", "icon": "spade", "glyph": "A\u2660"}},
    {"slug": "rummy", "name": "Rummy", "category": "Cards", "tagline": "Five seats, thirteen cards, one royal table", "featured": True,
     "description": "Server-authoritative Indian 13-card Rummy for exactly five seats across five skill categories. Played exclusively with virtual chips.",
     "art": {"from": "#072f25", "to": "#0b6b4f", "accent": "#e3c06e", "icon": "layers", "glyph": "13"}},
]


async def enable_all_games_for_launch():
    """Compatibility name for the reviewed-game availability migration."""
    result = await reconcile_game_availability()
    await db.announcements.update_one(
        {'title': 'Welcome to Chakri.Casino!'},
        {'$set': {'body': 'Chakri.Casino is a play-chip-only amusement platform. 11 reviewed games are approved and the rest of the catalogue is coming soon.'}},
    )
    await db.announcements.update_one(
        {'title': '18 games are on the way'},
        {'$set': {
            'title': '11 reviewed games are approved',
            'body': 'The reviewed set contains 11 games. Operators may keep any game visible as Coming Soon.',
        }},
    )
    await db.announcements.update_one(
        {'title': 'All 20 games are live'},
        {'$set': {
            'title': '11 reviewed games are approved',
            'body': 'The reviewed set contains 11 games. Operators may keep any game visible as Coming Soon.',
        }},
    )
    logger.info(
        'Reviewed game availability reconciled: %s enabled, %s coming soon',
        result['enabled'], result['coming_soon'],
    )
    return result['enabled'] + result['coming_soon']

ANNOUNCEMENTS = [
    {"title": "Welcome to Chakri.Casino!", "body": "Chakri.Casino is a play-chip-only amusement platform. 11 reviewed games are approved and the rest of the catalogue is coming soon.", "pinned": True},
    {"title": "11 reviewed games are approved", "body": "The reviewed set contains 11 games. Operators may keep any game visible as Coming Soon.", "pinned": False},
    {"title": "How play chips work", "body": "Play chips cannot be purchased, redeemed or transferred. Request chips from your Chips wallet and an operator will review your request.", "pinned": False},
]


async def run_seed():
    now = datetime.now(timezone.utc).isoformat()

    # Unique guards must exist before any insert so concurrent seeders can't
    # create duplicates (they'll hit the index and no-op instead).
    await db.system_config.create_index('key', unique=True)

    # System config
    if not await db.system_config.find_one({'key': 'main'}):
        await _safe_insert(db.system_config.insert_one({
            'key': 'main', 'maintenance_mode': False,
            'maintenance_message': 'Chakri.Casino is under scheduled maintenance. Please check back soon.',
            'min_client_version': '1.0.0', 'updated_at': now,
        }))

    # Games — the complete implemented catalogue
    await db.games.create_index('slug', unique=True)
    count = await db.games.count_documents({})
    if count == 0:
        docs = []
        for i, g in enumerate(GAMES):
            docs.append({
                'id': str(uuid.uuid4()), 'slug': g['slug'], 'name': g['name'],
                'category': g['category'], 'tagline': g['tagline'], 'description': g['description'],
                'status': 'ENABLED' if g['slug'] in PLAYABLE_GAME_SLUGS else 'COMING_SOON',
                'featured': g['featured'], 'art': g['art'], 'order': i,
                'created_at': now,
            })
        try:
            await db.games.insert_many(docs, ordered=False)
        except Exception as e:
            logger.info(f'games seed race (ok): {e}')

    # Games added after the initial seed — ensure they exist and are playable on
    # already-seeded databases (idempotent; won't clobber later edits).
    for slug, order in (('ice-fishing', 99), ('blackjack', 100), ('pappu-pictures', 101), ('rummy', 102), ('chicken-road', 103)):
        gm = next((g for g in GAMES if g['slug'] == slug), None)
        if gm:
            await db.games.update_one(
                {'slug': slug},
                {'$setOnInsert': {
                    'id': str(uuid.uuid4()), 'slug': slug, 'name': gm['name'],
                    'category': gm['category'], 'tagline': gm['tagline'], 'description': gm['description'],
                    'status': 'ENABLED' if slug in PLAYABLE_GAME_SLUGS else 'COMING_SOON',
                    'featured': gm['featured'], 'art': gm['art'], 'order': order,
                    'created_at': now,
                }},
                upsert=True,
            )

    # Narrow exact-copy migrations update only the two historical public
    # descriptions that implied real-money play. Operator-authored edits are
    # deliberately left untouched.
    await db.games.update_one(
        {
            'slug': 'ice-fishing',
            'description': "A 53-segment money wheel with three cinematic fish bonus games. Bet the leaves for instant pays, or hook Lil' Blues, Big Oranges and Huge Reds for multipliers up to 5000x.",
        },
        {'$set': {'description': next(
            game['description'] for game in GAMES if game['slug'] == 'ice-fishing'
        )}},
    )
    await db.games.update_one(
        {
            'slug': 'blackjack',
            'description': 'First Person Blackjack \u2014 up to 5 hands, Perfect Pairs & 21+3 side bets, insurance, blackjack pays 3:2. Real casino rules.',
        },
        {'$set': {'description': next(
            game['description'] for game in GAMES if game['slug'] == 'blackjack'
        )}},
    )

    # Enforce the immutable reviewed set before optional copy/index maintenance.
    # This also marks the superseded broad migrations complete before server.py
    # considers them, even if a later nonessential seed operation fails.
    await reconcile_game_availability()

    # Upgrade the original catalogue title without overwriting an operator's
    # later custom name. The slug stays stable because live bets, history and
    # admin reporting already use it as their durable game identifier.
    await db.games.update_one(
        {'slug': 'fun-roulette', 'name': 'Fun Roulette'},
        {'$set': {
            'name': 'American Roulette',
            'tagline': 'Double zero, one synchronized table',
            'description': 'American double-zero roulette with live synchronized rounds, neighbour bets, inside bets and classic outside chances.',
            'art.glyph': '00',
        }},
    )

    # Migrate the original 80-ball catalogue copy to the live 36-ball cabinet.
    # The narrow predicate preserves any later operator-authored description.
    await db.games.update_one(
        {
            'slug': 'keno',
            'description': 'Choose up to 10 numbers from 80. The more you match, the more play chips you win.',
        },
        {'$set': {
            'description': 'Choose up to 10 numbers from 36 in one synchronized live draw. The more you match, the more play chips you win.',
            'art.from': '#52001f',
            'art.to': '#be0045',
            'art.accent': '#ff9a1e',
            'art.glyph': '36',
        }},
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

    # Replace stale broad-launch copy without deleting operator announcements.
    await db.announcements.update_one(
        {'title': 'All 20 games are live'},
        {'$set': {
            'title': '11 reviewed games are approved',
            'body': 'The reviewed set contains 11 games. Operators may keep any game visible as Coming Soon.',
        }},
    )
    await db.announcements.update_one(
        {'title': 'Welcome to Chakri.Casino!', 'body': {'$regex': 'live games'}},
        {'$set': {'body': 'Chakri.Casino is a play-chip-only amusement platform. 11 reviewed games are approved and the rest of the catalogue is coming soon.'}},
    )

    # Indexes (idempotent)
    await db.users.create_index('email', unique=True)
    await db.users.create_index('id')
    await db.users.create_index('username')  # fast Login-ID lookups / uniqueness checks
    await db.games.create_index('slug', unique=True)
    await db.chip_transactions.create_index([('user_id', 1), ('created_at', -1)])
    await db.chip_requests.create_index([('user_id', 1), ('created_at', -1)])
    await db.notifications.create_index([('user_id', 1), ('created_at', -1)])
    await ensure_identity_indexes()
    await ensure_otp_indexes()
