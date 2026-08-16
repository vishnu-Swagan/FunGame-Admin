-- Grant the service role the game-table reads the Edge Functions perform.
--
-- Same defect as 20260816001000, in five more tables. They carry RLS with no
-- policies, which was intended to mean "definer functions and the service role
-- only". The service role bypasses RLS but NOT table-level GRANTs, and none was
-- issued, so every read failed.
--
-- The observable effect: the lobby advertised all fifteen games as AVAILABLE,
-- and then opening a session returned
--   503 GAME_SERVICE_UNAVAILABLE  "Game wagers could not be reconciled."
-- because the wager reconciliation pass could not read game_wagers at all. No
-- game was actually playable.
--
-- SELECT only. game-api performs no direct INSERT, UPDATE or DELETE on any of
-- these: every write goes through a SECURITY DEFINER procedure that re-checks
-- runtime admission and writes its own receipt. Granting writes here would let
-- a future direct write skip those checks, which on a wager table is the
-- difference between a settled round and an unaudited balance change.
--
-- RLS stays enabled, so anon and authenticated remain fully blocked.

grant select on table public.game_wagers to service_role;
grant select on table public.game_rounds to service_role;
grant select on table public.game_player_sessions to service_role;
grant select on table public.game_actions to service_role;
grant select on table public.game_event_outbox to service_role;
