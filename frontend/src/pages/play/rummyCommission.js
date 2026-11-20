export function rummyCommissionForCategory(category) {
  const entry = Number(category?.entryChips);
  const bps = category?.houseCommissionBps ?? 0;
  if (!Number.isSafeInteger(entry) || entry <= 0
      || !Number.isInteger(bps) || bps < 0 || bps >= 10000) return null;
  const grossPot = entry * 5;
  const fee = Math.floor(grossPot * bps / 10000);
  return { bps, percent: bps / 100, grossPot, fee, winnerPayout: grossPot - fee };
}
