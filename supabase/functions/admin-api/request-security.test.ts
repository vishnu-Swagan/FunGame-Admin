import {
  AdminRequestError,
  readBoundedJsonObject,
  requireStableIdempotencyKey,
} from "./request-security.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function expectRequestError(
  action: () => unknown | Promise<unknown>,
  status: number,
  code: string,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    assert(error instanceof AdminRequestError, "expected AdminRequestError");
    assert(error.status === status, `expected status ${status}, received ${error.status}`);
    assert(error.code === code, `expected code ${code}, received ${error.code}`);
    return;
  }
  throw new Error(`expected ${code} failure`);
}

Deno.test("admin mutations require a caller-owned stable idempotency key", async () => {
  await expectRequestError(
    () => requireStableIdempotencyKey(null),
    400,
    "IDEMPOTENCY_KEY_REQUIRED",
  );
  await expectRequestError(
    () => requireStableIdempotencyKey("unsafe key with spaces"),
    400,
    "INVALID_IDEMPOTENCY_KEY",
  );

  const key = "admin-points-d5a8a9f4-5a7e-4b08-aee0-3f99fc2e186e";
  assert(requireStableIdempotencyKey(key) === key, "valid key must be preserved exactly");
  assert(requireStableIdempotencyKey(key) === key, "a retry must resolve to the same key");
});

Deno.test("a small JSON object is accepted without Content-Length", async () => {
  const request = new Request("https://example.test/admin-api", {
    method: "POST",
    body: JSON.stringify({ amount: 10 }),
  });
  assert(request.headers.get("content-length") === null, "test request must be lengthless");
  const body = await readBoundedJsonObject(request, 64);
  assert(body.amount === 10, "body should be parsed");
});

Deno.test("chunked bodies cannot bypass the byte cap", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('{"note":"'));
      controller.enqueue(encoder.encode("x".repeat(80)));
      controller.enqueue(encoder.encode('"}'));
      controller.close();
    },
  });
  const request = new Request("https://example.test/admin-api", {
    method: "POST",
    body: stream,
    // Node's Fetch implementation requires duplex for streaming request
    // bodies; Deno safely ignores this additional RequestInit field.
    duplex: "half",
  } as RequestInit);
  assert(request.headers.get("content-length") === null, "stream must be chunked/lengthless");
  await expectRequestError(
    () => readBoundedJsonObject(request, 64),
    413,
    "BODY_TOO_LARGE",
  );
});

Deno.test("a false small Content-Length cannot bypass streamed-byte enforcement", async () => {
  const request = new Request("https://example.test/admin-api", {
    method: "POST",
    headers: { "content-length": "2" },
    body: JSON.stringify({ note: "x".repeat(80) }),
  });
  await expectRequestError(
    () => readBoundedJsonObject(request, 64),
    413,
    "BODY_TOO_LARGE",
  );
});

Deno.test("declared oversize and malformed JSON fail closed", async () => {
  const oversized = new Request("https://example.test/admin-api", {
    method: "POST",
    headers: { "content-length": "65" },
    body: "{}",
  });
  await expectRequestError(
    () => readBoundedJsonObject(oversized, 64),
    413,
    "BODY_TOO_LARGE",
  );

  const malformed = new Request("https://example.test/admin-api", {
    method: "POST",
    body: "not-json",
  });
  await expectRequestError(
    () => readBoundedJsonObject(malformed, 64),
    400,
    "INVALID_BODY",
  );
});
