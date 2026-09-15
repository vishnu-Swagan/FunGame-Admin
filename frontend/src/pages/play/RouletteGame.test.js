import { act } from "react";
import { createRoot } from "react-dom/client";
import RouletteGame from "./RouletteGame";
import { api } from "@/lib/api";
import { mountRoulette } from "./rouletteVip/engine";
import { serverSyncedDeadline } from "@/lib/serverClock";

const mockNavigate = jest.fn();
jest.mock("react-router-dom", () => ({ useNavigate: () => mockNavigate }), { virtual: true });
jest.mock("sonner", () => ({ toast: { error: jest.fn() } }));
jest.mock("@/lib/api", () => ({ api: { get: jest.fn(), post: jest.fn() }, errMsg: (error) => error.message }));
jest.mock("./rouletteVip/engine", () => ({ mountRoulette: jest.fn() }));
jest.mock("@/lib/sound", () => ({ isMuted: () => true, setMuted: jest.fn(), onMuteChange: () => () => {} }));
jest.mock("@/lib/serverClock", () => ({ serverSyncedDeadline: jest.fn(({ serverDeadlineSeconds }) => serverDeadlineSeconds * 1000) }));

let container;
let root;
let engine;

beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  jest.useFakeTimers();
  window.matchMedia = jest.fn(() => ({ matches: false }));
  serverSyncedDeadline.mockImplementation(({ serverDeadlineSeconds }) => serverDeadlineSeconds * 1000);
  engine = { applyState: jest.fn(), setHistory: jest.fn(), destroy: jest.fn() };
  mountRoulette.mockReturnValue(engine);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  jest.clearAllMocks();
  jest.useRealTimers();
});

test.each([
  [50, 10, 70, 10],
  [13, 7, 25, 5],
])("live adapter preserves server timing %s/%s/%s and opaque round identity", async (betting, spin, round, result) => {
  api.get.mockResolvedValue({ data: {
    phase: "BETTING", round_number: "roulette-v2:opaque-id",
    phase_ends_in: betting, next_round_in: round,
    phase_ends_at: 1000 + betting, round_ends_at: 1000 + round,
    server_now: 1000, clock_sampled_at: 999.9,
    betting_seconds: betting, spin_seconds: spin, round_seconds: round,
    my_bets: [], balance: 1000,
  } });
  await act(async () => {
    root.render(<RouletteGame game={{ slug: "fun-roulette" }} />);
    await Promise.resolve();
  });
  expect(api.get).toHaveBeenCalledWith("/games/fun-roulette/state");
  expect(engine.applyState).toHaveBeenCalledWith(expect.objectContaining({
    phase: "BETTING", roundNumber: "roulette-v2:opaque-id",
    secondsLeft: betting, roundSecondsLeft: round,
    phaseDeadlineMs: (1000 + betting) * 1000,
    roundDeadlineMs: (1000 + round) * 1000,
    timing: { bettingSeconds: betting, spinSeconds: spin, resultSeconds: result, roundSeconds: round },
  }));
  expect(serverSyncedDeadline).toHaveBeenCalledWith(expect.objectContaining({ serverNowSeconds: 1000, serverSampledAtSeconds: 999.9, serverDeadlineSeconds: 1000 + round }));
  expect(api.post).not.toHaveBeenCalled();
});
