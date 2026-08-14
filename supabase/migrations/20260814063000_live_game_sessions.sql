-- MyDGP live-game session foundation
--
-- This schema is deliberately separate from the legacy Mongo game service and
-- from the administrator API.  Supabase remains the sole player identity and
-- virtual-play-points authority.  No browser, Unity client, or anonymous role
-- receives table/RPC access; the player-facing Edge function authenticates a
-- Supabase JWT and uses these server-only procedures.
--
-- IMPORTANT: every runtime is seeded DISABLED.  A game cannot be opened until
-- an operator has independently confirmed the client-rule parity and promoted
-- its runtime configuration to QA_VERIFIED + ENABLED.  This avoids silently
-- replacing an unknown client rule with a plausible rule.

create type public.game_runtime_mode as enum ('CLOCKED_SHARED', 'PLAYER_PACED');
create type public.game_parity_state as enum ('BLOCKED', 'DERIVED', 'QA_VERIFIED');
create type public.game_runtime_availability as enum ('DISABLED', 'MAINTENANCE', 'ENABLED');
create type public.game_session_status as enum ('ACTIVE', 'CLOSED', 'EXPIRED');
create type public.game_round_phase as enum ('BETTING', 'REVEAL', 'RESULT', 'SETTLED', 'VOID');
create type public.game_wager_status as enum ('OPEN', 'REFUNDED', 'CANCELLED', 'SETTLED', 'VOID');
create type public.game_action_kind as enum (
  'STAKE', 'CLEAR', 'UNDO', 'REPEAT', 'COLLECT', 'DEAL', 'SET_HOLD',
  'CASH_OUT', 'GAMBLE', 'SETTLE'
);
create type public.game_action_status as enum ('APPLIED', 'REJECTED');

-- One authoritative translation table prevents the catalog, lobby tile,
-- Unity scene and engine identifiers from drifting apart.  `timing` uses a
-- documented wire shape:
--   { kind, bet_seconds, lock_seconds, reveal_seconds, result_seconds }
-- Player-paced cabinets deliberately have null timing values instead of a
-- fabricated countdown.
create table public.game_runtime_catalog (
  catalog_slug text primary key references public.games(slug) on delete restrict,
  unity_lobby_slug text not null unique,
  unity_scene text not null,
  engine_slug text not null unique,
  runtime_mode public.game_runtime_mode not null,
  parity_state public.game_parity_state not null default 'BLOCKED',
  availability public.game_runtime_availability not null default 'DISABLED',
  timing jsonb not null default '{}'::jsonb check (jsonb_typeof(timing) = 'object'),
  action_contract jsonb not null default '[]'::jsonb check (jsonb_typeof(action_contract) = 'array'),
  outcome_contract jsonb not null default '{}'::jsonb check (jsonb_typeof(outcome_contract) = 'object'),
  rule_source text not null,
  disabled_reason text,
  ruleset_version integer not null default 1 check (ruleset_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (availability <> 'ENABLED' or parity_state = 'QA_VERIFIED')
);

-- A session belongs to one authenticated player and one catalog game.  It has
-- no password, raw JWT, device fingerprint, privileged key, client balance or
-- client outcome.  The active-session uniqueness also gives retries a stable
-- server session rather than creating a new wallet context on every poll.
create table public.game_player_sessions (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.profiles(id) on delete restrict,
  catalog_slug text not null references public.game_runtime_catalog(catalog_slug) on delete restrict,
  engine_slug text not null,
  runtime_mode public.game_runtime_mode not null,
  ruleset_version integer not null check (ruleset_version > 0),
  status public.game_session_status not null default 'ACTIVE',
  state jsonb not null default '{}'::jsonb check (jsonb_typeof(state) = 'object'),
  opened_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  closed_at timestamptz,
  check ((status = 'ACTIVE' and closed_at is null) or (status <> 'ACTIVE' and closed_at is not null))
);

create unique index game_player_sessions_one_active_game
  on public.game_player_sessions(player_id, catalog_slug)
  where status = 'ACTIVE';
create index game_player_sessions_player_seen_idx
  on public.game_player_sessions(player_id, last_seen_at desc);

-- Clocked games share this row globally.  The Edge function decides an outcome
-- once using server randomness, commits its SHA-256 before the reveal, and
-- never accepts an outcome supplied by a player.  Player-paced games may use a
-- per-session round row with the same canonical shape once their exact rules
-- pass parity review.
create table public.game_rounds (
  id uuid primary key default gen_random_uuid(),
  catalog_slug text not null references public.game_runtime_catalog(catalog_slug) on delete restrict,
  engine_slug text not null,
  session_id uuid references public.game_player_sessions(id) on delete restrict,
  round_number bigint not null check (round_number >= 0),
  phase public.game_round_phase not null default 'BETTING',
  starts_at timestamptz not null,
  betting_closes_at timestamptz not null,
  reveal_starts_at timestamptz not null,
  result_starts_at timestamptz not null,
  ends_at timestamptz not null,
  outcome_commitment text not null check (outcome_commitment ~ '^[0-9a-f]{64}$'),
  outcome jsonb,
  outcome_source text not null default 'SERVER_RANDOM',
  outcome_published_at timestamptz,
  ruleset_version integer not null check (ruleset_version > 0),
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  check (starts_at <= betting_closes_at and betting_closes_at <= reveal_starts_at
         and reveal_starts_at <= result_starts_at and result_starts_at <= ends_at),
  check ((session_id is null) or (round_number >= 0))
);

-- Shared rounds have one result per catalog game and round number.  Player
-- paced rounds instead use their session id in the second unique index.
create unique index game_rounds_shared_number_idx
  on public.game_rounds(catalog_slug, round_number)
  where session_id is null;
create unique index game_rounds_session_number_idx
  on public.game_rounds(session_id, round_number)
  where session_id is not null;
create index game_rounds_catalog_timing_idx
  on public.game_rounds(catalog_slug, starts_at desc);

-- Every accepted player press is immutable and idempotent.  The request is an
-- intent (selection/stake/etc.); the result is written by server code only.
-- There is intentionally no `delta`, `balance_after` input, or client outcome.
create table public.game_actions (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.profiles(id) on delete restrict,
  session_id uuid not null references public.game_player_sessions(id) on delete restrict,
  round_id uuid references public.game_rounds(id) on delete restrict,
  catalog_slug text not null references public.game_runtime_catalog(catalog_slug) on delete restrict,
  kind public.game_action_kind not null,
  status public.game_action_status not null default 'APPLIED',
  idempotency_key text not null check (char_length(trim(idempotency_key)) between 8 and 160),
  request jsonb not null default '{}'::jsonb check (jsonb_typeof(request) = 'object'),
  result jsonb not null default '{}'::jsonb check (jsonb_typeof(result) = 'object'),
  reject_reason text,
  created_at timestamptz not null default now(),
  unique (player_id, idempotency_key)
);
create index game_actions_session_created_idx
  on public.game_actions(session_id, created_at desc);
create index game_actions_round_created_idx
  on public.game_actions(round_id, created_at asc);

-- A wager is not a mutable client balance.  Its stake/refund/prize receipts
-- reference the immutable play-point ledger, allowing reconciliation without
-- trusting UI state.
create table public.game_wagers (
  id uuid primary key default gen_random_uuid(),
  action_id uuid not null unique references public.game_actions(id) on delete restrict,
  player_id uuid not null references public.profiles(id) on delete restrict,
  session_id uuid not null references public.game_player_sessions(id) on delete restrict,
  round_id uuid not null references public.game_rounds(id) on delete restrict,
  catalog_slug text not null references public.game_runtime_catalog(catalog_slug) on delete restrict,
  selection text not null check (char_length(selection) between 1 and 160),
  amount bigint not null check (amount > 0),
  status public.game_wager_status not null default 'OPEN',
  stake_ledger_id uuid not null references public.play_point_ledger(id) on delete restrict,
  refund_action_id uuid references public.game_actions(id) on delete restrict,
  refund_ledger_id uuid references public.play_point_ledger(id) on delete restrict,
  settlement_action_id uuid unique references public.game_actions(id) on delete restrict,
  prize_ledger_id uuid references public.play_point_ledger(id) on delete restrict,
  payout bigint not null default 0 check (payout >= 0),
  outcome jsonb,
  placed_at timestamptz not null default now(),
  settled_at timestamptz,
  check (
    (status = 'OPEN' and refund_action_id is null and settlement_action_id is null)
    or status in ('REFUNDED', 'CANCELLED', 'SETTLED', 'VOID')
  )
);
create index game_wagers_player_round_status_idx
  on public.game_wagers(player_id, round_id, status);
create index game_wagers_round_status_idx
  on public.game_wagers(round_id, status);

-- This is the polling outbox.  Event IDs are globally monotonic so an Android
-- process may resume with `after_event_id` after a restart.  The server writes
-- events in the same transaction as an action/settlement; clients only read
-- their own rows through the Edge function.
create table public.game_event_outbox (
  event_id bigint generated always as identity primary key,
  player_id uuid references public.profiles(id) on delete restrict,
  session_id uuid references public.game_player_sessions(id) on delete restrict,
  round_id uuid references public.game_rounds(id) on delete restrict,
  action_id uuid references public.game_actions(id) on delete restrict,
  catalog_slug text not null references public.game_runtime_catalog(catalog_slug) on delete restrict,
  event_type text not null check (event_type ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now()
);
create index game_event_outbox_player_catalog_event_idx
  on public.game_event_outbox(player_id, catalog_slug, event_id);
create index game_event_outbox_round_event_idx
  on public.game_event_outbox(round_id, event_id);

-- One canonical row per externally visible cabinet.  All start disabled even
-- where a deterministic Unity engine exists: enabling requires an explicit
-- QA verification after screenshot/timing/rule parity review.
insert into public.game_runtime_catalog (
  catalog_slug, unity_lobby_slug, unity_scene, engine_slug, runtime_mode,
  parity_state, availability, timing, action_contract, outcome_contract,
  rule_source, disabled_reason
) values
  ('7up7down', 'seven-up-down', 'seven-up-down', 'seven-up-down', 'CLOCKED_SHARED',
   'DERIVED', 'DISABLED',
   '{"kind":"sides","bet_seconds":15,"lock_seconds":1,"reveal_seconds":15,"result_seconds":11,"idle_variant":{"reveal_seconds":0,"result_seconds":10},"hold_on_win":true}'::jsonb,
   '["place_bet","clear_bets","cancel_bet","repeat_bets","collect_full","collect_half"]'::jsonb,
   '{"type":"card_window","selection":"seven|up|down"}'::jsonb,
   'Unity Rounds.cs + SevenUpDown.cs',
   'Disabled pending shared-round review of the client''s player-specific idle cadence and hold-on-win collection timing.'),
  ('fun-ab', 'fun-ab', 'andar-bahar', 'andar-bahar', 'CLOCKED_SHARED',
   'BLOCKED', 'DISABLED',
   '{"kind":"sides","bet_seconds":36,"lock_seconds":6,"reveal_seconds":2,"result_seconds":5}'::jsonb,
   '["place_bet","clear_bets","cancel_bet","repeat_bets","collect_full","collect_half"]'::jsonb,
   '{"type":"andar_bahar","selection":"named side or rank"}'::jsonb,
   'Unity Rounds.cs + Tables.cs (AndarBahar)',
   'Side/rank payout evidence is incomplete; do not substitute inferred odds.'),
  ('triple-fun', 'triple-fun', 'triple-fun', 'triple-fun', 'CLOCKED_SHARED',
   'BLOCKED', 'DISABLED',
   '{"kind":"three_digits","bet_seconds":60,"lock_seconds":5,"reveal_seconds":5,"result_seconds":3}'::jsonb,
   '["place_bet","clear_bets","cancel_bet","repeat_bets","collect_full","collect_half"]'::jsonb,
   '{"type":"three_digit_draw","selection":"single:N|double:NN|triple:NNN"}'::jsonb,
   'Unity Tables.cs (TripleFun) + Rounds.cs',
   'Client round cadence is not recoverable from the source; do not enable on a guessed clock.'),
  ('fun-roulette', 'roulette', 'fun-roulette', 'fun-roulette', 'CLOCKED_SHARED',
   'DERIVED', 'DISABLED',
   '{"kind":"board","bet_seconds":45,"lock_seconds":11,"reveal_seconds":11,"result_seconds":4,"hold_on_win":true}'::jsonb,
   '["place_bet","clear_bets","cancel_bet","repeat_bets","collect_full","collect_half"]'::jsonb,
   '{"type":"american_roulette","pockets":38,"selection":"type:value"}'::jsonb,
   'Unity Roulette.cs + Rounds.cs + RouletteFeltTargets.cs',
   'Disabled pending QA: zero-end touch geometry and engine whitelist disagree for two physical split placements.'),
  ('fun-target', 'fun-target', 'fun-target', 'fun-target', 'CLOCKED_SHARED',
   'BLOCKED', 'DISABLED',
   '{"kind":"pick","bet_seconds":51,"lock_seconds":11,"reveal_seconds":5,"result_seconds":3}'::jsonb,
   '["place_bet","clear_bets","cancel_bet","repeat_bets","collect_full","collect_half"]'::jsonb,
   '{"type":"digit_wheel","selection":"number:0..9"}'::jsonb,
   'Unity Tables.cs (FunTarget) + Rounds.cs',
   'The client payout is explicitly unobserved; the Unity 9x value is an inference and cannot be promoted.'),
  ('bingo', 'bingo', 'bingo', 'bingo', 'CLOCKED_SHARED',
   'BLOCKED', 'DISABLED',
   '{"kind":"stake","bet_seconds":60,"lock_seconds":5,"reveal_seconds":6,"result_seconds":4}'::jsonb,
   '["place_bet","clear_bets","cancel_bet","repeat_bets","collect_full","collect_half"]'::jsonb,
   '{"type":"fixed_six_cards","draw_count":15}'::jsonb,
   'Unity Tables.cs (Bingo) + Rounds.cs',
   'Client payout evidence is incomplete; fixed cards/draw shape alone is insufficient to enable settlement.'),
  ('joker-bonus', 'joker-bonus', 'fever-joker', 'joker-bonus', 'PLAYER_PACED',
   'BLOCKED', 'DISABLED',
   '{"kind":"player_paced","bet_seconds":null,"lock_seconds":null,"reveal_seconds":4,"result_seconds":null}'::jsonb,
   '["place_bet","clear_bets","deal","hold","release","collect_full","collect_half","gamble"]'::jsonb,
   '{"type":"joker_poker"}'::jsonb,
   'Unity GameScenes.cs + ChampionTable.cs',
   'Double-up/hold settlement needs complete client-parity evidence.'),
  ('giant-jackpot', 'giant-jackpot', 'giant-jackpot', 'giant-jackpot', 'CLOCKED_SHARED',
   'BLOCKED', 'DISABLED',
   '{"kind":"stake","bet_seconds":60,"lock_seconds":5,"reveal_seconds":5,"result_seconds":3}'::jsonb,
   '["place_bet","clear_bets","cancel_bet","repeat_bets","collect_full","collect_half"]'::jsonb,
   '{"type":"four_window_ladder"}'::jsonb,
   'Unity GiantJackpotLadder.cs + Rounds.cs',
   'Client reel weights and payout scale/cap-row behavior are not fully known.'),
  ('golden-wheel', 'golden-wheel', 'super-golden-wheel', 'super-golden-wheel', 'CLOCKED_SHARED',
   'BLOCKED', 'DISABLED',
   '{"kind":"stake","bet_seconds":60,"lock_seconds":5,"reveal_seconds":5,"result_seconds":3}'::jsonb,
   '["place_bet","clear_bets","cancel_bet","repeat_bets","collect_full","collect_half"]'::jsonb,
   '{"type":"multiplier_wheel"}'::jsonb,
   'Unity Tables.cs (GoldenWheel) + Rounds.cs',
   'Segment weights/multiplier distribution have not been parity-confirmed against the client server.'),
  ('keno', 'keno', 'keno', 'keno', 'CLOCKED_SHARED',
   'BLOCKED', 'DISABLED',
   '{"kind":"picks","bet_seconds":60,"lock_seconds":5,"reveal_seconds":6,"result_seconds":4}'::jsonb,
   '["place_bet","clear_bets","cancel_bet","repeat_bets","collect_full","collect_half"]'::jsonb,
   '{"type":"keno","pool":80,"draw_count":20,"max_picks":10}'::jsonb,
   'Unity Tables.cs (Keno) + Rounds.cs',
   'Client paytable is explicitly unobserved; only board/draw validation may be derived.'),
  ('checker', 'checker', 'checker', 'checker', 'PLAYER_PACED',
   'DERIVED', 'DISABLED',
   '{"kind":"player_paced","bet_seconds":null,"lock_seconds":null,"reveal_seconds":6,"result_seconds":3}'::jsonb,
   '["place_bet","clear_bets","cancel_bet","deal","collect_full","collect_half","gamble"]'::jsonb,
   '{"type":"two_ring_checker","cells":25}'::jsonb,
   'Unity CheckerTable.cs + Tables.cs (Checker)',
   'Disabled pending QA of the client double-up branch; do not invent an ODD/EVEN result.'),
  ('lucky-8-line', 'lucky8line', 'lucky-8-line', 'lucky-8-line', 'CLOCKED_SHARED',
   'BLOCKED', 'DISABLED',
   '{"kind":"stake","bet_seconds":60,"lock_seconds":5,"reveal_seconds":5,"result_seconds":3}'::jsonb,
   '["place_bet","clear_bets","cancel_bet","repeat_bets","collect_full","collect_half"]'::jsonb,
   '{"type":"eight_line_reel"}'::jsonb,
   'Unity Reels.cs + Rounds.cs',
   'Reel weighting and payout parity require a client-server capture before launch.'),
  ('fever-joker-bonus', 'fever-joker', 'fever-joker-bonus', 'fever-joker-bonus', 'PLAYER_PACED',
   'BLOCKED', 'DISABLED',
   '{"kind":"player_paced","bet_seconds":null,"lock_seconds":null,"reveal_seconds":4,"result_seconds":null}'::jsonb,
   '["place_bet","clear_bets","deal","hold","release","collect_full","collect_half","gamble"]'::jsonb,
   '{"type":"joker_poker"}'::jsonb,
   'Unity GameScenes.cs + ChampionTable.cs',
   'Double-up/hold settlement needs complete client-parity evidence.'),
  ('no-hold', 'no-hold', 'no-hold', 'no-hold', 'PLAYER_PACED',
   'DERIVED', 'DISABLED',
   '{"kind":"player_paced","bet_seconds":null,"lock_seconds":null,"reveal_seconds":4,"result_seconds":null}'::jsonb,
   '["place_bet","clear_bets","deal","collect_full","collect_half"]'::jsonb,
   '{"type":"five_card_no_hold"}'::jsonb,
   'Unity ChampionTable.cs + SevenUpDown.cs (NoHold)',
   'Disabled pending independent gameplay/settlement capture.'),
  ('champion-poker', 'champion-poker', 'champion-poker', 'champion-poker', 'PLAYER_PACED',
   'BLOCKED', 'DISABLED',
   '{"kind":"player_paced","bet_seconds":null,"lock_seconds":null,"reveal_seconds":4,"result_seconds":null}'::jsonb,
   '["place_bet","clear_bets","deal","hold","release","collect_full","collect_half","gamble"]'::jsonb,
   '{"type":"five_card_draw_poker"}'::jsonb,
   'Unity ChampionTable.cs + SevenUpDown.cs (ChampionPoker)',
   'The client double-up outcome is unobserved; gameplay must remain closed until parity is complete.')
on conflict (catalog_slug) do update set
  unity_lobby_slug = excluded.unity_lobby_slug,
  unity_scene = excluded.unity_scene,
  engine_slug = excluded.engine_slug,
  runtime_mode = excluded.runtime_mode,
  timing = excluded.timing,
  action_contract = excluded.action_contract,
  outcome_contract = excluded.outcome_contract,
  rule_source = excluded.rule_source,
  disabled_reason = excluded.disabled_reason,
  updated_at = now();

create or replace function public.assert_game_player(p_player_id uuid)
returns public.profiles
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_player public.profiles;
begin
  select * into v_player from public.profiles
  where id = p_player_id and account_kind = 'PLAYER' and status = 'ACTIVE';
  if not found then
    raise exception 'Active player account required' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.exclusions e
    where e.player_id = p_player_id
      and e.status = 'ACTIVE'
      and (e.ends_at is null or e.ends_at > clock_timestamp())
  ) then
    raise exception 'Player gameplay is unavailable' using errcode = '42501';
  end if;
  return v_player;
end;
$$;

create or replace function public.assert_playable_game_runtime(
  p_player_id uuid,
  p_catalog_slug text
)
returns public.game_runtime_catalog
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_runtime public.game_runtime_catalog;
  v_maintenance boolean;
  v_game_status text;
begin
  perform public.assert_game_player(p_player_id);
  select maintenance_mode into v_maintenance from public.system_config where key = 'main';
  if coalesce(v_maintenance, true) then
    raise exception 'Game service is under maintenance' using errcode = '55000';
  end if;
  select * into v_runtime
  from public.game_runtime_catalog
  where catalog_slug = p_catalog_slug;
  if not found then
    raise exception 'Game runtime is not configured' using errcode = 'P0001';
  end if;
  select status into v_game_status from public.games where slug = p_catalog_slug;
  if v_game_status <> 'ENABLED'
     or v_runtime.availability <> 'ENABLED'
     or v_runtime.parity_state <> 'QA_VERIFIED' then
    raise exception 'Game runtime is not available' using errcode = '55000';
  end if;
  return v_runtime;
end;
$$;

create or replace function public.open_game_player_session(
  p_player_id uuid,
  p_catalog_slug text
)
returns public.game_player_sessions
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_runtime public.game_runtime_catalog;
  v_session public.game_player_sessions;
begin
  select * into v_runtime from public.assert_playable_game_runtime(p_player_id, p_catalog_slug);
  insert into public.game_player_sessions(
    player_id, catalog_slug, engine_slug, runtime_mode, ruleset_version, status
  ) values (
    p_player_id, v_runtime.catalog_slug, v_runtime.engine_slug, v_runtime.runtime_mode,
    v_runtime.ruleset_version, 'ACTIVE'
  )
  on conflict (player_id, catalog_slug) where status = 'ACTIVE'
  do update set last_seen_at = now(), ruleset_version = excluded.ruleset_version
  returning * into v_session;
  return v_session;
end;
$$;

create or replace function public.emit_game_event(
  p_player_id uuid,
  p_session_id uuid,
  p_round_id uuid,
  p_action_id uuid,
  p_catalog_slug text,
  p_event_type text,
  p_payload jsonb default '{}'::jsonb
)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_event_id bigint;
begin
  insert into public.game_event_outbox(
    player_id, session_id, round_id, action_id, catalog_slug, event_type, payload
  ) values (
    p_player_id, p_session_id, p_round_id, p_action_id, p_catalog_slug,
    p_event_type, coalesce(p_payload, '{}'::jsonb)
  ) returning event_id into v_event_id;
  return v_event_id;
end;
$$;

-- This atomic stake path is intentionally narrow.  Amount means a player
-- chosen stake only; it is converted to a negative ledger delta here.  The
-- outcome/payout never enters this function from a client request.
create or replace function public.submit_game_stake(
  p_player_id uuid,
  p_session_id uuid,
  p_round_id uuid,
  p_selection text,
  p_amount bigint,
  p_idempotency_key text,
  p_request jsonb default '{}'::jsonb
)
returns table(
  action_id uuid,
  wager_id uuid,
  balance_after bigint,
  duplicate boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_runtime public.game_runtime_catalog;
  v_session public.game_player_sessions;
  v_round public.game_rounds;
  v_existing public.game_actions;
  v_action_id uuid := gen_random_uuid();
  v_wager_id uuid := gen_random_uuid();
  v_ledger_id uuid;
  v_balance bigint;
  v_event_id bigint;
begin
  if coalesce(char_length(trim(p_idempotency_key)), 0) < 8 then
    raise exception 'Idempotency key is required' using errcode = '22023';
  end if;
  if p_amount < 1 or p_amount > 1000000 then
    raise exception 'Stake must be between 1 and 1000000 virtual play points' using errcode = '22023';
  end if;
  if coalesce(char_length(trim(p_selection)), 0) < 1 or char_length(trim(p_selection)) > 160 then
    raise exception 'Selection is invalid' using errcode = '22023';
  end if;

  select * into v_existing from public.game_actions
  where player_id = p_player_id and idempotency_key = trim(p_idempotency_key)
  for update;
  if found then
    if v_existing.kind <> 'STAKE' then
      raise exception 'Idempotency key was already used for a different action' using errcode = '22023';
    end if;
    select id into v_wager_id from public.game_wagers where action_id = v_existing.id;
    return query select v_existing.id, v_wager_id,
      coalesce((v_existing.result ->> 'balance_after')::bigint, 0), true;
    return;
  end if;

  select * into v_session from public.game_player_sessions
  where id = p_session_id and player_id = p_player_id and status = 'ACTIVE'
  for update;
  if not found then
    raise exception 'Active game session not found' using errcode = 'P0001';
  end if;
  select * into v_runtime from public.assert_playable_game_runtime(p_player_id, v_session.catalog_slug);
  select * into v_round from public.game_rounds
  where id = p_round_id and catalog_slug = v_session.catalog_slug
  for update;
  if not found then
    raise exception 'Round not found for this game session' using errcode = 'P0001';
  end if;
  if clock_timestamp() < v_round.starts_at or clock_timestamp() >= v_round.betting_closes_at then
    raise exception 'Bets are closed for this round' using errcode = '55000';
  end if;

  select ledger_id, balance_after into v_ledger_id, v_balance
  from public.apply_game_play_points(
    p_player_id, -p_amount, 'STAKE',
    'game-session-v1:' || v_action_id::text || ':stake',
    v_runtime.catalog_slug, v_round.id::text,
    'Server accepted game stake'
  );
  insert into public.game_actions(
    id, player_id, session_id, round_id, catalog_slug, kind, idempotency_key, request, result
  ) values (
    v_action_id, p_player_id, p_session_id, p_round_id, v_runtime.catalog_slug,
    'STAKE', trim(p_idempotency_key), coalesce(p_request, '{}'::jsonb),
    jsonb_build_object('balance_after', v_balance, 'ledger_id', v_ledger_id, 'selection', trim(p_selection), 'amount', p_amount)
  );
  insert into public.game_wagers(
    id, action_id, player_id, session_id, round_id, catalog_slug, selection, amount, stake_ledger_id
  ) values (
    v_wager_id, v_action_id, p_player_id, p_session_id, p_round_id,
    v_runtime.catalog_slug, trim(p_selection), p_amount, v_ledger_id
  );
  v_event_id := public.emit_game_event(
    p_player_id, p_session_id, p_round_id, v_action_id, v_runtime.catalog_slug,
    'BET_PLACED', jsonb_build_object('wager_id', v_wager_id, 'selection', trim(p_selection), 'amount', p_amount, 'balance_after', v_balance)
  );
  update public.game_player_sessions set last_seen_at = now() where id = p_session_id;
  return query select v_action_id, v_wager_id, v_balance, false;
end;
$$;

-- CLEAR and UNDO both refund only currently open wagers in the still-open
-- betting window.  The procedure creates one refund ledger entry per press,
-- not per row, and records exactly which wager ids were returned.
create or replace function public.refund_game_wagers(
  p_player_id uuid,
  p_session_id uuid,
  p_round_id uuid,
  p_kind public.game_action_kind,
  p_selection text,
  p_idempotency_key text,
  p_request jsonb default '{}'::jsonb
)
returns table(
  action_id uuid,
  refunded bigint,
  balance_after bigint,
  duplicate boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_runtime public.game_runtime_catalog;
  v_session public.game_player_sessions;
  v_round public.game_rounds;
  v_existing public.game_actions;
  v_action_id uuid := gen_random_uuid();
  v_ledger_id uuid;
  v_balance bigint;
  v_total bigint;
  v_wager_ids uuid[];
  v_event_type text;
begin
  if p_kind not in ('CLEAR', 'UNDO') then
    raise exception 'Only CLEAR and UNDO can refund open wagers' using errcode = '22023';
  end if;
  if coalesce(char_length(trim(p_idempotency_key)), 0) < 8 then
    raise exception 'Idempotency key is required' using errcode = '22023';
  end if;
  if p_kind = 'UNDO' and coalesce(char_length(trim(p_selection)), 0) < 1 then
    raise exception 'UNDO requires a selection' using errcode = '22023';
  end if;

  select * into v_existing from public.game_actions
  where player_id = p_player_id and idempotency_key = trim(p_idempotency_key)
  for update;
  if found then
    if v_existing.kind <> p_kind then
      raise exception 'Idempotency key was already used for a different action' using errcode = '22023';
    end if;
    return query select v_existing.id,
      coalesce((v_existing.result ->> 'refunded')::bigint, 0),
      coalesce((v_existing.result ->> 'balance_after')::bigint, 0), true;
    return;
  end if;

  select * into v_session from public.game_player_sessions
  where id = p_session_id and player_id = p_player_id and status = 'ACTIVE'
  for update;
  if not found then
    raise exception 'Active game session not found' using errcode = 'P0001';
  end if;
  select * into v_runtime from public.assert_playable_game_runtime(p_player_id, v_session.catalog_slug);
  select * into v_round from public.game_rounds
  where id = p_round_id and catalog_slug = v_session.catalog_slug
  for update;
  if not found then
    raise exception 'Round not found for this game session' using errcode = 'P0001';
  end if;
  if clock_timestamp() < v_round.starts_at or clock_timestamp() >= v_round.betting_closes_at then
    raise exception 'Bets are closed for this round' using errcode = '55000';
  end if;

  -- PostgreSQL does not permit FOR UPDATE directly on an aggregate query.
  -- Lock the eligible rows in the subquery, then aggregate that fixed set.
  select coalesce(sum(w.amount), 0), coalesce(array_agg(w.id), '{}'::uuid[])
  into v_total, v_wager_ids
  from (
    select id, amount
    from public.game_wagers
    where player_id = p_player_id and session_id = p_session_id and round_id = p_round_id
      and status = 'OPEN'
      and (p_kind = 'CLEAR' or selection = trim(p_selection))
    for update
  ) w;
  if v_total <= 0 then
    raise exception 'No open wager can be returned' using errcode = 'P0001';
  end if;

  select ledger_id, balance_after into v_ledger_id, v_balance
  from public.apply_game_play_points(
    p_player_id, v_total, 'REFUND',
    'game-session-v1:' || v_action_id::text || ':refund',
    v_runtime.catalog_slug, v_round.id::text,
    'Server returned open game wager'
  );
  insert into public.game_actions(
    id, player_id, session_id, round_id, catalog_slug, kind, idempotency_key, request, result
  ) values (
    v_action_id, p_player_id, p_session_id, p_round_id, v_runtime.catalog_slug,
    p_kind, trim(p_idempotency_key), coalesce(p_request, '{}'::jsonb),
    jsonb_build_object('refunded', v_total, 'balance_after', v_balance, 'ledger_id', v_ledger_id, 'wager_ids', to_jsonb(v_wager_ids))
  );
  update public.game_wagers
  set status = 'REFUNDED', refund_action_id = v_action_id, refund_ledger_id = v_ledger_id
  where id = any(v_wager_ids);
  v_event_type := case when p_kind = 'CLEAR' then 'BETS_CLEARED' else 'BET_UNDONE' end;
  perform public.emit_game_event(
    p_player_id, p_session_id, p_round_id, v_action_id, v_runtime.catalog_slug,
    v_event_type, jsonb_build_object('wager_ids', to_jsonb(v_wager_ids), 'refunded', v_total, 'balance_after', v_balance)
  );
  update public.game_player_sessions set last_seen_at = now() where id = p_session_id;
  return query select v_action_id, v_total, v_balance, false;
end;
$$;

-- Server-only settlement.  The Edge resolver passes a server-computed payout
-- after it has validated the stored round outcome and the stored wager; no
-- player-facing route accepts this function's arguments directly.
create or replace function public.resolve_game_wager(
  p_wager_id uuid,
  p_payout bigint,
  p_outcome jsonb,
  p_note text default null
)
returns table(
  action_id uuid,
  balance_after bigint,
  duplicate boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_wager public.game_wagers;
  v_round public.game_rounds;
  v_action_id uuid;
  v_ledger_id uuid;
  v_balance bigint;
begin
  if p_payout < 0 or p_payout > 1000000000 then
    raise exception 'Server payout is invalid' using errcode = '22023';
  end if;
  if p_outcome is null or jsonb_typeof(p_outcome) <> 'object' then
    raise exception 'Server outcome is required' using errcode = '22023';
  end if;
  select * into v_wager from public.game_wagers where id = p_wager_id for update;
  if not found then
    raise exception 'Wager not found' using errcode = 'P0001';
  end if;
  if v_wager.status = 'SETTLED' then
    select a.id, coalesce((a.result ->> 'balance_after')::bigint, 0)
    into v_action_id, v_balance
    from public.game_actions a
    where a.id = v_wager.settlement_action_id;
    return query select v_action_id, v_balance, true;
    return;
  end if;
  if v_wager.status <> 'OPEN' then
    raise exception 'Only an open wager can settle' using errcode = '55000';
  end if;
  select * into v_round from public.game_rounds where id = v_wager.round_id for update;
  if clock_timestamp() < v_round.reveal_starts_at then
    raise exception 'Round outcome is not available yet' using errcode = '55000';
  end if;
  v_action_id := gen_random_uuid();
  if p_payout > 0 then
    select ledger_id, balance_after into v_ledger_id, v_balance
    from public.apply_game_play_points(
      v_wager.player_id, p_payout, 'PRIZE',
      'game-session-v1:' || v_action_id::text || ':prize',
      v_wager.catalog_slug, v_round.id::text,
      coalesce(nullif(trim(p_note), ''), 'Server resolved game wager')
    );
  else
    select play_points_balance into v_balance from public.profiles where id = v_wager.player_id;
  end if;
  insert into public.game_actions(
    id, player_id, session_id, round_id, catalog_slug, kind, idempotency_key, request, result
  ) values (
    v_action_id, v_wager.player_id, v_wager.session_id, v_wager.round_id,
    v_wager.catalog_slug, 'SETTLE', 'game-resolution-v1:' || v_wager.id::text,
    jsonb_build_object('wager_id', v_wager.id),
    jsonb_build_object('payout', p_payout, 'balance_after', v_balance, 'ledger_id', v_ledger_id)
  );
  update public.game_wagers
  set status = 'SETTLED', settlement_action_id = v_action_id, prize_ledger_id = v_ledger_id,
      payout = p_payout, outcome = p_outcome, settled_at = now()
  where id = v_wager.id;
  perform public.emit_game_event(
    v_wager.player_id, v_wager.session_id, v_wager.round_id, v_action_id,
    v_wager.catalog_slug, 'WAGER_SETTLED',
    jsonb_build_object('wager_id', v_wager.id, 'payout', p_payout, 'balance_after', v_balance)
  );
  return query select v_action_id, v_balance, false;
end;
$$;

-- Server-only creator for a single global clocked round.  The unique index is
-- the race guard: concurrent Edge instances can propose a round, but only the
-- first persisted server-generated outcome becomes authoritative.
create or replace function public.create_clocked_game_round(
  p_catalog_slug text,
  p_round_number bigint,
  p_starts_at timestamptz,
  p_betting_closes_at timestamptz,
  p_reveal_starts_at timestamptz,
  p_result_starts_at timestamptz,
  p_ends_at timestamptz,
  p_outcome_commitment text,
  p_outcome jsonb,
  p_metadata jsonb default '{}'::jsonb
)
returns public.game_rounds
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_runtime public.game_runtime_catalog;
  v_round public.game_rounds;
begin
  select * into v_runtime from public.game_runtime_catalog
  where catalog_slug = p_catalog_slug and runtime_mode = 'CLOCKED_SHARED';
  if not found then
    raise exception 'Clocked runtime is not configured' using errcode = 'P0001';
  end if;
  if p_outcome is null or jsonb_typeof(p_outcome) <> 'object' then
    raise exception 'Server outcome is required' using errcode = '22023';
  end if;
  insert into public.game_rounds(
    catalog_slug, engine_slug, round_number, phase, starts_at, betting_closes_at,
    reveal_starts_at, result_starts_at, ends_at, outcome_commitment, outcome,
    ruleset_version, metadata
  ) values (
    v_runtime.catalog_slug, v_runtime.engine_slug, p_round_number, 'BETTING',
    p_starts_at, p_betting_closes_at, p_reveal_starts_at, p_result_starts_at,
    p_ends_at, lower(trim(p_outcome_commitment)), p_outcome,
    v_runtime.ruleset_version, coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (catalog_slug, round_number) where session_id is null do nothing
  returning * into v_round;
  if not found then
    select * into v_round from public.game_rounds
    where catalog_slug = p_catalog_slug and round_number = p_round_number and session_id is null;
  end if;
  return v_round;
end;
$$;

create trigger game_actions_immutable
before update or delete on public.game_actions
for each row execute function public.prevent_immutable_change();

create trigger game_event_outbox_immutable
before update or delete on public.game_event_outbox
for each row execute function public.prevent_immutable_change();

revoke all on table public.game_runtime_catalog, public.game_player_sessions,
  public.game_rounds, public.game_actions, public.game_wagers,
  public.game_event_outbox from public, anon, authenticated;
revoke all on sequence public.game_event_outbox_event_id_seq from public, anon, authenticated;
revoke all on function public.assert_game_player(uuid) from public, anon, authenticated;
revoke all on function public.assert_playable_game_runtime(uuid, text) from public, anon, authenticated;
revoke all on function public.open_game_player_session(uuid, text) from public, anon, authenticated;
revoke all on function public.emit_game_event(uuid, uuid, uuid, uuid, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.submit_game_stake(uuid, uuid, uuid, text, bigint, text, jsonb) from public, anon, authenticated;
revoke all on function public.refund_game_wagers(uuid, uuid, uuid, public.game_action_kind, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.resolve_game_wager(uuid, bigint, jsonb, text) from public, anon, authenticated;
revoke all on function public.create_clocked_game_round(text, bigint, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.assert_game_player(uuid) to service_role;
grant execute on function public.assert_playable_game_runtime(uuid, text) to service_role;
grant execute on function public.open_game_player_session(uuid, text) to service_role;
grant execute on function public.emit_game_event(uuid, uuid, uuid, uuid, text, text, jsonb) to service_role;
grant execute on function public.submit_game_stake(uuid, uuid, uuid, text, bigint, text, jsonb) to service_role;
grant execute on function public.refund_game_wagers(uuid, uuid, uuid, public.game_action_kind, text, text, jsonb) to service_role;
grant execute on function public.resolve_game_wager(uuid, bigint, jsonb, text) to service_role;
grant execute on function public.create_clocked_game_round(text, bigint, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, text, jsonb, jsonb) to service_role;

alter table public.game_runtime_catalog enable row level security;
alter table public.game_player_sessions enable row level security;
alter table public.game_rounds enable row level security;
alter table public.game_actions enable row level security;
alter table public.game_wagers enable row level security;
alter table public.game_event_outbox enable row level security;
