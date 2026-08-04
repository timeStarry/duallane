export function sanitizeGitHubAvatarUrl(value) {
  const candidate = typeof value === "string" ? value.trim() : "";
  if (!candidate) {
    return "";
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