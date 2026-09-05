import { normalizeRegistrationPolicies } from "./legalPolicies";

test("normalizes server-owned registration policy metadata", () => {
  const policies = normalizeRegistrationPolicies({
    schema_version: 1,
    documents: {
      terms: { title: "Terms", version: "account-terms-2026.09", url: "/legal/terms", required: true },
      privacy: { title: "Privacy", version: "privacy-2026.09", url: "https://legal.example/privacy", required: true },
    },
    acceptance: { explicit_versions_required: true },
  });

  expect(policies.terms.version).toBe("account-terms-2026.09");
  expect(policies.privacy.url).toBe("https://legal.example/privacy");
  expect(policies.explicitVersionsRequired).toBe(true);
});

test("rejects malformed versions and unsafe URLs fall back to local policies", () => {
  expect(() => normalizeRegistrationPolicies({ documents: { terms: { version: "bad value" }, privacy: { version: "privacy-v1" } } })).toThrow();

  const policies = normalizeRegistrationPolicies({
    documents: {
      terms: { version: "terms-v1", url: "javascript:alert(1)" },
      privacy: { version: "privacy-v1", url: "//evil.example/privacy" },
    },
  });
  expect(policies.terms.url).toBe("/legal/terms");
  expect(policies.privacy.url).toBe("/legal/privacy");
});
