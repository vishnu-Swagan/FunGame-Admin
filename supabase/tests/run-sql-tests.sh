#!/usr/bin/env bash
# Apply every migration to a throwaway PostgreSQL cluster and run the SQL
# regression suites against it.
#
# Nothing here touches a remote Supabase project. The cluster is created in a
# temporary directory and destroyed on exit.
#
# Requires a local PostgreSQL 15+ (`brew install postgresql@17`).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@17/bin}"
PORT="${PGPORT_TEST:-55432}"
WORKDIR="$(mktemp -d)"

if [ ! -x "$PGBIN/initdb" ]; then
  echo "PostgreSQL not found at $PGBIN. Set PGBIN, or: brew install postgresql@17" >&2
  exit 1
fi
export PATH="$PGBIN:$PATH"

cleanup() {
  pg_ctl -D "$WORKDIR/pgdata" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

initdb -D "$WORKDIR/pgdata" -U postgres --auth=trust >/dev/null
pg_ctl -D "$WORKDIR/pgdata" \
  -o "-p $PORT -k $WORKDIR -c listen_addresses=''" \
  -l "$WORKDIR/pg.log" start >/dev/null
for _ in $(seq 1 20); do
  psql -h "$WORKDIR" -p "$PORT" -U postgres -tAc 'select 1' >/dev/null 2>&1 && break
  sleep 0.5
done

psql -h "$WORKDIR" -p "$PORT" -U postgres -q -c 'create database mydgp;'

# Supabase supplies the auth schema and the anon/authenticated/service_role
# roles. Stand in for just enough of them that the migrations apply unchanged.
psql -h "$WORKDIR" -p "$PORT" -U postgres -d mydgp -q -v ON_ERROR_STOP=1 <<'SQL'
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  created_at timestamptz not null default now()
);
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end $$;
SQL

echo "Applying migrations"
for migration in "$REPO_ROOT"/supabase/migrations/*.sql; do
  printf '  %-56s' "$(basename "$migration")"
  psql -h "$WORKDIR" -p "$PORT" -U postgres -d mydgp -q -v ON_ERROR_STOP=1 -f "$migration"
  echo 'ok'
done

# Re-applying the newest migrations must be a no-op; a migration that cannot be
# replayed cannot be safely retried against production.
echo "Verifying the newest migrations re-apply cleanly"
for migration in "$REPO_ROOT"/supabase/migrations/20260815*.sql; do
  printf '  %-56s' "$(basename "$migration")"
  psql -h "$WORKDIR" -p "$PORT" -U postgres -d mydgp -q -v ON_ERROR_STOP=1 -f "$migration"
  echo 'idempotent'
done

echo "Running SQL tests"
for suite in "$REPO_ROOT"/supabase/tests/*_test.sql; do
  echo "  $(basename "$suite")"
  psql -h "$WORKDIR" -p "$PORT" -U postgres -d mydgp -q -v ON_ERROR_STOP=1 -f "$suite"
done

echo "SQL tests passed"
