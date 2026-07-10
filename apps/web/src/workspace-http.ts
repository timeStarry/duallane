export function createWorkspaceJsonHeaders(options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  if (options.body !== undefined && options.body !== null && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return headers;
}
