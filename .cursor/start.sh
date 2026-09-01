#!/usr/bin/env bash
# Per-boot runtime reconciliation: bring up MongoDB as a single-node replica set
# (transactions are a hard requirement for chip gameplay). Idempotent and
# tolerant of restarts; returns once the database is ready.
set -euo pipefail

log() { printf '\n\033[1;32m[start]\033[0m %s\n' "$*"; }

DBPATH=/var/lib/mongodb-rs
LOGPATH=/var/log/mongodb/mongod.log

sudo mkdir -p "$DBPATH" "$(dirname "$LOGPATH")"
sudo chown -R "$(whoami)":"$(whoami)" "$DBPATH" "$(dirname "$LOGPATH")"

# Start mongod only if it is not already answering on the port.
if mongosh --quiet --host 127.0.0.1 --port 27017 --eval 'db.runCommand({ping:1})' >/dev/null 2>&1; then
  log "mongod already running on 127.0.0.1:27017"
else
  log "Starting mongod (replica set rs0)"
  mongod --dbpath "$DBPATH" --replSet rs0 --bind_ip 127.0.0.1 --port 27017 \
    --logpath "$LOGPATH" --fork
fi

# Wait for the server to accept connections.
for _ in $(seq 1 30); do
  if mongosh --quiet --eval 'db.runCommand({ping:1})' >/dev/null 2>&1; then break; fi
  sleep 1
done

# Initiate the replica set once; ignore "already initialized".
if ! mongosh --quiet --eval 'rs.status().ok' >/dev/null 2>&1; then
  log "Initiating replica set rs0"
  mongosh --quiet --eval 'rs.initiate({_id:"rs0", members:[{_id:0, host:"127.0.0.1:27017"}]})' || true
fi

# Wait until a primary is elected (transactions require it).
for _ in $(seq 1 30); do
  state=$(mongosh --quiet --eval 'try { rs.status().myState } catch(e){ 0 }' 2>/dev/null || echo 0)
  if [ "$state" = "1" ]; then
    log "Replica set primary is ready"
    break
  fi
  sleep 1
done

log "MongoDB is ready."
