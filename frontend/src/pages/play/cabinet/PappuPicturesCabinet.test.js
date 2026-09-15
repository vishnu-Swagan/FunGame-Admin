import { act } from "react";
import { createRoot } from "react-dom/client";
import PappuPicturesCabinet from "./PappuPicturesCabinet";
import { useLiveRound } from "@/lib/useLiveRound";

const mockNavigate = jest.fn();
jest.mock("react-router-dom", () => ({ useNavigate: () => mockNavigate }), { virtual: true });
jest.mock("@/lib/useLiveRound", () => ({ useLiveRound: jest.fn() }));
jest.mock("@/components/common", () => ({ formatChips: (value) => String(value ?? 0) }));
jest.mock("@/lib/sound", () => ({
  isMuted: () => true, onMuteChange: () => () => {}, toggleMuted: jest.fn(),
  sfx: { chip: jest.fn(), betLock: jest.fn(), flip: jest.fn(), coinShower: jest.fn(), winCelebration: jest.fn(), lose: jest.fn() },
}));

let container;
let root;

beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  jest.useFakeTimers();
  jest.setSystemTime(1000000);
  HTMLElement.prototype.scrollTo = jest.fn();
  jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    setTransform: jest.fn(), createLinearGradient: () => ({ addColorStop: jest.fn() }),
    fillRect: jest.fn(), beginPath: jest.fn(), moveTo: jest.fn(), lineTo: jest.fn(), stroke: jest.fn(), fillText: jest.fn(),
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  jest.restoreAllMocks();
  jest.clearAllMocks();
  jest.useRealTimers();
});

async function advance(ms) {
  await act(async () => jest.advanceTimersByTime(ms));
}

function expectPhase(phase, seconds, betsEnabled) {
  expect(container.querySelector('[data-testid="pappu-pictures-cabinet"]').dataset.phase).toBe(phase);
  expect(container.querySelector(".pp-timer b").textContent).toBe(String(seconds));
  expect(container.querySelector('[data-testid="pappu-symbol-umbrella"]').disabled).toBe(!betsEnabled);
}

test("Pappu preview preserves the complete 20-second betting, 8-second reveal, 4-second result cycle", async () => {
  await act(async () => root.render(<PappuPicturesCabinet game={{ slug: "pappu-pictures", demo: true }} />));
  expectPhase("BETTING", 20, true);
  expect(container.querySelector(".pp-reveal")).toBeNull();
  await advance(19999);
  expectPhase("BETTING", 1, true);
  expect(container.querySelector(".pp-reveal")).toBeNull();
  await advance(1);
  expectPhase("REVEAL", 8, false);
  expect(container.querySelector(".pp-reveal")).not.toBeNull();
  await advance(7999);
  expectPhase("REVEAL", 1, false);
  await advance(1);
  expectPhase("RESULT", 4, false);
  expect(container.querySelector(".pp-reveal.is-open")).not.toBeNull();
  await advance(3999);
  expectPhase("RESULT", 1, false);
  await advance(1);
  expectPhase("BETTING", 20, true);
  expect(container.querySelector(".pp-modebar span").textContent).toBe("#5802");
  expect(container.querySelector(".pp-reveal")).toBeNull();
  expect(useLiveRound).not.toHaveBeenCalled();
});

function liveFixture(phase, countdown) {
  return {
    state: { round_number: "pappu-v2:server-round", phase, min_bet: 10, max_bet: 200, timings: { bet: 20, reveal: 8, result: 4 } },
    countdown, phase, betting: phase === "BETTING", balance: 1000, placing: false,
    outcome: phase === "BETTING" ? null : { symbol: "rose", multiplier: 8, extra_pay: false },
    myBets: [], myTotal: 0, lastResults: [], placeBet: jest.fn(), clearBets: jest.fn(), undoBet: jest.fn(), result: null,
  };
}

test("live Pappu renders server countdowns and phases, not its preview timer", async () => {
  useLiveRound.mockReturnValue(liveFixture("BETTING", 7.2));
  await act(async () => root.render(<PappuPicturesCabinet game={{ slug: "pappu-pictures" }} />));
  expectPhase("BETTING", 8, true);
  expect(useLiveRound).toHaveBeenCalledWith("pappu-pictures", { pollMs: 700, revealSound: "draw" });
  useLiveRound.mockReturnValue(liveFixture("REVEAL", 8));
  await act(async () => root.render(<PappuPicturesCabinet game={{ slug: "pappu-pictures" }} />));
  expectPhase("REVEAL", 8, false);
  useLiveRound.mockReturnValue(liveFixture("RESULT", 4));
  await act(async () => root.render(<PappuPicturesCabinet game={{ slug: "pappu-pictures" }} />));
  expectPhase("RESULT", 4, false);
  expect(container.querySelector(".pp-phase-banner").textContent).toContain("Rose 8×");
  useLiveRound.mockReturnValue(liveFixture("BETTING", 20));
  await act(async () => root.render(<PappuPicturesCabinet game={{ slug: "pappu-pictures" }} />));
  expectPhase("BETTING", 20, true);
  expect(container.querySelector(".pp-reveal")).toBeNull();
});
