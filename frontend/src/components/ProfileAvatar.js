import { useEffect, useState } from "react";

import { AvatarBadge } from "@/components/common";
import { api } from "@/lib/api";
import { cartoonAvatarForKey } from "@/lib/profileAvatars";


export function resolvePersonalAvatarUrl(value, apiBase = api?.defaults?.baseURL) {
  const candidate = String(value || "").trim();
  if (!candidate) return null;
  if (/^(blob:|data:image\/|https?:\/\/)/i.test(candidate)) return candidate;
  if (!candidate.startsWith("/")) return null;
  if (!apiBase || !/^https?:\/\//i.test(apiBase)) return candidate;
  try {
    return new URL(candidate, apiBase).toString();
  } catch (error) {
    return candidate;
  }
}

export function ProfileAvatar({
  avatarKey = "star",
  avatarUrl = null,
  size = 48,
  alt = "",
  className = "",
  testId,
  loading = "lazy",
}) {
  const preset = cartoonAvatarForKey(avatarKey);
  const source = resolvePersonalAvatarUrl(avatarUrl) || preset?.src || null;
  const [failed, setFailed] = useState(false);

  useEffect(() => setFailed(false), [source]);

  if (!source || failed) {
    return <AvatarBadge avatarKey={avatarKey} size={size} className={className} testId={testId} />;
  }

  return (
    <span
      data-testid={testId}
      className={`relative inline-flex shrink-0 overflow-hidden rounded-full border border-primary/35 bg-black/30 shadow-[inset_0_1px_0_rgba(255,255,255,0.24),0_8px_24px_rgba(0,0,0,0.34)] ${className}`}
      style={{ width: size, height: size }}
    >
      <img
        src={source}
        alt={alt}
        loading={loading}
        decoding="async"
        draggable="false"
        className="h-full w-full object-cover"
        onError={() => setFailed(true)}
      />
    </span>
  );
}
