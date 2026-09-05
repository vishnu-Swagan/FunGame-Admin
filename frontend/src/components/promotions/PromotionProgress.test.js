import { act } from "react";
import { createRoot } from "react-dom/client";
import { ClaimFinalityNotice, MissionDeadline, PromotionProgress, formatServerDuration, rewardLabel } from "./PromotionProgress";

jest.mock("framer-motion", () => ({
  motion: { div: ({ children, animate, transition, initial, ...props }) => <div {...props}>{children}</div> },
  useReducedMotion: () => true,
}));

beforeAll(() => { global.IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(() => { document.body.innerHTML = ""; });

function render(element) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(element));
  return { container, root };
}

test("never presents restricted bonus balance as cash", () => {
  expect(rewardLabel({ type: "BONUS_CHIPS", chips: 50, paise: 5000 })).toBe("50 restricted bonus");
  expect(rewardLabel({ type: "CASH_CREDIT", chips: 50, paise: 5000 })).toContain("50");
});

test.each([
  [0, "0%"],
  [41, "41%"],
  [100, "100%"],
])("renders the exact server progress %s with accessible numeric semantics", (percent, label) => {
  const { container, root } = render(<PromotionProgress mission={{ claimable: percent === 100, progress: { percent, settled_chips: percent, target_chips: 100, pending_chips: 3, remaining_chips: 100 - percent } }} />);
  const bar = container.querySelector('[role="progressbar"]');
  expect(bar.getAttribute("aria-valuenow")).toBe(String(percent));
  expect(container.textContent).toContain(label);
  expect(container.textContent).toContain("3 pending settlement");
  act(() => root.unmount());
});

test("shows an absolute deadline and server-relative remaining time", () => {
  const { container, root } = render(<MissionDeadline mission={{ deadline_at: "2026-09-03T12:00:00Z", server_time: "2026-09-02T10:00:00Z", timezone: "UTC" }} />);
  expect(container.textContent).toContain("1d 2h remaining");
  expect(container.textContent).toContain("Ends");
  act(() => root.unmount());
});

test("announces 100 percent pending finality without presenting completion as claimable", () => {
  const mission = {
    status: "PENDING_SETTLEMENT",
    claimable: false,
    timezone: "UTC",
    progress: { percent: 100, settled_chips: 1000, target_chips: 1000, pending_chips: 0, remaining_chips: 0 },
    claim_finality: { status: "PENDING", finality_at: "2026-09-04T10:00:00Z", remaining_seconds: 3660 },
  };
  const { container, root } = render(<><PromotionProgress mission={mission} /><ClaimFinalityNotice mission={mission} /></>);
  expect(container.querySelector('[aria-live="polite"]').textContent).toContain("Settled wagers are being verified");
  expect(container.querySelector('[data-testid="claim-finality-notice"]').textContent).toContain("Verifying settled wagers");
  expect(container.textContent).toContain("Review window ends");
  expect(container.textContent).toContain("1h 1m remaining based on server time");
  expect(formatServerDuration(0)).toBe("Finality review is due");
  act(() => root.unmount());
});
