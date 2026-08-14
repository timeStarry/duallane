import { describe, expect, it } from "vitest";
import { createWorkspaceCardRegistry } from "./workspace-card-registry.mjs";

describe("workspace card registry", () => {
  it("registers topic creation and synced-message card definitions", () => {
    const registry = createWorkspaceCardRegistry();
    expect(registry.get("workspace.topic-created", 1)).toMatchObject({
      cardType: "workspace.topic-created",
      schemaVersion: 1
    });
    expect(registry.get("workspace.topic-message-synced", 1)).toMatchObject({
      cardType: "workspace.topic-message-synced",
      schemaVersion: 1
    });
  });
});
