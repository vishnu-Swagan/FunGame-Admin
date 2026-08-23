import { withExpectedDistributorVersion } from "./distributorConcurrency";

test("distributor mutations carry the revision the administrator reviewed", () => {
  expect(withExpectedDistributorVersion({ record_version: 7 }, { status: "DISABLED" }))
    .toEqual({ status: "DISABLED", expected_version: 7 });
  expect(withExpectedDistributorVersion({ record_version: "12" }, { name: "Updated" }))
    .toEqual({ name: "Updated", expected_version: 12 });
});

test("legacy or invalid revisions fail closed to version zero", () => {
  expect(withExpectedDistributorVersion({}, { status: "ACTIVE" }).expected_version).toBe(0);
  expect(withExpectedDistributorVersion({ record_version: -1 }, {}).expected_version).toBe(0);
  expect(withExpectedDistributorVersion({ record_version: "not-a-number" }, {}).expected_version).toBe(0);
});
