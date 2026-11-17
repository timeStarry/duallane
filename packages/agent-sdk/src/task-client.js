import crypto from "node:crypto";

const SCOPED_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function scopedTaskError(code) {
  return Object.assign(new Error("DualLane task operation is unavailable"), { name: "DualLaneAgentError", code, retryable: false });
}

function scopedTaskExpiry(value) {
  const time = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(time)) throw scopedTaskError("task.invalid_context");
  return time;
}

/** A task is a revocable server grant, never a replacement for the Bot credential. */
export function createTaskScopedClient(client, task, options = {}) {
  if (!task || !SCOPED_TASK_ID.test(task.id || "") || !SCOPED_TASK_ID.test(task.conversationId || "") || typeof client.getTask !== "function") throw scopedTaskError("task.invalid_context");
  const initial = { id: task.id, conversationId: task.conversationId, triggerMessageId: task.triggerMessageId, expiresAt: scopedTaskExpiry(task.expiresAt) };
  const now = options.now ?? Date.now;
  const limit = (value, fallback, max) => Number.isSafeInteger(value) && value > 0 ? Math.min(value, max) : fallback;
  const maxCalls = limit(options.maxCalls, 32, 128);
  const maxResultBytes = limit(options.maxResultBytes, 16 * 1024 * 1024, 64 * 1024 * 1024);
  const deadline = Math.min(initial.expiresAt, now() + limit(options.timeoutMs, 300_000, 600_000));
  let calls = 0, resultBytes = 0, closed = false;
  const controller = new AbortController();
  const abort = () => { closed = true; controller.abort(); };
  options.signal?.addEventListener("abort", abort, { once: true });
  const assertOpen = () => {
    if (closed || options.signal?.aborted) throw scopedTaskError("task.cancelled");
    if (now() >= deadline) throw scopedTaskError("task.expired");
  };
  function conversation(value = initial.conversationId) {
    assertOpen();
    if (value !== initial.conversationId) throw scopedTaskError("task.conversation_mismatch");
    return value;
  }
  async function run(operation) {
    assertOpen();
    if (calls >= maxCalls || resultBytes >= maxResultBytes) throw scopedTaskError("context.budget_exhausted");
    calls++;
    const checked = await client.getTask(initial.id, { signal: controller.signal });
    assertOpen();
    const current = checked?.task;
    if (!current || current.id !== initial.id || current.conversationId !== initial.conversationId || current.triggerMessageId !== initial.triggerMessageId || scopedTaskExpiry(current.expiresAt) <= now() || ["cancelled", "expired", "revoked"].includes(current.status)) throw scopedTaskError("task.authorization_denied");
    const result = await operation(controller.signal);
    assertOpen();
    const bytes = result?.bytes instanceof Uint8Array ? result.bytes.byteLength : Buffer.byteLength(JSON.stringify(result ?? null));
    resultBytes += bytes;
    if (resultBytes > maxResultBytes) throw scopedTaskError("context.budget_exhausted");
    const messageConversation = result?.message?.conversationId;
    if (messageConversation && messageConversation !== initial.conversationId) throw scopedTaskError("task.conversation_mismatch");
    return result;
  }
  async function requireFeature(feature) {
    const capabilities = await run((signal) => client.getCapabilities(initial.conversationId, { signal }));
    if (capabilities?.features?.[feature] !== true) throw scopedTaskError("task.operation_unavailable");
  }
  function reference(operation, key) { return { taskId: initial.id, operation, key }; }
  async function mutation(operation, key, execute) {
    const operationReference = reference(operation, key);
    try { return { ...await run(execute), operation: operationReference }; }
    catch (error) { error.operation = operationReference; throw error; }
  }
  const scoped = {
    task: Object.freeze({ ...initial }),
    close() { abort(); options.signal?.removeEventListener("abort", abort); },
    budget() { return { calls, maxCalls, resultBytes, maxResultBytes, expiresAt: deadline }; },
    validate() { return run(async () => ({ valid: true })); },
    getCapabilities() { return run((signal) => client.getCapabilities(initial.conversationId, { signal })); },
    getOperation(operation, key) { return run((signal) => client.getOperation(initial.id, operation, key, { signal })); },
    getContext(id = initial.conversationId, input = {}) { return run((signal) => client.getContext(conversation(id), { ...input, signal, limit: Math.min(input.limit ?? 12, 50) })); },
    getMessage(messageId, input = {}) { return run((signal) => client.getMessage(messageId, { ...input, conversationId: initial.conversationId, signal })); },
    listHistory(id = initial.conversationId, input = {}) { return run((signal) => client.listHistory(conversation(id), { ...input, signal, limit: Math.min(input.limit ?? 12, 50) })); },
    searchMessages(id = initial.conversationId, input = {}) { return run((signal) => client.searchMessages(conversation(id), { ...input, signal, limit: Math.min(input.limit ?? 12, 50) })); },
    listMembers(id = initial.conversationId) { return run((signal) => client.listMembers(conversation(id), { signal })); },
    sendMessage(input) { conversation(input?.conversationId); return run((signal) => client.sendMessage({ ...input, signal })); },
    async editMessage(messageId, input, options = {}) {
      await requireFeature("conditionalMessageEdit");
      const update = typeof input === "string" ? { plainText: input, expectedVersion: options.expectedVersion } : { ...input };
      if (update.expectedVersion === undefined) update.expectedVersion = (await scoped.getMessage(messageId))?.message?.version;
      if (!/^[a-f0-9]{64}$/u.test(update.expectedVersion || "")) throw scopedTaskError("message.version_required");
      const key = "edit_" + crypto.createHash("sha256").update(`${messageId}:${update.expectedVersion}`).digest("hex");
      return mutation("message.edit", key, (signal) => client.editMessage(messageId, update, { signal }));
    },
    sendCard(input) { conversation(input?.conversationId); return run((signal) => client.sendCard({ ...input, signal })); },
    sendFeishuCard(input) { conversation(input?.conversationId); return run((signal) => client.sendFeishuCard({ ...input, signal })); },
    async updateCard(cardId, input = {}) {
      await requireFeature("taskCardUpdate");
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw scopedTaskError("card.revision_required");
      const key = "card_" + crypto.createHash("sha256").update(`${cardId}:${input.expectedRevision}`).digest("hex");
      return mutation("card.update", key, (signal) => client.updateCard(cardId, { ...input, signal }));
    },
    async updateFeishuCard(cardId, input = {}) {
      await requireFeature("taskCardUpdate");
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw scopedTaskError("card.revision_required");
      const key = "card_" + crypto.createHash("sha256").update(`${cardId}:${input.expectedRevision}`).digest("hex");
      return mutation("card.update", key, (signal) => client.updateFeishuCard(cardId, { ...input, signal }));
    },
    sendFile(input) { conversation(input?.conversationId); return run((signal) => client.sendFile({ ...input, signal })); },
    uploadFile(input) { conversation(input?.conversationId); return run((signal) => client.uploadFile({ ...input, signal })); },
    reserveUpload(input) { conversation(input?.conversationId); return run((signal) => client.reserveUpload({ ...input, signal })); },
    completeUploadContent(uploadId, bytes, mimeType) { return run((signal) => client.completeUploadContent(uploadId, bytes, mimeType, { signal })); },
    getUploadStatus(uploadId) { return run((signal) => client.getUploadStatus(uploadId, { signal })); },
    readAttachment(input) { conversation(input?.conversationId); return run((signal) => client.readAttachment({ ...input, signal })); },
    setTyping(id, input = {}) { conversation(id); return client.setTyping(id, { ...input, signal: input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal }); },
  };
  return Object.freeze(scoped);
}
