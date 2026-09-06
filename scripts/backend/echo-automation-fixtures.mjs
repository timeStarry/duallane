// Characterize the active Node Echo command/workflow definitions for the Go
// automation slice. This fixture uses only synthetic in-memory domain ports;
// it never opens the application database or sends an external notification.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  ECHO_COMMAND_NAMES,
  ECHO_WORKFLOW_TYPES,
  createEchoCommandDefinitions,
  createEchoWorkflowDefinitions
} from "../../apps/web/server/services/echo-runtime.mjs";
import { ECHO_USER_ID } from "../../apps/web/server/services/echo-identity.mjs";

const OWNER = { id: "usr_owner", role: "owner" };
const MEMBER = { id: "usr_member", role: "member" };
const AUDITOR = { id: "usr_auditor", role: "auditor" };

function requirementResult(publicId) {
  return {
    publicId,
    state: "submitted",
    phase: "proposal",
    status: "pending_review",
    archiveOutcome: null,
    duplicateOfPublicId: null,
    revision: 1
  };
}

function solicitationResult(publicId, status, revision) {
  return {
    publicId,
    status,
    revision,
    options: [{ id: "opt-a", label: "A", position: 0 }],
    selectedOptionIds: [],
    counts: { "opt-a": 0 },
    voteCount: 0
  };
}

function createRequirementPort() {
  const records = new Map();
  const port = {
    calls: 0,
    writes: 0,
    async submit(input) {
      port.calls += 1;
      const existing = records.get(input.idempotencyKey);
      if (existing) return existing;
      const result = requirementResult(`REQ-2026-${String(records.size + 1).padStart(4, "0")}`);
      records.set(input.idempotencyKey, result);
      port.writes += 1;
      return result;
    }
  };
  return port;
}

function createSolicitationPort({ failPublish = false } = {}) {
  const drafts = new Map();
  const published = new Map();
  const port = {
    drafts,
    published,
    createCalls: 0,
    createWrites: 0,
    publishCalls: 0,
    publishWrites: 0,
    async create(input) {
      port.createCalls += 1;
      const existing = drafts.get(input.idempotencyKey);
      if (existing) return existing;
      const result = {
        publicId: `SOL-2026-${String(drafts.size + 1).padStart(4, "0")}`,
        status: "draft",
        revision: 1,
        options: [{ id: "opt-a", label: "A", position: 0 }]
      };
      drafts.set(input.idempotencyKey, result);
      port.createWrites += 1;
      return result;
    },
    async publish(input) {
      port.publishCalls += 1;
      if (failPublish) {
        const error = new Error("synthetic publish failure");
        error.code = "echo.solicitation_publish_failed";
        throw error;
      }
      const existing = published.get(input.idempotencyKey);
      if (existing) return existing;
      const result = solicitationResult("SOL-2026-0001", "open", 2);
      published.set(input.idempotencyKey, result);
      port.publishWrites += 1;
      return result;
    }
  };
  return port;
}

async function characterizeAutomation() {
  const requirementPort = createRequirementPort();
  const solicitationPort = createSolicitationPort();
  const releasePort = {
    async publish(input) {
      return {
        version: input.version,
        title: "Synthetic release",
        recipientCount: 2,
        sentCount: 0,
        failedCount: 0,
        skippedCount: 0,
        replayed: false
      };
    }
  };
  const commands = createEchoCommandDefinitions({
    requirements: { listPage: async () => ({ items: [], total: 0, pageInfo: { offset: 0, limit: 100, hasNext: false, nextOffset: null } }), get: async () => requirementResult("REQ-2026-0001") },
    solicitations: solicitationPort,
    releases: releasePort
  });
  const commandByName = new Map(commands.map((definition) => [definition.name, definition]));
  assert.deepEqual(commands.map((definition) => definition.name), ECHO_COMMAND_NAMES);

  const help = await commandByName.get("help").execute({});
  assert.deepEqual(help.result.commands, ECHO_COMMAND_NAMES.map((name) => `/${name}`));
  assert.equal(help.result.botUserId, ECHO_USER_ID);
  const releaseResult = await commandByName.get("release").execute({
    actor: OWNER,
    arguments: { version: "0.15.1" },
    request: {}
  });
  assert.equal(releaseResult.result.type, "release-published");
  assert.equal(commandByName.get("release").authorize({ actor: OWNER }), true);
  assert.equal(commandByName.get("release").authorize({ actor: MEMBER }), false);
  assert.equal(commandByName.get("need").authorize({ actor: AUDITOR }), false);
  assert.equal(commandByName.get("need").authorize({ actor: MEMBER }), true);
  assert.equal(commandByName.has("idea"), false);
  assert.equal(commandByName.has("requirements"), false);
  assert.equal(commandByName.has("solicitations"), false);

  const workflows = createEchoWorkflowDefinitions({ requirements: requirementPort, solicitations: solicitationPort });
  const requirementWorkflow = workflows.find(({ type }) => type === ECHO_WORKFLOW_TYPES.requirement);
  const publishWorkflow = workflows.find(({ type }) => type === ECHO_WORKFLOW_TYPES.publish);
  const requirementStart = requirementWorkflow.initialize({ input: {} });
  assert.equal(requirementStart.state.step, "title");
  const requirementInput = {
    type: "requirement",
    title: "Synthetic title",
    detail: "Synthetic detail",
    scenario: "Synthetic scenario",
    expectedResult: "Synthetic result",
    confirm: true,
    idempotencyKey: "automation-requirement-1"
  };
  const requirementWorkflowValue = { id: "wf-requirement", revision: 1 };
  const requirementStep = await requirementWorkflow.continue({
    actor: MEMBER,
    workflow: requirementWorkflowValue,
    state: requirementStart.state,
    input: { title: "Synthetic title" },
    request: {}
  });
  const requirementResults = await Promise.all([
    requirementWorkflow.continue({ actor: MEMBER, workflow: requirementWorkflowValue, state: requirementStart.state, input: requirementInput, request: {} }),
    requirementWorkflow.continue({ actor: MEMBER, workflow: requirementWorkflowValue, state: requirementStart.state, input: requirementInput, request: {} })
  ]);
  assert.deepEqual(requirementResults[0], requirementResults[1]);
  assert.equal(requirementPort.writes, 1);

  const publishStart = publishWorkflow.initialize({ input: { title: "T", description: "D", question: "Q", options: ["A"] } });
  const publishStep = await publishWorkflow.continue({
    actor: OWNER,
    workflow: { id: "wf-publish-step", revision: 1 },
    state: publishStart.state,
    input: {}
  });
  const publishInput = { confirm: true, idempotencyKey: "automation-publish-1" };
  const publishWorkflowValue = { id: "wf-publish", revision: 1 };
  const publishResults = await Promise.all([
    publishWorkflow.continue({ actor: OWNER, workflow: publishWorkflowValue, state: publishStart.state, input: publishInput }),
    publishWorkflow.continue({ actor: OWNER, workflow: publishWorkflowValue, state: publishStart.state, input: publishInput })
  ]);
  assert.deepEqual(publishResults[0], publishResults[1]);
  assert.equal(solicitationPort.createWrites, 1);
  assert.equal(solicitationPort.publishWrites, 1);

  const faultPort = createSolicitationPort({ failPublish: true });
  const faultWorkflow = createEchoWorkflowDefinitions({ solicitations: faultPort }).find(({ type }) => type === ECHO_WORKFLOW_TYPES.publish);
  await assert.rejects(
    faultWorkflow.continue({ actor: OWNER, workflow: publishWorkflowValue, state: publishStart.state, input: publishInput }),
    (error) => error?.code === "echo.solicitation_publish_failed"
  );
  // Node's two service calls are not an InTx bridge. This is an explicit
  // characterization for the Go savepoint adapter, not a claim of Node
  // atomicity: a parent transaction must remove this draft on failure.
  assert.equal(faultPort.drafts.size, 1);

  return {
    commandInventory: ECHO_COMMAND_NAMES,
    helpCommands: help.result.commands,
    helpResult: help.result,
    unknownResourceNames: ["idea", "requirements", "solicitations"].filter((name) => !commandByName.has(name)),
    authorization: { ownerRelease: true, memberRelease: false, auditorNeed: false, memberNeed: true },
    workflow: {
      initialization: {
        requirement: requirementStart,
        publish: publishStart
      },
      steps: {
        requirementPartial: requirementStep,
        publishPartial: publishStep
      },
      requirementConcurrentSame: true,
      requirementWrites: requirementPort.writes,
      solicitationConcurrentSame: true,
      solicitationCreateWrites: solicitationPort.createWrites,
      solicitationPublishWrites: solicitationPort.publishWrites,
      faultDraftsAfterPublishFailure: faultPort.drafts.size,
      faultRequiresSharedTxRollback: true
    }
  };
}

const result = await characterizeAutomation();
if (process.argv.includes("--check")) {
  const expected = JSON.parse(await readFile(new URL("../../apps/backend/internal/workspace/echo/automation/testdata/node-runtime.json", import.meta.url), "utf8"));
  assert.deepEqual(result, expected);
  process.stdout.write("Echo automation Node fixtures passed\n");
} else {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
