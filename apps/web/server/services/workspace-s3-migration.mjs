import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import {
  loadWorkspaceS3Config,
  workspaceArchiveObjectKey,
  workspaceAttachmentObjectKey,
  workspaceAvatarObjectKey
} from "./workspace-object-store.mjs";
import { resolveWorkspaceStoragePath, workspaceStorageRoot } from "./workspace-storage.mjs";

const MULTIPART_PART_SIZE = 8 * 1024 * 1024;

export async function createWorkspaceS3MigrationStore({
  env = process.env,
  client,
  uploadFactory = (options) => new Upload(options)
} = {}) {
  const config = await loadWorkspaceS3Config(env);
  const s3 = client ?? new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey
    }
  });

  async function headObject(record) {
    try {
      return await s3.send(new HeadObjectCommand({ Bucket: config.bucket, Key: record.objectKey }));
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw migrationStorageError(error, record);
    }
  }

  function validateHead(record, head, expectedSha256 = record.sha256) {
    const byteSize = Number(head?.ContentLength);
    const metadataSize = Number(head?.Metadata?.["duallane-size"]);
    const storedSha256 = String(head?.Metadata?.["duallane-sha256"] || "").toLowerCase();
    const expectedByteSize = record.byteSize ?? byteSize;
    if (
      !Number.isSafeInteger(byteSize) ||
      byteSize !== expectedByteSize ||
      metadataSize !== expectedByteSize ||
      !/^[a-f0-9]{64}$/.test(storedSha256) ||
      (expectedSha256 && storedSha256 !== expectedSha256)
    ) {
      throw migrationMismatch(record);
    }
    record.byteSize = expectedByteSize;
    return storedSha256;
  }

  return {
    bucket: config.bucket,
    async assertReady() {
      try {
        await s3.send(new HeadBucketCommand({ Bucket: config.bucket }));
      } catch (error) {
        throw new Error(`Workspace S3 bucket is unavailable: ${safeProviderCode(error)}`);
      }
    },
    async close() {
      s3.destroy?.();
    },
    async ensureObject(record) {
      const existing = await headObject(record);
      if (existing) {
        validateHead(record, existing);
        return { action: "skipped" };
      }
      if (!record.sourcePath || !record.sha256) {
        throw migrationMissing(record);
      }
      try {
        const upload = uploadFactory({
          client: s3,
          params: {
            Bucket: config.bucket,
            Key: record.objectKey,
            Body: createReadStream(record.sourcePath),
            ContentLength: record.byteSize,
            ContentType: record.contentType || "application/octet-stream",
            Metadata: {
              "duallane-kind": record.kind,
              "duallane-id": String(record.id),
              "duallane-size": String(record.byteSize),
              "duallane-sha256": record.sha256
            }
          },
          queueSize: 2,
          partSize: MULTIPART_PART_SIZE,
          leavePartsOnError: false
        });
        await upload.done();
      } catch (error) {
        throw migrationStorageError(error, record);
      }
      const uploaded = await headObject(record);
      if (!uploaded) throw migrationMissing(record);
      validateHead(record, uploaded);
      return { action: "uploaded" };
    },
    async verifyObject(record) {
      const head = await headObject(record);
      if (!head) throw migrationMissing(record);
      const storedSha256 = validateHead(record, head);
      let response;
      try {
        response = await s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: record.objectKey }));
      } catch (error) {
        throw migrationStorageError(error, record);
      }
      const hash = createHash("sha256");
      let byteSize = 0;
      try {
        for await (const chunk of response.Body) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          byteSize += buffer.byteLength;
          hash.update(buffer);
        }
      } catch (error) {
        throw migrationStorageError(error, record);
      }
      const downloadedSha256 = hash.digest("hex");
      if (byteSize !== record.byteSize || downloadedSha256 !== storedSha256) {
        throw migrationMismatch(record);
      }
      return { sha256: downloadedSha256, byteSize };
    }
  };
}

export async function runWorkspaceS3Migration({
  db,
  dataDir,
  store,
  runId,
  mode = "backfill",
  reportDirectory = path.join(dataDir, "workspace-s3-migration-reports")
}) {
  const normalizedRunId = safeRunId(runId);
  if (!["backfill", "verify"].includes(mode)) {
    throw new Error("Workspace S3 migration mode must be backfill or verify");
  }
  const records = await buildWorkspaceStorageInventory({ db, dataDir, runId: normalizedRunId });
  const report = {
    version: 1,
    runId: normalizedRunId,
    mode,
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    counts: { total: records.length, uploaded: 0, skipped: 0, verified: 0, attachments: 0, avatars: 0, archives: 0 },
    records: []
  };

  try {
    for (const record of records) {
      if (record.sourcePath) {
        record.sha256 = await hashFile(record.sourcePath);
      }
      if (record.kind === "archive") {
        record.objectKey = workspaceArchiveObjectKey({ runId: normalizedRunId, sha256: record.sha256 });
        record.id = record.sha256;
      }
      const ensured = mode === "backfill"
        ? await store.ensureObject(record)
        : { action: "skipped" };
      const verified = await store.verifyObject(record);
      report.counts[ensured.action] += 1;
      report.counts.verified += 1;
      report.counts[`${record.kind}s`] += 1;
      report.records.push({
        kind: record.kind,
        id: record.id,
        sourceStorageKey: record.sourceStorageKey,
        objectKey: record.objectKey,
        byteSize: verified.byteSize,
        sha256: verified.sha256,
        action: ensured.action
      });
    }
    report.status = "completed";
    report.completedAt = new Date().toISOString();
    await writePrivateReport(reportDirectory, report);
    return report;
  } catch (error) {
    report.status = "failed";
    report.completedAt = new Date().toISOString();
    report.failedRecord = error?.record ?? null;
    await writePrivateReport(reportDirectory, report).catch(() => {});
    throw error;
  }
}

export async function buildWorkspaceStorageInventory({ db, dataDir, runId }) {
  const normalizedRunId = safeRunId(runId);
  const attachmentRows = await db.prepare(`
    SELECT id, space_id AS spaceId, storage_key AS storageKey, mime_type AS mimeType,
      byte_size AS byteSize, status
    FROM attachments
    ORDER BY id
  `).all();
  const avatarRows = await db.prepare(`
    SELECT id AS userId, avatar_storage_key AS storageKey, avatar_version AS version
    FROM users
    WHERE avatar_storage_key IS NOT NULL AND avatar_version IS NOT NULL
    ORDER BY id
  `).all();
  const localKeys = await listLocalStorageKeys(dataDir);
  const consumedKeys = new Set();
  const records = [];

  for (const attachment of attachmentRows.filter((row) => row.status === "available")) {
    const sourcePath = localKeys.has(attachment.storageKey)
      ? resolveWorkspaceStoragePath(dataDir, attachment.storageKey)
      : null;
    if (sourcePath) consumedKeys.add(attachment.storageKey);
    if (sourcePath) {
      const sourceStat = await stat(sourcePath);
      if (!sourceStat.isFile() || sourceStat.size !== attachment.byteSize) {
        throw migrationMismatch({ kind: "attachment", id: attachment.id });
      }
    }
    records.push({
      kind: "attachment",
      id: attachment.id,
      sourceStorageKey: attachment.storageKey,
      sourcePath,
      objectKey: workspaceAttachmentObjectKey(attachment),
      byteSize: attachment.byteSize,
      contentType: attachment.mimeType || "application/octet-stream",
      sha256: null
    });
  }

  for (const avatar of avatarRows) {
    const sourcePath = localKeys.has(avatar.storageKey)
      ? resolveWorkspaceStoragePath(dataDir, avatar.storageKey)
      : null;
    if (sourcePath) consumedKeys.add(avatar.storageKey);
    const sourceStat = sourcePath ? await stat(sourcePath) : null;
    records.push({
      kind: "avatar",
      id: avatar.userId,
      sourceStorageKey: avatar.storageKey,
      sourcePath,
      objectKey: workspaceAvatarObjectKey(avatar),
      byteSize: sourceStat?.size ?? null,
      contentType: "image/webp",
      sha256: null
    });
  }

  for (const storageKey of [...localKeys].filter((key) => !consumedKeys.has(key)).sort()) {
    const sourcePath = resolveWorkspaceStoragePath(dataDir, storageKey);
    const sourceStat = await stat(sourcePath);
    records.push({
      kind: "archive",
      id: "pending-hash",
      sourceStorageKey: storageKey,
      sourcePath,
      objectKey: workspaceArchiveObjectKey({ runId: normalizedRunId, sha256: "0".repeat(64) }),
      byteSize: sourceStat.size,
      contentType: "application/octet-stream",
      sha256: null
    });
  }

  return records.sort((left, right) => `${left.kind}:${left.id}:${left.sourceStorageKey}`.localeCompare(`${right.kind}:${right.id}:${right.sourceStorageKey}`));
}

export async function hashFile(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function listLocalStorageKeys(dataDir) {
  const root = workspaceStorageRoot(dataDir);
  const keys = new Set();
  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) keys.add(path.relative(root, target).split(path.sep).join("/"));
    }
  }
  await visit(root);
  return keys;
}

async function writePrivateReport(directory, report) {
  await mkdir(directory, { recursive: true });
  const targetPath = path.join(directory, `${report.runId}.json`);
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

function safeRunId(runId) {
  const normalized = String(runId ?? "").trim();
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(normalized)) {
    throw new Error("WORKSPACE_STORAGE_MIGRATION_RUN_ID is required and must be 8-64 safe characters");
  }
  return normalized;
}

function isNotFoundError(error) {
  return error?.$metadata?.httpStatusCode === 404 || ["NotFound", "NoSuchKey", "NoSuchBucket"].includes(error?.name);
}

function migrationStorageError(error, record) {
  const wrapped = new Error(`Workspace S3 migration storage failure: ${safeProviderCode(error)}`);
  wrapped.code = "storage.unavailable";
  wrapped.record = { kind: record?.kind, id: record?.id };
  return wrapped;
}

function migrationMismatch(record) {
  const error = new Error("Workspace S3 migration object integrity mismatch");
  error.code = "storage.mismatch";
  error.record = { kind: record?.kind, id: record?.id };
  return error;
}

function migrationMissing(record) {
  const error = new Error("Workspace S3 migration source and object are both missing");
  error.code = "storage.missing";
  error.record = { kind: record?.kind, id: record?.id };
  return error;
}

function safeProviderCode(error) {
  const code = String(error?.name || "storage_error");
  return /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : "storage_error";
}
