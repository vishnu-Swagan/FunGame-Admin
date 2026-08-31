describe("legacy chip request rollout flag", () => {
  const original = process.env.REACT_APP_LEGACY_CHIP_REQUESTS_ENABLED;

  afterEach(() => {
    jest.resetModules();
    if (original === undefined) {
      delete process.env.REACT_APP_LEGACY_CHIP_REQUESTS_ENABLED;
    } else {
      process.env.REACT_APP_LEGACY_CHIP_REQUESTS_ENABLED = original;
    }
  });

  test.each([undefined, "", "false", "yes", "1"])(
    "fails closed for %p",
    (value) => {
      jest.resetModules();
      if (value === undefined) {
        delete process.env.REACT_APP_LEGACY_CHIP_REQUESTS_ENABLED;
      } else {
        process.env.REACT_APP_LEGACY_CHIP_REQUESTS_ENABLED = value;
      }
      const { LEGACY_CHIP_REQUESTS_ENABLED } = require("./featureFlags");
      expect(LEGACY_CHIP_REQUESTS_ENABLED).toBe(false);
    },
  );

  test("requires an explicit true value", () => {
    jest.resetModules();
    process.env.REACT_APP_LEGACY_CHIP_REQUESTS_ENABLED = "true";
    const { LEGACY_CHIP_REQUESTS_ENABLED } = require("./featureFlags");
    expect(LEGACY_CHIP_REQUESTS_ENABLED).toBe(true);
  });
});
