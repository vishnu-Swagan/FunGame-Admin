const card = (deck, suit, rank, code, printedJoker = false) => ({
  id: `DEMO-${deck}-${suit}-${rank}`,
  deck,
  suit,
  rank,
  code,
  printedJoker,
});

const DEMO_HAND = [
  card(1, "H", 3, "3H"), card(1, "H", 4, "4H"), card(1, "H", 5, "5H"),
  card(1, "C", 6, "6C"), card(1, "C", 7, "7C"), card(1, "C", 8, "8C"),
  card(1, "S", 9, "9S"), card(1, "H", 9, "9H"), card(1, "D", 9, "9D"),
  card(1, "S", 13, "KS"), card(1, "H", 13, "KH"), card(1, "D", 13, "KD"),
  card(1, "J", 0, "PJ", true),
];

const DEMO_DRAW = card(2, "C", 2, "2C");
const DEMO_OPEN = card(2, "D", 10, "10D");
const DEMO_WILD = card(2, "S", 1, "AS");

const DEMO_GROUPS = [
  { label: "PURE_SEQUENCE", cardIds: DEMO_HAND.slice(0, 3).map(({ id }) => id) },
  { label: "PURE_SEQUENCE", cardIds: DEMO_HAND.slice(3, 6).map(({ id }) => id) },
  { label: "SET", cardIds: DEMO_HAND.slice(6, 9).map(({ id }) => id) },
  { label: "SET", cardIds: DEMO_HAND.slice(9, 13).map(({ id }) => id) },
];

const clone = (value) => JSON.parse(JSON.stringify(value));
const groupKey = (ids) => [...ids].sort().join("|");
const DEMO_LABELS = new Map(DEMO_GROUPS.map((row) => [groupKey(row.cardIds), row.label]));

export const RUMMY_DEMO_BALANCE = 12000;
export const RUMMY_DEMO_CATEGORIES = [
  { id: "LV1", displayName: "Beginner", entryChips: 100, pointsValue: 1, minChipBalance: 100, turnDurationSeconds: 30, firstDropPoints: 20, middleDropPoints: 40, accent: { from: "#0c8f71", to: "#08483c", metal: "#d9b862" } },
  { id: "LV2", displayName: "Classic", entryChips: 500, pointsValue: 2, minChipBalance: 500, turnDurationSeconds: 30, firstDropPoints: 20, middleDropPoints: 40, accent: { from: "#2f9f58", to: "#14532d", metal: "#e5c56d" } },
  { id: "LV3", displayName: "Pro", entryChips: 1000, pointsValue: 5, minChipBalance: 1000, turnDurationSeconds: 28, firstDropPoints: 20, middleDropPoints: 40, accent: { from: "#0d9488", to: "#134e4a", metal: "#f3cf72" } },
  { id: "LV4", displayName: "Elite", entryChips: 2500, pointsValue: 10, minChipBalance: 2500, turnDurationSeconds: 25, firstDropPoints: 20, middleDropPoints: 40, accent: { from: "#3557ad", to: "#172554", metal: "#f0c96a" } },
  { id: "LV5", displayName: "Royal", entryChips: 5000, pointsValue: 20, minChipBalance: 5000, turnDurationSeconds: 22, firstDropPoints: 20, middleDropPoints: 40, accent: { from: "#a42631", to: "#4c0519", metal: "#ffd978" } },
];

function validateGroups(cards, groups) {
  const labels = groups.map((ids) => DEMO_LABELS.get(groupKey(ids)) || "INVALID");
  const flattened = groups.flat();
  const cardIds = cards.map(({ id }) => id);
  const fullyGrouped = flattened.length === cardIds.length
    && new Set(flattened).size === flattened.length
    && cardIds.every((id) => flattened.includes(id));
  const sequenceCount = labels.filter((label) => label.endsWith("SEQUENCE")).length;
  const pureCount = labels.filter((label) => label === "PURE_SEQUENCE").length;
  let code = "VALID_DECLARATION";
  if (!fullyGrouped) code = "CARDS_NOT_FULLY_GROUPED";
  else if (labels.includes("INVALID")) code = "INVALID_GROUP";
  else if (!pureCount) code = "PURE_SEQUENCE_REQUIRED";
  else if (sequenceCount < 2) code = "SECOND_SEQUENCE_REQUIRED";
  return { valid: code === "VALID_DECLARATION", code, groups: labels };
}

function privateStateFor({ cards, groups, drawn, drawnCardId, canAct = true, dropPenaltyPoints = 20 }) {
  const groupValidation = validateGroups(cards, groups);
  const declarableDiscardCardIds = drawn
    ? cards.filter((candidate) => validateGroups(cards.filter(({ id }) => id !== candidate.id), groups).valid).map(({ id }) => id)
    : [];
  const grouped = new Set(groups.flat());
  const score = cards.filter(({ id }) => !grouped.has(id)).reduce((total, item) => total + Math.min(10, Number(item.rank || 0)), 0);
  return {
    seatIndex: 0,
    cards,
    groups,
    drawn,
    drawnCardId,
    suggestedGroups: clone(DEMO_GROUPS),
    ungroupedCardIds: cards.filter(({ id }) => !grouped.has(id)).map(({ id }) => id),
    points: Math.min(80, score),
    groupValidation,
    groupLabels: groupValidation.groups,
    declarableDiscardCardIds,
    dropPenaltyPoints,
    canDraw: canAct && !drawn,
    canDiscard: canAct && drawn,
    canDeclare: canAct && !drawn && groupValidation.valid,
  };
}

function demoSeats(activeSeat = 0) {
  return [
    { seatIndex: 0, playerId: "DE***01", displayName: "You", avatar: "avatar-01", isBot: false, status: "ACTIVE", cardCount: 13, active: activeSeat === 0 },
    { seatIndex: 1, playerId: "BO***01", displayName: "Maya", avatar: "avatar-26", isBot: true, botLabel: "AUTO · PRACTICE", status: "ACTIVE", cardCount: 13, active: activeSeat === 1 },
    { seatIndex: 2, playerId: "BO***02", displayName: "Arjun", avatar: "avatar-37", isBot: true, botLabel: "AUTO · PRACTICE", status: "ACTIVE", cardCount: 13, active: activeSeat === 2 },
    { seatIndex: 3, playerId: "BO***03", displayName: "Tara", avatar: "avatar-48", isBot: true, botLabel: "AUTO · PRACTICE", status: "ACTIVE", cardCount: 13, active: activeSeat === 3 },
    { seatIndex: 4, playerId: "BO***04", displayName: "Kabir", avatar: "avatar-59", isBot: true, botLabel: "AUTO · PRACTICE", status: "ACTIVE", cardCount: 13, active: activeSeat === 4 },
  ];
}

export function createRummyDemoState(categoryId = "LV1") {
  const category = clone(RUMMY_DEMO_CATEGORIES.find(({ id }) => id === categoryId) || RUMMY_DEMO_CATEGORIES[0]);
  return {
    roomId: "rummy-preview-room",
    roundId: "rummy-preview-round-1",
    mode: "PRACTICE",
    state: "TURN_ACTIVE",
    version: 1,
    serverTimestamp: Date.now() / 1000,
    category,
    maxPlayers: 5,
    seats: demoSeats(0),
    currentSeat: 0,
    turnEndsIn: category.turnDurationSeconds,
    closedDeckCount: 53,
    openDiscard: clone(DEMO_OPEN),
    wildJoker: clone(DEMO_WILD),
    privateState: privateStateFor({ cards: clone(DEMO_HAND), groups: DEMO_GROUPS.map(({ cardIds }) => [...cardIds]), drawn: false, drawnCardId: null }),
    result: null,
    walletNeutral: true,
    botTableNotice: "Practice table · AUTO seats fill missing places · no chips are used or returned",
    balance: RUMMY_DEMO_BALANCE,
  };
}

function settledState(state, playerWon, reason) {
  const next = clone(state);
  const cards = next.privateState?.cards || [];
  const userRow = {
    seatIndex: 0, playerId: "DE***01", displayName: "You",
    status: playerWon ? "WON" : "DROPPED", points: playerWon ? 0 : next.privateState?.dropPenaltyPoints || 20,
    chipDelta: 0, cards,
  };
  const botRows = next.seats.slice(1).map((seat, index) => ({
    seatIndex: seat.seatIndex, playerId: seat.playerId, displayName: seat.displayName,
    isBot: true, botLabel: seat.botLabel || "AUTO · PRACTICE",
    status: !playerWon && index === 0 ? "WON" : "LOST", points: !playerWon && index === 0 ? 0 : 42 + index,
    chipDelta: 0, cards: [],
  }));
  next.state = "ROUND_SETTLED";
  next.currentSeat = null;
  next.turnEndsIn = null;
  next.seats = next.seats.map((seat, index) => ({
    ...seat,
    active: false,
    status: playerWon ? (index === 0 ? "WON" : "LOST") : (index === 1 ? "WON" : index === 0 ? "DROPPED" : "LOST"),
    ...(index === 0 && !playerWon ? { droppedPoints: userRow.points } : {}),
  }));
  next.result = {
    winnerSeat: playerWon ? 0 : 1,
    winnerId: playerWon ? "DE***01" : "BO***01",
    winnerName: playerWon ? "You" : "Maya",
    payoutChips: 0,
    virtualPotChips: Number(next.category.entryChips || 0) * 5,
    reason,
    rows: [userRow, ...botRows],
    settledAt: new Date().toISOString(),
  };
  next.version += 1;
  return next;
}

export function applyRummyDemoAction(current, actionType, actionPayload = {}) {
  const next = clone(current);
  const privateState = next.privateState;
  if (!privateState) return next;

  if (actionType === "GROUP") {
    privateState.groups = clone(actionPayload.groups || []);
  } else if (actionType === "DRAW_CLOSED" || actionType === "DRAW_DISCARD") {
    if (!privateState.drawn) {
      const drawnCard = actionType === "DRAW_DISCARD" ? clone(next.openDiscard) : clone(DEMO_DRAW);
      privateState.cards.push(drawnCard);
      privateState.drawn = true;
      privateState.drawnCardId = drawnCard.id;
      next.closedDeckCount = actionType === "DRAW_CLOSED" ? Math.max(0, next.closedDeckCount - 1) : next.closedDeckCount;
      if (actionType === "DRAW_DISCARD") next.openDiscard = null;
    }
  } else if (actionType === "DISCARD") {
    const cardId = String(actionPayload.cardId || "");
    const discarded = privateState.cards.find(({ id }) => id === cardId);
    if (discarded && privateState.drawn) {
      privateState.cards = privateState.cards.filter(({ id }) => id !== cardId);
      privateState.groups = privateState.groups.map((group) => group.filter((id) => id !== cardId)).filter((group) => group.length);
      privateState.drawn = false;
      privateState.drawnCardId = null;
      next.openDiscard = discarded;
    }
  } else if (actionType === "DISCARD_AND_DECLARE") {
    const cardId = String(actionPayload.cardId || "");
    if (!privateState.declarableDiscardCardIds.includes(cardId)) throw new Error("That card does not complete this declaration.");
    privateState.cards = privateState.cards.filter(({ id }) => id !== cardId);
    privateState.groups = clone(actionPayload.groups || privateState.groups);
    return settledState(next, true, "VALID_DECLARATION");
  } else if (actionType === "DECLARE") {
    if (!privateState.groupValidation.valid) throw new Error("The displayed groups are not a valid declaration.");
    return settledState(next, true, "VALID_DECLARATION");
  } else if (actionType === "DROP") {
    return settledState(next, false, "PLAYER_DROPPED");
  } else if (actionType === "LEAVE") {
    next.state = "CANCELLED";
    next.cancelReason = "Practice table closed. No chips were used.";
  }

  next.version += 1;
  next.serverTimestamp = Date.now() / 1000;
  next.privateState = privateStateFor({
    cards: privateState.cards,
    groups: privateState.groups,
    drawn: privateState.drawn,
    drawnCardId: privateState.drawnCardId,
    dropPenaltyPoints: privateState.dropPenaltyPoints,
  });
  next.seats = demoSeats(0).map((seat) => seat.seatIndex === 0 ? { ...seat, cardCount: next.privateState.cards.length } : seat);
  next.turnEndsIn = next.category.turnDurationSeconds;
  return next;
}
