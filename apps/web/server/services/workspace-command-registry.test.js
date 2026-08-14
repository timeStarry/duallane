import { describe, expect, it } from "vitest";
import {
  createWorkspaceCommandRegistry,
  createWorkspaceWorkflowRegistry,
  WorkspaceInteractionDefinitionError
} from "./workspace-command-registry.mjs";

describe("Workspace command registry", () => {
  const definition = {
    name: "need",
    aliases: ["feedback"],
    version: 1,
    contexts: ["direct", "mention"],
    parseArguments: (source) => ({ summary: source }),
    execute: async () => ({})
  };

  it("recognizes registered commands only in Bot direct or explicit mention contexts", () => {
    const registry = createWorkspaceCommandRegistry([definition]);
    expect(registry.recognize("/need 设置页", {
      conversationType: "direct",
      botUserId: "usr_system_echo",
      mentionedBotIds: []
    })).toMatchObject({ type: "command", name: "need", arguments: { summary: "设置页" } });
    expect(registry.recognize("/feedback 通知", {
      conversationType: "group",
      botUserId: "usr_system_echo",
      mentionedBotIds: ["usr_system_echo"]
    })).toMatchObject({ type: "command", name: "need", arguments: { summary: "通知" } });
    expect(registry.recognize("/need 不应触发", {
      conversationType: "group",
      botUserId: "usr_system_echo",
      mentionedBotIds: []
    })).toBeNull();
  });

  it("keeps unknown commands distinguishable without treating ordinary text as commands", () => {
    const registry = createWorkspaceCommandRegistry([definition]);
    expect(registry.recognize(" /missing value ", { conversationType: "direct" }))
      .toEqual({ type: "unknown_command", name: "missing", rawArguments: "value" });
    expect(registry.recognize("prefix /need value", { conversationType: "direct" })).toBeNull();
    expect(registry.recognize("/need value suffix\nmore", { conversationType: "group", mentionedBotIds: [] })).toBeNull();
  });

  it("rejects duplicate aliases and dynamic non-function handlers", () => {
    expect(() => createWorkspaceCommandRegistry([
      definition,
      { name: "other", aliases: ["need"], execute: async () => ({}) }
    ])).toThrow(WorkspaceInteractionDefinitionError);
    expect(() => createWorkspaceCommandRegistry([{ name: "unsafe", execute: "eval(source)" }]))
      .toThrow(WorkspaceInteractionDefinitionError);
  });
});

describe("Workspace workflow registry", () => {
  it("registers only static versioned workflow handlers", () => {
    const registry = createWorkspaceWorkflowRegistry([{
      type: "echo.requirement",
      version: 1,
      initialize: async () => ({ step: "title" }),
      continue: async () => ({ step: "detail" })
    }]);
    expect(registry.get("echo.requirement", 1)).toMatchObject({ type: "echo.requirement", version: 1 });
    expect(registry.get("echo.requirement", 2)).toBeNull();
    expect(() => createWorkspaceWorkflowRegistry([{ type: "unsafe", initialize: "script", continue: () => ({}) }]))
      .toThrow(WorkspaceInteractionDefinitionError);
  });
});
