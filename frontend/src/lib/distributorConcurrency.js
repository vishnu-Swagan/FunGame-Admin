export const DISTRIBUTOR_VERSION_CONFLICT = "DISTRIBUTOR_VERSION_CONFLICT";

/** Carry the exact CRM revision the operator reviewed into every profile or
 * status mutation. Legacy rows without a revision are version zero. */
export function withExpectedDistributorVersion(distributor, fields) {
  const parsed = Number(distributor?.record_version);
  const expectedVersion = Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
  return { ...fields, expected_version: expectedVersion };
}
