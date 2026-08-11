import { useEffect, useState } from "react";

type WorkspaceAvatarProps = {
  name: string;
  avatarUrl?: string | null;
  className?: string;
  decorative?: boolean;
};

export function sanitizeWorkspaceAvatarUrl(value?: string | null) {
  if (!value) {
    return "";
  }
  const candidate = value.trim();
  if (/^\/assets\/[a-z0-9][a-z0-9._/-]*$/i.test(candidate) && !candidate.includes("..")) {
    return candidate;
  }
  if (/^\/api\/workspace\/avatars\/[a-z0-9_-]+\/[a-z0-9-]+$/i.test(candidate)) {
    return candidate;
  }
  try {
    const url = new URL(candidate);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "avatars.githubusercontent.com" ||
      url.username ||
      url.password ||
      url.port
    ) {
      return "";
    }
    return url.href;
  } catch {
    return "";
  }
}

export function workspaceAvatarInitial(name: string) {
  return Array.from(name.trim())[0]?.toUpperCase() || "?";
}

export function getWorkspaceAvatarAttemptUrl(value: string, retryToken: string) {
  if (!retryToken || !value.startsWith("/api/workspace/avatars/")) {
    return value;
  }
  return `${value}?retry=${encodeURIComponent(retryToken)}`;
}

export function WorkspaceAvatar({
  name,
  avatarUrl,
  className = "",
  decorative = false
}: WorkspaceAvatarProps) {
  const safeAvatarUrl = sanitizeWorkspaceAvatarUrl(avatarUrl);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [retryToken, setRetryToken] = useState("");

  useEffect(() => {
    setLoadAttempt(0);
    setRetryToken("");
  }, [safeAvatarUrl]);

  const displayAvatarUrl = getWorkspaceAvatarAttemptUrl(safeAvatarUrl, retryToken);
  const failed = loadAttempt > 1;

  const labelProps = decorative
    ? { "aria-hidden": true as const }
    : { "aria-label": `${name} 的头像`, role: "img" };

  return (
    <span className={`workspace-avatar ${className}`.trim()} {...labelProps}>
      {safeAvatarUrl && !failed ? (
        <img
          key={displayAvatarUrl}
          alt=""
          decoding="async"
          loading="lazy"
          referrerPolicy="no-referrer"
          src={displayAvatarUrl}
          onError={() => {
            if (loadAttempt === 0 && safeAvatarUrl.startsWith("/api/workspace/avatars/")) {
              setRetryToken(`${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
              setLoadAttempt(1);
              return;
            }
            setLoadAttempt(2);
          }}
        />
      ) : (
        workspaceAvatarInitial(name)
      )}
    </span>
  );
}
