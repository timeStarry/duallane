import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import {
  AbortMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { WorkspaceError } from "./workspace.mjs";
import {
  removeStoredAttachment,
  saveUploadStream,
  statStoredAttachment
} from "./workspace-storage.mjs";
import { removeProfileAvatar as removeLocalProfileAvatar, resolveProfileAvatar } from "./profile-avatar.mjs";

const DEFAULT_REGION = "us-east-1";
const DEFAULT_SIGNED_URL_TTL_SECONDS = 300;
const MAX_SIGNED_URL_TTL_SECONDS = 900;
const MULTIPART_PART_SIZE = 8 * 1024 * 1024;
const STALE_MULTIPART_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MULTIPART_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

export async function createWorkspaceObjectStore({
  env = process.env,
  dataDir,
  s3Client,
  publicS3Client,
  presign = getSignedUrl,
  uploadFactory = (options) => new Upload(options)
} = {}) {
  const driver = normalizeDriver(env.WORKSPACE_STORAGE_DRIVER);
  if (driver === "local") {
    return createLocalWorkspaceObjectStore(dataDir);
  }

  const config = await loadWorkspaceS3Config(env);
  const credentials = {
    accessKeyId: config.accessKey,
    secretAccessKey: config.secretKey
  };
  const internalClient = s3Client ?? new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials
  });
  const deliveryClient = publicS3Client ?? new S3Client({
    endpoint: config.publicEndpoint,
    region: config.region,
    forcePathStyle: true,
    credentials
  });

  return createS3WorkspaceObjectStore({
    dataDir,
    config,
    internalClient,
    deliveryClient,
    presign,
    uploadFactory
  });
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

function createLocalWorkspaceObjectStore(dataDir) {
  return {
    driver: "local",
    signedUrlTtlSeconds: 0,
    async assertReady() {},
    async close() {},
    async saveAttachment({ attachment, stream }) {
      return await saveUploadStream(dataDir, attachment.storageKey, stream, attachment.byteSize);
    },
    async statAttachment(attachment) {
      const stored = await statStoredAttachment(dataDir, attachment.storageKey, attachment.byteSize);
      return { ...stored, backend: "local" };
    },
    async getAttachmentDelivery(attachment) {
      const stored = await statStoredAttachment(dataDir, attachment.storageKey, attachment.byteSize);
      return { kind: "stream", path: stored.path, byteSize: stored.byteSize };
    },
    async removeAttachment(attachment) {
      await removeStoredAttachment(dataDir, attachment.storageKey);
    },
    async readAttachmentBytes(attachment, maxBytes) {
      const stored = await statStoredAttachment(dataDir, attachment.storageKey, attachment.byteSize);
      assertReadableSize(stored.byteSize, maxBytes);
      return await readFile(stored.path);
    },
    async persistProfileAvatar(stored) {
      return stored;
    },
    async getProfileAvatarDelivery(avatar) {
      const targetPath = resolveProfileAvatar(dataDir, avatar.storageKey);
      const fileStat = await statProfileAvatar(targetPath);
      return { kind: "stream", path: targetPath, byteSize: fileStat.size };
    },
    async removeProfileAvatar(avatar) {
      await removeLocalProfileAvatar(dataDir, avatar?.storageKey);
    },
    async persistCustomEmote(stored) {
      const result = await saveUploadStream(
        dataDir,
        stored.storageKey,
        createReadStream(stored.path),
        stored.byteSize
      );
      return { ...stored, ...result, backend: "local" };
    },
    async readCustomEmoteBytes(emote, maxBytes) {
      const stored = await statStoredAttachment(dataDir, emote.storageKey, emote.byteSize);
      assertReadableSize(stored.byteSize, maxBytes);
      return await readFile(stored.path);
    },
    async getCustomEmoteDelivery(emote) {
      const stored = await statStoredAttachment(dataDir, emote.storageKey, emote.byteSize);
      return { kind: "stream", path: stored.path, byteSize: stored.byteSize };
    },
    async removeCustomEmote(emote) {
      if (emote?.storageKey) await removeStoredAttachment(dataDir, emote.storageKey);
    }
  };
}

function createS3WorkspaceObjectStore({ dataDir, config, internalClient, deliveryClient, presign, uploadFactory }) {
  let multipartCleanupTimer = null;
  const uploadFile = async ({ key, path, byteSize, sha256, contentType, kind, id }) => {
    try {
      const upload = uploadFactory({
        client: internalClient,
        params: {
          Bucket: config.bucket,
          Key: key,
          Body: createReadStream(path),
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
    const head = await internalClient.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
    if (Number(head.ContentLength) !== Number(byteSize)) {
      throw new WorkspaceError("file.storage_mismatch", "文件内容不可用", 500);
    }
    if (sha256 && head.Metadata?.["duallane-sha256"] !== sha256) {
      throw new WorkspaceError("file.storage_mismatch", "文件内容不可用", 500);
    }
    return head;
  };

  const signedDelivery = async ({ key, contentType, contentDisposition }) => {
    const url = await presign(
      deliveryClient,
      new GetObjectCommand({
        Bucket: config.bucket,
        Key: key,
        ResponseContentType: contentType || undefined,
        ResponseContentDisposition: contentDisposition || undefined
      }),
      { expiresIn: config.ttlSeconds }
    );
    return {
      kind: "redirect",
      url,
      expiresAt: new Date(Date.now() + config.ttlSeconds * 1000).toISOString()
    };
  };

  const attachmentHeadOrFallback = async (attachment) => {
    const key = workspaceAttachmentObjectKey(attachment);
    try {
      const head = await verifyHead({ key, byteSize: attachment.byteSize });
      return { backend: "s3", key, byteSize: Number(head.ContentLength) };
    } catch (error) {
      if (!isNotFoundError(error) || !config.localReadFallback) {
        if (error instanceof WorkspaceError) throw error;
        throw storageUnavailable(error, "文件内容不可用");
      }
      const stored = await statStoredAttachment(dataDir, attachment.storageKey, attachment.byteSize);
      return { backend: "local", path: stored.path, byteSize: stored.byteSize };
    }
  };

  return {
    driver: "s3",
    bucket: config.bucket,
    signedUrlTtlSeconds: config.ttlSeconds,
    client: internalClient,
    async assertReady() {
      try {
        await internalClient.send(new HeadBucketCommand({ Bucket: config.bucket }));
        await cleanupWorkspaceMultipartUploads({ client: internalClient, bucket: config.bucket });
        if (!multipartCleanupTimer) {
          multipartCleanupTimer = setInterval(() => {
            void cleanupWorkspaceMultipartUploads({ client: internalClient, bucket: config.bucket }).catch(() => {});
          }, MULTIPART_CLEANUP_INTERVAL_MS);
          multipartCleanupTimer.unref?.();
        }
      } catch (error) {
        throw new Error(`Workspace S3 bucket is unavailable: ${safeProviderCode(error)}`);
      }
    },
    async close() {
      if (multipartCleanupTimer) clearInterval(multipartCleanupTimer);
      internalClient.destroy?.();
      if (deliveryClient !== internalClient) deliveryClient.destroy?.();
    },
    async saveAttachment({ attachment, stream }) {
      const stored = await saveUploadStream(dataDir, attachment.storageKey, stream, attachment.byteSize);
      try {
        await uploadFile({
          key: workspaceAttachmentObjectKey(attachment),
          path: stored.path,
          byteSize: stored.byteSize,
          sha256: stored.sha256,
          contentType: attachment.mimeType,
          kind: "attachment",
          id: attachment.id
        });
        if (!config.localMirrorWrite) {
          await removeStoredAttachment(dataDir, attachment.storageKey);
        }
        return { ...stored, backend: "s3" };
      } catch (error) {
        await removeStoredAttachment(dataDir, attachment.storageKey).catch(() => {});
        throw error;
      }
    },
    async statAttachment(attachment) {
      return await attachmentHeadOrFallback(attachment);
    },
    async getAttachmentDelivery(attachment, options = {}) {
      const stored = await attachmentHeadOrFallback(attachment);
      if (stored.backend === "local") {
        return { kind: "stream", path: stored.path, byteSize: stored.byteSize };
      }
      try {
        return await signedDelivery({
          key: stored.key,
          contentType: options.contentType ?? attachment.mimeType,
          contentDisposition: options.contentDisposition
        });
      } catch (error) {
        throw storageUnavailable(error, "文件链接生成失败");
      }
    },
    async removeAttachment(attachment) {
      await Promise.all([
        internalClient.send(new DeleteObjectCommand({
          Bucket: config.bucket,
          Key: workspaceAttachmentObjectKey(attachment)
        })).catch((error) => {
          throw storageUnavailable(error, "文件清理失败");
        }),
        removeStoredAttachment(dataDir, attachment.storageKey).catch(() => {})
      ]);
    },
    async readAttachmentBytes(attachment, maxBytes) {
      try {
        return await readS3Bytes({
          client: internalClient,
          bucket: config.bucket,
          key: workspaceAttachmentObjectKey(attachment),
          maxBytes
        });
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
        if (!config.localReadFallback) throw new WorkspaceError("file.storage_missing", "文件内容不可用", 404);
        const stored = await statStoredAttachment(dataDir, attachment.storageKey, attachment.byteSize);
        assertReadableSize(stored.byteSize, maxBytes);
        return await readFile(stored.path);
      }
    },
    async persistProfileAvatar(stored) {
      const sha256 = await hashFile(stored.path);
      await uploadFile({
        key: workspaceAvatarObjectKey(stored),
        path: stored.path,
        byteSize: stored.byteSize,
        sha256,
        contentType: "image/webp",
        kind: "profile-avatar",
        id: stored.userId
      });
      if (!config.localMirrorWrite) {
        await removeLocalProfileAvatar(dataDir, stored.storageKey);
      }
      return { ...stored, sha256, backend: "s3" };
    },
    async getProfileAvatarDelivery(avatar, options = {}) {
      const key = workspaceAvatarObjectKey(avatar);
      try {
        await internalClient.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
      } catch (error) {
        if (isNotFoundError(error) && config.localReadFallback) {
          const targetPath = resolveProfileAvatar(dataDir, avatar.storageKey);
          const fileStat = await statProfileAvatar(targetPath);
          return { kind: "stream", path: targetPath, byteSize: fileStat.size };
        }
        if (isNotFoundError(error)) {
          throw new WorkspaceError("avatar.not_found", "头像不存在", 404);
        }
        throw storageUnavailable(error, "头像内容不可用");
      }
      try {
        return await signedDelivery({
          key,
          contentType: "image/webp",
          contentDisposition: options.contentDisposition
        });
      } catch (error) {
        throw storageUnavailable(error, "头像链接生成失败");
      }
    },
    async removeProfileAvatar(avatar) {
      if (!avatar?.storageKey) return;
      const parsed = parseAvatarStorageKey(avatar.storageKey);
      await Promise.all([
        parsed
          ? internalClient.send(new DeleteObjectCommand({
              Bucket: config.bucket,
              Key: workspaceAvatarObjectKey(parsed)
            })).catch((error) => {
              throw storageUnavailable(error, "头像清理失败");
            })
          : Promise.resolve(),
        removeLocalProfileAvatar(dataDir, avatar.storageKey).catch(() => {})
      ]);
    },
    async persistCustomEmote(stored) {
      const key = workspaceCustomEmoteObjectKey(stored);
      try {
        await uploadFile({
          key,
          path: stored.path,
          byteSize: stored.byteSize,
          sha256: stored.sha256,
          contentType: "image/webp",
          kind: "custom-emote",
          id: stored.id
        });
        if (config.localMirrorWrite) {
          await saveUploadStream(dataDir, stored.storageKey, createReadStream(stored.path), stored.byteSize);
        }
        return { ...stored, backend: "s3" };
      } catch (error) {
        await Promise.all([
          internalClient.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key })).catch(() => {}),
          removeStoredAttachment(dataDir, stored.storageKey).catch(() => {})
        ]);
        throw error;
      }
    },
    async readCustomEmoteBytes(emote, maxBytes) {
      try {
        return await readS3Bytes({
          client: internalClient,
          bucket: config.bucket,
          key: workspaceCustomEmoteObjectKey(emote),
          maxBytes
        });
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
        if (!config.localReadFallback) throw new WorkspaceError("emote.not_found", "收藏表情不存在", 404);
        const stored = await statStoredAttachment(dataDir, emote.storageKey, emote.byteSize);
        assertReadableSize(stored.byteSize, maxBytes);
        return await readFile(stored.path);
      }
    },
    async getCustomEmoteDelivery(emote) {
      const key = workspaceCustomEmoteObjectKey(emote);
      try {
        const head = await internalClient.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
        if (Number(head.ContentLength) !== Number(emote.byteSize)) {
          throw new WorkspaceError("emote.storage_mismatch", "收藏表情内容不可用", 500);
        }
        const buffer = await readS3Bytes({
          client: internalClient,
          bucket: config.bucket,
          key,
          maxBytes: Number(emote.byteSize)
        });
        return { kind: "buffer", buffer, byteSize: buffer.byteLength };
      } catch (error) {
        if (isNotFoundError(error) && config.localReadFallback) {
          const stored = await statStoredAttachment(dataDir, emote.storageKey, emote.byteSize);
          return { kind: "stream", path: stored.path, byteSize: stored.byteSize };
        }
        if (error instanceof WorkspaceError) throw error;
        throw storageUnavailable(error, "收藏表情内容不可用");
      }
    },
    async removeCustomEmote(emote) {
      if (!emote?.storageKey) return;
      await Promise.all([
        internalClient.send(new DeleteObjectCommand({
          Bucket: config.bucket,
          Key: workspaceCustomEmoteObjectKey(emote)
        })).catch((error) => {
          throw storageUnavailable(error, "收藏表情清理失败");
        }),
        removeStoredAttachment(dataDir, emote.storageKey).catch(() => {})
      ]);
    }
  };
}

async function readS3Bytes({ client, bucket, key, maxBytes }) {
  let head;
  try {
    head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    assertReadableSize(Number(head.ContentLength), maxBytes);
    const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const bytes = await result.Body?.transformToByteArray?.();
    if (!bytes || bytes.byteLength !== Number(head.ContentLength)) {
      throw new WorkspaceError("file.storage_mismatch", "文件内容不可用", 500);
    }
    return Buffer.from(bytes);
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    if (isNotFoundError(error)) throw error;
    throw storageUnavailable(error, "文件内容不可用");
  }
}

function assertReadableSize(byteSize, maxBytes) {
  if (!Number.isSafeInteger(Number(byteSize)) || Number(byteSize) < 1 || Number(byteSize) > maxBytes) {
    throw new WorkspaceError("emote.source_too_large", "图片过大，无法收藏为表情", 413);
  }
}

export async function cleanupWorkspaceMultipartUploads({
  client,
  bucket,
  now = new Date(),
  maxAgeMs = STALE_MULTIPART_AGE_MS
}) {
  const cutoff = now.getTime() - maxAgeMs;
  let keyMarker;
  let uploadIdMarker;
  let aborted = 0;
  do {
    const page = await client.send(new ListMultipartUploadsCommand({
      Bucket: bucket,
      Prefix: "workspace/",
      KeyMarker: keyMarker,
      UploadIdMarker: uploadIdMarker,
      MaxUploads: 1000
    }));
    for (const upload of page.Uploads ?? []) {
      const initiatedAt = upload.Initiated instanceof Date ? upload.Initiated.getTime() : Date.parse(upload.Initiated);
      if (
        upload.Key?.startsWith("workspace/") &&
        upload.UploadId &&
        Number.isFinite(initiatedAt) &&
        initiatedAt <= cutoff
      ) {
        await client.send(new AbortMultipartUploadCommand({
          Bucket: bucket,
          Key: upload.Key,
          UploadId: upload.UploadId
        }));
        aborted += 1;
      }
    }
    keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    uploadIdMarker = page.IsTruncated ? page.NextUploadIdMarker : undefined;
  } while (keyMarker || uploadIdMarker);
  return { aborted };
}

export async function verifyWorkspaceMultipartCleanupAccess({ client, bucket }) {
  const key = `workspace/migration-archive/provisioning/multipart-cleanup-canary-${crypto.randomUUID()}`;
  const created = await client.send(new CreateMultipartUploadCommand({
    Bucket: bucket,
    Key: key,
    ContentType: "application/octet-stream",
    Metadata: {
      "duallane-kind": "multipart-cleanup-canary",
      "duallane-id": "provisioning"
    }
  }));
  if (!created.UploadId) throw new Error("Workspace S3 multipart cleanup canary was not created");
  try {
    await client.send(new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: "workspace/", MaxUploads: 1 }));
  } finally {
    await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: created.UploadId }));
  }
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function statProfileAvatar(filePath) {
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      throw new WorkspaceError("avatar.not_found", "头像不存在", 404);
    }
    return fileStat;
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    if (error?.code === "ENOENT") {
      throw new WorkspaceError("avatar.not_found", "头像不存在", 404);
    }
    throw error;
  }
}

function parseAvatarStorageKey(storageKey) {
  const match = /^profile-avatars\/([^/]+)\/([^/]+)\.webp$/.exec(String(storageKey ?? ""));
  return match ? { userId: match[1], version: match[2] } : null;
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
