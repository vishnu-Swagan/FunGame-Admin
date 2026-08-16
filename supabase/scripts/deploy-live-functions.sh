#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

"$script_dir/check-live-function-surface.sh"

supabase functions deploy admin-api "$@"
supabase functions deploy game-api "$@"
