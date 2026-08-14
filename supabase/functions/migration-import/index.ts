/**
 * One-time, server-to-server Mongo -> Supabase migration importer.
 *
 * This function is intentionally not a browser API.  It accepts only a
 * separate import secret, pulls a bounded page at a time from the temporary
 * HMAC-protected Mongo exporter, and first writes Canonical Extended JSON to
 * `legacy_documents`.  Materialization is a second, resumable phase so a
 * source snapshot is always retained even where the new virtual-points model
 * has no compatible destination table.
 *
 * The importer never reads, writes, or recreates legacy passwords, password
 * hashes, session tokens, or reset codes.  Every imported Auth identity gets a
 * cryptographically random unknown password and a mandatory recovery marker;
 * an operator must verify the destination email and issue a normal Supabase
 * recovery flow before that account can be used.
 */
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

type Json = Record<string, unknown>;
type Action = "archive" | "materialize" | "validate" | "run";
type RunStatus =
  | "STARTED"
  | "ARCHIVED"
  | "MATERIALIZED"
  | "VALIDATED"
  | "FAILED";
type ArchiveProgress = {
  cursor: string | null;
  complete: boolean;
  imported: number;
};
type MaterializeProgress = {
  last_key: string | null;
  complete: boolean;
  materialized: number;
  skipped: number;
  excluded: number;
};
type ManifestCollection = { name: string; count: number };
type SourceManifest = { collections: ManifestCollection[]; pageLimit: number };
type MigrationRun = {
  id: string;
  status: RunStatus;
  manifest: Json;
  error: string | null;
};
type LegacyDocument = {
  legacy_key: string;
  document: Json;
  document_sha256: string;
};
type MaterializeResult = {
  outcome: "materialized" | "skipped" | "excluded";
  reason?: string;
  seedUserKey?: string;
};

const PROJECT_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const SOURCE_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 65_536;
const MAX_PAGE_LIMIT = 100;
const DEFAULT_PAGE_LIMIT = 50;
const DEFAULT_MAX_PAGES = 12;
const DEFAULT_MAX_RECORDS = 40;
const COLLECTION_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GAME_STATUSES = new Set([
  "COMING_SOON",
  "ENABLED",
  "DISABLED",
  "MAINTENANCE",
  "UPDATE_REQUIRED",
  "RETIRED",
]);
const ACCOUNT_STATUSES = new Set([
  "VERIFIED",
  "PROFILE_SUBMITTED",
  "PENDING",
  "PENDING_AUDIT",
  "ACTIVE",
  "REJECTED",
  "SUSPENDED",
]);
const MATERIALIZATION_ORDER = [
  "users",
  "games",
  "announcements",
  "system_config",
  "signup_requests",
  "support_messages",
  "notifications",
  "chip_requests",
];
// These two addresses are the documented development seed identities. The
// owner explicitly authorized their removal from the new live control plane;
// they are archived only as source evidence and are never provisioned as Auth
// users, profiles, balances, or related player records.
const AUTHORIZED_SEED_EMAILS = new Set([
  "admin@fungame.app",
  "player@fungame.app",
]);
const PROHIBITED_FIELD_NAMES = new Set([
  "active_session_id",
  "access_token",
  "api_key",
  "api_secret",
  "auth_token",
  "credential",
  "credentials",
  "password",
  "password_hash",
  "private_key",
  "refresh_token",
  "reset_code",
  "reset_code_hash",
  "secret",
  "session_id",
  "session_token",
  "token",
  "verification_code",
  "verification_code_hash",
]);

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

class SkipRecord extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

function service(): SupabaseClient {
  if (!PROJECT_URL || !SERVICE_ROLE_KEY) {
    throw new Error("Supabase Edge Function environment is incomplete");
  }
  return createClient(PROJECT_URL, SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "cache-control": "no-store, max-age=0",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

function failure(error: unknown): Response {
  if (error instanceof HttpError) {
    return response({ detail: error.message }, error.status);
  }
  // Never return database, Auth, source-export, or environment details.  The
  // source data remains in legacy_documents and the run is marked FAILED.
  console.error(
    "migration-import failed",
    error instanceof Error ? error.message : "unknown error",
  );
  return response(
    { detail: "The migration operation could not be completed." },
    500,
  );
}

function asRecord(value: unknown, message = "A JSON object is required"): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, message);
  }
  return value as Json;
}

function optionalRecord(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Json
    : null;
}

async function readBody(req: Request): Promise<Json> {
  const length = Number(req.headers.get("content-length") || "0");
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
    throw new HttpError(413, "Request body is too large");
  }
  try {
    return asRecord(await req.json());
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Invalid JSON request body");
  }
}

function safeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index] || 0) ^ (b[index] || 0);
  }
  return difference === 0;
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(
    new Uint8Array(bytes),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/g,
    "",
  );
}

async function sha256(value: string): Promise<string> {
  return bytesToHex(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

async function hmacSha256(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToHex(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)),
  );
}

function randomPassword(): string {
  const alphabet =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
  const bytes = crypto.getRandomValues(new Uint8Array(40));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

function requiredPositiveInteger(
  value: unknown,
  name: string,
  max: number,
): number {
  const numberValue = ejsonNumber(value);
  if (
    !Number.isSafeInteger(numberValue) || numberValue <= 0 || numberValue > max
  ) {
    throw new SkipRecord(`${name} is not a safe positive integer`);
  }
  return numberValue;
}

function boundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = ejsonNumber(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

function ejsonNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value)) {
    return Number(value);
  }
  const record = optionalRecord(value);
  if (!record) return Number.NaN;
  for (
    const key of [
      "$numberInt",
      "$numberLong",
      "$numberDouble",
      "$numberDecimal",
    ]
  ) {
    const encoded = record[key];
    if (typeof encoded === "string" && /^-?\d+(?:\.\d+)?$/.test(encoded)) {
      return Number(encoded);
    }
  }
  return Number.NaN;
}

function scalarText(value: unknown, max = 512): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed && trimmed.length <= max ? trimmed : null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  const record = optionalRecord(value);
  if (
    record && typeof record.$oid === "string" &&
    /^[0-9a-f]{24}$/i.test(record.$oid)
  ) return record.$oid;
  return null;
}

function textField(document: Json, name: string, max: number): string | null {
  return scalarText(document[name], max);
}

function booleanField(document: Json, name: string, fallback = false): boolean {
  return typeof document[name] === "boolean" ? document[name] : fallback;
}

function dateField(value: unknown): string | null {
  let candidate: unknown = value;
  const record = optionalRecord(value);
  if (record && "$date" in record) candidate = record.$date;
  if (candidate && typeof candidate === "object") {
    const inner = optionalRecord(candidate);
    candidate = inner?.$numberLong ?? inner?.$numberInt ?? candidate;
  }
  const milliseconds = typeof candidate === "number"
    ? candidate
    : typeof candidate === "string" && /^-?\d+$/.test(candidate)
    ? Number(candidate)
    : Number.NaN;
  const date = Number.isFinite(milliseconds)
    ? new Date(milliseconds)
    : typeof candidate === "string"
    ? new Date(candidate)
    : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

function dateOnly(value: unknown): string | null {
  const encoded = typeof value === "string" ? value.trim() : "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(encoded)) return encoded;
  const date = dateField(value);
  return date ? date.slice(0, 10) : null;
}

function stableJson(value: unknown): string {
  if (
    value === null || typeof value === "boolean" || typeof value === "number" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = optionalRecord(value);
  if (!record) {
    throw new SkipRecord("source document contains an unsupported value");
  }
  return `{${
    Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(record[key])}`
    ).join(",")
  }}`;
}

function legacyKey(document: Json): string {
  const explicit = scalarText(document.id, 1024);
  if (explicit) return explicit;
  const mongoId = document._id;
  const scalar = scalarText(mongoId, 1024);
  if (scalar) return scalar;
  if (mongoId !== undefined) return `bson:${stableJson(mongoId)}`;
  return `document:${stableJson(document)}`;
}

function containsProhibitedField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsProhibitedField);
  const record = optionalRecord(value);
  if (!record) return false;
  return Object.entries(record).some(([key, nested]) =>
    PROHIBITED_FIELD_NAMES.has(key.toLowerCase()) ||
    containsProhibitedField(nested)
  );
}

function normaliseStatus(value: unknown, fallback: string): string {
  const candidate = scalarText(value, 48)?.toUpperCase();
  return candidate && ACCOUNT_STATUSES.has(candidate) ? candidate : fallback;
}

function normaliseRequestStatus(
  value: unknown,
): "PENDING" | "APPROVED" | "DENIED" {
  const raw = scalarText(value, 48)?.toUpperCase();
  if (raw === "APPROVED" || raw === "ACTIVE") return "APPROVED";
  if (raw === "DENIED" || raw === "REJECTED") return "DENIED";
  return "PENDING";
}

function requestedAction(body: Json): Action {
  const action = body.action === undefined ? "run" : body.action;
  if (
    action !== "archive" && action !== "materialize" && action !== "validate" &&
    action !== "run"
  ) {
    throw new HttpError(
      400,
      "action must be archive, materialize, validate, or run",
    );
  }
  return action;
}

function requestInteger(
  body: Json,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (body[key] === undefined) return fallback;
  const value = body[key];
  if (
    !Number.isSafeInteger(value) || (value as number) < min ||
    (value as number) > max
  ) {
    throw new HttpError(
      400,
      `${key} must be a whole number between ${min} and ${max}`,
    );
  }
  return value as number;
}

function requestRunId(body: Json): string | null {
  if (body.run_id === undefined || body.run_id === null) return null;
  if (typeof body.run_id !== "string" || !UUID.test(body.run_id)) {
    throw new HttpError(400, "run_id is invalid");
  }
  return body.run_id;
}

type Settings = { source: URL; importSecret: string; hmacSecret: string };

function settings(req: Request): Settings {
  if (req.headers.get("origin")) {
    throw new HttpError(403, "Browser requests are not allowed");
  }
  const importSecret = Deno.env.get("MIGRATION_IMPORT_SECRET") || "";
  const hmacSecret = Deno.env.get("MIGRATION_HMAC_SECRET") || "";
  const sourceValue = Deno.env.get("MIGRATION_SOURCE_URL") || "";
  const supplied = req.headers.get("x-migration-import-secret") || "";
  if (
    importSecret.length < 32 || hmacSecret.length < 32 ||
    importSecret === hmacSecret || !safeEqual(supplied, importSecret)
  ) {
    throw new HttpError(401, "Unauthorized");
  }
  let source: URL;
  try {
    source = new URL(sourceValue);
  } catch {
    throw new HttpError(503, "Migration importer is unavailable");
  }
  if (
    source.protocol !== "https:" || source.username || source.password ||
    source.search || source.hash
  ) {
    throw new HttpError(503, "Migration importer is unavailable");
  }
  source.pathname = source.pathname.replace(/\/+$/, "");
  if (!source.pathname || source.pathname === "/") {
    throw new HttpError(503, "Migration importer is unavailable");
  }
  return { source, importSecret, hmacSecret };
}

function sourceTarget(
  settingsValue: Settings,
  suffix: string,
  query = "",
): { url: string; pathAndQuery: string } {
  const path = `${settingsValue.source.pathname}${suffix}`;
  const pathAndQuery = query ? `${path}?${query}` : path;
  return { url: `${settingsValue.source.origin}${pathAndQuery}`, pathAndQuery };
}

async function fetchSourceJson<T extends Json>(
  settingsValue: Settings,
  suffix: string,
  query = "",
): Promise<T> {
  const target = sourceTarget(settingsValue, suffix, query);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = base64Url(crypto.getRandomValues(new Uint8Array(24)));
  const bodyDigest = await sha256("");
  const payload =
    `GET\n${target.pathAndQuery}\n${timestamp}\n${nonce}\n${bodyDigest}`;
  const signature = await hmacSha256(settingsValue.hmacSecret, payload);
  let result: Response;
  try {
    result = await fetch(target.url, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
      headers: {
        "accept": "application/json",
        "x-migration-timestamp": timestamp,
        "x-migration-nonce": nonce,
        "x-migration-signature": signature,
      },
    });
  } catch {
    throw new HttpError(502, "Migration source is unavailable");
  }
  if (!result.ok) {
    throw new HttpError(502, "Migration source rejected the request");
  }
  const contentLength = Number(result.headers.get("content-length") || "0");
  if (Number.isFinite(contentLength) && contentLength > 10_000_000) {
    throw new HttpError(502, "Migration source page is too large");
  }
  try {
    return asRecord(
      await result.json(),
      "Migration source returned invalid JSON",
    ) as T;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, "Migration source returned invalid JSON");
  }
}

function parseSourceManifest(raw: Json): SourceManifest {
  if (
    raw.format !== "bson-canonical-extended-json-v1" ||
    !Array.isArray(raw.collections)
  ) {
    throw new HttpError(
      502,
      "Migration source returned an unsupported manifest",
    );
  }
  const seen = new Set<string>();
  const collections: ManifestCollection[] = [];
  for (const value of raw.collections) {
    const item = optionalRecord(value);
    const name = item && scalarText(item.name, 64);
    const count = item ? ejsonNumber(item.count) : Number.NaN;
    if (
      !name || !COLLECTION_NAME.test(name) || seen.has(name) ||
      !Number.isSafeInteger(count) || count < 0
    ) {
      throw new HttpError(502, "Migration source returned an invalid manifest");
    }
    seen.add(name);
    collections.push({ name, count });
  }
  const sourceLimit = optionalRecord(raw.page_limit);
  const maximum = sourceLimit ? ejsonNumber(sourceLimit.maximum) : Number.NaN;
  const pageLimit = Number.isSafeInteger(maximum) && maximum > 0
    ? Math.min(MAX_PAGE_LIMIT, maximum)
    : DEFAULT_PAGE_LIMIT;
  return { collections, pageLimit };
}

type SourcePage = {
  documents: Json[];
  nextCursor: string | null;
  complete: boolean;
};

function parseSourcePage(
  raw: Json,
  collection: string,
  maximum: number,
): SourcePage {
  if (
    raw.format !== "bson-canonical-extended-json-v1" ||
    raw.collection !== collection || !Array.isArray(raw.documents)
  ) {
    throw new HttpError(502, "Migration source returned an invalid page");
  }
  if (
    raw.documents.length > maximum ||
    raw.documents.some((value) => !optionalRecord(value))
  ) {
    throw new HttpError(502, "Migration source returned an invalid page");
  }
  const nextCursor = raw.next_cursor;
  if (
    nextCursor !== null &&
    (typeof nextCursor !== "string" || nextCursor.length === 0 ||
      nextCursor.length > 4096)
  ) {
    throw new HttpError(502, "Migration source returned an invalid page");
  }
  const complete = raw.complete === true;
  if (complete !== (nextCursor === null)) {
    throw new HttpError(
      502,
      "Migration source page continuation is inconsistent",
    );
  }
  return { documents: raw.documents as Json[], nextCursor, complete };
}

function emptyArchiveProgress(manifest: SourceManifest): Json {
  return Object.fromEntries(manifest.collections.map(({ name }) => [name, {
    cursor: null,
    complete: false,
    imported: 0,
  }]));
}

function emptyMaterializeProgress(manifest: SourceManifest): Json {
  return Object.fromEntries(
    MATERIALIZATION_ORDER
      .filter((collection) =>
        manifest.collections.some(({ name }) => name === collection)
      )
      .map((
        name,
      ) => [name, {
        last_key: null,
        complete: false,
        materialized: 0,
        skipped: 0,
        excluded: 0,
      }]),
  );
}

function manifestForRun(manifest: SourceManifest): Json {
  return {
    source_format: "bson-canonical-extended-json-v1",
    source_collections: manifest.collections,
    source_page_limit: manifest.pageLimit,
    archive_progress: emptyArchiveProgress(manifest),
    materialize_progress: emptyMaterializeProgress(manifest),
    issues: { total: 0, samples: [] },
  };
}

function sourceManifestFromRun(run: MigrationRun): SourceManifest {
  const values = run.manifest.source_collections;
  if (!Array.isArray(values)) {
    throw new HttpError(409, "Migration run manifest is invalid");
  }
  const collections: ManifestCollection[] = [];
  const seen = new Set<string>();
  for (const itemValue of values) {
    const item = optionalRecord(itemValue);
    const name = item && scalarText(item.name, 64);
    const count = item ? ejsonNumber(item.count) : Number.NaN;
    if (
      !name || !COLLECTION_NAME.test(name) || seen.has(name) ||
      !Number.isSafeInteger(count) || count < 0
    ) {
      throw new HttpError(409, "Migration run manifest is invalid");
    }
    seen.add(name);
    collections.push({ name, count });
  }
  const configuredLimit = ejsonNumber(run.manifest.source_page_limit);
  const pageLimit =
    Number.isSafeInteger(configuredLimit) && configuredLimit >= 1 &&
      configuredLimit <= MAX_PAGE_LIMIT
      ? configuredLimit
      : DEFAULT_PAGE_LIMIT;
  return { collections, pageLimit };
}

function archiveProgressFor(
  run: MigrationRun,
  collection: string,
): ArchiveProgress {
  const progress = optionalRecord(run.manifest.archive_progress);
  const value = progress && optionalRecord(progress[collection]);
  const cursor = value?.cursor;
  const complete = value?.complete;
  const imported = value ? ejsonNumber(value.imported) : Number.NaN;
  if (
    (cursor !== null && typeof cursor !== "string") ||
    typeof complete !== "boolean" ||
    !Number.isSafeInteger(imported) || imported < 0
  ) {
    throw new HttpError(409, "Migration archive progress is invalid");
  }
  return { cursor: cursor as string | null, complete, imported };
}

function materializeProgressFor(
  run: MigrationRun,
  collection: string,
): MaterializeProgress {
  const progress = optionalRecord(run.manifest.materialize_progress);
  const value = progress && optionalRecord(progress[collection]);
  const lastKey = value?.last_key;
  const complete = value?.complete;
  const materialized = value ? ejsonNumber(value.materialized) : Number.NaN;
  const skipped = value ? ejsonNumber(value.skipped) : Number.NaN;
  const excluded = value ? ejsonNumber(value.excluded) : Number.NaN;
  if (
    (lastKey !== null && typeof lastKey !== "string") ||
    typeof complete !== "boolean" ||
    !Number.isSafeInteger(materialized) || materialized < 0 ||
    !Number.isSafeInteger(skipped) || skipped < 0 ||
    !Number.isSafeInteger(excluded) || excluded < 0
  ) {
    throw new HttpError(409, "Migration materialization progress is invalid");
  }
  return {
    last_key: lastKey as string | null,
    complete,
    materialized,
    skipped,
    excluded,
  };
}

function cloneManifest(run: MigrationRun): Json {
  // JSONB values returned by PostgREST are JSON-safe.  This clone avoids
  // mutating the object held by the Supabase client while a progress update is
  // in flight.
  return JSON.parse(JSON.stringify(run.manifest)) as Json;
}

function setArchiveProgress(
  manifest: Json,
  collection: string,
  progress: ArchiveProgress,
): void {
  const values = optionalRecord(manifest.archive_progress);
  if (!values) {
    throw new HttpError(409, "Migration archive progress is invalid");
  }
  values[collection] = progress;
}

function setMaterializeProgress(
  manifest: Json,
  collection: string,
  progress: MaterializeProgress,
): void {
  const values = optionalRecord(manifest.materialize_progress);
  if (!values) {
    throw new HttpError(409, "Migration materialization progress is invalid");
  }
  values[collection] = progress;
}

function appendIssue(manifest: Json, collection: string, reason: string): void {
  const existing = optionalRecord(manifest.issues) || { total: 0, samples: [] };
  const total = boundedInteger(existing.total, 0, 0, Number.MAX_SAFE_INTEGER) +
    1;
  const samples = Array.isArray(existing.samples)
    ? existing.samples.filter(optionalRecord).slice(0, 19)
    : [];
  // Do not include document keys, emails, or source payload excerpts in the
  // run metadata. The encrypted source record remains available in the
  // protected archive table for an authorized reconciliation operator.
  samples.push({ collection, reason: reason.slice(0, 180) });
  manifest.issues = { total, samples };
}

async function createRun(
  client: SupabaseClient,
  manifest: SourceManifest,
): Promise<MigrationRun> {
  const { data, error } = await client
    .from("migration_runs")
    .insert({
      source_name: "mongo-hmac-export-v1",
      status: "STARTED",
      manifest: manifestForRun(manifest),
    })
    .select("id,status,manifest,error")
    .single();
  if (error || !data) {
    // The partial unique index rejects concurrent/incomplete snapshots. Do
    // not infer whether a run exists from the public error text.
    if (error?.code === "23505") {
      throw new HttpError(
        409,
        "Another migration run must be resumed or resolved first",
      );
    }
    throw new Error("Could not create migration run");
  }
  return data as MigrationRun;
}

async function loadRun(
  client: SupabaseClient,
  id: string,
): Promise<MigrationRun> {
  const { data, error } = await client
    .from("migration_runs")
    .select("id,status,manifest,error")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error("Could not load migration run");
  if (!data) throw new HttpError(404, "Migration run was not found");
  return data as MigrationRun;
}

async function saveRun(
  client: SupabaseClient,
  run: MigrationRun,
  status?: RunStatus,
  error?: string | null,
): Promise<MigrationRun> {
  const update: Json = { manifest: run.manifest };
  if (status) update.status = status;
  if (error !== undefined) update.error = error;
  if (status === "VALIDATED") update.completed_at = new Date().toISOString();
  const { data, error: updateError } = await client
    .from("migration_runs")
    .update(update)
    .eq("id", run.id)
    .select("id,status,manifest,error")
    .single();
  if (updateError || !data) {
    throw new Error("Could not persist migration progress");
  }
  return data as MigrationRun;
}

async function failRun(
  client: SupabaseClient,
  run: MigrationRun,
  message: string,
): Promise<void> {
  // Failure state intentionally carries only an operational classification,
  // not database errors, documents, user IDs, or source URLs.
  try {
    await saveRun(client, run, "FAILED", message.slice(0, 300));
  } catch {
    // The caller will still receive the generic response. The original source
    // snapshot is never deleted merely because progress bookkeeping failed.
  }
}

async function existingHashes(
  client: SupabaseClient,
  collection: string,
  keys: string[],
): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  for (let start = 0; start < keys.length; start += 100) {
    const batch = keys.slice(start, start + 100);
    const { data, error } = await client
      .from("legacy_documents")
      .select("legacy_key,document_sha256")
      .eq("collection_name", collection)
      .in("legacy_key", batch);
    if (error) throw new Error("Could not verify archived source records");
    for (const row of data || []) {
      hashes.set(String(row.legacy_key), String(row.document_sha256));
    }
  }
  return hashes;
}

async function archivePage(
  client: SupabaseClient,
  collection: string,
  documents: Json[],
): Promise<number> {
  const rows: Json[] = [];
  for (const document of documents) {
    if (containsProhibitedField(document)) {
      // The exporter is already responsible for redaction. Treat an unexpected
      // credential field as a hard safety failure rather than persisting it.
      throw new HttpError(
        502,
        "Migration source included a prohibited credential field",
      );
    }
    const serialized = stableJson(document);
    rows.push({
      collection_name: collection,
      legacy_key: legacyKey(document),
      document,
      document_sha256: await sha256(serialized),
    });
  }
  if (!rows.length) return 0;
  const keys = rows.map((row) => String(row.legacy_key));
  if (new Set(keys).size !== keys.length) {
    throw new HttpError(
      502,
      "Migration source page contains duplicate record IDs",
    );
  }
  const stored = await existingHashes(client, collection, keys);
  for (const row of rows) {
    const oldHash = stored.get(String(row.legacy_key));
    if (oldHash && oldHash !== row.document_sha256) {
      // Do not silently overwrite a snapshot. A changed source while the
      // source is supposed to be frozen requires a reviewed fresh cutover.
      throw new HttpError(409, "Migration source changed after archival began");
    }
  }
  const { error } = await client
    .from("legacy_documents")
    .upsert(rows, { onConflict: "collection_name,legacy_key" });
  if (error) throw new Error("Could not archive migration source records");
  return rows.length;
}

function sourcePageQuery(limit: number, cursor: string | null): string {
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor) query.set("cursor", cursor);
  return query.toString();
}

async function archiveChunk(
  client: SupabaseClient,
  settingsValue: Settings,
  run: MigrationRun,
  pageLimit: number,
  maxPages: number,
): Promise<{ run: MigrationRun; complete: boolean; pages: number }> {
  if (run.status !== "STARTED") {
    throw new HttpError(
      409,
      "This migration run is not accepting archive pages",
    );
  }
  const sourceManifest = sourceManifestFromRun(run);
  let working = run;
  let pages = 0;
  for (const { name } of sourceManifest.collections) {
    let progress = archiveProgressFor(working, name);
    while (!progress.complete && pages < maxPages) {
      const rawPage = await fetchSourceJson<Json>(
        settingsValue,
        `/collections/${name}`,
        sourcePageQuery(pageLimit, progress.cursor),
      );
      const page = parseSourcePage(rawPage, name, pageLimit);
      const archived = await archivePage(client, name, page.documents);
      const manifest = cloneManifest(working);
      progress = {
        cursor: page.nextCursor,
        complete: page.complete,
        imported: progress.imported + archived,
      };
      setArchiveProgress(manifest, name, progress);
      working = await saveRun(client, { ...working, manifest });
      pages += 1;
      // Empty but unfinished pages would make a resume loop spin forever.
      if (!page.documents.length && !page.complete) {
        throw new HttpError(
          502,
          "Migration source returned an empty unfinished page",
        );
      }
    }
    if (pages >= maxPages) break;
  }
  const complete = sourceManifest.collections.every(({ name }) =>
    archiveProgressFor(working, name).complete
  );
  if (complete) working = await saveRun(client, working, "ARCHIVED");
  return { run: working, complete, pages };
}

async function mappedProfileId(
  client: SupabaseClient,
  legacyCollection: string,
  legacyKey: string,
): Promise<string | null> {
  const { data, error } = await client
    .from("legacy_identity_map")
    .select("target_id,target_table")
    .eq("legacy_collection", legacyCollection)
    .eq("legacy_key", legacyKey)
    .maybeSingle();
  if (error) throw new Error("Could not read migration identity mapping");
  if (!data) return null;
  if (
    data.target_table !== "profiles" || typeof data.target_id !== "string" ||
    !UUID.test(data.target_id)
  ) {
    throw new Error("Migration identity mapping is inconsistent");
  }
  return data.target_id;
}

async function rememberProfileId(
  client: SupabaseClient,
  legacyKey: string,
  profileId: string,
): Promise<void> {
  const { error } = await client
    .from("legacy_identity_map")
    .upsert({
      legacy_collection: "users",
      legacy_key: legacyKey,
      target_table: "profiles",
      target_id: profileId,
    }, { onConflict: "legacy_collection,legacy_key" });
  if (error) throw new Error("Could not save migration identity mapping");
}

function userProfileId(
  client: SupabaseClient,
  value: unknown,
): Promise<string | null> {
  const legacyUserId = scalarText(value, 1024);
  return legacyUserId
    ? mappedProfileId(client, "users", legacyUserId)
    : Promise.resolve(null);
}

async function findPrimaryActor(client: SupabaseClient): Promise<string> {
  const { data: admin, error: adminError } = await client
    .from("admin_accounts")
    .select("user_id")
    .eq("admin_level", "PRIMARY")
    .is("revoked_at", null)
    .maybeSingle();
  if (adminError) throw new Error("Could not verify migration administrator");
  if (
    !admin || typeof admin.user_id !== "string" || !UUID.test(admin.user_id)
  ) {
    throw new HttpError(
      409,
      "Bootstrap an active primary administrator before materializing legacy balances",
    );
  }
  const { data: profile, error: profileError } = await client
    .from("profiles")
    .select("id,account_kind,status")
    .eq("id", admin.user_id)
    .maybeSingle();
  if (profileError) throw new Error("Could not verify migration administrator");
  if (
    !profile || profile.account_kind !== "ADMIN" || profile.status !== "ACTIVE"
  ) {
    throw new HttpError(
      409,
      "Bootstrap an active primary administrator before materializing legacy balances",
    );
  }
  return admin.user_id;
}

function loginCandidate(document: Json, legacyKeyValue: string): string {
  const raw = textField(document, "username", 96) ||
    textField(document, "login_id", 96) ||
    textField(document, "login", 96) ||
    scalarText(document.email, 254)?.split("@")[0] ||
    "";
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, ".").replace(/\.{2,}/g, ".")
    .replace(/^\.+|\.+$/g, "").slice(0, 64);
  if (cleaned.length >= 3) return cleaned;
  const fallback = legacyKeyValue.replace(/[^A-Za-z0-9]/g, "").slice(-24);
  return `Migrated.${fallback || "Account"}`;
}

async function uniqueLoginId(
  client: SupabaseClient,
  preferred: string,
  legacyKeyValue: string,
): Promise<string> {
  const fallback = `Migrated.${(await sha256(legacyKeyValue)).slice(0, 18)}`;
  for (const candidate of [preferred, fallback]) {
    const { data, error } = await client.from("profiles").select("id").eq(
      "login_id",
      candidate,
    ).maybeSingle();
    if (error) throw new Error("Could not validate legacy login ID");
    if (!data) return candidate;
  }
  throw new SkipRecord(
    "legacy login ID collides with an existing Supabase profile",
  );
}

function legacyEmail(document: Json): string | null {
  const candidate = scalarText(document.email, 254)?.toLowerCase() || null;
  return candidate && EMAIL.test(candidate) ? candidate : null;
}

async function syntheticEmail(legacyKeyValue: string): Promise<string> {
  return `migration-${
    (await sha256(legacyKeyValue)).slice(0, 28)
  }@migration.invalid`;
}

function expectedAuthConflict(
  error: { status?: number; message?: string } | null,
): boolean {
  const message = error?.message?.toLowerCase() || "";
  return error?.status === 400 || error?.status === 409 ||
    error?.status === 422 ||
    message.includes("already") || message.includes("duplicate");
}

async function provisionMigratedAuthUser(
  client: SupabaseClient,
  candidateEmail: string | null,
  legacyKeyValue: string,
  runId: string,
): Promise<{ id: string; email: string; identityRecoveryRequired: boolean }> {
  const fallback = await syntheticEmail(legacyKeyValue);
  const attempts = candidateEmail && candidateEmail !== fallback
    ? [{ email: candidateEmail, identityRecoveryRequired: false }, {
      email: fallback,
      identityRecoveryRequired: true,
    }]
    : [{ email: fallback, identityRecoveryRequired: true }];
  let finalError: { status?: number; message?: string } | null = null;
  for (const attempt of attempts) {
    const { data, error } = await client.auth.admin.createUser({
      email: attempt.email,
      password: randomPassword(),
      email_confirm: true,
      user_metadata: {
        migrated_from_legacy: true,
        migration_run_id: runId,
        password_reset_required: true,
        identity_recovery_required: attempt.identityRecoveryRequired,
      },
    });
    if (!error && data.user?.id && UUID.test(data.user.id)) {
      return {
        id: data.user.id,
        email: attempt.email,
        identityRecoveryRequired: attempt.identityRecoveryRequired,
      };
    }
    finalError = error || null;
    // A malformed/duplicate legacy email is allowed to fall through to the
    // reserved .invalid address. Infrastructure failures are not data issues
    // and must stop the run rather than silently producing placeholder users.
    if (!expectedAuthConflict(error)) {
      throw new Error("Could not provision Supabase Auth identity");
    }
  }
  if (expectedAuthConflict(finalError)) {
    throw new SkipRecord("legacy email requires manual identity recovery");
  }
  throw new Error("Could not provision Supabase Auth identity");
}

async function deleteProvisionedAuthUser(
  client: SupabaseClient,
  id: string,
): Promise<void> {
  try {
    await client.auth.admin.deleteUser(id);
  } catch {
    // A failed cleanup is intentionally not hidden from the run: subsequent
    // retries will stop for manual review instead of taking over that account.
  }
}

function profileSettings(
  document: Json,
  identityRecoveryRequired: boolean,
): Json {
  const original = optionalRecord(document.settings);
  let safe: Json = {};
  if (original) {
    const serialized = stableJson(original);
    if (serialized.length <= 20_000) safe = original;
  }
  return {
    ...safe,
    migrated_from_legacy: true,
    password_reset_required: true,
    identity_recovery_required: identityRecoveryRequired,
  };
}

function isAuthorizedSeedUser(document: Json): boolean {
  const email = legacyEmail(document);
  return Boolean(email && AUTHORIZED_SEED_EMAILS.has(email));
}

function excludedSeedUserKeys(manifest: Json): Set<string> {
  const seed = optionalRecord(manifest.authorized_seed_exclusions);
  const users = seed && Array.isArray(seed.users) ? seed.users : [];
  return new Set(
    users.filter((value): value is string => typeof value === "string"),
  );
}

function recordSeedUserExclusion(manifest: Json, legacyKeyValue: string): void {
  const existing = optionalRecord(manifest.authorized_seed_exclusions) || {};
  const users = new Set(
    (Array.isArray(existing.users) ? existing.users : [])
      .filter((value): value is string => typeof value === "string"),
  );
  users.add(legacyKeyValue);
  manifest.authorized_seed_exclusions = {
    users: Array.from(users).sort(),
    source_emails: Array.from(AUTHORIZED_SEED_EMAILS).sort(),
    policy: "archive_only_no_auth_profile_or_playable_record",
  };
}

function isExcludedSeedRelatedDocument(
  seedUsers: Set<string>,
  value: unknown,
): boolean {
  const userId = scalarText(value, 1024);
  return Boolean(userId && seedUsers.has(userId));
}

function isSeedLinkedRecord(seedUsers: Set<string>, document: Json): boolean {
  for (
    const field of [
      "user_id",
      "sender_id",
      "admin_id",
      "created_by",
      "updated_by",
      "reviewed_by",
      "resolved_by",
    ]
  ) {
    if (isExcludedSeedRelatedDocument(seedUsers, document[field])) return true;
  }
  for (
    const field of [
      "email",
      "user_email",
      "sender_email",
      "admin_email",
      "created_by_email",
      "updated_by_email",
      "reviewed_by_email",
    ]
  ) {
    const email = scalarText(document[field], 254)?.toLowerCase();
    if (email && AUTHORIZED_SEED_EMAILS.has(email)) return true;
  }
  return false;
}

function openingPlayPoints(document: Json): number {
  if (document.chip_balance === undefined || document.chip_balance === null) {
    return 0;
  }
  const amount = ejsonNumber(document.chip_balance);
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > 1_000_000_000) {
    throw new SkipRecord(
      "legacy virtual play-point balance requires manual reconciliation",
    );
  }
  return amount;
}

async function ensureOpeningPlayPoints(
  client: SupabaseClient,
  actorId: string,
  profileId: string,
  legacyKeyValue: string,
  document: Json,
  runId: string,
): Promise<void> {
  const amount = openingPlayPoints(document);
  if (!amount) return;
  const idempotencyKey = `migration-opening:${legacyKeyValue}`;
  const { data: existing, error: lookupError } = await client
    .from("play_point_ledger")
    .select("id")
    .eq("player_id", profileId)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if (lookupError) throw new Error("Could not verify migrated opening balance");
  if (existing) return;
  const { error } = await client.rpc("adjust_play_points", {
    p_actor_id: actorId,
    p_player_id: profileId,
    p_delta: amount,
    p_kind: "MIGRATION_OPENING",
    p_idempotency_key: idempotencyKey,
    p_reference_type: "LEGACY_USER",
    p_reference_id: legacyKeyValue,
    p_note: "Opening virtual play-point balance migrated from legacy account",
    p_metadata: { migration_run_id: runId, source_collection: "users" },
  });
  if (error) {
    throw new Error("Could not create migrated opening balance ledger entry");
  }
}

async function materializeUser(
  client: SupabaseClient,
  row: LegacyDocument,
  actorId: string,
  runId: string,
): Promise<MaterializeResult> {
  if (isAuthorizedSeedUser(row.document)) {
    return {
      outcome: "excluded",
      seedUserKey: row.legacy_key,
      reason: "authorized development seed identity is archived only",
    };
  }
  let profileId = await mappedProfileId(client, "users", row.legacy_key);
  const role = scalarText(row.document.role, 32)?.toUpperCase();
  if (role && role !== "PLAYER" && role !== "ADMIN") {
    throw new SkipRecord(
      "legacy non-player account is retained in the archive only",
    );
  }
  const accountKind = role === "ADMIN" ? "ADMIN" : "PLAYER";
  if (profileId) {
    if (accountKind === "PLAYER") {
      await ensureOpeningPlayPoints(
        client,
        actorId,
        profileId,
        row.legacy_key,
        row.document,
        runId,
      );
    }
    return { outcome: "materialized" };
  }

  const auth = await provisionMigratedAuthUser(
    client,
    legacyEmail(row.document),
    row.legacy_key,
    runId,
  );
  let profileInserted = false;
  let identityMapped = false;
  try {
    const loginId = await uniqueLoginId(
      client,
      loginCandidate(row.document, row.legacy_key),
      row.legacy_key,
    );
    const sourceStatus = normaliseStatus(row.document.status, "PENDING");
    const profile: Json = {
      id: auth.id,
      legacy_id: row.legacy_key,
      login_id: loginId,
      auth_email: auth.email,
      account_kind: accountKind,
      // No legacy administrator receives privileges automatically. The one
      // active primary is bootstrapped separately and every historical admin
      // remains a PENDING_AUDIT profile until explicitly reviewed.
      status: accountKind === "ADMIN" ? "PENDING_AUDIT" : sourceStatus,
      display_name: textField(row.document, "display_name", 120) ||
        textField(row.document, "full_name", 120) || loginId,
      full_name: textField(row.document, "full_name", 160) ||
        textField(row.document, "display_name", 160),
      country: textField(row.document, "country", 64),
      date_of_birth: dateOnly(row.document.date_of_birth),
      phone: textField(row.document, "phone", 32),
      avatar: textField(row.document, "avatar", 128),
      // A new Auth identity must independently prove recovery control. Do not
      // treat an old Mongo boolean as Supabase email-verification evidence.
      email_verified: false,
      accepted_terms: booleanField(row.document, "accepted_terms"),
      settings: profileSettings(row.document, auth.identityRecoveryRequired),
      play_points_balance: accountKind === "PLAYER" ? 0 : null,
      created_at: dateField(row.document.created_at) ||
        new Date().toISOString(),
      approved_at: dateField(row.document.approved_at),
      last_login_at: null,
      legacy_metadata: {
        migrated_from_legacy: true,
        source_role: role || "PLAYER",
        source_status: scalarText(row.document.status, 48),
        source_email_present: Boolean(legacyEmail(row.document)),
        legacy_points_balance_preserved_in_archive:
          row.document.points_balance !== undefined,
        password_reset_required: true,
        identity_recovery_required: auth.identityRecoveryRequired,
      },
    };
    const { error: profileError } = await client.from("profiles").insert(
      profile,
    );
    if (profileError) {
      if (profileError.code === "23505") {
        throw new SkipRecord(
          "legacy account conflicts with an existing Supabase profile",
        );
      }
      throw new Error("Could not create migrated profile");
    }
    profileInserted = true;
    profileId = auth.id;
    await rememberProfileId(client, row.legacy_key, profileId);
    identityMapped = true;
    if (accountKind === "PLAYER") {
      await ensureOpeningPlayPoints(
        client,
        actorId,
        profileId,
        row.legacy_key,
        row.document,
        runId,
      );
    }
    return { outcome: "materialized" };
  } catch (error) {
    // A profile that was successfully inserted is intentionally retained if a
    // later ledger/action fails. The identity map allows the next resumable
    // call to finish the idempotent ledger step. Only clean up an Auth user
    // that has not been connected to a profile.
    if (!identityMapped) {
      if (profileInserted) {
        await client.from("profiles").delete().eq("id", auth.id);
      }
      await deleteProvisionedAuthUser(client, auth.id);
    }
    throw error;
  }
}

function upsertError(error: { code?: string } | null, target: string): never {
  if (error?.code === "23505") {
    throw new SkipRecord(
      `${target} conflicts with an existing Supabase record`,
    );
  }
  throw new Error(`Could not materialize ${target}`);
}

function validTimestamp(value: unknown): string | undefined {
  return dateField(value) || undefined;
}

async function materializeGame(
  client: SupabaseClient,
  row: LegacyDocument,
): Promise<MaterializeResult> {
  const slug = textField(row.document, "slug", 96)?.toLowerCase();
  if (!slug || !/^[a-z0-9][a-z0-9-]{0,95}$/.test(slug)) {
    throw new SkipRecord("game has no supported slug");
  }
  const rawStatus = scalarText(row.document.status, 48)?.toUpperCase();
  const status = rawStatus && GAME_STATUSES.has(rawStatus)
    ? rawStatus
    : "DISABLED";
  const art = optionalRecord(row.document.art) || {};
  const { error } = await client.from("games").upsert({
    legacy_id: row.legacy_key,
    slug,
    name: textField(row.document, "name", 200) || slug,
    category: textField(row.document, "category", 120),
    tagline: textField(row.document, "tagline", 500),
    description: textField(row.document, "description", 5000),
    status,
    featured: booleanField(row.document, "featured"),
    art,
    display_order: boundedInteger(
      row.document.order ?? row.document.display_order,
      0,
      -100_000,
      100_000,
    ),
    created_at: validTimestamp(row.document.created_at),
    updated_at: validTimestamp(row.document.updated_at),
  }, { onConflict: "slug" });
  if (error) upsertError(error, "game");
  return { outcome: "materialized" };
}

async function materializeAnnouncement(
  client: SupabaseClient,
  row: LegacyDocument,
  seedUsers: Set<string>,
): Promise<MaterializeResult> {
  if (isExcludedSeedRelatedDocument(seedUsers, row.document.created_by)) {
    return {
      outcome: "excluded",
      reason:
        "record is linked to an authorized development seed administrator",
    };
  }
  const title = textField(row.document, "title", 200);
  const body = textField(row.document, "body", 5000);
  if (!title || !body) {
    throw new SkipRecord("announcement is missing title or body");
  }
  const createdBy = await userProfileId(client, row.document.created_by);
  const { error } = await client.from("announcements").upsert({
    legacy_id: row.legacy_key,
    title,
    body,
    pinned: booleanField(row.document, "pinned"),
    active: booleanField(row.document, "active", true),
    created_by: createdBy,
    created_at: validTimestamp(row.document.created_at),
    updated_at: validTimestamp(row.document.updated_at),
  }, { onConflict: "legacy_id" });
  if (error) upsertError(error, "announcement");
  return { outcome: "materialized" };
}

async function materializeSystemConfig(
  client: SupabaseClient,
  row: LegacyDocument,
  seedUsers: Set<string>,
): Promise<MaterializeResult> {
  const key = scalarText(row.document.key, 48) || "main";
  if (key !== "main") {
    throw new SkipRecord("only the main system configuration is supported");
  }
  if (isExcludedSeedRelatedDocument(seedUsers, row.document.updated_by)) {
    return {
      outcome: "excluded",
      reason:
        "configuration is linked to an authorized development seed administrator",
    };
  }
  const updatedBy = await userProfileId(client, row.document.updated_by);
  const welcomePoints = ejsonNumber(
    row.document.welcome_play_points ?? row.document.welcome_chips,
  );
  const { error } = await client.from("system_config").upsert({
    key: "main",
    maintenance_mode: booleanField(row.document, "maintenance_mode"),
    maintenance_message: textField(row.document, "maintenance_message", 500),
    min_client_version: textField(row.document, "min_client_version", 64) ||
      "1.0.0",
    welcome_play_points:
      Number.isSafeInteger(welcomePoints) && welcomePoints >= 0 &&
        welcomePoints <= 1_000_000
        ? welcomePoints
        : 1000,
    updated_by: updatedBy,
    updated_at: validTimestamp(row.document.updated_at) ||
      new Date().toISOString(),
    legacy_metadata: {
      migrated_from_legacy: true,
      source_key: key,
      legacy_points_settings_preserved_in_archive:
        row.document.points !== undefined,
    },
  }, { onConflict: "key" });
  if (error) upsertError(error, "system configuration");
  return { outcome: "materialized" };
}

async function materializeSupportMessage(
  client: SupabaseClient,
  row: LegacyDocument,
  seedUsers: Set<string>,
): Promise<MaterializeResult> {
  if (isSeedLinkedRecord(seedUsers, row.document)) {
    return {
      outcome: "excluded",
      reason: "record is linked to an authorized development seed user",
    };
  }
  const userId = await userProfileId(client, row.document.user_id);
  const body = textField(row.document, "body", 2000);
  if (!userId) {
    throw new SkipRecord("support message references an unmigrated user");
  }
  if (!body) throw new SkipRecord("support message body is invalid");
  const sender = scalarText(row.document.sender, 32)?.toUpperCase() === "ADMIN"
    ? "ADMIN"
    : "PLAYER";
  const { error } = await client.from("support_messages").upsert({
    legacy_id: row.legacy_key,
    user_id: userId,
    sender,
    body,
    read_admin: booleanField(row.document, "read_admin"),
    read_user: booleanField(row.document, "read_user"),
    created_at: validTimestamp(row.document.created_at),
  }, { onConflict: "legacy_id" });
  if (error) upsertError(error, "support message");
  return { outcome: "materialized" };
}

async function materializeNotification(
  client: SupabaseClient,
  row: LegacyDocument,
  seedUsers: Set<string>,
): Promise<MaterializeResult> {
  if (isSeedLinkedRecord(seedUsers, row.document)) {
    return {
      outcome: "excluded",
      reason: "record is linked to an authorized development seed user",
    };
  }
  const userId = await userProfileId(client, row.document.user_id);
  const title = textField(row.document, "title", 200);
  const body = textField(row.document, "body", 2000);
  if (!userId) {
    throw new SkipRecord("notification references an unmigrated user");
  }
  if (!title || !body) {
    throw new SkipRecord("notification title or body is invalid");
  }
  const { error } = await client.from("notifications").upsert({
    legacy_id: row.legacy_key,
    user_id: userId,
    title,
    body,
    type: textField(row.document, "type", 64) || "INFO",
    read: booleanField(row.document, "read"),
    created_at: validTimestamp(row.document.created_at),
  }, { onConflict: "legacy_id" });
  if (error) upsertError(error, "notification");
  return { outcome: "materialized" };
}

async function materializeSignupRequest(
  client: SupabaseClient,
  row: LegacyDocument,
  seedUsers: Set<string>,
): Promise<MaterializeResult> {
  const fullName = textField(row.document, "full_name", 160);
  const email = textField(row.document, "email", 254)?.toLowerCase();
  if (!fullName || !email || !EMAIL.test(email)) {
    throw new SkipRecord("signup request identity is invalid");
  }
  if (
    AUTHORIZED_SEED_EMAILS.has(email) ||
    isExcludedSeedRelatedDocument(
      seedUsers,
      row.document.reviewed_by ?? row.document.approved_by,
    )
  ) {
    return {
      outcome: "excluded",
      reason: "record is linked to an authorized development seed identity",
    };
  }
  const reviewedBy = await userProfileId(
    client,
    row.document.reviewed_by ?? row.document.approved_by,
  );
  const { error } = await client.from("signup_requests").upsert({
    legacy_id: row.legacy_key,
    full_name: fullName,
    email,
    date_of_birth: dateOnly(row.document.date_of_birth),
    phone: textField(row.document, "phone", 32),
    country: textField(row.document, "country", 64),
    referral_code: textField(row.document, "referral_code", 64),
    status: normaliseRequestStatus(row.document.status),
    assigned_login_id: textField(row.document, "username", 64) ||
      textField(row.document, "assigned_login_id", 64),
    admin_note: textField(row.document, "admin_note", 1000),
    reviewed_by: reviewedBy,
    reviewed_at: validTimestamp(
      row.document.reviewed_at ?? row.document.resolved_at,
    ),
    created_at: validTimestamp(row.document.created_at),
    legacy_metadata: {
      migrated_from_legacy: true,
      source_status: scalarText(row.document.status, 48),
    },
  }, { onConflict: "legacy_id" });
  if (error) upsertError(error, "signup request");
  return { outcome: "materialized" };
}

async function materializeChipRequest(
  client: SupabaseClient,
  row: LegacyDocument,
  seedUsers: Set<string>,
): Promise<MaterializeResult> {
  const type = scalarText(row.document.type, 32)?.toUpperCase() || "BUY";
  // The current control plane has exactly one virtual play-point allocation
  // request. SELL/RETURN and any cash-like conversion semantics are archived
  // only; treating them as a new credit would change user entitlements.
  if (type !== "BUY") {
    throw new SkipRecord(
      `legacy ${type} request is archived only in the virtual-points system`,
    );
  }
  if (isSeedLinkedRecord(seedUsers, row.document)) {
    return {
      outcome: "excluded",
      reason: "record is linked to an authorized development seed user",
    };
  }
  const userId = await userProfileId(client, row.document.user_id);
  if (!userId) {
    throw new SkipRecord("play-point request references an unmigrated user");
  }
  const amount = requiredPositiveInteger(
    row.document.amount,
    "request amount",
    1_000_000_000,
  );
  const reviewedBy = await userProfileId(
    client,
    row.document.reviewed_by ?? row.document.resolved_by,
  );
  const status = normaliseRequestStatus(row.document.status);
  const { error } = await client.from("play_point_requests").upsert({
    legacy_id: row.legacy_key,
    player_id: userId,
    amount,
    note: textField(row.document, "note", 1000),
    status,
    admin_note: textField(row.document, "admin_note", 1000),
    reviewed_by: reviewedBy,
    reviewed_at: validTimestamp(
      row.document.resolved_at ?? row.document.reviewed_at,
    ),
    created_at: validTimestamp(row.document.created_at),
    legacy_metadata: {
      migrated_from_legacy: true,
      source_type: type,
      source_status: scalarText(row.document.status, 48),
      // An approved source request is represented by the source user's
      // opening balance. It must never be approved again after cutover.
      settlement_reflected_in_opening_balance: status === "APPROVED",
    },
  }, { onConflict: "legacy_id" });
  if (error) upsertError(error, "play-point request");
  return { outcome: "materialized" };
}

function materializeRow(
  client: SupabaseClient,
  collection: string,
  row: LegacyDocument,
  actorId: string,
  runId: string,
  seedUsers: Set<string>,
): Promise<MaterializeResult> {
  switch (collection) {
    case "users":
      return materializeUser(client, row, actorId, runId);
    case "games":
      return materializeGame(client, row);
    case "announcements":
      return materializeAnnouncement(client, row, seedUsers);
    case "system_config":
      return materializeSystemConfig(client, row, seedUsers);
    case "signup_requests":
      return materializeSignupRequest(client, row, seedUsers);
    case "support_messages":
      return materializeSupportMessage(client, row, seedUsers);
    case "notifications":
      return materializeNotification(client, row, seedUsers);
    case "chip_requests":
      return materializeChipRequest(client, row, seedUsers);
    default:
      return Promise.resolve({
        outcome: "skipped",
        reason: "collection intentionally retained in lossless archive only",
      });
  }
}

function issueCount(manifest: Json): number {
  const issues = optionalRecord(manifest.issues);
  const total = issues ? ejsonNumber(issues.total) : 0;
  return Number.isSafeInteger(total) && total >= 0 ? total : 0;
}

async function archivedRows(
  client: SupabaseClient,
  collection: string,
  lastKey: string | null,
  limit: number,
): Promise<LegacyDocument[]> {
  let query = client
    .from("legacy_documents")
    .select("legacy_key,document,document_sha256")
    .eq("collection_name", collection)
    .order("legacy_key", { ascending: true })
    .limit(limit);
  if (lastKey) query = query.gt("legacy_key", lastKey);
  const { data, error } = await query;
  if (error) throw new Error("Could not load archived migration records");
  const rows: LegacyDocument[] = [];
  for (const item of data || []) {
    if (
      typeof item.legacy_key !== "string" ||
      typeof item.document_sha256 !== "string" || !optionalRecord(item.document)
    ) {
      throw new Error("Archived migration record is invalid");
    }
    rows.push({
      legacy_key: item.legacy_key,
      document: item.document as Json,
      document_sha256: item.document_sha256,
    });
  }
  return rows;
}

async function materializeChunk(
  client: SupabaseClient,
  run: MigrationRun,
  maxRecords: number,
): Promise<{ run: MigrationRun; complete: boolean; records: number }> {
  if (run.status !== "ARCHIVED") {
    throw new HttpError(409, "This migration run is not ready to materialize");
  }
  const sourceManifest = sourceManifestFromRun(run);
  const collections = MATERIALIZATION_ORDER.filter((name) =>
    sourceManifest.collections.some(({ name: source }) => source === name)
  );
  const actorId = await findPrimaryActor(client);
  let working = run;
  let records = 0;
  for (const collection of collections) {
    let progress = materializeProgressFor(working, collection);
    while (!progress.complete && records < maxRecords) {
      const remaining = Math.min(maxRecords - records, 50);
      const rows = await archivedRows(
        client,
        collection,
        progress.last_key,
        remaining,
      );
      if (!rows.length) {
        const manifest = cloneManifest(working);
        progress = { ...progress, complete: true };
        setMaterializeProgress(manifest, collection, progress);
        working = await saveRun(client, { ...working, manifest });
        break;
      }
      const manifest = cloneManifest(working);
      for (const row of rows) {
        try {
          const result = await materializeRow(
            client,
            collection,
            row,
            actorId,
            working.id,
            excludedSeedUserKeys(manifest),
          );
          if (result.outcome === "materialized") {
            progress = { ...progress, materialized: progress.materialized + 1 };
          } else if (result.outcome === "excluded") {
            progress = { ...progress, excluded: progress.excluded + 1 };
            if (result.seedUserKey) {
              recordSeedUserExclusion(manifest, result.seedUserKey);
            }
          } else {
            progress = { ...progress, skipped: progress.skipped + 1 };
            appendIssue(
              manifest,
              collection,
              result.reason || "record intentionally retained in archive only",
            );
          }
        } catch (error) {
          if (error instanceof SkipRecord) {
            progress = { ...progress, skipped: progress.skipped + 1 };
            appendIssue(manifest, collection, error.reason);
          } else {
            // Do not advance the durable cursor on an infrastructure or data
            // integrity failure. A retry resumes at precisely this record.
            throw error;
          }
        }
        progress = { ...progress, last_key: row.legacy_key };
        records += 1;
      }
      setMaterializeProgress(manifest, collection, progress);
      working = await saveRun(client, { ...working, manifest });
      if (rows.length < remaining) {
        const finalManifest = cloneManifest(working);
        progress = { ...progress, complete: true };
        setMaterializeProgress(finalManifest, collection, progress);
        working = await saveRun(client, {
          ...working,
          manifest: finalManifest,
        });
      }
    }
    if (records >= maxRecords) break;
  }
  const complete = collections.every((collection) =>
    materializeProgressFor(working, collection).complete
  );
  if (complete) {
    if (issueCount(working.manifest) > 0) {
      await failRun(
        client,
        working,
        "Materialization requires manual reconciliation",
      );
      throw new HttpError(
        409,
        "Materialization needs manual reconciliation before validation",
      );
    }
    working = await saveRun(client, working, "MATERIALIZED");
  }
  return { run: working, complete, records };
}

function sameManifest(left: SourceManifest, right: SourceManifest): boolean {
  if (left.collections.length !== right.collections.length) return false;
  const rightByName = new Map(
    right.collections.map((item) => [item.name, item.count]),
  );
  return left.collections.every((item) =>
    rightByName.get(item.name) === item.count
  );
}

async function archiveCount(
  client: SupabaseClient,
  collection: string,
): Promise<number> {
  const { count, error } = await client
    .from("legacy_documents")
    .select("legacy_key", { count: "exact", head: true })
    .eq("collection_name", collection);
  if (error || count === null) {
    throw new Error("Could not validate archived record count");
  }
  return count;
}

async function validateRun(
  client: SupabaseClient,
  settingsValue: Settings,
  run: MigrationRun,
): Promise<MigrationRun> {
  if (run.status !== "MATERIALIZED") {
    throw new HttpError(409, "This migration run is not ready to validate");
  }
  if (issueCount(run.manifest) > 0) {
    throw new HttpError(
      409,
      "Materialization needs manual reconciliation before validation",
    );
  }
  const recorded = sourceManifestFromRun(run);
  const current = parseSourceManifest(
    await fetchSourceJson<Json>(settingsValue, "/manifest"),
  );
  if (!sameManifest(recorded, current)) {
    await failRun(client, run, "Source manifest changed before validation");
    throw new HttpError(409, "Migration source changed before validation");
  }
  for (const { name, count } of recorded.collections) {
    const archived = await archiveCount(client, name);
    const progress = archiveProgressFor(run, name);
    if (
      !progress.complete || progress.imported !== count || archived !== count
    ) {
      await failRun(client, run, "Archived record counts did not reconcile");
      throw new HttpError(409, "Archived record counts did not reconcile");
    }
  }
  return saveRun(client, run, "VALIDATED");
}

function runSummary(run: MigrationRun, extra: Json = {}): Json {
  const source = sourceManifestFromRun(run);
  const archive = Object.fromEntries(
    source.collections.map(({ name, count }) => {
      const progress = archiveProgressFor(run, name);
      return [name, {
        source_count: count,
        archived: progress.imported,
        complete: progress.complete,
      }];
    }),
  );
  const materialize = Object.fromEntries(
    MATERIALIZATION_ORDER
      .filter((name) =>
        source.collections.some((collection) => collection.name === name)
      )
      .map((name) => {
        const progress = materializeProgressFor(run, name);
        return [name, {
          materialized: progress.materialized,
          skipped: progress.skipped,
          excluded: progress.excluded,
          complete: progress.complete,
        }];
      }),
  );
  return {
    run_id: run.id,
    status: run.status,
    archive,
    materialize,
    reconciliation_issues: issueCount(run.manifest),
    ...extra,
  };
}

async function archiveAction(
  client: SupabaseClient,
  settingsValue: Settings,
  body: Json,
): Promise<Response> {
  const runId = requestRunId(body);
  const maxPages = requestInteger(body, "max_pages", DEFAULT_MAX_PAGES, 1, 100);
  let run: MigrationRun;
  let pageLimit: number;
  if (runId) {
    run = await loadRun(client, runId);
    pageLimit = requestInteger(
      body,
      "page_limit",
      Math.min(DEFAULT_PAGE_LIMIT, sourceManifestFromRun(run).pageLimit),
      1,
      Math.min(MAX_PAGE_LIMIT, sourceManifestFromRun(run).pageLimit),
    );
  } else {
    // Validate operator-provided chunk controls before writing a STARTED row,
    // so a malformed first request can never leave the exclusive-run lock
    // behind.
    const manifest = parseSourceManifest(
      await fetchSourceJson<Json>(settingsValue, "/manifest"),
    );
    pageLimit = requestInteger(
      body,
      "page_limit",
      Math.min(DEFAULT_PAGE_LIMIT, manifest.pageLimit),
      1,
      Math.min(MAX_PAGE_LIMIT, manifest.pageLimit),
    );
    run = await createRun(client, manifest);
  }
  try {
    const result = await archiveChunk(
      client,
      settingsValue,
      run,
      pageLimit,
      maxPages,
    );
    return response(runSummary(result.run, {
      phase: result.complete ? "ARCHIVED" : "ARCHIVING",
      pages_processed: result.pages,
      next_action: result.complete ? "materialize" : "archive",
    }));
  } catch (error) {
    // Invalid user input should not invalidate a safe resumable snapshot. A
    // changed source, exporter failure, or database failure must be reviewed
    // rather than resumed against unknown data.
    if (
      !(error instanceof HttpError) || error.status >= 500 ||
      error.message.includes("source changed")
    ) {
      await failRun(client, run, "Archive phase failed");
    }
    throw error;
  }
}

async function materializeAction(
  client: SupabaseClient,
  body: Json,
): Promise<Response> {
  const runId = requestRunId(body);
  if (!runId) {
    throw new HttpError(
      400,
      "run_id is required to materialize an archived snapshot",
    );
  }
  const run = await loadRun(client, runId);
  const maxRecords = requestInteger(
    body,
    "max_records",
    DEFAULT_MAX_RECORDS,
    1,
    200,
  );
  try {
    const result = await materializeChunk(client, run, maxRecords);
    return response(runSummary(result.run, {
      phase: result.complete ? "MATERIALIZED" : "MATERIALIZING",
      records_processed: result.records,
      next_action: result.complete ? "validate" : "materialize",
    }));
  } catch (error) {
    if (!(error instanceof HttpError) || error.status >= 500) {
      await failRun(client, run, "Materialization phase failed");
    }
    throw error;
  }
}

async function validateAction(
  client: SupabaseClient,
  settingsValue: Settings,
  body: Json,
): Promise<Response> {
  const runId = requestRunId(body);
  if (!runId) {
    throw new HttpError(
      400,
      "run_id is required to validate a materialized snapshot",
    );
  }
  const run = await loadRun(client, runId);
  const validated = await validateRun(client, settingsValue, run);
  return response(
    runSummary(validated, { phase: "VALIDATED", next_action: null }),
  );
}

async function runAction(
  client: SupabaseClient,
  settingsValue: Settings,
  body: Json,
): Promise<Response> {
  const runId = requestRunId(body);
  if (!runId) return archiveAction(client, settingsValue, body);
  const run = await loadRun(client, runId);
  if (run.status === "STARTED") {
    return archiveAction(client, settingsValue, body);
  }
  if (run.status === "ARCHIVED") return materializeAction(client, body);
  if (run.status === "MATERIALIZED") {
    return validateAction(client, settingsValue, body);
  }
  if (run.status === "VALIDATED") {
    return response(runSummary(run, { phase: "VALIDATED", next_action: null }));
  }
  throw new HttpError(
    409,
    "This migration run failed and requires review before a new snapshot starts",
  );
}

async function dispatch(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return response({ detail: "Method not allowed" }, 405);
  }
  const settingsValue = settings(req);
  const body = await readBody(req);
  const action = requestedAction(body);
  const client = service();
  if (action === "archive") return archiveAction(client, settingsValue, body);
  if (action === "materialize") return materializeAction(client, body);
  if (action === "validate") return validateAction(client, settingsValue, body);
  return runAction(client, settingsValue, body);
}

// Exporting only deterministic helpers lets the migration protocol be tested
// without starting a public listener.  The deployed Edge Function still has a
// single POST entry point below.
export const migrationImportInternals = {
  fetchSourceJson,
  hmacSha256,
  isAuthorizedSeedUser,
  isSeedLinkedRecord,
  parseSourceManifest,
  sourceTarget,
  stableJson,
};

if (import.meta.main) {
  Deno.serve(async (req) => {
    try {
      return await dispatch(req);
    } catch (error) {
      return failure(error);
    }
  });
}
