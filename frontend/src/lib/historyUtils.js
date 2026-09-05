/** Classify chip_transactions for player and Admin history screens.

  Typed `kind` is authoritative (STAKE / PAYOUT / REFUND / DEPOSIT / WITHDRAWAL /
  BONUS / ADJUST). Older rows may only have CREDIT/DEBIT plus an English note,
  so those fall back to the same note patterns Admin already uses for won/lost
  totals. Copy stays virtual-chips: this is not cash gambling history.
*/

export const PLAY_KINDS = Object.freeze(["STAKE", "PAYOUT", "REFUND"]);
export const WALLET_KINDS = Object.freeze(["DEPOSIT", "WITHDRAWAL", "BONUS", "ADJUST"]);

const PLAY_SET = new Set(PLAY_KINDS);
const WALLET_SET = new Set(WALLET_KINDS);

const PLAY_LABELS = Object.freeze({
  STAKE: "Lost",
  PAYOUT: "Won",
  REFUND: "Returned",
});

const WALLET_LABELS = Object.freeze({
  DEPOSIT: "Buy",
  WITHDRAWAL: "Withdraw",
  BONUS: "Bonus",
  ADJUST: "Adjustment",
});

export function classifyChipTransaction(tx) {
  const kind = String(tx?.kind || "").toUpperCase();
  if (PLAY_SET.has(kind) || WALLET_SET.has(kind)) return kind;
  const note = String(tx?.note || "");
  if (/win \(round|cashout/i.test(note)) return "PAYOUT";
  if (/bet \(round|Live bet/i.test(note)) return "STAKE";
  if (/refund|cancelled/i.test(note)) return "REFUND";
  if (/Chip request approved|Welcome play chips|provisioned by admin/i.test(note)) return "DEPOSIT";
  const direction = String(tx?.type || "").toUpperCase();
  if (direction === "CREDIT") return "BONUS";
  if (direction === "DEBIT") return "WITHDRAWAL";
  return kind || "ADJUST";
}

export function isPlayTransaction(tx) {
  return PLAY_SET.has(classifyChipTransaction(tx));
}

export function isWalletTransaction(tx) {
  return WALLET_SET.has(classifyChipTransaction(tx));
}

export function playOutcomeLabel(kind) {
  return PLAY_LABELS[kind] || kind;
}

export function walletKindLabel(kind) {
  return WALLET_LABELS[kind] || kind;
}

export function playSummary(transactions) {
  let won = 0;
  let staked = 0;
  let refunded = 0;
  for (const tx of transactions || []) {
    const kind = classifyChipTransaction(tx);
    const amount = Number(tx?.amount) || 0;
    if (kind === "PAYOUT") won += amount;
    else if (kind === "STAKE") staked += amount;
    else if (kind === "REFUND") refunded += amount;
  }
  const lost = Math.max(0, staked - refunded);
  return { won, lost, staked, refunded, net: won - lost };
}

export function matchesHistoryScope(tx, scope) {
  const key = String(scope || "all").toLowerCase();
  if (key === "play") return isPlayTransaction(tx);
  if (key === "wallet") return isWalletTransaction(tx);
  return true;
}
