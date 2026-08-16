-- Settlement for single-player (PLAYER_PACED) cabinets.
--
-- The clocked lifecycle in 20260815120000 settles many players against one
-- shared round inside a betting window, and every procedure there rejects a
-- PLAYER_PACED cabinet. Poker and reel titles have no shared round at all: one
-- player stakes, the server resolves, and it settles in the same breath.
--
-- This file adds that path without loosening the clocked one. The two remain
-- mutually exclusive: a CLOCKED_SHARED session is rejected here exactly as a
-- PLAYER_PACED session is rejected there.
--
-- Virtual play points only. Nothing here touches cash, deposits or payouts.

-- Stake and prize are separate immutable ledger entries under one action
-- receipt, so a partially-applied hand is impossible: both land or neither does.
create or replace function public.resolve_player_paced_hand(
  p_player_id uuid,
  p_session_id uuid,
  p_stake_points bigint,
  p_selection text,
  p_outcome jsonb,
  p_payout_points bigint,
  p_resolver_id text,
  p_ruleset_version integer,
  p_idempotency_key text
)
returns table(
  action_id uuid,
  stake_ledger_id uuid,
  prize_ledger_id uuid,
  balance_after bigint,
  duplicate boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
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
  select ledger_id, balance_after into v_stake_ledger, v_balance
  from public.apply_game_play_points(
    p_player_id, -p_stake_points, 'STAKE',
    v_key || ':stake', v_session.catalog_slug, null,
    'Single-player hand stake'
  );

  if p_payout_points > 0 then
    select ledger_id, balance_after into v_prize_ledger, v_balance
    from public.apply_game_play_points(
      p_player_id, p_payout_points, 'PRIZE',
      v_key || ':prize', v_session.catalog_slug, null,
      'Single-player hand prize'
    );
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
$$;

revoke all on function public.resolve_player_paced_hand(
  uuid, uuid, bigint, text, jsonb, bigint, text, integer, text
) from public, anon, authenticated;
grant execute on function public.resolve_player_paced_hand(
  uuid, uuid, bigint, text, jsonb, bigint, text, integer, text
) to service_role;
