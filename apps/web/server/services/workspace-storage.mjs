import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { WorkspaceError } from "./workspace.mjs";

export function workspaceStorageRoot(dataDir) {
  return path.resolve(dataDir, "workspace-files");
}

export function resolveWorkspaceStoragePath(dataDir, storageKey) {
  const root = workspaceStorageRoot(dataDir);
  const normalizedKey = typeof storageKey === "string" ? storageKey.replaceAll("\\", "/") : "";
  if (!normalizedKey || normalizedKey.includes("\0")) {
    throw new WorkspaceError("file.invalid_storage_key", "文件存储路径无效", 500);
  }

  const target = path.resolve(root, ...normalizedKey.split("/").filter(Boolean));
  if (target !== root && target.startsWith(`${root}${path.sep}`)) {
    return target;
  }
  throw new WorkspaceError("file.invalid_storage_key", "文件存储路径无效", 500);
}

export function normalizeWorkspaceObjectSha256(value) {
  const digest = String(value ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new WorkspaceError("storage.object_invalid_digest", "存储对象摘要无效", 500);
  }
  return digest;
}

export function workspaceContentObjectKey(sha256) {
  const digest = normalizeWorkspaceObjectSha256(sha256);
  return `workspace/objects/sha256/${digest.slice(0, 2)}/${digest}`;
}

export function resolveWorkspaceContentObjectKey(object) {
  const expected = workspaceContentObjectKey(object?.sha256);
  const stored = String(object?.objectKey ?? object?.storageKey ?? "").trim();
  if (stored && stored !== expected) {
    throw new WorkspaceError("storage.object_invalid_key", "存储对象路径无效", 500);
  }
  return stored || expected;
}

export async function ensureContentAddressedStream(dataDir, {
  sha256,
  byteSize,
  stream
}) {
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

export async function statContentAddressedObject(dataDir, object) {
  const { sha256, byteSize } = object;
  const digest = normalizeWorkspaceObjectSha256(sha256);
  const size = normalizeObjectByteSize(byteSize);
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

export async function readContentAddressedBytes(dataDir, object, maxBytes = Number.MAX_SAFE_INTEGER) {
  const stored = await statContentAddressedObject(dataDir, object);
  if (!Number.isSafeInteger(Number(maxBytes)) || Number(maxBytes) < stored.byteSize) {
    throw new WorkspaceError("file.storage_too_large", "文件内容过大", 413);
  }
  return await readFile(stored.path);
}

export async function removeContentAddressedObject(dataDir, object) {
  const storageKey = resolveWorkspaceContentObjectKey(object);
  await removeStoredAttachment(dataDir, storageKey);
  return { storageKey };
}

export async function saveUploadStream(dataDir, storageKey, stream, expectedByteSize) {
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
    if (error instanceof WorkspaceError) {
      throw error;
    }
    throw new WorkspaceError("file.storage_failed", "文件保存失败", 500);
  }
}

export async function statStoredAttachment(dataDir, storageKey, expectedByteSize) {
  const targetPath = resolveWorkspaceStoragePath(dataDir, storageKey);
  let fileStat;
  try {
    fileStat = await stat(targetPath);
  } catch {
    throw new WorkspaceError("file.storage_missing", "文件内容不可用", 404);
  }

  if (!fileStat.isFile() || fileStat.size !== expectedByteSize) {
    throw new WorkspaceError("file.storage_mismatch", "文件内容不可用", 500);
  }

  return {
    path: targetPath,
    byteSize: fileStat.size
  };
}

export async function removeStoredAttachment(dataDir, storageKey) {
  const targetPath = resolveWorkspaceStoragePath(dataDir, storageKey);
  await rm(targetPath, { force: true });
}

function normalizeObjectByteSize(value) {
  const byteSize = Number(value);
  if (!Number.isSafeInteger(byteSize) || byteSize < 0) {
    throw new WorkspaceError("storage.object_invalid_size", "存储对象大小无效", 500);
  }
  return byteSize;
}

async function hashStoredFile(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}
