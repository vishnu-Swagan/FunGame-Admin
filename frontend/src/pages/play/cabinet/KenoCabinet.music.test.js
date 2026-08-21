import { act } from "react";
import { createRoot } from "react-dom/client";
import KenoCabinet from "./KenoCabinet";
import { kenoMusic } from "@/lib/sound";

const mockNavigate = jest.fn();
let mockMuted = false;
const mockSoundListeners = new Set();

jest.mock("react-router-dom", () => ({ useNavigate: () => mockNavigate }), { virtual: true });
jest.mock("@/lib/sound", () => ({
  isMuted: () => mockMuted,
  toggleMuted: () => {
    mockMuted = !mockMuted;
    mockSoundListeners.forEach((listener) => listener(mockMuted));
  },
  onMuteChange: (listener) => {
    mockSoundListeners.add(listener);
    return () => mockSoundListeners.delete(listener);
  },
  kenoMusic: {
    start: jest.fn(() => true),
    stop: jest.fn(),
    isPlaying: jest.fn(() => false),
  },
  sfx: {
    chip: jest.fn(),
    lose: jest.fn(),
    slotBell: jest.fn(),
    winCelebration: jest.fn(),
  },
}));

beforeAll(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mockMuted = false;
  mockNavigate.mockReset();
  kenoMusic.start.mockReset().mockReturnValue(true);
  kenoMusic.stop.mockClear();
});

afterEach(() => {
  document.body.innerHTML = "";
  mockSoundListeners.clear();
});

test("Keno music starts only from its visible control and stops on exit", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(<KenoCabinet game={{ slug: "keno", name: "Keno", demo: true }} />);
  });
  const musicButton = container.querySelector('[data-testid="keno-music"]');
  expect(musicButton).not.toBeNull();
  expect(musicButton.getAttribute("aria-pressed")).toBe("false");
  expect(kenoMusic.start).not.toHaveBeenCalled();

  await act(async () => musicButton.click());
  expect(kenoMusic.start).toHaveBeenCalledTimes(1);
  expect(kenoMusic.start.mock.results[0].value).toBe(true);
  expect(container.querySelector('[data-testid="keno-music"]').getAttribute("aria-pressed")).toBe("true");

  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(container.querySelector('[data-testid="keno-music"]').getAttribute("aria-pressed")).toBe("false");
  expect(kenoMusic.stop).toHaveBeenCalled();

  await act(async () => root.unmount());
  expect(kenoMusic.stop).toHaveBeenCalled();
});
