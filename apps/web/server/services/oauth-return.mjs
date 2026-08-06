export function normalizeWorkspaceReturnTo(value) {
  const candidate = typeof value === "string" ? value.trim() : "";
  if (!candidate.startsWith("/") || candidate.startsWith("//") || candidate.includes("\\") || candidate.includes("#") || /[\u0000-\u001f\u007f]/.test(candidate)) {
    return "";
  }

  try {
    const base = new URL("https://duallane.invalid");
    const url = new URL(candidate, base);
    const decodedPath = decodeURIComponent(url.pathname);
    if (
      url.origin !== base.origin ||
      decodedPath.includes("\\") ||
      /[\u0000-\u001f\u007f]/.test(decodedPath) ||
      (url.pathname !== "/workspace" && !url.pathname.startsWith("/workspace/"))
    ) {
      return "";
    }
    return `${url.pathname}${url.search}`;
  } catch {
    return "";
  }
}
