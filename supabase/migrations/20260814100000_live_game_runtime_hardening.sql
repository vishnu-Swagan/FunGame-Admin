-- Fail-closed hardening for the server-authoritative virtual-points runtime.
--
-- This is intentionally forward-only: it does not enable any cabinet.  It
-- changes a balance only to return an already-debited OPEN virtual stake when
-- a runtime/player lockout closes or when this fail-closed recovery reconciles
-- a stale open wager.

alter table public.game_runtime_catalog
  add column if not exists min_bet bigint not null default 1,
  add column if not exists max_bet bigint not null default 1000000;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'game_runtime_catalog_bet_limits'
      and conrelid = 'public.game_runtime_catalog'::regclass
  ) then
    alter table public.game_runtime_catalog
      add constraint game_runtime_catalog_bet_limits
      check (min_bet >= 1 and max_bet >= min_bet and max_bet <= 1000000);
  end if;
end;
$$;

-- These values are duplicated from the reviewed static GameSpec map.  The
-- Edge function additionally rejects any drift before opening a session.
update public.game_runtime_catalog as runtime
set min_bet = limits.min_bet,
    max_bet = limits.max_bet,
    updated_at = now()
from (
  values
    ('7up7down', 5::bigint, 1000::bigint),
    ('fun-ab', 10::bigint, 10000::bigint),
    ('triple-fun', 5::bigint, 5000::bigint),
    ('fun-roulette', 5::bigint, 5000::bigint),
    ('fun-target', 5::bigint, 5000::bigint),
    ('bingo', 5::bigint, 1000::bigint),
    ('joker-bonus', 5::bigint, 1000::bigint),
    ('giant-jackpot', 10::bigint, 1000::bigint),
    ('golden-wheel', 5::bigint, 1000::bigint),
    ('keno', 5::bigint, 1000::bigint),
    ('checker', 5::bigint, 1000::bigint),
    ('lucky-8-line', 10::bigint, 1000::bigint),
    ('fever-joker-bonus', 5::bigint, 1000::bigint),
    ('no-hold', 5::bigint, 1000::bigint),
    ('champion-poker', 5::bigint, 1000::bigint)
) as limits(catalog_slug, min_bet, max_bet)
where runtime.catalog_slug = limits.catalog_slug;

-- Player-paced runtime timing has no invented result countdown.  This fixes
-- the pre-existing Checker row so it agrees with the static contract.
update public.game_runtime_catalog
set timing = jsonb_set(timing, '{result_seconds}', 'null'::jsonb, true),
    updated_at = now()
where catalog_slug = 'checker'
  and timing -> 'result_seconds' is distinct from 'null'::jsonb;

-- A refund is a restoration of a prior virtual stake, not new gameplay.  It
-- must remain possible if an operator suspends the player at the same time a
-- game is disabled, otherwise an OPEN wager could become stranded.
create or replace function public.apply_game_play_points(
  p_player_id uuid,
  p_delta bigint,
  p_kind public.play_point_kind,
  p_idempotency_key text,
  p_game_slug text,
  p_round_id text,
  p_note text default null
)
returns table(ledger_id uuid, balance_after bigint, duplicate boolean)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_player public.profiles;
  v_existing public.play_point_ledger;
  v_new_balance bigint;
  v_ledger_id uuid;
  v_entry_sequence bigint;
begin
  if p_kind not in ('STAKE', 'PRIZE', 'REFUND') then
    raise exception 'Invalid game settlement kind' using errcode = '22023';
  end if;
  if (p_kind = 'STAKE' and p_delta >= 0) or (p_kind in ('PRIZE', 'REFUND') and p_delta <= 0) then
    raise exception 'Game settlement amount has an invalid sign' using errcode = '22023';
  end if;
  if coalesce(char_length(trim(p_idempotency_key)), 0) < 8 then
    raise exception 'Idempotency key is required' using errcode = '22023';
  end if;

  select * into v_player
  from public.profiles
  where id = p_player_id
    and account_kind = 'PLAYER'
    and (p_kind = 'REFUND' or status = 'ACTIVE')
  for update;
  if not found then
    if p_kind = 'REFUND' then
      raise exception 'Player not found for game refund' using errcode = 'P0001';
    end if;
    raise exception 'Active player not found' using errcode = 'P0001';
  end if;
  -- `submit_game_stake` already reaches this point through the switch/player
  -- admission lock.  Keep the check here too so a future server-only caller
  -- cannot debit a player while an effective exclusion exists.
  if p_kind = 'STAKE' and exists (
    select 1
    from public.exclusions e
    where e.player_id = p_player_id
      and e.status = 'ACTIVE'
      and (e.ends_at is null or e.ends_at > clock_timestamp())
  ) then
    raise exception 'Player gameplay is unavailable' using errcode = '42501';
  end if;

  select * into v_existing from public.play_point_ledger
  where player_id = p_player_id and idempotency_key = trim(p_idempotency_key);
  if found then
    if v_existing.delta <> p_delta or v_existing.kind <> p_kind
      or v_existing.reference_type <> 'GAME_ROUND'
      or v_existing.reference_id is distinct from p_round_id then
      raise exception 'Idempotency key was already used for a different settlement' using errcode = '22023';
    end if;
    return query select v_existing.id, v_existing.balance_after, true;
    return;
  end if;

  v_new_balance := v_player.play_points_balance + p_delta;
  if v_new_balance < 0 then
    raise exception 'Insufficient virtual play points' using errcode = '22003';
  end if;
  perform set_config('app.play_points_mutation', 'on', true);
  update public.profiles set play_points_balance = v_new_balance where id = p_player_id;
  select coalesce(max(entry_sequence), 0) + 1 into v_entry_sequence
  from public.play_point_ledger where player_id = p_player_id;
  insert into public.play_point_ledger(
    player_id, actor_id, delta, balance_after, entry_sequence, kind, idempotency_key,
    reference_type, reference_id, note, metadata
  ) values (
    p_player_id, null, p_delta, v_new_balance, v_entry_sequence, p_kind, trim(p_idempotency_key),
    'GAME_ROUND', p_round_id, p_note, jsonb_build_object('game_slug', p_game_slug)
  ) returning id into v_ledger_id;
  return query select v_ledger_id, v_new_balance, false;
end;
$$;

-- Player lockout and all game switches participate in one deliberate lock
-- order: system -> runtime -> catalogue -> player -> session -> round/wager.
-- Locking the player row here serializes a new suspension/exclusion with the
-- final debit.  The exclusion trigger below takes the same row lock before it
-- writes an effective lockout, so a stake is either accepted before the
-- lockout and immediately returned, or rejected after the lockout commits.
create or replace function public.assert_game_player(p_player_id uuid)
returns public.profiles
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_player public.profiles;
begin
  select * into v_player
  from public.profiles
  where id = p_player_id
    and account_kind = 'PLAYER'
    and status = 'ACTIVE'
  for update;
  if not found then
    raise exception 'Active player account required' using errcode = '42501';
  end if;
  if exists (
    select 1
    from public.exclusions e
    where e.player_id = p_player_id
      and e.status = 'ACTIVE'
      and (e.ends_at is null or e.ends_at > clock_timestamp())
  ) then
    raise exception 'Player gameplay is unavailable' using errcode = '42501';
  end if;
  return v_player;
end;
$$;

-- Lock the live switches before the player, so a disable/maintenance update
-- takes the conflicting lock before draining and cannot race an accepted
-- stake or a resolver settlement.
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
  select maintenance_mode into v_maintenance
  from public.system_config where key = 'main'
  for share;
  if coalesce(v_maintenance, true) then
    raise exception 'Game service is under maintenance' using errcode = '55000';
  end if;
  select * into v_runtime
  from public.game_runtime_catalog
  where catalog_slug = p_catalog_slug
  for share;
  if not found then
    raise exception 'Game runtime is not configured' using errcode = 'P0001';
  end if;
  select status into v_game_status
  from public.games where slug = p_catalog_slug
  for share;
  if coalesce(v_game_status, 'DISABLED') <> 'ENABLED'
     or v_runtime.availability <> 'ENABLED'
     or v_runtime.parity_state <> 'QA_VERIFIED' then
    raise exception 'Game runtime is not available' using errcode = '55000';
  end if;
  perform public.assert_game_player(p_player_id);
  return v_runtime;
end;
$$;

-- A stake intent is canonicalized by game-api before it reaches this RPC.
-- Recreate that compact shape here and bind it, the session, and the round to
-- the idempotency key so retries cannot replay a key against another wager.
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
  v_expected_request jsonb;
begin
  if coalesce(char_length(trim(p_idempotency_key)), 0) < 8 then
    raise exception 'Idempotency key is required' using errcode = '22023';
  end if;
  if p_amount is null or p_amount < 1 or p_amount > 1000000 then
    raise exception 'Stake must be between 1 and 1000000 virtual play points' using errcode = '22023';
  end if;
  if coalesce(char_length(trim(p_selection)), 0) < 1 or char_length(trim(p_selection)) > 160 then
    raise exception 'Selection is invalid' using errcode = '22023';
  end if;
  v_expected_request := jsonb_build_object(
    'action', 'place_bet', 'selection', trim(p_selection), 'amount', p_amount
  );
  if coalesce(p_request, '{}'::jsonb) is distinct from v_expected_request then
    raise exception 'Request does not match the normalized game stake intent' using errcode = '22023';
  end if;

  -- Serialize the same player's same key before inspecting the immutable
  -- receipt. The unique index remains the final guard, while this preserves a
  -- duplicate response rather than a unique-violation race under retries.
  perform pg_advisory_xact_lock(hashtext(p_player_id::text || ':' || trim(p_idempotency_key)));
  select * into v_existing from public.game_actions
  where player_id = p_player_id and idempotency_key = trim(p_idempotency_key)
  for update;
  if found then
    if v_existing.kind <> 'STAKE'
       or v_existing.session_id is distinct from p_session_id
       or v_existing.round_id is distinct from p_round_id
       or v_existing.request is distinct from v_expected_request then
      raise exception 'Idempotency key was already used for a different action' using errcode = '22023';
    end if;
    select id into v_wager_id from public.game_wagers where action_id = v_existing.id;
    return query select v_existing.id, v_wager_id,
      coalesce((v_existing.result ->> 'balance_after')::bigint, 0), true;
    return;
  end if;

  -- Read the session only to discover its catalogue.  Do not lock it before
  -- the shared runtime/player admission locks: a suspension trigger locks the
  -- player before it closes sessions, and the opposite order would deadlock.
  select * into v_session from public.game_player_sessions
  where id = p_session_id and player_id = p_player_id and status = 'ACTIVE';
  if not found then
    raise exception 'Active game session not found' using errcode = 'P0001';
  end if;
  select * into v_runtime from public.assert_playable_game_runtime(p_player_id, v_session.catalog_slug);
  select * into v_session from public.game_player_sessions
  where id = p_session_id and player_id = p_player_id and status = 'ACTIVE'
  for update;
  if not found then
    raise exception 'Active game session not found' using errcode = 'P0001';
  end if;
  if v_session.catalog_slug <> v_runtime.catalog_slug
     or v_session.engine_slug <> v_runtime.engine_slug
     or v_session.runtime_mode <> v_runtime.runtime_mode
     or v_session.ruleset_version <> v_runtime.ruleset_version then
    raise exception 'Game session does not match the active runtime' using errcode = '55000';
  end if;
  if p_amount < v_runtime.min_bet or p_amount > v_runtime.max_bet then
    raise exception 'Stake must be between % and % virtual play points for this game',
      v_runtime.min_bet, v_runtime.max_bet using errcode = '22023';
  end if;
  select * into v_round from public.game_rounds
  where id = p_round_id and catalog_slug = v_session.catalog_slug
  for update;
  if not found then
    raise exception 'Round not found for this game session' using errcode = 'P0001';
  end if;
  if v_round.engine_slug <> v_runtime.engine_slug
     or v_round.ruleset_version <> v_runtime.ruleset_version then
    raise exception 'Round does not match the active runtime' using errcode = '55000';
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
    'STAKE', trim(p_idempotency_key), v_expected_request,
    jsonb_build_object('balance_after', v_balance, 'ledger_id', v_ledger_id, 'selection', trim(p_selection), 'amount', p_amount)
  );
  insert into public.game_wagers(
    id, action_id, player_id, session_id, round_id, catalog_slug, selection, amount, stake_ledger_id
  ) values (
    v_wager_id, v_action_id, p_player_id, p_session_id, p_round_id,
    v_runtime.catalog_slug, trim(p_selection), p_amount, v_ledger_id
  );
  perform public.emit_game_event(
    p_player_id, p_session_id, p_round_id, v_action_id, v_runtime.catalog_slug,
    'BET_PLACED', jsonb_build_object('wager_id', v_wager_id, 'selection', trim(p_selection), 'amount', p_amount, 'balance_after', v_balance)
  );
  update public.game_player_sessions set last_seen_at = now() where id = p_session_id;
  return query select v_action_id, v_wager_id, v_balance, false;
end;
$$;

-- CLEAR and UNDO receive the same immutable request binding as a stake.
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
  v_expected_request jsonb;
begin
  if p_kind not in ('CLEAR', 'UNDO') then
    raise exception 'Only CLEAR and UNDO can refund open wagers' using errcode = '22023';
  end if;
  if coalesce(char_length(trim(p_idempotency_key)), 0) < 8 then
    raise exception 'Idempotency key is required' using errcode = '22023';
  end if;
  if p_kind = 'UNDO' and (
    coalesce(char_length(trim(p_selection)), 0) < 1 or char_length(trim(p_selection)) > 160
  ) then
    raise exception 'UNDO requires a valid selection' using errcode = '22023';
  end if;
  if p_kind = 'CLEAR' and nullif(trim(p_selection), '') is not null then
    raise exception 'CLEAR does not accept a selection' using errcode = '22023';
  end if;
  v_expected_request := jsonb_build_object(
    'action', case when p_kind = 'CLEAR' then 'clear_bets' else 'cancel_bet' end
  );
  if p_kind = 'UNDO' then
    v_expected_request := v_expected_request || jsonb_build_object('selection', trim(p_selection));
  end if;
  if coalesce(p_request, '{}'::jsonb) is distinct from v_expected_request then
    raise exception 'Request does not match the normalized game refund intent' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_player_id::text || ':' || trim(p_idempotency_key)));
  select * into v_existing from public.game_actions
  where player_id = p_player_id and idempotency_key = trim(p_idempotency_key)
  for update;
  if found then
    if v_existing.kind <> p_kind
       or v_existing.session_id is distinct from p_session_id
       or v_existing.round_id is distinct from p_round_id
       or v_existing.request is distinct from v_expected_request then
      raise exception 'Idempotency key was already used for a different action' using errcode = '22023';
    end if;
    return query select v_existing.id,
      coalesce((v_existing.result ->> 'refunded')::bigint, 0),
      coalesce((v_existing.result ->> 'balance_after')::bigint, 0), true;
    return;
  end if;

  -- Keep the same lock order as stake acceptance.  A player lockout owns the
  -- profile lock before it drains and closes sessions, so a refund action must
  -- not hold the session row while waiting for that profile lock.
  select * into v_session from public.game_player_sessions
  where id = p_session_id and player_id = p_player_id and status = 'ACTIVE';
  if not found then
    raise exception 'Active game session not found' using errcode = 'P0001';
  end if;
  select * into v_runtime from public.assert_playable_game_runtime(p_player_id, v_session.catalog_slug);
  select * into v_session from public.game_player_sessions
  where id = p_session_id and player_id = p_player_id and status = 'ACTIVE'
  for update;
  if not found then
    raise exception 'Active game session not found' using errcode = 'P0001';
  end if;
  if v_session.catalog_slug <> v_runtime.catalog_slug
     or v_session.engine_slug <> v_runtime.engine_slug
     or v_session.runtime_mode <> v_runtime.runtime_mode
     or v_session.ruleset_version <> v_runtime.ruleset_version then
    raise exception 'Game session does not match the active runtime' using errcode = '55000';
  end if;
  select * into v_round from public.game_rounds
  where id = p_round_id and catalog_slug = v_session.catalog_slug
  for update;
  if not found then
    raise exception 'Round not found for this game session' using errcode = 'P0001';
  end if;
  if v_round.engine_slug <> v_runtime.engine_slug
     or v_round.ruleset_version <> v_runtime.ruleset_version then
    raise exception 'Round does not match the active runtime' using errcode = '55000';
  end if;
  if clock_timestamp() < v_round.starts_at or clock_timestamp() >= v_round.betting_closes_at then
    raise exception 'Bets are closed for this round' using errcode = '55000';
  end if;

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
    p_kind, trim(p_idempotency_key), v_expected_request,
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

-- Settlement obtains the same switch and player locks as a stake before it
-- locks the wager.  That ordering is what makes a disable/maintenance update
-- atomic: the resolver settles before the switch can change, or the switch
-- changes first and the trigger restores the still-open virtual stake.
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
  v_runtime public.game_runtime_catalog;
  v_action_id uuid;
  v_ledger_id uuid;
  v_balance bigint;
begin
  if p_payout is null or p_payout < 0 or p_payout > 1000000000 then
    raise exception 'Server payout is invalid' using errcode = '22023';
  end if;
  if p_outcome is null or jsonb_typeof(p_outcome) <> 'object' then
    raise exception 'Server outcome is required' using errcode = '22023';
  end if;

  -- This probe intentionally has no row lock.  Its only purpose is to obtain
  -- the catalogue/player needed for the admission locks; the wager is read
  -- again with FOR UPDATE after those locks are held.
  select * into v_wager from public.game_wagers where id = p_wager_id;
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

  select * into v_runtime
  from public.assert_playable_game_runtime(v_wager.player_id, v_wager.catalog_slug);
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
  if v_wager.catalog_slug <> v_runtime.catalog_slug then
    raise exception 'Wager does not match the active runtime' using errcode = '55000';
  end if;
  select * into v_round from public.game_rounds where id = v_wager.round_id for update;
  if not found then
    raise exception 'Round not found for wager' using errcode = 'P0001';
  end if;
  if v_round.catalog_slug <> v_runtime.catalog_slug
     or v_round.engine_slug <> v_runtime.engine_slug
     or v_round.ruleset_version <> v_runtime.ruleset_version then
    raise exception 'Round does not match the active runtime' using errcode = '55000';
  end if;
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

-- A fail-closed transition cannot strand virtual points.  This internal
-- helper is reachable only through table triggers or this migration's
-- one-time recovery.  It restores each still-open stake, emits an immutable
-- VOID receipt, then closes affected sessions so a stale UI cannot be reused
-- after a configuration or player-lockout transition.
create or replace function public.drain_open_game_wagers_internal(
  p_catalog_slug text,
  p_player_id uuid,
  p_reason text
)
returns table(refunded_wagers bigint, refunded_points bigint)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_player_id uuid;
  v_wager public.game_wagers;
  v_action_id uuid;
  v_ledger_id uuid;
  v_balance bigint;
  v_reason text := coalesce(nullif(trim(p_reason), ''), 'Live game runtime disabled before settlement');
begin
  refunded_wagers := 0;
  refunded_points := 0;
  -- Never take a wager lock and then wait for a player wallet lock.  Player
  -- lockout transitions own profiles first, so all drain paths enumerate
  -- players in one deterministic order and only then lock their wagers.
  for v_player_id in
    select p.id
    from public.profiles p
    where (p_player_id is null or p.id = p_player_id)
      and exists (
        select 1
        from public.game_wagers w
        where w.player_id = p.id
          and w.status = 'OPEN'
          and (p_catalog_slug is null or w.catalog_slug = p_catalog_slug)
      )
    order by p.id
    for update of p
  loop
    for v_wager in
      select *
      from public.game_wagers
      where player_id = v_player_id
        and status = 'OPEN'
        and (p_catalog_slug is null or catalog_slug = p_catalog_slug)
      order by placed_at, id
      for update
    loop
      v_action_id := gen_random_uuid();
      select ledger_id, balance_after into v_ledger_id, v_balance
      from public.apply_game_play_points(
        v_wager.player_id, v_wager.amount, 'REFUND',
        'game-runtime-drain-v1:' || v_wager.id::text,
        v_wager.catalog_slug, v_wager.round_id::text,
        v_reason
      );
      insert into public.game_actions(
        id, player_id, session_id, round_id, catalog_slug, kind, idempotency_key, request, result
      ) values (
        v_action_id, v_wager.player_id, v_wager.session_id, v_wager.round_id,
        v_wager.catalog_slug, 'SETTLE', 'game-runtime-drain-v1:' || v_wager.id::text,
        jsonb_build_object('action', 'runtime_drain_refund', 'reason', v_reason),
        jsonb_build_object(
          'wager_id', v_wager.id, 'refunded', v_wager.amount,
          'balance_after', v_balance, 'ledger_id', v_ledger_id, 'reason', v_reason
        )
      );
      update public.game_wagers
      set status = 'VOID', refund_action_id = v_action_id, refund_ledger_id = v_ledger_id,
          settled_at = now()
      where id = v_wager.id;
      perform public.emit_game_event(
        v_wager.player_id, v_wager.session_id, v_wager.round_id, v_action_id,
        v_wager.catalog_slug, 'WAGER_VOIDED',
        jsonb_build_object('wager_id', v_wager.id, 'refunded', v_wager.amount, 'balance_after', v_balance, 'reason', v_reason)
      );
      refunded_wagers := refunded_wagers + 1;
      refunded_points := refunded_points + v_wager.amount;
    end loop;
  end loop;

  update public.game_player_sessions
  set status = 'CLOSED', closed_at = clock_timestamp(), last_seen_at = clock_timestamp()
  where status = 'ACTIVE'
    and (p_catalog_slug is null or catalog_slug = p_catalog_slug)
    and (p_player_id is null or player_id = p_player_id);
  return query select refunded_wagers, refunded_points;
end;
$$;

-- Preserve the pre-existing two-argument signature for game/runtime/system
-- triggers.  It is deliberately not granted to any API role.
create or replace function public.drain_open_game_wagers(
  p_catalog_slug text default null,
  p_reason text default 'Live game runtime disabled before settlement'
)
returns table(refunded_wagers bigint, refunded_points bigint)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  return query select * from public.drain_open_game_wagers_internal(
    p_catalog_slug, null, p_reason
  );
end;
$$;

create or replace function public.drain_open_player_game_wagers(
  p_player_id uuid,
  p_reason text default 'Player gameplay became unavailable before settlement'
)
returns table(refunded_wagers bigint, refunded_points bigint)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if p_player_id is null then
    raise exception 'Player is required for player wager drain' using errcode = '22023';
  end if;
  return query select * from public.drain_open_game_wagers_internal(
    null, p_player_id, p_reason
  );
end;
$$;

create or replace function public.drain_wagers_on_game_disable()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if old.status = 'ENABLED' and new.status <> 'ENABLED' then
    perform public.drain_open_game_wagers(new.slug, 'Game catalogue disabled or placed under maintenance');
  end if;
  return new;
end;
$$;

create or replace function public.drain_wagers_on_runtime_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if (old.availability = 'ENABLED' and new.availability <> 'ENABLED')
     or old.parity_state is distinct from new.parity_state
     or old.ruleset_version is distinct from new.ruleset_version
     or old.engine_slug is distinct from new.engine_slug
     or old.runtime_mode is distinct from new.runtime_mode
     or old.unity_lobby_slug is distinct from new.unity_lobby_slug
     or old.unity_scene is distinct from new.unity_scene
     or old.timing is distinct from new.timing
     or old.action_contract is distinct from new.action_contract
     or old.outcome_contract is distinct from new.outcome_contract
     or old.min_bet is distinct from new.min_bet
     or old.max_bet is distinct from new.max_bet then
    perform public.drain_open_game_wagers(new.catalog_slug, 'Game runtime changed or became unavailable before settlement');
  end if;
  return new;
end;
$$;

create or replace function public.drain_wagers_on_system_maintenance()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if old.maintenance_mode is false and new.maintenance_mode is true then
    perform public.drain_open_game_wagers(null, 'System maintenance started before game settlement');
  end if;
  return new;
end;
$$;

create or replace function public.drain_wagers_on_player_lockout()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if old.account_kind = 'PLAYER' and old.status = 'ACTIVE' and new.status <> 'ACTIVE' then
    -- The row update already holds this player's FOR UPDATE lock.  All gameplay
    -- admission reaches the same lock before it can debit a stake.
    perform public.drain_open_player_game_wagers(old.id, 'Player account became unavailable before game settlement');
  end if;
  return new;
end;
$$;

create or replace function public.drain_wagers_on_effective_exclusion()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_old_effective boolean := false;
  v_new_effective boolean;
begin
  v_new_effective := new.status = 'ACTIVE'
    and (new.ends_at is null or new.ends_at > clock_timestamp());
  if tg_op = 'UPDATE' then
    v_old_effective := old.status = 'ACTIVE'
      and (old.ends_at is null or old.ends_at > clock_timestamp());
  end if;
  if v_new_effective and not v_old_effective then
    -- Lock the same player row used by assert_game_player/apply_game_play_points
    -- before the exclusion exists, closing the check-to-debit race.
    perform 1 from public.profiles
    where id = new.player_id and account_kind = 'PLAYER'
    for update;
    perform public.drain_open_player_game_wagers(new.player_id, 'An active player exclusion began before game settlement');
  end if;
  return new;
end;
$$;

drop trigger if exists games_drain_open_wagers_on_disable on public.games;
create trigger games_drain_open_wagers_on_disable
before update of status on public.games
for each row execute function public.drain_wagers_on_game_disable();

drop trigger if exists game_runtime_catalog_drain_open_wagers_on_disable on public.game_runtime_catalog;
create trigger game_runtime_catalog_drain_open_wagers_on_disable
before update on public.game_runtime_catalog
for each row execute function public.drain_wagers_on_runtime_change();

drop trigger if exists system_config_drain_open_wagers_on_maintenance on public.system_config;
create trigger system_config_drain_open_wagers_on_maintenance
before update of maintenance_mode on public.system_config
for each row execute function public.drain_wagers_on_system_maintenance();

drop trigger if exists profiles_drain_open_wagers_on_lockout on public.profiles;
create trigger profiles_drain_open_wagers_on_lockout
after update of status on public.profiles
for each row execute function public.drain_wagers_on_player_lockout();

drop trigger if exists exclusions_drain_open_wagers_on_effective_lockout on public.exclusions;
create trigger exclusions_drain_open_wagers_on_effective_lockout
before insert or update of status, ends_at on public.exclusions
for each row execute function public.drain_wagers_on_effective_exclusion();

revoke all on function public.drain_open_game_wagers_internal(text, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.drain_open_game_wagers(text, text) from public, anon, authenticated, service_role;
revoke all on function public.drain_open_player_game_wagers(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.drain_wagers_on_game_disable() from public, anon, authenticated, service_role;
revoke all on function public.drain_wagers_on_runtime_change() from public, anon, authenticated, service_role;
revoke all on function public.drain_wagers_on_system_maintenance() from public, anon, authenticated, service_role;
revoke all on function public.drain_wagers_on_player_lockout() from public, anon, authenticated, service_role;
revoke all on function public.drain_wagers_on_effective_exclusion() from public, anon, authenticated, service_role;

-- Every resolver in this deployment is intentionally unregistered until its
-- observed client rules and settlement path are reviewed.  Return any legacy
-- OPEN virtual stake now rather than carrying it into a closed runtime.  The
-- helper also closes stale active sessions, preventing old UI state reuse.
select * from public.drain_open_game_wagers(
  null::text,
  'Fail-closed hardening migration returned an unsettled virtual game stake'
);
