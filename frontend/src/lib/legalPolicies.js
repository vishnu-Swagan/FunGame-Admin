import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { LEGAL_ROUTES } from "@/lib/legalContent";

const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

function safePolicyUrl(value, fallback) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const url = value.trim();
  if (url.startsWith("/") && !url.startsWith("//")) return url;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password ? url : fallback;
  } catch {
    return fallback;
  }
}

function normalizeDocument(value, key) {
  const version = typeof value?.version === "string" ? value.version.trim() : "";
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Current ${key} policy version is unavailable`);
  }
  return Object.freeze({
    key,
    title: value?.title || (key === "terms" ? "Terms and Conditions" : "Privacy Notice"),
    version,
    url: safePolicyUrl(value?.url, key === "terms" ? LEGAL_ROUTES.terms : LEGAL_ROUTES.privacy),
    effectiveAt: value?.effective_at || null,
    contentSha256: value?.content_sha256 || null,
    required: value?.required !== false,
  });
}

export function normalizeRegistrationPolicies(value) {
  return Object.freeze({
    schemaVersion: Number(value?.schema_version) || 1,
    terms: normalizeDocument(value?.documents?.terms, "terms"),
    privacy: normalizeDocument(value?.documents?.privacy, "privacy"),
    explicitVersionsRequired: value?.acceptance?.explicit_versions_required === true,
  });
}

export function useRegistrationPolicies() {
  const [state, setState] = useState({ policies: null, loading: true, error: null });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    setState({ policies: null, loading: true, error: null });
    setAttempt((value) => value + 1);
  }, []);

  useEffect(() => {
    let active = true;
    api.get("/auth/policies/current")
      .then(({ data }) => {
        if (active) setState({ policies: normalizeRegistrationPolicies(data), loading: false, error: null });
      })
      .catch(() => {
        if (active) setState({ policies: null, loading: false, error: "The current account policies could not be loaded. Please retry." });
      });
    return () => { active = false; };
  }, [attempt]);

  return { ...state, retry };
}
