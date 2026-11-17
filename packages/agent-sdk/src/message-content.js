export const AGENT_MESSAGE_FORMAT = "duallane.message+json;v=1";
const MESSAGE_REFERENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MESSAGE_BLOCK_FIELDS = Object.freeze({
  text: ["text"], mention: ["userId", "label"], link: ["url", "label"],
  attachment: ["attachmentId"], emoji: ["shortcode"],
  emote_collection: ["shareId"], topic_reference: ["topicId", "title"], card: ["cardId", "cardType", "schemaVersion", "fallbackText"],
});

function messageInvalid(code = "message.invalid_content") {
  return Object.assign(new TypeError("Invalid structured DualLane message"), { code });
}

function messageReference(value) {
  if (typeof value !== "string" || !MESSAGE_REFERENCE_ID.test(value)) throw messageInvalid("message.invalid_reference");
  return value;
}

export function messageText(text) {
  if (typeof text !== "string" || !text || text.length > 30_000) throw messageInvalid();
  return { type: "text", text };
}

export function messageMention(userId, label = "") {
  if (typeof label !== "string" || label.length > 180) throw messageInvalid();
  return { type: "mention", userId: messageReference(userId), label };
}

export function messageAttachment(attachmentId) {
  return { type: "attachment", attachmentId: messageReference(attachmentId) };
}

export function messageLink(url, label = "") {
  let parsed;
  try { parsed = new URL(url); } catch { throw messageInvalid("message.invalid_link"); }
  if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password || String(url).length > 4096 || typeof label !== "string" || label.length > 1000) throw messageInvalid("message.invalid_link");
  return { type: "link", url: parsed.href, label };
}

function normalizeMessageBlock(block) {
  if (!block || typeof block !== "object" || Array.isArray(block)) throw messageInvalid();
  switch (block.type) {
    case "text": return messageText(block.text);
    case "mention": return messageMention(block.userId, block.label);
    case "attachment": return messageAttachment(block.attachmentId);
    case "link": return messageLink(block.url, block.label);
    case "emoji":
      if (typeof block.shortcode !== "string" || !/^(?:[a-z0-9_+\-]{1,64}|custom:[A-Za-z0-9._:-]{1,128})$/u.test(block.shortcode)) throw messageInvalid();
      return { type: "emoji", shortcode: block.shortcode };
    case "emote_collection": return { type: "emote_collection", shareId: messageReference(block.shareId) };
    case "topic_reference":
      if (typeof block.title !== "string" || block.title.length > 300) throw messageInvalid();
      return { type: "topic_reference", topicId: messageReference(block.topicId), title: block.title };
    case "card":
      if (typeof block.cardType !== "string" || block.cardType.length > 100 || !Number.isSafeInteger(block.schemaVersion) || block.schemaVersion < 1 || typeof block.fallbackText !== "string" || block.fallbackText.length > 3000) throw messageInvalid();
      return { type: "card", cardId: messageReference(block.cardId), cardType: block.cardType, schemaVersion: block.schemaVersion, fallbackText: block.fallbackText };
    default: throw messageInvalid("message.unsupported_block");
  }
}

function messageBlockFallback(block) {
  switch (block.type) {
    case "text": return block.text;
    case "mention": return `@${block.label || block.userId}`;
    case "link": return block.label || block.url;
    case "attachment": return "[附件]";
    case "emoji": return `:${block.shortcode}:`;
    case "emote_collection": return "[表情合集]";
    case "topic_reference": return block.title;
    case "card": return block.fallbackText;
    default: return "[不支持的消息内容]";
  }
}

/** Canonical outbound representation; the server still validates IDs and ACLs. */
export function buildMessageContent(input) {
  const blocks = Array.isArray(input) ? input : input?.blocks;
  if (!Array.isArray(blocks) || blocks.length < 1 || blocks.length > 100 || (input?.format !== undefined && input.format !== AGENT_MESSAGE_FORMAT)) throw messageInvalid();
  const normalized = blocks.map(normalizeMessageBlock);
  const plainText = normalized.map(messageBlockFallback).join("");
  if (plainText.length > 30_000 || Buffer.byteLength(JSON.stringify(normalized)) > 128 * 1024) throw messageInvalid("message.content_limit");
  return { format: AGENT_MESSAGE_FORMAT, blocks: normalized, plainText };
}

/** Unknown read blocks remain visible as unsupported; never silently re-send them. */
export function parseMessageContent(input) {
  if (!input || input.format !== AGENT_MESSAGE_FORMAT || !Array.isArray(input.blocks) || input.blocks.length > 100) throw messageInvalid();
  const unsupportedBlockTypes = [];
  const blocks = input.blocks.map((block) => {
    if (!Object.hasOwn(MESSAGE_BLOCK_FIELDS, block?.type)) {
      const originalType = typeof block?.type === "string" ? block.type.slice(0, 64) : "unknown";
      unsupportedBlockTypes.push(originalType);
      return { type: "unsupported", originalType };
    }
    return normalizeMessageBlock(block);
  });
  return { format: AGENT_MESSAGE_FORMAT, blocks,
    plainText: typeof input.plainText === "string" ? input.plainText.slice(0, 30_000) : blocks.map(messageBlockFallback).join(""),
    unsupportedBlockTypes, complete: unsupportedBlockTypes.length === 0 };
}

export const AGENT_MESSAGE_CONTENT_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false,
  properties: { format: { const: AGENT_MESSAGE_FORMAT }, plainText: { type: "string", maxLength: 30_000, description: "Optional display fallback; the server canonicalizes it." },
    blocks: { type: "array", minItems: 1, maxItems: 100,
      items: { oneOf: Object.entries(MESSAGE_BLOCK_FIELDS).map(([type, fields]) => ({
        type: "object", additionalProperties: false,
        properties: { type: { const: type }, ...Object.fromEntries(fields.map((field) => [field,
          field === "schemaVersion" ? { type: "integer", minimum: 1 }
            : { type: "string", ...(field.endsWith("Id") ? { pattern: MESSAGE_REFERENCE_ID.source, maxLength: 128 } : { maxLength: field === "text" ? 30_000 : field === "url" ? 4096 : 3000 }) }])) },
        required: ["type", ...fields.filter((field) => field !== "label")],
      })) } } },
  required: ["format", "blocks"],
});
