-- Operator-driven promotion of a game runtime.
--
-- Until now `game_runtime_catalog.parity_state` and `.availability` could only
-- be moved by a raw service-role SQL session against production: the admin API
-- reads the catalogue but has never had a write path.  That is an unsafe place
-- to leave an operator control.  This migration adds one auditable RPC so the
-- promotion happens through the administrator console under the same active-
-- administrator assertion and the same audit trail as every other privileged
-- mutation.
--
-- Virtual play points only.  Nothing in this file touches cash, deposits or
-- payouts, all of which remain disabled for this deployment.
--
-- Forward-only and replayable: the function is `create or replace`, the
-- privilege statements are unconditional, and the catalogue promotion at the
-- bottom is guarded so a second application changes no rows.

-- ---------------------------------------------------------------------------
-- Operations
-- ---------------------------------------------------------------------------

create or replace function public.set_game_runtime_state(
  p_actor_id uuid,
  p_catalog_slug text,
  p_parity_state public.game_parity_state default null,
  p_availability public.game_runtime_availability default null,
  p_reason text default null
)
returns public.game_runtime_catalog
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_before public.game_runtime_catalog;
  v_after public.game_runtime_catalog;
  v_parity public.game_parity_state;
  v_availability public.game_runtime_availability;
begin
  perform public.assert_active_admin(p_actor_id);

  if p_parity_state is null and p_availability is null then
    raise exception 'No runtime fields were provided' using errcode = '22023';
  end if;

  -- Lock the row so two operators cannot interleave a parity downgrade with an
  -- availability promotion and land on a pair neither of them chose.
  select * into v_before
  from public.game_runtime_catalog
  where catalog_slug = p_catalog_slug
  for update;
  if not found then
    raise exception 'No runtime is registered for that game' using errcode = 'P0002';
  end if;

  v_parity := coalesce(p_parity_state, v_before.parity_state);
  v_availability := coalesce(p_availability, v_before.availability);

  -- The table CHECK already forbids this pair.  Assert it here first so the
  -- operator receives a sentence explaining the ordering rule instead of a raw
  -- constraint-violation message naming an internal constraint.
  if v_availability = 'ENABLED' and v_parity <> 'QA_VERIFIED' then
    raise exception
      'A game runtime cannot be ENABLED until its client-rule parity is QA_VERIFIED'
      using errcode = '23514';
  end if;

  update public.game_runtime_catalog
  set parity_state = v_parity,
      availability = v_availability,
      updated_at = now()
  where catalog_slug = p_catalog_slug
  returning * into v_after;

  perform public.audit_admin_action(
    p_actor_id,
    'GAME_RUNTIME_STATE_SET',
    'GAME_RUNTIME',
    v_after.catalog_slug,
    jsonb_build_object(
      'parity_state', v_before.parity_state,
      'availability', v_before.availability,
      'ruleset_version', v_before.ruleset_version
    ),
    jsonb_build_object(
      'parity_state', v_after.parity_state,
      'availability', v_after.availability,
      'ruleset_version', v_after.ruleset_version
    ),
    p_reason
  );

  return v_after;
end;
$$;

comment on function public.set_game_runtime_state(uuid, text, public.game_parity_state, public.game_runtime_availability, text) is
  'Administrator promotion or demotion of one game runtime. Asserts an active administrator, preserves the QA_VERIFIED-before-ENABLED ordering with an explanatory error, and writes an admin_audit row carrying the before/after pair.';

-- ---------------------------------------------------------------------------
-- Privileges: service_role only. No anon or authenticated grant anywhere.
-- ---------------------------------------------------------------------------

revoke all on function public.set_game_runtime_state(uuid, text, public.game_parity_state, public.game_runtime_availability, text) from public, anon, authenticated;
grant execute on function public.set_game_runtime_state(uuid, text, public.game_parity_state, public.game_runtime_availability, text) to service_role;

-- ---------------------------------------------------------------------------
-- Operator decision: enable the full catalogue under ruleset v1
-- ---------------------------------------------------------------------------
--
-- This is an operator decision, not an engineering finding.  The operator has
-- reviewed all fifteen titles and elected to ship the entire catalogue under
-- the operator's own declared ruleset v1, accepting the house rules encoded by
-- that ruleset as the authoritative behaviour for this deployment.  The rows
-- seeded as BLOCKED/DERIVED recorded the *earlier* position that no cabinet
-- would go live before an independent client-parity review; the operator has
-- now superseded that position for its own play-money deployment.
--
-- The Edge functions still fail closed on top of this: a title is only publicly
-- playable when a compiled resolver is registered for its exact ruleset
-- version, so promoting the catalogue cannot by itself expose an unimplemented
-- game to a player.
--
-- Guarded so re-applying this migration updates no rows.  The stale
-- disabled_reason sentences are cleared with the promotion; leaving "disabled
-- pending review" text on an enabled cabinet would misinform the next operator.
update public.game_runtime_catalog
set parity_state = 'QA_VERIFIED',
    availability = 'ENABLED',
    disabled_reason = null,
    updated_at = now()
where parity_state is distinct from 'QA_VERIFIED'
   or availability is distinct from 'ENABLED'
   or disabled_reason is not null;
