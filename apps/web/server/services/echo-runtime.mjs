import { ECHO_USER_ID } from "./echo-identity.mjs";
import {
  ECHO_REQUIREMENT_CARD_DEFINITIONS,
  createEchoRequirementCardActions,
  createEchoRequirementService
} from "./echo-requirements.mjs";
import {
  ECHO_SOLICITATION_CARD_DEFINITION,
  createEchoSolicitationCardActions,
  createEchoSolicitationService
} from "./echo-solicitations.mjs";
import {
  ECHO_RELEASE_CARD_DEFINITION,
  createEchoReleaseService
} from "./echo-releases.mjs";
import {
  createWorkspaceCommandRegistry,
  createWorkspaceWorkflowRegistry
} from "./workspace-command-registry.mjs";
import { createWorkspaceInteractionService } from "./workspace-interactions.mjs";
import {
  createWorkspaceCardInteractionService,
  WorkspaceCardInteractionError
} from "./workspace-card-interactions.mjs";
import { createCardRegistry } from "./workspace-cards.mjs";

export const ECHO_COMMAND_NAMES = Object.freeze([
  "help",
  "cancel",
  "publish",
  "release",
  "need",
  "feedback",
  "list",
  "view",
  "collect",
  "implement",
  "reject"
]);

export const ECHO_WORKFLOW_TYPES = Object.freeze({
  publish: "echo.publish",
  requirement: "echo.requirement"
});

export const ECHO_COMMAND_VERSION = 1;
export const ECHO_WORKFLOW_VERSION = 1;

export class EchoRuntimeError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "EchoRuntimeError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Build the deterministic Echo command definitions. The generic Workspace
 * interaction service owns parsing context, persistence, audit rows, and
 * command idempotency; these handlers only call the Echo domain services.
 */
export function createEchoCommandDefinitions(options = {}) {
  const requirements = options.requirements ?? options.requirementService ?? null;
  const solicitations = options.solicitations ?? options.solicitationService ?? null;
  const releases = options.releases ?? options.releaseService ?? null;
  const delivery = options.deliveryService ?? options.delivery ?? null;
  const getInteractionService = typeof options.getInteractionService === "function"
    ? options.getInteractionService
    : () => options.interactionService ?? null;
  const commands = [];

  commands.push({
    name: "help",
    version: ECHO_COMMAND_VERSION,
    contexts: ["direct", "mention"],
    parseArguments: parseEmptyArguments,
    async execute() {
      return {
        result: {
          type: "help",
          botUserId: ECHO_USER_ID,
          commands: ECHO_COMMAND_NAMES.map((name) => `/${name}`)
        }
      };
    }
  });

  commands.push({
    name: "cancel",
    version: ECHO_COMMAND_VERSION,
    contexts: ["direct", "mention"],
    parseArguments: parseWorkflowIdArguments,
    async execute({ actor, context, botUserId, arguments: args, request }) {
      const interaction = getInteractionService();
      if (!interaction || typeof interaction.cancelWorkflow !== "function") {
        return { result: { type: "cancel", cancelled: false, workflowId: args.workflowId } };
      }
      const workflow = await interaction.cancelWorkflow(actor.id, {
        workflowId: args.workflowId,
        spaceId: context.spaceId,
        conversationId: context.id,
        botUserId,
        request
      });
      return { result: safeWorkflowResult(workflow, true) };
    }
  });

  commands.push({
    name: "publish",
    version: ECHO_COMMAND_VERSION,
    contexts: ["direct", "mention"],
    parseArguments: parsePublishArguments,
    authorize: ({ actor }) => actor.role === "owner",
    async execute({ arguments: args }) {
      return {
        result: {
          type: "workflow.start",
          workflowType: ECHO_WORKFLOW_TYPES.publish,
          version: ECHO_WORKFLOW_VERSION,
          input: args
        }
      };
    }
  });

  commands.push({
    name: "release",
    version: ECHO_COMMAND_VERSION,
    contexts: ["direct", "mention"],
    parseArguments: parseReleaseArguments,
    authorize: ({ actor }) => actor.role === "owner",
    async execute({ actor, arguments: args, request }) {
      requireDomain(releases, "版本发布服务尚未初始化");
      const publication = await releases.publish({
        actorId: actor.id,
        version: args.version,
        request
      });
      let deliveryResult = null;
      try {
        if (typeof delivery?.syncRelease === "function") {
          deliveryResult = await delivery.syncRelease({ version: publication.version, request });
        }
      } catch {
        // The durable delivery rows are recovered by the Echo worker.
      }
      const sentCount = Number(deliveryResult?.sent ?? publication.sentCount) || 0;
      const failedCount = Number(deliveryResult?.failed ?? publication.failedCount) || 0;
      const skippedCount = Number(deliveryResult?.skipped ?? publication.skippedCount) || 0;
      return {
        result: {
          type: "release-published",
          version: publication.version,
          title: publication.title,
          recipientCount: publication.recipientCount,
          sentCount,
          failedCount,
          skippedCount,
          pendingCount: Math.max(0, publication.recipientCount - sentCount - failedCount - skippedCount),
          replayed: publication.replayed
        }
      };
    }
  });

  const requirementCommand = {
    name: "need",
    version: ECHO_COMMAND_VERSION,
    contexts: ["direct", "mention"],
    parseArguments: parseRequirementWorkflowArguments,
    authorize: ({ actor }) => actor.role !== "auditor",
    async execute({ arguments: args }) {
      return {
        result: {
          type: "workflow.start",
          workflowType: ECHO_WORKFLOW_TYPES.requirement,
          version: ECHO_WORKFLOW_VERSION,
          input: args
        }
      };
    }
  };
  commands.push(requirementCommand);
  commands.push({
    ...requirementCommand,
    name: "feedback",
    parseArguments: (raw) => ({ ...parseRequirementWorkflowArguments(raw), type: "problem" })
  });

  commands.push({
    name: "list",
    version: ECHO_COMMAND_VERSION,
    contexts: ["direct", "mention"],
    parseArguments: parseListArguments,
    async execute({ actor, arguments: args, request }) {
      requireDomain(requirements, "需求服务尚未初始化");
      const page = await requirements.listPage({
        actorId: actor.id,
        phase: args.phase,
        status: args.status,
        limit: args.limit,
        offset: args.offset,
        request
      });
      return { result: { type: "requirement-list", ...safeRequirementPage(page) } };
    }
  });

  commands.push({
    name: "view",
    version: ECHO_COMMAND_VERSION,
    contexts: ["direct", "mention"],
    parseArguments: parseRequirementIdArguments,
    async execute({ actor, arguments: args, request }) {
      requireDomain(requirements, "需求服务尚未初始化");
      const result = await requirements.get({ actorId: actor.id, publicId: args.publicId, request });
      return { result: { type: "requirement", requirement: result } };
    }
  });

  for (const [name, target] of Object.entries({
    collect: { phase: "formal", status: "planned" },
    implement: { phase: "formal", status: "delivered" },
    reject: { phase: "archived", status: "archived", archiveOutcome: "rejected" }
  })) {
    commands.push({
      name,
      version: ECHO_COMMAND_VERSION,
      contexts: ["direct", "mention"],
      parseArguments: name === "reject" ? parseRejectArguments : parseRequirementIdArguments,
      authorize: ({ actor }) => actor.role === "owner",
      async execute({ actor, arguments: args, request, clientInvocationId }) {
        requireDomain(requirements, "需求服务尚未初始化");
        const current = await requirements.get({ actorId: actor.id, publicId: args.publicId, request });
        const result = await requirements.transition({
          actorId: actor.id,
          publicId: args.publicId,
          ...target,
          response: args.response ?? null,
          expectedRevision: current.revision,
          idempotencyKey: clientInvocationId,
          request
        });
        return { result: { type: "requirement-transition", ...safeRequirementSummary(result) } };
      }
    });
  }

  // Keep the factory useful in isolated registry tests where domain services
  // are intentionally absent. The closures above fail only when invoked.
  return Object.freeze(commands);
}

export function createEchoWorkflowDefinitions(options = {}) {
  const requirements = options.requirements ?? options.requirementService ?? null;
  const solicitations = options.solicitations ?? options.solicitationService ?? null;
  return Object.freeze([
    createPublishWorkflowDefinition(solicitations),
    createRequirementWorkflowDefinition(requirements)
  ]);
}

export function createEchoCardDefinitions(options = {}) {
  const requirementDefinitions = ECHO_REQUIREMENT_CARD_DEFINITIONS.map((definition) => definition.cardType === "echo.request" && options.requirements
    ? { ...definition, actions: createEchoRequirementCardActions(options.requirements) }
    : definition);
  const solicitationDefinition = options.solicitations
    ? { ...ECHO_SOLICITATION_CARD_DEFINITION, actions: createEchoSolicitationCardActions(options.solicitations) }
    : ECHO_SOLICITATION_CARD_DEFINITION;
  return Object.freeze([
    ...requirementDefinitions,
    solicitationDefinition,
    ECHO_RELEASE_CARD_DEFINITION
  ]);
}

export function createEchoCommandRegistry(options = {}) {
  return createWorkspaceCommandRegistry(createEchoCommandDefinitions(options));
}

export function createEchoWorkflowRegistry(options = {}) {
  return createWorkspaceWorkflowRegistry(createEchoWorkflowDefinitions(options));
}

export function createEchoCardRegistry(optionsOrDefinitions = []) {
  const options = Array.isArray(optionsOrDefinitions) ? {} : (optionsOrDefinitions ?? {});
  const extraDefinitions = Array.isArray(optionsOrDefinitions) ? optionsOrDefinitions : (options.extraDefinitions ?? []);
  return createCardRegistry([...createEchoCardDefinitions(options), ...extraDefinitions]);
}

// Safe, dependency-free defaults for hosts that wire the registries later.
// Runtime instances with a database should use createEchoRuntime instead so
// command/action closures share the host's domain services and delivery hook.
export const defaultEchoCommandDefinitions = createEchoCommandDefinitions();
export const defaultEchoWorkflowDefinitions = createEchoWorkflowDefinitions();
export const defaultEchoCardDefinitions = createEchoCardDefinitions();
export const defaultEchoCommandRegistry = createWorkspaceCommandRegistry(defaultEchoCommandDefinitions);
export const defaultEchoWorkflowRegistry = createWorkspaceWorkflowRegistry(defaultEchoWorkflowDefinitions);
export const defaultEchoCardRegistry = createCardRegistry(defaultEchoCardDefinitions);
export const ECHO_COMMAND_DEFINITIONS = defaultEchoCommandDefinitions;
export const ECHO_WORKFLOW_DEFINITIONS = defaultEchoWorkflowDefinitions;
export const ECHO_CARD_DEFINITIONS = defaultEchoCardDefinitions;
export const DEFAULT_ECHO_COMMAND_REGISTRY = defaultEchoCommandRegistry;
export const DEFAULT_ECHO_WORKFLOW_REGISTRY = defaultEchoWorkflowRegistry;
export const DEFAULT_ECHO_CARD_REGISTRY = defaultEchoCardRegistry;
export const defaultEchoRegistries = Object.freeze({
  commandRegistry: defaultEchoCommandRegistry,
  workflowRegistry: defaultEchoWorkflowRegistry,
  cardRegistry: defaultEchoCardRegistry
});
export const DEFAULT_ECHO_REGISTRIES = defaultEchoRegistries;

/**
 * Assemble all Echo registries and optional Workspace execution services.
 * `deliveryService` is deliberately best-effort: domain commits are never
 * rolled back because a notification or card refresh is temporarily down.
 */
export function createEchoRuntime(options = {}) {
  const db = options.db ?? null;
  const rawRequirements = options.requirements
    ?? options.requirementService
    ?? (db ? createEchoRequirementService({ db, spaceId: options.spaceId, now: options.now }) : null);
  const rawSolicitations = options.solicitations
    ?? options.solicitationService
    ?? (db ? createEchoSolicitationService({ db, spaceId: options.spaceId, now: options.now, idFactory: options.idFactory }) : null);
  const releases = options.releases
    ?? options.releaseService
    ?? (db ? createEchoReleaseService({ db, spaceId: options.spaceId, now: options.now, idFactory: options.idFactory }) : null);
  const requirements = withDeliveryHooks(rawRequirements, options.deliveryService, "requirement");
  const solicitations = withDeliveryHooks(rawSolicitations, options.deliveryService, "solicitation");

  let interactionService = options.interactionService ?? null;
  const commandDefinitions = createEchoCommandDefinitions({
    requirements,
    solicitations,
    releases,
    deliveryService: options.deliveryService,
    getInteractionService: () => interactionService
  });
  const workflowDefinitions = createEchoWorkflowDefinitions({ requirements, solicitations });
  const commandRegistry = options.commandRegistry ?? createWorkspaceCommandRegistry(commandDefinitions);
  const workflowRegistry = options.workflowRegistry ?? createWorkspaceWorkflowRegistry(workflowDefinitions);
  const cardRegistry = options.cardRegistry ?? createCardRegistry([
    // Card actions must call the raw domain services. Delivery hooks run only
    // after the card transaction commits; wrapping these services here would
    // perform delivery while the card CAS transaction is still open.
    ...createEchoCardDefinitions({ requirements: rawRequirements, solicitations: rawSolicitations }),
    ...(options.extraCardDefinitions ?? [])
  ]);

  if (!interactionService && db && options.createInteractionService !== false) {
    interactionService = createWorkspaceInteractionService({
      db,
      commandRegistry,
      workflowRegistry,
      now: options.now,
      idFactory: options.idFactory
    });
  }
  const rawCardInteractionService = options.cardInteractionService
    ?? (db && options.createCardInteractionService !== false
      ? createWorkspaceCardInteractionService({ db, registry: cardRegistry, now: options.now, idFactory: options.idFactory })
      : null);
  const cardInteractionService = createRuntimeCardInteractionService(rawCardInteractionService, options.deliveryService);

  const runtime = {
    botUserId: ECHO_USER_ID,
    requirements,
    solicitations,
    releases,
    commandDefinitions,
    workflowDefinitions,
    cardDefinitions: createEchoCardDefinitions({ requirements: rawRequirements, solicitations: rawSolicitations }),
    commandRegistry,
    workflowRegistry,
    cardRegistry,
    interactionService,
    cardInteractionService,
    async executeCommand(input) {
      if (!interactionService) throw new EchoRuntimeError("interaction.unavailable", "Echo 命令执行器尚未初始化", 503);
      return interactionService.executeCommand({ ...input, botUserId: ECHO_USER_ID });
    },
    async startWorkflow(input) {
      if (!interactionService) throw new EchoRuntimeError("interaction.unavailable", "Echo 工作流执行器尚未初始化", 503);
      return interactionService.startWorkflow({ ...input, botUserId: ECHO_USER_ID });
    },
    async continueWorkflow(actorId, input) {
      if (!interactionService) throw new EchoRuntimeError("interaction.unavailable", "Echo 工作流执行器尚未初始化", 503);
      return interactionService.continueWorkflow(actorId, input);
    },
    async cancelWorkflow(actorId, workflowId) {
      if (!interactionService) throw new EchoRuntimeError("interaction.unavailable", "Echo 工作流执行器尚未初始化", 503);
      return interactionService.cancelWorkflow(actorId, workflowId);
    },
    async executeCardAction(actorId, input = {}) {
      if (!cardInteractionService) throw new EchoRuntimeError("interaction.unavailable", "Echo 卡片执行器尚未初始化", 503);
      return cardInteractionService.executeAction(actorId, input);
    }
  };
  return Object.freeze(runtime);
}

function createPublishWorkflowDefinition(solicitations) {
  return {
    type: ECHO_WORKFLOW_TYPES.publish,
    version: ECHO_WORKFLOW_VERSION,
    authorize: ({ actor }) => actor.role === "owner",
    initialize({ input = {} }) {
      const fields = pickFields(input, SOLICITATION_FIELDS);
      return { state: { step: nextPublishStep(fields), fields } };
    },
    async continue({ actor, workflow, state, input = {} }) {
      const fields = pickFields({ ...state.fields, ...input }, SOLICITATION_FIELDS);
      if (input.confirm === true) {
        requireDomain(solicitations, "征集服务尚未初始化");
        const key = input.idempotencyKey ?? `workflow-${workflow.id}-${workflow.revision}`;
        const draft = await solicitations.create({ actorId: actor.id, ...fields, idempotencyKey: `${key}:create` });
        const published = await solicitations.publish({ actorId: actor.id, publicId: draft.publicId, idempotencyKey: `${key}:publish` });
        return {
          state: { step: "complete", fields },
          status: "completed",
          result: { type: "solicitation-published", ...safeSolicitationSummary(published) }
        };
      }
      return {
        state: { step: nextPublishStep(fields), fields },
        result: { type: "workflow-step", step: nextPublishStep(fields), missing: missingPublishFields(fields) }
      };
    },
    validateState: validatePublishState,
    project: ({ state }) => ({ step: state.step, fields: redactWorkflowFields(state.fields) })
  };
}

function createRequirementWorkflowDefinition(requirements) {
  return {
    type: ECHO_WORKFLOW_TYPES.requirement,
    version: ECHO_WORKFLOW_VERSION,
    authorize: ({ actor }) => actor.role !== "auditor",
    initialize({ input = {} }) {
      const fields = pickFields({ type: input.type ?? "requirement", ...input }, REQUIREMENT_FIELDS);
      return { state: { step: nextRequirementStep(fields), fields } };
    },
    async continue({ actor, workflow, state, input = {}, request }) {
      const fields = pickFields({ ...state.fields, ...input }, REQUIREMENT_FIELDS);
      if (input.confirm === true) {
        requireDomain(requirements, "需求服务尚未初始化");
        const idempotencyKey = input.idempotencyKey ?? `workflow-${workflow.id}-${workflow.revision}`;
        const result = await requirements.submit({ actorId: actor.id, ...fields, idempotencyKey, request });
        return {
          state: { step: "complete", fields },
          status: "completed",
          result: { type: "requirement-submitted", ...safeRequirementSummary(result) }
        };
      }
      return {
        state: { step: nextRequirementStep(fields), fields },
        result: { type: "workflow-step", step: nextRequirementStep(fields), missing: missingRequirementFields(fields) }
      };
    },
    validateState: validateRequirementState,
    project: ({ state }) => ({ step: state.step, fields: redactWorkflowFields(state.fields) })
  };
}

const SOLICITATION_FIELDS = Object.freeze([
  "title", "description", "question", "options", "choiceMode", "minSelections",
  "maxSelections", "allowVoteChange", "deadline", "resultVisibility", "deliveryPolicy"
]);
const REQUIREMENT_FIELDS = Object.freeze([
  "type", "title", "detail", "scenario", "expectedResult", "relatedLink"
]);

function withDeliveryHooks(service, delivery, kind) {
  if (!service || !delivery) return service;
  const methods = new Set(kind === "requirement" ? ["submit", "transition"] : ["publish", "close", "withdraw", "vote"]);
  const wrapped = {};
  for (const [name, method] of Object.entries(service)) {
    if (typeof method !== "function" || !methods.has(name)) {
      wrapped[name] = method;
      continue;
    }
    wrapped[name] = async (input = {}) => {
      const result = await method(input);
      try {
        const operation = kind === "requirement" ? delivery.syncRequirement : delivery.syncSolicitation;
        if (typeof operation === "function") await operation.call(delivery, { publicId: result.publicId, actorUserId: input.actorId });
      } catch {
        // Domain success is durable even when notification/card refresh fails.
      }
      return result;
    };
  }
  return Object.freeze(wrapped);
}

/**
 * Adapt the generic card service to Echo's domain idempotency and delivery
 * contract. The adapter is also exposed to the generic card route, so both
 * direct route calls and runtime calls share the same post-commit behavior.
 */
function createRuntimeCardInteractionService(service, delivery) {
  if (!service) return null;
  const wrapped = {
    ...service,
    async executeAction(actorId, input = {}) {
      let clientActionId;
      try {
        clientActionId = normalizeClientActionId(input.clientActionId);
      } catch (error) {
        // Preserve the generic card route's stable 4xx error contract.
        throw new WorkspaceCardInteractionError(error.code, error.message, error.statusCode);
      }
      const actionInput = { ...(input.input ?? {}), idempotencyKey: clientActionId };
      const outcome = await service.executeAction(actorId, { ...input, input: actionInput });
      if (!outcome?.replayed && outcome?.ok !== false) {
        await syncCardActionDelivery(delivery, input.actionId, outcome.result, actorId);
      }
      return outcome;
    }
  };
  return Object.freeze(wrapped);
}

async function syncCardActionDelivery(delivery, actionId, result, actorUserId) {
  const publicId = typeof result?.publicId === "string" ? result.publicId : "";
  if (!delivery || !publicId) return;
  const operation = actionId === "vote" ? delivery.syncSolicitation : delivery.syncRequirement;
  if (typeof operation !== "function") return;
  try {
    await operation.call(delivery, { publicId, actorUserId });
  } catch {
    // Card/domain success is durable even if notification refresh fails.
  }
}

function parseEmptyArguments(raw) {
  if (String(raw ?? "").trim()) throw new EchoRuntimeError("command.arguments_invalid", "该命令不接受参数");
  return {};
}

function parseWorkflowIdArguments(raw) {
  const tokens = tokenize(raw);
  if (tokens.length > 1) throw new EchoRuntimeError("command.arguments_invalid", "工作流参数无效");
  return { workflowId: tokens[0] ?? null };
}

function parsePublishArguments(raw) {
  const tokens = tokenize(raw);
  if (tokens.length > 0) throw new EchoRuntimeError("command.arguments_invalid", "请通过引导流程填写征集内容");
  return {};
}

function parseReleaseArguments(raw) {
  const tokens = tokenize(raw);
  const match = tokens.length === 1 ? tokens[0].match(/^(?:v)?(\d+\.\d+\.\d+)$/i) : null;
  if (!match) throw new EchoRuntimeError("command.arguments_invalid", "需要版本号，例如 /release 0.15.1");
  return { version: match[1] };
}

function parseRequirementWorkflowArguments(raw) {
  const tokens = tokenize(raw);
  if (tokens.length > 1) throw new EchoRuntimeError("command.arguments_invalid", "请通过引导流程填写完整内容");
  return { type: tokens[0] === "feedback" ? "problem" : "requirement" };
}

function parseRequirementIdArguments(raw) {
  const tokens = tokenize(raw);
  if (tokens.length !== 1 || !/^REQ-\d{4}-\d{4}$/i.test(tokens[0])) {
    throw new EchoRuntimeError("command.arguments_invalid", "需要有效的需求编号");
  }
  return { publicId: tokens[0].toUpperCase() };
}

function parseRejectArguments(raw) {
  const tokens = tokenize(raw);
  if (tokens.length < 1 || tokens.length > 2 || !/^REQ-\d{4}-\d{4}$/i.test(tokens[0])) {
    throw new EchoRuntimeError("command.arguments_invalid", "需要需求编号和可选说明");
  }
  return { publicId: tokens[0].toUpperCase(), response: tokens[1] ?? null };
}

function parseListArguments(raw) {
  const tokens = tokenize(raw);
  if (tokens.length > 1) throw new EchoRuntimeError("command.arguments_invalid", "列表筛选参数无效");
  const filter = tokens[0]?.toLowerCase() ?? null;
  const mapping = {
    pending: { phase: "proposal", status: "pending_review" },
    submitted: { phase: "proposal", status: "pending_review" },
    collected: { phase: "formal", status: "planned" },
    planned: { phase: "formal", status: "planned" },
    in_progress: { phase: "formal", status: "in_progress" },
    implemented: { phase: "formal", status: "delivered" },
    delivered: { phase: "formal", status: "delivered" },
    rejected: { phase: "archived", status: "archived", archiveOutcome: "rejected" }
  };
  if (filter && !mapping[filter]) throw new EchoRuntimeError("command.arguments_invalid", "未知的需求筛选状态");
  return filter ? mapping[filter] : {};
}

function tokenize(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return [];
  const tokens = [];
  let current = "";
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
    } else if (/\s/u.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += char;
    }
    if (tokens.length > 16 || Buffer.byteLength(current, "utf8") > 4 * 1024) {
      throw new EchoRuntimeError("command.arguments_invalid", "命令参数过长");
    }
  }
  if (quote) throw new EchoRuntimeError("command.arguments_invalid", "命令引号不完整");
  if (current) tokens.push(current);
  if (tokens.length > 16) throw new EchoRuntimeError("command.arguments_invalid", "命令参数过多");
  return tokens;
}

function pickFields(input, fields) {
  const result = {};
  for (const field of fields) {
    if (input[field] !== undefined && input[field] !== null && input[field] !== "") result[field] = input[field];
  }
  return result;
}

function nextPublishStep(fields) {
  return missingPublishFields(fields)[0] ?? "confirm";
}

function missingPublishFields(fields) {
  return ["title", "description", "question", "options"].filter((field) => fields[field] === undefined);
}

function nextRequirementStep(fields) {
  return missingRequirementFields(fields)[0] ?? "confirm";
}

function missingRequirementFields(fields) {
  return ["type", "title", "detail", "scenario", "expectedResult"].filter((field) => fields[field] === undefined);
}

function validatePublishState(state) {
  if (!state || typeof state !== "object" || !Array.isArray(state.fields?.options ?? [])) {
    if (state?.fields?.options !== undefined) throw new EchoRuntimeError("workflow.state_invalid", "征集选项无效");
  }
  return state;
}

function validateRequirementState(state) {
  if (!state || typeof state !== "object" || !state.fields || typeof state.fields !== "object") {
    throw new EchoRuntimeError("workflow.state_invalid", "需求流程状态无效");
  }
  return state;
}

function redactWorkflowFields(fields = {}) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => {
    if (["detail", "scenario", "expectedResult", "description", "question", "response"].includes(key)) {
      return [key, typeof value === "string" ? `${value.slice(0, 1)}…` : value];
    }
    return [key, value];
  }));
}

function safeRequirementPage(page) {
  return {
    items: (page.items ?? []).map(safeRequirementSummary),
    total: page.total,
    pageInfo: page.pageInfo
  };
}

function safeRequirementSummary(result) {
  return {
    publicId: result.publicId,
    state: result.state,
    phase: result.phase,
    status: result.status,
    archiveOutcome: result.archiveOutcome ?? null,
    duplicateOfPublicId: result.duplicateOfPublicId ?? null,
    revision: result.revision
  };
}

function safeSolicitationSummary(result) {
  return {
    publicId: result.publicId,
    status: result.status,
    revision: result.revision,
    options: result.options,
    selectedOptionIds: result.selectedOptionIds,
    counts: result.counts,
    voteCount: result.voteCount
  };
}

function safeWorkflowResult(workflow, cancelled) {
  return {
    type: "workflow.cancelled",
    workflowId: workflow.id,
    status: workflow.status,
    revision: workflow.revision,
    cancelled
  };
}

function normalizeClientActionId(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)) {
    throw new EchoRuntimeError("card.invalid_client_action_id", "客户端操作 ID 无效", 400);
  }
  return normalized;
}

function requireDomain(service, message) {
  if (!service) throw new EchoRuntimeError("echo.unavailable", message, 503);
}
