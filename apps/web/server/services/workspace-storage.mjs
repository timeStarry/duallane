import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
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
