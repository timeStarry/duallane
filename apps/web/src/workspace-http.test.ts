import { describe, expect, it } from "vitest";
import { createWorkspaceJsonHeaders } from "./workspace-http";

describe("workspace HTTP headers", () => {
  it("does not declare JSON when a request has no body", () => {
    expect(createWorkspaceJsonHeaders({ method: "POST" }).has("content-type")).toBe(false);
    expect(createWorkspaceJsonHeaders({ method: "DELETE", body: null }).has("content-type")).toBe(false);
  });

  it("declares JSON for request bodies and preserves explicit content types", () => {
    const jsonHeaders = createWorkspaceJsonHeaders({
      method: "POST",
      body: JSON.stringify({ ok: true })
    });
    expect(jsonHeaders.get("content-type")).toBe("application/json");

    const customHeaders = createWorkspaceJsonHeaders({
      method: "POST",
      body: "payload",
      headers: { "content-type": "application/merge-patch+json" }
    });
    expect(customHeaders.get("content-type")).toBe("application/merge-patch+json");
  });
});
