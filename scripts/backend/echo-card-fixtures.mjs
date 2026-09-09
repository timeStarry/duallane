// Generate/check the Echo card-definition golden from the active Node runtime.
// This script invokes the registered validators and action closures themselves;
// it does not reimplement their schemas or transition targets.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

import { createEchoCardDefinitions } from "../../apps/web/server/services/echo-runtime.mjs";
import { DEFAULT_CARD_LIMITS } from "../../apps/web/server/services/workspace-cards.mjs";

const fixtureURL = new URL("../../apps/backend/internal/workspace/echo/carddefinitions/testdata/node-definitions.json", import.meta.url);
const OWNER = { id: "usr_fixture_owner", kind: "human", role: "owner" };
const MEMBER = { id: "usr_fixture_member", kind: "human", role: "member" };

const requestPayload = {
  publicId: "REQ-2026-0001",
  type: "requirement",
  title: "Synthetic Echo request",
  detail: "Synthetic private detail",
  scenario: "Synthetic scenario",
  expectedResult: "Synthetic result",
  state: "submitted",
  phase: "proposal",
  status: "pending_review",
  archiveOutcome: null,
  duplicateOfPublicId: null,
  revision: 1,
  response: null,
  createdAt: "2026-09-06T12:00:00.000Z",
  updatedAt: "2026-09-06T12:00:00.000Z"
};
const statusPayload = {
  publicId: requestPayload.publicId,
  type: requestPayload.type,
  title: requestPayload.title,
  state: requestPayload.state,
  phase: requestPayload.phase,
  status: requestPayload.status,
  revision: requestPayload.revision,
  createdAt: requestPayload.createdAt,
  updatedAt: requestPayload.updatedAt
};
const listPayload = { items: [statusPayload] };
const solicitationPayload = {
  publicId: "SOL-2026-0001",
  title: "Synthetic solicitation",
  description: "Synthetic description",
  question: "Synthetic question?",
  status: "open",
  deadline: null,
  revision: 1,
  choiceMode: "single",
  minSelections: 1,
  maxSelections: 1,
  allowVoteChange: true,
  options: [{ id: "opt-a", label: "A", position: 0, count: 0 }, { id: "opt-b", label: "B", position: 1, count: 0 }],
  selectedOptionIds: [],
  owner: true,
  voteCount: 0
};
const releasePayload = {
  version: "0.15.1",
  releasedAt: "2026-09-06",
  title: "Synthetic release",
  summary: "Synthetic summary",
  sections: [{ title: "Changes", items: [{ title: "Card definitions", description: "Synthetic description", location: "Workspace" }] }],
  publishedAt: "2026-09-06T12:34:56.789Z"
};

function definitionSummary(definition) {
  const limits = { ...DEFAULT_CARD_LIMITS, ...(definition.limits ?? {}) };
  const actions = Object.fromEntries(Object.entries(definition.actions ?? {}).map(([id, action]) => [id, {
    id,
    limits: {
      maxPayloadBytes: 16 * 1024,
      maxDepth: 6,
      maxNodes: 100,
      maxTextBytes: 8 * 1024,
      ...(action.limits ?? {})
    }
  }]));
  return {
    cardType: definition.cardType,
    schemaVersion: definition.schemaVersion,
    allowPublicUrls: definition.allowPublicUrls === true,
    limits,
    actions
  };
}

function validatorObservation(definition, name, payload) {
  try {
    return { name, cardType: definition.cardType, payload, expected: definition.validatePayload?.(structuredClone(payload)) ?? payload };
  } catch (error) {
    return { name, cardType: definition.cardType, payload, error: { code: error.code, message: error.message } };
  }
}

async function actionObservations(definitions) {
  const calls = { requirementTransition: null, requirementProjection: null, solicitationVote: null, solicitationProjection: null };
  const requirementAdapter = {
    async transition(input) {
      calls.requirementTransition = { ...input };
      return {
        ...requestPayload,
        publicId: input.publicId,
        state: "collected",
        phase: input.phase,
        status: input.status,
        revision: input.expectedRevision + 1,
        detail: "synthetic private transition detail",
        response: input.response
      };
    },
    async projectCard(input) {
      calls.requirementProjection = { ...input };
      return { payload: { ...statusPayload, state: "collected", phase: "formal", status: "planned", revision: 2, detail: "synthetic private projection" } };
    }
  };
  const solicitationAdapter = {
    async vote(input) {
      calls.solicitationVote = { ...input, optionIds: [...input.optionIds] };
      return {
        publicId: input.publicId,
        status: "open",
        revision: 2,
        selectedOptionIds: [...input.optionIds],
        counts: { "opt-a": 1, "opt-b": 0 },
        voteCount: 1,
        description: "synthetic private domain field"
      };
    },
    async projectCard(input) {
      calls.solicitationProjection = { ...input };
      return { payload: { ...solicitationPayload, revision: 2, selectedOptionIds: ["opt-a"] } };
    }
  };
  const injected = createEchoCardDefinitions({ requirements: requirementAdapter, solicitations: solicitationAdapter });
  const requirement = injected.find(({ cardType }) => cardType === "echo.request");
  const solicitation = injected.find(({ cardType }) => cardType === "echo.solicitation");
  const requirementAction = await requirement.actions.collect.execute({
    db: null,
    actor: OWNER,
    card: { spaceId: "spc_fixture", cardType: "echo.request", revision: 1 },
    payload: requestPayload,
    input: { idempotencyKey: "runtime-domain-key", response: "owner response" },
    request: { requestId: "fixture-request" }
  });
  const solicitationAction = await solicitation.actions.vote.execute({
    db: null,
    actor: MEMBER,
    card: { spaceId: "spc_fixture", cardType: "echo.solicitation", revision: 1 },
    payload: solicitationPayload,
    input: { idempotencyKey: "runtime-vote-key", optionIds: ["opt-a"] },
    request: { requestId: "fixture-request" }
  });
  return {
    requirement: {
      transition: calls.requirementTransition,
      projection: calls.requirementProjection,
      result: requirementAction.result,
      resultKeys: Object.keys(requirementAction.result).sort(),
      cardPayloadKeys: Object.keys(requirementAction.cardPayload).sort()
    },
    solicitation: {
      vote: calls.solicitationVote,
      projection: calls.solicitationProjection,
      result: solicitationAction.result,
      resultKeys: Object.keys(solicitationAction.result).sort()
    }
  };
}

const definitions = createEchoCardDefinitions();
const fixture = {
  schemaVersion: 1,
  source: {
    runtime: "apps/web/server/services/echo-runtime.mjs",
    definitions: "createEchoCardDefinitions"
  },
  definitions: definitions.map(definitionSummary),
  validation: [
    validatorObservation(definitions.find(({ cardType }) => cardType === "echo.request"), "request-valid", requestPayload),
    validatorObservation(definitions.find(({ cardType }) => cardType === "echo.request"), "request-missing-detail", { ...requestPayload, detail: "" }),
    validatorObservation(definitions.find(({ cardType }) => cardType === "echo.request-status"), "status-valid", statusPayload),
    validatorObservation(definitions.find(({ cardType }) => cardType === "echo.request-list"), "list-valid", listPayload),
    validatorObservation(definitions.find(({ cardType }) => cardType === "echo.solicitation"), "solicitation-valid", solicitationPayload),
    validatorObservation(definitions.find(({ cardType }) => cardType === "echo.solicitation"), "solicitation-missing-options", { ...solicitationPayload, options: [] }),
    validatorObservation(definitions.find(({ cardType }) => cardType === "echo.release"), "release-valid", releasePayload),
    validatorObservation(definitions.find(({ cardType }) => cardType === "echo.release"), "release-invalid-published-at", { ...releasePayload, publishedAt: "not-a-time" })
  ],
  actions: await actionObservations(definitions)
};

if (process.argv.includes("--write")) {
  await writeFile(fixtureURL, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
} else {
  assert.deepEqual(JSON.parse(await readFile(fixtureURL, "utf8")), fixture);
}
process.stdout.write(`echo-card-fixtures ${process.argv.includes("--write") ? "written" : "verified"} definitions=${fixture.definitions.length} validation=${fixture.validation.length} actions=2 PASS\n`);
