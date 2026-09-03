import { classifyChipTransaction, isPlayTransaction, matchesHistoryScope, playOutcomeLabel, playSummary } from "./historyUtils";

test("prefers typed kind over the note", () => {
  expect(classifyChipTransaction({ kind: "PAYOUT", note: "bet (round 1)" })).toBe("PAYOUT");
  expect(classifyChipTransaction({ kind: "STAKE", note: "Fun Roulette win (round 9)" })).toBe("STAKE");
});

test("classifies legacy note-only play rows", () => {
  expect(classifyChipTransaction({ type: "DEBIT", note: "Fun Roulette bet (round 41)" })).toBe("STAKE");
  expect(classifyChipTransaction({ type: "CREDIT", note: "Fun Roulette win (round 41)" })).toBe("PAYOUT");
  expect(classifyChipTransaction({ type: "CREDIT", note: "Aviator cashout" })).toBe("PAYOUT");
  expect(classifyChipTransaction({ type: "CREDIT", note: "Round cancelled — refund" })).toBe("REFUND");
});

test("play summary nets refunds out of lost chips", () => {
  expect(playSummary([
    { kind: "STAKE", amount: 100 },
    { kind: "PAYOUT", amount: 40 },
    { kind: "STAKE", amount: 50 },
    { kind: "REFUND", amount: 50 },
  ])).toMatchObject({ won: 40, lost: 100, net: -60 });
});

test("scope helpers split play from wallet", () => {
  const stake = { kind: "STAKE", amount: 10 };
  const buy = { kind: "DEPOSIT", amount: 500 };
  expect(isPlayTransaction(stake)).toBe(true);
  expect(isPlayTransaction(buy)).toBe(false);
  expect(matchesHistoryScope(stake, "play")).toBe(true);
  expect(matchesHistoryScope(buy, "play")).toBe(false);
  expect(matchesHistoryScope(buy, "wallet")).toBe(true);
  expect(playOutcomeLabel("PAYOUT")).toBe("Won");
  expect(playOutcomeLabel("STAKE")).toBe("Lost");
});
