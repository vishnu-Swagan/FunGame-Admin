#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
supabase_dir=$(dirname -- "$script_dir")
repo_dir=$(dirname -- "$supabase_dir")
functions_dir="$supabase_dir/functions"
config_file="$supabase_dir/config.toml"
archive_dir="$repo_dir/archive/decommissioned-supabase-functions/migration-import"

fail() {
  printf 'Supabase function-surface check failed: %s\n' "$1" >&2
  exit 1
}

[ ! -e "$functions_dir/migration-import" ] || \
  fail 'migration-import is present in the deployable function tree'

if grep -Eq '^\[functions\.migration-import\][[:space:]]*$' "$config_file"; then
  fail 'migration-import still has a deployable config block'
fi

[ -f "$archive_dir/index.ts" ] || \
  fail 'the decommissioned importer source is missing from the audit archive'

deployable_functions=$(
  find "$functions_dir" -mindepth 2 -maxdepth 2 -type f -name index.ts \
    -exec dirname {} \; |
    sed 's#.*/##' |
    LC_ALL=C sort |
    tr '\n' ' '
)

[ "$deployable_functions" = 'admin-api game-api ' ] || \
  fail "unexpected deployable entry points: ${deployable_functions:-none}"

printf 'Supabase function surface is restricted to admin-api and game-api.\n'
