-- Qualify the ambiguous `balance_after` selects in the game settlement path.
--
-- Every one of these functions declares `balance_after` as an OUT column and
-- ALSO selects a column of that name out of apply_game_play_points(). Postgres
-- cannot tell the OUT parameter from the result column and raises
--   42702  column reference "balance_after" is ambiguous
-- the moment the statement executes.
--
-- The effect was total and silent: placing a bet, clearing a bet and settling a
-- round all failed, so no game has ever been playable. It stayed hidden because
-- game-api mapped any error mentioning "balance" to INSUFFICIENT_POINTS, so the
-- client was told the player was short of points on an account holding 3800.
--
-- The point-transfer functions were written with the call aliased and are
-- unaffected, which is why transfers worked while games did not.
--
-- Bodies are the live definitions, reproduced verbatim except that the
-- set-returning call is aliased `_pts` and both columns are qualified against
-- it. No other logic is touched.

CREATE OR REPLACE FUNCTION public.submit_game_stake(p_player_id uuid, p_session_id uuid, p_round_id uuid, p_selection text, p_amount bigint, p_idempotency_key text, p_request jsonb DEFAULT '{}'::jsonb)
 RETURNS TABLE(action_id uuid, wager_id uuid, balance_after bigint, duplicate boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
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

  select _pts.ledger_id, _pts.balance_after into v_ledger_id, v_balance
  from public.apply_game_play_points(
    p_player_id, -p_amount, 'STAKE',
    'game-session-v1:' || v_action_id::text || ':stake',
    v_runtime.catalog_slug, v_round.id::text,
    'Server accepted game stake'
  ) _pts;
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
$function$;


CREATE OR REPLACE FUNCTION public.refund_game_wagers(p_player_id uuid, p_session_id uuid, p_round_id uuid, p_kind game_action_kind, p_selection text, p_idempotency_key text, p_request jsonb DEFAULT '{}'::jsonb)
 RETURNS TABLE(action_id uuid, refunded bigint, balance_after bigint, duplicate boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
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

  select _pts.ledger_id, _pts.balance_after into v_ledger_id, v_balance
  from public.apply_game_play_points(
    p_player_id, v_total, 'REFUND',
    'game-session-v1:' || v_action_id::text || ':refund',
    v_runtime.catalog_slug, v_round.id::text,
    'Server returned open game wager'
  ) _pts;
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
$function$;


CREATE OR REPLACE FUNCTION public.resolve_ready_clocked_game_wager(p_wager_id uuid, p_payout bigint, p_outcome jsonb, p_outcome_commitment text, p_resolver_id text, p_ruleset_version integer)
 RETURNS TABLE(action_id uuid, balance_after bigint, duplicate boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
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
    select _pts.ledger_id, _pts.balance_after into v_ledger_id, v_balance
    from public.apply_game_play_points(
      v_wager.player_id, p_payout, 'PRIZE',
      v_idempotency_key || ':prize', v_wager.catalog_slug, v_round.id::text,
      'READY clocked resolver settled game wager'
    ) _pts;
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
$function$;


CREATE OR REPLACE FUNCTION public.resolve_player_paced_hand(p_player_id uuid, p_session_id uuid, p_stake_points bigint, p_selection text, p_outcome jsonb, p_payout_points bigint, p_resolver_id text, p_ruleset_version integer, p_idempotency_key text)
 RETURNS TABLE(action_id uuid, stake_ledger_id uuid, prize_ledger_id uuid, balance_after bigint, duplicate boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
declare
  v_key text := trim(p_idempotency_key);
  v_existing public.game_actions;
  v_session public.game_player_sessions;
  v_runtime public.game_runtime_catalog;
  v_result jsonb;
  v_stake_ledger uuid;
  v_prize_ledger uuid;
  v_balance bigint;
  v_action_id uuid;
begin
  if p_stake_points is null or p_stake_points <= 0 then
    raise exception 'A hand requires a positive whole stake' using errcode = '22023';
  end if;
  if p_payout_points is null or p_payout_points < 0 then
    raise exception 'Payout cannot be negative' using errcode = '22023';
  end if;
  if coalesce(char_length(v_key), 0) not between 8 and 160 then
    raise exception 'Idempotency key is required' using errcode = '22023';
  end if;
  if p_resolver_id is null or p_ruleset_version is null or p_ruleset_version < 1 then
    raise exception 'A resolver identity and ruleset version are required' using errcode = '22023';
  end if;
  if jsonb_typeof(p_outcome) is null then
    raise exception 'A resolved outcome is required' using errcode = '22023';
  end if;

  -- The full authoritative result. A retry must match this exactly, so a
  -- reconnecting client cannot replay one key against a different hand.
  v_result := jsonb_build_object(
    'selection', p_selection,
    'outcome', p_outcome,
    'stake_points', p_stake_points,
    'payout_points', p_payout_points,
    'resolver_id', p_resolver_id,
    'ruleset_version', p_ruleset_version
  );

  -- Replay check runs before the player lock and before any mutation, so a
  -- lost response is answered from the original receipt rather than re-staked.
  select * into v_existing from public.game_actions
  where player_id = p_player_id and idempotency_key = v_key;
  if found then
    if v_existing.result is distinct from v_result then
      raise exception 'Idempotency key was already used for a different hand'
        using errcode = '22023';
    end if;
    select play_points_balance into v_balance
    from public.profiles where id = p_player_id;
    return query select
      v_existing.id,
      (v_existing.result ->> 'stake_ledger_id')::uuid,
      (v_existing.result ->> 'prize_ledger_id')::uuid,
      v_balance,
      true;
    return;
  end if;

  -- Serialize this player's hands against each other.
  perform 1 from public.profiles where id = p_player_id for update;

  select * into v_session from public.game_player_sessions
  where id = p_session_id for update;
  if not found or v_session.player_id <> p_player_id then
    raise exception 'Game session not found' using errcode = 'P0001';
  end if;
  if v_session.status <> 'ACTIVE' then
    raise exception 'That game session is closed' using errcode = '22023';
  end if;
  if v_session.runtime_mode <> 'PLAYER_PACED' then
    raise exception 'Shared clocked runtimes cannot use single-player settlement'
      using errcode = '22023';
  end if;
  if v_session.ruleset_version <> p_ruleset_version then
    raise exception 'The session ruleset does not match the resolving ruleset'
      using errcode = '22023';
  end if;

  -- Re-checks catalogue status, runtime availability, parity and player
  -- eligibility. A title switched off mid-session stops resolving here.
  v_runtime := public.assert_playable_game_runtime(p_player_id, v_session.catalog_slug);
  if v_runtime.runtime_mode <> 'PLAYER_PACED'
     or v_runtime.parity_state <> 'QA_VERIFIED'
     or v_runtime.availability <> 'ENABLED'
     or v_runtime.ruleset_version <> p_ruleset_version then
    raise exception 'This game is not available for single-player settlement'
      using errcode = '22023';
  end if;

  -- Debit first: an insufficient balance must abort before any prize exists.
  select _pts.ledger_id, _pts.balance_after into v_stake_ledger, v_balance
  from public.apply_game_play_points(
    p_player_id, -p_stake_points, 'STAKE',
    v_key || ':stake', v_session.catalog_slug, null,
    'Single-player hand stake'
  ) _pts;

  if p_payout_points > 0 then
    select _pts.ledger_id, _pts.balance_after into v_prize_ledger, v_balance
    from public.apply_game_play_points(
      p_player_id, p_payout_points, 'PRIZE',
      v_key || ':prize', v_session.catalog_slug, null,
      'Single-player hand prize'
    ) _pts;
  end if;

  insert into public.game_actions(
    player_id, session_id, round_id, catalog_slug, kind, status,
    idempotency_key, request, result
  ) values (
    p_player_id, p_session_id, null, v_session.catalog_slug, 'SETTLE', 'APPLIED',
    v_key,
    jsonb_build_object('selection', p_selection, 'stake_points', p_stake_points),
    v_result
      || jsonb_build_object('stake_ledger_id', v_stake_ledger)
      || jsonb_build_object('prize_ledger_id', v_prize_ledger)
  ) returning id into v_action_id;

  update public.game_player_sessions
  set last_seen_at = now()
  where id = p_session_id;

  return query select v_action_id, v_stake_ledger, v_prize_ledger, v_balance, false;
end;
$function$;


CREATE OR REPLACE FUNCTION public.resolve_game_wager(p_wager_id uuid, p_payout bigint, p_outcome jsonb, p_note text DEFAULT NULL::text)
 RETURNS TABLE(action_id uuid, balance_after bigint, duplicate boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
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
    select _pts.ledger_id, _pts.balance_after into v_ledger_id, v_balance
    from public.apply_game_play_points(
      v_wager.player_id, p_payout, 'PRIZE',
      'game-session-v1:' || v_action_id::text || ':prize',
      v_wager.catalog_slug, v_round.id::text,
      coalesce(nullif(trim(p_note), ''), 'Server resolved game wager')
    ) _pts;
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
$function$;
