export function registrationReview(user = {}) {
  const selfService = user.registration_source === "SELF_SERVICE";
  const manualReview = selfService && user.activation_mode === "ADMIN_REVIEW";
  const phonePrimary = user.primary_identity_channel === "PHONE";
  const contact = manualReview
    ? [user.phone, user.email].filter(Boolean).join(" · ")
    : phonePrimary ? user.phone : user.email;
  const channelVerified = phonePrimary ? user.phone_verified : user.email_verified;
  const contactVerified = Boolean(user.contact_verified && channelVerified);
  const verificationDeferred = user.activation_mode === "SELF_SERVICE_NO_OTP"
    && user.contact_verification_status === "DEFERRED";
  const phoneOtpActivated = user.activation_mode === "PHONE_OTP"
    && contactVerified && Boolean(user.approved_at || user.activated_at);
  const manualReviewApproved = manualReview
    && user.manual_contact_reviewed === true
    && user.contact_verification_status === "ADMIN_APPROVED";
  const termsAccepted = user.accepted_terms === true;
  const submitted = Boolean(user.submitted_at);
  const directlyActivated = (verificationDeferred && user.status === "ACTIVE") || phoneOtpActivated;
  return {
    selfService,
    sourceLabel: selfService ? "Self-service" : "Operator-provisioned",
    contactLabel: manualReview ? "Contacts" : phonePrimary ? "Mobile" : "Email",
    contact: contact || "—",
    contactVerified,
    manualReview,
    manualReviewApproved,
    verificationDeferred,
    contactStatusLabel: contactVerified
      ? "verified"
      : manualReviewApproved
        ? "admin approved; OTP pending"
        : manualReview
          ? "awaiting admin review"
          : verificationDeferred ? "OTP deferred" : "not verified",
    termsAccepted,
    submitted,
    directlyActivated,
    submissionLabel: directlyActivated
      ? (phoneOtpActivated ? "Activated by phone OTP" : "Activated at registration")
      : submitted ? null : "Not submitted",
    // Deferred verification explains how an already-active launch account was
    // created; it must never satisfy the backend's contact-verification gate
    // for approving or reactivating a suspended/rejected account.
    approvalReady: !selfService || (
      termsAccepted
      && (submitted || directlyActivated)
      && (contactVerified || manualReview)
    ),
  };
}
