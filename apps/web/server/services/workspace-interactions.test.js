import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SPACE_ID } from "./db.mjs";
import { ECHO_USER_ID } from "./echo-identity.mjs";
import { openTestDatabase } from "./test-database.mjs";
import {
  createWorkspaceCommandRegistry,
  createWorkspaceWorkflowRegistry
} from "./workspace-command-registry.mjs";
import { createWorkspaceInteractionService } from "./workspace-interactions.mjs";

const cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(async ({ db, directory }) => {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }));
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "duallane-interactions-"));
  const db = openTestDatabase(directory);
  cleanups.push({ db, directory });
  const createdAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO conversations (id, space_id, type, title, direct_key, retention_count, created_by, created_at)
    VALUES ('conv_interaction_group', ?, 'group', 'Commands', NULL, 10000, 'usr_owner', ?)
  `).run(DEFAULT_SPACE_ID, createdAt);
  for (const userId of ["usr_owner", ECHO_USER_ID]) {
    db.prepare(`
      INSERT INTO conversation_members (conversation_id, user_id, joined_at, removed_at)
      VALUES ('conv_interaction_group', ?, ?, NULL)
    `).run(userId, createdAt);
  }
  let commandExecutions = 0;
  const commandRegistry = createWorkspaceCommandRegistry([{
    name: "ping",
    version: 1,
    contexts: ["direct", "mention"],
    parseArguments: (text) => ({ text }),
    async execute({ arguments: args }) {
      commandExecutions += 1;
      return { result: { reply: `pong:${args.text}` } };
    }
  }]);
  const workflowRegistry = createWorkspaceWorkflowRegistry([{
    type: "echo.test",
    version: 1,
    async initialize({ input }) {
      return { state: { value: Number(input.value ?? 0) } };
    },
    validateState(state) {
      if (!Number.isSafeInteger(state.value)) throw new Error("invalid state");
      return state;
    },
    async continue({ state, input }) {
      const value = state.value + Number(input.increment ?? 1);
      return { state: { value }, status: value >= 2 ? "completed" : "active", result: { value } };
    }
  }]);
  let sequence = 0;
  let currentTime = new Date("2026-08-14T00:00:00.000Z");
  const service = createWorkspaceInteractionService({
    db,
    commandRegistry,
    workflowRegistry,
    now: () => currentTime,
    idFactory: () => `fixed_${sequence += 1}`
  });
  return {
    db,
    service,
    commandExecutions: () => commandExecutions,
    advanceTime(milliseconds) { currentTime = new Date(currentTime.getTime() + milliseconds); }
  };
}

describe("Workspace registered command execution", () => {
  it("requires explicit Bot mentions in groups and replays identical invocations", async () => {
    const { service, commandExecutions, db } = await fixture();
    const base = {
      actorId: "usr_owner",
      spaceId: DEFAULT_SPACE_ID,
      conversationId: "conv_interaction_group",
      botUserId: ECHO_USER_ID,
      source: "/ping hello",
      clientInvocationId: "invoke-1"
    };
    await expect(service.executeCommand({ ...base, mentionedBotIds: [] }))
      .rejects.toMatchObject({ code: "command.not_triggered" });
    await expect(service.executeCommand({ ...base, mentionedBotIds: [ECHO_USER_ID] })).resolves.toEqual({
      ok: true,
      replayed: false,
      result: { reply: "pong:hello" },
      resultCardId: null
    });
    await expect(service.executeCommand({ ...base, mentionedBotIds: [ECHO_USER_ID] })).resolves.toMatchObject({
      ok: true,
      replayed: true,
      result: { reply: "pong:hello" }
    });
    expect(commandExecutions()).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_command_runs").get().count).toBe(1);
    await expect(service.executeCommand({ ...base, source: "/ping changed", mentionedBotIds: [ECHO_USER_ID] }))
      .rejects.toMatchObject({ code: "command.idempotency_conflict" });
  });
});

describe("Workspace guided workflow persistence", () => {
  it("persists revisions, rejects stale updates, and completes deterministically", async () => {
    const { service } = await fixture();
    const started = await service.startWorkflow({
      actorId: "usr_owner",
      spaceId: DEFAULT_SPACE_ID,
      conversationId: "conv_interaction_group",
      botUserId: ECHO_USER_ID,
      type: "echo.test",
      input: { value: 0 }
    });
    expect(started).toMatchObject({ type: "echo.test", status: "active", revision: 1, state: { value: 0 } });
    const first = await service.continueWorkflow("usr_owner", {
      workflowId: started.id,
      expectedRevision: 1,
      input: { increment: 1 }
    });
    expect(first).toMatchObject({ workflow: { status: "active", revision: 2, state: { value: 1 } }, result: { value: 1 } });
    await expect(service.continueWorkflow("usr_owner", {
      workflowId: started.id,
      expectedRevision: 1,
      input: { increment: 1 }
    })).rejects.toMatchObject({ code: "workflow.stale_revision" });
    const completed = await service.continueWorkflow("usr_owner", {
      workflowId: started.id,
      expectedRevision: 2,
      input: { increment: 1 }
    });
    expect(completed.workflow).toMatchObject({ status: "completed", revision: 3, state: { value: 2 } });
    await expect(service.continueWorkflow("usr_owner", {
      workflowId: started.id,
      expectedRevision: 3,
      input: {}
    })).rejects.toMatchObject({ code: "workflow.not_active" });
  });

  it("expires active workflows and hides other users' sessions", async () => {
    const { service, advanceTime } = await fixture();
    const started = await service.startWorkflow({
      actorId: "usr_owner",
      spaceId: DEFAULT_SPACE_ID,
      type: "echo.test",
      ttlMs: 60_000,
      input: {}
    });
    await expect(service.getWorkflow("missing-user", started.id)).rejects.toMatchObject({ code: "permission.denied" });
    advanceTime(60_001);
    await expect(service.continueWorkflow("usr_owner", {
      workflowId: started.id,
      expectedRevision: 1,
      input: {}
    })).rejects.toMatchObject({ code: "workflow.expired" });
  });
});
