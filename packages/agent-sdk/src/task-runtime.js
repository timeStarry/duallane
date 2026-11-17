import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AgentRuntimeError, buildAgentBridgeRequest, parseAgentBridgeResult, safeAgentError } from "./bridge-protocol.js";

const TASK_TERMINAL = new Set(["completed", "failed", "cancelled"]);
const TASK_FILE_LIMIT = 16 * 1024 * 1024;
const taskDigest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const taskCheckCancelled = (signal) => { if (signal?.aborted) throw new AgentRuntimeError("task.cancelled"); };

function taskStartThinking(client, conversationId, signal) {
  if (typeof client.setTyping !== "function" || signal.aborted) return () => {};
  const request = new AbortController();
  let stopped = false, pending = false;
  const renew = () => {
    if (stopped || pending || signal.aborted) return;
    pending = true;
    // This six-second server lease is advisory; a failed heartbeat cannot fail
    // a business task or accumulate overlapping requests on a slow gateway.
    Promise.resolve().then(() => {
      if (!stopped) return client.setTyping(conversationId, { state: "thinking", signal: request.signal, timeoutMs: 3000 });
    }).catch(() => {}).finally(() => { pending = false; });
  };
  const timer = setInterval(renew, 3800);
  timer.unref?.();
  const stop = () => {
    stopped = true; clearInterval(timer); request.abort();
    signal.removeEventListener("abort", stop);
  };
  signal.addEventListener("abort", stop, { once: true });
  renew();
  return stop;
}

function taskPrivateDirectory(directory) {
  const resolved = path.resolve(directory);
  let cursor = path.parse(resolved).root;
  for (const segment of resolved.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (!fs.existsSync(cursor)) fs.mkdirSync(cursor, { mode: 0o700 });
    const stat = fs.lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new AgentRuntimeError("runtime.unsafe_state_path");
  }
  if (process.platform !== "win32" && (fs.statSync(resolved).mode & 0o077) !== 0) throw new AgentRuntimeError("runtime.state_permissions");
  return resolved;
}

function taskReadFile(file, maxBytes = TASK_FILE_LIMIT) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxBytes) throw new AgentRuntimeError("runtime.unsafe_state_file");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new AgentRuntimeError("runtime.state_permissions");
  return fs.readFileSync(file);
}

function taskAtomicWrite(file, bytes) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    if (fs.existsSync(file)) taskReadFile(file);
    fs.renameSync(temporary, file);
    // Persist the rename where directory fsync is supported.
    if (process.platform !== "win32") {
      const directoryFd = fs.openSync(path.dirname(file), "r");
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function taskIdentity(origin, botId) {
  const base = new URL(origin);
  if (base.username || base.password || !["https:", "http:"].includes(base.protocol) || typeof botId !== "string" || !botId.trim()) throw new AgentRuntimeError("runtime.invalid_identity");
  return taskDigest(`${base.origin}\n${botId}`);
}

function taskEventFingerprint(event) {
  const messageId = event.payload?.messageId || event.payload?.message?.id || event.messageId;
  // Replay reprojects current authorized text. An edit does not create a new
  // event or replace an already accepted task's input and publication receipts.
  const identity = event.type === "message.created" && typeof messageId === "string" && messageId
    ? { messageId } : event.payload || null;
  return taskDigest(JSON.stringify([event.type, event.conversationId, identity]));
}

function taskOwnerAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code !== "ESRCH"; }
}

function acquireTaskOwner(directory) {
  const lock = path.join(directory, "owner.json");
  const gate = path.join(directory, "owner-acquisition");
  const recovery = path.join(directory, "owner-recovery");
  if (fs.existsSync(recovery)) throw new AgentRuntimeError("runtime.owner_recovery_active");
  try { fs.mkdirSync(gate, { mode: 0o700 }); } catch { throw new AgentRuntimeError("runtime.owner_busy"); }
  const nonce = crypto.randomUUID();
  const claimant = path.join(gate, "claimant.json");
  try {
    const claimFd = fs.openSync(claimant, "wx", 0o600);
    try { fs.writeFileSync(claimFd, JSON.stringify({ pid: process.pid, nonce })); fs.fsyncSync(claimFd); } finally { fs.closeSync(claimFd); }
    if (fs.existsSync(recovery)) throw new AgentRuntimeError("runtime.owner_recovery_active");
    if (fs.existsSync(lock)) {
      const old = JSON.parse(taskReadFile(lock, 4096).toString("utf8"));
      if (taskOwnerAlive(old.pid)) throw new AgentRuntimeError("runtime.owner_busy");
      fs.unlinkSync(lock);
    }
    const fd = fs.openSync(lock, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } finally {
    if (fs.existsSync(claimant)) {
      const claim = JSON.parse(taskReadFile(claimant, 4096).toString("utf8"));
      if (claim.pid === process.pid && claim.nonce === nonce) fs.unlinkSync(claimant);
    }
    if (fs.existsSync(gate)) fs.rmdirSync(gate);
  }
  return () => {
    if (!fs.existsSync(lock)) return;
    const owner = JSON.parse(taskReadFile(lock, 4096).toString("utf8"));
    if (owner.pid === process.pid && owner.nonce === nonce) fs.unlinkSync(lock);
  };
}

export function recoverAgentTaskOwner(options, { confirmStopped = false } = {}) {
  if (confirmStopped !== true) throw new AgentRuntimeError("runtime.offline_confirmation_required");
  const directory = taskPrivateDirectory(agentTaskDirectory(options));
  const recovery = path.join(directory, "owner-recovery");
  try { fs.mkdirSync(recovery, { mode: 0o700 }); } catch { throw new AgentRuntimeError("runtime.owner_recovery_active"); }
  try {
    const lock = path.join(directory, "owner.json");
    if (fs.existsSync(lock)) {
      const owner = JSON.parse(taskReadFile(lock, 4096).toString("utf8"));
      if (taskOwnerAlive(owner.pid)) throw new AgentRuntimeError("runtime.owner_busy");
    }
    const gate = path.join(directory, "owner-acquisition");
    if (fs.existsSync(gate)) {
      taskPrivateDirectory(gate);
      const entries = fs.readdirSync(gate);
      if (entries.some((name) => name !== "claimant.json")) throw new AgentRuntimeError("runtime.unsafe_state_path");
      const claimant = path.join(gate, "claimant.json");
      if (entries.length) {
        const claim = JSON.parse(taskReadFile(claimant, 4096).toString("utf8"));
        if (taskOwnerAlive(claim.pid)) throw new AgentRuntimeError("runtime.owner_busy");
        fs.unlinkSync(claimant);
      }
      // An acquiring process must write its claimant before touching owner.json.
      // If it wins this race, rmdir fails on the non-empty gate; no recursive deletion.
      fs.rmdirSync(gate);
    }
    if (fs.existsSync(lock)) fs.unlinkSync(lock);
    return { recovered: true };
  } finally { fs.rmdirSync(recovery); }
}

function agentTaskDirectory({ stateDir, origin, botId }) {
  return path.join(path.resolve(stateDir), taskIdentity(origin, botId));
}

export function readAgentTaskSummary(options) {
  const directory = agentTaskDirectory(options);
  if (fs.existsSync(directory)) taskPrivateDirectory(directory);
  const file = path.join(directory, "tasks.json");
  if (!fs.existsSync(file)) return { total: 0, active: 0, failed: 0, completed: 0, tasks: [] };
  const state = JSON.parse(taskReadFile(file).toString("utf8"));
  const tasks = (state.tasks || []).map((task) => ({ taskId: task.taskId, state: task.state, attempts: task.attempts,
    error: task.error || null, updatedAt: task.updatedAt, expiresAt: task.expiresAt }));
  return { total: tasks.length, active: tasks.filter((t) => !TASK_TERMINAL.has(t.state)).length,
    failed: tasks.filter((t) => t.state === "failed").length, completed: tasks.filter((t) => t.state === "completed").length, tasks };
}

export function requestAgentTaskControl(options, taskId, action = "retry") {
  if (!/^[a-f0-9]{64}$/u.test(taskId) || !["retry", "cancel"].includes(action)) throw new AgentRuntimeError("task.invalid_control");
  const directory = agentTaskDirectory(options);
  taskPrivateDirectory(directory);
  const state = readAgentTaskSummary(options);
  if (!state.tasks.some((task) => task.taskId === taskId)) throw new AgentRuntimeError("task.not_found");
  taskAtomicWrite(path.join(directory, `control-${taskId}.json`), JSON.stringify({ taskId, action }));
  return { taskId, action, queued: true };
}

/** A local durable inbox. Transport ACK confirms accept(), never business completion. */
export function createAgentTaskRuntime(options) {
  const { client, invoke, prepareInputs = async () => [], resolveMedia, validateBytes,
    onState = () => {}, now = Date.now, scopes = [] } = options;
  if (!client || typeof invoke !== "function") throw new AgentRuntimeError("runtime.invalid_adapter");
  for (const field of ["maxTasks", "maxBytes", "retentionMs", "maxConcurrency", "maxAttempts", "retryDelayMs"]) {
    if (options[field] !== undefined && (!Number.isSafeInteger(options[field]) || options[field] < (field === "retryDelayMs" ? 0 : 1))) throw new AgentRuntimeError("runtime.invalid_limit");
  }
  const maxTasks = Math.min(1000, Math.max(1, options.maxTasks ?? 200));
  const maxBytes = Math.min(1024 * 1024 * 1024, Math.max(1, options.maxBytes ?? 256 * 1024 * 1024));
  const retentionMs = Math.min(7 * 24 * 3600_000, Math.max(60_000, options.retentionMs ?? 24 * 3600_000));
  const concurrency = Math.min(8, Math.max(1, options.maxConcurrency ?? 2));
  const maxAttempts = Math.min(5, Math.max(1, options.maxAttempts ?? 3));
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 1500);
  taskPrivateDirectory(path.resolve(options.stateDir));
  const directory = taskPrivateDirectory(agentTaskDirectory(options));
  const releaseOwner = acquireTaskOwner(directory);
  const stateFile = path.join(directory, "tasks.json");
  let tasks = [], closed = false, started = false, timer, scheduling = false;
  const running = new Map(), activeConversations = new Set(), waiters = [], notifying = new Map();
  const notify = () => { try { onState(summary()); } catch { /* Observability cannot alter task state. */ } };
  const persist = () => {
    const bytes = Buffer.from(JSON.stringify({ version: 1, tasks }));
    if (bytes.length > TASK_FILE_LIMIT) throw new AgentRuntimeError("runtime.state_limit");
    taskAtomicWrite(stateFile, bytes);
  };
  const setState = (task, state, patch = {}) => { Object.assign(task, patch, { state, updatedAt: now() }); persist(); notify(); };
  const blobPath = (id) => {
    if (!/^[a-f0-9]{64}$/u.test(id)) throw new AgentRuntimeError("artifact.invalid_reference");
    return path.join(directory, `${id}.blob`);
  };
  const usedBytes = () => fs.readdirSync(directory).filter((name) => /^[a-f0-9]{64}\.blob$/u.test(name))
    .reduce((total, name) => total + fs.lstatSync(path.join(directory, name)).size, 0);
  const summary = () => ({ total: tasks.length, active: running.size,
    pending: tasks.filter((task) => !TASK_TERMINAL.has(task.state)).length,
    failed: tasks.filter((task) => task.state === "failed").length,
    completed: tasks.filter((task) => task.state === "completed").length,
    lastError: [...tasks].reverse().find((task) => task.error)?.error || null });
  const prune = () => {
    const expired = tasks.filter((task) => task.expiresAt <= now() && !running.has(task.taskId));
    if (!expired.length) return;
    tasks = tasks.filter((task) => !expired.includes(task)); persist();
    for (const task of expired) for (const artifact of task.artifacts || []) {
      const file = blobPath(artifact.artifactId);
      if (fs.existsSync(file)) { taskReadFile(file, 50 * 1024 * 1024); fs.unlinkSync(file); }
    }
  };
  try {
    for (const name of fs.readdirSync(directory).filter((name) => /^(?:tasks\.json|[a-f0-9]{64}\.blob)\.[a-f0-9-]{36}\.tmp$/u.test(name))) {
      const file = path.join(directory, name); taskReadFile(file, 25 * 1024 * 1024); fs.unlinkSync(file);
    }
    if (fs.existsSync(stateFile)) {
      const state = JSON.parse(taskReadFile(stateFile).toString("utf8"));
      if (state.version !== 1 || !Array.isArray(state.tasks) || state.tasks.length > 1000) throw new AgentRuntimeError("runtime.invalid_state");
      tasks = state.tasks;
      for (const task of tasks) {
        if (!/^[a-f0-9]{64}$/u.test(task.taskId) || typeof task.event?.conversationId !== "string" || !Number.isFinite(task.expiresAt)) throw new AgentRuntimeError("runtime.invalid_state");
        if (!TASK_TERMINAL.has(task.state)) {
          if ((task.artifacts || []).some((artifact) => ["uploading", "reserving"].includes(artifact.state) && !artifact.uploadId && !artifact.attachmentId)) {
            for (const artifact of task.artifacts || []) if (["uploading", "reserving"].includes(artifact.state) && !artifact.uploadId && !artifact.attachmentId) artifact.state = "unknown";
            task.state = "failed"; task.error = { code: "upload.outcome_unknown", stage: "uploading", retryable: false };
          } else task.state = "received";
        }
      }
    }
    prune(); persist();
    const referenced = new Set(tasks.flatMap((task) => (task.artifacts || []).map((artifact) => `${artifact.artifactId}.blob`)));
    for (const name of fs.readdirSync(directory).filter((name) => /^[a-f0-9]{64}\.blob$/u.test(name) && !referenced.has(name))) {
      const file = path.join(directory, name); taskReadFile(file, 25 * 1024 * 1024); fs.unlinkSync(file);
    }
  } catch (error) { releaseOwner(); throw error; }

  async function authorize(task) {
    const result = await client.listConversations();
    const conversation = result?.conversations?.find((item) => item.id === task.event.conversationId);
    if (!conversation || conversation.allowTrigger === false || conversation.allowSend === false) throw new AgentRuntimeError("task.authorization_denied");
    let context = null;
    if (scopes.includes("messages:read_context") && conversation.allowContext !== false) context = await client.getContext(conversation.id, { limit: 50 });
    return { conversation, context };
  }

  function visibleArtifacts(conversationId, context) {
    if (!scopes.includes("files:read_content") || !scopes.includes("messages:read_context")) return [];
    const visibleMessages = new Map((context?.messages || []).filter((message) => !message.recalledAt && !message.deletedAt && !message.removedAt && !["recalled", "removed", "deleted"].includes(message.status)).map((message) => [message.id, message]));
    return tasks.filter((task) => task.event.conversationId === conversationId && task.expiresAt > now())
      .flatMap((task) => (task.artifacts || []).filter((artifact) => artifact.messageId &&
        visibleMessages.get(artifact.messageId)?.content?.blocks?.some((block) => block.type === "attachment" && block.attachmentId === artifact.attachmentId && !["removed", "deleted", "failed"].includes(block.status)))
        .map((artifact) => ({ artifactId: artifact.artifactId, fileName: artifact.fileName, mimeType: artifact.mimeType,
          byteSize: artifact.byteSize, attachmentId: artifact.attachmentId, messageId: artifact.messageId, sourceMessageId: task.triggerMessageId || null,
          expiresAt: task.expiresAt })));
  }

  async function readArtifact(id, conversationId, context, signal, maxBytes = 10 * 1024 * 1024) {
    if (!scopes.includes("files:read_content") || !scopes.includes("messages:read_context") || typeof client.readAttachment !== "function") throw new AgentRuntimeError("artifact.read_scope_required");
    const visible = visibleArtifacts(conversationId, context).find((artifact) => artifact.artifactId === id);
    if (!visible) throw new AgentRuntimeError("artifact.reference_denied");
    const owner = tasks.find((task) => (task.artifacts || []).some((artifact) => artifact.artifactId === id));
    const record = owner.artifacts.find((artifact) => artifact.artifactId === id);
    if (record.byteSize > maxBytes) throw new AgentRuntimeError("input.attachment_limit");
    const result = await client.readAttachment({ conversationId, messageId: record.messageId, attachmentId: record.attachmentId,
      mode: "content", signal, maxBytes });
    taskCheckCancelled(signal);
    if (owner.expiresAt <= now()) throw new AgentRuntimeError("artifact.expired");
    const bytes = Buffer.from(result.bytes);
    if (bytes.length !== record.byteSize || taskDigest(bytes) !== record.sha256) throw new AgentRuntimeError("artifact.integrity_failed");
    validateBytes?.(bytes, record.mimeType);
    return { bytes, fileName: record.fileName, mimeType: record.mimeType, attachmentId: record.attachmentId,
      source: { kind: "artifact", artifactId: id, attachmentId: record.attachmentId, messageId: record.messageId } };
  }

  async function generate(task, authorization, signal) {
    taskCheckCancelled(signal);
    const { conversation, context } = authorization;
    const request = buildAgentBridgeRequest({ taskId: task.taskId, event: task.event, conversation, context,
      capabilities: { publicMedia: Boolean(resolveMedia), incomingAttachments: scopes.some((scope) => ["files:read_content", "files:read_preview"].includes(scope)) },
      artifacts: visibleArtifacts(conversation.id, context) });
    task.triggerMessageId = request.triggerMessage?.id || null;
    persist();
    request.inputs = await prepareInputs({ client, event: task.event, triggerMessage: request.triggerMessage, context, conversation, scopes, signal });
    taskCheckCancelled(signal);
    let remainingInputBytes = 10 * 1024 * 1024 - request.inputs.reduce((total, input) => total + (input.byteSize || 0), 0);
    const alreadyIncluded = new Set(request.inputs.map((input) => input.attachmentId));
    for (const reference of [...request.artifacts].reverse().filter((artifact) => !alreadyIncluded.has(artifact.attachmentId)).slice(0, 2)) {
      if (alreadyIncluded.has(reference.attachmentId) || request.inputs.length >= 6 || reference.byteSize > remainingInputBytes) continue;
      try {
        const artifact = await readArtifact(reference.artifactId, conversation.id, context, signal, remainingInputBytes);
        remainingInputBytes -= artifact.bytes.length;
        alreadyIncluded.add(reference.attachmentId);
        request.inputs.push({ artifactId: reference.artifactId, attachmentId: reference.attachmentId, messageId: reference.messageId,
          conversationId: conversation.id, status: "available", trust: "untrusted-attachment", mimeType: artifact.mimeType,
          byteSize: artifact.bytes.length, type: /^image\/(?:png|jpeg|gif|webp)$/u.test(artifact.mimeType) ? "image" : "document",
          encoding: "base64", data: artifact.bytes.toString("base64") });
      } catch (error) {
        taskCheckCancelled(signal);
        request.inputs.push({ artifactId: reference.artifactId, status: "unavailable", code: safeAgentError(error).code });
      }
    }
    const result = parseAgentBridgeResult(await invoke(request, { signal }), { taskId: task.taskId, validateBytes });
    taskCheckCancelled(signal);
    const artifacts = [];
    let total = 0;
    try { for (const descriptor of result.artifacts) {
      let artifact = descriptor;
      if (descriptor.source === "https") {
        if (!resolveMedia) throw new AgentRuntimeError("media.disabled");
        artifact = await resolveMedia(descriptor.url, { signal });
        taskCheckCancelled(signal);
        if (descriptor.fileName) artifact.fileName = descriptor.fileName;
      } else if (descriptor.source === "artifact") artifact = await readArtifact(descriptor.artifactId, conversation.id, context, signal);
      validateBytes?.(artifact.bytes, artifact.mimeType, { source: descriptor.source === "https" ? "https" : "inline" });
      total += artifact.bytes.length;
      if (total > 50 * 1024 * 1024 || usedBytes() + artifact.bytes.length > maxBytes) throw new AgentRuntimeError("artifact.storage_limit");
      const artifactId = taskDigest(`${task.taskId}\n${descriptor.id}`);
      const sha256 = taskDigest(artifact.bytes);
      const file = blobPath(artifactId);
      if (fs.existsSync(file)) {
        if (taskDigest(taskReadFile(file, 25 * 1024 * 1024)) !== sha256) throw new AgentRuntimeError("artifact.conflicting_result");
      } else taskAtomicWrite(file, artifact.bytes);
      artifacts.push({ artifactId, fileName: artifact.fileName, mimeType: artifact.mimeType, byteSize: artifact.bytes.length,
        sha256, state: descriptor.source === "artifact" && artifact.attachmentId ? "uploaded" : "generated",
        source: ["https", "artifact"].includes(descriptor.source) ? artifact.source : { kind: descriptor.source },
        attachmentId: descriptor.source === "artifact" ? artifact.attachmentId : null, messageId: null });
    } } catch (error) {
      for (const artifact of artifacts) {
        const file = blobPath(artifact.artifactId);
        if (fs.existsSync(file)) fs.unlinkSync(file);
      }
      throw error;
    }
    task.text = result.text; task.artifacts = artifacts; task.generated = true;
    setState(task, "generated");
  }

  async function publish(task, signal) {
    for (let index = 0; index < task.artifacts.length; index += 1) {
      const artifact = task.artifacts[index];
      if (artifact.messageId) continue;
      if (signal.aborted) throw new AgentRuntimeError("task.cancelled");
      const authorization = await authorize(task);
      taskCheckCancelled(signal);
      if (artifact.source?.kind === "artifact") {
        const current = await readArtifact(artifact.source.artifactId, task.event.conversationId, authorization.context, signal);
        if (taskDigest(current.bytes) !== artifact.sha256) throw new AgentRuntimeError("artifact.integrity_failed");
      }
      if (!artifact.attachmentId) {
        if (artifact.state === "uploading" || artifact.state === "unknown") throw new AgentRuntimeError("upload.outcome_unknown");
        const bytes = taskReadFile(blobPath(artifact.artifactId), 25 * 1024 * 1024);
        if (taskDigest(bytes) !== artifact.sha256) throw new AgentRuntimeError("artifact.integrity_failed");
        setState(task, "uploading");
        if (typeof client.reserveUpload === "function" && typeof client.getUploadStatus === "function") {
          if (!artifact.uploadId) {
            artifact.state = "reserving"; persist();
            let reservationRejected = false;
            try {
              const reserved = await client.reserveUpload({ conversationId: task.event.conversationId,
                fileName: artifact.fileName, mimeType: artifact.mimeType, byteSize: artifact.byteSize });
              // Quota rejection is a successful gateway response with no upload ID.
              if (reserved?.upload?.status === "rejected") {
                reservationRejected = true;
                throw new AgentRuntimeError("quota.insufficient");
              }
              const uploadId = reserved?.upload?.id;
              if (typeof uploadId !== "string" || !uploadId) throw new AgentRuntimeError("upload.outcome_unknown");
              artifact.uploadId = uploadId; artifact.state = "reserved"; persist();
            } catch (error) {
              const status = error?.statusCode ?? error?.status;
              const rejected = reservationRejected || (Number.isInteger(status) && status >= 400 && status < 500);
              artifact.state = rejected ? "generated" : "unknown"; persist();
              if (!rejected) throw new AgentRuntimeError("upload.outcome_unknown");
              throw error;
            }
          }
          if (artifact.state === "reserved") {
            taskCheckCancelled(signal);
            artifact.state = "completing"; persist();
            try {
              const complete = await client.completeUploadContent(artifact.uploadId, bytes, artifact.mimeType);
              const receipt = complete?.attachment || complete?.upload?.attachment;
              if (receipt?.id) { artifact.attachmentId = receipt.id; artifact.state = "uploaded"; persist(); }
              else { artifact.state = "checking"; persist(); }
            } catch (error) {
              const status = error?.statusCode ?? error?.status;
              if (Number.isInteger(status) && status >= 400 && status < 500) {
                // A definitive rejection did not accept this transfer. Preserve the
                // reservation and original error; an explicit retry may try it again.
                artifact.state = "reserved"; persist(); throw error;
              }
              // Reconcile only an uncertain completion instead of retransferring bytes.
              artifact.state = "checking"; persist();
            }
          }
          taskCheckCancelled(signal);
          if (!artifact.attachmentId) {
            const status = await client.getUploadStatus(artifact.uploadId);
            if (status?.upload?.status === "completed" && status.upload.attachment?.id) {
              artifact.attachmentId = status.upload.attachment.id; artifact.state = "uploaded"; persist();
            } else if (status?.upload?.status === "failed") throw new AgentRuntimeError("upload.failed");
            else throw new AgentRuntimeError("upload.status_pending", { retryable: true });
          }
        } else {
          // Older custom clients cannot reconcile a lost one-step upload receipt.
          artifact.state = "uploading"; persist();
          try {
            const uploaded = await client.uploadFile({ conversationId: task.event.conversationId, bytes,
              fileName: artifact.fileName, mimeType: artifact.mimeType,
              clientMessageId: `artifact-${artifact.artifactId}`, idempotencyKey: `artifact-${artifact.artifactId}` });
            if (typeof uploaded?.attachment?.id !== "string" || !uploaded.attachment.id) throw new AgentRuntimeError("upload.outcome_unknown");
            artifact.attachmentId = uploaded.attachment.id; artifact.state = "uploaded"; persist();
          } catch (error) {
            const status = error?.statusCode ?? error?.status;
            const rejected = Number.isInteger(status) && status >= 400 && status < 500;
            artifact.state = rejected ? "generated" : "unknown"; persist();
            if (!rejected) throw new AgentRuntimeError("upload.outcome_unknown");
            throw error;
          }
        }
      }
      if (signal.aborted) throw new AgentRuntimeError("task.cancelled");
      setState(task, "sending");
      const text = index === 0 ? task.text : "";
      const sent = await client.sendMessage({ conversationId: task.event.conversationId,
        content: { format: "duallane.message+json;v=1", plainText: text,
          blocks: [...(text ? [{ type: "text", text }] : []), { type: "attachment", attachmentId: artifact.attachmentId }] },
        replyToMessageId: task.triggerMessageId || undefined,
        clientMessageId: `publish-${artifact.artifactId}`, idempotencyKey: `publish-${artifact.artifactId}` });
      if (!sent?.message?.id) throw new AgentRuntimeError("send.invalid_receipt", { retryable: true });
      artifact.messageId = sent.message.id; artifact.state = "sent"; persist();
      taskCheckCancelled(signal);
    }
    if (!task.artifacts.length && !task.messageId) {
      await authorize(task); taskCheckCancelled(signal); setState(task, "sending");
      const sent = await client.sendMessage({ conversationId: task.event.conversationId, text: task.text,
        replyToMessageId: task.triggerMessageId || undefined,
        clientMessageId: `reply-${task.taskId}`, idempotencyKey: `reply-${task.taskId}` });
      if (!sent?.message?.id) throw new AgentRuntimeError("send.invalid_receipt", { retryable: true });
      task.messageId = sent.message.id; persist();
      taskCheckCancelled(signal);
    }
    taskCheckCancelled(signal);
    setState(task, "completed", { error: null });
  }

  async function failureReceipt(task) {
    if (task.failureNotified || task.state === "cancelled" || task.notificationAttempts >= 3) return;
    task.notificationAttempts = (task.notificationAttempts || 0) + 1;
    task.nextNotificationAt = now() + Math.max(1000, retryDelayMs) * 2 ** (task.notificationAttempts - 1);
    persist();
    try {
      await authorize(task);
      const error = task.error;
      const result = await client.sendMessage({ conversationId: task.event.conversationId,
        text: `请求未完成（阶段：${error.stage}；错误：${error.code}）。已成功发送的附件会保留。请联系机器人管理员重试任务 ${task.taskId}。`,
        replyToMessageId: task.triggerMessageId || task.event.payload?.messageId || undefined,
        clientMessageId: `failure-${task.taskId}-${task.generation || 0}`, idempotencyKey: `failure-${task.taskId}-${task.generation || 0}` });
      if (result?.message?.id) { task.failureNotified = true; persist(); }
    } catch (error) {
      if (!safeAgentError(error).retryable) { task.notificationAttempts = 3; persist(); }
    }
  }

  async function execute(task, controller) {
    task.attempts += 1; task.error = null; setState(task, "running");
    let stopThinking = () => {};
    try {
      const authorization = await authorize(task);
      taskCheckCancelled(controller.signal);
      stopThinking = taskStartThinking(client, task.event.conversationId, controller.signal);
      if (!task.generated) await generate(task, authorization, controller.signal);
      if (controller.signal.aborted) throw new AgentRuntimeError("task.cancelled");
      await publish(task, controller.signal);
    } catch (error) {
      stopThinking();
      const safe = safeAgentError(error, task.state);
      if (controller.signal.aborted && closed) { setState(task, "received", { error: null }); return; }
      if (controller.signal.aborted || ["task.cancelled", "bridge.cancelled"].includes(safe.code)) { setState(task, "cancelled", { error: { code: "task.cancelled", stage: task.state, retryable: false } }); return; }
      if (safe.retryable && task.attempts < maxAttempts && safe.code !== "upload.outcome_unknown") {
        setState(task, "received", { error: safe, nextAttemptAt: now() + retryDelayMs * 2 ** (task.attempts - 1) });
      } else { setState(task, "failed", { error: safe }); await failureReceipt(task); }
    } finally { stopThinking(); }
  }

  function control(taskId, action) {
    const task = tasks.find((item) => item.taskId === taskId);
    if (!task || task.expiresAt <= now()) throw new AgentRuntimeError("task.not_found");
    if (action === "cancel") {
      if (running.has(taskId)) running.get(taskId).controller.abort();
      else if (!TASK_TERMINAL.has(task.state)) setState(task, "cancelled");
      return;
    }
    if (task.state !== "failed") throw new AgentRuntimeError("task.not_retryable");
    if ((task.artifacts || []).some((artifact) => ["unknown", "uploading", "reserving"].includes(artifact.state) && !artifact.uploadId)) throw new AgentRuntimeError("upload.outcome_unknown");
    task.attempts = 0; task.failureNotified = false; task.notificationAttempts = 0; task.generation = (task.generation || 0) + 1;
    setState(task, "received", { error: null, nextAttemptAt: 0 }); schedule();
  }

  function schedule() {
    if (!started || closed || scheduling) return;
    scheduling = true;
    try {
      prune();
      for (const file of fs.readdirSync(directory).filter((name) => /^control-[a-f0-9]{64}\.json$/u.test(name))) {
        const filePath = path.join(directory, file);
        const input = JSON.parse(taskReadFile(filePath, 4096).toString("utf8"));
        try { control(input.taskId, input.action); } catch { /* Invalid/stale operator requests do not run a task. */ }
        fs.unlinkSync(filePath);
      }
      const waitingConversations = new Set(activeConversations);
      for (const task of tasks) {
        if (running.size >= concurrency) break;
        if (task.state !== "received" || waitingConversations.has(task.event.conversationId)) continue;
        waitingConversations.add(task.event.conversationId);
        if ((task.nextAttemptAt || 0) > now()) continue;
        const controller = new AbortController();
        activeConversations.add(task.event.conversationId);
        // Publish ownership before execute() can synchronously persist/notify.
        const slot = { controller, promise: null }; running.set(task.taskId, slot);
        slot.promise = execute(task, controller).catch(() => {
          // Disk failures stop admission; accepting more events would lose durable ownership.
          closed = true;
        }).finally(() => {
          running.delete(task.taskId); activeConversations.delete(task.event.conversationId);
          queueMicrotask(schedule);
          if (!running.size && !tasks.some((item) => item.state === "received")) for (const waiter of waiters.splice(0)) waiter();
          notify();
        });
      }
      for (const task of tasks) {
        if (running.size + notifying.size >= concurrency) break;
        if (task.state !== "failed" || task.failureNotified || task.notificationAttempts >= 3 || (task.nextNotificationAt || 0) > now() || notifying.has(task.taskId)) continue;
        const work = failureReceipt(task).catch(() => { closed = true; }).finally(() => notifying.delete(task.taskId));
        notifying.set(task.taskId, work);
      }
    } finally { scheduling = false; }
  }

  return {
    accept(event, { completed = false } = {}) {
      if (closed) throw new AgentRuntimeError("runtime.closed");
      if (!event || typeof event.eventId !== "string" || !event.eventId || event.eventId.length > 180 || typeof event.conversationId !== "string" || !event.conversationId || Buffer.byteLength(JSON.stringify(event)) > 64 * 1024) throw new AgentRuntimeError("task.invalid_event");
      prune();
      const taskId = taskDigest(`${taskIdentity(options.origin, options.botId)}\n${event.eventId}`);
      const fingerprint = taskEventFingerprint(event);
      const previous = tasks.find((task) => task.taskId === taskId);
      if (previous) {
        if (taskEventFingerprint(previous.event) !== fingerprint) throw new AgentRuntimeError("task.event_conflict");
        return { taskId, duplicate: true };
      }
      if (tasks.length >= maxTasks) throw new AgentRuntimeError("runtime.queue_full", { retryable: true });
      const timestamp = now();
      tasks.push({ taskId, fingerprint, event: structuredClone(event), state: completed ? "completed" : "received", createdAt: timestamp, updatedAt: timestamp,
        expiresAt: timestamp + retentionMs, attempts: 0, artifacts: [], generated: false });
      try { persist(); } catch (error) { tasks.pop(); throw error; }
      queueMicrotask(schedule); notify();
      return { taskId, duplicate: false };
    },
    start() {
      if (closed) throw new AgentRuntimeError("runtime.closed");
      if (started) return;
      started = true; timer = setInterval(schedule, Math.max(20, Math.min(retryDelayMs || 20, 500))); schedule();
    },
    retry(taskId) { control(taskId, "retry"); },
    cancel(taskId) { control(taskId, "cancel"); },
    summary,
    getTask(taskId) { const task = tasks.find((item) => item.taskId === taskId); return task ? structuredClone(task) : null; },
    listArtifacts(conversationId, context) { return visibleArtifacts(conversationId, context); },
    async idle() {
      if (!running.size && !tasks.some((task) => task.state === "received")) return;
      await new Promise((resolve) => waiters.push(resolve));
    },
    async close() {
      closed = true; clearInterval(timer);
      for (const { controller } of running.values()) controller.abort();
      await Promise.allSettled([...running.values()].map((slot) => slot.promise));
      await Promise.allSettled([...notifying.values()]);
      releaseOwner();
      for (const waiter of waiters.splice(0)) waiter();
    },
  };
}
