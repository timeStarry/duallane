import { isIP } from "node:net";
import { CardValidationError, normalizeCardPayload } from "./workspace-cards.mjs";
import { writeWorkspaceEvent } from "./workspace.mjs";

export const FEISHU_CARD_TYPE = "feishu.adaptive.v1";
export const FEISHU_CARD_SCHEMA_VERSION = 1;
export const FEISHU_CARD_ACTION_IDS = Object.freeze(["cancel", "confirm", "refresh", "submit"]);

const ACTION_IDS = new Set(FEISHU_CARD_ACTION_IDS);
const ROOT_KEYS = new Set(["config", "elements", "header"]);
const CONFIG_KEYS = new Set(["version", "wide_screen_mode"]);
const HEADER_KEYS = new Set(["subtitle", "template", "title"]);
const TEXT_KEYS = new Set(["content", "tag"]);
const ELEMENT_LIMITS = Object.freeze({ maxDepth: 10, maxNodes: 80, maxTextBytes: 12 * 1024, maxPayloadBytes: 48 * 1024 });
const HTML_PATTERN = /<\/?[a-z][^>]*>/iu;
const UNSAFE_TEXT_PATTERN = /(?:javascript|vbscript|data)\s*:|\bon[a-z][a-z0-9_-]*\s*=|\b(?:eval|function|settimeout|setinterval)\s*\(/iu;
const URL_PATTERN = /(?:https?:\/\/|\/\/)[^\s<>()]+/giu;
const PRIVATE_HOST_SUFFIX = /(?:^|\.)(?:localhost|local|internal|home|lan)$/iu;
const HEADER_TONES = new Map([
  ["blue", "info"],
  ["green", "success"],
  ["orange", "warning"],
  ["red", "danger"],
  ["grey", "neutral"],
  ["gray", "neutral"]
]);

export function convertFeishuCard(input, options = {}) {
  const limits = { ...ELEMENT_LIMITS, ...(options.limits ?? {}) };
  const allowedActions = normalizeAllowedActions(options.allowedActions);
  const state = { depth: 0, nodes: 0, textBytes: 0, limits, allowedActions, seenActions: new Set() };
  const source = requireObject(input, "card.feishu_invalid", "飞书卡片必须是 JSON 对象");
  assertKnownKeys(source, ROOT_KEYS, "卡片");
  if (!Array.isArray(source.elements) || source.elements.length === 0) {
    throw new CardValidationError("card.feishu_elements_required", "飞书卡片至少需要一个内容元素");
  }

  const payload = {
    format: "duallane.feishu-card.v1",
    config: convertConfig(source.config, state),
    header: convertHeader(source.header, state),
    elements: source.elements.map((element) => convertElement(element, state, 1))
  };
  const normalized = normalizeCardPayload(payload, { allowPublicUrls: true, limits });
  return {
    cardType: FEISHU_CARD_TYPE,
    schemaVersion: FEISHU_CARD_SCHEMA_VERSION,
    payload: normalized,
    fallbackText: deriveFallbackText(normalized)
  };
}

export function validateConvertedFeishuCard(payload) {
  const source = requireObject(payload, "card.feishu_invalid", "飞书卡片映射结果无效");
  if (source.format !== "duallane.feishu-card.v1") {
    throw new CardValidationError("card.feishu_invalid", "飞书卡片映射版本无效");
  }
  if (!source.config || typeof source.config !== "object" || Array.isArray(source.config)) {
    throw new CardValidationError("card.feishu_invalid_config", "飞书卡片映射 config 无效");
  }
  if (source.header !== null && (typeof source.header !== "object" || Array.isArray(source.header))) {
    throw new CardValidationError("card.feishu_invalid_header", "飞书卡片映射 header 无效");
  }
  if (!Array.isArray(source.elements) || source.elements.length === 0) {
    throw new CardValidationError("card.feishu_elements_required", "飞书卡片至少需要一个内容元素");
  }
  const allowedActions = FEISHU_CARD_ACTION_IDS;
  const reconstructed = {
    config: {
      version: source.config?.version,
      wide_screen_mode: source.config?.wideScreen
    },
    header: source.header ? {
      title: { tag: "plain_text", content: source.header.title },
      ...(source.header.subtitle ? { subtitle: { tag: "plain_text", content: source.header.subtitle } } : {}),
      ...(source.header.tone && source.header.tone !== "neutral" ? { template: reverseTone(source.header.tone) } : {})
    } : undefined,
    elements: (source.elements ?? []).map(toFeishuElement)
  };
  return convertFeishuCard(reconstructed, { allowedActions }).payload;
}

export const FEISHU_CARD_DEFINITION = Object.freeze({
  cardType: FEISHU_CARD_TYPE,
  schemaVersion: FEISHU_CARD_SCHEMA_VERSION,
  allowPublicUrls: true,
  limits: ELEMENT_LIMITS,
  validatePayload: validateConvertedFeishuCard,
  actions: Object.freeze(Object.fromEntries(FEISHU_CARD_ACTION_IDS.map((actionId) => [actionId, Object.freeze({
    validateInput: validateEmptyActionInput,
    execute: (context) => executeFeishuAction(actionId, context)
  })])))
});

function convertConfig(value, state) {
  if (value === undefined) return { version: "1.0", wideScreen: false };
  const config = requireObject(value, "card.feishu_invalid_config", "飞书卡片 config 无效");
  assertKnownKeys(config, CONFIG_KEYS, "config");
  if (config.version !== undefined && config.version !== "1.0") {
    throw new CardValidationError("card.feishu_unsupported_version", "仅支持飞书卡片 1.0 子集");
  }
  if (config.wide_screen_mode !== undefined && typeof config.wide_screen_mode !== "boolean") {
    throw new CardValidationError("card.feishu_invalid_config", "wide_screen_mode 必须是布尔值");
  }
  countNode(state, 1);
  return { version: "1.0", wideScreen: config.wide_screen_mode === true };
}

function convertHeader(value, state) {
  if (value === undefined) return null;
  const header = requireObject(value, "card.feishu_invalid_header", "飞书卡片 header 无效");
  assertKnownKeys(header, HEADER_KEYS, "header");
  const title = convertTextObject(header.title, state, { allowMarkdown: false, required: true });
  const subtitle = header.subtitle === undefined
    ? null
    : convertTextObject(header.subtitle, state, { allowMarkdown: false, required: true }).text;
  let tone = "neutral";
  if (header.template !== undefined) {
    if (!HEADER_TONES.has(header.template)) {
      throw new CardValidationError("card.feishu_style_forbidden", "飞书卡片 header 样式不在允许列表中");
    }
    tone = HEADER_TONES.get(header.template);
  }
  countNode(state, 1);
  return { title: title.text, ...(subtitle ? { subtitle } : {}), tone };
}

function convertElement(value, state, depth) {
  countNode(state, depth);
  const element = requireObject(value, "card.feishu_invalid_element", "飞书卡片元素无效");
  switch (element.tag) {
    case "div":
      assertKnownKeys(element, new Set(["tag", "text"]), "div");
      return { type: "text", ...convertTextObject(element.text, state, { allowMarkdown: true, required: true }) };
    case "markdown":
      assertKnownKeys(element, new Set(["content", "tag"]), "markdown");
      return { type: "text", format: "markdown", text: normalizeText(element.content, state) };
    case "note": {
      assertKnownKeys(element, new Set(["elements", "tag"]), "note");
      if (!Array.isArray(element.elements) || element.elements.length === 0 || element.elements.length > 8) {
        throw new CardValidationError("card.feishu_invalid_note", "飞书卡片 note 元素数量无效");
      }
      return {
        type: "note",
        parts: element.elements.map((part) => convertTextObject(part, state, { allowMarkdown: true, required: true }))
      };
    }
    case "hr":
      assertKnownKeys(element, new Set(["tag"]), "hr");
      return { type: "divider" };
    case "action":
      assertKnownKeys(element, new Set(["actions", "tag"]), "action");
      return convertActions(element.actions, state, depth + 1);
    case "button_list":
      assertKnownKeys(element, new Set(["buttons", "tag"]), "button_list");
      return convertActions(element.buttons, state, depth + 1);
    case "column_set":
    case "columns":
      return convertColumns(element, state, depth + 1);
    default:
      throw new CardValidationError("card.feishu_unknown_element", "飞书卡片包含不支持的元素");
  }
}

function convertActions(value, state, depth) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 6) {
    throw new CardValidationError("card.feishu_invalid_actions", "飞书卡片按钮数量无效");
  }
  return { type: "actions", buttons: value.map((button) => convertButton(button, state, depth)) };
}

function convertButton(value, state, depth) {
  countNode(state, depth);
  const button = requireObject(value, "card.feishu_invalid_button", "飞书卡片按钮无效");
  assertKnownKeys(button, new Set(["action_id", "tag", "text", "type", "value"]), "button");
  if (button.tag !== "button") throw new CardValidationError("card.feishu_invalid_button", "action 中仅允许 button");
  const valueObject = button.value === undefined
    ? {}
    : requireObject(button.value, "card.feishu_invalid_action", "按钮 value 无效");
  assertKnownKeys(valueObject, new Set(["action_id", "data"]), "button.value");
  const actionId = normalizeActionId(button.action_id ?? valueObject.action_id, state.allowedActions);
  if (state.seenActions.has(actionId)) {
    throw new CardValidationError("card.feishu_duplicate_action", "飞书卡片动作标识必须唯一");
  }
  state.seenActions.add(actionId);
  const label = typeof button.text === "string"
    ? normalizeText(button.text, state)
    : convertTextObject(button.text, state, { allowMarkdown: false, required: true }).text;
  const style = button.type ?? "default";
  if (!new Set(["default", "primary", "danger"]).has(style)) {
    throw new CardValidationError("card.feishu_style_forbidden", "按钮样式不在允许列表中");
  }
  const data = valueObject.data === undefined
    ? {}
    : normalizeCardPayload(valueObject.data, {
      limits: { maxPayloadBytes: 4 * 1024, maxDepth: 3, maxNodes: 30, maxTextBytes: 2 * 1024 }
    });
  return { type: "button", label, actionId, style, data };
}

function convertColumns(value, state, depth) {
  const element = requireObject(value, "card.feishu_invalid_columns", "飞书卡片 columns 无效");
  assertKnownKeys(element, new Set(["columns", "tag"]), "columns");
  if (!Array.isArray(element.columns) || element.columns.length < 2 || element.columns.length > 4) {
    throw new CardValidationError("card.feishu_invalid_columns", "飞书卡片列数必须为 2 至 4");
  }
  return {
    type: "columns",
    columns: element.columns.map((column) => {
      countNode(state, depth);
      const source = requireObject(column, "card.feishu_invalid_column", "飞书卡片列无效");
      assertKnownKeys(source, new Set(["elements", "tag", "weight", "width"]), "column");
      if (source.tag !== undefined && source.tag !== "column") {
        throw new CardValidationError("card.feishu_invalid_column", "columns 中仅允许 column");
      }
      const width = source.width ?? "weighted";
      if (!new Set(["auto", "weighted"]).has(width)) {
        throw new CardValidationError("card.feishu_style_forbidden", "列宽样式不在允许列表中");
      }
      const weight = width === "weighted" ? Number(source.weight ?? 1) : null;
      if (weight !== null && (!Number.isSafeInteger(weight) || weight < 1 || weight > 12)) {
        throw new CardValidationError("card.feishu_invalid_column", "列权重无效");
      }
      if (!Array.isArray(source.elements) || source.elements.length === 0 || source.elements.length > 8) {
        throw new CardValidationError("card.feishu_invalid_column", "列内容数量无效");
      }
      return {
        width,
        ...(weight === null ? {} : { weight }),
        elements: source.elements.map((child) => convertElement(child, state, depth + 1))
      };
    })
  };
}

function convertTextObject(value, state, options) {
  const text = requireObject(value, "card.feishu_invalid_text", "飞书卡片文本无效");
  assertKnownKeys(text, TEXT_KEYS, "text");
  if (!new Set(options.allowMarkdown ? ["plain_text", "lark_md"] : ["plain_text"]).has(text.tag)) {
    throw new CardValidationError("card.feishu_invalid_text", "飞书卡片文本格式不受支持");
  }
  const content = normalizeText(text.content, state);
  if (options.required && !content) throw new CardValidationError("card.feishu_invalid_text", "飞书卡片文本不能为空");
  return { format: text.tag === "lark_md" ? "markdown" : "plain", text: content };
}

function normalizeText(value, state) {
  if (typeof value !== "string") throw new CardValidationError("card.feishu_invalid_text", "飞书卡片文本无效");
  const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "").trim();
  if (!text || HTML_PATTERN.test(text) || UNSAFE_TEXT_PATTERN.test(text)) {
    throw new CardValidationError("card.unsafe_content", "飞书卡片文本包含不安全内容");
  }
  state.textBytes += Buffer.byteLength(text, "utf8");
  if (state.textBytes > state.limits.maxTextBytes) throw new CardValidationError("card.text_too_large", "卡片文本超限");
  for (const match of text.matchAll(URL_PATTERN)) assertPublicHttpsUrl(match[0]);
  return text;
}

function assertPublicHttpsUrl(value) {
  let url;
  try {
    url = new URL(value.startsWith("//") ? `https:${value}` : value);
  } catch {
    throw new CardValidationError("card.invalid_url", "飞书卡片 URL 无效");
  }
  const hostname = url.hostname.replace(/^\[|\]$/gu, "").replace(/\.$/u, "").toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new CardValidationError("card.url_forbidden", "飞书卡片仅允许无凭据的 HTTPS URL");
  }
  if (!hostname || PRIVATE_HOST_SUFFIX.test(hostname) || isPrivateIp(hostname)) {
    throw new CardValidationError("card.private_url", "飞书卡片不允许私网 URL");
  }
}

function isPrivateIp(hostname) {
  const kind = isIP(hostname);
  if (kind === 4) {
    const [a, b] = hostname.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (kind === 6) {
    const normalized = hostname.toLowerCase();
    return normalized === "::" || normalized === "::1" || normalized.startsWith("::ffff:") || normalized.startsWith("fc") || normalized.startsWith("fd") || /^fe[89ab]/u.test(normalized);
  }
  return false;
}

function normalizeActionId(value, allowedActions) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[a-z][a-z0-9._-]{0,63}$/u.test(normalized) || !allowedActions.has(normalized)) {
    throw new CardValidationError("card.unknown_action", "飞书卡片动作未注册");
  }
  return normalized;
}

function normalizeAllowedActions(value) {
  const values = value === undefined ? FEISHU_CARD_ACTION_IDS : value;
  if (!Array.isArray(values)) throw new TypeError("allowedActions must be an array");
  const normalized = new Set();
  for (const action of values) {
    const id = typeof action === "string" ? action.trim().toLowerCase() : "";
    if (!ACTION_IDS.has(id)) throw new CardValidationError("card.unknown_action", "飞书卡片动作未注册");
    normalized.add(id);
  }
  return normalized;
}

function validateEmptyActionInput(value) {
  const input = requireObject(value, "card.feishu_invalid_action", "飞书卡片动作参数无效");
  if (Object.keys(input).length > 0) {
    throw new CardValidationError("card.feishu_action_input_forbidden", "飞书卡片动作不接受客户端参数");
  }
  return {};
}

async function executeFeishuAction(actionId, { db, actor, card, payload, clientActionId }) {
  const button = findActionButton(payload?.elements, actionId);
  if (!button) throw new CardValidationError("card.unknown_action", "飞书卡片动作未注册");
  const bot = await db.prepare(`SELECT b.id AS botId, b.bot_user_id AS botUserId
    FROM workspace_cards c
    INNER JOIN workspace_agent_bots b
      ON b.bot_user_id = c.created_by_user_id AND b.space_id = c.space_id AND b.status = 'active'
    WHERE c.id = ? AND c.space_id = ? AND c.source_kind = 'custom_bot'`)
    .get(card.id, card.spaceId);
  if (!bot) throw new CardValidationError("card.unknown_action", "飞书卡片动作未注册");
  await writeWorkspaceEvent(db, {
    type: "card.action",
    spaceId: card.spaceId,
    actorId: actor.id,
    conversationId: card.conversationId,
    targetType: "workspace.card",
    targetId: card.id,
    payload: {
      botId: bot.botId,
      botUserId: bot.botUserId,
      cardId: card.id,
      actionId,
      clientActionId,
      data: button.data
    }
  });
  return { result: { accepted: true, actionId } };
}

function findActionButton(elements, actionId) {
  if (!Array.isArray(elements)) return null;
  for (const element of elements) {
    if (element?.type === "actions") {
      const button = element.buttons?.find((candidate) => candidate?.actionId === actionId);
      if (button) return button;
    }
    if (element?.type === "columns") {
      for (const column of element.columns ?? []) {
        const button = findActionButton(column?.elements, actionId);
        if (button) return button;
      }
    }
  }
  return null;
}

function deriveFallbackText(payload) {
  const candidates = [payload.header?.title];
  for (const element of payload.elements) {
    if (element.type === "text") candidates.push(element.text);
    if (element.type === "note") candidates.push(element.parts?.map((part) => part.text).join(" "));
  }
  const text = candidates.find((candidate) => typeof candidate === "string" && candidate.trim())?.trim() ?? "Bot 卡片";
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function countNode(state, depth) {
  if (depth > state.limits.maxDepth) throw new CardValidationError("card.payload_too_deep", "卡片嵌套深度超限");
  state.nodes += 1;
  if (state.nodes > state.limits.maxNodes) throw new CardValidationError("card.payload_too_complex", "卡片节点数量超限");
}

function assertKnownKeys(value, allowed, label) {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new CardValidationError("card.feishu_unknown_field", `${label} 包含不支持的字段`);
}

function requireObject(value, code, message) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new CardValidationError(code, message);
  }
  return value;
}

function reverseTone(tone) {
  for (const [template, mapped] of HEADER_TONES) if (mapped === tone) return template;
  throw new CardValidationError("card.feishu_style_forbidden", "飞书卡片 header 样式不在允许列表中");
}

function toFeishuElement(element) {
  requireObject(element, "card.feishu_invalid_element", "飞书卡片映射元素无效");
  if (element.type === "text") return element.format === "markdown"
    ? { tag: "markdown", content: element.text }
    : { tag: "div", text: { tag: "plain_text", content: element.text } };
  if (element.type === "note") {
    if (!Array.isArray(element.parts)) throw new CardValidationError("card.feishu_invalid_note", "飞书卡片 note 映射无效");
    return { tag: "note", elements: element.parts.map((part) => {
      requireObject(part, "card.feishu_invalid_note", "飞书卡片 note 映射无效");
      return { tag: part.format === "markdown" ? "lark_md" : "plain_text", content: part.text };
    }) };
  }
  if (element.type === "divider") return { tag: "hr" };
  if (element.type === "actions") {
    if (!Array.isArray(element.buttons)) throw new CardValidationError("card.feishu_invalid_actions", "飞书卡片按钮映射无效");
    return { tag: "action", actions: element.buttons.map((button) => {
      requireObject(button, "card.feishu_invalid_button", "飞书卡片按钮映射无效");
      return { tag: "button", text: { tag: "plain_text", content: button.label }, type: button.style, value: { action_id: button.actionId, data: button.data } };
    }) };
  }
  if (element.type === "columns") {
    if (!Array.isArray(element.columns)) throw new CardValidationError("card.feishu_invalid_columns", "飞书卡片 columns 映射无效");
    return { tag: "column_set", columns: element.columns.map((column) => {
      requireObject(column, "card.feishu_invalid_column", "飞书卡片列映射无效");
      if (!Array.isArray(column.elements)) throw new CardValidationError("card.feishu_invalid_column", "飞书卡片列映射无效");
      return { tag: "column", width: column.width, ...(column.weight ? { weight: column.weight } : {}), elements: column.elements.map(toFeishuElement) };
    }) };
  }
  throw new CardValidationError("card.feishu_unknown_element", "飞书卡片包含不支持的元素");
}
