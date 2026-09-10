import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { WorkspaceError } from "./errors.mjs";
import {
  normalizeWorkspaceObjectSha256,
  resolveWorkspaceContentObjectKey,
  resolveWorkspaceStoragePath,
  workspaceContentObjectKey
} from "./storage-paths.mjs";

const DEFAULT_REGION = "us-east-1";
const DEFAULT_SIGNED_URL_TTL_SECONDS = 300;
const MAX_SIGNED_URL_TTL_SECONDS = 900;
const MULTIPART_PART_SIZE = 8 * 1024 * 1024;

export async function createWorkspaceObjectStore({
  env = process.env,
  dataDir,
  s3Client,
  uploadFactory = (options) => new Upload(options)
} = {}) {
  const driver = normalizeDriver(env.WORKSPACE_STORAGE_DRIVER);
  if (driver === "local") {
    return createLocalWorkspaceObjectStore(dataDir);
  }

  const config = await loadWorkspaceS3Config(env);
  const client = s3Client ?? new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED"
  });
  return createS3WorkspaceObjectStore({ dataDir, config, client, uploadFactory });
}

export async function loadWorkspaceS3Config(env = process.env) {
  const endpoint = requiredUrl(env.WORKSPACE_S3_ENDPOINT, "WORKSPACE_S3_ENDPOINT");
  const publicEndpoint = requiredUrl(env.WORKSPACE_S3_PUBLIC_ENDPOINT, "WORKSPACE_S3_PUBLIC_ENDPOINT");
  if (publicEndpoint.protocol !== "https:") {
    throw new Error("WORKSPACE_S3_PUBLIC_ENDPOINT must use HTTPS");
  }
  const bucket = requiredString(env.WORKSPACE_S3_BUCKET, "WORKSPACE_S3_BUCKET");
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Error("WORKSPACE_S3_BUCKET is invalid");
  }
  const credentialsPath = requiredString(
    env.WORKSPACE_S3_CREDENTIALS_FILE,
    "WORKSPACE_S3_CREDENTIALS_FILE"
  );
  let parsed;
  try {
    parsed = JSON.parse(await readFile(credentialsPath, "utf8"));
  } catch {
    throw new Error("WORKSPACE_S3_CREDENTIALS_FILE cannot be read");
  }
  const accessKey = requiredString(parsed?.accessKey, "S3 accessKey");
  const secretKey = requiredString(parsed?.secretKey, "S3 secretKey");
  const ttlSeconds = clampPositiveInteger(
    env.WORKSPACE_S3_SIGNED_URL_TTL_SECONDS,
    DEFAULT_SIGNED_URL_TTL_SECONDS,
    MAX_SIGNED_URL_TTL_SECONDS
  );
  return {
    endpoint: endpoint.toString().replace(/\/$/, ""),
    publicEndpoint: publicEndpoint.toString().replace(/\/$/, ""),
    bucket,
    region: String(env.WORKSPACE_S3_REGION || DEFAULT_REGION).trim() || DEFAULT_REGION,
    accessKey,
    secretKey,
    ttlSeconds,
    localReadFallback: env.WORKSPACE_STORAGE_LOCAL_READ_FALLBACK === "true",
    localMirrorWrite: env.WORKSPACE_STORAGE_LOCAL_MIRROR_WRITE === "true"
  };
}

export function workspaceAttachmentObjectKey(attachment) {
  return `workspace/attachments/${safeSegment(attachment?.spaceId)}/${safeSegment(attachment?.id)}/content`;
}

export function workspaceAvatarObjectKey({ userId, version }) {
  return `workspace/profile-avatars/${safeSegment(userId)}/${safeSegment(version)}.webp`;
}

export function workspaceCustomEmoteObjectKey({ userId, id }) {
  return `workspace/custom-emotes/${safeSegment(userId)}/${safeSegment(id)}/content.webp`;
}

export function workspaceArchiveObjectKey({ runId, sha256 }) {
  const digest = String(sha256 ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error("archive sha256 is invalid");
  }
  return `workspace/migration-archive/${safeSegment(runId)}/${digest}`;
}

export { workspaceContentObjectKey };

function createLocalWorkspaceObjectStore(dataDir) {
  return {
    driver: "local",
    async assertReady() {},
    async close() {},
    async ensureObject(input) {
      const stored = await ensureContentAddressedStream(dataDir, input);
      return { ...stored, objectKey: stored.storageKey, backend: "local" };
    },
    async openObject(object) {
      const stored = await statContentAddressedObject(dataDir, object);
      return { stream: createReadStream(stored.path), byteSize: stored.byteSize, sha256: stored.sha256 };
    },
    async deleteObject(object) {
      const objectKey = resolveWorkspaceContentObjectKey(object);
      await removeStoredAttachment(dataDir, objectKey);
      return { objectKey };
    },
    async openLegacyObject(record) {
      return await openLocalLegacyObject(dataDir, record);
    },
    async deleteLegacyObject(record) {
      if (record?.storageKey) await removeStoredAttachment(dataDir, record.storageKey);
    }
  };
}

function createS3WorkspaceObjectStore({ dataDir, config, client, uploadFactory }) {
  const uploadFile = async ({ key, path: filePath, byteSize, sha256, contentType, kind, id }) => {
    try {
      const upload = uploadFactory({
        client,
        params: {
          Bucket: config.bucket,
          Key: key,
          Body: createReadStream(filePath),
          ContentLength: byteSize,
          ContentType: contentType || "application/octet-stream",
          Metadata: {
            "duallane-kind": kind,
            "duallane-id": String(id),
            "duallane-size": String(byteSize),
            "duallane-sha256": sha256
          }
        },
        queueSize: 2,
        partSize: MULTIPART_PART_SIZE,
        leavePartsOnError: false
      });
      await upload.done();
      await verifyHead({ key, byteSize, sha256 });
    } catch (error) {
      throw storageUnavailable(error, "文件保存失败");
    }
  };

  const verifyHead = async ({ key, byteSize, sha256 }) => {
    const head = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
    validateCanonicalHead({ sha256, byteSize }, head);
    return head;
  };

  return {
    driver: "s3",
    bucket: config.bucket,
    client,
    async ensureObject(input) {
      const sha256 = normalizeWorkspaceObjectSha256(input?.sha256);
      const byteSize = normalizeCanonicalByteSize(input?.byteSize);
      const objectKey = workspaceContentObjectKey(sha256);
      try {
        const head = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: objectKey }));
        validateCanonicalHead({ sha256, byteSize }, head);
        return { objectKey, sha256, byteSize, backend: "s3", created: false };
      } catch (error) {
        if (!isNotFoundError(error)) {
          if (error instanceof WorkspaceError) throw error;
          throw storageUnavailable(error, "文件内容不可用");
        }
      }
      if (!input?.stream || typeof input.stream.pipe !== "function") {
        throw new WorkspaceError("storage.object_source_required", "存储对象来源不可用", 500);
      }
      const stagingKey = `.content-object-staging/${randomUUID()}`;
      const staged = await saveUploadStream(dataDir, stagingKey, input.stream, byteSize);
      try {
        if (staged.sha256 !== sha256) {
          throw new WorkspaceError("storage.object_digest_mismatch", "存储对象校验失败", 500);
        }
        await uploadFile({
          key: objectKey,
          path: staged.path,
          byteSize,
          sha256,
          contentType: input.contentType || "application/octet-stream",
          kind: "content-object",
          id: sha256
        });
        if (config.localMirrorWrite) {
          await ensureContentAddressedStream(dataDir, {
            sha256,
            byteSize,
            stream: createReadStream(staged.path)
          });
        }
        return { objectKey, sha256, byteSize, backend: "s3", created: true };
      } finally {
        await removeStoredAttachment(dataDir, stagingKey).catch(() => {});
      }
    },
    async openObject(object) {
      return await openS3ContentObject({ dataDir, config, client, object });
    },
    async deleteObject(object) {
      const objectKey = resolveWorkspaceContentObjectKey(object);
      await Promise.all([
        client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: objectKey })).catch((error) => {
          throw storageUnavailable(error, "文件清理失败");
        }),
        removeStoredAttachment(dataDir, objectKey).catch(() => {})
      ]);
      return { objectKey };
    },
    async openLegacyObject(record) {
      const objectKey = legacyWorkspaceObjectKey(record);
      try {
        const head = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: objectKey }));
        const byteSize = Number(head.ContentLength);
        validateLegacyByteSize(record, byteSize);
        const result = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: objectKey }));
        if (!result.Body) throw new WorkspaceError("file.storage_missing", "文件内容不可用", 404);
        return { stream: result.Body, byteSize };
      } catch (error) {
        if (isNotFoundError(error) && config.localReadFallback) return await openLocalLegacyObject(dataDir, record);
        if (error instanceof WorkspaceError) throw error;
        if (isNotFoundError(error)) throw new WorkspaceError("file.storage_missing", "文件内容不可用", 404);
        throw storageUnavailable(error, "文件内容不可用");
      }
    },
    async deleteLegacyObject(record) {
      await Promise.all([
        client.send(new DeleteObjectCommand({
          Bucket: config.bucket,
          Key: legacyWorkspaceObjectKey(record)
        })).catch((error) => {
          throw storageUnavailable(error, "文件清理失败");
        }),
        record?.storageKey
          ? removeStoredAttachment(dataDir, record.storageKey).catch(() => {})
          : Promise.resolve()
      ]);
    },
    async assertReady() {
      try {
        // Readiness is deliberately read-only. Multipart cleanup is an explicit
        // provisioning concern and never runs as a dedupe/migration side effect.
        await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
      } catch (error) {
        throw new Error(`Workspace S3 bucket is unavailable: ${safeProviderCode(error)}`);
      }
    },
    async close() {
      client.destroy?.();
    }
  };
}

async function ensureContentAddressedStream(dataDir, { sha256, byteSize, stream }) {
  const digest = normalizeWorkspaceObjectSha256(sha256);
  const size = normalizeObjectByteSize(byteSize);
  const storageKey = workspaceContentObjectKey(digest);
  try {
    const existing = await statContentAddressedObject(dataDir, { sha256: digest, byteSize: size });
    return { ...existing, storageKey, created: false };
  } catch (error) {
    if (error?.code !== "file.storage_missing") throw error;
  }
  if (!stream || typeof stream.pipe !== "function") {
    throw new WorkspaceError("storage.object_source_required", "存储对象来源不可用", 500);
  }

  const stagingKey = `.content-object-staging/${randomUUID()}`;
  const staged = await saveUploadStream(dataDir, stagingKey, stream, size);
  try {
    if (staged.sha256 !== digest) {
      throw new WorkspaceError("storage.object_digest_mismatch", "存储对象校验失败", 500);
    }
    const targetPath = resolveWorkspaceStoragePath(dataDir, storageKey);
    await mkdir(path.dirname(targetPath), { recursive: true });
    let created = true;
    try {
      await link(staged.path, targetPath);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      created = false;
    }
    const stored = await statContentAddressedObject(dataDir, { sha256: digest, byteSize: size });
    return { ...stored, storageKey, created };
  } finally {
    await removeStoredAttachment(dataDir, stagingKey).catch(() => {});
  }
}

async function statContentAddressedObject(dataDir, object) {
  const digest = normalizeWorkspaceObjectSha256(object?.sha256);
  const size = normalizeObjectByteSize(object?.byteSize);
  const storageKey = resolveWorkspaceContentObjectKey({ ...object, sha256: digest });
  const targetPath = resolveWorkspaceStoragePath(dataDir, storageKey);
  let fileStat;
  try {
    fileStat = await stat(targetPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new WorkspaceError("file.storage_missing", "文件内容不可用", 404);
    }
    throw error;
  }
  if (!fileStat.isFile() || fileStat.size !== size || await hashStoredFile(targetPath) !== digest) {
    throw new WorkspaceError("file.storage_mismatch", "文件内容不可用", 500);
  }
  return { path: targetPath, byteSize: size, sha256: digest };
}

async function saveUploadStream(dataDir, storageKey, stream, expectedByteSize) {
  if (!stream || typeof stream.pipe !== "function") {
    throw new WorkspaceError("upload.invalid_content", "上传内容不能为空", 400);
  }

  const targetPath = resolveWorkspaceStoragePath(dataDir, storageKey);
  const tmpPath = `${targetPath}.${randomUUID()}.tmp`;
  const hash = createHash("sha256");
  let written = 0;

  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      written += buffer.byteLength;
      if (written > expectedByteSize) {
        callback(new WorkspaceError("upload.size_mismatch", "上传内容大小与预留不一致", 400));
        return;
      }
      hash.update(buffer);
      callback(null, buffer);
    }
  });

  try {
    await mkdir(path.dirname(targetPath), { recursive: true });
    await pipeline(stream, meter, createWriteStream(tmpPath));
    if (written !== expectedByteSize) {
      throw new WorkspaceError("upload.size_mismatch", "上传内容大小与预留不一致", 400);
    }
    await rename(tmpPath, targetPath);
    return {
      path: targetPath,
      byteSize: written,
      sha256: hash.digest("hex")
    };
  } catch (error) {
    await rm(tmpPath, { force: true });
    if (error instanceof WorkspaceError) throw error;
    throw new WorkspaceError("file.storage_failed", "文件保存失败", 500);
  }
}

async function openS3ContentObject({ dataDir, config, client, object }) {
  const sha256 = normalizeWorkspaceObjectSha256(object?.sha256);
  const byteSize = normalizeCanonicalByteSize(object?.byteSize);
  const objectKey = resolveWorkspaceContentObjectKey({ ...object, sha256 });
  try {
    const head = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: objectKey }));
    validateCanonicalHead({ sha256, byteSize }, head);
    const result = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: objectKey }));
    if (!result.Body) throw new WorkspaceError("file.storage_missing", "文件内容不可用", 404);
    return { stream: result.Body, byteSize, sha256 };
  } catch (error) {
    if (isNotFoundError(error) && config.localReadFallback) {
      const stored = await statContentAddressedObject(dataDir, { ...object, sha256, byteSize });
      return { stream: createReadStream(stored.path), byteSize, sha256 };
    }
    if (error instanceof WorkspaceError) throw error;
    if (isNotFoundError(error)) throw new WorkspaceError("file.storage_missing", "文件内容不可用", 404);
    throw storageUnavailable(error, "文件内容不可用");
  }
}

async function openLocalLegacyObject(dataDir, record) {
  const storageKey = String(record?.storageKey ?? "").trim();
  if (!storageKey) throw new WorkspaceError("file.storage_missing", "文件内容不可用", 404);
  const targetPath = resolveWorkspaceStoragePath(dataDir, storageKey);
  let fileStat;
  try {
    fileStat = await stat(targetPath);
  } catch (error) {
    if (error?.code === "ENOENT") throw new WorkspaceError("file.storage_missing", "文件内容不可用", 404);
    throw error;
  }
  if (!fileStat.isFile()) throw new WorkspaceError("file.storage_mismatch", "文件内容不可用", 500);
  validateLegacyByteSize(record, fileStat.size);
  return { stream: createReadStream(targetPath), byteSize: fileStat.size };
}

function legacyWorkspaceObjectKey(record) {
  if (record?.kind === "attachment") return workspaceAttachmentObjectKey(record);
  if (record?.kind === "avatar") return workspaceAvatarObjectKey(record);
  if (record?.kind === "customEmote") return workspaceCustomEmoteObjectKey(record);
  throw new WorkspaceError("storage.object_invalid_kind", "存储对象类型无效", 500);
}

function validateLegacyByteSize(record, actualByteSize) {
  const size = normalizeCanonicalByteSize(actualByteSize);
  if (record?.byteSize !== null && record?.byteSize !== undefined && Number(record.byteSize) !== size) {
    throw new WorkspaceError("file.storage_mismatch", "文件内容不可用", 500);
  }
  return size;
}

function normalizeCanonicalByteSize(value) {
  const byteSize = Number(value);
  if (!Number.isSafeInteger(byteSize) || byteSize < 0) {
    throw new WorkspaceError("storage.object_invalid_size", "存储对象大小无效", 500);
  }
  return byteSize;
}

function normalizeObjectByteSize(value) {
  return normalizeCanonicalByteSize(value);
}

function validateCanonicalHead(object, head) {
  const byteSize = Number(head?.ContentLength);
  const metadataSize = Number(head?.Metadata?.["duallane-size"]);
  const metadataSha256 = String(head?.Metadata?.["duallane-sha256"] ?? "").toLowerCase();
  if (
    byteSize !== object.byteSize ||
    metadataSize !== object.byteSize ||
    metadataSha256 !== object.sha256
  ) {
    throw new WorkspaceError("file.storage_mismatch", "文件内容不可用", 500);
  }
}

async function hashStoredFile(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function removeStoredAttachment(dataDir, storageKey) {
  const targetPath = resolveWorkspaceStoragePath(dataDir, storageKey);
  await rm(targetPath, { force: true });
}

function normalizeDriver(value) {
  const driver = String(value || "local").trim().toLowerCase();
  if (!["local", "s3"].includes(driver)) {
    throw new Error("WORKSPACE_STORAGE_DRIVER must be local or s3");
  }
  return driver;
}

function safeSegment(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized || !/^[a-zA-Z0-9_-]+$/.test(normalized)) {
    throw new Error("object key segment is invalid");
  }
  return normalized;
}

function requiredString(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function requiredUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(requiredString(value, label));
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/"
  ) {
    throw new Error(`${label} is invalid`);
  }
  return parsed;
}

function clampPositiveInteger(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function isNotFoundError(error) {
  return error?.$metadata?.httpStatusCode === 404 || ["NotFound", "NoSuchKey", "NoSuchBucket"].includes(error?.name);
}

function storageUnavailable(error, message) {
  if (error instanceof WorkspaceError) return error;
  return new WorkspaceError("file.storage_unavailable", message, 503);
}

function safeProviderCode(error) {
  const code = String(error?.name || "storage_error");
  return /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : "storage_error";
}
