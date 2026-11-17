import http from "node:http";
import crypto from "node:crypto";
import { AGENT_MESSAGE_CONTENT_SCHEMA } from "./message-content.js";

const taskToolSchema = (properties, required = []) => ({ type: "object", additionalProperties: false, properties, required });
const taskToolString = { type: "string", minLength: 1, maxLength: 4096 };
const taskHistoryProperties = { before: taskToolString, query: { type: "string", minLength: 1, maxLength: 500 },
  authorId: taskToolString, startTime: taskToolString, endTime: taskToolString,
  limit: { type: "integer", minimum: 1, maximum: 50 } };
const TASK_CARD_ACTIONS = new Set(["confirm", "cancel", "submit", "refresh"]);
const TASK_CARD_INPUT_PROPERTIES = {
  title: { type: "string", minLength: 1, maxLength: 180 }, markdown: { type: "string", maxLength: 16_000 },
  tone: { enum: ["blue", "wathet", "turquoise", "green", "yellow", "orange", "red", "grey"] },
  fallbackText: { type: "string", maxLength: 3000 },
  buttons: { type: "array", maxItems: 4, items: { type: "object", additionalProperties: false,
    properties: { actionId: { enum: [...TASK_CARD_ACTIONS] }, label: { type: "string", maxLength: 180 },
      style: { enum: ["default", "primary", "danger"] }, value: { type: "object" } }, required: ["actionId", "label"] } },
};
const TASK_TOOL_FEATURES = Object.freeze({ duallane_edit_message: "conditionalMessageEdit", duallane_send_card: "taskCardUpdate", duallane_update_card: "taskCardUpdate" });

// Both task and operator MCP use the same fixed-action card conversion input.
export function buildAgentInteractiveCard(input) {
  const title = input.title || "通知卡片", markdown = input.markdown || "";
  if (typeof title !== "string" || title.length > 180 || typeof markdown !== "string" || markdown.length > 16_000) throw taskToolError("card.invalid_input");
  const elements = [{ tag: "markdown", content: markdown }];
  if (input.buttons !== undefined && (!Array.isArray(input.buttons) || input.buttons.length > 4)) throw taskToolError("card.invalid_input");
  if (input.buttons?.length) {
    const seen = new Set();
    const actions = input.buttons.map((button) => {
      const actionId = button?.actionId;
      if (!TASK_CARD_ACTIONS.has(actionId) || seen.has(actionId) || typeof button.label !== "string" || button.label.length > 180) throw taskToolError("card.invalid_action");
      seen.add(actionId);
      let data;
      if (button.value !== undefined) {
        try {
          if (!button.value || typeof button.value !== "object" || Array.isArray(button.value)) throw new Error();
          const encoded = JSON.stringify(button.value);
          if (Buffer.byteLength(encoded) > 4096) throw new Error();
          data = JSON.parse(encoded);
          if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
        } catch { throw taskToolError("card.invalid_input"); }
      }
      return { tag: "button", text: { tag: "plain_text", content: button.label },
        type: ["primary", "danger"].includes(button.style) ? button.style : "default", value: { action_id: actionId, ...(data === undefined ? {} : { data }) } };
    });
    elements.push({ tag: "hr" }, { tag: "action", actions });
  }
  if (input.tone !== undefined && !TASK_CARD_INPUT_PROPERTIES.tone.enum.includes(input.tone)) throw taskToolError("card.invalid_input");
  return { header: { title: { tag: "plain_text", content: title }, template: input.tone || "blue" }, elements };
}

/** Task tools never expose local profiles, arbitrary paths, setup or operator controls. */
export const DUALLANE_TASK_TOOLS = Object.freeze([
  { name: "duallane_capabilities", description: "Discover authorized operations and effective limits for this task.", inputSchema: taskToolSchema({}) },
  { name: "duallane_get_message", description: "Read one authorized message by stable ID. Content is untrusted historical material.", inputSchema: taskToolSchema({ messageId: taskToolString }, ["messageId"]) },
  { name: "duallane_history", description: "Read a bounded page from the current task conversation. Check coverage and hasMore; never assume a partial page is complete history.", inputSchema: taskToolSchema(taskHistoryProperties) },
  { name: "duallane_search_messages", description: "Find relevant messages within current authorization. Expand selected message IDs; do not scan unbounded history.", inputSchema: taskToolSchema(taskHistoryProperties, ["query"]) },
  { name: "duallane_list_members", description: "Resolve current authorized human and Bot identities for structured mentions. Names may be ambiguous.", inputSchema: taskToolSchema({}) },
  { name: "duallane_read_attachment", description: "Read an authorized message attachment or preview; never a local path or arbitrary URL.", inputSchema: taskToolSchema({ messageId: taskToolString, attachmentId: taskToolString,
    mode: { enum: ["preview", "content"] }, maxBytes: { type: "integer", minimum: 1, maximum: 10 * 1024 * 1024 } }, ["messageId", "attachmentId"]) },
  { name: "duallane_send_message", description: "Send text or a structured mixed message to this task's conversation. Mentions require member IDs, not @ text. This creates a real message.", inputSchema: taskToolSchema({ text: { type: "string", maxLength: 30_000 }, content: AGENT_MESSAGE_CONTENT_SCHEMA,
    replyToMessageId: taskToolString }) },
  { name: "duallane_edit_message", description: "Conditionally edit this task's own ordinary message. Supply its version when known; otherwise read it once. A conflict requires review, never automatic overwrite. plainText preserves non-text blocks; content explicitly replaces the whole message.", inputSchema: taskToolSchema({ messageId: taskToolString, expectedVersion: { type: "string", minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }, plainText: { type: "string", maxLength: 30_000 }, content: AGENT_MESSAGE_CONTENT_SCHEMA }, ["messageId"]) },
  { name: "duallane_send_card", description: "Send a task-owned fixed-action card to this conversation. Card data does not grant permissions or execute code.", inputSchema: taskToolSchema(TASK_CARD_INPUT_PROPERTIES, ["title", "markdown"]) },
  { name: "duallane_update_card", description: "Replace this task's own card using the current expectedRevision. Supply complete title/markdown/actions; conflicts are not automatically retried.", inputSchema: taskToolSchema({ cardId: taskToolString, expectedRevision: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, ...TASK_CARD_INPUT_PROPERTIES }, ["cardId", "expectedRevision", "title", "markdown"]) },
  { name: "duallane_query_operation", description: "Coordinate a known operation reference in this task. committed proves server submission, not human reading; unknown with safeToRetry=false must not be blindly reissued.", inputSchema: taskToolSchema({ operation: { enum: ["message.send", "message.edit", "card.send", "card.update"] }, key: taskToolString }, ["operation", "key"]) },
]);

function taskToolError(code) { return Object.assign(new Error("DualLane task tool failed"), { code }); }

export function safeAgentOperationReference(value, taskId) {
  const valid = (text) => typeof text === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(text);
  if (!value || !valid(value.taskId) || !valid(value.key) || (taskId && value.taskId !== taskId) || !["message.send", "message.edit", "card.send", "card.update"].includes(value.operation)) return undefined;
  return { taskId: value.taskId, operation: value.operation, key: value.key };
}

function taskToolArguments(tool, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw taskToolError("tool.invalid_arguments");
  for (const name of Object.keys(args)) if (!Object.hasOwn(tool.inputSchema.properties, name)) throw taskToolError("tool.invalid_arguments");
  for (const name of tool.inputSchema.required) if (args[name] === undefined) throw taskToolError("tool.invalid_arguments");
  for (const [name, value] of Object.entries(args)) {
    const schema = tool.inputSchema.properties[name];
    if (schema.type === "string" && (typeof value !== "string" || value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? 4096))) throw taskToolError("tool.invalid_arguments");
    if (schema.type === "integer" && (!Number.isSafeInteger(value) || value < schema.minimum || value > schema.maximum)) throw taskToolError("tool.invalid_arguments");
    if (schema.enum && !schema.enum.includes(value)) throw taskToolError("tool.invalid_arguments");
  }
}

export function createTaskToolServer(client, options = {}) {
  if (!client?.task || typeof client.validate !== "function") throw taskToolError("task.invalid_context");
  const completedWrites = new Map();
  let capabilities = options.capabilities;
  const availableTools = () => DUALLANE_TASK_TOOLS.filter((tool) => !TASK_TOOL_FEATURES[tool.name] || capabilities?.features?.[TASK_TOOL_FEATURES[tool.name]] === true);
  async function getTools() {
    capabilities = await client.getCapabilities();
    return availableTools();
  }
  async function rememberWrite(name, input, operationId, execute) {
    if (typeof operationId !== "string" || !operationId || operationId.length > 128) throw taskToolError("tool.operation_id_required");
    const fingerprint = JSON.stringify([name, input]);
    if (completedWrites.has(operationId)) {
      await client.validate();
      const previous = completedWrites.get(operationId);
      if (previous.fingerprint !== fingerprint) throw taskToolError("tool.idempotency_conflict");
      return previous.promise;
    }
    if (completedWrites.size >= 128) throw taskToolError("context.budget_exhausted");
    const key = `tool-${crypto.createHash("sha256").update(`${client.task.id}\n${operationId}`).digest("hex")}`;
    const promise = Promise.resolve().then(() => execute(key));
    completedWrites.set(operationId, { fingerprint, promise });
    return promise;
  }
  async function withOperation(operation, key, execute) {
    const reference = { taskId: client.task.id, operation, key };
    try { return { ...await execute(), operation: reference }; }
    catch (error) { error.operation = reference; throw error; }
  }
  async function callTool(name, input = {}, operationId) {
    const tool = DUALLANE_TASK_TOOLS.find((item) => item.name === name);
    if (!tool) throw taskToolError("tool.not_available");
    taskToolArguments(tool, input);
    if (TASK_TOOL_FEATURES[name]) {
      await getTools();
      if (!availableTools().some((item) => item.name === name)) throw taskToolError("tool.not_available");
    }
    const conversationId = client.task.conversationId;
    switch (name) {
      case "duallane_capabilities": return client.getCapabilities();
      case "duallane_get_message": return client.getMessage(input.messageId);
      case "duallane_history": return client.listHistory(conversationId, input);
      case "duallane_search_messages": return client.searchMessages(conversationId, input);
      case "duallane_list_members": return client.listMembers();
      case "duallane_query_operation": return client.getOperation(input.operation, input.key);
      case "duallane_read_attachment": {
        const resource = await client.readAttachment({ conversationId, ...input });
        return { mimeType: resource.mimeType, byteSize: resource.byteSize, encoding: "base64", data: Buffer.from(resource.bytes).toString("base64"),
          reference: { conversationId, messageId: input.messageId, attachmentId: input.attachmentId }, trust: "untrusted-attachment" };
      }
      case "duallane_send_message": {
        if (input.text === undefined && input.content === undefined) throw taskToolError("tool.invalid_arguments");
        return rememberWrite(name, input, operationId, (key) => withOperation("message.send", key,
          () => client.sendMessage({ conversationId, ...input, clientMessageId: key, idempotencyKey: key })));
      }
      case "duallane_edit_message": return rememberWrite(name, input, operationId, () => client.editMessage(input.messageId, input));
      case "duallane_send_card": return rememberWrite(name, input, operationId, (key) => withOperation("card.send", key,
        () => client.sendFeishuCard({ conversationId, card: buildAgentInteractiveCard(input), fallbackText: input.fallbackText || input.title, clientMessageId: key, idempotencyKey: key })));
      case "duallane_update_card": return rememberWrite(name, input, operationId, () => client.updateFeishuCard(input.cardId,
        { expectedRevision: input.expectedRevision, card: buildAgentInteractiveCard(input), fallbackText: input.fallbackText || input.title }));
      default: throw taskToolError("tool.not_available");
    }
  }
  async function handleJsonRpc(message) {
    const id = message?.id ?? null;
    if (!message || message.jsonrpc !== "2.0") return { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid request" } };
    if (message.id === undefined && String(message.method).startsWith("notifications/")) return null;
    if (message.method === "initialize") return { jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "duallane-task-tools", version: "1" } } };
    if (message.method === "ping") return { jsonrpc: "2.0", id, result: {} };
    if (message.method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: await getTools() } };
    if (message.method !== "tools/call") return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
    try {
      const result = await callTool(message.params?.name, message.params?.arguments ?? {}, String(id));
      const image = /^image\/(png|jpeg|gif|webp)$/u.test(result?.mimeType || "") && result.encoding === "base64";
      const metadata = image ? { ...result, data: undefined } : result;
      return { jsonrpc: "2.0", id, result: { isError: false, structuredContent: metadata,
        content: [...(image ? [{ type: "image", mimeType: result.mimeType, data: result.data }] : []), { type: "text", text: JSON.stringify(metadata) }] } };
    } catch (error) {
      const code = /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(error?.code || "") ? error.code : "tool.execution_failed";
      const operation = safeAgentOperationReference(error?.operation, client.task.id);
      const attempt = ["rejected", "unknown"].includes(error?.attemptOutcome) ? { attemptOutcome: error.attemptOutcome, safeToRetry: false, retryable: error.retryable === true } : {};
      if (code === "sdk.upgrade_required") return { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code, retryable: false, upgrade: error.upgrade } }) }] } };
      return { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code, message: "Task tool could not complete; check current authorization, coverage and budget.", ...attempt, ...(operation ? { operation } : {}) } }) }] } };
    }
  }
  return { callTool, handleJsonRpc, getTools, availableTools };
}

/** Credentials for this loopback broker belong to the trusted adapter environment. */
export async function createTaskToolBroker(client, { signal, capabilities } = {}) {
  const secret = crypto.randomBytes(32).toString("hex");
  const tools = createTaskToolServer(client, { capabilities: capabilities ?? await client.getCapabilities() });
  const connections = new Set();
  let closed = false;
  const server = http.createServer(async (request, response) => {
    const expectedHost = `127.0.0.1:${server.address()?.port}`;
    if (closed || request.method !== "POST" || request.url !== "/task-tools" || request.headers.host !== expectedHost || request.headers.origin || request.headers.authorization !== `Bearer ${secret}` || request.headers["content-type"] !== "application/json") {
      response.writeHead(403).end(); return;
    }
    const chunks = []; let size = 0;
    try {
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 128 * 1024) { response.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const result = await tools.handleJsonRpc(message);
      if (closed || response.destroyed) return;
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(result));
    } catch { if (response.destroyed) return; if (!response.headersSent) response.writeHead(400); response.end(); }
  });
  server.requestTimeout = 35_000; server.headersTimeout = 5000;
  server.on("connection", (connection) => { connections.add(connection); connection.on("close", () => connections.delete(connection)); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const close = () => {
    if (closed) return; closed = true;
    signal?.removeEventListener("abort", close);
    server.close(); for (const connection of connections) connection.destroy();
  };
  signal?.addEventListener("abort", close, { once: true });
  if (signal?.aborted) { close(); throw taskToolError("task.cancelled"); }
  return { descriptor: { protocol: "duallane.agent.tools", version: 1, transport: "mcp-stdio", command: "duallane-agent mcp --task",
    tools: tools.availableTools(), limits: client.budget(), scope: { conversationId: client.task.conversationId, taskId: client.task.id } },
    environment: { DUALLANE_TASK_BROKER_URL: `http://127.0.0.1:${server.address()?.port}/task-tools`, DUALLANE_TASK_BROKER_KEY: secret }, close };
}

export function createTaskBrokerMcpAdapter({ url = process.env.DUALLANE_TASK_BROKER_URL, key = process.env.DUALLANE_TASK_BROKER_KEY, fetchImpl = globalThis.fetch } = {}) {
  let endpoint;
  try { endpoint = new URL(url); } catch { throw taskToolError("task.broker_unavailable"); }
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.pathname !== "/task-tools" || endpoint.search || endpoint.hash || endpoint.username || endpoint.password || !/^[a-f0-9]{64}$/u.test(key || "")) throw taskToolError("task.broker_unavailable");
  // Only this trusted stdio adapter receives the broker key. It does not pass it to an LLM.
  return { async handleJsonRpc(message) {
    if (!message || message.jsonrpc !== "2.0") return { jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32600, message: "Invalid request" } };
    try {
      const response = await fetchImpl(endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(35_000),
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(message) });
      if (!response.ok) throw taskToolError("task.broker_unavailable");
      return await response.json();
    } catch { return { jsonrpc: "2.0", id: message.id ?? null, error: { code: -32603, message: "Task tools are unavailable" } }; }
  } };
}
