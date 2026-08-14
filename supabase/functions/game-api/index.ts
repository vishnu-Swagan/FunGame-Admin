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
  generateServerOutcome,
  normalizePlayerAction,
  outcomeForPublicPhase,
  publicClockWire,
  runtimeContractIssue,
  snapshotRevealSeconds,
  type ClockState,
  type GameSpec,
  type RuntimeMode,
  type ServerOutcome,
} from "./game-core.ts";
import { isPubliclyPlayableRuntime } from "../shared/runtime-availability.ts";
import { hasRegisteredLiveResolver } from "../shared/live-resolver-registry.ts";

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
  outcome: ServerOutcome | null;
  ruleset_version: number;
};
type WagerRow = { id: string; selection: string; amount: number | string; status: string };
type GameStatusRow = { slug: string; status: string };

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

function service(): SupabaseClient {
  return createClient(PROJECT_URL!, SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}

function publicAuth(): SupabaseClient {
  return createClient(PROJECT_URL!, ANON_KEY!, {
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

function dbError(error: { message?: string } | null, fallback: string): never {
  const source = error?.message || "";
  if (/insufficient|not enough|balance/i.test(source)) {
    throw new HttpError(409, "Insufficient virtual play points.", "INSUFFICIENT_POINTS");
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
  console.error("game-api database error", source);
  throw new HttpError(503, fallback, "GAME_SERVICE_UNAVAILABLE");
}

function rpcOne<T>(data: T | T[] | null, error: { message?: string } | null, fallback: string): T {
  if (error || data === null) dbError(error, fallback);
  const value = Array.isArray(data) ? data[0] : data;
  if (!value) throw new HttpError(503, fallback, "GAME_SERVICE_UNAVAILABLE");
  return value;
}

async function requirePlayer(req: Request): Promise<PlayerActor> {
  const token = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token) throw new HttpError(401, "Player authentication is required.", "AUTH_REQUIRED");
  const { data: userData, error: userError } = await publicAuth().auth.getUser(token);
  if (userError || !userData.user) {
    throw new HttpError(401, "Player session is invalid or expired.", "AUTH_INVALID");
  }
  const { data: profile, error } = await service().from("profiles")
    .select("id,login_id,account_kind,status,display_name,full_name,play_points_balance")
    .eq("id", userData.user.id).maybeSingle<Profile>();
  if (error || !profile || profile.account_kind !== "PLAYER" || profile.status !== "ACTIVE") {
    throw new HttpError(403, "An active player account is required.", "PLAYER_REQUIRED");
  }
  return { id: userData.user.id, profile };
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
  if (!hasRegisteredLiveResolver(runtime.catalog_slug, runtime.ruleset_version)) {
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
  const outcome = generateServerOutcome(spec);
  const { data, error } = await service().rpc("create_clocked_game_round", {
    p_catalog_slug: spec.catalog_slug,
    p_round_number: clock.round_number,
    p_starts_at: clock.starts_at,
    p_betting_closes_at: clock.betting_closes_at,
    p_reveal_starts_at: clock.reveal_starts_at,
    p_result_starts_at: clock.result_starts_at,
    p_ends_at: clock.ends_at,
    p_outcome_commitment: await sha256Hex(JSON.stringify(outcome)),
    p_outcome: outcome,
    p_metadata: { ruleset_version: runtime.ruleset_version, resolver: "game-api-v1" },
  });
  const round = asRoundRow(rpcOne<unknown>(data, error, "Could not prepare game round."));
  if (round.catalog_slug !== spec.catalog_slug || round.engine_slug !== spec.engine_slug ||
      wireInteger(round.round_number, "round number") !== clock.round_number || !round.outcome) {
    throw new HttpError(503, "Game round needs review.", "ROUND_INVALID");
  }
  return { clock, round };
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

function publicReveal(outcome: ServerOutcome | null): Json | null {
  if (!outcome) return null;
  switch (outcome.kind) {
    case "american_roulette": return { pocket: outcome.pocket };
    case "digit_wheel": return { pocket: String(outcome.digit) };
    case "multiplier_wheel": return { multiplier: outcome.multiplier };
    case "keno_80_of_20": return { sequence: outcome.drawn.map(String) };
  }
}

type Snapshot = { body: Json; clock: ClockState; round: RoundRow; openWagers: WagerRow[]; allowed: string[] };

async function snapshot(actor: PlayerActor, session: SessionRow, runtime: RuntimeRow, spec: GameSpec): Promise<Snapshot> {
  const { clock, round } = await ensureClockedRound(spec, runtime);
  const [balance, wagers, cursor] = await Promise.all([
    currentBalance(actor.id), wagersFor(actor, session.id, round.id), eventCursor(actor, session.id),
  ]);
  const openWagers = wagers.filter((wager) => wager.status === "OPEN");
  const bets = openWagers.map((wager) => ({
    selection: wager.selection,
    amount: wireInteger(wager.amount, "bet amount"),
  }));
  const myTotal = wireInteger(bets.reduce((total, wager) => total + wager.amount, 0), "my_total");
  const allowed = allowedActions(spec, clock, openWagers);
  const publicOutcome = round.outcome ? outcomeForPublicPhase(clock, round.outcome) : null;
  const clockWire = publicClockWire(clock);
  const state: Json = {
    round_number: wireInteger(round.round_number, "round number"),
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
  return { body: { session_id: session.id, cursor, allowed_actions: allowed, state }, clock, round, openWagers, allowed };
}

function rejectUntrustedFields(body: Json): void {
  for (const key of ["outcome", "payout", "prize", "delta", "balance", "balance_after", "ledger_id", "round_id", "player_id", "seed", "multiplier"]) {
    if (key in body) throw new HttpError(400, `Client-supplied ${key} is not accepted.`, "UNTRUSTED_FIELD");
  }
}

type ActionRequest = { action: string; selection?: string; amount?: number; idempotencyKey: string };
function actionRequest(req: Request, body: Json): ActionRequest {
  rejectUntrustedFields(body);
  const allowed = new Set(["action", "selection", "amount", "idempotency_key"]);
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
  const header = req.headers.get("x-idempotency-key")?.trim();
  if (header && header !== body.idempotency_key) {
    throw new HttpError(400, "Conflicting idempotency keys.", "IDEMPOTENCY_CONFLICT");
  }
  return { action: body.action, selection: body.selection as string | undefined, amount: body.amount as number | undefined, idempotencyKey: body.idempotency_key };
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

async function act(req: Request, sessionId: string): Promise<Response> {
  const actor = await requirePlayer(req);
  const session = await sessionFor(actor, sessionId);
  const { runtime, spec } = await assertPlayableRuntime(actor, session.catalog_slug);
  const incoming = actionRequest(req, await readBody(req));
  const normalized = normalizePlayerAction(spec, incoming.action, {
    selection: incoming.selection,
    amount: incoming.amount,
  });
  const before = await snapshot(actor, session, runtime, spec);
  if (!before.allowed.includes(normalized.action)) {
    throw new HttpError(409, "That action is not available in the current game state.", "ACTION_UNAVAILABLE");
  }
  const request: Json = { action: normalized.action };
  if (normalized.selection !== undefined) request.selection = normalized.selection;
  if (normalized.amount !== undefined) request.amount = normalized.amount;
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
    .select("event_id").eq("player_id", actor.id).eq("session_id", session.id)
    .gt("event_id", after).order("event_id", { ascending: true }).limit(MAX_EVENT_LIMIT)
    .returns<Array<{ event_id: number | string }>>();
  if (error) dbError(error, "Game events are unavailable.");
  const events = (data || []).map((event) => {
    const cursor = wireInteger(event.event_id, "event cursor");
    return { cursor, state: current.body.state };
  });
  const nextAfter = events.length ? events[events.length - 1].cursor : Math.max(after, wireInteger(current.body.cursor, "event cursor"));
  return ok(req, {
    session_id: session.id,
    cursor: nextAfter,
    next_after: nextAfter,
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
