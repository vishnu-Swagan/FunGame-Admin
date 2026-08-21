import {
  isValidE164Phone,
  loginVerificationRecovery,
  normalizeAuthCapabilities,
  normalizeContactIdentifier,
  registrationChannelAvailable,
  verificationChannelState,
} from "./authCapabilities";

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

test("contact normalization matches backend email and E.164 phone rules", () => {
  expect(normalizeContactIdentifier("EMAIL", " Player@Example.COM ")).toBe("player@example.com");
  expect(normalizeContactIdentifier("PHONE", "+91 98765-43210")).toBe("+919876543210");
  expect(isValidE164Phone("+1234567")).toBe(false);
  expect(isValidE164Phone("+12345678")).toBe(true);
  expect(isValidE164Phone("+919876543210")).toBe(true);
});

test("an issued OTP remains verifiable when delivery pauses but cannot be resent", () => {
  const closed = normalizeAuthCapabilities({ registration_enabled: false, email_registration: false, phone_registration: false });
  expect(verificationChannelState(closed, "EMAIL", false)).toEqual({
    deliveryAvailable: false,
    verificationAvailable: false,
    anyChannelAvailable: false,
  });
  expect(verificationChannelState(closed, "EMAIL", true)).toEqual({
    deliveryAvailable: false,
    verificationAvailable: true,
    anyChannelAvailable: false,
  });
});

test("login recovery only builds a resend request for a ready channel", () => {
  const phoneOnly = normalizeAuthCapabilities({ registration_enabled: true, email_registration: false, phone_registration: true });
  expect(loginVerificationRecovery(phoneOnly, "EMAIL", "Player@Example.com")).toBeNull();
  expect(loginVerificationRecovery(phoneOnly, "SMS", "+91 98765-43210")).toEqual({
    channel: "PHONE",
    contact: "+919876543210",
    body: {
      channel: "PHONE",
      identifier: "+919876543210",
      email: undefined,
      phone: "+919876543210",
    },
  });
});
