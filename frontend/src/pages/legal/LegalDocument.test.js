import { act } from "react";
import { createRoot } from "react-dom/client";
import LegalDocument from "./LegalDocument";

beforeAll(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  document.body.innerHTML = "";
});

const renderPolicy = (slug) => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<LegalDocument slug={slug} />));
  return { container, root };
};

test("renders an accessible policy title, contents navigation, and version metadata", () => {
  const { container, root } = renderPolicy("withdrawals");

  expect(container.querySelectorAll("h1")).toHaveLength(1);
  expect(container.querySelector("h1").textContent).toBe("Withdrawal Policy");
  expect(container.querySelector('[data-testid="legal-status"]').textContent).toContain("DRAFT");
  expect(container.textContent).toContain("2026.09-draft.1");
  expect(container.textContent).toContain("Pending approval and publication");

  const contentNavs = container.querySelectorAll('nav[aria-label="Withdrawal Policy contents"]');
  expect(contentNavs.length).toBeGreaterThan(0);
  expect(container.querySelector('a[href="#available"]')).not.toBeNull();
  expect(container.querySelector("#available h2").textContent).toBe("What can be withdrawn");
  expect(container.querySelector('a[href="#legal-main"]')).not.toBeNull();

  act(() => root.unmount());
});

test("shows cash and bonus rules without imposing a blanket deposit wager", () => {
  const { container, root } = renderPolicy("withdrawals");

  expect(container.textContent).toContain("There is no blanket requirement to wager deposited cash");
  expect(container.textContent).toContain("Restricted promotional value and pending rewards are shown separately");
  expect(container.textContent).toContain("Forfeiting an unearned bonus does not forfeit deposited cash or cash winnings");

  act(() => root.unmount());
});

test("marks the scaffold as a controlled draft and exposes company information", () => {
  const { container, root } = renderPolicy("terms");

  expect(container.querySelector('[data-testid="legal-draft-notice"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="legal-company-information"]')).not.toBeNull();
  expect(container.textContent).toContain("This is a controlled draft");
  expect(container.textContent).toContain("Company Information");

  act(() => root.unmount());
});

test("links every document to the rest of the policy library", () => {
  const { container, root } = renderPolicy("terms");

  const related = container.querySelector('nav[aria-label="Related policies"]');
  expect(related).not.toBeNull();
  expect(related.querySelector('a[href="/legal/privacy"]')).not.toBeNull();
  expect(related.querySelector('a[href="/legal/game-rules"]')).not.toBeNull();
  expect(related.querySelector('a[href="/legal/terms"]')).toBeNull();

  act(() => root.unmount());
});

test("renders a safe fallback for an unknown policy", () => {
  const { container, root } = renderPolicy("missing");

  expect(container.querySelector("h1").textContent).toBe("This policy could not be found");
  expect(container.textContent).toContain("Return to Chakri.Casino");

  act(() => root.unmount());
});

