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

test("operator-provisioned accounts retain their existing review path", () => {
  expect(registrationReview({ username: "GK1234567" })).toMatchObject({
    sourceLabel: "Operator-provisioned",
    approvalReady: true,
  });
});
