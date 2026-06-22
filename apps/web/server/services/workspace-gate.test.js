import { describe, expect, it, vi } from "vitest";
import {
  blockWorkspace,
  isWorkspaceEnabled,
  WORKSPACE_UNDER_DEVELOPMENT_RESPONSE
} from "./workspace-gate.mjs";

describe("workspace gate", () => {
  it("keeps workspace disabled by default", () => {
    expect(isWorkspaceEnabled({})).toBe(false);
    expect(isWorkspaceEnabled({ WORKSPACE_ENABLED: "false" })).toBe(false);
    expect(isWorkspaceEnabled({ WORKSPACE_ENABLED: "1" })).toBe(false);
  });

  it("enables workspace only through an explicit true flag", () => {
    expect(isWorkspaceEnabled({ WORKSPACE_ENABLED: "true" })).toBe(true);
  });

  it("returns a stable under-development response", () => {
    const send = vi.fn();
    const reply = {
      code: vi.fn(() => ({ send }))
    };

    blockWorkspace(reply);

    expect(reply.code).toHaveBeenCalledWith(503);
    expect(send).toHaveBeenCalledWith(WORKSPACE_UNDER_DEVELOPMENT_RESPONSE);
  });
});
