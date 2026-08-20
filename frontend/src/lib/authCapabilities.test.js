import { normalizeAuthCapabilities, registrationChannelAvailable } from "./authCapabilities";

test("auth capabilities fail closed for missing, malformed or inconsistent responses", () => {
  expect(normalizeAuthCapabilities()).toEqual({ registration_enabled: false, email_registration: false, phone_registration: false });
  expect(normalizeAuthCapabilities({ registration_enabled: true, email_registration: "yes", phone_registration: false }))
    .toEqual({ registration_enabled: false, email_registration: false, phone_registration: false });
});

test("only explicitly ready registration channels are selectable", () => {
  const capabilities = normalizeAuthCapabilities({ registration_enabled: true, email_registration: true, phone_registration: false });
  expect(registrationChannelAvailable(capabilities, "EMAIL")).toBe(true);
  expect(registrationChannelAvailable(capabilities, "PHONE")).toBe(false);
});
