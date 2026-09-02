import { act } from "react";
import { createRoot } from "react-dom/client";
import OfferReview from "./OfferReview";

jest.mock("@/components/ui/checkbox", () => ({
  Checkbox: ({ checked, onCheckedChange, ...props }) => <input type="checkbox" checked={checked} onChange={(event) => onCheckedChange(event.target.checked)} {...props} />,
}));

beforeAll(() => { global.IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(() => { document.body.innerHTML = ""; });

const offer = {
  id: "campaign-1",
  campaign_id: "campaign-1",
  campaign_version: 3,
  name: "Golden mission",
  terms_version: "terms-3",
  jurisdiction: "IN",
  claim_finality_hours: 24,
  settlement_finality_policy_version: "settlement-v1",
  deposit_amount_paise: 50000,
  deposit_chips: 500,
  target_chips: 2500,
  wager_multiplier_bps: 50000,
  rate_version: "rate-1",
  quote_token: "quote-token-1",
  quote_expires_at: "2026-09-02T10:10:00Z",
  deadline_at: "2026-09-05T10:00:00Z",
  timezone: "UTC",
  reward: { type: "BONUS_CHIPS", chips: 100 },
  contribution_rules: { default_bps: 10000, max_qualifying_stake_chips: 200, allowed_games: ["aviator"], excluded_games: ["demo"] },
  withdrawal_consequence: "Deposited cash remains withdrawable; ending the mission forfeits only the unearned reward.",
  significant_terms: ["Only settled eligible wagers contribute."],
};

test("shows the complete server quote and significant terms before acceptance", () => {
  const onAcceptedChange = jest.fn();
  const container = document.createElement("div"); document.body.appendChild(container); const root = createRoot(container);
  act(() => root.render(<OfferReview offers={[offer]} selectedOfferId="campaign-1" onSelect={jest.fn()} accepted={false} onAcceptedChange={onAcceptedChange} depositPaise={50000} />));

  expect(container.textContent).toContain("Exact target");
  expect(container.textContent).toContain("2,500 settled stake");
  expect(container.textContent).toContain("5× quoted balance credit");
  expect(container.textContent).toContain("Only settled eligible wagers contribute.");
  expect(container.textContent).toContain("Deposited cash remains withdrawable");
  expect(container.textContent).toContain("24-hour server verification window");
  expect(container.textContent).toContain("policy settlement-v1");
  expect(container.textContent).toContain("accept campaign version 3, terms terms-3, and settlement-finality policy settlement-v1");
  expect(container.textContent).toContain("terms terms-3");
  act(() => container.querySelector('input[type="checkbox"]').click());
  expect(onAcceptedChange).toHaveBeenCalledWith(true);
  act(() => root.unmount());
});

test("fails closed when a current server quote is absent", () => {
  const incomplete = { ...offer, target_chips: 0, rate_version: "" };
  const container = document.createElement("div"); document.body.appendChild(container); const root = createRoot(container);
  act(() => root.render(<OfferReview offers={[incomplete]} selectedOfferId="campaign-1" onSelect={jest.fn()} accepted={false} onAcceptedChange={jest.fn()} depositPaise={50000} />));
  expect(container.textContent).toContain("server quote expired");
  expect(container.querySelector('input[type="checkbox"]').disabled).toBe(true);
  act(() => root.unmount());
});

test("fails closed when the server omits the settlement-finality term", () => {
  const incomplete = { ...offer, claim_finality_hours: 0 };
  const container = document.createElement("div"); document.body.appendChild(container); const root = createRoot(container);
  act(() => root.render(<OfferReview offers={[incomplete]} selectedOfferId="campaign-1" onSelect={jest.fn()} accepted={false} onAcceptedChange={jest.fn()} depositPaise={50000} />));
  expect(container.textContent).toContain("settlement-finality window");
  expect(container.querySelector('input[type="checkbox"]').disabled).toBe(true);
  act(() => root.unmount());
});

test.each(["", "invalid policy version!"])("fails closed for a missing or malformed finality policy version: %s", (policyVersion) => {
  const incomplete = { ...offer, settlement_finality_policy_version: policyVersion };
  const container = document.createElement("div"); document.body.appendChild(container); const root = createRoot(container);
  act(() => root.render(<OfferReview offers={[incomplete]} selectedOfferId="campaign-1" onSelect={jest.fn()} accepted={false} onAcceptedChange={jest.fn()} depositPaise={50000} />));
  expect(container.textContent).toContain("immutable finality policy version");
  expect(container.querySelector('input[type="checkbox"]').disabled).toBe(true);
  act(() => root.unmount());
});

test("continue without bonus clears the selected offer and prior acceptance", () => {
  const onSelect = jest.fn();
  const onAcceptedChange = jest.fn();
  const container = document.createElement("div"); document.body.appendChild(container); const root = createRoot(container);
  act(() => root.render(<OfferReview offers={[offer]} selectedOfferId="campaign-1" onSelect={onSelect} accepted onAcceptedChange={onAcceptedChange} depositPaise={50000} />));

  const continueWithout = [...container.querySelectorAll("button")].find((button) => button.textContent.includes("Continue without bonus"));
  act(() => continueWithout.click());
  expect(onSelect).toHaveBeenCalledWith("");
  expect(onAcceptedChange).toHaveBeenCalledWith(false);
  act(() => root.unmount());
});
