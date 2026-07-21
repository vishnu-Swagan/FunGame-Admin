import { alarmStep } from "./useBettingAlarm";

test("alarmStep maps last 5 whole seconds to steps 5..1", () => {
  expect(alarmStep(5.9)).toBe(5);
  expect(alarmStep(4.2)).toBe(4);
  expect(alarmStep(1.0)).toBe(1);
});
test("alarmStep is null above 5s and at/below 0", () => {
  expect(alarmStep(6.1)).toBeNull();
  expect(alarmStep(0)).toBeNull();
});
