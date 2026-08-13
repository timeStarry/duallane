const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CARD_TYPE_PATTERN = /^[a-z][a-z0-9._-]{0,127}$/;
const HTML_TAG_PATTERN = /<\/?[a-z][^>]*>/i;
const SCRIPT_PATTERN = /(?:^|[\s<])(?:javascript|vbscript)\s*:/i;
const EVENT_HANDLER_PATTERN = /\bon[a-z][a-z0-9_-]*\s*=/i;
const DYNAMIC_CODE_PATTERN = /(?:^|[^a-z])(?:eval|function|settimeout|setinterval)\s*\(/i;
const PRIVATE_HOST_PATTERN = /^(?:localhost|localhost\.local|0\.0\.0\.0|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|169\.254(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}|::1|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:|fe80:)/i;

export const WORKSPACE_V1_BLOCK_TYPES = Object.freeze([
  "text",
  "mention",
  "link",
  "emoji",
  "attachment",
  "emote_collection"
]);

export const CARD_BLOCK_TYPE = "card";
export const CARD_FALLBACK_TYPE = "card_fallback";
export const DEFAULT_CARD_LIMITS = Object.freeze({
  maxPayloadBytes: 64 * 1024,
  maxDepth: 8,
  maxNodes: 200,
  maxTextBytes: 16 * 1024
});

export class CardValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CardValidationError";
    this.code = code;
  }
}

export function normalizeCardBlock(block) {
  if (!isPlainObject(block) || block.type !== CARD_BLOCK_TYPE) {
    throw new CardValidationError("card.invalid_block", "卡片消息块格式无效");
  }

  const cardId = normalizeIdentifier(block.cardId, "card.invalid_id", "卡片 ID 无效");
  const cardType = normalizeCardType(block.cardType);
  const schemaVersion = normalizeSchemaVersion(block.schemaVersion);
  const fallbackText = normalizeFallbackText(block.fallbackText);
  return { type: CARD_BLOCK_TYPE, cardId, cardType, schemaVersion, fallbackText };
}

export function normalizeCardPayload(payload, options = {}) {
  const limits = { ...DEFAULT_CARD_LIMITS, ...(options.limits ?? {}) };
  const allowPublicUrls = options.allowPublicUrls === true;
  const state = { depth: 0, nodes: 0, textBytes: 0 };
  const normalized = visitPayload(payload, state, limits, allowPublicUrls, "payload");
  const serialized = JSON.stringify(normalized);
  if (Buffer.byteLength(serialized, "utf8") > limits.maxPayloadBytes) {
    throw new CardValidationError("card.payload_too_large", "卡片数据过大");
  }
  return normalized;
}

export function isWorkspaceV1ContentBlock(block) {
  return isPlainObject(block) && typeof block.type === "string" && WORKSPACE_V1_BLOCK_TYPES.includes(block.type);
}

export class CardRegistry {
  #definitions = new Map();

  constructor(definitions = []) {
    for (const definition of definitions) {
      this.register(definition);
    }
  }

  register(definition) {
    const normalized = normalizeDefinition(definition);
    const key = cardKey(normalized.cardType, normalized.schemaVersion);
    if (this.#definitions.has(key)) {
      throw new CardValidationError("card.duplicate_definition", "卡片定义已注册");
    }
    this.#definitions.set(key, normalized);
    return normalized;
  }

  get(cardType, schemaVersion) {
    return this.#definitions.get(cardKey(normalizeCardType(cardType), normalizeSchemaVersion(schemaVersion))) ?? null;
  }

  normalizeBlock(block) {
    return normalizeCardBlock(block);
  }

  resolve(block) {
    const normalized = normalizeCardBlock(block);
    const definition = this.#definitions.get(cardKey(normalized.cardType, normalized.schemaVersion));
    if (!definition) {
      return {
        type: CARD_FALLBACK_TYPE,
        reason: "card.unknown_version",
        block: normalized,
        fallbackText: normalized.fallbackText
      };
    }
    return { type: "card", block: normalized, definition };
  }

  validatePayload(block, payload, options = {}) {
    const normalizedBlock = normalizeCardBlock(block);
    const definition = this.#definitions.get(cardKey(normalizedBlock.cardType, normalizedBlock.schemaVersion));
    if (!definition) {
      return {
        type: CARD_FALLBACK_TYPE,
        reason: "card.unknown_version",
        block: normalizedBlock,
        fallbackText: normalizedBlock.fallbackText
      };
    }
    const safePayload = normalizeCardPayload(payload, {
      ...options,
      limits: { ...definition.limits, ...(options.limits ?? {}) },
      allowPublicUrls: options.allowPublicUrls ?? definition.allowPublicUrls
    });
    const projected = definition.validatePayload
      ? definition.validatePayload(safePayload)
      : safePayload;
    return { type: "card", block: normalizedBlock, definition, payload: projected };
  }
}

export function createCardRegistry(definitions = []) {
  return new CardRegistry(definitions);
}

function normalizeDefinition(definition) {
  if (!isPlainObject(definition)) {
    throw new CardValidationError("card.invalid_definition", "卡片定义无效");
  }
  const cardType = normalizeCardType(definition.cardType);
  const schemaVersion = normalizeSchemaVersion(definition.schemaVersion);
  if (definition.validatePayload !== undefined && typeof definition.validatePayload !== "function") {
    throw new CardValidationError("card.invalid_definition", "卡片校验器无效");
  }
  return Object.freeze({
    cardType,
    schemaVersion,
    validatePayload: definition.validatePayload,
    allowPublicUrls: definition.allowPublicUrls === true,
    limits: Object.freeze({ ...DEFAULT_CARD_LIMITS, ...(definition.limits ?? {}) })
  });
}

function visitPayload(value, state, limits, allowPublicUrls, path) {
  state.nodes += 1;
  if (state.nodes > limits.maxNodes) {
    throw new CardValidationError("card.payload_too_complex", "卡片节点数量超限");
  }
  if (state.depth > limits.maxDepth) {
    throw new CardValidationError("card.payload_too_deep", "卡片嵌套深度超限");
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new CardValidationError("card.invalid_payload", "卡片数据包含无效数字");
    }
    return value;
  }
  if (typeof value === "string") {
    return normalizePayloadString(value, state, limits, allowPublicUrls, path);
  }
  if (Array.isArray(value)) {
    state.depth += 1;
    const result = value.map((item, index) => visitPayload(item, state, limits, allowPublicUrls, `${path}[${index}]`));
    state.depth -= 1;
    return result;
  }
  if (!isPlainObject(value)) {
    throw new CardValidationError("card.invalid_payload", "卡片数据必须是 JSON 值");
  }
  state.depth += 1;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(key)) {
      throw new CardValidationError("card.invalid_payload", "卡片字段名无效");
    }
    if (["__proto__", "constructor", "prototype"].includes(key)) {
      throw new CardValidationError("card.invalid_payload", "卡片字段名保留，不可使用");
    }
    if (!allowPublicUrls && /(callback|webhook|actionurl|targeturl|href|uri|url)$/i.test(key)) {
      if (typeof child === "string" && looksLikeUrl(child)) {
        throw new CardValidationError("card.url_forbidden", "卡片不允许未注册的 URL 操作");
      }
    }
    result[key] = visitPayload(child, state, limits, allowPublicUrls, `${path}.${key}`);
  }
  state.depth -= 1;
  return result;
}

function normalizePayloadString(value, state, limits, allowPublicUrls, path) {
  const text = String(value);
  state.textBytes += Buffer.byteLength(text, "utf8");
  if (state.textBytes > limits.maxTextBytes) {
    throw new CardValidationError("card.text_too_large", "卡片文本超限");
  }
  if (HTML_TAG_PATTERN.test(text) || SCRIPT_PATTERN.test(text) || EVENT_HANDLER_PATTERN.test(text) || DYNAMIC_CODE_PATTERN.test(text)) {
    throw new CardValidationError("card.unsafe_content", `卡片字段 ${path} 包含不安全内容`);
  }
  if (looksLikeUrl(text)) {
    assertSafeUrl(text, allowPublicUrls);
  }
  return text;
}

function assertSafeUrl(value, allowPublicUrls) {
  let url;
  try {
    url = new URL(value, "https://duallane.invalid");
  } catch {
    throw new CardValidationError("card.invalid_url", "卡片 URL 无效");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new CardValidationError("card.url_forbidden", "卡片仅允许 HTTP(S) URL");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (url.username || url.password || PRIVATE_HOST_PATTERN.test(hostname)) {
    throw new CardValidationError("card.private_url", "卡片不允许访问私有地址");
  }
  if (!allowPublicUrls && url.hostname !== "duallane.invalid") {
    throw new CardValidationError("card.url_forbidden", "卡片不允许未注册的 URL 操作");
  }
}

function looksLikeUrl(value) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|https?:\/\/)/i.test(value.trim());
}

function normalizeIdentifier(value, code, message) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!IDENTIFIER_PATTERN.test(normalized)) {
    throw new CardValidationError(code, message);
  }
  return normalized;
}

function normalizeCardType(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!CARD_TYPE_PATTERN.test(normalized)) {
    throw new CardValidationError("card.invalid_type", "卡片类型无效");
  }
  return normalized;
}

function normalizeSchemaVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) {
    throw new CardValidationError("card.invalid_version", "卡片版本无效");
  }
  return value;
}

function normalizeFallbackText(value) {
  const normalized = typeof value === "string" ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim() : "";
  if (!normalized || Buffer.byteLength(normalized, "utf8") > 16 * 1024 || HTML_TAG_PATTERN.test(normalized)) {
    throw new CardValidationError("card.invalid_fallback", "卡片降级文本无效");
  }
  return normalized;
}

function cardKey(cardType, schemaVersion) {
  return `${cardType}@${schemaVersion}`;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
