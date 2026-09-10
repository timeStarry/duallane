import path from "node:path";
import { WorkspaceError } from "./errors.mjs";

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
