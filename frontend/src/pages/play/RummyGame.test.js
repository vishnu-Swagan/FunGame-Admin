import { act } from "react";
import { createRoot } from "react-dom/client";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { api } from "@/lib/api";
import RummyGame, { CategoryLobby, getRummyScheduleInfo, nextRummyPollDelay, PlayerSeat, Results, RummyTable } from "./RummyGame";
import { applyRummyDemoAction, createRummyDemoState, RUMMY_DEMO_CATEGORIES } from "./rummyDemo";


jest.mock("react-router-dom", () => ({ useNavigate: () => jest.fn() }), { virtual: true });
jest.mock("sonner", () => ({ toast: { info: jest.fn(), error: jest.fn() } }));
jest.mock("@/lib/api", () => ({
  api: { get: jest.fn(), post: jest.fn() },
  errCode: () => null,
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
  expect(container.querySelector(".rummy-only-timer").parentElement).toBe(container.querySelector(".rummy-avatar-ring"));
  act(() => root.unmount());
});

test("bot opponents are explicitly labelled with their server difficulty", () => {
  const bot = { seatIndex: 1, status: "ACTIVE", displayName: "Mira", avatar: "avatar-37", isBot: true, botLabel: "Expert bot", cardCount: 13 };
  const { container, root } = renderSeat(bot, 3);
  expect(container.textContent).toContain("Expert bot");
  expect(container.querySelector(".rummy-seat-bot-badge")?.textContent).toBe("BOT");
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

test("royal table conversation labels bots and sends only allow-listed code reactions", async () => {
  const state = createRummyDemoState("LV2");
  state.chatEvents = [{
    id: "BOT-CHAT-1",
    reactionId: "laugh",
    message: "That was close!",
    sender: { displayName: "Maharaja Arin", isBot: true, label: "BOT", botLabel: "BOT · CLASSIC" },
  }];
  const sendSocialEvent = jest.fn().mockResolvedValue({
    accepted: true,
    event: { id: "PLAYER-GIF-1", reactionId: "royal-clap", message: "A royal applause!", sender: { displayName: "You", isBot: false } },
  });
  const { container, root } = await render(<RummyTable state={state} busy={false} reconnecting={false} sendAction={jest.fn()} sendSocialEvent={sendSocialEvent} onExit={jest.fn()} />);
  await click(container.querySelector('button[aria-label="Open Rummy table conversation"]'));
  expect(container.querySelector(".rummy-social-drawer")).not.toBeNull();
  expect(container.querySelector(".rummy-chat-log")?.textContent).toContain("BOT · CLASSIC");
  expect(container.querySelector(".rummy-chat-log")?.textContent).not.toContain("BOT · BOT");
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
  };
  const onSupportRequest = jest.fn().mockResolvedValue(true);
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

  const request = container.querySelector('textarea[aria-label="Music request"]');
  expect(request.maxLength).toBe(120);
  await typeInto(request, "Play a calm instrumental mood");
  await click([...container.querySelectorAll("button")].find((button) => button.textContent.includes("SEND MUSIC REQUEST")));
  expect(onSupportRequest).toHaveBeenCalledWith("MUSIC_REQUEST", "Play a calm instrumental mood");
  expect(container.querySelector(".rummy-support-status")?.textContent).toContain("Support inbox");
  await click([...container.querySelectorAll(".rummy-social-drawer nav button")].find((button) => button.textContent.includes("Help Desk")));
  expect(container.querySelector('textarea[aria-label="Help Desk message"]').maxLength).toBe(240);
  act(() => root.unmount());
});

test("the active ring uses the category turn duration instead of a hard-coded thirty seconds", () => {
  const opponent = { seatIndex: 1, status: "ACTIVE", displayName: "Rival", playerId: "PL***02", isBot: false, cardCount: 13, active: true };
  const { container, root } = renderSeat(opponent, 3, 22, 22);
  expect(container.querySelector(".rummy-avatar-ring")?.style.getPropertyValue("--turn-progress")).toBe("1");
  act(() => root.unmount());
});

test("the Rummy lobby presents all five levels without showing the gameplay table", async () => {
  const { container, root } = await render(<RummyGame game={{ slug: "rummy", name: "Rummy", demo: true }} />);
  const lobby = container.querySelector('[data-testid="rummy-category-lobby"]');
  expect(lobby).not.toBeNull();
  expect(lobby.textContent).toContain("CHAKRI.CASINO");
  expect(lobby.textContent).toContain("RUMMY");
  expect(lobby.textContent).toContain("MOST PLAYED ONLINE");
  expect(lobby.querySelector('header img[src="/chakri-app-icon-192.png"]')).not.toBeNull();
  expect(lobby.querySelector(".rummy-lobby-table-preview")).toBeNull();
  expect(lobby.querySelector('img[src="/game-art/rummy/table-palace-v2.png"]')).toBeNull();
  expect([...lobby.querySelectorAll(".rummy-category")].map((card) => card.textContent).join(" ")).toMatch(/LV1[\s\S]*LV2[\s\S]*LV3[\s\S]*LV4[\s\S]*LV5/);
  const practiceButtons = [...lobby.querySelectorAll("button")].filter((button) => button.textContent === "PRACTICE TABLE");
  expect(practiceButtons).toHaveLength(5);
  practiceButtons.forEach((button) => expect(button.disabled).toBe(false));
  expect(lobby.textContent).not.toContain("FAIR BOT TABLE");
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
  const cards = [...container.querySelectorAll(".rummy-category")];
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
  expect(container.querySelector(".rummy-bot-table-notice")?.textContent).toContain("automated players are labelled BOT");
  expect(container.textContent).toContain("PURE SEQUENCE");

  await click(container.querySelector('button[aria-label="CLOSED DECK"]'));
  const drawn = container.querySelector('button[data-card-id="DEMO-2-C-2"]');
  expect(drawn).not.toBeNull();
  await click(drawn);
  const declare = [...container.querySelectorAll(".rummy-actions button")].find((button) => button.textContent.includes("DISCARD & DECLARE"));
  expect(declare.disabled).toBe(false);
  expect(container.querySelector(".rummy-validation")?.textContent).toContain("Ready");
  await click(declare);
  expect(container.querySelector("#rummy-result-title")?.textContent).toBe("You win");
  expect(container.querySelector(".rummy-result-rows")?.textContent).toContain("BOT · PRACTICE");
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
  const panel = container.querySelector(".rummy-results");
  const lobbyButton = panel.querySelector("button");
  expect(panel.classList.contains("is-player-win")).toBe(true);
  expect(panel.dataset.reducedMotion).toBe("true");
  expect(container.querySelector("#rummy-result-title")?.textContent).toBe("You win");
  expect(container.querySelector('[data-testid="rummy-player-win-celebration"]')?.textContent).toContain("ROYAL VICTORY");
  expect(container.querySelector('[data-testid="rummy-player-win-celebration"]')?.classList.contains("is-static")).toBe(true);
  expect(document.activeElement).toBe(lobbyButton);
  [...panel.querySelectorAll(".rummy-result-ribbon, h2, p, article")].forEach((element) => {
    expect(["", "none"]).toContain(element.style.transform);
  });
  await pressKey("Tab");
  expect(document.activeElement).toBe(lobbyButton);
  await pressKey("Tab", { shiftKey: true });
  expect(document.activeElement).toBe(lobbyButton);

  await act(async () => root.render(<Results result={{ ...result, winnerSeat: 1, winnerName: "You" }} viewerSeatIndex={2} onLobby={onLobby} reducedMotion />));
  expect(container.querySelector(".rummy-results").classList.contains("is-player-loss")).toBe(true);
  expect(container.querySelector('[data-testid="rummy-player-win-celebration"]')).toBeNull();
  await pressKey("Escape");
  expect(onLobby).toHaveBeenCalledTimes(1);
  act(() => root.unmount());
  expect(document.activeElement).toBe(returnTarget);
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
  expect(container.querySelector(".rummy-results")).not.toBeNull();
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
  expect(container.querySelector("#rummy-result-title")?.textContent).toBe("You win");
  expect(container.querySelector('[data-testid="rummy-player-win-celebration"]')).not.toBeNull();
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
    { timeout: 22000 },
  );
  expect(container.querySelector('[data-testid="rummy-live-table"]')).not.toBeNull();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  act(() => root.unmount());
});

test("the exact-ratio table auto-fits the safe viewport without portrait cropping", () => {
  const css = fs.readFileSync(path.join(__dirname, "rummy.css"), "utf8");
  expect(css).toContain("width: var(--fg-usable-w, 100vw)");
  expect(css).toContain("height: var(--fg-usable-h, 100dvh)");
  expect(css).toMatch(/\.rummy-lobby::before\s*\{[^}]*position:\s*absolute/s);
  expect(css).not.toMatch(/\.rummy-table\s*\{[^}]*width:\s*[^;}]*vw/s);
  expect(css).toMatch(/\.rummy-stage\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);
  expect(css).toMatch(/\.rummy-stage\s*\{[^}]*grid-template-rows:\s*minmax\(0, 1fr\) auto/s);
  expect(css).toMatch(/\.rummy-hand-zone\s*\{[^}]*grid-template-rows:\s*auto auto/s);
  expect(css).toMatch(/\.rummy-group-rail\s*\{[^}]*align-items:\s*flex-start/s);
  expect(css).toMatch(/\.rummy-group\s*\{[^}]*grid-template-rows:\s*22px auto/s);
  expect(css).toContain("@media (orientation: landscape) and (max-height: 430px)");
  expect(css).toMatch(/@media \(orientation: landscape\) and \(max-height: 430px\)[\s\S]*?\.rummy-actions button\s*\{[^}]*min-height:\s*42px/s);
  expect(css).toContain("@media (orientation: portrait) and (max-width: 430px)");
  expect(css).toMatch(/@media \(orientation: portrait\) and \(max-width: 430px\)[\s\S]*?\.rummy-table-hud\s*\{\s*display:\s*none/s);
  expect(css).toMatch(/\.rummy-seat\s*\{\s*width:\s*clamp\(48px, 17cqw, 68px\)/s);
  expect(css).toMatch(/@media \(orientation: landscape\) and \(max-height: 430px\)[\s\S]*?\.rummy-seat\s*\{\s*width:\s*clamp\(42px, 17cqw, 58px\)/s);
  expect(css).toMatch(/\.rummy-only-timer\s*\{[^}]*top:\s*0;[^}]*right:\s*-4px;[^}]*transform:\s*translateX\(100%\)/s);
  expect(css).toMatch(/@media \(orientation: landscape\) and \(max-height: 430px\)[\s\S]*?\.rummy-only-timer\s*\{[^}]*width:\s*18px;[^}]*height:\s*18px/s);
  expect(css).toMatch(/@media \(orientation: portrait\) and \(max-width: 430px\)[\s\S]*?\.rummy-only-timer\s*\{[^}]*width:\s*18px;[^}]*height:\s*18px/s);
  expect(css).toContain("container-type: inline-size");
  expect(css).toMatch(/\.rummy-table-slot\s*\{[^}]*container-type:\s*size/s);
  expect(css).toMatch(/\.rummy-table\s*\{[^}]*width:\s*min\(100cqw, 177\.6833cqh\);[^}]*aspect-ratio:\s*1672 \/ 941/s);
  expect(css).toMatch(/@media \(orientation: portrait\)[\s\S]*?\.rummy-stage\s*\{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\)/s);
  expect(css).toMatch(/@media \(orientation: portrait\)[\s\S]*?\.rummy-table-slot\s*\{[^}]*aspect-ratio:\s*1672 \/ 941/s);
  expect(css).not.toContain("height: min(100%, 100vw)");
  expect(css.match(/\.rummy-seat-1\s*\{/g)).toHaveLength(1);
  expect(css.match(/\.rummy-seat-3\s*\{/g)).toHaveLength(1);
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
  expect(css).not.toContain(".rummy-table::before");
  expect(css).not.toContain(".rummy-table::after");
  expect(css).toMatch(/\.rummy-table-art\s*\{[^}]*object-fit:\s*contain;[^}]*pointer-events:\s*none/s);
  expect(css).toMatch(/\.rummy-seat-0\s*\{\s*left:\s*32\.9%;\s*top:\s*80\.6%/s);
  expect(css).toMatch(/\.rummy-seat-4\s*\{\s*left:\s*67%;\s*top:\s*80\.6%/s);
  expect(asset.readUInt32BE(16)).toBe(1672);
  expect(asset.readUInt32BE(20)).toBe(941);
  expect(crypto.createHash("sha256").update(asset).digest("hex")).toBe(
    "867b6f3985edc429c1ed0e34a36ac78845ab191f567c7e6e126ce003d02eda42",
  );
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

test("the development application exposes the isolated Rummy preview route", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../App.js"), "utf8");
  expect(source).toContain('path="/__preview/rummy"');
  expect(source).toContain('game={{ slug: "rummy", name: "Rummy", demo: true }}');
});

test("the Rummy preview exposes a direct palace-table gameplay URL", () => {
  const source = fs.readFileSync(path.join(__dirname, "RummyGame.js"), "utf8");
  expect(source).toContain('new URLSearchParams(window.location.search).get("play") === "1"');
  expect(source).toContain('void join(categories[0].id, "PRACTICE")');
});
