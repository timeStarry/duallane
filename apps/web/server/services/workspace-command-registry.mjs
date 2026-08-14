const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const WORKFLOW_TYPE_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const MAX_COMMAND_TEXT_CODE_POINTS = 4096;

export class WorkspaceInteractionDefinitionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorkspaceInteractionDefinitionError";
    this.code = code;
  }
}

export class WorkspaceCommandRegistry {
  #commands = new Map();

  constructor(definitions = []) {
    for (const definition of definitions) this.register(definition);
  }

  register(definition) {
    const normalized = normalizeCommandDefinition(definition);
    for (const name of [normalized.name, ...normalized.aliases]) {
      if (this.#commands.has(name)) {
        throw new WorkspaceInteractionDefinitionError("command.duplicate_definition", "命令名称或别名重复");
      }
      this.#commands.set(name, normalized);
    }
    return normalized;
  }

  get(name) {
    return this.#commands.get(normalizeCommandName(name)) ?? null;
  }

  recognize(source, context = {}) {
    const text = typeof source === "string" ? source : "";
    if (Array.from(text).length > MAX_COMMAND_TEXT_CODE_POINTS) return null;
    const match = /^\s*\/([A-Za-z][A-Za-z0-9_-]{0,31})(?:\s+([\s\S]*))?\s*$/u.exec(text);
    if (!match) return null;
    const definition = this.get(match[1]);
    if (!definition) return {
      type: "unknown_command",
      name: normalizeCommandName(match[1]),
      rawArguments: match[2]?.trim() ?? ""
    };
    const directAllowed = context.conversationType === "direct" && definition.contexts.includes("direct");
    const mentioned = Array.isArray(context.mentionedBotIds)
      && typeof context.botUserId === "string"
      && context.mentionedBotIds.includes(context.botUserId);
    const mentionAllowed = context.conversationType === "group" && mentioned && definition.contexts.includes("mention");
    if (!directAllowed && !mentionAllowed) return null;
    const rawArguments = match[2]?.trim() ?? "";
    const argumentsValue = definition.parseArguments
      ? definition.parseArguments(rawArguments)
      : { text: rawArguments };
    return { type: "command", definition, name: definition.name, rawArguments, arguments: argumentsValue };
  }
}

export class WorkspaceWorkflowRegistry {
  #definitions = new Map();

  constructor(definitions = []) {
    for (const definition of definitions) this.register(definition);
  }

  register(definition) {
    const normalized = normalizeWorkflowDefinition(definition);
    const key = workflowKey(normalized.type, normalized.version);
    if (this.#definitions.has(key)) {
      throw new WorkspaceInteractionDefinitionError("workflow.duplicate_definition", "引导流程定义重复");
    }
    this.#definitions.set(key, normalized);
    return normalized;
  }

  get(type, version) {
    return this.#definitions.get(workflowKey(normalizeWorkflowType(type), normalizeVersion(version, "workflow.invalid_version"))) ?? null;
  }
}

export function createWorkspaceCommandRegistry(definitions = []) {
  return new WorkspaceCommandRegistry(definitions);
}

export function createWorkspaceWorkflowRegistry(definitions = []) {
  return new WorkspaceWorkflowRegistry(definitions);
}

function normalizeCommandDefinition(definition) {
  if (!isPlainObject(definition)) throw invalidDefinition("命令定义无效");
  const name = normalizeCommandName(definition.name);
  const aliases = [...new Set((definition.aliases ?? []).map(normalizeCommandName))].filter((alias) => alias !== name);
  const version = normalizeVersion(definition.version ?? 1, "command.invalid_version");
  const contexts = [...new Set(definition.contexts ?? ["direct", "mention"])]
    .filter((context) => context === "direct" || context === "mention");
  if (contexts.length === 0 || typeof definition.execute !== "function") throw invalidDefinition("命令处理器无效");
  if (definition.parseArguments !== undefined && typeof definition.parseArguments !== "function") throw invalidDefinition("命令参数解析器无效");
  if (definition.authorize !== undefined && typeof definition.authorize !== "function") throw invalidDefinition("命令授权器无效");
  return Object.freeze({
    name,
    aliases: Object.freeze(aliases),
    version,
    contexts: Object.freeze(contexts),
    parseArguments: definition.parseArguments,
    authorize: definition.authorize,
    execute: definition.execute
  });
}

function normalizeWorkflowDefinition(definition) {
  if (!isPlainObject(definition)) throw invalidDefinition("引导流程定义无效");
  const type = normalizeWorkflowType(definition.type);
  const version = normalizeVersion(definition.version ?? 1, "workflow.invalid_version");
  if (typeof definition.initialize !== "function" || typeof definition.continue !== "function") {
    throw invalidDefinition("引导流程处理器无效");
  }
  for (const key of ["validateState", "authorize", "project"]) {
    if (definition[key] !== undefined && typeof definition[key] !== "function") throw invalidDefinition("引导流程定义无效");
  }
  return Object.freeze({
    type,
    version,
    initialize: definition.initialize,
    continue: definition.continue,
    validateState: definition.validateState,
    authorize: definition.authorize,
    project: definition.project
  });
}

function normalizeCommandName(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!COMMAND_NAME_PATTERN.test(normalized)) {
    throw new WorkspaceInteractionDefinitionError("command.invalid_name", "命令名称无效");
  }
  return normalized;
}

function normalizeWorkflowType(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!WORKFLOW_TYPE_PATTERN.test(normalized)) {
    throw new WorkspaceInteractionDefinitionError("workflow.invalid_type", "引导流程类型无效");
  }
  return normalized;
}

function normalizeVersion(value, code) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) {
    throw new WorkspaceInteractionDefinitionError(code, "版本号无效");
  }
  return value;
}

function workflowKey(type, version) {
  return `${type}@${version}`;
}

function invalidDefinition(message) {
  return new WorkspaceInteractionDefinitionError("interaction.invalid_definition", message);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
