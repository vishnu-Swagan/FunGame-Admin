import { formatRoundClock, kenoPayoutLabel } from "./kenoResult";

const money = (value) => Number(value).toFixed(2);

test("zero payout is never presented as a win", () => {
  expect(kenoPayoutLabel(0, 100, money)).toBe("NO WIN");
});

test("sub-stake payout is presented as a return, not a win", () => {
  expect(kenoPayoutLabel(36, 100, money)).toBe("RETURN ₹36.00");
});

test("only a payout above stake is presented as a win", () => {
  expect(kenoPayoutLabel(100, 100, money)).toBe("STAKE RETURN ₹100.00");
  expect(kenoPayoutLabel(251, 100, money)).toBe("WIN ₹251.00");
});

test("round clock renders a full minute as 01:00", () => {
  expect(formatRoundClock(60)).toBe("01:00");
  expect(formatRoundClock(30)).toBe("00:30");
  expect(formatRoundClock(0)).toBe("00:00");
});
