import { registrationReview } from "@/lib/adminRegistrationReview";

test("a submitted self-service email registration is approval-ready", () => {
  expect(registrationReview({
    registration_source: "SELF_SERVICE",
    primary_identity_channel: "EMAIL",
    email: "player@example.com",
    contact_verified: true,
    email_verified: true,
    accepted_terms: true,
    submitted_at: "2026-08-21T09:00:00Z",
  })).toMatchObject({
    sourceLabel: "Self-service",
    contactLabel: "Email",
    contact: "player@example.com",
    contactVerified: true,
    submitted: true,
    approvalReady: true,
  });
});

test("an incomplete self-service registration cannot be approved from the UI", () => {
  expect(registrationReview({
    registration_source: "SELF_SERVICE",
    primary_identity_channel: "PHONE",
    phone: "+919876543210",
    contact_verified: true,
    phone_verified: false,
    accepted_terms: true,
  })).toMatchObject({
    contactLabel: "Mobile",
    contactVerified: false,
    submitted: false,
    approvalReady: false,
  });
});

test("a phone-OTP activated account is shown as verified and already activated", () => {
  expect(registrationReview({
    registration_source: "SELF_SERVICE",
    activation_mode: "PHONE_OTP",
    primary_identity_channel: "PHONE",
    phone: "+919876543210",
    email: "optional@example.com",
    contact_verified: true,
    phone_verified: true,
    email_verified: false,
    accepted_terms: true,
    approved_at: "2026-08-21T09:00:00Z",
    activated_at: "2026-08-21T09:00:00Z",
    status: "ACTIVE",
  })).toMatchObject({
    contactLabel: "Mobile",
    contact: "+919876543210",
    contactVerified: true,
    contactStatusLabel: "verified",
    directlyActivated: true,
    submissionLabel: "Activated by phone OTP",
    approvalReady: true,
  });
});

test("operator-provisioned accounts retain their existing review path", () => {
  expect(registrationReview({ username: "GK1234567" })).toMatchObject({
    sourceLabel: "Operator-provisioned",
    approvalReady: true,
  });
});

test("a complete manual-review registration is approval-ready without pretending contacts are OTP verified", () => {
  expect(registrationReview({
    registration_source: "SELF_SERVICE",
    activation_mode: "ADMIN_REVIEW",
    contact_verification_status: "ADMIN_REVIEW_PENDING",
    primary_identity_channel: "PHONE",
    phone: "+919876543210",
    email: "player@example.com",
    contact_verified: false,
    phone_verified: false,
    email_verified: false,
    accepted_terms: true,
    submitted_at: "2026-08-21T09:00:00Z",
    status: "PENDING",
  })).toMatchObject({
    contactLabel: "Admin contact check",
    contact: "+919876543210 · player@example.com",
    contactVerified: false,
    manualReview: true,
    contactStatusLabel: "awaiting admin review",
    approvalReady: true,
  });
});

test("an explicitly no-OTP account is labelled deferred rather than verified", () => {
  expect(registrationReview({
    registration_source: "SELF_SERVICE",
    activation_mode: "SELF_SERVICE_NO_OTP",
    contact_verification_status: "DEFERRED",
    primary_identity_channel: "EMAIL",
    email: "new.player@example.com",
    contact_verified: false,
    email_verified: false,
    accepted_terms: true,
    status: "ACTIVE",
  })).toMatchObject({
    contactVerified: false,
    verificationDeferred: true,
    contactStatusLabel: "OTP deferred",
    directlyActivated: true,
    submissionLabel: "Activated at registration",
    approvalReady: false,
  });
});

test("a suspended deferred-verification account cannot be reapproved without real verification", () => {
  expect(registrationReview({
    registration_source: "SELF_SERVICE",
    activation_mode: "SELF_SERVICE_NO_OTP",
    contact_verification_status: "DEFERRED",
    primary_identity_channel: "EMAIL",
    email: "suspended@example.com",
    contact_verified: false,
    email_verified: false,
    accepted_terms: true,
    submitted_at: "2026-08-21T09:00:00Z",
    status: "SUSPENDED",
  })).toMatchObject({
    verificationDeferred: true,
    directlyActivated: false,
    approvalReady: false,
  });
});
