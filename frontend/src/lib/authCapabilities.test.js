import {
  isValidE164Phone,
  loginIdFromPhone,
  loginVerificationRecovery,
  normalizeAuthCapabilities,
  normalizeContactIdentifier,
  registrationChannelAvailable,
  verificationChannelState,
} from "./authCapabilities";

test("auth capabilities fail closed for missing, malformed or inconsistent responses", () => {
  const closed = {
    registration_enabled: false,
    email_registration: false,
    phone_registration: false,
    email_contact_verification: false,
    phone_contact_verification: false,
    email_password_reset: false,
    phone_password_reset: false,
    phone_verification_required: true,
    email_verification_required: false,
    manual_admin_review: false,
    registration_mode: "PHONE_OTP",
    verification_required: true,
  };
  expect(normalizeAuthCapabilities()).toEqual(closed);
  expect(normalizeAuthCapabilities({ registration_enabled: true, email_registration: "yes", phone_registration: false }))
    .toEqual(closed);
});

test("the client never accepts a no-OTP capability downgrade", () => {
  expect(normalizeAuthCapabilities({
    registration_enabled: true,
    email_registration: true,
    phone_registration: true,
    email_contact_verification: false,
    phone_contact_verification: false,
    email_password_reset: false,
    phone_password_reset: false,
    verification_required: false,
  })).toMatchObject({ registration_enabled: true, verification_required: true, registration_mode: "PHONE_OTP" });
  expect(normalizeAuthCapabilities({
    registration_enabled: true,
    email_registration: true,
  })).toMatchObject({ registration_enabled: false, verification_required: true });
});

test("manual registration does not hide independent recovery and legacy verification", () => {
  const capabilities = normalizeAuthCapabilities({
    registration_enabled: true,
    email_registration: true,
    phone_registration: true,
    verification_required: false,
    manual_admin_review: true,
    registration_mode: "ADMIN_REVIEW",
    email_contact_verification: true,
    phone_contact_verification: false,
    email_password_reset: true,
    phone_password_reset: false,
  });
  expect(capabilities.email_password_reset).toBe(true);
  expect(loginVerificationRecovery(capabilities, "EMAIL", "Old@Example.com")).toMatchObject({
    channel: "EMAIL",
    contact: "old@example.com",
  });
});

test("manual admin review is accepted only when the server names the mode and both contacts are ready", () => {
  expect(normalizeAuthCapabilities({
    registration_enabled: true,
    email_registration: true,
    phone_registration: true,
    verification_required: false,
    manual_admin_review: true,
    registration_mode: "ADMIN_REVIEW",
  })).toEqual({
    registration_enabled: true,
    email_registration: true,
    phone_registration: true,
    email_contact_verification: false,
    phone_contact_verification: false,
    email_password_reset: false,
    phone_password_reset: false,
    phone_verification_required: false,
    email_verification_required: false,
    verification_required: false,
    manual_admin_review: true,
    registration_mode: "ADMIN_REVIEW",
  });
  expect(normalizeAuthCapabilities({
    registration_enabled: true,
    email_registration: false,
    phone_registration: true,
    verification_required: false,
    manual_admin_review: true,
    registration_mode: "ADMIN_REVIEW",
  }).registration_enabled).toBe(false);
});

test("only an explicitly ready phone channel can register", () => {
  const capabilities = normalizeAuthCapabilities({ registration_enabled: true, email_registration: true, phone_registration: true });
  expect(registrationChannelAvailable(capabilities, "EMAIL")).toBe(false);
  expect(registrationChannelAvailable(capabilities, "PHONE")).toBe(true);
});

test("dual registration preserves the server email-verification requirement", () => {
  const capabilities = normalizeAuthCapabilities({
    registration_enabled: true,
    phone_registration: true,
    email_contact_verification: true,
    phone_contact_verification: true,
    email_verification_required: true,
  });
  expect(capabilities.registration_enabled).toBe(true);
  expect(capabilities.email_verification_required).toBe(true);
  expect(verificationChannelState(capabilities, "EMAIL", false).deliveryAvailable).toBe(true);
});

test("contact normalization matches backend email and E.164 phone rules", () => {
  expect(normalizeContactIdentifier("EMAIL", " Player@Example.COM ")).toBe("player@example.com");
  expect(normalizeContactIdentifier("PHONE", "+91 98765-43210")).toBe("+919876543210");
  expect(normalizeContactIdentifier("PHONE", "+91 (98765).43210")).toBe("+919876543210");
  expect(isValidE164Phone("+1234567")).toBe(false);
  expect(isValidE164Phone("+12345678")).toBe(true);
  expect(isValidE164Phone("+91 (98765).43210")).toBe(true);
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
  const phoneReadyEmailOptional = normalizeAuthCapabilities({
    registration_enabled: true,
    phone_registration: true,
    email_contact_verification: true,
    phone_contact_verification: true,
    email_verification_required: false,
  });
  expect(loginVerificationRecovery(phoneReadyEmailOptional, "EMAIL", "Player@Example.com")).toBeNull();
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

test("login IDs derived from E.164 phones match the backend rule", () => {
  expect(loginIdFromPhone("+91 98765-43210")).toBe("p919876543210");
  expect(loginIdFromPhone("+447700900123")).toBe("p447700900123");
  expect(loginIdFromPhone("+919876543210")).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{3,31}$/);
});
