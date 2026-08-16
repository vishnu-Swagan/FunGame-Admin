import { migrationImportInternals } from "./index.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("source requests use the exporter’s exact timestamped HMAC payload", async () => {
  const originalFetch = globalThis.fetch;
  const hmacSecret = "h".repeat(32);
  const settings = {
    source: new URL("https://source.example/api/migration-export"),
    importSecret: "i".repeat(32),
    hmacSecret,
  };
  let seen = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const timestamp = headers.get("x-migration-timestamp") || "";
    const nonce = headers.get("x-migration-nonce") || "";
    const bodyHash = await crypto.subtle.digest("SHA-256", new Uint8Array());
    const hex = Array.from(
      new Uint8Array(bodyHash),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const payload =
      `GET\n${url.pathname}${url.search}\n${timestamp}\n${nonce}\n${hex}`;
    const expected = await migrationImportInternals.hmacSha256(
      hmacSecret,
      payload,
    );
    assert(
      headers.get("x-migration-signature") === expected,
      "source request signature does not match exporter format",
    );
    assert(
      url.pathname === "/api/migration-export/collections/users",
      "source path is wrong",
    );
    assert(
      url.search === "?limit=1&cursor=opaque",
      "source query is not preserved in signed request",
    );
    seen = true;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const result = await migrationImportInternals.fetchSourceJson(
      settings,
      "/collections/users",
      "limit=1&cursor=opaque",
    );
    assert(result.ok === true, "source JSON did not round-trip");
    assert(seen, "source fetch was not called");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("manifest keeps Canonical Extended JSON collection counts", () => {
  const manifest = migrationImportInternals.parseSourceManifest({
    format: "bson-canonical-extended-json-v1",
    collections: [{ name: "users", count: { $numberInt: "2" } }],
    page_limit: { maximum: 250 },
  });
  assert(
    manifest.collections[0]?.name === "users",
    "manifest collection name was not read",
  );
  assert(
    manifest.collections[0]?.count === 2,
    "Canonical Extended JSON count was not read",
  );
  assert(manifest.pageLimit === 100, "page limit was not safely capped");
});

Deno.test("authorized development seed users are never provisioned", () => {
  assert(
    migrationImportInternals.isAuthorizedSeedUser({
      email: "player@fungame.app",
    }),
    "player seed identity must be excluded",
  );
  assert(
    migrationImportInternals.isAuthorizedSeedUser({
      email: "ADMIN@FUNGAME.APP",
    }),
    "admin seed identity must be excluded case-insensitively",
  );
  assert(
    !migrationImportInternals.isAuthorizedSeedUser({
      email: "real.player@example.com",
    }),
    "ordinary identities must not be excluded",
  );
  assert(
    migrationImportInternals.isSeedLinkedRecord(
      new Set(["seed-player-id"]),
      { user_id: "seed-player-id" },
    ),
    "records linked to the player seed must be excluded",
  );
  assert(
    migrationImportInternals.isSeedLinkedRecord(
      new Set(),
      { user_email: "admin@fungame.app" },
    ),
    "email-linked seed records must be excluded",
  );
});
