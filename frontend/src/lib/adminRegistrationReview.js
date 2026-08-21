export function registrationReview(user = {}) {
  const selfService = user.registration_source === "SELF_SERVICE";
  const phonePrimary = user.primary_identity_channel === "PHONE";
  const contact = phonePrimary ? user.phone : user.email;
  const channelVerified = phonePrimary ? user.phone_verified : user.email_verified;
  const contactVerified = Boolean(user.contact_verified && channelVerified);
  const termsAccepted = user.accepted_terms === true;
  const submitted = Boolean(user.submitted_at);
  return {
    selfService,
    sourceLabel: selfService ? "Self-service" : "Operator-provisioned",
    contactLabel: phonePrimary ? "Mobile" : "Email",
    contact: contact || "—",
    contactVerified,
    termsAccepted,
    submitted,
    approvalReady: !selfService || (contactVerified && termsAccepted && submitted),
  };
}
