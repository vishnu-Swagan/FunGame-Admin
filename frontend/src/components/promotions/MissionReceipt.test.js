import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import MissionReceipt from "./MissionReceipt";

jest.mock("framer-motion", () => ({
  motion: { div: ({ children, animate, transition, initial, ...props }) => <div {...props}>{children}</div>, span: ({ children, animate, transition, initial, ...props }) => <span {...props}>{children}</span> },
  useReducedMotion: () => true,
}));

jest.mock("@/components/ui/button", () => ({ Button: ({ children, ...props }) => <button {...props}>{children}</button> }));

beforeAll(() => { global.IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(() => { document.body.innerHTML = ""; });

const mission = {
  id: "mission-1",
  status: "ACTIVE",
  campaign_version: 2,
  terms_version: "terms-2",
  jurisdiction: "IN-TEST",
  deadline_at: "2026-09-05T10:00:00Z",
  server_time: "2026-09-02T10:00:00Z",
  timezone: "UTC",
  deposit: { amount_paise: 50000, chips: 500 },
  reward: { type: "BONUS_CHIPS", chips: 100 },
  progress: { target_chips: 1000, settled_chips: 0, pending_chips: 0, remaining_chips: 1000, percent: 0 },
  claim_finality: { status: "NOT_STARTED", window_hours: 24, policy_version: "settlement-v1", remaining_seconds: 0 },
  contribution_rules: { default_bps: 10000, max_qualifying_stake_chips: 200, allowed_games: ["Aviator"], excluded_games: ["Demo"] },
};

test("fills the usable viewport and repeats material post-payment terms", () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<MissionReceipt mission={mission} deposit={{ id: "deposit-1" }} onClose={jest.fn()} onStart={jest.fn()} onHelp={jest.fn()} />));

  const receipt = document.querySelector('[data-testid="mission-receipt"]');
  expect(receipt.className).toContain("min-h-[100dvh]");
  expect(document.querySelector('[role="progressbar"]').getAttribute("aria-valuenow")).toBe("0");
  expect(document.body.textContent).toContain("Deposit received");
  expect(document.body.textContent).toContain("Your deposited cash is not locked");
  expect(document.body.textContent).toContain("Version terms-2");
  expect(document.body.textContent).toContain("server verifies settled wagers for 24 hours");
  expect(document.body.textContent).toContain("policy settlement-v1");
  expect(document.querySelector('img[alt="Gold reward vault with an emerald center"]')).not.toBeNull();
  const close = document.querySelector('button[aria-label="Close mission receipt"]');
  expect(close).not.toBeNull();
  expect(close.className).toContain("h-11");
  expect(close.className).toContain("w-11");
  act(() => root.unmount());
});

test("traps focus, closes on Escape, and restores focus to the invoking control", async () => {
  const onClose = jest.fn();
  function Harness() {
    const [open, setOpen] = useState(false);
    return <><button type="button" onClick={() => setOpen(true)}>Show mission receipt</button>{open && <MissionReceipt mission={mission} onClose={() => { onClose(); setOpen(false); }} onStart={jest.fn()} onHelp={jest.fn()} />}</>;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<Harness />));
  const trigger = container.querySelector("button");
  trigger.focus();
  await act(async () => { trigger.click(); await Promise.resolve(); });

  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(document.activeElement).not.toBe(trigger);
  await act(async () => {
    document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await Promise.resolve();
  });
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  act(() => root.unmount());
});
