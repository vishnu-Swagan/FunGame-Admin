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
