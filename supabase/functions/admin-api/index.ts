// deno-lint-ignore-file no-import-prefix
/**
 * MyDGP administrator control-plane API.
 *
 * The browser is deliberately unable to query public tables directly. This
 * function uses the service role only after verifying the caller's Supabase
 * session and active administrator record. All balance changes go through the
 * SQL RPCs so the immutable virtual-points ledger remains authoritative.
 */
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  isPubliclyPlayableRuntime,
  runtimeReadinessMessage,
  type RuntimeAvailabilityRecord,
} from "../shared/runtime-availability.ts";

type Json = Record<string, unknown>;
type Profile = {
  id: string;
  login_id: string;
  auth_email: string;
  account_kind: "PLAYER" | "ADMIN";
  status: string;
  display_name: string | null;
  full_name: string | null;
  country: string | null;
  phone: string | null;
  avatar: string | null;
  play_points_balance: number | null;
  created_at: string;
  approved_at: string | null;
  last_login_at: string | null;
};
type AdminAccount = {
  user_id: string;
  admin_level: "PRIMARY" | "OPERATOR";
  created_by: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  created_at: string;
};
type Actor = { id: string; profile: Profile; admin: AdminAccount };
type PlayerActor = { id: string; profile: Profile };
type LedgerBalance = {
  play_points: number;
  point_balance: number;
  points_balance: number;
  chip_balance: number;
  ledger_entry_sequence: number | null;
  updated_at: string | null;
};
type RuntimePolicyRow = RuntimeAvailabilityRecord & {
  catalog_slug: string;
  ruleset_version: number;
};

const PROJECT_URL = Deno.env.get("SUPABASE_URL");
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!PROJECT_URL || !ANON_KEY || !SERVICE_ROLE_KEY) {
  throw new Error("Supabase Edge Function environment is incomplete");
}

const ALLOWED_ORIGINS = new Set([
  "https://mydgp.casino",
  "https://www.mydgp.casino",
]);
const OPERATOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._]{1,22}[A-Za-z0-9]$/;
// Client accounts use both seven- and eight-digit GK suffixes. The automatic
// generator keeps its established seven-digit form, while an administrator may
// explicitly issue either canonical form and player sign-in accepts both.
const PLAYER_ID_PATTERN = /^GK[0-9]{7,8}$/;
const NEW_PLAYER_ID_PATTERN = /^GK[0-9]{7,8}$/;
const USER_STATUSES = new Set(["PENDING", "ACTIVE", "SUSPENDED", "REJECTED"]);
const GAME_STATUSES = new Set([
  "COMING_SOON",
  "ENABLED",
  "DISABLED",
  "MAINTENANCE",
  "UPDATE_REQUIRED",
  "RETIRED",
]);
const LEGACY_CASH_PATH =
  /^\/admin\/(?:chip-requests|payouts?|commission|revenue|distributors)(?:\/|$)/;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

class HttpError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function service(): SupabaseClient {
  return createClient(PROJECT_URL!, SERVICE_ROLE_KEY!, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}

function publicAuth(): SupabaseClient {
  return createClient(PROJECT_URL!, ANON_KEY!, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}

function corsHeaders(req: Request): HeadersInit {
  const origin = req.headers.get("origin");
  return {
    "access-control-allow-origin": origin && ALLOWED_ORIGINS.has(origin)
      ? origin
      : "https://mydgp.casino",
    "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers":
      "authorization, content-type, x-idempotency-key, x-bootstrap-secret",
    "access-control-max-age": "86400",
    "content-type": "application/json; charset=utf-8",
    "vary": "Origin",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
}

function assertAllowedOrigin(req: Request) {
  const origin = req.headers.get("origin");
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    throw new HttpError(403, "Origin is not allowed");
  }
}

function json(req: Request, value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: corsHeaders(req),
  });
}

function failure(req: Request, error: unknown): Response {
  if (error instanceof HttpError) {
    return json(req, {
      detail: error.code
        ? { code: error.code, message: error.message }
        : error.message,
    }, error.status);
  }
  // Database and Auth errors can carry implementation details. They are logged
  // only by the managed runtime; callers receive a stable generic response.
  console.error(
    "admin-api request failed",
    error instanceof Error ? error.message : "unknown error",
  );
  return json(req, { detail: "The request could not be completed." }, 500);
}

function routePath(req: Request): string {
  const raw = new URL(req.url).pathname;
  const marker = "/admin-api";
  const index = raw.indexOf(marker);
  const path = index >= 0 ? raw.slice(index + marker.length) : raw;
  return (path || "/").replace(/\/+$/, "") || "/";
}

function asRecord(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "A JSON object is required");
  }
  return value as Json;
}

async function readBody(req: Request): Promise<Json> {
  const length = Number(req.headers.get("content-length") || "0");
  if (Number.isFinite(length) && length > 65_536) {
    throw new HttpError(413, "Request body is too large");
  }
  try {
    return asRecord(await req.json());
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Invalid JSON request body");
  }
}

function requiredText(
  body: Json,
  key: string,
  min: number,
  max: number,
): string {
  const value = body[key];
  if (typeof value !== "string") throw new HttpError(400, `${key} is required`);
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new HttpError(
      400,
      `${key} must be between ${min} and ${max} characters`,
    );
  }
  return trimmed;
}

function optionalText(
  body: Json,
  key: string,
  max: number,
): string | undefined {
  if (!(key in body) || body[key] === null || body[key] === undefined) {
    return undefined;
  }
  if (typeof body[key] !== "string") {
    throw new HttpError(400, `${key} must be text`);
  }
  const value = body[key].trim();
  if (value.length > max) throw new HttpError(400, `${key} is too long`);
  return value;
}

function optionalBoolean(body: Json, key: string): boolean | undefined {
  if (!(key in body) || body[key] === null || body[key] === undefined) {
    return undefined;
  }
  if (typeof body[key] !== "boolean") {
    throw new HttpError(400, `${key} must be true or false`);
  }
  return body[key] as boolean;
}

function integer(
  value: unknown,
  name: string,
  min: number,
  max: number,
): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string"
    ? Number(value)
    : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new HttpError(
      400,
      `${name} must be a whole number between ${min} and ${max}`,
    );
  }
  return parsed;
}

function uuid(value: string, name = "id"): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value)
  ) {
    throw new HttpError(400, `${name} is invalid`);
  }
  return value;
}

function makeAuthEmail(
  kind: "admin" | "operator" | "player",
  loginId: string,
): string {
  const local = loginId.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(
    /^\.+|\.+$/g,
    "",
  );
  if (!local) throw new HttpError(400, "Login ID is invalid");
  return `${kind}.${local}@auth.mydgp.casino`;
}

function randomPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(7));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

function retryKey(req: Request, prefix: string): string {
  const supplied = req.headers.get("x-idempotency-key")?.trim();
  if (supplied) {
    if (supplied.length < 8 || supplied.length > 160) {
      throw new HttpError(400, "x-idempotency-key must be 8-160 characters");
    }
    return supplied;
  }
  return `${prefix}:${crypto.randomUUID()}`;
}

function adminUser(profile: Profile, admin: AdminAccount): Json {
  return {
    id: profile.id,
    login_id: profile.login_id,
    username: profile.login_id,
    email: profile.auth_email,
    auth_email: profile.auth_email,
    display_name: profile.display_name || profile.full_name || profile.login_id,
    full_name: profile.full_name,
    status: profile.status,
    role: "ADMIN",
    account_kind: "ADMIN",
    admin_level: admin.admin_level,
    is_primary: admin.admin_level === "PRIMARY",
    operator_created_by: admin.created_by,
    created_at: profile.created_at,
  };
}

function playerUser(
  profile: Profile,
  stats: { points_won: number; points_used: number } = {
    points_won: 0,
    points_used: 0,
  },
): Json {
  return {
    id: profile.id,
    login_id: profile.login_id,
    username: profile.login_id,
    email: profile.auth_email,
    auth_email: profile.auth_email,
    display_name: profile.display_name || profile.full_name || profile.login_id,
    full_name: profile.full_name,
    country: profile.country,
    phone: profile.phone,
    avatar: profile.avatar,
    status: profile.status,
    role: "PLAYER",
    account_kind: "PLAYER",
    point_balance: profile.play_points_balance || 0,
    points_balance: profile.play_points_balance || 0,
    chip_balance: profile.play_points_balance || 0,
    stats,
    created_at: profile.created_at,
    approved_at: profile.approved_at,
    last_login_at: profile.last_login_at,
  };
}

function playerSessionProfile(profile: Profile): Json {
  // Auth email is an internal identity mapping and is intentionally not sent to
  // the Unity client. A player signs in with the issued Login ID instead.
  return {
    id: profile.id,
    login_id: profile.login_id,
    username: profile.login_id,
    display_name: profile.display_name || profile.full_name || profile.login_id,
    full_name: profile.full_name,
    country: profile.country,
    avatar: profile.avatar,
    status: profile.status,
    role: "PLAYER",
    created_at: profile.created_at,
    last_login_at: profile.last_login_at,
  };
}

async function dbResult<T>(
  operation: PromiseLike<
    { data: T | null; error: { message?: string; code?: string } | null }
  >,
  notFound?: string,
): Promise<T> {
  const { data, error } = await operation;
  if (error) {
    if (
      notFound &&
      (error.code === "PGRST116" || /no rows/i.test(error.message || ""))
    ) throw new HttpError(404, notFound);
    throw new HttpError(400, error.message || "Database request failed");
  }
  if (data === null) {
    throw new HttpError(
      notFound ? 404 : 500,
      notFound || "Database request returned no data",
    );
  }
  return data;
}

async function runtimePolicies(db: SupabaseClient): Promise<RuntimePolicyRow[]> {
  const { data, error } = await db.from("game_runtime_catalog").select(
    "catalog_slug,availability,parity_state,disabled_reason,ruleset_version",
  ).returns<RuntimePolicyRow[]>();
  if (error) {
    throw new HttpError(400, error.message || "Could not load game runtime policy");
  }
  return data || [];
}

async function runtimePolicy(
  db: SupabaseClient,
  catalogSlug: string,
): Promise<RuntimePolicyRow | null> {
  const { data, error } = await db.from("game_runtime_catalog").select(
    "catalog_slug,availability,parity_state,disabled_reason,ruleset_version",
  ).eq("catalog_slug", catalogSlug).maybeSingle<RuntimePolicyRow>();
  if (error && error.code !== "PGRST116") {
    throw new HttpError(400, error.message || "Could not load game runtime policy");
  }
  return data || null;
}

async function requireActor(req: Request): Promise<Actor> {
  const authorization = req.headers.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new HttpError(401, "Authentication is required");

  const db = service();
  const { data: authData, error: authError } = await db.auth.getUser(match[1]);
  if (authError || !authData.user) {
    throw new HttpError(401, "Your session is invalid or expired");
  }
  const id = authData.user.id;
  const profile = await dbResult<Profile>(
    db.from("profiles").select(
      "id,login_id,auth_email,account_kind,status,display_name,full_name,country,phone,avatar,play_points_balance,created_at,approved_at,last_login_at",
    ).eq("id", id).maybeSingle(),
    "Administrator access is disabled",
  );
  const admin = await dbResult<AdminAccount>(
    db.from("admin_accounts").select(
      "user_id,admin_level,created_by,revoked_at,revoked_by,created_at",
    ).eq("user_id", id).maybeSingle(),
    "Administrator access is disabled",
  );
  if (
    profile.account_kind !== "ADMIN" || profile.status !== "ACTIVE" ||
    admin.revoked_at
  ) {
    throw new HttpError(403, "Administrator access is disabled");
  }
  return { id, profile, admin };
}

async function requirePlayer(req: Request): Promise<PlayerActor> {
  const authorization = req.headers.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new HttpError(401, "Authentication is required");

  const db = service();
  const { data: authData, error: authError } = await db.auth.getUser(match[1]);
  if (authError || !authData.user) {
    throw new HttpError(401, "Your session is invalid or expired");
  }
  const profile = await dbResult<Profile>(
    db.from("profiles").select(
      "id,login_id,auth_email,account_kind,status,display_name,full_name,country,phone,avatar,play_points_balance,created_at,approved_at,last_login_at",
    ).eq("id", authData.user.id).maybeSingle(),
    "Player access is disabled",
  );
  if (profile.account_kind !== "PLAYER" || profile.status !== "ACTIVE") {
    throw new HttpError(403, "Player access is disabled");
  }
  return { id: profile.id, profile };
}

async function authoritativePlayerBalance(
  db: SupabaseClient,
  profile: Profile,
): Promise<LedgerBalance> {
  const latest = await db.from("play_point_ledger").select(
    "balance_after,entry_sequence,created_at",
  ).eq("player_id", profile.id).order("entry_sequence", {
    ascending: false,
  }).limit(1).maybeSingle();
  if (latest.error && latest.error.code !== "PGRST116") {
    throw new HttpError(
      400,
      latest.error.message || "Could not load the player balance",
    );
  }
  const entry = latest.data as {
    balance_after: number;
    entry_sequence: number;
    created_at: string;
  } | null;
  const balance = entry
    ? entry.balance_after
    : profile.play_points_balance || 0;
  // A divergence must never be quietly presented as spendable points. The
  // ledger is the authoritative source; fail closed until an operator repairs
  // an unexpected materialized-balance mismatch.
  if (entry && profile.play_points_balance !== entry.balance_after) {
    console.error("play-point balance projection mismatch", profile.id);
    throw new HttpError(
      503,
      "Balance is being reconciled. Please try again shortly.",
    );
  }
  return {
    play_points: balance,
    point_balance: balance,
    points_balance: balance,
    chip_balance: balance,
    ledger_entry_sequence: entry?.entry_sequence || null,
    updated_at: entry?.created_at || profile.created_at,
  };
}

function requirePrimary(actor: Actor) {
  if (actor.admin.admin_level !== "PRIMARY") {
    throw new HttpError(403, "Primary administrator access is required");
  }
}

async function audit(
  db: SupabaseClient,
  actor: Actor,
  action: string,
  targetType: string,
  targetId?: string,
  before?: unknown,
  after?: unknown,
  reason?: string,
) {
  // `audit_admin_action` intentionally returns void, so a successful RPC has
  // a null data field. Check only its error rather than using dbResult(), which
  // is reserved for queries/functions that return a value.
  const { error } = await db.rpc("audit_admin_action", {
    p_actor_id: actor.id,
    p_action: action,
    p_target_type: targetType,
    p_target_id: targetId || null,
    p_before: before ?? null,
    p_after: after ?? null,
    p_reason: reason || null,
  });
  if (error) {
    throw new HttpError(
      400,
      error.message || "Could not write the audit record",
    );
  }
}

function throttleLogin(req: Request) {
  const key = req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const now = Date.now();
  const state = loginAttempts.get(key);
  if (!state || state.resetAt <= now) {
    loginAttempts.set(key, { count: 1, resetAt: now + 60_000 });
    return;
  }
  state.count += 1;
  if (state.count > 10) {
    throw new HttpError(429, "Too many sign-in attempts. Try again shortly.");
  }
}

async function handleLogin(req: Request): Promise<Response> {
  throttleLogin(req);
  const body = await readBody(req);
  const identity = requiredText(body, "email", 3, 254).toLowerCase();
  const password = requiredText(body, "password", 1, 256);
  const db = service();

  let profile: Profile | null = null;
  const byLogin = await db.from("profiles").select(
    "id,login_id,auth_email,account_kind,status,display_name,full_name,country,phone,avatar,play_points_balance,created_at,approved_at,last_login_at",
  ).eq("login_id", identity).maybeSingle();
  if (byLogin.error && byLogin.error.code !== "PGRST116") {
    throw new HttpError(400, "Sign-in is temporarily unavailable");
  }
  profile = byLogin.data as Profile | null;
  if (!profile && identity.includes("@")) {
    const byEmail = await db.from("profiles").select(
      "id,login_id,auth_email,account_kind,status,display_name,full_name,country,phone,avatar,play_points_balance,created_at,approved_at,last_login_at",
    ).eq("auth_email", identity).maybeSingle();
    if (byEmail.error && byEmail.error.code !== "PGRST116") {
      throw new HttpError(400, "Sign-in is temporarily unavailable");
    }
    profile = byEmail.data as Profile | null;
  }
  // Do not disclose whether an identity exists, is an administrator, or is disabled.
  if (
    !profile || profile.account_kind !== "ADMIN" || profile.status !== "ACTIVE"
  ) {
    throw new HttpError(401, "Invalid operator ID or passcode");
  }
  const account = await db.from("admin_accounts").select(
    "user_id,admin_level,created_by,revoked_at,revoked_by,created_at",
  ).eq("user_id", profile.id).maybeSingle();
  if (account.error || !account.data || account.data.revoked_at) {
    throw new HttpError(401, "Invalid operator ID or passcode");
  }

  const auth = publicAuth();
  const { data: sessionData, error: signInError } = await auth.auth
    .signInWithPassword({ email: profile.auth_email, password });
  if (
    signInError || !sessionData.session || !sessionData.user ||
    sessionData.user.id !== profile.id
  ) {
    throw new HttpError(401, "Invalid operator ID or passcode");
  }
  await db.from("profiles").update({ last_login_at: new Date().toISOString() })
    .eq("id", profile.id);
  await audit(
    db,
    { id: profile.id, profile, admin: account.data as AdminAccount },
    "ADMIN_SIGNED_IN",
    "ADMIN",
    profile.id,
  );
  return json(req, {
    access_token: sessionData.session.access_token,
    user: adminUser(profile, account.data as AdminAccount),
  });
}

function playerLoginId(body: Json): string {
  const fromLoginId = optionalText(body, "login_id", 24);
  const fromUsername = optionalText(body, "username", 24);
  if (!fromLoginId && !fromUsername) {
    throw new HttpError(400, "login_id or username is required");
  }
  if (
    fromLoginId && fromUsername &&
    fromLoginId.toUpperCase() !== fromUsername.toUpperCase()
  ) {
    throw new HttpError(400, "login_id and username do not match");
  }
  const loginId = (fromLoginId || fromUsername || "").toUpperCase();
  if (!PLAYER_ID_PATTERN.test(loginId)) {
    // Do not provide a different message for an unknown player identifier.
    throw new HttpError(401, "Invalid player ID or password");
  }
  return loginId;
}

async function handlePlayerLogin(req: Request): Promise<Response> {
  throttleLogin(req);
  const body = await readBody(req);
  const loginId = playerLoginId(body);
  const password = requiredText(body, "password", 1, 256);
  const db = service();
  const lookup = await db.from("profiles").select(
    "id,login_id,auth_email,account_kind,status,display_name,full_name,country,phone,avatar,play_points_balance,created_at,approved_at,last_login_at",
  ).eq("login_id", loginId).eq("account_kind", "PLAYER").maybeSingle();
  if (lookup.error && lookup.error.code !== "PGRST116") {
    throw new HttpError(400, "Sign-in is temporarily unavailable");
  }
  const profile = lookup.data as Profile | null;
  if (!profile || profile.status !== "ACTIVE") {
    throw new HttpError(401, "Invalid player ID or password");
  }

  const auth = publicAuth();
  const { data: sessionData, error: signInError } = await auth.auth
    .signInWithPassword({ email: profile.auth_email, password });
  if (
    signInError || !sessionData.session || !sessionData.user ||
    sessionData.user.id !== profile.id
  ) {
    throw new HttpError(401, "Invalid player ID or password");
  }
  const now = new Date().toISOString();
  const { error: updateError } = await db.from("profiles").update({
    last_login_at: now,
  }).eq("id", profile.id);
  if (updateError) {
    throw new HttpError(400, "Sign-in is temporarily unavailable");
  }
  profile.last_login_at = now;
  const balance = await authoritativePlayerBalance(db, profile);
  const player = playerSessionProfile(profile);
  return json(req, {
    access_token: sessionData.session.access_token,
    token_type: sessionData.session.token_type,
    expires_at: sessionData.session.expires_at || null,
    user: player,
    profile: player,
    balance,
  });
}

async function handlePlayerSession(req: Request): Promise<Response> {
  const player = await requirePlayer(req);
  const db = service();
  const [balance, games, runtimes] = await Promise.all([
    authoritativePlayerBalance(db, player.profile),
    dbResult<Json[]>(
      db.from("games").select(
        "slug,name,category,tagline,description,art,display_order,status",
      ).order("display_order", { ascending: true }),
    ),
    runtimePolicies(db),
  ]);
  const runtimeByCatalog = new Map(
    runtimes.map((runtime) => [runtime.catalog_slug, runtime]),
  );
  // Do not advertise a game merely because a legacy catalogue row says
  // ENABLED. The player session and game-api lobby must describe the same
  // launchable set, otherwise a real player can reach a dead cabinet.
  const playableGames = games.filter((game) =>
    isPubliclyPlayableRuntime(
      typeof game.status === "string" ? game.status : null,
      runtimeByCatalog.get(String(game.slug || "")),
    )
  ).map(({ status: _status, ...game }) => game);
  const profile = playerSessionProfile(player.profile);
  return json(req, {
    profile,
    user: profile,
    balance,
    games: playableGames,
  });
}

async function handlePlayerBalance(req: Request): Promise<Response> {
  const player = await requirePlayer(req);
  const balance = await authoritativePlayerBalance(service(), player.profile);
  return json(req, balance);
}

async function handleMe(req: Request): Promise<Response> {
  const actor = await requireActor(req);
  return json(req, { user: adminUser(actor.profile, actor.admin) });
}

async function handleLogout(req: Request): Promise<Response> {
  const actor = await requireActor(req);
  const db = service();
  const { error } = await db.auth.admin.signOut(actor.id, "global");
  if (error) throw new HttpError(400, "Could not close the session");
  await audit(db, actor, "ADMIN_SIGNED_OUT", "ADMIN", actor.id);
  return json(req, { message: "Signed out" });
}

async function handlePublicConfig(req: Request): Promise<Response> {
  const db = service();
  const config = await dbResult<Json>(
    db.from("system_config").select(
      "maintenance_mode,maintenance_message,min_client_version,welcome_play_points,updated_at",
    ).eq("key", "main").maybeSingle(),
    "System configuration is unavailable",
  );
  return json(req, config);
}

async function handleStats(req: Request): Promise<Response> {
  const actor = await requireActor(req);
  const db = service();
  const count = async (
    query: PromiseLike<
      { count: number | null; error: { message?: string } | null }
    >,
  ) => {
    const { count: result, error } = await query;
    if (error) {
      throw new HttpError(400, error.message || "Could not load statistics");
    }
    return result || 0;
  };
  const [
    pendingSignups,
    pendingUsers,
    activeUsers,
    suspendedUsers,
    pendingPoints,
    totalGames,
    enabledGames,
    announcements,
    config,
  ] = await Promise.all([
    count(
      db.from("signup_requests").select("id", { count: "exact", head: true })
        .eq("status", "PENDING"),
    ),
    count(
      db.from("profiles").select("id", { count: "exact", head: true }).eq(
        "account_kind",
        "PLAYER",
      ).eq("status", "PENDING"),
    ),
    count(
      db.from("profiles").select("id", { count: "exact", head: true }).eq(
        "account_kind",
        "PLAYER",
      ).eq("status", "ACTIVE"),
    ),
    count(
      db.from("profiles").select("id", { count: "exact", head: true }).eq(
        "account_kind",
        "PLAYER",
      ).eq("status", "SUSPENDED"),
    ),
    count(
      db.from("play_point_requests").select("id", {
        count: "exact",
        head: true,
      }).eq("status", "PENDING"),
    ),
    count(db.from("games").select("id", { count: "exact", head: true })),
    count(
      db.from("games").select("id", { count: "exact", head: true }).eq(
        "status",
        "ENABLED",
      ),
    ),
    count(
      db.from("announcements").select("id", { count: "exact", head: true }).eq(
        "active",
        true,
      ),
    ),
    dbResult<Json>(
      db.from("system_config").select("maintenance_mode").eq("key", "main")
        .maybeSingle(),
    ),
  ]);
  await audit(db, actor, "ADMIN_STATS_VIEWED", "SYSTEM_CONFIG", "main");
  return json(req, {
    pending_signups: pendingSignups,
    pending_users: pendingUsers,
    active_users: activeUsers,
    suspended_users: suspendedUsers,
    pending_point_requests: pendingPoints,
    pending_chip_requests: pendingPoints,
    total_games: totalGames,
    enabled_games: enabledGames,
    active_announcements: announcements,
    maintenance_mode: Boolean(config.maintenance_mode),
  });
}

async function playerStats(
  db: SupabaseClient,
  ids: string[],
): Promise<Map<string, { points_won: number; points_used: number }>> {
  const result = new Map<string, { points_won: number; points_used: number }>();
  if (!ids.length) return result;
  const rows = await dbResult<Array<{ player_id: string; delta: number }>>(
    db.from("play_point_ledger").select("player_id,delta").in("player_id", ids)
      .range(0, 9_999),
  );
  for (const row of rows) {
    const stats = result.get(row.player_id) ||
      { points_won: 0, points_used: 0 };
    if (row.delta > 0) stats.points_won += row.delta;
    else stats.points_used += Math.abs(row.delta);
    result.set(row.player_id, stats);
  }
  return result;
}

async function listUsers(req: Request): Promise<Response> {
  await requireActor(req);
  const status = new URL(req.url).searchParams.get("status")?.toUpperCase();
  if (status && !USER_STATUSES.has(status)) {
    throw new HttpError(400, "status is invalid");
  }
  const db = service();
  const baseQuery = db.from("profiles").select(
    "id,login_id,auth_email,account_kind,status,display_name,full_name,country,phone,avatar,play_points_balance,created_at,approved_at,last_login_at",
  ).eq("account_kind", "PLAYER").order("created_at", { ascending: false })
    .range(0, 249);
  const query = status ? baseQuery.eq("status", status) : baseQuery;
  const players = await dbResult<Profile[]>(query);
  const stats = await playerStats(db, players.map((player) => player.id));
  return json(req, {
    users: players.map((player) => playerUser(player, stats.get(player.id))),
  });
}

async function createPlayer(req: Request): Promise<Response> {
  const actor = await requireActor(req);
  const body = await readBody(req);
  const fullName = requiredText(body, "full_name", 1, 120);
  const startingPoints = integer(
    body.starting_points ?? body.starting_play_points ?? 0,
    "starting_points",
    0,
    1_000_000,
  );
  const suppliedLogin = optionalText(body, "login_id", 16);
  const loginId = suppliedLogin
    ? suppliedLogin.toUpperCase()
    : `GK${
      String(crypto.getRandomValues(new Uint32Array(1))[0] % 10_000_000)
        .padStart(7, "0")
    }`;
  if (!NEW_PLAYER_ID_PATTERN.test(loginId)) {
    throw new HttpError(400, "Player ID must be GK followed by seven or eight digits");
  }
  const password = optionalText(body, "password", 128) || randomPassword();
  if (password.length < 7) {
    throw new HttpError(400, "password must be at least 7 characters");
  }
  const db = service();
  const authEmail = makeAuthEmail("player", loginId);
  const { data: created, error: createError } = await db.auth.admin.createUser({
    email: authEmail,
    password,
    email_confirm: true,
  });
  if (createError || !created.user) {
    if (/already|exists|duplicate/i.test(createError?.message || "")) {
      throw new HttpError(409, "That player ID is already in use");
    }
    throw new HttpError(400, "Could not create the player identity");
  }
  try {
    const profile = await dbResult<Profile>(
      db.rpc("create_player_profile", {
        p_actor_id: actor.id,
        p_auth_user_id: created.user.id,
        p_login_id: loginId,
        p_auth_email: authEmail,
        p_full_name: fullName,
        p_starting_play_points: startingPoints,
        p_note: optionalText(body, "note", 500) || null,
        p_idempotency_key: retryKey(req, "player-create"),
      }),
    );
    return json(req, {
      message: "Player account created",
      login_id: loginId,
      username: loginId,
      temporary_password: password,
      password,
      user: playerUser(profile),
    }, 201);
  } catch (error) {
    await db.auth.admin.deleteUser(created.user.id);
    throw error;
  }
}

async function updatePlayerStatus(
  req: Request,
  playerId: string,
  action: "approve" | "reject" | "suspend",
): Promise<Response> {
  const actor = await requireActor(req);
  const body = await readBody(req);
  const reason = optionalText(body, "note", 500);
  const db = service();
  const before = await dbResult<Profile>(
    db.from("profiles").select(
      "id,login_id,auth_email,account_kind,status,display_name,full_name,country,phone,avatar,play_points_balance,created_at,approved_at,last_login_at",
    ).eq("id", playerId).eq("account_kind", "PLAYER").maybeSingle(),
    "Player not found",
  );
  const patch = action === "approve"
    ? { status: "ACTIVE", approved_at: new Date().toISOString() }
    : action === "reject"
    ? { status: "REJECTED" }
    : { status: "SUSPENDED" };
  const after = await dbResult<Profile>(
    db.from("profiles").update(patch).eq("id", playerId).select(
      "id,login_id,auth_email,account_kind,status,display_name,full_name,country,phone,avatar,play_points_balance,created_at,approved_at,last_login_at",
    ).single(),
  );
  if (action === "suspend") await db.auth.admin.signOut(playerId, "global");
  await audit(
    db,
    actor,
    `PLAYER_${action.toUpperCase()}D`,
    "PLAYER",
    playerId,
    before,
    after,
    reason,
  );
  return json(req, { message: `Player ${action}d`, user: playerUser(after) });
}

async function adjustPoints(req: Request, playerId: string): Promise<Response> {
  const actor = await requireActor(req);
  const body = await readBody(req);
  const amountValue = body.delta ?? body.amount ?? body.points;
  const delta = integer(amountValue, "amount", -1_000_000, 1_000_000);
  if (delta === 0) throw new HttpError(400, "amount cannot be zero");
  const note = optionalText(body, "note", 500) ||
    "Administrator virtual play-point adjustment";
  const db = service();
  const result = await dbResult<
    Array<{ ledger_id: string; balance_after: number; duplicate: boolean }>
  >(
    db.rpc("adjust_play_points", {
      p_actor_id: actor.id,
      p_player_id: playerId,
      p_delta: delta,
      p_kind: "ADMIN_ADJUSTMENT",
      p_idempotency_key: retryKey(req, "admin-points"),
      p_reference_type: "ADMIN_CONSOLE",
      p_reference_id: null,
      p_note: note,
      p_metadata: { source: "admin-api" },
    }),
  );
  const entry = result[0];
  if (!entry) {
    throw new HttpError(
      500,
      "Play-point adjustment did not return a ledger entry",
    );
  }
  return json(req, { message: "Virtual play points updated", ...entry });
}

async function listPointRequests(req: Request): Promise<Response> {
  await requireActor(req);
  const status = new URL(req.url).searchParams.get("status")?.toUpperCase();
  if (status && !["PENDING", "APPROVED", "DENIED"].includes(status)) {
    throw new HttpError(400, "status is invalid");
  }
  const db = service();
  const baseQuery = db.from("play_point_requests").select(
    "id,player_id,amount,note,status,admin_note,reviewed_by,reviewed_at,created_at",
  ).order("created_at", { ascending: false }).range(0, 249);
  const query = status ? baseQuery.eq("status", status) : baseQuery;
  const requests = await dbResult<Array<Json>>(query);
  const playerIds = Array.from(
    new Set(requests.map((row) => String(row.player_id))),
  );
  const players = playerIds.length
    ? await dbResult<Profile[]>(
      db.from("profiles").select(
        "id,login_id,auth_email,account_kind,status,display_name,full_name,country,phone,avatar,play_points_balance,created_at,approved_at,last_login_at",
      ).in("id", playerIds),
    )
    : [];
  const byId = new Map(players.map((player) => [player.id, player]));
  const pointRequests = requests.map((request) => {
    const player = byId.get(String(request.player_id));
    return {
      ...request,
      type: "PLAY_POINTS",
      user_login_id: player?.login_id || null,
      player_login_id: player?.login_id || null,
      user_email: player?.auth_email || null,
      user_display_name: player?.display_name || player?.full_name ||
        player?.login_id || null,
      player_display_name: player?.display_name || player?.full_name ||
        player?.login_id || null,
    };
  });
  return json(req, { point_requests: pointRequests, requests: pointRequests });
}

async function resolvePointRequest(
  req: Request,
  requestId: string,
  approve: boolean,
): Promise<Response> {
  const actor = await requireActor(req);
  const body = await readBody(req);
  const db = service();
  const result = await dbResult<
    Array<{ status: string; balance_after: number | null }>
  >(
    db.rpc("resolve_play_point_request", {
      p_actor_id: actor.id,
      p_request_id: requestId,
      p_approve: approve,
      p_note: optionalText(body, "note", 500) || null,
      p_idempotency_key: retryKey(req, "point-request"),
    }),
  );
  return json(req, {
    message: approve
      ? "Play points credited to player"
      : "Play-point request denied",
    ...(result[0] || {}),
  });
}

async function listOperators(req: Request): Promise<Response> {
  const actor = await requireActor(req);
  requirePrimary(actor);
  const db = service();
  const accounts = await dbResult<AdminAccount[]>(
    db.from("admin_accounts").select(
      "user_id,admin_level,created_by,revoked_at,revoked_by,created_at",
    ).eq("admin_level", "OPERATOR").eq("created_by", actor.id).order(
      "created_at",
      { ascending: false },
    ),
  );
  const ids = accounts.map((account) => account.user_id);
  const profiles = ids.length
    ? await dbResult<Profile[]>(
      db.from("profiles").select(
        "id,login_id,auth_email,account_kind,status,display_name,full_name,country,phone,avatar,play_points_balance,created_at,approved_at,last_login_at",
      ).in("id", ids),
    )
    : [];
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  return json(req, {
    operators: accounts.map((account) => {
      const profile = profileById.get(account.user_id)!;
      return {
        id: account.user_id,
        login_id: profile?.login_id,
        username: profile?.login_id,
        email: profile?.auth_email,
        display_name: profile?.display_name || profile?.full_name ||
          profile?.login_id,
        status: profile?.status,
        admin_level: account.admin_level,
        created_at: account.created_at,
        revoked_at: account.revoked_at,
      };
    }),
  });
}

async function createOperator(req: Request): Promise<Response> {
  const actor = await requireActor(req);
  requirePrimary(actor);
  const body = await readBody(req);
  const loginId =
    (optionalText(body, "login_id", 24) || optionalText(body, "username", 24) ||
      "").trim();
  if (!OPERATOR_ID_PATTERN.test(loginId)) {
    throw new HttpError(
      400,
      "Operator ID must be 3-24 characters: letters, numbers, dots or underscores",
    );
  }
  const password = requiredText(body, "password", 8, 128);
  const displayName = optionalText(body, "display_name", 120);
  const authEmail = makeAuthEmail("operator", loginId);
  const db = service();
  const { data: created, error: createError } = await db.auth.admin.createUser({
    email: authEmail,
    password,
    email_confirm: true,
  });
  if (createError || !created.user) {
    if (/already|exists|duplicate/i.test(createError?.message || "")) {
      throw new HttpError(409, "That administrator ID is already in use");
    }
    throw new HttpError(400, "Could not create the administrator identity");
  }
  try {
    const profile = await dbResult<Profile>(
      db.rpc("provision_operator_profile", {
        p_primary_id: actor.id,
        p_auth_user_id: created.user.id,
        p_operator_id: loginId,
        p_auth_email: authEmail,
        p_display_name: displayName || null,
      }),
    );
    return json(req, {
      message: "Administrator created",
      operator: {
        id: profile.id,
        login_id: profile.login_id,
        username: profile.login_id,
        email: profile.auth_email,
        display_name: profile.display_name || profile.full_name ||
          profile.login_id,
        status: profile.status,
        admin_level: "OPERATOR",
        created_at: profile.created_at,
      },
    }, 201);
  } catch (error) {
    await db.auth.admin.deleteUser(created.user.id);
    throw error;
  }
}

async function revokeOperator(
  req: Request,
  operatorId: string,
): Promise<Response> {
  const actor = await requireActor(req);
  requirePrimary(actor);
  const db = service();
  const { error: revokeError } = await db.rpc("revoke_operator_profile", {
    p_primary_id: actor.id,
    p_operator_id: operatorId,
  });
  if (revokeError) {
    throw new HttpError(
      400,
      revokeError.message || "Could not revoke the administrator",
    );
  }
  // Revocation in the database is authoritative even if Auth's best-effort
  // global sign-out is delayed; future API calls re-check the revoked record.
  await db.auth.admin.signOut(operatorId, "global");
  return json(req, { message: "Administrator revoked" });
}

async function listGames(req: Request): Promise<Response> {
  await requireActor(req);
  const db = service();
  const [games, runtimes] = await Promise.all([
    dbResult<Json[]>(
      db.from("games").select(
      "id,slug,name,category,tagline,description,status,featured,art,display_order,created_at,updated_at",
      ).order("display_order", { ascending: true }),
    ),
    runtimePolicies(db),
  ]);
  const runtimeByCatalog = new Map(
    runtimes.map((runtime) => [runtime.catalog_slug, runtime]),
  );
  return json(req, {
    games: games.map((game) => {
      const runtime = runtimeByCatalog.get(String(game.slug || ""));
      const gameStatus = typeof game.status === "string" ? game.status : null;
      return {
        ...game,
        runtime: runtime
          ? {
            availability: runtime.availability,
            parity_state: runtime.parity_state,
            disabled_reason: runtime.disabled_reason || null,
            ruleset_version: runtime.ruleset_version,
          }
          : null,
        // This deliberately excludes the mutable catalogue status. It answers
        // whether a reviewed server runtime is capable of being promoted; the
        // distinct `runtime_available` field answers whether it is public now.
        runtime_ready_for_enable: isPubliclyPlayableRuntime("ENABLED", runtime),
        runtime_available: isPubliclyPlayableRuntime(gameStatus, runtime),
      };
    }),
  });
}

async function updateGame(req: Request, slug: string): Promise<Response> {
  const actor = await requireActor(req);
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) {
    throw new HttpError(400, "Game slug is invalid");
  }
  const body = await readBody(req);
  const patch: Json = { updated_at: new Date().toISOString() };
  if ("status" in body) {
    const status = requiredText(body, "status", 1, 32).toUpperCase();
    if (!GAME_STATUSES.has(status)) {
      throw new HttpError(400, "Game status is invalid");
    }
    patch.status = status;
  }
  const featured = optionalBoolean(body, "featured");
  if (featured !== undefined) patch.featured = featured;
  for (const key of ["name", "category", "tagline", "description"] as const) {
    const value = optionalText(body, key, key === "description" ? 2_000 : 200);
    if (value !== undefined) {
      if (key === "name" && !value) {
        throw new HttpError(400, "name cannot be empty");
      }
      patch[key] = value || null;
    }
  }
  if ("display_order" in body) {
    patch.display_order = integer(
      body.display_order,
      "display_order",
      -10_000,
      10_000,
    );
  }
  if ("art" in body) {
    if (!body.art || typeof body.art !== "object" || Array.isArray(body.art)) {
      throw new HttpError(400, "art must be an object");
    }
    patch.art = body.art;
  }
  if (Object.keys(patch).length === 1) {
    throw new HttpError(400, "No supported game fields were provided");
  }
  const db = service();
  if (patch.status === "ENABLED") {
    const runtime = await runtimePolicy(db, slug);
    if (!isPubliclyPlayableRuntime("ENABLED", runtime)) {
      throw new HttpError(
        409,
        runtimeReadinessMessage("ENABLED", runtime),
        "GAME_RUNTIME_NOT_READY",
      );
    }
  }
  const before = await dbResult<Json>(
    db.from("games").select(
      "id,slug,name,category,tagline,description,status,featured,art,display_order,created_at,updated_at",
    ).eq("slug", slug).maybeSingle(),
    "Game not found",
  );
  const game = await dbResult<Json>(
    db.from("games").update(patch).eq("slug", slug).select(
      "id,slug,name,category,tagline,description,status,featured,art,display_order,created_at,updated_at",
    ).single(),
  );
  await audit(db, actor, "GAME_UPDATED", "GAME", String(game.id), before, game);
  return json(req, { message: "Game updated", game });
}

async function listAnnouncements(req: Request): Promise<Response> {
  await requireActor(req);
  const announcements = await dbResult<Json[]>(
    service().from("announcements").select(
      "id,title,body,pinned,active,created_by,created_at,updated_at",
    ).order("pinned", { ascending: false }).order("created_at", {
      ascending: false,
    }).range(0, 249),
  );
  return json(req, { announcements });
}

function announcementInput(body: Json): Json {
  const title = requiredText(body, "title", 1, 200);
  const message = requiredText(body, "body", 1, 5_000);
  const pinned = optionalBoolean(body, "pinned");
  const active = optionalBoolean(body, "active");
  return {
    title,
    body: message,
    ...(pinned === undefined ? {} : { pinned }),
    ...(active === undefined ? {} : { active }),
  };
}

async function createAnnouncement(req: Request): Promise<Response> {
  const actor = await requireActor(req);
  const patch = announcementInput(await readBody(req));
  const db = service();
  const item = await dbResult<Json>(
    db.from("announcements").insert({ ...patch, created_by: actor.id }).select(
      "id,title,body,pinned,active,created_by,created_at,updated_at",
    ).single(),
  );
  await audit(
    db,
    actor,
    "ANNOUNCEMENT_CREATED",
    "ANNOUNCEMENT",
    String(item.id),
    undefined,
    item,
  );
  return json(
    req,
    { message: "Announcement published", announcement: item },
    201,
  );
}

async function updateAnnouncement(
  req: Request,
  announcementId: string,
): Promise<Response> {
  const actor = await requireActor(req);
  const body = await readBody(req);
  const patch: Json = { updated_at: new Date().toISOString() };
  if ("title" in body) patch.title = requiredText(body, "title", 1, 200);
  if ("body" in body) patch.body = requiredText(body, "body", 1, 5_000);
  const pinned = optionalBoolean(body, "pinned");
  const active = optionalBoolean(body, "active");
  if (pinned !== undefined) patch.pinned = pinned;
  if (active !== undefined) patch.active = active;
  if (Object.keys(patch).length === 1) {
    throw new HttpError(400, "No supported announcement fields were provided");
  }
  const db = service();
  const before = await dbResult<Json>(
    db.from("announcements").select(
      "id,title,body,pinned,active,created_by,created_at,updated_at",
    ).eq("id", announcementId).maybeSingle(),
    "Announcement not found",
  );
  const item = await dbResult<Json>(
    db.from("announcements").update(patch).eq("id", announcementId).select(
      "id,title,body,pinned,active,created_by,created_at,updated_at",
    ).single(),
  );
  await audit(
    db,
    actor,
    "ANNOUNCEMENT_UPDATED",
    "ANNOUNCEMENT",
    announcementId,
    before,
    item,
  );
  return json(req, { message: "Announcement updated", announcement: item });
}

async function deleteAnnouncement(
  req: Request,
  announcementId: string,
): Promise<Response> {
  const actor = await requireActor(req);
  const db = service();
  const before = await dbResult<Json>(
    db.from("announcements").select(
      "id,title,body,pinned,active,created_by,created_at,updated_at",
    ).eq("id", announcementId).maybeSingle(),
    "Announcement not found",
  );
  const { error } = await db.from("announcements").delete().eq(
    "id",
    announcementId,
  );
  if (error) {
    throw new HttpError(400, error.message || "Could not delete announcement");
  }
  await audit(
    db,
    actor,
    "ANNOUNCEMENT_DELETED",
    "ANNOUNCEMENT",
    announcementId,
    before,
  );
  return json(req, { message: "Announcement deleted" });
}

async function getSystemConfig(req: Request): Promise<Response> {
  await requireActor(req);
  const config = await dbResult<Json>(
    service().from("system_config").select(
      "maintenance_mode,maintenance_message,min_client_version,welcome_play_points,updated_at,updated_by",
    ).eq("key", "main").maybeSingle(),
    "System configuration is unavailable",
  );
  return json(req, { config });
}

async function updateSystemConfig(req: Request): Promise<Response> {
  const actor = await requireActor(req);
  const body = await readBody(req);
  const maintenanceMode = optionalBoolean(body, "maintenance_mode");
  const message = optionalText(body, "maintenance_message", 2_000);
  const version = optionalText(body, "min_client_version", 32);
  const welcome = "welcome_play_points" in body || "starting_points" in body
    ? integer(
      body.welcome_play_points ?? body.starting_points,
      "welcome_play_points",
      0,
      1_000_000,
    )
    : undefined;
  if (
    maintenanceMode === undefined && message === undefined &&
    version === undefined && welcome === undefined
  ) throw new HttpError(400, "No supported system fields were provided");
  if (
    version !== undefined &&
    !/^\d+(?:\.\d+){0,3}(?:[-+][A-Za-z0-9.-]+)?$/.test(version)
  ) throw new HttpError(400, "min_client_version is invalid");
  const db = service();
  const config = await dbResult<Json>(db.rpc("set_system_config", {
    p_actor_id: actor.id,
    p_maintenance_mode: maintenanceMode ?? null,
    p_maintenance_message: message ?? null,
    p_min_client_version: version ?? null,
    p_welcome_play_points: welcome ?? null,
  }));
  return json(req, { message: "System configuration saved", config });
}

async function supportThreads(req: Request): Promise<Response> {
  await requireActor(req);
  const db = service();
  const messages = await dbResult<
    Array<
      {
        id: string;
        user_id: string;
        sender: string;
        body: string;
        read_admin: boolean;
        created_at: string;
      }
    >
  >(
    db.from("support_messages").select(
      "id,user_id,sender,body,read_admin,created_at",
    ).order("created_at", { ascending: false }).range(0, 2_499),
  );
  const byUser = new Map<
    string,
    {
      user_id: string;
      unread: number;
      last_sender: string;
      last_body: string;
      last_at: string;
    }
  >();
  for (const message of messages) {
    const thread = byUser.get(message.user_id) ||
      {
        user_id: message.user_id,
        unread: 0,
        last_sender: message.sender,
        last_body: message.body,
        last_at: message.created_at,
      };
    if (message.sender === "PLAYER" && !message.read_admin) thread.unread += 1;
    byUser.set(message.user_id, thread);
  }
  const ids = [...byUser.keys()];
  const players = ids.length
    ? await dbResult<Profile[]>(
      db.from("profiles").select(
        "id,login_id,auth_email,account_kind,status,display_name,full_name,country,phone,avatar,play_points_balance,created_at,approved_at,last_login_at",
      ).in("id", ids),
    )
    : [];
  const profileById = new Map(players.map((player) => [player.id, player]));
  const threads = [...byUser.values()].sort((a, b) =>
    b.last_at.localeCompare(a.last_at)
  ).map((thread) => {
    const profile = profileById.get(thread.user_id);
    return {
      ...thread,
      user_email: profile?.auth_email || null,
      user_login_id: profile?.login_id || null,
      user_display_name: profile?.display_name || profile?.full_name ||
        profile?.login_id || "Unknown player",
    };
  });
  return json(req, { threads });
}

async function supportThread(
  req: Request,
  playerId: string,
): Promise<Response> {
  await requireActor(req);
  const db = service();
  const { error: readError } = await db.from("support_messages").update({
    read_admin: true,
  }).eq("user_id", playerId).eq("sender", "PLAYER").eq("read_admin", false);
  if (readError) {
    throw new HttpError(400, "Could not mark support messages as read");
  }
  const messages = await dbResult<Json[]>(
    db.from("support_messages").select(
      "id,user_id,sender,body,read_admin,read_user,created_at",
    ).eq("user_id", playerId).order("created_at", { ascending: true }).range(
      0,
      2_499,
    ),
  );
  return json(req, { messages });
}

async function replySupport(req: Request, playerId: string): Promise<Response> {
  const actor = await requireActor(req);
  const body = await readBody(req);
  const text = requiredText(body, "body", 1, 2_000);
  const db = service();
  const player = await dbResult<Profile>(
    db.from("profiles").select(
      "id,login_id,auth_email,account_kind,status,display_name,full_name,country,phone,avatar,play_points_balance,created_at,approved_at,last_login_at",
    ).eq("id", playerId).eq("account_kind", "PLAYER").maybeSingle(),
    "Player not found",
  );
  const item = await dbResult<Json>(
    db.from("support_messages").insert({
      user_id: player.id,
      sender: "ADMIN",
      body: text,
      read_admin: true,
      read_user: false,
    }).select("id,user_id,sender,body,read_admin,read_user,created_at")
      .single(),
  );
  await audit(db, actor, "SUPPORT_REPLY_SENT", "PLAYER", playerId, undefined, {
    message_id: item.id,
  });
  return json(req, { item }, 201);
}

type ComplianceConfig = {
  market_mode: "OFF" | "ALLOW" | "BLOCK";
  markets: string[];
  min_age: number;
  min_age_by_country: Record<string, number>;
  enforce_market_on_login: boolean;
  require_age_verification: boolean;
  reactivation_cooling_hours: number;
  updated_at: string;
};

function countryCode(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(normalized) ? normalized : null;
}

function ageOn(dateOfBirth: string | null): number | null {
  if (!dateOfBirth || !/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) return null;
  const born = new Date(`${dateOfBirth}T00:00:00.000Z`);
  if (Number.isNaN(born.getTime())) return null;
  const today = new Date();
  let age = today.getUTCFullYear() - born.getUTCFullYear();
  const anniversary = Date.UTC(
    today.getUTCFullYear(),
    born.getUTCMonth(),
    born.getUTCDate(),
  );
  if (Date.now() < anniversary) age -= 1;
  return age >= 0 && age < 150 ? age : null;
}

function normalizedMarkets(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new HttpError(
      400,
      "markets must be an array of two-letter country codes",
    );
  }
  const countries = [
    ...new Set(
      value.map((item) =>
        typeof item === "string" ? item.trim().toUpperCase() : ""
      ).filter((item) => /^[A-Z]{2}$/.test(item)),
    ),
  ];
  if (countries.length !== value.length || countries.length > 250) {
    throw new HttpError(
      400,
      "markets must contain at most 250 two-letter country codes",
    );
  }
  return countries;
}

function complianceResponse(config: ComplianceConfig): Json {
  // The legacy screen asks for this field, but the virtual-only schema never
  // stores monetary limit-increase behaviour. Returning zero keeps the screen
  // readable without pretending that a cash setting exists.
  return { ...config, limit_increase_delay_hours: 0 };
}

function reviewPlayers(
  players: Array<Profile & { date_of_birth?: string | null; settings?: Json }>,
  config: Pick<ComplianceConfig, "market_mode" | "markets" | "min_age">,
): Json {
  const marketSet = new Set(
    config.markets.map((market) => market.toUpperCase()),
  );
  const flagged: Json[] = [];
  for (const player of players) {
    const code = countryCode(player.country);
    const age = ageOn(player.date_of_birth || null);
    const reasons: string[] = [];
    if (config.market_mode === "ALLOW" && (!code || !marketSet.has(code))) {
      reasons.push(code ? "MARKET" : "COUNTRY_UNKNOWN");
    }
    if (config.market_mode === "BLOCK" && code && marketSet.has(code)) {
      reasons.push("MARKET");
    }
    if (age === null) reasons.push("NO_DOB");
    else if (age < config.min_age) reasons.push("UNDERAGE");
    if (reasons.length) {
      flagged.push({
        user_id: player.id,
        login_id: player.login_id,
        country: player.country,
        country_code: code,
        age,
        chip_balance: player.play_points_balance || 0,
        point_balance: player.play_points_balance || 0,
        reasons,
      });
    }
  }
  return { checked: players.length, flagged };
}

function getComplianceConfig(db: SupabaseClient): Promise<ComplianceConfig> {
  return dbResult<ComplianceConfig>(
    db.from("compliance_config").select(
      "market_mode,markets,min_age,min_age_by_country,enforce_market_on_login,require_age_verification,reactivation_cooling_hours,updated_at",
    ).eq("key", "main").maybeSingle(),
    "Compliance configuration is unavailable",
  );
}

function listCompliancePlayers(
  db: SupabaseClient,
): Promise<
  Array<Profile & { date_of_birth?: string | null; settings?: Json }>
> {
  return dbResult<
    Array<Profile & { date_of_birth?: string | null; settings?: Json }>
  >(
    db.from("profiles").select(
      "id,login_id,auth_email,account_kind,status,display_name,full_name,country,date_of_birth,phone,avatar,play_points_balance,settings,created_at,approved_at,last_login_at",
    ).eq("account_kind", "PLAYER").range(0, 4_999),
  );
}

async function getCompliance(req: Request): Promise<Response> {
  await requireActor(req);
  const config = await getComplianceConfig(service());
  return json(req, { config: complianceResponse(config) });
}

async function patchCompliance(req: Request): Promise<Response> {
  const actor = await requireActor(req);
  const body = await readBody(req);
  const db = service();
  const before = await getComplianceConfig(db);
  const patch: Json = {
    updated_by: actor.id,
    updated_at: new Date().toISOString(),
  };
  if ("market_mode" in body) {
    const mode = requiredText(body, "market_mode", 1, 8).toUpperCase();
    if (!(["OFF", "ALLOW", "BLOCK"] as string[]).includes(mode)) {
      throw new HttpError(400, "market_mode is invalid");
    }
    patch.market_mode = mode;
  }
  if ("markets" in body) patch.markets = normalizedMarkets(body.markets);
  if ("min_age" in body) {
    patch.min_age = integer(body.min_age, "min_age", 18, 30);
  }
  if ("min_age_by_country" in body) {
    if (
      !body.min_age_by_country || typeof body.min_age_by_country !== "object" ||
      Array.isArray(body.min_age_by_country)
    ) throw new HttpError(400, "min_age_by_country must be an object");
    const perCountry: Record<string, number> = {};
    for (
      const [country, age] of Object.entries(body.min_age_by_country as Json)
    ) {
      const normalized = countryCode(country);
      if (!normalized) {
        throw new HttpError(
          400,
          "min_age_by_country has an invalid country code",
        );
      }
      perCountry[normalized] = integer(age, "minimum age", 18, 30);
    }
    patch.min_age_by_country = perCountry;
  }
  for (
    const key of [
      "enforce_market_on_login",
      "require_age_verification",
    ] as const
  ) {
    const value = optionalBoolean(body, key);
    if (value !== undefined) patch[key] = value;
  }
  if ("reactivation_cooling_hours" in body) {
    patch.reactivation_cooling_hours = integer(
      body.reactivation_cooling_hours,
      "reactivation_cooling_hours",
      0,
      168,
    );
  }
  if ("limit_increase_delay_hours" in body) {
    throw new HttpError(
      410,
      "Cash and purchase limit controls are disabled for this virtual-points-only deployment",
    );
  }
  if (Object.keys(patch).length === 2) {
    throw new HttpError(400, "No supported compliance fields were provided");
  }
  const config = await dbResult<ComplianceConfig>(
    db.from("compliance_config").update(patch).eq("key", "main").select(
      "market_mode,markets,min_age,min_age_by_country,enforce_market_on_login,require_age_verification,reactivation_cooling_hours,updated_at",
    ).single(),
  );
  await audit(
    db,
    actor,
    "COMPLIANCE_CONFIG_UPDATED",
    "COMPLIANCE_CONFIG",
    "main",
    before,
    config,
  );
  return json(req, {
    message: "Compliance configuration saved",
    config: complianceResponse(config),
  });
}

async function complianceReview(
  req: Request,
  useQuery = false,
): Promise<Response> {
  await requireActor(req);
  const db = service();
  const saved = await getComplianceConfig(db);
  let settings: Pick<ComplianceConfig, "market_mode" | "markets" | "min_age"> =
    saved;
  if (useQuery) {
    const params = new URL(req.url).searchParams;
    const mode = (params.get("market_mode") || saved.market_mode).toUpperCase();
    if (!(["OFF", "ALLOW", "BLOCK"] as string[]).includes(mode)) {
      throw new HttpError(400, "market_mode is invalid");
    }
    const rawMarkets = params.get("markets");
    const markets = rawMarkets === null ? saved.markets : normalizedMarkets(
      rawMarkets.split(",").map((item) => item.trim()).filter(Boolean),
    );
    const rawAge = params.get("min_age");
    settings = {
      market_mode: mode as ComplianceConfig["market_mode"],
      markets,
      min_age: rawAge === null
        ? saved.min_age
        : integer(rawAge, "min_age", 18, 30),
    };
  }
  return json(req, reviewPlayers(await listCompliancePlayers(db), settings));
}

async function listExclusions(req: Request): Promise<Response> {
  await requireActor(req);
  const db = service();
  const exclusions = await dbResult<Array<Json>>(
    db.from("exclusions").select(
      "id,player_id,kind,status,starts_at,ends_at,source,reason,lifted_at,lifted_by,lift_reason,created_at",
    ).order("created_at", { ascending: false }).range(0, 499),
  );
  const ids = Array.from(
    new Set(exclusions.map((row) => String(row.player_id))),
  );
  const profiles = ids.length
    ? await dbResult<Profile[]>(
      db.from("profiles").select(
        "id,login_id,auth_email,account_kind,status,display_name,full_name,country,phone,avatar,play_points_balance,created_at,approved_at,last_login_at",
      ).in("id", ids),
    )
    : [];
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  const now = Date.now();
  return json(req, {
    exclusions: exclusions.map((row) => {
      const profile = profileById.get(String(row.player_id));
      const endsAt = typeof row.ends_at === "string"
        ? Date.parse(row.ends_at)
        : NaN;
      return {
        ...row,
        user_id: row.player_id,
        login_id: profile?.login_id || null,
        user_email: profile?.auth_email || null,
        in_force: row.status === "ACTIVE" &&
          (Number.isNaN(endsAt) || endsAt > now),
      };
    }),
  });
}

async function liftExclusion(
  req: Request,
  playerId: string,
): Promise<Response> {
  const actor = await requireActor(req);
  const body = await readBody(req);
  const reason = requiredText(body, "reason", 3, 500);
  const db = service();
  const before = await dbResult<Json>(
    db.from("exclusions").select(
      "id,player_id,kind,status,starts_at,ends_at,source,reason,lifted_at,lifted_by,lift_reason,created_at",
    ).eq("player_id", playerId).eq("status", "ACTIVE").order("created_at", {
      ascending: false,
    }).maybeSingle(),
    "No active exclusion exists for this player",
  );
  const item = await dbResult<Json>(
    db.from("exclusions").update({
      status: "LIFTED",
      lifted_at: new Date().toISOString(),
      lifted_by: actor.id,
      lift_reason: reason,
    }).eq("id", before.id).select(
      "id,player_id,kind,status,starts_at,ends_at,source,reason,lifted_at,lifted_by,lift_reason,created_at",
    ).single(),
  );
  await audit(
    db,
    actor,
    "EXCLUSION_LIFTED",
    "EXCLUSION",
    String(item.id),
    before,
    item,
    reason,
  );
  return json(req, { message: "Player exclusion lifted" });
}

async function verifyPlayerAge(
  req: Request,
  playerId: string,
): Promise<Response> {
  const actor = await requireActor(req);
  const body = await readBody(req);
  if (body.verified !== true) throw new HttpError(400, "verified must be true");
  const db = service();
  const player = await dbResult<
    Profile & { date_of_birth?: string | null; settings?: Json }
  >(
    db.from("profiles").select(
      "id,login_id,auth_email,account_kind,status,display_name,full_name,country,date_of_birth,phone,avatar,play_points_balance,settings,created_at,approved_at,last_login_at",
    ).eq("id", playerId).eq("account_kind", "PLAYER").maybeSingle(),
    "Player not found",
  );
  const age = ageOn(player.date_of_birth || null);
  if (age === null) {
    throw new HttpError(400, "The player has no usable date of birth");
  }
  const settings = {
    ...(player.settings || {}),
    age_verified_at: new Date().toISOString(),
    age_verified_by: actor.id,
  };
  await dbResult<Json>(
    db.from("profiles").update({ settings }).eq("id", playerId).select("id")
      .single(),
  );
  await audit(
    db,
    actor,
    "PLAYER_AGE_VERIFIED",
    "PLAYER",
    playerId,
    { age_verified_at: (player.settings || {}).age_verified_at || null },
    { age_verified_at: settings.age_verified_at },
    `Age ${age}`,
  );
  return json(req, { message: "Player age verified", age });
}

async function bootstrapPrimary(req: Request): Promise<Response> {
  const expected = Deno.env.get("BOOTSTRAP_SECRET");
  if (!expected || req.headers.get("x-bootstrap-secret") !== expected) {
    throw new HttpError(404, "Not found");
  }
  const body = await readBody(req);
  const loginId =
    (optionalText(body, "login_id", 24) || optionalText(body, "username", 24) ||
      "").trim();
  if (!OPERATOR_ID_PATTERN.test(loginId)) {
    throw new HttpError(
      400,
      "Administrator ID must be 3-24 characters: letters, numbers, dots or underscores",
    );
  }
  const password = requiredText(body, "password", 8, 128);
  const displayName = optionalText(body, "display_name", 120);
  const db = service();
  const primary = await db.from("admin_accounts").select("user_id", {
    count: "exact",
    head: true,
  }).eq("admin_level", "PRIMARY");
  if (primary.error) {
    throw new HttpError(400, "Could not check bootstrap state");
  }
  if ((primary.count || 0) > 0) {
    throw new HttpError(409, "Primary administrator is already configured");
  }
  const authEmail = makeAuthEmail("admin", loginId);
  const { data: created, error: createError } = await db.auth.admin.createUser({
    email: authEmail,
    password,
    email_confirm: true,
  });
  if (createError || !created.user) {
    if (/already|exists|duplicate/i.test(createError?.message || "")) {
      throw new HttpError(409, "That administrator ID is already in use");
    }
    throw new HttpError(
      400,
      "Could not create the primary administrator identity",
    );
  }
  try {
    const profile = await dbResult<Profile>(db.rpc("bootstrap_primary_admin", {
      p_auth_user_id: created.user.id,
      p_login_id: loginId,
      p_auth_email: authEmail,
      p_display_name: displayName || null,
    }));
    return json(req, {
      message: "Primary administrator created",
      admin: {
        id: profile.id,
        login_id: profile.login_id,
        username: profile.login_id,
        email: profile.auth_email,
      },
    }, 201);
  } catch (error) {
    await db.auth.admin.deleteUser(created.user.id);
    throw error;
  }
}

function dispatch(req: Request): Response | Promise<Response> {
  assertAllowedOrigin(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }
  const path = routePath(req);
  if (LEGACY_CASH_PATH.test(path)) {
    return json(req, {
      detail:
        "Cash, deposits, payouts, and partner settlement are disabled for this virtual-points-only deployment.",
    }, 410);
  }

  if (req.method === "POST" && path === "/auth/login") return handleLogin(req);
  if (req.method === "GET" && path === "/auth/me") return handleMe(req);
  if (req.method === "POST" && path === "/auth/logout") {
    return handleLogout(req);
  }
  if (req.method === "POST" && path === "/player/auth/login") {
    return handlePlayerLogin(req);
  }
  if (req.method === "GET" && path === "/player/session") {
    return handlePlayerSession(req);
  }
  if (req.method === "GET" && path === "/player/balance") {
    return handlePlayerBalance(req);
  }
  if (req.method === "GET" && path === "/system/config") {
    return handlePublicConfig(req);
  }
  if (req.method === "POST" && path === "/bootstrap/primary") {
    return bootstrapPrimary(req);
  }

  if (req.method === "GET" && path === "/admin/stats") return handleStats(req);
  if (req.method === "GET" && path === "/admin/users") return listUsers(req);
  if (req.method === "POST" && path === "/admin/users") {
    return createPlayer(req);
  }

  const userAction = path.match(
    /^\/admin\/users\/([^/]+)\/(approve|reject|suspend)$/,
  );
  if (req.method === "POST" && userAction) {
    return updatePlayerStatus(
      req,
      uuid(userAction[1], "player ID"),
      userAction[2] as "approve" | "reject" | "suspend",
    );
  }
  const pointAdjustment = path.match(
    /^\/admin\/users\/([^/]+)\/(?:play-points|points)$/,
  );
  if (req.method === "POST" && pointAdjustment) {
    return adjustPoints(req, uuid(pointAdjustment[1], "player ID"));
  }

  if (req.method === "GET" && path === "/admin/point-requests") {
    return listPointRequests(req);
  }
  const pointAction = path.match(
    /^\/admin\/point-requests\/([^/]+)\/(approve|deny)$/,
  );
  if (req.method === "POST" && pointAction) {
    return resolvePointRequest(
      req,
      uuid(pointAction[1], "request ID"),
      pointAction[2] === "approve",
    );
  }

  if (req.method === "GET" && path === "/admin/operators") {
    return listOperators(req);
  }
  if (req.method === "POST" && path === "/admin/operators") {
    return createOperator(req);
  }
  const operatorAction = path.match(/^\/admin\/operators\/([^/]+)\/revoke$/);
  if (req.method === "POST" && operatorAction) {
    return revokeOperator(req, uuid(operatorAction[1], "operator ID"));
  }

  if (req.method === "GET" && path === "/admin/games") return listGames(req);
  const gamePatch = path.match(/^\/admin\/games\/([^/]+)$/);
  if (req.method === "PATCH" && gamePatch) {
    return updateGame(req, decodeURIComponent(gamePatch[1]));
  }

  if (req.method === "GET" && path === "/admin/announcements") {
    return listAnnouncements(req);
  }
  if (req.method === "POST" && path === "/admin/announcements") {
    return createAnnouncement(req);
  }
  const announcementRoute = path.match(/^\/admin\/announcements\/([^/]+)$/);
  if (announcementRoute && req.method === "PATCH") {
    return updateAnnouncement(
      req,
      uuid(announcementRoute[1], "announcement ID"),
    );
  }
  if (announcementRoute && req.method === "DELETE") {
    return deleteAnnouncement(
      req,
      uuid(announcementRoute[1], "announcement ID"),
    );
  }

  if (req.method === "GET" && path === "/admin/system") {
    return getSystemConfig(req);
  }
  if (req.method === "PATCH" && path === "/admin/system") {
    return updateSystemConfig(req);
  }

  if (req.method === "GET" && path === "/admin/compliance/config") {
    return getCompliance(req);
  }
  if (req.method === "PATCH" && path === "/admin/compliance/config") {
    return patchCompliance(req);
  }
  if (req.method === "GET" && path === "/admin/compliance/review") {
    return complianceReview(req);
  }
  if (req.method === "GET" && path === "/admin/compliance/preview") {
    return complianceReview(req, true);
  }
  if (req.method === "GET" && path === "/admin/compliance/exclusions") {
    return listExclusions(req);
  }
  const exclusionLift = path.match(
    /^\/admin\/compliance\/players\/([^/]+)\/exclusion\/lift$/,
  );
  if (req.method === "POST" && exclusionLift) {
    return liftExclusion(req, uuid(exclusionLift[1], "player ID"));
  }
  const ageVerify = path.match(
    /^\/admin\/compliance\/players\/([^/]+)\/age-verify$/,
  );
  if (req.method === "POST" && ageVerify) {
    return verifyPlayerAge(req, uuid(ageVerify[1], "player ID"));
  }

  if (req.method === "GET" && path === "/admin/support/threads") {
    return supportThreads(req);
  }
  const supportRoute = path.match(
    /^\/admin\/support\/threads\/([^/]+)(?:\/(reply))?$/,
  );
  if (supportRoute && req.method === "GET" && !supportRoute[2]) {
    return supportThread(req, uuid(supportRoute[1], "player ID"));
  }
  if (supportRoute && req.method === "POST" && supportRoute[2] === "reply") {
    return replySupport(req, uuid(supportRoute[1], "player ID"));
  }

  throw new HttpError(404, "Route not found");
}

Deno.serve(async (req) => {
  try {
    return await dispatch(req);
  } catch (error) {
    return failure(req, error);
  }
});
