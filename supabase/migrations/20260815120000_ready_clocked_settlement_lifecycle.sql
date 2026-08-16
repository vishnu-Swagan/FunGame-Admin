-- Production-safe settlement lifecycle for future READY clocked resolvers.
--
-- This migration does not enable or promote any game. It adds immutable
-- resolver identity to shared rounds, makes settlement retries compare the
-- full authoritative result, and exposes only service-role procedures. A
-- PLAYER_PACED cabinet is rejected by every procedure in this file.

alter table public.game_rounds
  add column if not exists resolver_id text;

alter table public.game_wagers
  add column if not exists settlement_resolver_id text,
  add column if not exists settlement_ruleset_version integer;

create index if not exists game_wagers_open_round_player_idx
  on public.game_wagers(round_id, player_id, placed_at, id)
  where status = 'OPEN';

create or replace function public.prevent_game_round_authority_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if new.catalog_slug is distinct from old.catalog_slug
     or new.engine_slug is distinct from old.engine_slug
     or new.session_id is distinct from old.session_id
     or new.round_number is distinct from old.round_number
     or new.starts_at is distinct from old.starts_at
     or new.betting_closes_at is distinct from old.betting_closes_at
     or new.reveal_starts_at is distinct from old.reveal_starts_at
     or new.result_starts_at is distinct from old.result_starts_at
     or new.ends_at is distinct from old.ends_at
     or new.outcome_commitment is distinct from old.outcome_commitment
     or new.outcome is distinct from old.outcome
     or new.outcome_source is distinct from old.outcome_source
     or new.ruleset_version is distinct from old.ruleset_version
     or new.resolver_id is distinct from old.resolver_id
     or new.metadata is distinct from old.metadata then
    raise exception 'Authoritative game round fields are immutable' using errcode = '55000';
  end if;
  return new;
end;
$$;

drop trigger if exists game_rounds_authority_immutable on public.game_rounds;
create trigger game_rounds_authority_immutable
before update on public.game_rounds
for each row execute function public.prevent_game_round_authority_change();

-- The old four-argument RPC predates compiled resolver identity. Retain its
-- catalog object for migration compatibility, but remove the API role's only
-- execution grant so it cannot bypass the exact READY resolver lifecycle.
revoke all on function public.resolve_game_wager(uuid, bigint, jsonb, text)
  from public, anon, authenticated, service_role;

create or replace function public.create_ready_clocked_game_round(
  p_catalog_slug text,
  p_round_number bigint,
  p_starts_at timestamptz,
  p_betting_closes_at timestamptz,
  p_reveal_starts_at timestamptz,
  p_result_starts_at timestamptz,
  p_ends_at timestamptz,
  p_outcome_commitment text,
  p_outcome jsonb,
  p_resolver_id text,
  p_ruleset_version integer,
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
  v_game_status text;
  v_maintenance boolean;
begin
  if p_round_number is null or p_round_number < 0
     or p_ruleset_version is null or p_ruleset_version < 1 then
    raise exception 'Clocked round identity is invalid' using errcode = '22023';
  end if;
  if coalesce(char_length(trim(p_resolver_id)), 0) < 3
     or char_length(trim(p_resolver_id)) > 80
     or trim(p_resolver_id) !~ '^[a-z0-9]+([._-][a-z0-9]+)*$' then
    raise exception 'Clocked resolver identity is invalid' using errcode = '22023';
  end if;
  if p_outcome is null or jsonb_typeof(p_outcome) <> 'object'
     or coalesce(trim(p_outcome_commitment), '') !~ '^[0-9a-f]{64}$' then
    raise exception 'Authoritative server outcome is invalid' using errcode = '22023';
  end if;
  if p_starts_at is null or p_betting_closes_at is null
     or p_reveal_starts_at is null or p_result_starts_at is null or p_ends_at is null
     or not (p_starts_at <= p_betting_closes_at
             and p_betting_closes_at <= p_reveal_starts_at
             and p_reveal_starts_at <= p_result_starts_at
             and p_result_starts_at <= p_ends_at) then
    raise exception 'Clocked round timing is invalid' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_metadata, '{}'::jsonb)) <> 'object' then
    raise exception 'Clocked round metadata is invalid' using errcode = '22023';
  end if;

  -- Preserve the gameplay lock order used by stake and settlement:
  -- system -> runtime -> catalogue. There is deliberately no player/session
  -- lock because a shared round is global and must have session_id NULL.
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
  if not found
     or v_runtime.runtime_mode <> 'CLOCKED_SHARED'
     or v_runtime.parity_state <> 'QA_VERIFIED'
     or v_runtime.availability <> 'ENABLED'
     or v_runtime.ruleset_version <> p_ruleset_version then
    raise exception 'Ready clocked runtime is not available' using errcode = '55000';
  end if;
  select status into v_game_status
  from public.games where slug = p_catalog_slug
  for share;
  if coalesce(v_game_status, 'DISABLED') <> 'ENABLED' then
    raise exception 'Game catalogue is not enabled' using errcode = '55000';
  end if;

  insert into public.game_rounds(
    catalog_slug, engine_slug, session_id, round_number, phase, starts_at,
    betting_closes_at, reveal_starts_at, result_starts_at, ends_at,
    outcome_commitment, outcome, outcome_source, ruleset_version, resolver_id,
    metadata
  ) values (
    v_runtime.catalog_slug, v_runtime.engine_slug, null, p_round_number,
    'BETTING', p_starts_at, p_betting_closes_at, p_reveal_starts_at,
    p_result_starts_at, p_ends_at, trim(p_outcome_commitment), p_outcome,
    'SERVER_RANDOM', p_ruleset_version, trim(p_resolver_id),
    coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object(
      'resolver_id', trim(p_resolver_id),
      'ruleset_version', p_ruleset_version
    )
  )
  on conflict (catalog_slug, round_number) where session_id is null do nothing
  returning * into v_round;

  if not found then
    select * into v_round
    from public.game_rounds
    where catalog_slug = p_catalog_slug
      and round_number = p_round_number
      and session_id is null;
  end if;
  if not found
     or v_round.session_id is not null
     or v_round.engine_slug <> v_runtime.engine_slug
     or v_round.ruleset_version <> p_ruleset_version
     or v_round.resolver_id is distinct from trim(p_resolver_id)
     or v_round.starts_at is distinct from p_starts_at
     or v_round.betting_closes_at is distinct from p_betting_closes_at
     or v_round.reveal_starts_at is distinct from p_reveal_starts_at
     or v_round.result_starts_at is distinct from p_result_starts_at
     or v_round.ends_at is distinct from p_ends_at then
    raise exception 'Existing shared round does not match the READY runtime identity' using errcode = '55000';
  end if;
  -- A concurrent creator may have proposed different entropy. The first row is
  -- authoritative; return it so every Edge instance settles the same outcome.
  return v_round;
end;
$$;

create or replace function public.resolve_ready_clocked_game_wager(
  p_wager_id uuid,
  p_payout bigint,
  p_outcome jsonb,
  p_outcome_commitment text,
  p_resolver_id text,
  p_ruleset_version integer
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
  v_action public.game_actions;
  v_action_id uuid;
  v_ledger_id uuid;
  v_balance bigint;
  v_idempotency_key text;
begin
  if p_payout is null or p_payout < 0 or p_payout > 1000000000
     or p_outcome is null or jsonb_typeof(p_outcome) <> 'object'
     or coalesce(trim(p_outcome_commitment), '') !~ '^[0-9a-f]{64}$'
     or coalesce(char_length(trim(p_resolver_id)), 0) < 3
     or char_length(trim(p_resolver_id)) > 80
     or trim(p_resolver_id) !~ '^[a-z0-9]+([._-][a-z0-9]+)*$'
     or p_ruleset_version is null or p_ruleset_version < 1 then
    raise exception 'Clocked settlement input is invalid' using errcode = '22023';
  end if;

  -- Probe only for the lock-order keys, then reacquire the wager after the
  -- shared runtime/player admission locks are held.
  select * into v_wager from public.game_wagers where id = p_wager_id;
  if not found then
    raise exception 'Wager not found' using errcode = 'P0001';
  end if;
  -- An already-committed receipt remains replayable after an operator disables
  -- the runtime. No wallet mutation occurs here, but the retry must still match
  -- every authoritative input instead of silently accepting changed values.
  if v_wager.status = 'SETTLED' then
    select * into v_round from public.game_rounds where id = v_wager.round_id;
    select * into v_action from public.game_actions
    where id = v_wager.settlement_action_id;
    if not found
       or v_round.session_id is not null
       or v_round.resolver_id is distinct from trim(p_resolver_id)
       or v_round.ruleset_version is distinct from p_ruleset_version
       or v_round.outcome_commitment is distinct from trim(p_outcome_commitment)
       or v_round.outcome is distinct from p_outcome
       or v_wager.payout is distinct from p_payout
       or v_wager.outcome is distinct from p_outcome
       or v_wager.settlement_resolver_id is distinct from trim(p_resolver_id)
       or v_wager.settlement_ruleset_version is distinct from p_ruleset_version
       or (v_action.result ->> 'resolver_id') is distinct from trim(p_resolver_id)
       or (v_action.result ->> 'ruleset_version')::integer is distinct from p_ruleset_version
       or (v_action.result ->> 'outcome_commitment') is distinct from trim(p_outcome_commitment)
       or (v_action.result ->> 'payout')::bigint is distinct from p_payout then
      raise exception 'Settlement retry conflicts with the stored authoritative result' using errcode = '22023';
    end if;
    return query select v_action.id,
      coalesce((v_action.result ->> 'balance_after')::bigint, 0), true;
    return;
  end if;
  select * into v_runtime
  from public.assert_playable_game_runtime(v_wager.player_id, v_wager.catalog_slug);
  if v_runtime.runtime_mode <> 'CLOCKED_SHARED'
     or v_runtime.ruleset_version <> p_ruleset_version then
    raise exception 'Player-paced or mismatched runtime cannot use clocked settlement' using errcode = '55000';
  end if;

  select * into v_wager from public.game_wagers where id = p_wager_id for update;
  if not found then
    raise exception 'Wager not found' using errcode = 'P0001';
  end if;
  select * into v_round from public.game_rounds where id = v_wager.round_id for update;
  if not found
     or v_round.session_id is not null
     or v_round.catalog_slug <> v_runtime.catalog_slug
     or v_round.engine_slug <> v_runtime.engine_slug
     or v_round.ruleset_version <> p_ruleset_version
     or v_round.resolver_id is distinct from trim(p_resolver_id)
     or v_round.outcome_commitment is distinct from trim(p_outcome_commitment)
     or v_round.outcome is distinct from p_outcome then
    raise exception 'Settlement does not match the authoritative shared round' using errcode = '55000';
  end if;

  if v_wager.status = 'SETTLED' then
    select * into v_action from public.game_actions
    where id = v_wager.settlement_action_id;
    if not found
       or v_wager.payout is distinct from p_payout
       or v_wager.outcome is distinct from p_outcome
       or v_wager.settlement_resolver_id is distinct from trim(p_resolver_id)
       or v_wager.settlement_ruleset_version is distinct from p_ruleset_version
       or (v_action.result ->> 'resolver_id') is distinct from trim(p_resolver_id)
       or (v_action.result ->> 'ruleset_version')::integer is distinct from p_ruleset_version
       or (v_action.result ->> 'outcome_commitment') is distinct from trim(p_outcome_commitment)
       or (v_action.result ->> 'payout')::bigint is distinct from p_payout then
      raise exception 'Settlement retry conflicts with the stored authoritative result' using errcode = '22023';
    end if;
    return query select v_action.id,
      coalesce((v_action.result ->> 'balance_after')::bigint, 0), true;
    return;
  end if;
  if v_wager.status <> 'OPEN' then
    raise exception 'Only an open wager can settle' using errcode = '55000';
  end if;
  if clock_timestamp() < v_round.reveal_starts_at then
    raise exception 'Round outcome is not available yet' using errcode = '55000';
  end if;

  v_idempotency_key := 'clocked-resolution-v2:' || trim(p_resolver_id)
    || ':' || p_ruleset_version::text || ':' || v_wager.id::text;
  if char_length(v_idempotency_key) > 160 then
    raise exception 'Settlement idempotency identity is too long' using errcode = '22023';
  end if;
  v_action_id := gen_random_uuid();
  if p_payout > 0 then
    select ledger_id, balance_after into v_ledger_id, v_balance
    from public.apply_game_play_points(
      v_wager.player_id, p_payout, 'PRIZE',
      v_idempotency_key || ':prize', v_wager.catalog_slug, v_round.id::text,
      'READY clocked resolver settled game wager'
    );
  else
    select play_points_balance into v_balance
    from public.profiles where id = v_wager.player_id;
  end if;

  insert into public.game_actions(
    id, player_id, session_id, round_id, catalog_slug, kind,
    idempotency_key, request, result
  ) values (
    v_action_id, v_wager.player_id, v_wager.session_id, v_wager.round_id,
    v_wager.catalog_slug, 'SETTLE', v_idempotency_key,
    jsonb_build_object('wager_id', v_wager.id),
    jsonb_build_object(
      'payout', p_payout,
      'balance_after', v_balance,
      'ledger_id', v_ledger_id,
      'resolver_id', trim(p_resolver_id),
      'ruleset_version', p_ruleset_version,
      'outcome_commitment', trim(p_outcome_commitment)
    )
  );
  update public.game_wagers
  set status = 'SETTLED',
      settlement_action_id = v_action_id,
      prize_ledger_id = v_ledger_id,
      payout = p_payout,
      outcome = p_outcome,
      settlement_resolver_id = trim(p_resolver_id),
      settlement_ruleset_version = p_ruleset_version,
      settled_at = clock_timestamp()
  where id = v_wager.id and status = 'OPEN';
  if not found then
    raise exception 'Open wager changed before settlement' using errcode = '55000';
  end if;

  update public.game_rounds
  set phase = case
        when not exists (
          select 1 from public.game_wagers
          where round_id = v_round.id and status = 'OPEN'
        ) then 'SETTLED'::public.game_round_phase
        when clock_timestamp() >= v_round.result_starts_at then 'RESULT'::public.game_round_phase
        else 'REVEAL'::public.game_round_phase
      end,
      outcome_published_at = coalesce(outcome_published_at, clock_timestamp()),
      settled_at = case
        when not exists (
          select 1 from public.game_wagers
          where round_id = v_round.id and status = 'OPEN'
        ) then coalesce(settled_at, clock_timestamp())
        else settled_at
      end
  where id = v_round.id;
  perform public.emit_game_event(
    v_wager.player_id, v_wager.session_id, v_wager.round_id, v_action_id,
    v_wager.catalog_slug, 'WAGER_SETTLED',
    jsonb_build_object(
      'wager_id', v_wager.id,
      'payout', p_payout,
      'balance_after', v_balance,
      'resolver_id', trim(p_resolver_id),
      'ruleset_version', p_ruleset_version,
      'outcome_commitment', trim(p_outcome_commitment)
    )
  );
  return query select v_action_id, v_balance, false;
end;
$$;

-- Keep phase/publication timestamps current even for a round with no wagers.
-- This RPC never settles or refunds and cannot operate on a player-paced row.
create or replace function public.advance_ready_clocked_game_round(
  p_round_id uuid,
  p_resolver_id text,
  p_ruleset_version integer
)
returns public.game_rounds
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_round public.game_rounds;
begin
  select * into v_round from public.game_rounds where id = p_round_id for update;
  if not found
     or v_round.session_id is not null
     or v_round.resolver_id is distinct from trim(p_resolver_id)
     or v_round.ruleset_version is distinct from p_ruleset_version then
    raise exception 'Clocked round lifecycle identity is invalid' using errcode = '55000';
  end if;
  if clock_timestamp() >= v_round.reveal_starts_at then
    update public.game_rounds
    set phase = case
          when not exists (
            select 1 from public.game_wagers
            where round_id = v_round.id and status = 'OPEN'
          ) then 'SETTLED'::public.game_round_phase
          when clock_timestamp() >= v_round.result_starts_at then 'RESULT'::public.game_round_phase
          else 'REVEAL'::public.game_round_phase
        end,
        outcome_published_at = coalesce(outcome_published_at, clock_timestamp()),
        settled_at = case
          when not exists (
            select 1 from public.game_wagers
            where round_id = v_round.id and status = 'OPEN'
          ) then coalesce(settled_at, clock_timestamp())
          else settled_at
        end
    where id = v_round.id
    returning * into v_round;
  end if;
  return v_round;
end;
$$;

revoke all on function public.prevent_game_round_authority_change()
  from public, anon, authenticated, service_role;
revoke all on function public.create_ready_clocked_game_round(
  text, bigint, timestamptz, timestamptz, timestamptz, timestamptz,
  timestamptz, text, jsonb, text, integer, jsonb
) from public, anon, authenticated;
revoke all on function public.resolve_ready_clocked_game_wager(
  uuid, bigint, jsonb, text, text, integer
) from public, anon, authenticated;
revoke all on function public.advance_ready_clocked_game_round(uuid, text, integer)
  from public, anon, authenticated;

grant execute on function public.create_ready_clocked_game_round(
  text, bigint, timestamptz, timestamptz, timestamptz, timestamptz,
  timestamptz, text, jsonb, text, integer, jsonb
) to service_role;
grant execute on function public.resolve_ready_clocked_game_wager(
  uuid, bigint, jsonb, text, text, integer
) to service_role;
grant execute on function public.advance_ready_clocked_game_round(uuid, text, integer)
  to service_role;
