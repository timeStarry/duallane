import { validateArtifactBytes } from "./media.js";

// Only the trigger's logical references enter the model input; history and
// generated local paths do not implicitly authorize another download.
export async function prepareAgentInputs({ client, event, triggerMessage, context, conversation, scopes = [], signal }) {
  const conversationId = event?.conversationId;
  const messageId = triggerMessage?.id;
  if (!conversationId || !messageId || (conversation?.id && conversation.id !== conversationId)) return [];
  const authorized = context?.messages?.find((message) => message.id === messageId);
  if (!authorized) return [];
  const blocks = Array.isArray(authorized.content?.blocks) ? authorized.content.blocks : [];
  const ids = [...new Set(blocks.filter((block) => block.type === "attachment").map((block) => block.attachmentId).filter((id) => typeof id === "string"))];
  if (ids.length > 6) throw Object.assign(new Error("Too many input attachments"), { code: "input.attachment_limit" });
  const canRead = scopes.includes("messages:read_context") && scopes.includes("files:read_content");
  const canPreview = scopes.includes("messages:read_context") && scopes.includes("files:read_preview");
  let remaining = 10 * 1024 * 1024;
  const inputs = [];
  for (const attachmentId of ids) {
    const reference = { attachmentId, messageId, conversationId };
    if (!canRead && !canPreview) {
      inputs.push({ ...reference, status: "unavailable", code: "input.attachment_scope_required" });
      continue;
    }
    if (remaining <= 0) throw Object.assign(new Error("Input attachments exceed the byte limit"), { code: "input.attachment_limit" });
    try {
      const mode = canRead ? "content" : "preview";
      const result = await client.readAttachment({ ...reference, mode, maxBytes: Math.min(remaining, mode === "preview" ? 64 * 1024 : remaining), signal });
      const available = remaining;
      remaining -= result.bytes.byteLength;
      // A currently authorized DL attachment is distinct from an arbitrary
      // public URL. Validate its opaque envelope without rendering/executing it.
      const checked = validateArtifactBytes(result.bytes, result.mimeType, { source: "inline", maxBytes: available });
      const textInput = checked.mimeType.startsWith("text/") || ["application/json", "application/xml", "application/javascript"].includes(checked.mimeType);
      inputs.push({
        ...reference,
        status: "available",
        kind: checked.mimeType.startsWith("image/") ? "image" : textInput ? "text" : "document",
        mimeType: checked.mimeType,
        byteSize: result.bytes.byteLength,
        encoding: textInput ? "utf8" : "base64",
        data: Buffer.from(result.bytes).toString(textInput ? "utf8" : "base64"),
        trust: "untrusted-attachment",
      });
    } catch (error) {
      if (error?.code === "sdk.aborted") throw error;
      if (error?.code === "gateway.response_too_large") remaining = 0;
      const code = typeof error?.code === "string" && /^[a-z0-9][a-z0-9._-]{0,80}$/u.test(error.code) ? error.code : "input.attachment_unavailable";
      inputs.push({ ...reference, status: "unavailable", code });
    }
  }
  return inputs;
}
