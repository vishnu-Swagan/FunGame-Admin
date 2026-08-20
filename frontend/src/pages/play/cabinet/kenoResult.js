export function kenoPayoutLabel(payoutValue, stakeValue, formatMoney = String) {
  const payout = Number(payoutValue) || 0;
  const stake = Number(stakeValue) || 0;
  if (payout <= 0) return "NO WIN";
  if (payout > stake) return `WIN ₹${formatMoney(payout)}`;
  if (payout === stake) return `STAKE RETURN ₹${formatMoney(payout)}`;
  return `RETURN ₹${formatMoney(payout)}`;
}

export function formatRoundClock(secondsValue) {
  const total = Math.max(0, Math.ceil(Number(secondsValue) || 0));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
