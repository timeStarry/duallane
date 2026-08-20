import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openTestDatabase } from "./test-database.mjs";
import {
  ECHO_COMMAND_NAMES,
  createEchoCommandDefinitions,
  createEchoRuntime
} from "./echo-runtime.mjs";

const fixtures = [];
const now = new Date("2026-08-14T00:00:00.000Z");

async function fixture(runtimeOptions = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "duallane-echo-runtime-"));
  const db = openTestDatabase(directory);
  const timestamp = now.toISOString();
  for (const [id, role] of [["usr_runtime_member", "member"], ["usr_runtime_auditor", "auditor"]]) {
    db.prepare(`
      INSERT INTO users (id, github_id, github_login, email, display_name, avatar_url, kind, created_at, last_login_at)
      VALUES (?, ?, ?, ?, ?, NULL, 'human', ?, NULL)
    `).run(id, `${id}-github`, id, `${id}@example.com`, id, timestamp);
    db.prepare(`
      INSERT INTO space_members (space_id, user_id, role, joined_at, removed_at)
      VALUES ('spc_default', ?, ?, ?, NULL)
    `).run(id, role, timestamp);
  }
  const runtime = createEchoRuntime({ db, now: () => now, ...runtimeOptions });
  fixtures.push({ db, directory });
  return { db, runtime };
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.db.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

async function submit(runtime, actorId = "usr_runtime_member", suffix = "a") {
  return runtime.requirements.submit({
    actorId,
    type: "requirement",
    title: `Runtime ${suffix}`,
    detail: "仅用于运行时动作测试。",
    scenario: "验证统一服务",
    expectedResult: "命令和卡片动作状态一致",
    idempotencyKey: `submit-${suffix}`
  });
}

async function createRequirementCard(runtime, requirement) {
  const projected = await runtime.requirements.projectCard({ actorId: "usr_owner", publicId: requirement.publicId });
  return runtime.cardInteractionService.createCard({
    spaceId: "spc_default",
    cardType: projected.block.cardType,
    schemaVersion: projected.block.schemaVersion,
    fallbackText: projected.block.fallbackText,
    payload: projected.payload,
    sourceKind: "echo",
    sourceId: requirement.publicId,
    visibilityScope: "space",
    createdByUserId: "usr_owner"
  });
}

describe("Echo runtime registration", () => {
  it("registers every command and revisioned guided workflow", () => {
    const runtime = createEchoRuntime({ createInteractionService: false, createCardInteractionService: false });
    expect(ECHO_COMMAND_NAMES.every((name) => runtime.commandRegistry.get(name))).toBe(true);
    expect(runtime.commandRegistry.get("feedback").name).toBe("feedback");
    expect(runtime.commandRegistry.recognize("/release v0.15.1", { conversationType: "direct" }).arguments)
      .toEqual({ version: "0.15.1" });
    expect(runtime.commandRegistry.recognize("/feedback", { conversationType: "direct" }).arguments)
      .toMatchObject({ type: "problem" });
    expect(runtime.workflowRegistry.get("echo.publish", 1)).toBeTruthy();
    expect(runtime.workflowRegistry.get("echo.requirement", 1)).toBeTruthy();
    expect(runtime.cardRegistry.get("echo.solicitation", 1).actions).toHaveProperty("vote");
    expect(runtime.cardRegistry.get("echo.request", 1).actions).toMatchObject({
      collect: expect.any(Object),
      start: expect.any(Object),
      progress: expect.any(Object),
      implement: expect.any(Object),
      reject: expect.any(Object),
      duplicate: expect.any(Object)
    });
    expect(runtime.cardRegistry.get("echo.release", 1)).toBeTruthy();
  });

  it("publishes a registered release through the owner-only command and reports delivery progress", async () => {
    const calls = [];
    const definitions = createEchoCommandDefinitions({
      releases: {
        async publish(input) {
          calls.push({ type: "publish", input });
          return { version: "0.15.1", title: "更新", recipientCount: 3, sentCount: 0, failedCount: 0, skippedCount: 0, replayed: false };
        }
      },
      deliveryService: {
        async syncRelease(input) {
          calls.push({ type: "deliver", input });
          return { sent: 2, failed: 1, skipped: 0 };
        }
      }
    });
    const release = definitions.find((definition) => definition.name === "release");
    expect(release.authorize({ actor: { role: "owner" } })).toBe(true);
    expect(release.authorize({ actor: { role: "member" } })).toBe(false);
    await expect(release.execute({
      actor: { id: "usr_owner", role: "owner" },
      arguments: { version: "0.15.1" },
      request: { requestId: "req-release-command" }
    })).resolves.toEqual({
      result: {
        type: "release-published",
        version: "0.15.1",
        title: "更新",
        recipientCount: 3,
        sentCount: 2,
        failedCount: 1,
        skippedCount: 0,
        pendingCount: 0,
        replayed: false
      }
    });
    expect(calls).toHaveLength(2);
  });

  it("resolves /cancel against the current Bot conversation when no workflow ID is provided", async () => {
    const calls = [];
    const definitions = createEchoCommandDefinitions({
      getInteractionService: () => ({
        async cancelWorkflow(actorId, input) {
          calls.push({ actorId, input });
          return { id: "wf_current", status: "cancelled", revision: 2 };
        }
      })
    });
    const cancel = definitions.find((definition) => definition.name === "cancel");
    await expect(cancel.execute({
      actor: { id: "usr_runtime_member" },
      context: { id: "conv_echo", spaceId: "spc_default", type: "direct" },
      botUserId: "usr_system_echo",
      arguments: { workflowId: null },
      request: { requestId: "req-echo-cancel" }
    })).resolves.toMatchObject({
      result: { type: "workflow.cancelled", workflowId: "wf_current", cancelled: true }
    });
    expect(calls).toEqual([{
      actorId: "usr_runtime_member",
      input: {
        workflowId: null,
        spaceId: "spc_default",
        conversationId: "conv_echo",
        botUserId: "usr_system_echo",
        request: { requestId: "req-echo-cancel" }
      }
    }]);
  });
});

describe("Echo runtime domain/action equivalence", () => {
  it("uses the same transition service for commands and card actions, with action replay", async () => {
    const { runtime } = await fixture();
    const commandRequirement = await submit(runtime, "usr_runtime_member", "command");
    const collect = runtime.commandRegistry.get("collect");
    const commandResult = await collect.execute({
      actor: { id: "usr_owner", kind: "human", role: "owner" },
      arguments: { publicId: commandRequirement.publicId },
      clientInvocationId: "command-collect-1"
    });
    expect(commandResult.result).toMatchObject({ status: "planned", phase: "formal", revision: 2 });

    const cardRequirement = await submit(runtime, "usr_runtime_member", "card");
    const card = await createRequirementCard(runtime, cardRequirement);
    const actionInput = {
      cardId: card.block.cardId,
      actionId: "collect",
      expectedRevision: 1,
      clientActionId: "card-collect-1",
      input: {}
    };
    const first = await runtime.executeCardAction("usr_owner", actionInput);
    const replay = await runtime.executeCardAction("usr_owner", actionInput);
    expect(first).toMatchObject({ ok: true, replayed: false, revision: 2, result: { status: "planned", phase: "formal" } });
    expect(replay).toMatchObject({ ok: true, replayed: true, revision: 2, result: { status: "planned", phase: "formal" } });
    await expect(runtime.executeCardAction("usr_owner", { ...actionInput, input: { response: "不同说明" } }))
      .rejects.toMatchObject({ code: "card.idempotency_conflict" });
  });

  it("injects card idempotency and delivers only after the card commit", async () => {
    let cardId = null;
    const deliveries = [];
    const { runtime, db } = await fixture({
      deliveryService: {
        async syncRequirement(input) {
          const card = cardId
            ? db.prepare("SELECT revision FROM workspace_cards WHERE id = ?").get(cardId)
            : null;
          deliveries.push({ ...input, cardRevision: Number(card?.revision ?? 0) });
        }
      }
    });
    const requirement = await submit(runtime, "usr_runtime_member", "delivery");
    const card = await createRequirementCard(runtime, requirement);
    cardId = card.block.cardId;
    // Submission delivery is a separate domain hook; this assertion covers
    // only the action delivery path under test.
    deliveries.splice(0);

    const actionInput = {
      cardId,
      actionId: "collect",
      expectedRevision: 1,
      clientActionId: "card-delivery-1",
      input: {}
    };
    const first = await runtime.cardInteractionService.executeAction("usr_owner", actionInput);
    expect(first).toMatchObject({ ok: true, replayed: false, revision: 2 });
    expect(deliveries).toEqual([{
      publicId: requirement.publicId,
      actorUserId: "usr_owner",
      cardRevision: 2
    }]);

    const replay = await runtime.cardInteractionService.executeAction("usr_owner", actionInput);
    expect(replay).toMatchObject({ ok: true, replayed: true, revision: 2 });
    expect(deliveries).toHaveLength(1);
  });

  it("denies auditors before persistence and records duplicate_proposal without private text", async () => {
    const { runtime, db } = await fixture();
    const auditorCommand = runtime.commandRegistry.get("need");
    expect(auditorCommand.authorize({ actor: { role: "auditor" } })).toBe(false);
    await expect(runtime.requirements.submit({
      actorId: "usr_runtime_auditor",
      type: "requirement",
      title: "不应落库",
      detail: "敏感正文",
      scenario: "auditor",
      expectedResult: "拒绝",
      idempotencyKey: "auditor-runtime"
    })).rejects.toMatchObject({ code: "echo.permission_denied", statusCode: 403 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM echo_requirements WHERE submitter_user_id = 'usr_runtime_auditor'").get().count).toBe(0);
    expect(JSON.stringify(db.prepare("SELECT reason FROM audit_logs WHERE action = 'echo.requirement.submit'").all())).not.toContain("敏感正文");

    const primary = await submit(runtime, "usr_runtime_member", "primary");
    const duplicate = await submit(runtime, "usr_runtime_member", "duplicate");
    const card = await createRequirementCard(runtime, duplicate);
    await runtime.executeCardAction("usr_owner", {
      cardId: card.block.cardId,
      actionId: "duplicate",
      expectedRevision: 1,
      clientActionId: "duplicate-action-1",
      input: { duplicateOfPublicId: primary.publicId }
    });
    expect(db.prepare("SELECT phase, status, archive_outcome AS archiveOutcome FROM echo_requirements WHERE public_id = ?").get(duplicate.publicId))
      .toEqual({ phase: "archived", status: "archived", archiveOutcome: "duplicate" });
    expect(db.prepare("SELECT reason FROM audit_logs WHERE action = 'echo.requirement.transition' AND target_id = ? ORDER BY created_at DESC LIMIT 1").get(duplicate.publicId).reason)
      .toBe("duplicate_proposal");
  });
});
