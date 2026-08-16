export type JsonObject = Record<string, unknown>;

export const ADMIN_MAX_BODY_BYTES = 65_536;

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/;

export class AdminRequestError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(
    status: number,
    message: string,
    code?: string,
  ) {
    super(message);
    this.name = "AdminRequestError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Privileged ledger mutations must receive a key chosen once by the caller and
 * reused for every retry. Generating a key inside the API after a missing
 * response would turn the retry into a second, independently valid mutation.
 */
export function requireStableIdempotencyKey(value: string | null): string {
  const key = value?.trim() || "";
  if (!key) {
    throw new AdminRequestError(
      400,
      "x-idempotency-key is required for this operation",
      "IDEMPOTENCY_KEY_REQUIRED",
    );
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new AdminRequestError(
      400,
      "x-idempotency-key must be 8-160 safe characters",
      "INVALID_IDEMPOTENCY_KEY",
    );
  }
  return key;
}

function declaredBodyLength(req: Request, maxBytes: number): void {
  const raw = req.headers.get("content-length");
  if (raw === null) return;
  const normalized = raw.trim();
  if (!/^[0-9]+$/.test(normalized)) {
    throw new AdminRequestError(400, "Content-Length is invalid", "INVALID_CONTENT_LENGTH");
  }
  const length = Number(normalized);
  if (!Number.isSafeInteger(length) || length > maxBytes) {
    throw new AdminRequestError(413, "Request body is too large", "BODY_TOO_LARGE");
  }
}

async function readBoundedBytes(req: Request, maxBytes: number): Promise<Uint8Array> {
  declaredBodyLength(req, maxBytes);
  if (!req.body) return new Uint8Array();

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel("Request body is too large");
        } catch {
          // The size violation is authoritative even if the upstream stream
          // has already closed and cannot be cancelled.
        }
        throw new AdminRequestError(413, "Request body is too large", "BODY_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Read and validate a JSON object while enforcing the cap on bytes received. */
export async function readBoundedJsonObject(
  req: Request,
  maxBytes = ADMIN_MAX_BODY_BYTES,
): Promise<JsonObject> {
  let parsed: unknown;
  try {
    const bytes = await readBoundedBytes(req, maxBytes);
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(source);
  } catch (error) {
    if (error instanceof AdminRequestError) throw error;
    throw new AdminRequestError(400, "Invalid JSON request body", "INVALID_BODY");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AdminRequestError(400, "A JSON object is required", "INVALID_BODY");
  }
  return parsed as JsonObject;
}
