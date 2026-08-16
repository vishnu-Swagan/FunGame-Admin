-- Aviator — the sixteenth public cabinet, a player-paced crash game.
--
-- Ruleset v1 draws one crash multiplier per flight from P(crash>=m)=(1-edge)/m
-- with edge=0.10, delivered as a 10% instant-bust at 1.00x plus the tail. The
-- player commits a stake and an auto cash-out target in one press; a fixed
-- target returns exactly 90% of stake for every target. The outcome draw and
-- settlement live in the deployed game-api resolver (resolvers/aviator.ts, over
-- the crash core in aviator.ts, registered at ruleset v1 in the code review and
-- live resolver registries). This migration only registers the catalog and
-- runtime rows so the cabinet is advertised and playable, mirroring the shape
-- of the existing player-paced entries.
--
-- The runtime row is inserted directly at its live state: game_runtime_catalog's
-- drain trigger is BEFORE UPDATE only, so a fresh insert cannot leave a wager
-- half-settled, and the table CHECK (availability='ENABLED' requires
-- parity_state='QA_VERIFIED') is satisfied. Every field mirrors the compiled
-- GameSpec/OUTCOME_CONTRACTS for "aviator" exactly, or runtimeContractIssue
-- would refuse to advertise or open the cabinet.

insert into public.games (slug, name, category, display_order, status) values
  ('aviator', 'Aviator', 'Arcade', 160, 'ENABLED')
on conflict (slug) do update set
  name = excluded.name,
  category = excluded.category,
  display_order = excluded.display_order,
  status = excluded.status;

insert into public.game_runtime_catalog (
  catalog_slug, unity_lobby_slug, unity_scene, engine_slug, runtime_mode,
  parity_state, availability, timing, action_contract, outcome_contract,
  rule_source, disabled_reason, min_bet, max_bet, ruleset_version
) values (
  'aviator', 'aviator', 'aviator', 'aviator', 'PLAYER_PACED',
  'QA_VERIFIED', 'ENABLED',
  '{"kind":"player_paced","bet_seconds":null,"lock_seconds":null,"reveal_seconds":4,"result_seconds":null}'::jsonb,
  '["place_bet","clear_bets","collect_full"]'::jsonb,
  '{"type":"crash_flight"}'::jsonb,
  'Unity Engines/AviatorTable.cs + Tables.cs (Aviator)',
  null, 5, 1000, 1
)
on conflict (catalog_slug) do update set
  unity_lobby_slug = excluded.unity_lobby_slug,
  unity_scene = excluded.unity_scene,
  engine_slug = excluded.engine_slug,
  runtime_mode = excluded.runtime_mode,
  parity_state = excluded.parity_state,
  availability = excluded.availability,
  timing = excluded.timing,
  action_contract = excluded.action_contract,
  outcome_contract = excluded.outcome_contract,
  rule_source = excluded.rule_source,
  disabled_reason = excluded.disabled_reason,
  min_bet = excluded.min_bet,
  max_bet = excluded.max_bet,
  ruleset_version = excluded.ruleset_version;
