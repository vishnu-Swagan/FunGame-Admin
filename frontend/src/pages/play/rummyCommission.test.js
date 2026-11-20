import { rummyCommissionForCategory } from './rummyCommission';
test('calculates displayed gross pot, commission and winner payout in whole chips', () => {
  expect(rummyCommissionForCategory({entryChips:20000,houseCommissionBps:1500})).toEqual({bps:1500,percent:15,grossPot:100000,fee:15000,winnerPayout:85000});
  expect(rummyCommissionForCategory({entryChips:101,houseCommissionBps:1500}).winnerPayout).toBe(430);
  expect(rummyCommissionForCategory({entryChips:100}).fee).toBe(0);
  expect(rummyCommissionForCategory({entryChips:100,houseCommissionBps:-1})).toBeNull();
});
