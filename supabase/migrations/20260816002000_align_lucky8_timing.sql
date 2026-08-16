-- Align lucky-8-line's stored timing with its compiled contract.
--
-- 20260816000000 moved this cabinet's runtime_mode to PLAYER_PACED but left the
-- timing column holding the old shared-clock shape (kind "stake", 60s betting,
-- 5s lock). The compiled contract now emits PLAYER_PACED(5), and game-core
-- refuses to let a database row silently redefine a cabinet's timing, so the
-- title advertised as UNAVAILABLE in the lobby while every operational switch
-- said ENABLED.
--
-- The target shape matches what PLAYER_PACED(5) produces, and mirrors checker,
-- the reference player-paced row: no betting or lock window, because the hand
-- is dealt on the player's press rather than on a shared clock.
--
-- Forward-only and idempotent: the guard makes a replay a zero-row no-op.

update public.game_runtime_catalog
set timing = jsonb_build_object(
      'kind', 'player_paced',
      'bet_seconds', null,
      'lock_seconds', null,
      'reveal_seconds', 5,
      'result_seconds', null
    )
where catalog_slug = 'lucky-8-line'
  and timing->>'kind' is distinct from 'player_paced';
