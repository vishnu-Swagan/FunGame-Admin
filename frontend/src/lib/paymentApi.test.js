import { responseRows } from "./paymentApi";

test("payment response rows accept the canonical key and a rollout alias", () => {
  expect(responseRows({ audit: [{ id: "a" }] }, "audit", ["events"])).toEqual([{ id: "a" }]);
  expect(responseRows({ events: [{ id: "legacy" }] }, "audit", ["events"])).toEqual([{ id: "legacy" }]);
  expect(responseRows({}, "audit", ["events"])).toEqual([]);
});
