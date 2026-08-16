-- Grant the service role the reads the Edge Functions actually perform.
--
-- These three tables carry RLS with no policies, which was intended to mean
-- "only SECURITY DEFINER functions and the service role reach them". That is
-- half right: the service role bypasses RLS, but it does NOT bypass table-level
-- GRANTs, and none was ever issued. The observable effect in production was
-- `permission denied for table game_runtime_catalog` on GET /admin/games, so
-- the operator console listed zero games despite fifteen rows being present.
--
-- SELECT only, deliberately. Every write still goes through a SECURITY DEFINER
-- procedure that asserts an administrator and writes an audit row, so widening
-- these to INSERT/UPDATE would let a future direct write bypass those checks:
--   game_runtime_catalog   <- set_game_runtime_state
--   point_transfers        <- submit/settle/cancel_point_transfer
--   point_collector_accounts <- provision_point_collector
--
-- player_transfer_pins is deliberately NOT granted: it holds PIN hashes and is
-- only ever touched by definer functions, so the service role has no business
-- reading it.
--
-- RLS stays enabled, so anon and authenticated remain fully blocked.

grant select on table public.game_runtime_catalog to service_role;
grant select on table public.point_transfers to service_role;
grant select on table public.point_collector_accounts to service_role;
