import { auditState, formatAuditValue, reconciliationSummary } from "./adminPaymentUtils";

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
