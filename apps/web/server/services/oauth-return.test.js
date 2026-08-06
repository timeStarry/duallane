import { describe, expect, it } from "vitest";
import { normalizeWorkspaceReturnTo } from "./oauth-return.mjs";

describe("Workspace OAuth return paths", () => {
  it("accepts local Workspace routes and queries", () => {
    expect(normalizeWorkspaceReturnTo("/workspace")).toBe("/workspace");
    expect(normalizeWorkspaceReturnTo("/workspace/space/email")).toBe("/workspace/space/email");
    expect(normalizeWorkspaceReturnTo("/workspace?invite=INVITE-1")).toBe("/workspace?invite=INVITE-1");
  });

  it("rejects open redirects, fragments, and encoded path confusion", () => {
    for (const value of [
      "https://example.com/workspace",
      "//example.com/workspace",
      "workspace/space",
      "/about",
      "/workspace#secret",
      "/workspace\\@example.com",
      "/workspace/%5c@example.com"
    ]) {
      expect(normalizeWorkspaceReturnTo(value)).toBe("");
    }
  });
});
