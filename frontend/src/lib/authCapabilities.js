import { useEffect, useState } from "react";
import { api } from "@/lib/api";

const CLOSED_CAPABILITIES = Object.freeze({
  registration_enabled: false,
  email_registration: false,
  phone_registration: false,
  verification_required: true,
  registration_mode: "PHONE_OTP",
});

export function normalizeAuthCapabilities(value) {
  const phone = value?.phone_registration === true;
  const email = value?.email_registration === true;
  const manualReview = value?.registration_mode === "ADMIN_REVIEW"
    && value?.verification_required === false
    && value?.manual_admin_review === true;
  if (manualReview) {
    const registrationEnabled = value?.registration_enabled === true && phone && email;
    return {
      registration_enabled: registrationEnabled,
      email_registration: registrationEnabled,
      phone_registration: registrationEnabled,
      phone_verification_required: false,
      verification_required: false,
      manual_admin_review: true,
      registration_mode: "ADMIN_REVIEW",
    };
  }
  return {
    registration_enabled: value?.registration_enabled === true && phone,
    // New accounts always prove a mobile number. Email is optional profile
    // data and is never exposed as a registration/activation channel.
    email_registration: false,
    phone_registration: phone,
    phone_verification_required: true,
    verification_required: true,
    manual_admin_review: false,
    registration_mode: "PHONE_OTP",
  };
}

export function registrationChannelAvailable(capabilities, channel) {
  if (!capabilities?.registration_enabled) return false;
  return channel === "PHONE" ? capabilities.phone_registration === true : capabilities.email_registration === true;
}

export function normalizeContactChannel(channel, identifier = "") {
  const value = String(channel || "").trim().toUpperCase();
  if (value === "SMS" || value === "PHONE") return "PHONE";
  if (value === "EMAIL") return "EMAIL";
  return String(identifier).includes("@") ? "EMAIL" : "PHONE";
}

export function normalizeContactIdentifier(channel, identifier) {
  const value = String(identifier || "");
  return normalizeContactChannel(channel, value) === "PHONE"
    ? value.replace(/[\s-]/g, "")
    : value.trim().toLowerCase();
}

export function isValidE164Phone(identifier) {
  return /^\+[1-9]\d{7,14}$/.test(normalizeContactIdentifier("PHONE", identifier));
}

export function verificationChannelState(capabilities, channel, issuedChallenge = false) {
  const deliveryAvailable = capabilities?.verification_required === true
    && registrationChannelAvailable(capabilities, channel);
  return {
    deliveryAvailable,
    verificationAvailable: Boolean(issuedChallenge || deliveryAvailable),
    anyChannelAvailable: ["EMAIL", "PHONE"].some((key) => registrationChannelAvailable(capabilities, key)),
  };
}

export function loginVerificationRecovery(capabilities, detailChannel, identifier) {
  if (capabilities?.verification_required !== true) return null;
  const channel = normalizeContactChannel(detailChannel, identifier);
  if (!registrationChannelAvailable(capabilities, channel)) return null;
  const contact = normalizeContactIdentifier(channel, identifier);
  return {
    channel,
    contact,
    body: {
      channel,
      identifier: contact,
      email: channel === "EMAIL" ? contact : undefined,
      phone: channel === "PHONE" ? contact : undefined,
    },
  };
}

export function useAuthCapabilities() {
  const [capabilities, setCapabilities] = useState(CLOSED_CAPABILITIES);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    api.get("/auth/capabilities")
      .then(({ data }) => { if (active) setCapabilities(normalizeAuthCapabilities(data)); })
      .catch(() => { if (active) setCapabilities(CLOSED_CAPABILITIES); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  return { capabilities, loading };
}
