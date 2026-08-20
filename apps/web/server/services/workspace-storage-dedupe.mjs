import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createWorkspaceStorageObjectRegistry } from "./workspace-storage-objects.mjs";
import { workspaceContentObjectKey } from "./workspace-storage.mjs";

const MODES = new Set(["backfill", "verify", "finalize"]);

export async function runWorkspaceStorageDedupe({
  db,
  store,
  dataDir,
  runId,
  mode = "backfill",
  now = () => new Date(),
  reportDirectory = path.join(dataDir, "workspace-storage-dedupe-reports")
}) {
  const normalizedRunId = normalizeRunId(runId);
  const normalizedMode = String(mode ?? "").trim().toLowerCase();
  if (!MODES.has(normalizedMode)) {
    throw new Error("Workspace storage dedupe mode must be backfill, verify, or finalize");
  }
  const records = await buildWorkspaceDedupeInventory(db);
  const registry = createWorkspaceStorageObjectRegistry({ db, objectStore: store, now });
  const report = {
    version: 1,
    runId: normalizedRunId,
    mode: normalizedMode,
    status: "running",
    startedAt: now().toISOString(),
    completedAt: null,
    counts: {
      total: records.length,
      processed: 0,
      created: 0,
      reused: 0,
      verified: 0,
      finalized: 0,
      legacyDeleted: 0,
      attachments: 0,
      avatars: 0,
      customEmotes: 0,
      logicalBytes: 0,
      uniqueBytes: 0,
      deduplicatedBytes: 0
    },
    records: []
  };
  const uniqueDigests = new Set();
  await writePrivateDedupeReport(reportDirectory, report);

  try {
    if (normalizedMode === "backfill") {
      for (const record of records) {
        const object = await backfillRecord({ registry, store, record });
        const action = object.created ? "created" : "reused";
        report.counts[action] += 1;
        appendReportRecord(report, uniqueDigests, record, object, action);
        await writePrivateDedupeReport(reportDirectory, report);
      }
      const clones = await bindCustomEmoteClones({ db, registry });
      report.counts.total += clones.length;
      for (const { record, object } of clones) {
        appendReportRecord(report, uniqueDigests, record, object, "bound_clone");
        await writePrivateDedupeReport(reportDirectory, report);
      }
    } else {
      const verifiedRecords = [];
      for (const record of records) {
        if (!record.storageObjectId) throw dedupeError("storage.dedupe_not_backfilled", record);
        const object = await registry.withObjectLock(record.storageObjectId, async (locked) => {
          await verifyPhysicalObject(store, locked, record);
          await db.prepare(`UPDATE workspace_storage_objects SET verified_at = ?
            WHERE id = ? AND deleted_at IS NULL`).run(now().toISOString(), locked.id);
          return locked;
        });
        report.counts.verified += 1;
        verifiedRecords.push({ record, object });
        appendReportRecord(report, uniqueDigests, record, object, "verified");
        await writePrivateDedupeReport(reportDirectory, report);
      }
      if (normalizedMode === "finalize") {
        for (let index = 0; index < verifiedRecords.length; index += 1) {
          const { record } = verifiedRecords[index];
          try {
            await registry.withObjectLock(record.storageObjectId, async () => {
              await store.deleteLegacyObject(record);
            });
          } catch (error) {
            throw withRecord(error, record);
          }
          report.counts.finalized += 1;
          report.counts.legacyDeleted += 1;
          report.records[index].action = "finalized";
          await writePrivateDedupeReport(reportDirectory, report);
        }
      }
    }
    report.status = "completed";
    report.completedAt = now().toISOString();
    await writePrivateDedupeReport(reportDirectory, report);
    return report;
  } catch (error) {
    report.status = "failed";
    report.completedAt = now().toISOString();
    report.failedRecord = error?.record ?? null;
    report.errorCode = safeErrorCode(error);
    await writePrivateDedupeReport(reportDirectory, report).catch(() => {});
    throw error;
  }
}

export async function buildWorkspaceDedupeInventory(db) {
  const [attachments, avatars, customEmotes] = await Promise.all([
    db.prepare(`SELECT id, space_id AS spaceId, storage_key AS storageKey,
      storage_object_id AS storageObjectId, mime_type AS contentType, byte_size AS byteSize
      FROM attachments
      WHERE status = 'available' AND storage_key IS NOT NULL
      ORDER BY id`).all(),
    db.prepare(`SELECT id, id AS userId, avatar_storage_key AS storageKey,
      avatar_storage_object_id AS storageObjectId, avatar_version AS version
      FROM users
      WHERE avatar_storage_key IS NOT NULL AND avatar_version IS NOT NULL
      ORDER BY id`).all(),
    db.prepare(`SELECT id, user_id AS userId, storage_key AS storageKey,
      storage_object_id AS storageObjectId, normalized_mime_type AS contentType,
      byte_size AS byteSize, sha256
      FROM workspace_custom_emotes
      WHERE storage_key IS NOT NULL
      ORDER BY id`).all()
  ]);
  return [
    ...attachments.map((record) => ({ ...record, kind: "attachment" })),
    ...avatars.map((record) => ({ ...record, kind: "avatar", contentType: "image/webp", byteSize: null })),
    ...customEmotes.map((record) => ({ ...record, kind: "customEmote", contentType: record.contentType || "image/webp" }))
  ].sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`));
}

export function workspaceStorageObjectId(sha256) {
  const objectKey = workspaceContentObjectKey(sha256);
  return `wso_${objectKey.slice(objectKey.lastIndexOf("/") + 1)}`;
}

async function inspectLegacyRecord(store, record) {
  const opened = await store.openLegacyObject(record);
  const inspected = await hashStream(opened.stream, opened.byteSize);
  if (record.sha256 && String(record.sha256).toLowerCase() !== inspected.sha256) {
    throw dedupeError("storage.dedupe_legacy_mismatch", record);
  }
  return inspected;
}

async function backfillRecord({ registry, store, record }) {
  if (record.storageObjectId) {
    const stored = await registry.loadObjectById(record.storageObjectId);
    try {
      const rebound = await registry.acquireAndBind({
        kind: record.kind,
        resourceId: record.id,
        sha256: stored.sha256,
        byteSize: stored.byteSize,
        contentType: stored.contentType,
        cleanupPrevious: false
      });
      return { ...rebound.object, created: false };
    } catch (error) {
      if (error?.code !== "storage.object_source_required") throw withRecord(error, record);
      const source = await store.openLegacyObject(record);
      const rebound = await registry.acquireAndBind({
        kind: record.kind,
        resourceId: record.id,
        sha256: stored.sha256,
        byteSize: stored.byteSize,
        contentType: stored.contentType,
        stream: source.stream,
        cleanupPrevious: false
      });
      return { ...rebound.object, created: false };
    }
  }
  const inspected = await inspectLegacyRecord(store, record);
  const source = await store.openLegacyObject(record);
  const acquired = await registry.acquireAndBind({
    kind: record.kind,
    resourceId: record.id,
    sha256: inspected.sha256,
    byteSize: inspected.byteSize,
    contentType: record.contentType,
    stream: source.stream,
    cleanupPrevious: false
  });
  return acquired.object;
}

async function bindCustomEmoteClones({ db, registry }) {
  const rows = await db.prepare(`SELECT id, source_custom_emote_id AS sourceCustomEmoteId,
    storage_object_id AS storageObjectId, storage_key AS storageKey, removed_at AS removedAt
    FROM workspace_custom_emotes ORDER BY id`).all();
  const byId = new Map(rows.map((row) => [row.id, row]));
  const pending = rows.filter((row) => !row.storageKey && row.sourceCustomEmoteId);
  const bound = [];
  while (pending.length > 0) {
    let progressed = false;
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const clone = pending[index];
      const source = byId.get(clone.sourceCustomEmoteId);
      if (!source?.storageObjectId) continue;
      const result = await registry.bindObject({
        kind: "customEmote",
        resourceId: clone.id,
        storageObjectId: source.storageObjectId
      });
      clone.storageObjectId = result.object.id;
      pending.splice(index, 1);
      progressed = true;
      bound.push({ record: { kind: "customEmote", id: clone.id }, object: result.object });
    }
    if (!progressed) {
      throw dedupeError("storage.dedupe_unresolved_clone", {
        kind: "customEmote",
        id: pending.map((row) => row.id).sort()[0]
      });
    }
  }
  return bound.sort((left, right) => left.record.id.localeCompare(right.record.id));
}

async function verifyPhysicalObject(store, object, record) {
  let opened;
  try {
    opened = await store.openObject(object);
  } catch (error) {
    throw withRecord(error, record);
  }
  const verified = await hashStream(opened.stream, object.byteSize);
  if (verified.sha256 !== object.sha256) {
    throw dedupeError("storage.dedupe_object_mismatch", record);
  }
}

function appendReportRecord(report, uniqueDigests, record, object, action) {
  report.counts.processed += 1;
  report.counts[`${record.kind}s`] += 1;
  report.counts.logicalBytes += object.byteSize;
  if (!uniqueDigests.has(object.sha256)) {
    uniqueDigests.add(object.sha256);
    report.counts.uniqueBytes += object.byteSize;
  }
  report.counts.deduplicatedBytes = report.counts.logicalBytes - report.counts.uniqueBytes;
  report.records.push({
    kind: record.kind,
    id: record.id,
    storageObjectId: object.id,
    sha256: object.sha256,
    byteSize: object.byteSize,
    action
  });
}

async function hashStream(stream, expectedByteSize) {
  const hash = createHash("sha256");
  let byteSize = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteSize += buffer.byteLength;
    hash.update(buffer);
  }
  if (expectedByteSize !== null && expectedByteSize !== undefined && Number(expectedByteSize) !== byteSize) {
    const error = new Error("Workspace storage object size mismatch");
    error.code = "storage.dedupe_size_mismatch";
    throw error;
  }
  return { sha256: hash.digest("hex"), byteSize };
}

async function writePrivateDedupeReport(directory, report) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const targetPath = path.join(directory, `${report.runId}-${report.mode}.json`);
  const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporaryPath, targetPath);
    await chmod(targetPath, 0o600);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function readWorkspaceDedupeReport({ dataDir, runId, mode }) {
  const normalizedMode = String(mode ?? "").trim().toLowerCase();
  if (!MODES.has(normalizedMode)) throw new Error("Workspace storage dedupe report mode is invalid");
  const filePath = path.join(
    dataDir,
    "workspace-storage-dedupe-reports",
    `${normalizeRunId(runId)}-${normalizedMode}.json`
  );
  return JSON.parse(await readFile(filePath, "utf8"));
}

function normalizeRunId(value) {
  const runId = String(value ?? "").trim();
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(runId)) {
    throw new Error("WORKSPACE_STORAGE_DEDUPE_RUN_ID is required and must be 8-64 safe characters");
  }
  return runId;
}

function withRecord(error, record) {
  if (!error.record) error.record = { kind: record?.kind, id: record?.id };
  return error;
}

function dedupeError(code, record) {
  const error = new Error("Workspace storage dedupe validation failed");
  error.code = code;
  error.record = { kind: record?.kind, id: record?.id };
  return error;
}

function safeErrorCode(error) {
  const code = String(error?.code || "storage.dedupe_failed");
  return /^[a-z0-9_.-]{1,64}$/i.test(code) ? code : "storage.dedupe_failed";
}
