import { auditState, formatAuditValue, formatPaymentTime, paymentDisplayAt, reconciliationSummary } from "./adminPaymentUtils";

test("reads audit before and after from canonical fields or legacy metadata", () => {
  expect(auditState({ before: { mode: "MANUAL" }, after: { mode: "AUTOMATIC" } })).toEqual({
    before: { mode: "MANUAL" },
    after: { mode: "AUTOMATIC" },
  });
  expect(auditState({ metadata: { before: "old", after: "new" } })).toEqual({ before: "old", after: "new" });
});

test("formats audit values without rendering object values directly", () => {
  expect(formatAuditValue({ status: "PAID" })).toBe('{"status":"PAID"}');
  expect(formatAuditValue(null)).toBe("—");
});

test("summarises a bulk reconciliation response", () => {
  expect(reconciliationSummary({ result: { checked: 8, repaired: 3, review_required: 1 } }))
    .toBe("8 checked · 3 repaired · 1 need review");
});

test("admin payment clock uses provider capture time in IST", () => {
  const captured = "2026-09-02T11:17:47.759Z";
  expect(paymentDisplayAt({
    status: "CREDITED",
    created_at: "2026-09-02T06:32:05.329Z",
    provider_occurred_at: captured,
  })).toBe(captured);
  const shown = formatPaymentTime(captured);
  expect(shown).toMatch(/IST/i);
  expect(shown).toMatch(/47/);
});
