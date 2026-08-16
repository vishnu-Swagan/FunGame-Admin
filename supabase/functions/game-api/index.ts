// deno-lint-ignore-file no-import-prefix
/**
 * Player-facing, server-authoritative live-game session API.
 *
 * The public routes deliberately mirror Runtime/SupabaseGameServer.cs.  This
 * is a virtual-points-only boundary: it accepts an authenticated player intent
 * and never a client result, payout, ledger delta, or balance.
 */
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  clockState,
  GameRuleError,
  gameSpec,
  isRoundActionPrecondition,
  matchesPersistedGameActionReplay,
  matchesRoundActionPrecondition,
  normalizePlayerAction,
  type NormalizedAction,
  normalizedActionRequest,
  publicClockWire,
  roundActionPrecondition,
  runtimeContractIssue,
  snapshotRevealSeconds,
  type ClockState,
  type GameSpec,
  type RuntimeMode,
} from "./game-core.ts";
import { isPubliclyPlayableRuntime } from "../shared/runtime-availability.ts";
import { hasRegisteredLiveResolver } from "../shared/live-resolver-registry.ts";
import { hasExecutableReviewResolver } from "./resolvers/review-registry.ts";
import {
  generateClockedRoundOutcome,
  generatePlayerPacedOutcome,
  planClockedSettlements,
  planParimutuelClockedRound,
  planPlayerPacedSettlement,
  SettlementLifecycleError,
} from "./settlement-lifecycle.ts";

type Json = Record<string, unknown>;
type Profile = {
  id: string;
  login_id: string;
  account_kind: "PLAYER" | "ADMIN";
  status: string;
  display_name: string | null;
  full_name: string | null;
  play_points_balance: number | string | null;
};
type PlayerActor = { id: string; profile: Profile };
type RuntimeRow = {
  catalog_slug: string;
  unity_lobby_slug: string;
  unity_scene: string;
  engine_slug: string;
  runtime_mode: RuntimeMode;
  parity_state: "BLOCKED" | "DERIVED" | "QA_VERIFIED";
  availability: "DISABLED" | "MAINTENANCE" | "ENABLED";
  timing: Json;
  action_contract: unknown;
  outcome_contract: Json;
  ruleset_version: number;
  min_bet: number | string;
  max_bet: number | string;
  disabled_reason: string | null;
};
type SessionRow = {
  id: string;
  player_id: string;
  catalog_slug: string;
  engine_slug: string;
  runtime_mode: RuntimeMode;
  ruleset_version: number;
  status: string;
  opened_at: string;
  last_seen_at: string;
};
type RoundRow = {
  id: string;
  catalog_slug: string;
  engine_slug: string;
  session_id: string | null;
  round_number: number | string;
  outcome_commitment: string;
  outcome: unknown | null;
  resolver_id: string | null;
  ruleset_version: number;
  reveal_starts_at: string;
  result_starts_at: string;
  ends_at: string;
};
type WagerRow = { id: string; selection: string; amount: number | string; status: string };
type DueWagerRow = WagerRow & { round_id: string };
type GameStatusRow = { slug: string; status: string };
type PersistedActionRow = { session_id: string; round_id: string; kind: string; status: string; request: unknown };

const PROJECT_URL = Deno.env.get("SUPABASE_URL");
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!PROJECT_URL || !ANON_KEY || !SERVICE_ROLE_KEY) {
  throw new Error("Supabase Edge Function environment is incomplete");
}

const ALLOWED_ORIGINS = new Set(["https://mydgp.casino", "https://www.mydgp.casino"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,159}$/;
const MAX_BODY_BYTES = 32 * 1024;
const MAX_EVENT_LIMIT = 100;
const UI_MAX_INT = 2_147_483_647;

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
  }
}

// One client per role for the life of the isolate, not one per request.
// Rebuilding on every call re-ran the client's own startup each time and was a
// measurable slice of the login and lobby latency. The clients are stateless
// here (no session persistence, no auto-refresh), so sharing them is safe.
let _serviceClient: SupabaseClient | null = null;
let _publicClient: SupabaseClient | null = null;

function service(): SupabaseClient {
  return _serviceClient ??= createClient(PROJECT_URL!, SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}

function publicAuth(): SupabaseClient {
  return _publicClient ??= createClient(PROJECT_URL!, ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}

function corsHeaders(req: Request): HeadersInit {
  const origin = req.headers.get("origin");
  return {
    "access-control-allow-origin": origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://mydgp.casino",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, x-idempotency-key",
    "access-control-max-age": "86400",
    "cache-control": "no-store, max-age=0",
    "content-type": "application/json; charset=utf-8",
    "vary": "Origin",
    "x-content-type-options": "nosniff",
  };
}

function response(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders(req) });
}

function ok(req: Request, body: Json, status = 200): Response {
  return response(req, { schema_version: 1, status: "ok", ...body }, status);
}

function routePath(req: Request): string {
  const path = new URL(req.url).pathname;
  const marker = "/game-api";
  const index = path.indexOf(marker);
  return ((index >= 0 ? path.slice(index + marker.length) : path) || "/").replace(/\/+$/, "") || "/";
}

function assertAllowedOrigin(req: Request): void {
  const origin = req.headers.get("origin");
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    throw new HttpError(403, "Origin is not allowed.", "ORIGIN_NOT_ALLOWED");
  }
}

function asRecord(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "A JSON object is required.", "INVALID_BODY");
  }
  return value as Json;
}

async function readBody(req: Request): Promise<Json> {
  const length = Number(req.headers.get("content-length") || "0");
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
    throw new HttpError(413, "Request body is too large.", "BODY_TOO_LARGE");
  }
  try {
    return asRecord(await req.json());
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Invalid JSON request body.", "INVALID_BODY");
  }
}

function requiredUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new HttpError(400, `${label} is invalid.`, "INVALID_ID");
  }
  return value;
}

function wireInteger(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value
    : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > UI_MAX_INT) {
    throw new HttpError(503, `${label} is outside the supported client range.`, "UI_RANGE");
  }
  return parsed;
}

function parseCursor(value: string | null): number {
  if (value === null || value === "") return 0;
  if (!/^\d+$/.test(value)) throw new HttpError(400, "after is invalid.", "INVALID_QUERY");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new HttpError(400, "after is invalid.", "INVALID_QUERY");
  }
  return parsed;
}

/**
 * Map a database failure to a player-facing code.
 *
 * Matching is anchored on the exact sentences the procedures raise, not on
 * loose keywords. The previous `/insufficient|not enough|balance/` matched any
 * message merely containing the word "balance" — including
 * "Virtual play-point balances can only change through the ledger" and every
 * permission error naming a balance column — so unrelated faults were reported
 * to the player as INSUFFICIENT_POINTS. That masked a live outage: staking
 * failed for a completely different reason while the client was told the player
 * was short of points, on an account holding 3800.
 *
 * The genuine shortfall raises SQLSTATE 22003, which is checked first and is
 * unambiguous.
 */
function dbError(
  error: { message?: string; code?: string } | null,
  fallback: string,
): never {
  const source = error?.message || "";
  if (error?.code === "22003" || /insufficient virtual play points/i.test(source)) {
    throw new HttpError(409, "Insufficient virtual play points.", "INSUFFICIENT_POINTS");
  }
  if (/round not found for this game session/i.test(source)) {
    throw new HttpError(409, "This round has already closed.", "ACTION_CLOSED");
  }
  if (/bets are closed|outcome is not available/i.test(source)) {
    throw new HttpError(409, "This round no longer accepts that action.", "ACTION_CLOSED");
  }
  if (/runtime is not available|under maintenance|gameplay is unavailable/i.test(source)) {
    throw new HttpError(409, "This game is not available yet.", "GAME_UNAVAILABLE");
  }
  if (/active game session not found/i.test(source)) {
    throw new HttpError(409, "Open a game session before playing.", "SESSION_REQUIRED");
  }
  if (/idempotency key/i.test(source)) {
    throw new HttpError(409, "This idempotency key belongs to a different action.", "IDEMPOTENCY_CONFLICT");
  }
  // Unmapped faults are operational, not player mistakes. Log the SQLSTATE with
  // the message: without the code, diagnosing this from the outside meant
  // reproducing each RPC by hand against production to find out what actually
  // failed.
  console.error("game-api database error", error?.code || "-", source);
  throw new HttpError(503, fallback, "GAME_SERVICE_UNAVAILABLE");
}

function rpcOne<T>(
  data: T | T[] | null,
  error: { message?: string; code?: string } | null,
  fallback: string,
): T {
  if (error || data === null) dbError(error, fallback);
  const value = Array.isArray(data) ? data[0] : data;
  if (!value) throw new HttpError(503, fallback, "GAME_SERVICE_UNAVAILABLE");
  return value;
}

// A validated token → user-id cache with a short TTL.
//
// The client polls session state about once a second, and every poll re-ran a
// network round-trip to Supabase Auth to validate the same JWT. That round-trip
// was the largest part of each authenticated request. Caching the validated
// (token → user id) for a few seconds removes it from the hot path without
// weakening the boundary: an entry lives at most TTL, and it caches only the
// fact that this exact token validated — the profile row (balance, status) is
// still read fresh on every call, so a suspension or balance change is never
// stale. The token's own signed expiry still bounds its lifetime.
const AUTH_CACHE_TTL_MS = 5_000;
const _authCache = new Map<string, { userId: string; expiresAt: number }>();

async function validatedUserId(token: string): Promise<string> {
  const now = Date.now();
  const cached = _authCache.get(token);
  if (cached && cached.expiresAt > now) return cached.userId;
  const { data: userData, error: userError } = await publicAuth().auth.getUser(token);
  if (userError || !userData.user) {
    _authCache.delete(token);
    throw new HttpError(401, "Player session is invalid or expired.", "AUTH_INVALID");
  }
  // Bound the map: this is one warm isolate, but a long-lived one should not
  // accumulate every token it has ever seen.
  if (_authCache.size > 500) _authCache.clear();
  _authCache.set(token, { userId: userData.user.id, expiresAt: now + AUTH_CACHE_TTL_MS });
  return userData.user.id;
}

async function requirePlayer(req: Request): Promise<PlayerActor> {
  const token = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token) throw new HttpError(401, "Player authentication is required.", "AUTH_REQUIRED");
  const userId = await validatedUserId(token);
  const { data: profile, error } = await service().from("profiles")
    .select("id,login_id,account_kind,status,display_name,full_name,play_points_balance")
    .eq("id", userId).maybeSingle<Profile>();
  if (error || !profile || profile.account_kind !== "PLAYER" || profile.status !== "ACTIVE") {
    throw new HttpError(403, "An active player account is required.", "PLAYER_REQUIRED");
  }
  return { id: userId, profile };
}

function publicPlayer(actor: PlayerActor): Json {
  return {
    id: actor.profile.id,
    login_id: actor.profile.login_id,
    display_name: actor.profile.display_name || actor.profile.full_name || actor.profile.login_id,
  };
}

async function currentBalance(playerId: string): Promise<number> {
  const { data, error } = await service().from("profiles").select("play_points_balance")
    .eq("id", playerId).eq("account_kind", "PLAYER").maybeSingle<{ play_points_balance: number | string }>();
  if (error || !data) dbError(error, "Balance is unavailable.");
  return wireInteger(data.play_points_balance, "balance");
}

function assertRuntimeMap(runtime: RuntimeRow, spec: GameSpec): void {
  const issue = runtimeContractIssue(spec, runtime);
  if (issue) {
    console.error("game-api runtime contract mismatch", runtime.catalog_slug, issue);
    throw new HttpError(503, "Game configuration needs review.", "RUNTIME_MAP_MISMATCH");
  }
}

async function assertPlayableRuntime(actor: PlayerActor, catalogSlug: string): Promise<{ runtime: RuntimeRow; spec: GameSpec }> {
  const spec = gameSpec(catalogSlug);
  const { data, error } = await service().rpc("assert_playable_game_runtime", {
    p_player_id: actor.id,
    p_catalog_slug: catalogSlug,
  });
  const runtime = rpcOne<RuntimeRow>(data as RuntimeRow | RuntimeRow[] | null, error, "Game runtime is unavailable.");
  assertRuntimeMap(runtime, spec);
  // Database approval is necessary but not sufficient.  A session can only be
  // created when this deployed bundle has an explicit resolver for exactly
  // the persisted ruleset version.
  if (!hasRegisteredLiveResolver(runtime.catalog_slug, runtime.ruleset_version) ||
      !hasExecutableReviewResolver(runtime.catalog_slug, runtime.ruleset_version)) {
    throw new HttpError(409, "This game is not available yet.", "GAME_UNAVAILABLE");
  }
  return { runtime, spec };
}

async function runtimeCatalog(): Promise<RuntimeRow[]> {
  const { data, error } = await service().from("game_runtime_catalog").select(
    "catalog_slug,unity_lobby_slug,unity_scene,engine_slug,runtime_mode,parity_state,availability,timing,action_contract,outcome_contract,ruleset_version,min_bet,max_bet,disabled_reason",
  ).order("catalog_slug", { ascending: true }).returns<RuntimeRow[]>();
  if (error) dbError(error, "Game lobby is unavailable.");
  return data || [];
}

async function gameStatuses(): Promise<Map<string, string>> {
  const { data, error } = await service().from("games").select("slug,status")
    .returns<GameStatusRow[]>();
  if (error) dbError(error, "Game lobby is unavailable.");
  return new Map((data || []).map((game) => [game.slug, game.status]));
}

function isAdvertisableRuntime(runtime: RuntimeRow, gameStatus: string | undefined): boolean {
  if (!isPubliclyPlayableRuntime(gameStatus, runtime)) return false;
  if (!hasExecutableReviewResolver(runtime.catalog_slug, runtime.ruleset_version)) return false;
  try {
    return runtimeContractIssue(gameSpec(runtime.catalog_slug), runtime) === null;
  } catch {
    // Do not send a player to a cabinet whose local contract cannot be
    // verified. The session gate repeats this check before any RPC is opened.
    return false;
  }
}

async function sessionFor(actor: PlayerActor, sessionId: string): Promise<SessionRow> {
  const { data, error } = await service().from("game_player_sessions").select(
    "id,player_id,catalog_slug,engine_slug,runtime_mode,ruleset_version,status,opened_at,last_seen_at",
  ).eq("id", sessionId).eq("player_id", actor.id).eq("status", "ACTIVE").maybeSingle<SessionRow>();
  if (error) dbError(error, "Game session is unavailable.");
  if (!data) throw new HttpError(404, "Game session was not found.", "SESSION_NOT_FOUND");
  return data;
}

async function openSession(actor: PlayerActor, catalogSlug: string): Promise<{ session: SessionRow; runtime: RuntimeRow; spec: GameSpec }> {
  const { runtime, spec } = await assertPlayableRuntime(actor, catalogSlug);
  const { data, error } = await service().rpc("open_game_player_session", {
    p_player_id: actor.id,
    p_catalog_slug: catalogSlug,
  });
  const session = rpcOne<SessionRow>(data as SessionRow | SessionRow[] | null, error, "Could not open game session.");
  if (session.player_id !== actor.id || session.catalog_slug !== catalogSlug || session.engine_slug !== spec.engine_slug) {
    throw new HttpError(503, "Game session needs review.", "SESSION_INVALID");
  }
  return { session, runtime, spec };
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function asRoundRow(value: unknown): RoundRow {
  if (!value || typeof value !== "object") {
    throw new HttpError(503, "Game round is unavailable.", "ROUND_INVALID");
  }
  return value as RoundRow;
}

async function ensureClockedRound(spec: GameSpec, runtime: RuntimeRow): Promise<{ clock: ClockState; round: RoundRow }> {
  if (spec.runtime_mode !== "CLOCKED_SHARED") {
    throw new HttpError(409, "This player-paced cabinet has not been enabled.", "GAME_UNAVAILABLE");
  }
  const clock = clockState(spec, Date.now());
  const generated = generateClockedRoundOutcome(runtime);
  const { data, error } = await service().rpc("create_ready_clocked_game_round", {
    p_catalog_slug: spec.catalog_slug,
    p_round_number: clock.round_number,
    p_starts_at: clock.starts_at,
    p_betting_closes_at: clock.betting_closes_at,
    p_reveal_starts_at: clock.reveal_starts_at,
    p_result_starts_at: clock.result_starts_at,
    p_ends_at: clock.ends_at,
    p_outcome_commitment: await sha256Hex(JSON.stringify(generated.outcome)),
    p_outcome: generated.outcome,
    p_resolver_id: generated.resolver_id,
    p_ruleset_version: generated.ruleset_version,
    p_metadata: { lifecycle: "ready-clocked-v2" },
  });
  const round = asRoundRow(rpcOne<unknown>(data, error, "Could not prepare game round."));
  if (!UUID_RE.test(round.id) || round.catalog_slug !== spec.catalog_slug || round.engine_slug !== spec.engine_slug ||
      round.session_id !== null || round.resolver_id !== generated.resolver_id ||
      wireInteger(round.ruleset_version, "ruleset version") !== runtime.ruleset_version ||
      wireInteger(round.round_number, "round number") !== clock.round_number || !round.outcome) {
    throw new HttpError(503, "Game round needs review.", "ROUND_INVALID");
  }
  return { clock, round };
}

/**
 * Reconcile every due OPEN wager for this player/session before returning a
 * balance. This includes older shared rounds so a missed reveal poll cannot
 * leave a stake behind when the player later resumes the cabinet.
 */
async function settleDueClockedWagers(
  actor: PlayerActor,
  session: SessionRow,
  runtime: RuntimeRow,
): Promise<void> {
  if (runtime.runtime_mode !== "CLOCKED_SHARED") {
    throw new HttpError(409, "Player-paced games cannot use clocked settlement.", "GAME_UNAVAILABLE");
  }
  for (let batch = 0; batch < 20; batch++) {
    // Which rounds does THIS player have OPEN money in, past reveal? That set
    // decides which rounds to settle; the settlement itself covers the WHOLE
    // round's book across every player, because a pari-mutuel payout depends on
    // the entire pool.
    const { data: mine, error: mineError } = await service().from("game_wagers")
      .select("round_id")
      .eq("player_id", actor.id)
      .eq("session_id", session.id)
      .eq("status", "OPEN")
      .limit(200)
      .returns<{ round_id: string }[]>();
    if (mineError) dbError(mineError, "Game wagers could not be reconciled.");
    if (!mine?.length) return;

    const roundIds = [...new Set(mine.map((w) => w.round_id))];
    const { data: rounds, error: roundError } = await service().from("game_rounds")
      .select("id,catalog_slug,engine_slug,session_id,round_number,outcome_commitment,outcome,resolver_id,ruleset_version,reveal_starts_at,result_starts_at,ends_at")
      .in("id", roundIds)
      .returns<RoundRow[]>();
    if (roundError) dbError(roundError, "Game rounds could not be reconciled.");
    const dueRounds = (rounds || []).filter((round) =>
      round.outcome !== null && Date.parse(round.reveal_starts_at) <= Date.now()
    );
    if (!dueRounds.length) return;

    for (const round of dueRounds) {
      // The full round book: every player, every status. Settled wagers still
      // count toward the pool, so a round settled in two passes (two players
      // polling) computes the same payouts both times.
      const { data: book, error: bookError } = await service().from("game_wagers")
        .select("id,player_id,selection,amount,status")
        .eq("round_id", round.id)
        .limit(4000)
        .returns<Array<{ id: string; player_id: string; selection: string; amount: number | string; status: string }>>();
      if (bookError) dbError(bookError, "Game wagers could not be reconciled.");
      if (!book?.length) continue;

      const plan = planParimutuelClockedRound(runtime, {
        id: round.id,
        catalog_slug: round.catalog_slug,
        ruleset_version: wireInteger(round.ruleset_version, "ruleset version"),
        runtime_mode: "CLOCKED_SHARED",
        session_id: round.session_id as null,
        outcome_commitment: round.outcome_commitment,
        outcome: round.outcome,
      }, book);

      const payoutByWager = new Map(plan.payouts.map((p) => [p.wager_id, p.payout_points]));
      // Settle only the wagers still OPEN; the per-wager RPC is atomic and
      // no-ops an already-settled one. Order by id for a stable lock order.
      const open = book.filter((w) => w.status === "OPEN").sort((a, b) => a.id.localeCompare(b.id));
      for (const wager of open) {
        const { data, error } = await service().rpc("resolve_ready_clocked_game_wager", {
          p_wager_id: wager.id,
          p_payout: payoutByWager.get(wager.id) ?? 0,
          p_outcome: plan.outcome,
          p_outcome_commitment: plan.outcome_commitment,
          p_resolver_id: plan.resolver_id,
          p_ruleset_version: plan.ruleset_version,
        });
        rpcOne<unknown>(data, error, "Game wager could not be settled.");
      }
    }
  }
  throw new HttpError(503, "Game settlement backlog requires another worker pass.", "SETTLEMENT_BACKLOG");
}

async function wagersFor(actor: PlayerActor, sessionId: string, roundId: string): Promise<WagerRow[]> {
  const { data, error } = await service().from("game_wagers").select("id,selection,amount,status")
    .eq("player_id", actor.id).eq("session_id", sessionId).eq("round_id", roundId)
    .order("placed_at", { ascending: true }).returns<WagerRow[]>();
  if (error) dbError(error, "Game wagers are unavailable.");
  return data || [];
}

async function eventCursor(actor: PlayerActor, sessionId: string): Promise<number> {
  const { data, error } = await service().from("game_event_outbox").select("event_id")
    .eq("player_id", actor.id).eq("session_id", sessionId)
    .order("event_id", { ascending: false }).limit(1).returns<Array<{ event_id: number | string }>>();
  if (error) dbError(error, "Game events are unavailable.");
  return data?.length ? wireInteger(data[0].event_id, "event cursor") : 0;
}

function allowedActions(spec: GameSpec, clock: ClockState, openWagers: WagerRow[]): string[] {
  // A specific cabinet resolver may offer more after its parity tests are
  // installed.  This generic clocked path knows only stake/refund semantics.
  if (clock.phase !== "BETTING" || !clock.bets_open) return [];
  const actions: string[] = [];
  if (spec.actions.includes("place_bet")) actions.push("place_bet");
  if (openWagers.length && spec.actions.includes("clear_bets")) actions.push("clear_bets");
  if (openWagers.length && spec.actions.includes("cancel_bet")) actions.push("cancel_bet");
  return actions;
}

function publicReveal(outcome: unknown | null): Json | null {
  if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) return null;
  const value = outcome as Json;
  if (typeof value.pocket === "string") return { pocket: value.pocket };
  if (Number.isSafeInteger(value.digit)) return { pocket: String(value.digit) };
  if (typeof value.multiplier === "number" && Number.isFinite(value.multiplier)) {
    return { multiplier: value.multiplier };
  }
  if (Array.isArray(value.drawn) && value.drawn.every((item) => Number.isSafeInteger(item))) {
    return { sequence: value.drawn.map(String) };
  }
  return null;
}

type Snapshot = {
  body: Json;
  clock: ClockState;
  /** Null on a single-player cabinet: those have no shared round. */
  round: RoundRow | null;
  openWagers: WagerRow[];
  allowed: string[];
  actionPrecondition: string;
};

/**
 * Some cabinets take a structured selection rather than a token: the reel
 * machine stakes eight lines independently. The wire field is a string, so a
 * JSON selection is parsed back to the object its resolver expects. A plain
 * token is passed through untouched.
 */
function pacedSelection(selection: string | undefined, catalogSlug: string, stake: number): unknown {
  // "__stake__" is the normalizer's sentinel for a stake-only table, not a
  // selection a resolver understands. It means the same thing as no selection
  // at all: stake the machine, let the cabinet default decide the shape.
  const raw = (selection && selection !== "__stake__")
    ? selection
    : pacedDefaultSelection(catalogSlug, stake);
  if (raw.startsWith("{")) {
    try {
      return JSON.parse(raw);
    } catch {
      throw new HttpError(400, "That selection is not valid for this table.", "INVALID_SELECTION");
    }
  }
  return raw;
}

/**
 * The selection a single-player cabinet stakes with when the client sends none.
 *
 * These machines have no felt: the player stakes the machine itself rather than
 * picking a position, so the resolver still needs the one selection token it
 * recognises. Each is that module's own accepted value, not a shared default —
 * they genuinely differ, and a wrong token fails the resolver rather than
 * silently pricing the wrong bet.
 */
function pacedDefaultSelection(catalogSlug: string, stake: number): string {
  switch (catalogSlug) {
    case "checker":
      return "cell:3-3";
    case "lucky-8-line": {
      // The reel machine settles the eight line stakes it was dealt, and its
      // settle() refuses any staked total that differs from their sum. So the
      // default selection distributes the player's stake across the eight
      // lines exactly: floor per line, remainder one point at a time from the
      // first line. Every point staked lands on a line, none invented.
      const per = Math.floor(stake / 8);
      const rem = stake % 8;
      const lines = Array.from({ length: 8 }, (_, i) => per + (i < rem ? 1 : 0));
      return JSON.stringify({ line_stakes: lines });
    }
    default:
      return "hand";
  }
}

/**
 * The one action a single-player cabinet exposes.
 *
 * Most deal. The reel machines have no deal control at all and stake straight
 * from place_bet, so the paced path accepts whichever of the two that cabinet
 * actually declares rather than assuming every machine has a DEAL button.
 */
function pacedActions(spec: GameSpec): string[] {
  if (spec.actions.includes("deal")) return ["deal"];
  if (spec.actions.includes("place_bet")) return ["place_bet"];
  return [];
}

/**
 * State for a single-player cabinet.
 *
 * There is no shared round and no betting window: the hand is dealt on the
 * player's press and settles in the same request. So the snapshot carries no
 * round, and the clock is a constant that reports "open" — a countdown here
 * would be a fiction the client then rendered.
 *
 * `deal` is the only action. Placing a stake and resolving it are one atomic
 * operation in resolve_player_paced_hand, which is what keeps a hand from
 * existing in a half-staked state.
 */
async function pacedSnapshot(
  actor: PlayerActor,
  session: SessionRow,
  spec: GameSpec,
): Promise<Snapshot> {
  const [balance, cursor] = await Promise.all([
    currentBalance(actor.id),
    eventCursor(actor, session.id),
  ]);
  const clock: ClockState = {
    round_number: 0,
    phase: "BETTING",
    bets_open: true,
    starts_at: new Date().toISOString(),
    betting_closes_at: new Date().toISOString(),
    reveal_starts_at: new Date().toISOString(),
    result_starts_at: new Date().toISOString(),
    ends_at: new Date().toISOString(),
    phase_ends_in: 0,
  } as unknown as ClockState;
  const state: Json = {
    round_number: 0,
    phase: "BETTING",
    server_time_unix_ms: Date.now(),
    phase_ends_at_unix_ms: 0,
    phase_ends_in: 0,
    bets_open: true,
    balance,
    my_total: 0,
    min_bet: spec.min_bet,
    max_bet: spec.max_bet,
    last_payout: 0,
    runtime_mode: "PLAYER_PACED",
  };
  return {
    body: {
      schema_version: 1,
      status: "ok",
      session_id: session.id,
      cursor,
      // Reuses the round precondition shape, bound to the session instead of a
    // round: a single-player cabinet has no round, but the action must still be
    // bound to the state the player actually saw, and one validated format is
    // better than a second one to keep in step.
    action_precondition: roundActionPrecondition(session.id),
      allowed_actions: pacedActions(spec),
      state,
    },
    clock,
    round: null,
    openWagers: [],
    allowed: pacedActions(spec),
    actionPrecondition: roundActionPrecondition(session.id),
  };
}

async function snapshot(actor: PlayerActor, session: SessionRow, runtime: RuntimeRow, spec: GameSpec): Promise<Snapshot> {
  if (spec.runtime_mode === "PLAYER_PACED") {
    return await pacedSnapshot(actor, session, spec);
  }
  const { clock, round } = await ensureClockedRound(spec, runtime);
  await settleDueClockedWagers(actor, session, runtime);
  const { data: advanced, error: advanceError } = await service().rpc("advance_ready_clocked_game_round", {
    p_round_id: round.id,
    p_resolver_id: round.resolver_id,
    p_ruleset_version: runtime.ruleset_version,
  });
  const currentRound = asRoundRow(rpcOne<unknown>(advanced, advanceError, "Could not advance game round."));
  const [balance, wagers, cursor] = await Promise.all([
    currentBalance(actor.id), wagersFor(actor, session.id, currentRound.id), eventCursor(actor, session.id),
  ]);
  const openWagers = wagers.filter((wager) => wager.status === "OPEN");
  const bets = openWagers.map((wager) => ({
    selection: wager.selection,
    amount: wireInteger(wager.amount, "bet amount"),
  }));
  const myTotal = wireInteger(bets.reduce((total, wager) => total + wager.amount, 0), "my_total");
  const allowed = allowedActions(spec, clock, openWagers);
  const publicOutcome = clock.phase === "BETTING" ? null : currentRound.outcome;
  const clockWire = publicClockWire(clock);
  const actionPrecondition = roundActionPrecondition(currentRound.id);
  const state: Json = {
    round_number: wireInteger(currentRound.round_number, "round number"),
    phase: clockWire.phase,
    // Unity consumes these exact numeric server timestamps. It may render a
    // local countdown from them, but must use `bets_open` rather than guessing
    // whether an apparent BETTING phase still accepts a stake.
    server_time_unix_ms: clockWire.server_time_unix_ms,
    phase_ends_at_unix_ms: clockWire.phase_ends_at_unix_ms,
    phase_ends_in: clockWire.phase_ends_in,
    bets_open: clockWire.bets_open,
    balance,
    my_total: myTotal,
    min_bet: spec.min_bet,
    max_bet: spec.max_bet,
    last_payout: 0,
    // Unity uses this as the full animation duration. `phase_ends_in` above
    // is the only clock that counts down between polls; feeding it here would
    // change the speed/restart position halfway through a reveal.
    reveal_seconds: snapshotRevealSeconds(spec),
    outcome_json: publicOutcome ? JSON.stringify(publicOutcome) : null,
    my_bets: bets,
    paytable: [],
    history: [],
    readouts: [],
    options: [],
    reveal: publicReveal(publicOutcome),
    allowed_actions: allowed,
  };
  return {
    body: {
      session_id: session.id,
      cursor,
      action_precondition: actionPrecondition,
      allowed_actions: allowed,
      state,
    },
    clock,
    round: currentRound,
    openWagers,
    allowed,
    actionPrecondition,
  };
}

function rejectUntrustedFields(body: Json): void {
  for (const key of ["outcome", "payout", "prize", "delta", "balance", "balance_after", "ledger_id", "round_id", "player_id", "seed", "multiplier"]) {
    if (key in body) throw new HttpError(400, `Client-supplied ${key} is not accepted.`, "UNTRUSTED_FIELD");
  }
}

type ActionRequest = {
  action: string;
  selection?: string;
  amount?: number;
  idempotencyKey: string;
  actionPrecondition: string;
};
function actionRequest(req: Request, body: Json): ActionRequest {
  rejectUntrustedFields(body);
  const allowed = new Set(["action", "selection", "amount", "idempotency_key", "action_precondition"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw new HttpError(400, "Unsupported action field.", "INVALID_ACTION");
  }
  if (typeof body.action !== "string" || !/^[a-z_]{3,20}$/.test(body.action)) {
    throw new HttpError(400, "Action is invalid.", "INVALID_ACTION");
  }
  if (body.selection !== undefined && (typeof body.selection !== "string" || body.selection.length > 160)) {
    throw new HttpError(400, "selection is invalid.", "INVALID_ACTION");
  }
  if (body.amount !== undefined && (typeof body.amount !== "number" || !Number.isSafeInteger(body.amount) || body.amount < 1)) {
    throw new HttpError(400, "amount is invalid.", "INVALID_ACTION");
  }
  if (typeof body.idempotency_key !== "string" || !IDEMPOTENCY_RE.test(body.idempotency_key)) {
    throw new HttpError(400, "idempotency_key must be 8-160 safe characters.", "IDEMPOTENCY_KEY_REQUIRED");
  }
  if (!isRoundActionPrecondition(body.action_precondition)) {
    throw new HttpError(400, "action_precondition is required and invalid.", "ACTION_PRECONDITION_REQUIRED");
  }
  const header = req.headers.get("x-idempotency-key")?.trim();
  if (header && header !== body.idempotency_key) {
    throw new HttpError(400, "Conflicting idempotency keys.", "IDEMPOTENCY_CONFLICT");
  }
  return {
    action: body.action,
    selection: body.selection as string | undefined,
    amount: body.amount as number | undefined,
    idempotencyKey: body.idempotency_key,
    actionPrecondition: body.action_precondition,
  };
}

/**
 * Find an already-applied intent before consulting the current round clock.
 * A response can be lost after the RPC commits; by the time Unity retries, the
 * original round may be locked or over.  Re-running phase admission first would
 * strand the client's pending idempotency key even though its ledger receipt
 * already exists.
 */
async function hasAppliedActionReplay(
  actor: PlayerActor,
  session: SessionRow,
  idempotencyKey: string,
  internalAction: Parameters<typeof matchesPersistedGameActionReplay>[2],
  request: Record<string, string | number>,
  actionPrecondition: string,
): Promise<boolean> {
  const { data, error } = await service().from("game_actions")
    .select("session_id,round_id,kind,status,request")
    .eq("player_id", actor.id)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle<PersistedActionRow>();
  if (error) dbError(error, "Could not reconcile the game action.");
  if (!data) return false;
  if (!matchesPersistedGameActionReplay(
    data,
    session.id,
    internalAction,
    request,
    actionPrecondition,
  )) {
    throw new HttpError(
      409,
      "This idempotency key belongs to a different action.",
      "IDEMPOTENCY_CONFLICT",
    );
  }
  return true;
}

async function lobby(req: Request): Promise<Response> {
  const actor = await requirePlayer(req);
  const [balance, catalog, statuses] = await Promise.all([
    currentBalance(actor.id),
    runtimeCatalog(),
    gameStatuses(),
  ]);
  const games = catalog.map((runtime) => ({
    catalog_slug: runtime.catalog_slug,
    unity_lobby_slug: runtime.unity_lobby_slug,
    unity_scene: runtime.unity_scene,
    engine_slug: runtime.engine_slug,
    runtime_mode: runtime.runtime_mode,
    // The same gate is used by the administrator console and the session RPC.
    // An operator disabling the catalogue entry must immediately make a
    // previously verified runtime unavailable in the player lobby too.
    availability: isAdvertisableRuntime(runtime, statuses.get(runtime.catalog_slug))
      ? "AVAILABLE"
      : "UNAVAILABLE",
    ruleset_version: runtime.ruleset_version,
  }));
  return ok(req, { player: publicPlayer(actor), balance, games, virtual_points_only: true });
}

async function createSession(req: Request): Promise<Response> {
  const actor = await requirePlayer(req);
  const body = await readBody(req);
  if (Object.keys(body).length !== 1 || typeof body.game_slug !== "string" || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(body.game_slug)) {
    throw new HttpError(400, "game_slug is invalid.", "INVALID_GAME");
  }
  const { session, runtime, spec } = await openSession(actor, body.game_slug);
  return ok(req, (await snapshot(actor, session, runtime, spec)).body, 201);
}

async function getSession(req: Request, sessionId: string): Promise<Response> {
  const actor = await requirePlayer(req);
  const session = await sessionFor(actor, sessionId);
  const { runtime, spec } = await assertPlayableRuntime(actor, session.catalog_slug);
  if (session.engine_slug !== spec.engine_slug || session.runtime_mode !== spec.runtime_mode) {
    throw new HttpError(503, "Game session needs review.", "SESSION_INVALID");
  }
  return ok(req, (await snapshot(actor, session, runtime, spec)).body);
}

/**
 * Deal and settle one single-player hand.
 *
 * The server generates the outcome from the registered resolver, prices it with
 * that resolver's own settle(), and hands the database a stake and a payout to
 * apply in one transaction. The client never sees the outcome before it is
 * committed, and never supplies it.
 *
 * The resolver's arithmetic is re-validated by planPlayerPacedSettlement before
 * anything is written, so a resolver returning an inconsistent net cannot move
 * a balance.
 */
async function dealPacedHand(
  req: Request,
  actor: PlayerActor,
  session: SessionRow,
  runtime: RuntimeRow,
  spec: GameSpec,
  normalized: NormalizedAction,
  incoming: { idempotencyKey: string; amount?: number | null },
  request: Json,
): Promise<Response> {
  const identity = {
    catalog_slug: spec.catalog_slug,
    ruleset_version: runtime.ruleset_version,
    runtime_mode: "PLAYER_PACED" as const,
  };
  // `deal` carries no amount through the normalizer, so the stake comes from
  // the raw request. A single-player hand stakes and settles in one press,
  // so there is no earlier action that could have carried it.
  const stake = typeof normalized.amount === "number"
    ? normalized.amount
    : incoming.amount;
  if (!Number.isSafeInteger(stake) || (stake as number) < spec.min_bet || (stake as number) > spec.max_bet) {
    throw new HttpError(400, "That stake is not accepted at this table.", "INVALID_STAKE");
  }

  let plan;
  try {
    const generated = generatePlayerPacedOutcome(identity);
    plan = planPlayerPacedSettlement(identity, {
      session_id: session.id,
      catalog_slug: spec.catalog_slug,
      ruleset_version: runtime.ruleset_version,
      runtime_mode: "PLAYER_PACED",
      selection: pacedSelection(normalized.selection, spec.catalog_slug, stake as number),
      stake_points: stake as number,
      outcome: generated.outcome,
    });
  } catch (error) {
    // A resolver that cannot generate or price its own hand is an operational
    // fault, not something the player did.
    console.error("game-api paced settlement", spec.catalog_slug, String(error));
    throw new HttpError(503, "This game could not be dealt.", "GAME_SERVICE_UNAVAILABLE");
  }

  const { data, error } = await service().rpc("resolve_player_paced_hand", {
    p_player_id: actor.id,
    p_session_id: session.id,
    p_stake_points: plan.stake_points,
    p_selection: (normalized.selection && normalized.selection !== "__stake__")
      ? normalized.selection
      : pacedDefaultSelection(spec.catalog_slug, stake as number),
    p_outcome: plan.outcome,
    p_payout_points: plan.payout_points,
    p_resolver_id: plan.resolver_id,
    p_ruleset_version: plan.ruleset_version,
    p_idempotency_key: incoming.idempotencyKey,
  });
  rpcOne<unknown>(data, error, "Could not deal this hand.");

  const after = await snapshot(actor, session, runtime, spec);
  const body = after.body as Record<string, unknown>;
  const state = (body.state || {}) as Record<string, unknown>;
  state.last_payout = plan.payout_points;
  state.outcome = plan.outcome;
  body.state = state;
  return ok(req, body as Json);
}

async function act(req: Request, sessionId: string): Promise<Response> {
  const actor = await requirePlayer(req);
  const session = await sessionFor(actor, sessionId);
  const { runtime, spec } = await assertPlayableRuntime(actor, session.catalog_slug);
  const incoming = actionRequest(req, await readBody(req));
  const normalized = normalizePlayerAction(spec, incoming.action, {
    selection: incoming.selection,
    amount: incoming.amount,
  });
  const request = normalizedActionRequest(normalized);

  // This lookup is deliberately before snapshot()/allowed-actions. A retry of
  // an action that already committed must return a current authoritative state
  // even after the original round has locked or rolled over.
  if (await hasAppliedActionReplay(
    actor,
    session,
    incoming.idempotencyKey,
    normalized.internal_action,
    request,
    incoming.actionPrecondition,
  )) {
    return ok(req, (await snapshot(actor, session, runtime, spec)).body);
  }

  const before = await snapshot(actor, session, runtime, spec);

  // A single-player cabinet takes one action: deal. Stake and settlement are a
  // single atomic operation, so there is no round to precondition against and
  // no window that can close between the press and the result.
  if (spec.runtime_mode === "PLAYER_PACED") {
    if (!before.allowed.includes(normalized.action)) {
      throw new HttpError(409, "That action is not available in the current game state.", "ACTION_UNAVAILABLE");
    }
    return await dealPacedHand(req, actor, session, runtime, spec, normalized, incoming, request);
  }

  if (!before.round) {
    throw new HttpError(503, "Game round is unavailable.", "ROUND_INVALID");
  }
  if (!matchesRoundActionPrecondition(incoming.actionPrecondition, before.round.id)) {
    throw new HttpError(
      409,
      "The game round changed before this action was accepted.",
      "ACTION_PRECONDITION_FAILED",
    );
  }
  if (!before.allowed.includes(normalized.action)) {
    throw new HttpError(409, "That action is not available in the current game state.", "ACTION_UNAVAILABLE");
  }
  if (normalized.action === "place_bet") {
    const { data, error } = await service().rpc("submit_game_stake", {
      p_player_id: actor.id,
      p_session_id: session.id,
      p_round_id: before.round.id,
      p_selection: normalized.selection,
      p_amount: normalized.amount,
      p_idempotency_key: incoming.idempotencyKey,
      p_request: request,
    });
    rpcOne<unknown>(data, error, "Could not place game stake.");
  } else if (normalized.action === "clear_bets" || normalized.action === "cancel_bet") {
    const { data, error } = await service().rpc("refund_game_wagers", {
      p_player_id: actor.id,
      p_session_id: session.id,
      p_round_id: before.round.id,
      p_kind: normalized.internal_action.toUpperCase(),
      p_selection: normalized.selection || null,
      p_idempotency_key: incoming.idempotencyKey,
      p_request: request,
    });
    rpcOne<unknown>(data, error, "Could not return open wager.");
  } else {
    // No shared implementation is permitted for cabinet-specific verbs.
    throw new HttpError(409, "This cabinet action has not passed server parity review.", "ACTION_UNAVAILABLE");
  }
  return ok(req, (await snapshot(actor, session, runtime, spec)).body);
}

async function events(req: Request, sessionId: string): Promise<Response> {
  const actor = await requirePlayer(req);
  const session = await sessionFor(actor, sessionId);
  const { runtime, spec } = await assertPlayableRuntime(actor, session.catalog_slug);
  const after = parseCursor(new URL(req.url).searchParams.get("after"));
  const current = await snapshot(actor, session, runtime, spec);
  const { data, error } = await service().from("game_event_outbox")
    .select("event_id,event_type,payload,created_at,round_id,action_id")
    .eq("player_id", actor.id).eq("session_id", session.id)
    .gt("event_id", after).order("event_id", { ascending: true }).limit(MAX_EVENT_LIMIT)
    .returns<Array<{
      event_id: number | string;
      event_type: string;
      payload: Json;
      created_at: string;
      round_id: string | null;
      action_id: string | null;
    }>>();
  if (error) dbError(error, "Game events are unavailable.");
  const events = (data || []).map((event) => {
    const cursor = wireInteger(event.event_id, "event cursor");
    return {
      id: cursor,
      cursor,
      event_type: event.event_type,
      payload: event.payload,
      created_at: event.created_at,
      round_id: event.round_id,
      action_id: event.action_id,
    };
  });
  const nextAfter = events.length ? events[events.length - 1].cursor : Math.max(after, wireInteger(current.body.cursor, "event cursor"));
  return ok(req, {
    session_id: session.id,
    cursor: nextAfter,
    next_after: nextAfter,
    action_precondition: current.actionPrecondition,
    allowed_actions: current.allowed,
    events,
  });
}

function failure(req: Request, error: unknown): Response {
  if (error instanceof HttpError) {
    return response(req, { detail: { code: error.code || "REQUEST_FAILED", message: error.message } }, error.status);
  }
  if (error instanceof GameRuleError) {
    return response(req, { detail: { code: error.code, message: error.message } }, 400);
  }
  if (error instanceof SettlementLifecycleError) {
    console.error("game-api settlement lifecycle error", error.code, error.message);
    return response(req, {
      detail: { code: "GAME_UNAVAILABLE", message: "This game is not available yet." },
    }, 409);
  }
  console.error("game-api request failed", error instanceof Error ? error.message : "unknown error");
  return response(req, { detail: { code: "GAME_SERVICE_UNAVAILABLE", message: "The game service could not complete the request." } }, 503);
}

async function dispatch(req: Request): Promise<Response> {
  assertAllowedOrigin(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
  const path = routePath(req);
  if (req.method === "GET" && path === "/player/lobby") return await lobby(req);
  if (req.method === "POST" && path === "/sessions") return await createSession(req);
  const state = path.match(/^\/sessions\/([0-9a-f-]+)$/i);
  if (req.method === "GET" && state) return await getSession(req, requiredUuid(state[1], "session_id"));
  const action = path.match(/^\/sessions\/([0-9a-f-]+)\/actions$/i);
  if (req.method === "POST" && action) return await act(req, requiredUuid(action[1], "session_id"));
  const event = path.match(/^\/sessions\/([0-9a-f-]+)\/events$/i);
  if (req.method === "GET" && event) return await events(req, requiredUuid(event[1], "session_id"));
  throw new HttpError(404, "Route not found.", "NOT_FOUND");
}

Deno.serve(async (req) => {
  try {
    return await dispatch(req);
  } catch (error) {
    return failure(req, error);
  }
});
