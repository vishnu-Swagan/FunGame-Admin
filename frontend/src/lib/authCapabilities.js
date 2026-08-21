import { useEffect, useState } from "react";
import { api } from "@/lib/api";

const CLOSED_CAPABILITIES = Object.freeze({
  registration_enabled: false,
  email_registration: false,
  phone_registration: false,
});

export function normalizeAuthCapabilities(value) {
  const email = value?.email_registration === true;
  const phone = value?.phone_registration === true;
  return {
    registration_enabled: value?.registration_enabled === true && (email || phone),
    email_registration: email,
    phone_registration: phone,
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
  const deliveryAvailable = registrationChannelAvailable(capabilities, channel);
  return {
    deliveryAvailable,
    verificationAvailable: Boolean(issuedChallenge || deliveryAvailable),
    anyChannelAvailable: ["EMAIL", "PHONE"].some((key) => registrationChannelAvailable(capabilities, key)),
  };
}

export function loginVerificationRecovery(capabilities, detailChannel, identifier) {
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
