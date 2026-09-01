#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap for Chakri.Casino (FastAPI + MongoDB + React).
# Safe to run repeatedly and against a cached/partially-prepared workspace.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

log() { printf '\n\033[1;34m[install]\033[0m %s\n' "$*"; }

# --- System dependencies (stable): MongoDB server + python venv tooling -------
# MongoDB is required because gameplay chip mutations run inside real Mongo
# transactions (single-node replica set below). Installed here so the binaries
# are captured in the environment build snapshot.
if ! command -v mongod >/dev/null 2>&1; then
  log "Installing MongoDB server (mongodb-org 8.0)"
  curl -fsSL https://pgp.mongodb.com/server-8.0.asc \
    | sudo gpg -o /usr/share/keyrings/mongodb-server-8.0.gpg --dearmor --yes
  echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/ubuntu noble/mongodb-org/8.0 multiverse" \
    | sudo tee /etc/apt/sources.list.d/mongodb-org-8.0.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq mongodb-org
else
  log "MongoDB already installed ($(mongod --version | head -1))"
fi

if ! python3 -c 'import venv, ensurepip' >/dev/null 2>&1; then
  log "Installing python3-venv"
  sudo apt-get update -qq
  sudo apt-get install -y -qq python3-venv
fi

# --- Backend: virtualenv + dependencies --------------------------------------
log "Setting up backend virtualenv + dependencies"
cd "$REPO_ROOT/backend"
if [ ! -x .venv/bin/python ]; then
  python3 -m venv .venv
fi
./.venv/bin/python -m pip install --quiet --upgrade pip
# requirements-test.txt includes runtime requirements plus the test toolchain.
./.venv/bin/python -m pip install --quiet -r requirements-test.txt

# --- Backend environment file (dev defaults; gitignored) ---------------------
if [ ! -f "$REPO_ROOT/backend/.env" ]; then
  log "Writing backend/.env (local dev defaults; play-chip only)"
  cat > "$REPO_ROOT/backend/.env" <<EOF
MONGO_URL=mongodb://127.0.0.1:27017/?replicaSet=rs0
DB_NAME=fungame
JWT_SECRET=$(openssl rand -hex 32)
CORS_ORIGINS=*
AVIATOR_RETURN_FACTOR=0.95
APP_ENV=development
OTP_PEPPER=$(openssl rand -hex 24)
REGISTRATION_MODE=ADMIN_REVIEW
OTP_EMAIL_ADAPTER=disabled
OTP_SMS_ADAPTER=disabled
OTP_EXPOSE_DEV_CODE=true
EMAIL_PROVIDER=disabled
REAL_MONEY_ENABLED=false
DEPOSITS_ENABLED=false
WITHDRAWALS_ENABLED=false
AUTO_WITHDRAWALS_ENABLED=false
FINANCIAL_GAME_WALLET_INTEGRATED=false
LEGACY_CHIP_REQUESTS_ENABLED=false
PAYMENTS_V2_ENABLED=false
PAYMENT_GATEWAY_ADMIN_ENABLED=false
PAYMENT_LIVE_MODE_ALLOWED=false
EOF
else
  log "backend/.env already present; leaving as-is"
fi

# --- Frontend: dependencies + Aviator sub-app build --------------------------
log "Installing frontend dependencies (yarn)"
cd "$REPO_ROOT/frontend"
if [ ! -f "$REPO_ROOT/frontend/.env" ]; then
  log "Writing frontend/.env (points the SPA at the local API)"
  cat > "$REPO_ROOT/frontend/.env" <<'EOF'
REACT_APP_BACKEND_URL=http://localhost:8000
PORT=3000
HOST=0.0.0.0
DANGEROUSLY_DISABLE_HOST_CHECK=true
WDS_SOCKET_PORT=0
EOF
fi
yarn install --frozen-lockfile
# The embedded Aviator app is a separate build that bakes its API origin from
# REACT_APP_BACKEND_URL at build time (see aviator-reference/src/config.ts).
# It reads env from its own directory, so give it an .env.local pointing at the
# local API; otherwise the in-iframe game falls back to window.location.origin
# (:3000, no /api) and never receives live round updates.
DEV_BACKEND_URL="$(grep -E '^REACT_APP_BACKEND_URL=' "$REPO_ROOT/frontend/.env" | head -1 | cut -d= -f2-)"
DEV_BACKEND_URL="${DEV_BACKEND_URL:-http://localhost:8000}"
printf 'REACT_APP_BACKEND_URL=%s\n' "$DEV_BACKEND_URL" > "$REPO_ROOT/frontend/aviator-reference/.env.local"
# Build the embedded Aviator reference app once here so per-boot startup does
# not need to reinstall/rebuild it (output: frontend/public/aviator-live).
log "Building Aviator reference sub-app (API origin: $DEV_BACKEND_URL)"
REACT_APP_BACKEND_URL="$DEV_BACKEND_URL" yarn build:aviator

log "Install complete."
