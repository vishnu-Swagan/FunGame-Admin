-- Align lucky-8-line's stored runtime mode with its compiled contract.
--
-- The catalogue row still said CLOCKED_SHARED while GAME_SPECS and the
-- resolver manifest both declare PLAYER_PACED. That disagreement is not
-- cosmetic: the clocked and single-player settlement paths each admit exactly
-- one mode and refuse the other, so a title whose stored mode contradicts its
-- compiled mode is settleable by neither and fails closed at play time.
--
-- PLAYER_PACED is the correct value: level10 ships no timer object, so there
-- is no shared betting window for this cabinet. The 60/5/5/3 schedule the row
-- carried was a shared default rather than a measurement.
--
-- Forward-only and idempotent: the guard makes a replay a zero-row no-op.

update public.game_runtime_catalog
set runtime_mode = 'PLAYER_PACED'
where catalog_slug = 'lucky-8-line'
  and runtime_mode <> 'PLAYER_PACED';
