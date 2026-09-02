import {
  BALANCE_DEFINITIONS,
  LEGAL_DOCUMENT_ORDER,
  LEGAL_DOCUMENTS,
  LEGAL_POLICY_EFFECTIVE_DATE,
  LEGAL_POLICY_STATUS,
  LEGAL_POLICY_VERSION,
  LEGAL_ROUTES,
  getLegalDocument,
  isLegalPublishingReady,
  missingOperatorFields,
} from "./legalContent";

const allCopy = () => JSON.stringify(LEGAL_DOCUMENTS);

test("publishes a complete and uniquely identified policy registry", () => {
  expect(LEGAL_DOCUMENT_ORDER).toHaveLength(11);
  expect(Object.keys(LEGAL_DOCUMENTS).sort()).toEqual([...LEGAL_DOCUMENT_ORDER].sort());
  expect(Object.keys(LEGAL_ROUTES).sort()).toEqual([...LEGAL_DOCUMENT_ORDER].sort());

  const ids = LEGAL_DOCUMENT_ORDER.map((slug) => getLegalDocument(slug).id);
  expect(new Set(ids).size).toBe(ids.length);

  LEGAL_DOCUMENT_ORDER.forEach((slug) => {
    const document = getLegalDocument(slug);
    expect(document.version).toBe(LEGAL_POLICY_VERSION);
    expect(document.status).toBe(LEGAL_POLICY_STATUS);
    expect(document.effectiveDate).toBe(LEGAL_POLICY_EFFECTIVE_DATE);
    expect(document.sections.length).toBeGreaterThan(0);
    expect(new Set(document.sections.map((section) => section.id)).size).toBe(document.sections.length);
  });
});

test("keeps cash and promotional value as distinct legal concepts", () => {
  expect(BALANCE_DEFINITIONS.depositedCash).toMatch(/Cash credited/);
  expect(BALANCE_DEFINITIONS.withdrawableCash).toMatch(/Cleared deposited cash and cash winnings/);
  expect(BALANCE_DEFINITIONS.restrictedBonus).toMatch(/separate from cash/);

  const withdrawalCopy = JSON.stringify(LEGAL_DOCUMENTS.withdrawals);
  expect(withdrawalCopy).toContain("There is no blanket requirement to wager deposited cash");
  expect(withdrawalCopy).toContain("Forfeiting an unearned bonus does not forfeit deposited cash or cash winnings");

  const bonusCopy = JSON.stringify(LEGAL_DOCUMENTS.bonuses);
  expect(bonusCopy).toContain("Players must be able to continue without a bonus");
  expect(bonusCopy).toContain("Only server-confirmed settled stakes count");
});

test("does not copy the reference operator or retain virtual-only claims", () => {
  const copy = allCopy();
  expect(copy).not.toMatch(/Stake\.com/i);
  expect(copy).not.toMatch(/LottoWin/i);
  expect(copy).not.toMatch(/virtual chips only/i);
  expect(copy).not.toMatch(/no cash value/i);
});

test("fails publication readiness when status is draft or operator facts are missing", () => {
  const completeLookingConfig = {
    legalName: "Configured Operator",
    companyNumber: "Configured Number",
    registeredOffice: "Configured Office",
    regulatorName: "Configured Regulator",
    licenceNumber: "Configured Licence",
    licenceUrl: "https://example.test/licence",
    supportEmail: "support@example.test",
    privacyEmail: "privacy@example.test",
    complaintsEmail: "complaints@example.test",
    governingLaw: "Configured Law",
  };

  expect(missingOperatorFields(completeLookingConfig)).toEqual([]);
  expect(missingOperatorFields({})).toContain("legalName");
  expect(isLegalPublishingReady(completeLookingConfig)).toBe(false);
});

test("returns null for an unknown policy key", () => {
  expect(getLegalDocument("unknown-policy")).toBeNull();
});

