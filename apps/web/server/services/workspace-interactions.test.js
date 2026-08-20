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

async function fixture(options = {}) {
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
      await options.beforeContinue?.({ db, state, input });
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
    idFactory: () => `fixed_${sequence += 1}`,
    rateLimits: options.rateLimits
  });
  return {
    db,
    service,
    commandExecutions: () => commandExecutions,
    advanceTime(milliseconds) { currentTime = new Date(currentTime.getTime() + milliseconds); }
  };
}

function workflowStartInput(overrides = {}) {
  return {
    actorId: "usr_owner",
    spaceId: DEFAULT_SPACE_ID,
    conversationId: "conv_interaction_group",
    botUserId: ECHO_USER_ID,
    clientInvocationId: "workflow-start-default",
    type: "echo.test",
    input: { value: 0 },
    ...overrides
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
      clientInvocationId: "workflow-start-1",
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
      conversationId: "conv_interaction_group",
      botUserId: ECHO_USER_ID,
      clientInvocationId: "workflow-start-expiry",
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

  it("replays identical starts and rejects invocation or active-lane conflicts", async () => {
    const { service, db } = await fixture();
    const input = workflowStartInput({ clientInvocationId: "workflow-start-replay" });
    const first = await service.startWorkflow(input);
    const replay = await service.startWorkflow(input);
    expect(replay).toEqual(first);
    expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_workflow_sessions").get().count).toBe(1);

    await expect(service.startWorkflow({ ...input, input: { value: 1 } }))
      .rejects.toMatchObject({ code: "workflow.idempotency_conflict", statusCode: 409 });
    await expect(service.startWorkflow({ ...input, clientInvocationId: "workflow-start-conflict" }))
      .rejects.toMatchObject({
        code: "workflow.active_conflict",
        statusCode: 409,
        details: { activeWorkflowId: first.id }
      });
  });

  it("validates the Bot conversation binding and audits request metadata without workflow fields", async () => {
    const { service, db } = await fixture();
    const request = {
      requestId: "req-workflow-start",
      ipAddress: "192.0.2.10",
      userAgent: "workflow-test-agent"
    };
    await expect(service.startWorkflow(workflowStartInput({
      botUserId: "usr_owner",
      clientInvocationId: "workflow-wrong-bot",
      input: { value: 7, privateBody: "must-not-enter-audit" },
      request
    }))).rejects.toMatchObject({ code: "bot.not_available" });

    const rejectedAudit = db.prepare(`
      SELECT action, result, reason, request_id AS requestId, ip_address AS ipAddress,
        user_agent AS userAgent
      FROM audit_logs WHERE action = 'workflow.start' ORDER BY created_at DESC LIMIT 1
    `).get();
    expect(rejectedAudit).toEqual({
      action: "workflow.start",
      result: "rejected",
      reason: "bot.not_available",
      requestId: request.requestId,
      ipAddress: request.ipAddress,
      userAgent: request.userAgent
    });
    expect(JSON.stringify(db.prepare("SELECT * FROM audit_logs WHERE request_id = ?").all(request.requestId)))
      .not.toContain("must-not-enter-audit");
  });

  it("cancels the current Bot-conversation workflow without an ID and reports missing or ambiguous state", async () => {
    const { service, db } = await fixture();
    const started = await service.startWorkflow(workflowStartInput({ clientInvocationId: "workflow-cancel-current" }));
    const context = {
      spaceId: DEFAULT_SPACE_ID,
      conversationId: "conv_interaction_group",
      botUserId: ECHO_USER_ID,
      request: { requestId: "req-cancel-current" }
    };
    await expect(service.cancelWorkflow("usr_owner", context)).resolves.toMatchObject({
      id: started.id,
      status: "cancelled",
      revision: 2
    });
    expect(db.prepare(`
      SELECT action, result, request_id AS requestId FROM audit_logs
      WHERE request_id = 'req-cancel-current'
    `).get()).toEqual({ action: "workflow.cancel", result: "success", requestId: "req-cancel-current" });
    await expect(service.cancelWorkflow("usr_owner", context))
      .rejects.toMatchObject({ code: "workflow.active_not_found", statusCode: 404 });

    db.exec("DROP INDEX workspace_workflows_foreground_active_unique");
    const timestamp = new Date("2026-08-14T00:01:00.000Z").toISOString();
    for (const id of ["wf_ambiguous_1", "wf_ambiguous_2"]) {
      db.prepare(`
        INSERT INTO workspace_workflow_sessions (
          id, space_id, conversation_id, actor_user_id, bot_user_id, workflow_type, workflow_version,
          state_json, status, revision, expires_at, created_at, updated_at
        ) VALUES (?, ?, 'conv_interaction_group', 'usr_owner', ?, 'echo.test', 1,
          '{"value":0}', 'active', 1, ?, ?, ?)
      `).run(id, DEFAULT_SPACE_ID, ECHO_USER_ID, "2026-08-14T01:00:00.000Z", timestamp, timestamp);
    }
    await expect(service.cancelWorkflow("usr_owner", context))
      .rejects.toMatchObject({ code: "workflow.active_ambiguous", statusCode: 409 });
  });

  it("persists command and workflow rate limits and audits rate-limit rejection", async () => {
    const { service, db } = await fixture({
      rateLimits: { command: 1, workflowStart: 1, workflowContinue: 1, workflowCancel: 1 }
    });
    const command = {
      actorId: "usr_owner",
      spaceId: DEFAULT_SPACE_ID,
      conversationId: "conv_interaction_group",
      botUserId: ECHO_USER_ID,
      source: "/ping first",
      mentionedBotIds: [ECHO_USER_ID],
      request: { requestId: "req-command-rate" }
    };
    await service.executeCommand({ ...command, clientInvocationId: "rate-command-1" });
    await expect(service.executeCommand({ ...command, clientInvocationId: "rate-command-2" }))
      .rejects.toMatchObject({ code: "interaction.rate_limited", statusCode: 429 });

    const started = await service.startWorkflow(workflowStartInput({ clientInvocationId: "rate-workflow-start-1" }));
    await service.continueWorkflow("usr_owner", {
      workflowId: started.id,
      expectedRevision: 1,
      input: { increment: 1 },
      request: { requestId: "req-workflow-continue-1" }
    });
    await expect(service.continueWorkflow("usr_owner", {
      workflowId: started.id,
      expectedRevision: 2,
      input: { increment: 0 },
      request: { requestId: "req-workflow-continue-rate" }
    })).rejects.toMatchObject({ code: "interaction.rate_limited", statusCode: 429 });

    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM workspace_interaction_rate_limits
      WHERE actor_user_id = 'usr_owner'
    `).get().count).toBeGreaterThanOrEqual(3);
    expect(db.prepare(`
      SELECT result, reason, request_id AS requestId FROM audit_logs
      WHERE request_id = 'req-workflow-continue-rate'
    `).get()).toEqual({ result: "rejected", reason: "interaction.rate_limited", requestId: "req-workflow-continue-rate" });
  });

  it("returns a stable conflict when cancellation wins the final-step CAS", async () => {
    let mutate = true;
    const { service, db } = await fixture({
      async beforeContinue({ db: workflowDb }) {
        if (!mutate) return;
        mutate = false;
        workflowDb.prepare(`
          UPDATE workspace_workflow_sessions
          SET status = 'cancelled', revision = revision + 1
          WHERE id = 'wf_fixed_1' AND status = 'active'
        `).run();
      }
    });
    const started = await service.startWorkflow(workflowStartInput({ clientInvocationId: "workflow-final-race" }));
    await expect(service.continueWorkflow("usr_owner", {
      workflowId: started.id,
      expectedRevision: 1,
      input: { increment: 2 }
    })).rejects.toMatchObject({ code: "workflow.race_conflict", statusCode: 409 });
    expect(db.prepare("SELECT status, revision FROM workspace_workflow_sessions WHERE id = ?").get(started.id))
      .toEqual({ status: "cancelled", revision: 2 });
  });

  it("allows only one of two concurrent continues to advance a revision", async () => {
    const { service, db } = await fixture();
    const started = await service.startWorkflow(workflowStartInput({ clientInvocationId: "workflow-concurrent-continue" }));
    const results = await Promise.allSettled([
      service.continueWorkflow("usr_owner", { workflowId: started.id, expectedRevision: 1, input: { increment: 1 } }),
      service.continueWorkflow("usr_owner", { workflowId: started.id, expectedRevision: 1, input: { increment: 1 } })
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")?.reason)
      .toMatchObject({ code: expect.stringMatching(/^workflow\.(stale_revision|race_conflict)$/), statusCode: 409 });
    expect(db.prepare("SELECT status, revision FROM workspace_workflow_sessions WHERE id = ?").get(started.id))
      .toEqual({ status: "active", revision: 2 });
  });
});
