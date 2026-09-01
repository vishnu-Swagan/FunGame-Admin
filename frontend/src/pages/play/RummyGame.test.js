import { act } from "react";
import { createRoot } from "react-dom/client";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { api } from "@/lib/api";
import { toast } from "sonner";
import RummyGame, { CategoryLobby, getRummyScheduleInfo, nextRummyPollDelay, PlayerSeat, requestRummyLandscape, Results, RummyCard, RummyLandscapeGuard, RummyTable, rummyTurnAnnouncement, shouldBlockRummyPortrait, visibleRummyName } from "./RummyGame";
import { applyRummyDemoAction, createRummyDemoState, RUMMY_DEMO_CATEGORIES } from "./rummyDemo";


jest.mock("react-router-dom", () => ({ useNavigate: () => jest.fn() }), { virtual: true });
jest.mock("sonner", () => ({ toast: { info: jest.fn(), error: jest.fn() } }));
jest.mock("@/lib/api", () => ({
  api: { get: jest.fn(), post: jest.fn() },
  errCode: (error) => error?.response?.data?.detail?.code || error?.response?.data?.code || null,
  errMsg: (error, fallback) => error?.response?.data?.detail?.message || error?.message || fallback,
}));
jest.mock("@/lib/sound", () => ({
  isMuted: () => false,
  onMuteChange: () => () => {},
  toggleMuted: jest.fn(),
  sfx: {},
}));
jest.mock("@/components/common", () => ({ formatChips: (value) => String(value ?? 0) }));
jest.mock("./RummyAtmosphere", () => ({
  __esModule: true,
  default: ({ phase }) => <canvas data-rummy-atmosphere={phase} />,
  RUMMY_ATMOSPHERE_PHASES: {
    TABLE: "table", DRAW: "draw", DISCARD: "discard", VALID_DECLARE: "valid-declare", INVALID: "invalid", DROP: "drop",
  },
}));


beforeAll(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
});

function renderSeat(seat, viewerSeatIndex, timer = null, turnDuration = 30) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<PlayerSeat seat={seat} viewerSeatIndex={viewerSeatIndex} timer={timer} turnDuration={turnDuration} reducedMotion />);
  });
  return { container, root };
}

afterEach(() => {
  jest.clearAllMocks();
  api.get.mockReset();
  api.post.mockReset();
  document.body.innerHTML = "";
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function click(element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

async function typeInto(element, value) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

async function pressKey(key, options = {}) {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options }));
    await Promise.resolve();
  });
}

async function render(element) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
    await Promise.resolve();
  });
  return { container, root };
}

function cssBlock(source, anchor) {
  const anchorIndex = source.indexOf(anchor);
  if (anchorIndex < 0) throw new Error(`CSS anchor not found: ${anchor}`);
  const openIndex = source.indexOf("{", anchorIndex);
  if (openIndex < 0) throw new Error(`CSS block not opened: ${anchor}`);
  let depth = 1;
  for (let index = openIndex + 1; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(openIndex + 1, index);
  }
  throw new Error(`CSS block not closed: ${anchor}`);
}

function cssRuleWithin(source, selector) {
  return cssBlock(source, `${selector} {`);
}

test("a live user seated away from seat zero never sees a back stack on their own seat", () => {
  const viewer = { seatIndex: 3, status: "ACTIVE", displayName: "You", playerId: "PL***01", isBot: false, cardCount: 13 };
  const { container, root } = renderSeat(viewer, 3);
  expect(container.querySelector(".rummy-card-back")).toBeNull();
  act(() => root.unmount());
});

test("opponents retain hidden backs and only the active seat renders the one countdown", () => {
  const opponent = { seatIndex: 1, status: "ACTIVE", displayName: "Rival", playerId: "PL***02", isBot: false, cardCount: 13, active: true };
  const { container, root } = renderSeat(opponent, 3, 18.2);
  expect(container.querySelector(".rummy-card-back")).not.toBeNull();
  expect(container.querySelector('[data-testid="rummy-seat-avatar-1"] img')?.getAttribute("src")).toBe("/game-art/avatars/cartoon/avatar-02.png");
  expect(container.querySelectorAll(".rummy-only-timer")).toHaveLength(1);
  expect(container.querySelector(".rummy-only-timer")?.textContent).toBe("19");
  expect(container.querySelector(".rummy-only-timer")?.getAttribute("role")).toBe("timer");
  expect(container.querySelector(".rummy-avatar-ring")?.classList.contains("is-emerald")).toBe(true);
  expect(container.querySelector(".rummy-only-timer").parentElement).toBe(container.querySelector(".rummy-avatar-ring"));
  act(() => root.unmount());
});

test("the turn ring changes from emerald to amber to ruby as seconds run down", () => {
  const seat = { seatIndex: 2, status: "ACTIVE", displayName: "Rival", playerId: "PL***03", isBot: false, cardCount: 13, active: true };
  const amber = renderSeat(seat, 0, 12, 30);
  expect(amber.container.querySelector(".rummy-avatar-ring")?.classList.contains("is-amber")).toBe(true);
  expect(amber.container.querySelector(".rummy-only-timer")?.textContent).toBe("12");
  act(() => amber.root.unmount());

  const ruby = renderSeat(seat, 0, 5, 30);
  expect(ruby.container.querySelector(".rummy-avatar-ring")?.classList.contains("is-ruby")).toBe(true);
  expect(ruby.container.querySelector(".rummy-only-timer")?.textContent).toBe("5");
  act(() => ruby.root.unmount());
});

test("turn urgency is announced only as a start, halfway, and final-seconds phase", () => {
  const ownSeat = { seatIndex: 3, displayName: "You", isBot: false };
  const rival = { seatIndex: 1, displayName: "Mira", isBot: true };
  expect(rummyTurnAnnouncement(ownSeat, 3, 30, 30)).toBe("Your turn started.");
  expect(rummyTurnAnnouncement(ownSeat, 3, 15, 30)).toBe("Less than half of your turn remains.");
  expect(rummyTurnAnnouncement(ownSeat, 3, 6, 30)).toBe("Final seconds for your turn.");
  expect(rummyTurnAnnouncement(rival, 3, 15, 30)).toBe("Less than half of Mira's turn remains.");
  expect(rummyTurnAnnouncement(null, 3, null, 30)).toBe("");
});

test("an undealt wild joker renders a placeholder instead of crashing the table", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<RummyCard card={null} compact />));
  expect(container.querySelector(".rummy-card-placeholder")?.textContent).toBe("?");
  act(() => root.unmount());
});

test("printed and rank wild jokers remain distinct, readable card faces", () => {
  const printedContainer = document.createElement("div");
  const printedRoot = createRoot(printedContainer);
  act(() => printedRoot.render(<RummyCard card={{ id: "pj-1", code: "PJ", printedJoker: true }} />));
  const printed = printedContainer.querySelector(".rummy-card");
  expect(printed?.classList.contains("is-printed-joker")).toBe(true);
  expect(printed?.classList.contains("is-rank-wild")).toBe(false);
  expect(printed?.dataset.jokerKind).toBe("printed");
  expect(printed?.getAttribute("aria-label")).toBe("Printed joker");
  expect(printedContainer.querySelector(".rummy-joker-emblem")?.textContent).toContain("JOKER");
  expect(printedContainer.querySelector(".rummy-wild-badge")).toBeNull();
  act(() => printedRoot.unmount());

  const rankContainer = document.createElement("div");
  const rankRoot = createRoot(rankContainer);
  act(() => rankRoot.render(<RummyCard card={{ id: "7d", code: "7D", rank: 7, suit: "D" }} wildRank={7} />));
  const rankWild = rankContainer.querySelector(".rummy-card");
  expect(rankWild?.classList.contains("is-rank-wild")).toBe(true);
  expect(rankWild?.classList.contains("is-printed-joker")).toBe(false);
  expect(rankWild?.dataset.jokerKind).toBe("rank-wild");
  expect(rankWild?.getAttribute("role")).toBe("img");
  expect(rankWild?.getAttribute("aria-label")).toBe("7 of diamonds, wild joker");
  expect(rankContainer.querySelector(".rummy-wild-badge")?.textContent).toBe("W");
  expect(rankContainer.querySelector(".rummy-joker-emblem")).toBeNull();
  act(() => rankRoot.unmount());
});

test("non-player seat metadata never appears as a technical badge", () => {
  const bot = { seatIndex: 1, status: "ACTIVE", displayName: "Mira", avatar: "avatar-37", isBot: true, botLabel: "Expert bot", cardCount: 13 };
  const { container, root } = renderSeat(bot, 3);
  expect(container.textContent).toContain("Mira");
  expect(container.textContent).toContain("PLAYING");
  expect(container.textContent).not.toMatch(/\bauto\b/i);
  expect(container.textContent).not.toMatch(/\bbots?\b/i);
  expect(container.querySelector(".rummy-seat-bot-badge")).toBeNull();
  expect(container.querySelector('[data-testid="rummy-seat-avatar-1"] img')?.getAttribute("src")).toBe("/game-art/avatars/cartoon/avatar-37.png");
  act(() => root.unmount());
});

test("occupied seats use uploaded or configured portraits with deterministic varied fallbacks", () => {
  const uploaded = { seatIndex: 0, status: "ACTIVE", displayName: "You", avatar: "avatar-37", avatarUrl: "/api/profile/avatar/current", isBot: false, cardCount: 13 };
  const firstFallback = { seatIndex: 2, status: "ACTIVE", displayName: "Leela", avatar: "gem", isBot: false, cardCount: 13 };
  const secondFallback = { seatIndex: 4, status: "ACTIVE", displayName: "Kabir", avatar: "spade", isBot: false, cardCount: 13 };
  const empty = { seatIndex: 3, status: "EMPTY", displayName: "", isBot: false, cardCount: 0 };

  const uploadedSeat = renderSeat(uploaded, 0);
  expect(uploadedSeat.container.querySelector("img")?.getAttribute("src")).toBe("/api/profile/avatar/current");
  expect(uploadedSeat.container.querySelector("img")?.getAttribute("alt")).toBe("You portrait");
  act(() => uploadedSeat.root.unmount());

  const fallbackA = renderSeat(firstFallback, 0);
  expect(fallbackA.container.querySelector("img")?.getAttribute("src")).toBe("/game-art/avatars/cartoon/avatar-03.png");
  act(() => fallbackA.root.unmount());

  const fallbackB = renderSeat(secondFallback, 0);
  expect(fallbackB.container.querySelector("img")?.getAttribute("src")).toBe("/game-art/avatars/cartoon/avatar-05.png");
  act(() => fallbackB.root.unmount());

  const emptySeat = renderSeat(empty, 0);
  expect(emptySeat.container.querySelector("img")).toBeNull();
  expect(emptySeat.container.querySelector(".rummy-empty-avatar")?.textContent).toBe("+");
  act(() => emptySeat.root.unmount());
});

test("three-minute server matchmaking metadata renders an exact countdown", async () => {
  const now = 1_800_000_000_000;
  expect(getRummyScheduleInfo({ matchmaking: { cycleSeconds: 180, cycleId: "LV3:42", scheduledStartAtEpoch: (now + 179_200) / 1000 } }, now)).toEqual({
    seconds: 180,
    scheduledAt: now + 179_200,
    cycleSeconds: 180,
    scheduleId: "LV3:42",
  });
  expect(getRummyScheduleInfo({ liveMatchmaking: { cycleSeconds: 180, cycleId: "LV4:8", nextScheduledStartAtEpoch: (now + 61_100) / 1000, startsIn: 99 } }, now)).toEqual({
    seconds: 62,
    scheduledAt: now + 61_100,
    cycleSeconds: 180,
    scheduleId: "LV4:8",
  });

  const waiting = createRummyDemoState("LV3");
  waiting.state = "WAITING_FOR_PLAYERS";
  waiting.privateState = null;
  waiting.matchmaking = { cycleSeconds: 180, cycleId: "LV3:42", startsIn: 180, missingSeats: 4 };
  waiting.seats = [waiting.seats[0], ...waiting.seats.slice(1).map((seat) => ({ seatIndex: seat.seatIndex, status: "EMPTY", cardCount: 0 }))];
  const { container, root } = await render(<RummyTable state={waiting} busy={false} reconnecting={false} sendAction={jest.fn()} onExit={jest.fn()} />);
  expect(container.querySelector('[data-testid="rummy-next-table-countdown"]')?.textContent).toContain("03:00");
  expect(container.querySelector('[data-testid="rummy-next-table-countdown"]')?.textContent).toContain("3 min cycle");
  act(() => root.unmount());
});

test("royal table conversation uses player names and sends only allow-listed code reactions", async () => {
  const state = createRummyDemoState("LV2");
  state.chatEvents = [{
    id: "BOT-CHAT-1",
    reactionId: "laugh",
    message: "AUTO atmosphere suggestion: That was close!",
    sender: { displayName: "Maharaja Arin", isBot: true, label: "BOT", botLabel: "BOT · CLASSIC" },
  }];
  const sendSocialEvent = jest.fn().mockResolvedValue({
    accepted: true,
    event: { id: "PLAYER-GIF-1", reactionId: "royal-clap", message: "A royal applause!", sender: { displayName: "You", isBot: false } },
  });
  const { container, root } = await render(<RummyTable state={state} busy={false} reconnecting={false} sendAction={jest.fn()} sendSocialEvent={sendSocialEvent} onExit={jest.fn()} />);
  await click(container.querySelector('button[aria-label="Open Rummy table conversation"]'));
  expect(container.querySelector(".rummy-social-drawer")).not.toBeNull();
  expect(container.querySelector(".rummy-chat-log")?.textContent).toContain("Maharaja Arin");
  expect(container.querySelector(".rummy-chat-log")?.textContent).toContain("That was close!");
  expect(container.querySelector(".rummy-chat-log")?.textContent).not.toMatch(/\bauto\b/i);
  expect(container.querySelector(".rummy-chat-log")?.textContent).not.toMatch(/\bbots?\b/i);
  const royalClap = container.querySelector('button[aria-label="Royal clap animated reaction"]');
  await click(royalClap);
  expect(sendSocialEvent).toHaveBeenCalledWith({ eventType: "GIF", reactionId: "royal-clap" });
  expect(container.querySelector(".rummy-chat-log")?.textContent).toContain("A royal applause!");
  act(() => root.unmount());
});

test("generated ambience is opt-in and music requests are submitted without promising an instant reply", async () => {
  const state = createRummyDemoState("LV1");
  const audioController = {
    enableFromGesture: jest.fn().mockResolvedValue(true),
    startAmbient: jest.fn().mockResolvedValue(true),
    stopAmbient: jest.fn(),
    setAmbientVolume: jest.fn(),
    setAmbientPreset: jest.fn(),
  };
  const onSupportRequest = jest.fn().mockResolvedValue({ accepted: true, requestStatus: "SUBMITTED" });
  const { container, root } = await render(<RummyTable state={state} busy={false} reconnecting={false} sendAction={jest.fn()} onSupportRequest={onSupportRequest} onExit={jest.fn()} audioController={audioController} />);
  await click(container.querySelector('button[aria-label="Open Rummy table conversation"]'));
  await click([...container.querySelectorAll(".rummy-social-drawer nav button")].find((button) => button.textContent.includes("Music")));
  const ambience = [...container.querySelectorAll("button")].find((button) => button.textContent.includes("PLAY AMBIENCE"));
  expect(ambience.getAttribute("aria-pressed")).toBe("false");
  expect(audioController.startAmbient).not.toHaveBeenCalled();
  await click(ambience);
  expect(audioController.enableFromGesture).toHaveBeenCalled();
  expect(audioController.startAmbient).toHaveBeenCalled();
  expect([...container.querySelectorAll("button")].find((button) => button.textContent.includes("STOP AMBIENCE"))).toBeDefined();
  expect(container.querySelector(".rummy-music-status")?.textContent).toContain("playing");

  const request = container.querySelector('textarea[aria-label="Music request"]');
  expect(request.maxLength).toBe(120);
  await typeInto(request, "Play a calm instrumental mood");
  await click([...container.querySelectorAll("button")].find((button) => button.textContent.includes("SEND MUSIC REQUEST")));
  expect(onSupportRequest).toHaveBeenCalledWith("MUSIC_REQUEST", "Play a calm instrumental mood");
  expect(container.querySelector(".rummy-music-pane .rummy-support-status:not(.rummy-music-status)")?.textContent).toContain("Support inbox");
  await click([...container.querySelectorAll(".rummy-social-drawer nav button")].find((button) => button.textContent.includes("Help Desk")));
  expect(container.querySelector(".rummy-table-disclosure")).toBeNull();
  expect(container.querySelector('textarea[aria-label="Help Desk message"]').maxLength).toBe(240);
  act(() => root.unmount());
});

test("music and Help Desk expose device and server outcomes in the drawer", async () => {
  const state = createRummyDemoState("LV1");
  const audioController = {
    enableFromGesture: jest.fn().mockResolvedValue(false),
    startAmbient: jest.fn().mockResolvedValue(false),
    stopAmbient: jest.fn(),
    setAmbientVolume: jest.fn(),
    setAmbientPreset: jest.fn(),
  };
  const onSupportRequest = jest.fn()
    .mockResolvedValueOnce({ accepted: true, requestStatus: "QUEUED" })
    .mockRejectedValueOnce(new Error("Support service unavailable"));
  const { container, root } = await render(<RummyTable state={state} busy={false} reconnecting={false} sendAction={jest.fn()} onSupportRequest={onSupportRequest} onExit={jest.fn()} audioController={audioController} />);
  await click(container.querySelector('button[aria-label="Open Rummy table conversation"]'));
  await click([...container.querySelectorAll(".rummy-social-drawer nav button")].find((button) => button.textContent.includes("Music")));
  await click([...container.querySelectorAll("button")].find((button) => button.textContent.includes("PLAY AMBIENCE")));
  expect(container.querySelector(".rummy-music-status")?.textContent).toContain("could not start");

  await click([...container.querySelectorAll(".rummy-social-drawer nav button")].find((button) => button.textContent.includes("Help Desk")));
  const request = container.querySelector('textarea[aria-label="Help Desk message"]');
  await typeInto(request, "Please review this hand");
  await click([...container.querySelectorAll("button")].find((button) => button.textContent.includes("SUBMIT TO HELP DESK")));
  expect(container.querySelector(".rummy-support-status")?.textContent).toContain("Request queued");

  await typeInto(request, "Please retry this hand");
  await click([...container.querySelectorAll("button")].find((button) => button.textContent.includes("SUBMIT TO HELP DESK")));
  expect(container.querySelector(".rummy-support-status")?.textContent).toContain("Support service unavailable");
  act(() => root.unmount());
});

test("the active ring uses the category turn duration instead of a hard-coded thirty seconds", () => {
  const opponent = { seatIndex: 1, status: "ACTIVE", displayName: "Rival", playerId: "PL***02", isBot: false, cardCount: 13, active: true };
  const { container, root } = renderSeat(opponent, 3, 22, 22);
  expect(container.querySelector(".rummy-avatar-ring")?.style.getPropertyValue("--turn-progress")).toBe("1");
  act(() => root.unmount());
});

test("partial server seat arrays still render all five visible table positions", async () => {
  const state = createRummyDemoState("LV1");
  state.seats = state.seats.slice(0, 2);
  const { container, root } = await render(<RummyTable state={state} busy={false} reconnecting={false} sendAction={jest.fn()} onExit={jest.fn()} />);
  expect(container.querySelectorAll(".rummy-table .rummy-seat")).toHaveLength(5);
  expect(container.querySelectorAll(".rummy-table .rummy-empty-avatar")).toHaveLength(3);
  act(() => root.unmount());
});

test("the live Rummy table leaves Chakri branding in the lobby", () => {
  const source = fs.readFileSync(path.join(__dirname, "RummyGame.js"), "utf8");
  expect(source).not.toContain("BrandWordmark");
  expect(source).not.toContain('className="rummy-brand-lockup"');
});

test("the Rummy lobby presents all five levels without showing the gameplay table", async () => {
  const { container, root } = await render(<RummyGame game={{ slug: "rummy", name: "Rummy", demo: true }} />);
  const lobby = container.querySelector('[data-testid="rummy-category-lobby"]');
  expect(lobby).not.toBeNull();
  expect(lobby.textContent).toContain("CHAKRI.CASINO");
  expect(lobby.textContent).toContain("PLAY IN THE LIGHT");
  expect(lobby.textContent).toContain("Choose your royal table");
  expect(lobby.querySelectorAll('[role="img"][aria-label="CHAKRI.CASINO — PLAY IN THE LIGHT"]')).toHaveLength(1);
  expect(lobby.querySelector('header img[src="/chakri-roulette-emblem-transparent.png"]')).not.toBeNull();
  expect(lobby.querySelector(".rummy-lobby-table-preview")).toBeNull();
  expect(lobby.querySelector('img[src="/game-art/rummy/table-palace-v2.png"]')).toBeNull();
  expect(lobby.querySelectorAll(".rpl-card-fan > i")).toHaveLength(13);
  expect(lobby.querySelectorAll(".rpl-level-card")).toHaveLength(5);
  expect(lobby.querySelectorAll(".rpl-level-card.is-featured")).toHaveLength(1);
  expect([...lobby.querySelectorAll(".rpl-level-card")].map((card) => card.textContent).join(" ")).toMatch(/LV1[\s\S]*LV2[\s\S]*LV3[\s\S]*LV4[\s\S]*LV5/);
  const practiceButtons = [...lobby.querySelectorAll("button")].filter((button) => button.textContent === "PRACTICE TABLE");
  expect(practiceButtons).toHaveLength(5);
  practiceButtons.forEach((button) => expect(button.disabled).toBe(false));
  expect(lobby.textContent).not.toContain("FAIR BOT TABLE");
  expect(lobby.textContent).not.toContain("Secure server shuffle · Practice is wallet-neutral · automated players are labelled in-game");
  expect(lobby.querySelector("footer")?.textContent).not.toContain("Secure server shuffle");
  expect(lobby.querySelector(".rpl-footer")?.textContent).toBe("CHAKRI.CASINO · RUMMY");
  expect(lobby.textContent).not.toMatch(/\bauto\b/i);
  expect(lobby.textContent).not.toMatch(/\bbots?\b/i);
  act(() => root.unmount());
});

test("only paid Live entry is balance-gated while every Practice table stays available", async () => {
  const { container, root } = await render(
    <CategoryLobby
      categories={RUMMY_DEMO_CATEGORIES}
      balance={750}
      busy={false}
      loading={false}
      error={false}
      joinFailure={null}
      preview={false}
      onJoin={jest.fn()}
      onRetry={jest.fn()}
      onExit={jest.fn()}
    />,
  );
  const cards = [...container.querySelectorAll(".rpl-level-card")];
  expect(cards).toHaveLength(5);
  cards.forEach((card, index) => {
    const live = [...card.querySelectorAll("button")].find((button) => button.textContent === "JOIN LIVE");
    const practice = [...card.querySelectorAll("button")].find((button) => button.textContent === "PRACTICE TABLE");
    expect(practice.disabled).toBe(false);
    expect(live.disabled).toBe(index > 1);
  });
  act(() => root.unmount());
});

test("Live entry requires the larger of the configured minimum and entry stake", async () => {
  const category = { ...RUMMY_DEMO_CATEGORIES[1], minChipBalance: 100, entryChips: 500 };
  const { container, root } = await render(
    <CategoryLobby
      categories={[category]}
      balance={300}
      busy={false}
      loading={false}
      error={false}
      joinFailure={null}
      preview={false}
      onJoin={jest.fn()}
      onRetry={jest.fn()}
      onExit={jest.fn()}
    />,
  );
  const live = [...container.querySelectorAll("button")].find((button) => button.textContent === "JOIN LIVE");
  const practice = [...container.querySelectorAll("button")].find((button) => button.textContent === "PRACTICE TABLE");
  expect(live.disabled).toBe(true);
  expect(practice.disabled).toBe(false);
  expect(container.textContent).toContain("Live requires 500 chips");
  act(() => root.unmount());
});

test("the deterministic preview completes draw and atomic discard-and-declare without API access", async () => {
  const { container, root } = await render(<RummyGame game={{ slug: "rummy", name: "Rummy", demo: true }} />);
  expect(api.get).not.toHaveBeenCalled();
  const practice = [...container.querySelectorAll("button")].find((button) => button.textContent.includes("PRACTICE TABLE"));
  await click(practice);
  expect(container.querySelector('[data-testid="rummy-live-table"]')).not.toBeNull();
  expect(container.querySelector(".rummy-live-pill")?.textContent).toContain("PRACTICE MODE");
  expect(container.querySelector(".rummy-bot-table-notice")).toBeNull();
  expect(container.querySelector(".rummy-table-opponent-disclosure")).toBeNull();
  expect(container.querySelector('.rummy-sr-only[role="status"]')?.textContent).toBe("Your turn started.");
  expect(container.querySelector('.rummy-sr-only[role="status"]')?.getAttribute("aria-live")).toBe("polite");
  expect(container.querySelector('[data-testid="rummy-live-table"]')?.textContent).not.toMatch(/\bauto\b/i);
  expect(container.querySelector('[data-testid="rummy-live-table"]')?.textContent).not.toMatch(/\bbots?\b/i);
  expect(container.textContent).toContain("PURE SEQUENCE");

  await click(container.querySelector('button[aria-label="CLOSED DECK"]'));
  const drawn = container.querySelector('button[data-card-id="DEMO-2-C-2"]');
  expect(drawn).not.toBeNull();
  await click(drawn);
  const declare = [...container.querySelectorAll(".rummy-actions button")].find((button) => button.textContent.includes("DISCARD & DECLARE"));
  expect(declare.disabled).toBe(false);
  expect(container.querySelector(".rummy-validation")?.textContent).toContain("Ready");
  await click(declare);
  const settlement = container.querySelector('.rummy-royal-settlement[data-phase="celebration"]');
  expect(settlement).not.toBeNull();
  expect(container.querySelector("#rrs-title")?.textContent).toBe("You win");
  expect(container.querySelector('[data-testid="rrs-celebration-stage"]')).not.toBeNull();
  expect(container.querySelector(".rrs-payout")?.dataset.payoutChips).toBe("0");
  expect(settlement.textContent).not.toMatch(/\bauto\b/i);
  expect(container.querySelector(".rummy-balance")?.textContent).toContain("12000");
  act(() => root.unmount());
});

test("preview reducer supports ordinary discard and drop settlement while remaining wallet-neutral", () => {
  const initial = createRummyDemoState("LV1");
  const drawn = applyRummyDemoAction(initial, "DRAW_CLOSED");
  const discarded = applyRummyDemoAction(drawn, "DISCARD", { cardId: drawn.privateState.drawnCardId });
  expect(discarded.state).toBe("TURN_ACTIVE");
  expect(discarded.privateState.cards).toHaveLength(13);
  expect(discarded.balance).toBe(initial.balance);
  const dropped = applyRummyDemoAction(discarded, "DROP");
  expect(dropped.state).toBe("ROUND_SETTLED");
  expect(dropped.result.rows[0].status).toBe("DROPPED");
  expect(dropped.seats[0].droppedPoints).toBe(20);
  expect(dropped.balance).toBe(initial.balance);
  expect(dropped.result.payoutChips).toBe(0);
});

test("drop confirmation traps forward and reverse focus, restores the trigger, and absorbs audio rejection", async () => {
  const state = createRummyDemoState("LV1");
  const audioController = { play: jest.fn(() => Promise.reject(new Error("audio unavailable"))) };
  const { container, root } = await render(<RummyTable state={state} busy={false} reconnecting={false} sendAction={jest.fn()} onExit={jest.fn()} audioController={audioController} />);
  const dropTrigger = [...container.querySelectorAll(".rummy-actions button")].find((button) => button.textContent.trim() === "DROP");
  dropTrigger.focus();
  await click(dropTrigger);

  const dialog = container.querySelector(".rummy-confirm[aria-modal='true']");
  const buttons = [...dialog.querySelectorAll("button")];
  expect(audioController.play).toHaveBeenCalledWith("ui-tap");
  expect(document.activeElement).toBe(buttons[0]);
  await pressKey("Tab", { shiftKey: true });
  expect(document.activeElement).toBe(buttons[buttons.length - 1]);
  await pressKey("Tab");
  expect(document.activeElement).toBe(buttons[0]);

  await pressKey("Escape");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 240)); });
  expect(container.querySelector(".rummy-confirm")).toBeNull();
  expect(document.activeElement).toBe(dropTrigger);
  act(() => root.unmount());
});

test("results derive the player win from seat identity, trap focus, and remove reduced-motion transforms", async () => {
  const returnTarget = document.createElement("button");
  document.body.appendChild(returnTarget);
  returnTarget.focus();
  const onLobby = jest.fn();
  const result = {
    winnerSeat: 2,
    winnerName: "Maya",
    payoutChips: 300,
    reason: "VALID_DECLARATION",
    rows: [{ seatIndex: 2, displayName: "Maya", status: "WON", points: 0, chipDelta: 300, cards: [] }],
  };
  const { container, root } = await render(<Results result={result} viewerSeatIndex={2} onLobby={onLobby} reducedMotion />);
  const panel = container.querySelector(".rummy-royal-settlement");
  const lobbyButton = panel.querySelector(".rrs-summary-actions button");
  expect(panel.classList.contains("is-player-win")).toBe(true);
  expect(panel.dataset.reducedMotion).toBe("true");
  expect(panel.dataset.phase).toBe("summary");
  expect(container.querySelector("#rrs-title")?.textContent).toBe("You win");
  expect(container.querySelector('[data-testid="rrs-summary-stage"]')).not.toBeNull();
  expect(container.querySelector(".rrs-particles")).toBeNull();
  expect(document.activeElement).toBe(lobbyButton);
  [...panel.querySelectorAll(".rrs-summary-hero, .rrs-final-hand, .rrs-standing-rows article")].forEach((element) => {
    expect(["", "none"]).toContain(element.style.transform);
  });
  await pressKey("Tab");
  expect(document.activeElement).toBe(lobbyButton);
  await pressKey("Tab", { shiftKey: true });
  expect(document.activeElement).toBe(lobbyButton);

  await act(async () => root.render(<Results result={{ ...result, winnerSeat: 1, winnerName: "You" }} viewerSeatIndex={2} onLobby={onLobby} reducedMotion />));
  expect(container.querySelector(".rummy-royal-settlement").classList.contains("is-player-loss")).toBe(true);
  expect(container.querySelector('[data-testid="rrs-celebration-stage"]')).toBeNull();
  await pressKey("Escape");
  expect(onLobby).toHaveBeenCalledTimes(1);
  act(() => root.unmount());
  expect(document.activeElement).toBe(returnTarget);
});

test("legacy automated seat suffixes never leak into visible Rummy names", () => {
  expect(visibleRummyName("Mira · BOT", true)).toBe("Mira");
  expect(visibleRummyName("Leela - Bot - Royal", true)).toBe("Leela");
  expect(visibleRummyName("Kabir · AUTO · Practice", true)).toBe("Kabir");
  expect(visibleRummyName("Robin Botter", false)).toBe("Robin Botter");
});

test("the flagship result dialog renders a royal outcome hero and complete standings without stale result structures", async () => {
  const winningCards = [
    { id: "W1", rank: 3, suit: "H", code: "3H" },
    { id: "W2", rank: 4, suit: "H", code: "4H" },
    { id: "W3", rank: 5, suit: "H", code: "5H" },
  ];
  const result = {
    winnerSeat: 1,
    winnerName: "Mira · BOT",
    payoutChips: 725,
    reason: "VALID_DECLARATION",
    rows: [
      { seatIndex: 0, displayName: "You", status: "LOST", points: 20, chipDelta: -100, cards: [] },
      { seatIndex: 1, displayName: "Mira · BOT", isBot: true, botLabel: "BOT · ROYAL", status: "WON", points: 0, chipDelta: 725, cards: winningCards, groups: [{ label: "PURE_SEQUENCE", cardIds: winningCards.map((card) => card.id) }] },
      { seatIndex: 2, displayName: "Leela", status: "LOST", points: 28, chipDelta: -100, cards: [] },
      { seatIndex: 3, displayName: "Arjun", status: "DROPPED", points: 40, chipDelta: -100, cards: [] },
      { seatIndex: 4, displayName: "Kabir", status: "LOST", points: 54, chipDelta: -100, cards: [] },
    ],
  };
  const { container, root } = await render(<Results result={result} viewerSeatIndex={0} onLobby={jest.fn()} reducedMotion />);
  const panel = container.querySelector(".rummy-royal-settlement");
  const hero = panel?.querySelector(".rrs-summary-hero");
  const standings = panel?.querySelector(".rrs-standings");
  const actions = panel?.querySelector(".rrs-summary-actions");
  const winner = standings?.querySelector("article.is-winner");

  expect(hero?.querySelector(".rrs-summary-seal")).not.toBeNull();
  expect(hero?.querySelector(".rrs-payout")?.getAttribute("aria-label")).toBe("725 chips payout");
  expect(standings?.getAttribute("aria-labelledby")).toBe("rrs-standings-title");
  expect(standings?.querySelectorAll(".rrs-standing-rows > article")).toHaveLength(5);
  expect(winner?.querySelector(".rrs-standing-player b")?.textContent).toBe("Mira");
  expect(winner?.textContent).toContain("SEAT 2");
  expect(winner?.textContent).not.toMatch(/\bauto\b/i);
  expect(panel?.textContent).not.toMatch(/\bbots?\b/i);
  expect(actions?.querySelector("button")?.textContent).toBe("BACK TO LOBBY");
  expect(panel?.querySelectorAll(".rrs-final-hand .rrs-card")).toHaveLength(3);
  expect(panel?.querySelector(".rrs-final-hand .rrs-group-band")?.textContent).toContain("PURE SEQUENCE");
  expect(panel?.querySelector(".rummy-result-ribbon")).toBeNull();
  expect(panel?.querySelector(".rummy-win-burst")).toBeNull();
  act(() => root.unmount());
});

test("royal settlement CSS preserves portrait hierarchy, visible short-landscape cards, touch targets, and reduced-motion fallbacks", () => {
  const source = fs.readFileSync(path.join(__dirname, "RummyGame.js"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "rummy-royal-settlement.css"), "utf8");
  const portrait = cssBlock(css, "@media (orientation: portrait)");
  const portraitResults = cssRuleWithin(portrait, ".rummy-royal-settlement");
  const portraitHero = cssRuleWithin(portrait, ".rrs-summary-hero");
  const portraitRows = cssRuleWithin(portrait, ".rrs-standing-rows article");
  const landscape = cssBlock(css, "@media (orientation: landscape) and (max-height: 430px)");
  const landscapeResults = cssRuleWithin(landscape, ".rummy-royal-settlement");
  const landscapeSummary = cssRuleWithin(landscape, ".rrs-summary");
  const landscapeFinalHand = cssRuleWithin(landscape, ".rrs-final-hand");
  const landscapeStandingRow = cssRuleWithin(landscape, ".rrs-standing-rows article");
  const landscapeActions = cssRuleWithin(landscape, ".rrs-summary-actions");
  const landscapeCta = cssRuleWithin(landscape, ".rrs-summary-actions button");
  const baseCta = cssRuleWithin(css, ".rrs-summary-actions button");
  const reducedMotion = cssBlock(css, "@media (prefers-reduced-motion: reduce)");

  expect(portraitResults).toMatch(/inset-block-start:\s*58px/);
  expect(portraitHero).toMatch(/grid-template-columns:\s*52px minmax\(0, 1fr\) minmax\(96px, 120px\)/);
  expect(portraitRows).toMatch(/grid-template-areas:\s*[\s\S]*"position player delta"[\s\S]*"position stats stats"[\s\S]*"hand hand hand"/);

  expect(landscapeResults).toMatch(/inset-block-start:\s*44px/);
  expect(landscapeSummary).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\)/);
  expect(landscapeSummary).toMatch(/grid-template-rows:\s*58px 72px minmax\(0, 1fr\) 44px/);
  expect(landscapeFinalHand).toMatch(/grid-column:\s*1/);
  expect(landscapeFinalHand).toMatch(/grid-row:\s*2/);
  expect(landscapeFinalHand).not.toMatch(/display:\s*none/);
  expect(landscapeStandingRow).toMatch(/grid-template-areas:\s*"position player stats delta"/);
  expect(landscapeActions).toMatch(/grid-column:\s*1 \/ -1/);
  expect(landscapeActions).toMatch(/grid-row:\s*4/);
  expect(landscapeCta).toMatch(/min-height:\s*44px/);
  expect(baseCta).toMatch(/min-height:\s*44px/);

  expect(reducedMotion).toMatch(/\.rrs-celebration-veil,[\s\S]*\.rrs-summary-hero\s*\{\s*animation:\s*none/);
  expect(cssRuleWithin(reducedMotion, ".rrs-particles")).toMatch(/display:\s*none/);
  expect(css).not.toMatch(/\.rrs-final-hand\s*\{[^}]*display:\s*none/s);
  expect(source).toContain("<RummyRoyalSettlement");
});

test("a settled result replaces an open drop confirmation without overlapping modal dialogs", async () => {
  const active = createRummyDemoState("LV1");
  const props = { busy: false, reconnecting: false, sendAction: jest.fn(), onExit: jest.fn() };
  const { container, root } = await render(<RummyTable state={active} {...props} />);
  const dropTrigger = [...container.querySelectorAll(".rummy-actions button")].find((button) => button.textContent.trim() === "DROP");
  await click(dropTrigger);
  expect(container.querySelectorAll("[aria-modal='true']")).toHaveLength(1);

  const settled = applyRummyDemoAction(active, "DROP");
  await act(async () => {
    root.render(<RummyTable state={settled} {...props} />);
    await new Promise((resolve) => setTimeout(resolve, 240));
  });
  expect(container.querySelector(".rummy-confirm")).toBeNull();
  expect(container.querySelector('.rummy-royal-settlement[data-phase="celebration"]')).not.toBeNull();
  expect(container.querySelectorAll("[aria-modal='true']")).toHaveLength(1);
  act(() => root.unmount());
});

test("the remembered viewer seat keeps a server-settled player win celebratory", async () => {
  const active = createRummyDemoState("LV1");
  const props = { busy: false, reconnecting: false, sendAction: jest.fn(), onExit: jest.fn() };
  const { container, root } = await render(<RummyTable state={active} {...props} />);
  const settled = {
    ...active,
    state: "ROUND_SETTLED",
    privateState: null,
    result: {
      winnerSeat: 0,
      winnerName: "You",
      payoutChips: 500,
      reason: "VALID_DECLARATION",
      rows: [],
    },
  };
  await act(async () => {
    root.render(<RummyTable state={settled} {...props} />);
    await Promise.resolve();
  });
  expect(container.querySelector("#rrs-title")?.textContent).toBe("You win");
  expect(container.querySelector('.rummy-royal-settlement.is-player-win[data-phase="celebration"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="rrs-celebration-stage"]')).not.toBeNull();
  act(() => root.unmount());
});

test("failed authoritative grouping restores the prior visible groups", async () => {
  const state = createRummyDemoState("LV1");
  const sendAction = jest.fn().mockResolvedValue(null);
  const { container, root } = await render(<RummyTable state={state} busy={false} reconnecting={false} sendAction={sendAction} onExit={jest.fn()} />);
  const firstGroupCards = container.querySelectorAll(".rummy-group:not(.is-ungrouped):first-child .rummy-card");
  await click(firstGroupCards[0]);
  await click(firstGroupCards[1]);
  const groupButton = [...container.querySelectorAll(".rummy-actions button")].find((button) => button.textContent.includes("GROUP") && !button.textContent.includes("UNGROUP"));
  await click(groupButton);
  expect(sendAction).toHaveBeenCalledWith("GROUP", expect.objectContaining({ groups: expect.any(Array) }));
  expect(container.querySelectorAll(".rummy-group:not(.is-ungrouped)")).toHaveLength(4);
  act(() => root.unmount());
});

test("an older equal-version poll cannot overwrite an acknowledged private grouping", async () => {
  const initial = createRummyDemoState("LV1");
  const stalePoll = deferred();
  let acknowledgedGroups = null;
  api.get.mockImplementation((url) => {
    if (url === "/games/rummy/categories") return Promise.resolve({ data: { categories: [initial.category] } });
    if (url === "/chips/balance") return Promise.resolve({ data: { balance: initial.balance } });
    if (url.includes(`/games/rummy/rooms/${initial.roomId}/state`)) return stalePoll.promise;
    return Promise.reject(new Error(`Unexpected GET ${url}`));
  });
  api.post.mockImplementation((url, payload) => {
    if (url === "/games/rummy/join") return Promise.resolve({ data: initial });
    if (url.includes(`/games/rummy/rooms/${initial.roomId}/actions`)) {
      acknowledgedGroups = payload.actionPayload.groups;
      const acknowledged = JSON.parse(JSON.stringify(initial));
      acknowledged.privateState.groups = acknowledgedGroups;
      acknowledged.privateState.groupLabels = acknowledgedGroups.map(() => "UNVALIDATED");
      acknowledged.privateState.groupValidation = { valid: false, code: "INVALID_GROUP", groups: acknowledged.privateState.groupLabels };
      return Promise.resolve({ data: { code: "GROUP_ACCEPTED", state: acknowledged } });
    }
    return Promise.reject(new Error(`Unexpected POST ${url}`));
  });

  const { container, root } = await render(<RummyGame game={{ slug: "rummy", name: "Rummy" }} />);
  const practice = [...container.querySelectorAll("button")].find((button) => button.textContent.includes("PRACTICE TABLE"));
  await click(practice);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(api.get).toHaveBeenCalledWith(expect.stringContaining(`/games/rummy/rooms/${initial.roomId}/state`), expect.any(Object));

  const firstGroupCards = container.querySelectorAll(".rummy-group:not(.is-ungrouped):first-child .rummy-card");
  await click(firstGroupCards[0]);
  await click(firstGroupCards[1]);
  const groupButton = [...container.querySelectorAll(".rummy-actions button")].find((button) => button.textContent.trim() === "GROUP");
  await click(groupButton);
  expect(acknowledgedGroups).toHaveLength(5);
  expect(container.querySelectorAll(".rummy-group:not(.is-ungrouped)")).toHaveLength(5);

  await act(async () => {
    stalePoll.resolve({ data: initial });
    await Promise.resolve();
  });
  expect(container.querySelectorAll(".rummy-group:not(.is-ungrouped)")).toHaveLength(5);
  act(() => root.unmount());
});

test("waiting and cancelled rooms use dedicated recovery panels without blank decks", async () => {
  const waiting = createRummyDemoState("LV1");
  waiting.state = "WAITING_FOR_PLAYERS";
  waiting.privateState = null;
  waiting.fallbackStartsIn = 8.2;
  waiting.seats = [waiting.seats[0], ...waiting.seats.slice(1).map((seat) => ({ seatIndex: seat.seatIndex, status: "EMPTY", cardCount: 0 }))];
  const { container, root } = await render(<RummyTable state={waiting} busy={false} reconnecting={false} sendAction={jest.fn()} onExit={jest.fn()} />);
  expect(container.querySelector('[data-testid="rummy-waiting-room"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="rummy-fallback-countdown"]')?.textContent).toContain("9s");
  expect(container.querySelector('[data-testid="rummy-fallback-countdown"]')?.textContent).toBe("Game starts in 9s.");
  expect(container.querySelector(".rummy-deck")).toBeNull();

  const cancelled = { ...waiting, state: "CANCELLED", cancelReason: "Stake restored." };
  await act(async () => root.render(<RummyTable state={cancelled} busy={false} reconnecting={false} sendAction={jest.fn()} onExit={jest.fn()} />));
  expect(container.querySelector('[data-testid="rummy-cancelled-room"]')?.textContent).toContain("Stake restored");
  expect(container.textContent).not.toContain("Player's turn");
  act(() => root.unmount());
});

test("wallet-neutral Practice tables remain available when only the balance request fails", async () => {
  api.get.mockImplementation((url) => {
    if (url === "/games/rummy/categories") return Promise.resolve({ data: { categories: [{ id: "LV1", displayName: "Beginner", entryChips: 100, pointsValue: 1, minChipBalance: 100, turnDurationSeconds: 30, accent: {} }] } });
    return Promise.reject(new Error("balance unavailable"));
  });
  const { container, root } = await render(<RummyGame game={{ slug: "rummy", name: "Rummy" }} />);
  const practice = [...container.querySelectorAll("button")].find((button) => button.textContent.includes("PRACTICE TABLE"));
  expect(practice).toBeDefined();
  expect(practice.disabled).toBe(false);
  expect(container.textContent).toContain("Balance unavailable · Practice remains available");
  act(() => root.unmount());
});

test("a no-response join failure shows contextual recovery and a successful retry enters the table", async () => {
  const initial = createRummyDemoState("LV1");
  api.get.mockImplementation((url) => {
    if (url === "/games/rummy/categories") return Promise.resolve({ data: { categories: [initial.category] } });
    if (url === "/chips/balance") return Promise.resolve({ data: { balance: initial.balance } });
    return Promise.reject(new Error(`Unexpected GET ${url}`));
  });
  api.post
    .mockRejectedValueOnce(Object.assign(new Error("Network Error"), { request: {}, response: undefined }))
    .mockResolvedValueOnce({ data: initial });

  const { container, root } = await render(<RummyGame game={{ slug: "rummy", name: "Rummy" }} />);
  const practice = [...container.querySelectorAll("button")].find((button) => button.textContent.includes("PRACTICE TABLE"));
  await click(practice);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  const alert = container.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain("secure Rummy server");
  expect(alert?.textContent).not.toContain("Network Error");
  const retry = [...container.querySelectorAll("button")].find((button) => button.textContent === "RETRY PRACTICE");
  expect(retry).toBeDefined();

  await click(retry);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(api.post).toHaveBeenCalledTimes(2);
  expect(api.post).toHaveBeenLastCalledWith(
    "/games/rummy/join",
    { categoryId: "LV1", mode: "PRACTICE" },
    {
      timeout: 22000,
      headers: { "Idempotency-Key": expect.stringMatching(/^rummy-/) },
    },
  );
  expect(container.querySelector('[data-testid="rummy-live-table"]')).not.toBeNull();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  act(() => root.unmount());
});

test("a failed leave keeps the authoritative table visible instead of stranding the player in the lobby", async () => {
  const initial = createRummyDemoState("LV1");
  const pendingPoll = deferred();
  let roomReadCount = 0;
  api.get.mockImplementation((url) => {
    if (url === "/games/rummy/categories") return Promise.resolve({ data: { categories: [initial.category] } });
    if (url === "/chips/balance") return Promise.resolve({ data: { balance: initial.balance } });
    if (url.includes(`/games/rummy/rooms/${initial.roomId}/state`)) {
      roomReadCount += 1;
      if (roomReadCount === 1) return pendingPoll.promise;
      return Promise.reject(Object.assign(new Error("Network Error"), { request: {}, response: undefined }));
    }
    return Promise.reject(new Error(`Unexpected GET ${url}`));
  });
  api.post.mockImplementation((url) => {
    if (url === "/games/rummy/join") return Promise.resolve({ data: initial });
    if (url.includes(`/games/rummy/rooms/${initial.roomId}/actions`)) {
      return Promise.reject(Object.assign(new Error("Network Error"), { request: {}, response: undefined }));
    }
    return Promise.reject(new Error(`Unexpected POST ${url}`));
  });

  const { container, root } = await render(<RummyGame game={{ slug: "rummy", name: "Rummy" }} />);
  await click([...container.querySelectorAll("button")].find((button) => button.textContent.includes("PRACTICE TABLE")));
  expect(container.querySelector('[data-testid="rummy-live-table"]')).not.toBeNull();

  await click(container.querySelector('.rummy-game-head button[aria-label="Leave Rummy"]'));

  expect(container.querySelector('[data-testid="rummy-live-table"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="rummy-category-lobby"]')).toBeNull();
  expect(container.textContent).toContain("Reconnecting to the authoritative table");
  expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("table remains open here"));
  act(() => root.unmount());
});

test("a committed drop with a lost acknowledgement accepts the inactive authoritative seat without a second action", async () => {
  const initial = createRummyDemoState("LV1");
  const pendingPoll = deferred();
  const dropped = {
    ...initial,
    version: initial.version + 1,
    seats: initial.seats.map((seat) => (
      seat.seatIndex === initial.privateState.seatIndex
        ? { ...seat, active: false, status: "DROPPED", droppedPoints: 20 }
        : seat
    )),
  };
  let roomReadCount = 0;
  let actionCount = 0;
  api.get.mockImplementation((url) => {
    if (url === "/games/rummy/categories") return Promise.resolve({ data: { categories: [initial.category] } });
    if (url === "/chips/balance") return Promise.resolve({ data: { balance: initial.balance } });
    if (url.includes(`/games/rummy/rooms/${initial.roomId}/state`)) {
      roomReadCount += 1;
      return roomReadCount === 1 ? pendingPoll.promise : Promise.resolve({ data: dropped });
    }
    return Promise.reject(new Error(`Unexpected GET ${url}`));
  });
  api.post.mockImplementation((url) => {
    if (url === "/games/rummy/join") return Promise.resolve({ data: initial });
    if (url.includes(`/games/rummy/rooms/${initial.roomId}/actions`)) {
      actionCount += 1;
      return Promise.reject(Object.assign(new Error("Network Error"), { request: {}, response: undefined }));
    }
    return Promise.reject(new Error(`Unexpected POST ${url}`));
  });

  const { container, root } = await render(<RummyGame game={{ slug: "rummy", name: "Rummy" }} />);
  await click([...container.querySelectorAll("button")].find((button) => button.textContent.includes("PRACTICE TABLE")));
  await click(container.querySelector('.rummy-game-head button[aria-label="Leave Rummy"]'));

  expect(actionCount).toBe(1);
  expect(roomReadCount).toBe(2);
  expect(container.querySelector('[data-testid="rummy-live-table"]')).toBeNull();
  expect(container.querySelector('[data-testid="rummy-category-lobby"]')).not.toBeNull();
  expect(toast.error).not.toHaveBeenCalled();
  act(() => root.unmount());
});

test("a stale leave restores the room and retries once with the same idempotent action id", async () => {
  jest.useFakeTimers();
  const initial = createRummyDemoState("LV1");
  const restored = { ...initial, version: initial.version + 1 };
  const released = applyRummyDemoAction(restored, "DROP");
  const actionPayloads = [];
  const actionConfigs = [];
  api.get.mockImplementation((url) => {
    if (url === "/games/rummy/categories") return Promise.resolve({ data: { categories: [initial.category] } });
    if (url === "/chips/balance") return Promise.resolve({ data: { balance: initial.balance } });
    if (url.includes(`/games/rummy/rooms/${initial.roomId}/state`)) return Promise.resolve({ data: restored });
    return Promise.reject(new Error(`Unexpected GET ${url}`));
  });
  api.post.mockImplementation((url, payload, config) => {
    if (url === "/games/rummy/join") return Promise.resolve({ data: initial });
    if (url.includes(`/games/rummy/rooms/${initial.roomId}/actions`)) {
      actionPayloads.push(payload);
      actionConfigs.push(config);
      if (actionPayloads.length === 1) {
        return Promise.reject({
          response: { data: { detail: { code: "RUMMY_STALE_VERSION", message: "The table changed." } } },
        });
      }
      return Promise.resolve({ data: { code: "PLAYER_DROPPED", state: released } });
    }
    return Promise.reject(new Error(`Unexpected POST ${url}`));
  });

  try {
    const { container, root } = await render(<RummyGame game={{ slug: "rummy", name: "Rummy" }} />);
    await click([...container.querySelectorAll("button")].find((button) => button.textContent.includes("PRACTICE TABLE")));
    await click(container.querySelector('.rummy-game-head button[aria-label="Leave Rummy"]'));

    expect(actionPayloads).toHaveLength(2);
    expect(actionPayloads[1].actionId).toBe(actionPayloads[0].actionId);
    expect(actionConfigs[0]?.headers?.["Idempotency-Key"]).toBe(actionPayloads[0].actionId);
    expect(actionConfigs[1]?.headers?.["Idempotency-Key"]).toBe(actionPayloads[1].actionId);
    expect(actionPayloads[0].expectedVersion).toBe(initial.version);
    expect(actionPayloads[1].expectedVersion).toBe(restored.version);
    expect(container.querySelector('[data-testid="rummy-live-table"]')).toBeNull();
    expect(container.querySelector('[data-testid="rummy-category-lobby"]')).not.toBeNull();
    expect(toast.error).not.toHaveBeenCalledWith("The table changed.");
    act(() => root.unmount());
  } finally {
    jest.useRealTimers();
  }
});

test("the deterministic Practice journey reaches the premium five-seat result and returns cleanly to the lobby", async () => {
  jest.useFakeTimers();
  let root;
  try {
    const rendered = await render(<RummyGame game={{ slug: "rummy", name: "Rummy", demo: true }} />);
    const { container } = rendered;
    root = rendered.root;
    expect(container.querySelector('[data-testid="rummy-category-lobby"]')).not.toBeNull();

    await click([...container.querySelectorAll("button")].find((button) => button.textContent.includes("PRACTICE TABLE")));
    const declare = [...container.querySelectorAll(".rummy-actions button")].find((button) => button.textContent.trim() === "DECLARE");
    expect(declare?.disabled).toBe(false);
    await click(declare);

    const settlement = container.querySelector(".rummy-royal-settlement[aria-modal='true']");
    expect(settlement).not.toBeNull();
    expect(settlement?.dataset.phase).toBe("celebration");
    expect(container.querySelector('[data-testid="rrs-celebration-stage"]')).not.toBeNull();
    expect(container.querySelector("#rrs-title")?.textContent).toBe("You win");

    await act(async () => {
      jest.advanceTimersByTime(2800);
      await Promise.resolve();
    });

    expect(settlement?.dataset.phase).toBe("summary");
    expect(container.querySelector('[data-testid="rrs-summary-stage"]')).not.toBeNull();
    expect(container.querySelector(".rrs-summary-hero")?.textContent).toContain("You win");
    expect(container.querySelector(".rrs-summary-hero .rrs-payout")?.dataset.payoutChips).toBe("0");
    expect(container.querySelectorAll(".rrs-standing-rows > article")).toHaveLength(5);
    expect(container.querySelector(".rrs-standing-rows > article.is-winner")).not.toBeNull();
    expect(container.querySelector(".rrs-final-hand")).not.toBeNull();

    await click([...container.querySelectorAll(".rrs-summary-actions button")].find((button) => button.textContent === "BACK TO LOBBY"));
    expect(container.querySelector(".rummy-royal-settlement")).toBeNull();
    expect(container.querySelector('[data-testid="rummy-category-lobby"]')).not.toBeNull();
    act(() => root.unmount());
    root = null;
  } finally {
    if (root) act(() => root.unmount());
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});

test("the exact-ratio table fills landscape while controls respect the safe viewport", () => {
  const css = fs.readFileSync(path.join(__dirname, "rummy.css"), "utf8");
  expect(css).toContain("width: var(--fg-usable-w, 100vw)");
  expect(css).toContain("height: var(--fg-usable-h, 100dvh)");
  expect(css).toMatch(/\.rummy-game\s*\{[^}]*left:\s*var\(--fg-viewport-left, 0px\);[^}]*width:\s*min\(var\(--fg-viewport-w, 100vw\), 100vw\);[^}]*height:\s*min\(var\(--fg-viewport-h, 100dvh\), 100dvh\)/s);
  expect(css).toMatch(/\.rummy-game\s*\{[^}]*grid-template-rows:\s*calc\(clamp\(50px, 7\.2vh, 72px\) \+ var\(--fg-safe-top, 0px\)\)/s);
  expect(css).toMatch(/\.rummy-game-head\s*\{[^}]*padding-right:\s*max\([^;]*var\(--fg-safe-right, 0px\)\);[^}]*padding-left:\s*max\([^;]*var\(--fg-safe-left, 0px\)\)/s);
  expect(css).toMatch(/\.rummy-game-head\s*\{[^}]*padding-top:\s*max\(5px, var\(--fg-safe-top, 0px\)\)/s);
  expect(css).toMatch(/\.rummy-hand-zone\s*\{[^}]*padding-right:\s*max\([^;]*var\(--fg-safe-right, 0px\)\);[^}]*padding-left:\s*max\([^;]*var\(--fg-safe-left, 0px\)\)/s);
  expect(css).toMatch(/\.rummy-table-opponent-disclosure\s*\{[^}]*right:\s*max\(8px, var\(--fg-safe-right, 0px\)\)/s);
  expect(css).toMatch(/\.rummy-social-drawer\s*\{[^}]*right:\s*max\([^;]*var\(--fg-safe-right, 0px\)\);[^}]*bottom:\s*max\([^;]*var\(--fg-safe-bottom, 0px\)\)/s);
  expect(css).toMatch(/\.rummy-results\s*\{[^}]*right:\s*max\([^;]*var\(--fg-safe-right, 0px\)[^;]*\);[^}]*bottom:\s*max\([^;]*var\(--fg-safe-bottom, 0px\)\);[^}]*left:\s*max\([^;]*var\(--fg-safe-left, 0px\)/s);
  expect(css).toMatch(/\.rummy-lobby::before\s*\{[^}]*position:\s*absolute/s);
  expect(css).not.toMatch(/\.rummy-table\s*\{[^}]*width:\s*[^;}]*vw/s);
  expect(css).toMatch(/\.rummy-stage\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);
  expect(css).toMatch(/\.rummy-stage\s*\{[^}]*grid-template-rows:\s*minmax\(0, 1fr\) auto/s);
  expect(css).toMatch(/\.rummy-hand-zone\s*\{[^}]*grid-template-rows:\s*minmax\(0, 1fr\) auto/s);
  expect(css).toMatch(/\.rummy-group-rail\s*\{[^}]*align-items:\s*flex-start/s);
  expect(css).toMatch(/\.rummy-group\s*\{[^}]*grid-template-rows:\s*auto 22px/s);
  expect(css).toContain("@media (orientation: landscape) and (max-height: 430px)");
  expect(css).toContain("@media (max-width: 880px) and (min-height: 431px), (min-height: 431px) and (max-height: 620px)");
  expect(css).not.toContain("@media (max-width: 880px), (max-height: 620px)");
  expect(css).toMatch(/@media \(orientation: landscape\) and \(max-height: 430px\)[\s\S]*?\.rummy-actions button\s*\{[^}]*min-height:\s*44px/s);
  expect(css).toContain("@media (orientation: portrait) and (max-width: 430px)");
  expect(css).toMatch(/@media \(orientation: portrait\) and \(max-width: 430px\)[\s\S]*?\.rummy-table-hud\s*\{\s*display:\s*none/s);
  expect(css).toMatch(/\.rummy-seat\s*\{\s*width:\s*clamp\(48px, 17cqw, 68px\)/s);
  expect(css).toMatch(/@media \(orientation: landscape\) and \(max-height: 430px\)[\s\S]*?\.rummy-seat\s*\{\s*width:\s*clamp\(48px, 17cqw, 60px\)/s);
  expect(css).toMatch(/\.rummy-only-timer\s*\{[^}]*top:\s*0;[^}]*right:\s*-4px;[^}]*transform:\s*translateX\(100%\)/s);
  expect(css).toMatch(/@media \(orientation: landscape\) and \(max-height: 430px\)[\s\S]*?\.rummy-only-timer\s*\{[^}]*width:\s*18px;[^}]*height:\s*18px/s);
  expect(css).toMatch(/@media \(orientation: portrait\) and \(max-width: 430px\)[\s\S]*?\.rummy-only-timer\s*\{[^}]*width:\s*18px;[^}]*height:\s*18px/s);
  expect(css).toContain("container-type: inline-size");
  expect(css).toMatch(/\.rummy-table-slot\s*\{[^}]*container-type:\s*size/s);
  expect(css).toMatch(/\.rummy-table\s*\{[^}]*width:\s*min\(100cqw, 255cqh\);[^}]*aspect-ratio:\s*1672 \/ 941/s);
  expect(css).toMatch(/@media \(orientation: portrait\)[\s\S]*?\.rummy-table-slot\s*\{[^}]*aspect-ratio:\s*1672 \/ 941/s);
  expect(css).not.toContain("height: min(100%, 100vw)");
  expect(css.match(/\.rummy-seat-1\s*\{/g)).toHaveLength(1);
  expect(css.match(/\.rummy-seat-3\s*\{/g)).toHaveLength(1);
});

test("the rendered practice table keeps the stable auto-fit layer hierarchy without network entry", async () => {
  const state = createRummyDemoState("LV1");
  const { container, root } = await render(
    <RummyTable state={state} busy={false} reconnecting={false} sendAction={jest.fn()} onExit={jest.fn()} />,
  );

  const game = container.querySelector('main.rummy-game[data-testid="rummy-live-table"]');
  const stage = game?.querySelector(":scope > .rummy-stage");
  const slot = stage?.querySelector(":scope > .rummy-table-slot");
  const table = slot?.querySelector(":scope > .rummy-table");
  const art = table?.querySelector(":scope > img.rummy-table-art");
  const hand = stage?.querySelector(":scope > .rummy-hand-zone");

  expect(game?.querySelector(":scope > .rummy-game-head")).not.toBeNull();
  expect(stage).not.toBeNull();
  expect(slot).not.toBeNull();
  expect(slot?.getAttribute("data-table-art-ready")).toBe("false");
  expect(slot?.classList.contains("is-art-loading")).toBe(true);
  expect(table).not.toBeNull();
  expect(art?.getAttribute("src")).toBe("/game-art/rummy/table-palace-v2.png");
  expect(art?.getAttribute("draggable")).toBe("false");
  expect(table?.querySelectorAll(":scope > .rummy-seat")).toHaveLength(5);
  expect(hand).not.toBeNull();
  expect(stage?.querySelector('button[aria-label="OPEN CARD: 10 of diamonds"]')).not.toBeNull();
  expect(stage?.querySelector('[role="group"][aria-label="Wild-rank indicator: A of spades"]')).not.toBeNull();
  expect(stage?.querySelector(".rummy-bot-table-notice")).toBeNull();
  expect(stage?.querySelector(".rummy-table-opponent-disclosure")).toBeNull();
  expect(stage?.textContent).not.toMatch(/\bauto\b/i);
  expect(stage?.textContent).not.toMatch(/\bbots?\b/i);
  expect(api.get).not.toHaveBeenCalled();
  expect(api.post).not.toHaveBeenCalled();
  await act(async () => {
    art?.dispatchEvent(new Event("load"));
    await Promise.resolve();
  });
  expect(slot?.getAttribute("data-table-art-ready")).toBe("true");
  expect(slot?.classList.contains("is-art-ready")).toBe(true);
  act(() => root.unmount());
});

test("Rummy portrait detection blocks handheld screens but leaves landscape and desktop available", () => {
  const handheld = (width, height, { touch = true, coarse = true } = {}) => ({
    innerWidth: width,
    innerHeight: height,
    navigator: { maxTouchPoints: touch ? 5 : 0 },
    matchMedia: () => ({ matches: coarse }),
    document: { documentElement: { clientWidth: width, clientHeight: height } },
  });

  expect(shouldBlockRummyPortrait(handheld(390, 844))).toBe(true);
  expect(shouldBlockRummyPortrait(handheld(844, 390))).toBe(false);
  expect(shouldBlockRummyPortrait(handheld(768, 1024))).toBe(true);
  expect(shouldBlockRummyPortrait(handheld(1280, 1600))).toBe(false);
  expect(shouldBlockRummyPortrait(handheld(900, 1200, { touch: false, coarse: false }))).toBe(false);
  expect(shouldBlockRummyPortrait(handheld(390, 844, { touch: false, coarse: false }))).toBe(true);
});

test("Rummy landscape request uses fullscreen fallback only after the direct lock is rejected", async () => {
  const calls = [];
  const lock = jest.fn(async () => {
    calls.push("lock");
    if (lock.mock.calls.length === 1) throw new Error("fullscreen required");
  });
  const targetWindow = {
    screen: { orientation: { lock } },
    document: {
      fullscreenElement: null,
      documentElement: { requestFullscreen: jest.fn(async () => { calls.push("fullscreen"); }) },
    },
  };

  await expect(requestRummyLandscape(targetWindow)).resolves.toEqual({ locked: false, enteredFullscreen: false });
  expect(calls).toEqual(["lock"]);
  lock.mockClear();
  calls.length = 0;
  await expect(requestRummyLandscape(targetWindow, { allowFullscreen: true })).resolves.toEqual({ locked: true, enteredFullscreen: true });
  expect(calls).toEqual(["lock", "fullscreen", "lock"]);
});

test("portrait guard keeps the active Rummy subtree mounted and makes it inert until rotation", async () => {
  const originalWidth = window.innerWidth;
  const originalHeight = window.innerHeight;
  const originalMaxTouchPoints = window.navigator.maxTouchPoints;
  Object.defineProperty(window.navigator, "maxTouchPoints", { configurable: true, value: 5 });
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 768 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 1024 });
  const onExit = jest.fn();
  const { container, root } = await render(
    <RummyLandscapeGuard onExit={onExit}><button data-testid="guarded-action">PLAY</button></RummyLandscapeGuard>,
  );

  const guardedAction = container.querySelector('[data-testid="guarded-action"]');
  expect(container.querySelector('[data-testid="rummy-orientation-gate"]')).not.toBeNull();
  expect(container.querySelector(".rummy-landscape-content")?.getAttribute("aria-hidden")).toBe("true");
  expect(container.querySelector(".rummy-landscape-content")?.hasAttribute("inert")).toBe(true);

  Object.defineProperty(window, "innerWidth", { configurable: true, value: 844 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 390 });
  await act(async () => {
    window.dispatchEvent(new Event("resize"));
    await Promise.resolve();
  });
  expect(container.querySelector('[data-testid="rummy-orientation-gate"]')).toBeNull();
  expect(container.querySelector('[data-testid="guarded-action"]')).toBe(guardedAction);
  expect(container.querySelector(".rummy-landscape-content")?.hasAttribute("inert")).toBe(false);

  act(() => root.unmount());
  Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: originalHeight });
  Object.defineProperty(window.navigator, "maxTouchPoints", { configurable: true, value: originalMaxTouchPoints });
});

test("short mobile landscape expands the palace table edge to edge above a compact 44px action dock", () => {
  const css = fs.readFileSync(path.join(__dirname, "rummy.css"), "utf8");
  const landscape = cssBlock(css, "@media (orientation: landscape) and (max-height: 430px)");
  const landscapeGame = cssRuleWithin(landscape, ".rummy-game");
  const landscapeHeader = cssRuleWithin(landscape, ".rummy-game-head");
  const landscapeStage = cssRuleWithin(landscape, ".rummy-stage");
  const landscapeSlot = cssRuleWithin(landscape, ".rummy-table-slot");
  const landscapeSlotAtmosphere = cssRuleWithin(landscape, ".rummy-table-slot::after");
  const landscapeTable = cssRuleWithin(landscape, ".rummy-table");
  const landscapeHand = cssRuleWithin(landscape, ".rummy-hand-zone");
  const landscapeRail = cssRuleWithin(landscape, ".rummy-group-rail");
  const landscapeGroup = cssRuleWithin(landscape, ".rummy-group");
  const landscapeGroupCards = cssRuleWithin(landscape, ".rummy-group > div");
  const landscapeCard = cssRuleWithin(landscape, ".rummy-card");
  const landscapeOverlap = cssRuleWithin(landscape, ".rummy-group > div .rummy-card + .rummy-card");
  const landscapeActions = cssRuleWithin(landscape, ".rummy-actions");
  const landscapeActionButton = cssRuleWithin(landscape, ".rummy-actions button");
  const landscapeValidation = cssRuleWithin(landscape, ".rummy-validation");
  const landscapeHud = cssRuleWithin(landscape, ".rummy-table-hud");
  const landscapeSeatBack = cssRuleWithin(landscape, ".rummy-seat > small,\n  .rummy-seat .rummy-card-back");

  expect(landscapeGame).toMatch(/grid-template-rows:\s*minmax\(0, 1fr\)/);
  expect(landscapeHeader).toMatch(/position:\s*absolute/);
  expect(landscapeHeader).toMatch(/height:\s*calc\(50px \+ var\(--fg-safe-top, 0px\)\)/);
  expect(landscapeHeader).toMatch(/padding-right:\s*max\(6px, var\(--fg-safe-right, 0px\)\)/);
  expect(landscapeHeader).toMatch(/padding-left:\s*max\(6px, var\(--fg-safe-left, 0px\)\)/);
  expect(landscapeStage).not.toMatch(/--rummy-mobile-dock-w/);
  expect(landscapeStage).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\)/);
  expect(landscapeStage).toMatch(/grid-template-rows:\s*minmax\(0, 1fr\) auto/);
  expect(landscapeSlot).toMatch(/grid-column:\s*1/);
  expect(landscapeSlot).toMatch(/grid-row:\s*1/);
  expect(landscapeSlotAtmosphere).toMatch(/filter:\s*none/);
  expect(landscapeTable).toMatch(/position:\s*absolute/);
  expect(landscapeTable).toMatch(/left:\s*50%/);
  expect(landscapeTable).toMatch(/top:\s*49%/);
  expect(landscapeTable).toMatch(/width:\s*min\(100cqw, calc\(290cqh - 150px\)\)/);
  expect(landscapeTable).toMatch(/transform:\s*translate\(-50%, -50%\) translateZ\(0\)/);
  expect(landscapeHand).toMatch(/grid-column:\s*1/);
  expect(landscapeHand).toMatch(/grid-row:\s*2/);
  expect(landscapeHand).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\)/);
  expect(landscapeHand).toMatch(/grid-template-rows:\s*minmax\(0, 1fr\) 44px/);
  expect(landscapeHand).toMatch(/align-content:\s*start/);
  expect(landscapeHand).toMatch(/overflow:\s*hidden/);
  expect(landscapeHand).toMatch(/min-height:\s*calc\(112px \+ var\(--fg-safe-bottom\)\)/);
  expect(landscapeHand).toMatch(/height:\s*calc\(112px \+ var\(--fg-safe-bottom\)\)/);
  expect(landscapeHand).toMatch(/max-height:\s*calc\(112px \+ var\(--fg-safe-bottom\)\)/);
  expect(landscapeHand).toMatch(/border-top:\s*1px solid/);
  expect(landscapeHand).toMatch(/border-left:\s*0/);
  expect(landscapeHand).toMatch(/padding-right:\s*max\(5px, var\(--fg-safe-right, 0px\)\)/);
  expect(landscapeHand).toMatch(/padding-bottom:\s*max\(3px, var\(--fg-safe-bottom\)\)/);
  expect(landscapeHand).toMatch(/padding-left:\s*max\(5px, var\(--fg-safe-left, 0px\)\)/);
  expect(landscapeRail).toMatch(/width:\s*100%/);
  expect(landscapeRail).toMatch(/height:\s*100%/);
  expect(landscapeRail).toMatch(/gap:\s*7px/);
  expect(landscapeRail).toMatch(/scroll-snap-type:\s*x proximity/);
  expect(landscapeGroup).toMatch(/grid-template-rows:\s*auto 14px/);
  expect(landscapeGroupCards).toMatch(/min-height:\s*50px/);
  expect(landscapeCard).toMatch(/width:\s*clamp\(39px, 5\.2vw, 46px\)/);
  expect(landscapeCard).toMatch(/height:\s*clamp\(48px, 13svh, 54px\)/);
  expect(landscapeOverlap).toMatch(/margin-left:\s*-14px/);
  expect(landscapeActions).toMatch(/position:\s*static/);
  expect(landscapeActions).toMatch(/grid-row:\s*2/);
  expect(landscapeActions).toMatch(/width:\s*100%/);
  expect(landscapeActions).toMatch(/grid-template-columns:\s*repeat\(6, minmax\(0, 1fr\)\)/);
  expect(landscapeActions).toMatch(/grid-template-rows:\s*44px/);
  expect(landscapeActions).toMatch(/pointer-events:\s*auto/);
  expect(landscapeActionButton).toMatch(/min-height:\s*44px/);
  expect(landscapeActionButton).toMatch(/height:\s*44px/);
  expect(landscapeActionButton).toMatch(/pointer-events:\s*auto/);
  expect(landscapeValidation).toMatch(/top:\s*1px/);
  expect(landscapeValidation).toMatch(/bottom:\s*auto/);
  expect(landscapeValidation).toMatch(/max-width:\s*calc\(100% - 16px\)/);
  expect(landscapeHud).toMatch(/display:\s*none/);
  expect(landscapeSeatBack).toMatch(/display:\s*none/);
  expect(landscape).not.toMatch(/\.rummy-seat-[0-4]\s*\{/);
  expect(css.match(/\.rummy-seat-[0-4]\s*\{/g)).toHaveLength(5);
});

test("extra-short landscape phones keep the hand and controls inside the visible viewport", () => {
  const css = fs.readFileSync(path.join(__dirname, "rummy.css"), "utf8");
  const extraShort = cssBlock(css, "@media (orientation: landscape) and (max-height: 340px)");
  const hand = cssRuleWithin(extraShort, ".rummy-hand-zone");
  const card = cssRuleWithin(extraShort, ".rummy-card");
  expect(hand).toMatch(/height:\s*calc\(112px \+ var\(--fg-safe-bottom\)\)/);
  expect(card).toMatch(/height:\s*clamp\(48px, 15svh, 52px\)/);
});

test("taller mobile landscape viewports keep the palace presentation fitted to the full safe rectangle", () => {
  const css = fs.readFileSync(path.join(__dirname, "rummy.css"), "utf8");
  const mobileLandscape = cssBlock(css, "@media (orientation: landscape) and (min-height: 431px) and (max-height: 620px) and (max-width: 1180px)");
  expect(cssRuleWithin(mobileLandscape, ".rummy-stage,\n  .rummy-table-slot")).toMatch(/width:\s*100%;\s*height:\s*100%/);
  expect(cssRuleWithin(mobileLandscape, ".rummy-table")).toMatch(/top:\s*49%;\s*width:\s*min\(100cqw, calc\(290cqh - 232px\)\)/);
});

test("mobile Joker styling keeps rank suits visible and printed Jokers self-contained", () => {
  const css = fs.readFileSync(path.join(__dirname, "rummy.css"), "utf8");
  expect(css).toMatch(/\.rummy-card\.is-rank-wild\s*\{[^}]*background:/s);
  expect(css).toMatch(/\.rummy-wild-badge\s*\{[^}]*right:\s*4px;[^}]*top:\s*4px[^}]*border-radius:\s*50%/s);
  expect(css).toMatch(/\.rummy-card\.is-printed-joker\s*\{[^}]*overflow:\s*hidden;[^}]*border-color:/s);
  expect(css).toMatch(/\.rummy-joker-emblem\s*\{[^}]*inset:\s*18% 13%/s);
  expect(css).not.toContain(".rummy-wild-crown");
  expect(css.indexOf(".rummy-card:not(.rummy-card-placeholder)")).toBeLessThan(css.indexOf(".rummy-card.is-selected"));
  expect(css.indexOf(".rummy-card:not(.rummy-card-placeholder)")).toBeLessThan(css.indexOf(".rummy-card.is-rank-wild"));
  expect(css.indexOf(".rummy-card:not(.rummy-card-placeholder)")).toBeLessThan(css.indexOf(".rummy-card.is-printed-joker"));
});

test("the deterministic preview demonstrates visibly varied avatar families", () => {
  const state = createRummyDemoState("LV1");
  expect(state.seats.map((seat) => seat.avatar)).toEqual([
    "avatar-01", "avatar-26", "avatar-37", "avatar-48", "avatar-59",
  ]);
});

test("the approved five-seat palace table asset is reserved for gameplay", () => {
  const source = fs.readFileSync(path.join(__dirname, "RummyGame.js"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "rummy.css"), "utf8");
  const asset = fs.readFileSync(path.join(__dirname, "../../../public/game-art/rummy/table-palace-v2.png"));
  expect(source.match(/\/game-art\/rummy\/table-palace-v2\.png/g)).toHaveLength(1);
  expect(source).not.toContain("table-cinematic");
  expect(source).not.toContain("backgroundImage");
  expect(source).not.toContain("rummy-table-inlay");
  expect(source).toContain('className="rummy-table-art"');
  expect(css).toMatch(/\.rummy-table::before,\s*\.rummy-table::after\s*\{[^}]*content:\s*none;[^}]*display:\s*none;/s);
  expect(css).toMatch(/\.rummy-table-art\s*\{[^}]*object-fit:\s*contain;[^}]*pointer-events:\s*none/s);
  expect(css).toMatch(/\.rummy-table-slot\.is-art-loading \.rummy-table > :not\(\.rummy-table-art\)\s*\{[^}]*visibility:\s*hidden/s);
  expect(css).toMatch(/\.rummy-seat-0\s*\{\s*left:\s*32\.9%;\s*top:\s*80\.6%/s);
  expect(css).toMatch(/\.rummy-seat-1\s*\{\s*left:\s*15\.1%;\s*top:\s*40%/s);
  expect(css).toMatch(/\.rummy-seat-2\s*\{\s*left:\s*50%;\s*top:\s*22\.2%/s);
  expect(css).toMatch(/\.rummy-seat-3\s*\{\s*left:\s*84\.9%;\s*top:\s*40%/s);
  expect(css).toMatch(/\.rummy-seat-4\s*\{\s*left:\s*67%;\s*top:\s*80\.6%/s);
  expect(asset.readUInt32BE(16)).toBe(1672);
  expect(asset.readUInt32BE(20)).toBe(941);
  expect(crypto.createHash("sha256").update(asset).digest("hex")).toBe(
    "867b6f3985edc429c1ed0e34a36ac78845ab191f567c7e6e126ce003d02eda42",
  );
});

test("landscape gameplay extends the palace atmosphere edge to edge without altering the contained table", () => {
  const css = fs.readFileSync(path.join(__dirname, "rummy.css"), "utf8");
  expect(css).toMatch(/\.rummy-table-slot::after\s*\{[^}]*inset:\s*0;[^}]*var\(--rummy-palace-art\)[^}]*center 47% \/ cover no-repeat/s);
  expect(css).toMatch(/\.rummy-table-slot::after\s*\{[^}]*filter:\s*none/s);
  expect(css).toMatch(/\.rummy-table-slot\.is-art-ready::after\s*\{\s*opacity:\s*1/);
  expect(css).toMatch(/\.rummy-table\s*\{[^}]*position:\s*absolute;[^}]*left:\s*50%;[^}]*top:\s*47%;[^}]*width:\s*min\(100cqw, 255cqh\)[^}]*transform:\s*translate\(-50%, -50%\) translateZ\(0\)/s);
  expect(css).toMatch(/\.rummy-table-art\s*\{[^}]*object-fit:\s*contain/s);
  expect(css).toMatch(/\.rummy-hand-zone\s*\{[^}]*backdrop-filter:\s*blur\(12px\) saturate\(1\.08\)/s);
});

test("the hand uses interruptible shared-layout card motion with a reduced-motion fallback", () => {
  const source = fs.readFileSync(path.join(__dirname, "RummyGame.js"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "rummy.css"), "utf8");
  expect(source).toContain("AnimatePresence, LayoutGroup, motion");
  expect(source).toContain('layoutId: motionId || undefined');
  expect(source).toContain('type: "spring", duration: 0.24, bounce: 0.12');
  expect(source).toContain('transform: `translate3d(0,${restingLift}px,0) scale(1) rotate(0deg)`');
  expect(source).toContain('whileTap: { transform: `translate3d(0,${pressedLift}px,0) scale(.975) rotate(0deg)` }');
  expect(source).toContain('transform: "translate3d(0,-30px,0) scale(.96) rotate(3deg)"');
  expect(source).toContain('entering={arrivingCardId === id}');
  expect(css).toMatch(/\.rummy-card\s*\{[^}]*transition:\s*transform 180ms cubic-bezier\(\.23,1,\.32,1\)/s);
  expect(css).not.toMatch(/transition:\s*all/i);
  expect(css).toMatch(/@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.rummy-card[^}]*transition:\s*none/s);
});

test("state polling backs off after failures and resets after success", () => {
  expect(nextRummyPollDelay(900, false)).toBe(1800);
  expect(nextRummyPollDelay(7200, false)).toBe(8000);
  expect(nextRummyPollDelay(8000, true)).toBe(900);
});

test("state polling is recursive, abortable and never interval-overlaps", () => {
  const source = fs.readFileSync(path.join(__dirname, "RummyGame.js"), "utf8");
  expect(source).not.toContain("setInterval(");
  expect(source).toContain("pollInFlightRef.current");
  expect(source).toContain("new AbortController()");
  expect(source).toContain("pollAbortRef.current?.abort()");
});

test("the Rummy preview exposes a direct palace-table gameplay URL", () => {
  const source = fs.readFileSync(path.join(__dirname, "RummyGame.js"), "utf8");
  expect(source).toContain('new URLSearchParams(window.location.search).get("play") === "1"');
  expect(source).toContain('void join(categories[0].id, "PRACTICE")');
});
