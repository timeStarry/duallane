import { WorkspaceError } from "./workspace.mjs";
import {
  normalizeWorkspaceObjectSha256,
  resolveWorkspaceContentObjectKey,
  workspaceContentObjectKey
} from "./workspace-storage.mjs";

export function createWorkspaceStorageObjectRegistry({
  db,
  objectStore,
  now = () => new Date()
}) {
  if (!db || !objectStore) throw new TypeError("Workspace storage object registry requires db and objectStore");

  async function acquireObject({ sha256, byteSize, contentType, stream }) {
    const digest = normalizeWorkspaceObjectSha256(sha256);
    const size = normalizeByteSize(byteSize);
    const id = storageObjectId(digest);
    return await transaction(db, async () => {
      await lockObject(db, id);
      return await acquireLocked({ id, digest, size, contentType, stream });
    });
  }

  async function acquireAndBind({
    kind,
    resourceId,
    sha256,
    byteSize,
    contentType,
    stream,
    cleanupPrevious = true
  }) {
    const target = resourceTarget(kind);
    const digest = normalizeWorkspaceObjectSha256(sha256);
    const size = normalizeByteSize(byteSize);
    const id = storageObjectId(digest);
    let previousStorageObjectId = null;
    const object = await transaction(db, async () => {
      const current = await db.prepare(`SELECT ${target.referenceColumn} AS storageObjectId
        FROM ${target.table} WHERE id = ?`).get(resourceId);
      if (!current) throw registryError("storage.resource_not_found", "存储资源不存在", 404);
      previousStorageObjectId = current.storageObjectId ?? null;
      for (const objectId of [...new Set([previousStorageObjectId, id].filter(Boolean))].sort()) {
        await lockObject(db, objectId);
      }
      const acquired = await acquireLocked({ id, digest, size, contentType, stream });
      await db.prepare(`UPDATE ${target.table} SET ${target.referenceColumn} = ? WHERE id = ?`)
        .run(acquired.id, resourceId);
      return acquired;
    });
    if (cleanupPrevious && previousStorageObjectId && previousStorageObjectId !== object.id) {
      await cleanupIfUnreferenced(previousStorageObjectId);
    }
    return { object, previousStorageObjectId };
  }

  async function acquireLocked({ id, digest, size, contentType, stream }) {
    const objectKey = workspaceContentObjectKey(digest);
    const existing = await db.prepare("SELECT id FROM workspace_storage_objects WHERE sha256 = ?").get(digest);
    const ensured = await objectStore.ensureObject({ sha256: digest, byteSize: size, contentType, stream });
    await db.prepare(`INSERT INTO workspace_storage_objects (
      id, sha256, object_key, byte_size, content_type, created_at, verified_at, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
    ON CONFLICT (sha256) DO UPDATE SET
      content_type = COALESCE(workspace_storage_objects.content_type, excluded.content_type),
      deleted_at = NULL`).run(
      id,
      digest,
      objectKey,
      size,
      contentType || "application/octet-stream",
      now().toISOString()
    );
    const object = await loadObjectById(id);
    if (object.sha256 !== digest || object.objectKey !== objectKey || object.byteSize !== size) {
      throw registryError("storage.object_conflict", "存储对象登记冲突", 409);
    }
    return {
      ...object,
      created: !existing,
      storageCreated: ensured.created === true
    };
  }

  async function loadObjectById(storageObjectId, { includeDeleted = false } = {}) {
    const row = await db.prepare(`SELECT id, sha256, object_key AS objectKey,
      byte_size AS byteSize, content_type AS contentType, created_at AS createdAt,
      verified_at AS verifiedAt, deleted_at AS deletedAt
      FROM workspace_storage_objects WHERE id = ?`).get(storageObjectId);
    if (!row || (!includeDeleted && row.deletedAt)) {
      throw registryError("storage.object_not_found", "存储对象不存在", 404);
    }
    const byteSize = normalizeByteSize(row.byteSize);
    resolveWorkspaceContentObjectKey(row);
    return { ...row, byteSize };
  }

  async function bindObject({ kind, resourceId, storageObjectId, cleanupPrevious = true }) {
    const target = resourceTarget(kind);
    let previousStorageObjectId = null;
    const object = await transaction(db, async () => {
      const current = await db.prepare(`SELECT ${target.referenceColumn} AS storageObjectId
        FROM ${target.table} WHERE id = ?`).get(resourceId);
      if (!current) throw registryError("storage.resource_not_found", "存储资源不存在", 404);
      previousStorageObjectId = current.storageObjectId ?? null;
      for (const id of [...new Set([previousStorageObjectId, storageObjectId].filter(Boolean))].sort()) {
        await lockObject(db, id);
      }
      const next = await loadObjectById(storageObjectId);
      await db.prepare(`UPDATE ${target.table} SET ${target.referenceColumn} = ? WHERE id = ?`)
        .run(next.id, resourceId);
      return next;
    });
    if (cleanupPrevious && previousStorageObjectId && previousStorageObjectId !== object.id) {
      await cleanupIfUnreferenced(previousStorageObjectId);
    }
    return { object, previousStorageObjectId };
  }

  async function releaseObject({ kind, resourceId, storageObjectId }) {
    const target = resourceTarget(kind);
    const released = await transaction(db, async () => {
      await lockObject(db, storageObjectId);
      const current = await db.prepare(`SELECT ${target.referenceColumn} AS storageObjectId
        FROM ${target.table} WHERE id = ?`).get(resourceId);
      if (!current) throw registryError("storage.resource_not_found", "存储资源不存在", 404);
      if (!current.storageObjectId) return false;
      if (current.storageObjectId !== storageObjectId) {
        throw registryError("storage.reference_conflict", "存储对象引用已变化", 409);
      }
      await db.prepare(`UPDATE ${target.table} SET ${target.referenceColumn} = NULL WHERE id = ?`)
        .run(resourceId);
      return true;
    });
    const cleanup = released
      ? await cleanupIfUnreferenced(storageObjectId)
      : { deleted: false, references: 0 };
    return { released, ...cleanup };
  }

  async function countReferences(storageObjectId) {
    const row = await db.prepare(`SELECT
      (SELECT COUNT(*) FROM attachments WHERE storage_object_id = ?) +
      (SELECT COUNT(*) FROM users WHERE avatar_storage_object_id = ?) +
      (SELECT COUNT(*) FROM workspace_custom_emotes WHERE storage_object_id = ?) AS referenceCount`)
      .get(storageObjectId, storageObjectId, storageObjectId);
    return Number(row?.referenceCount ?? 0);
  }

  async function cleanupIfUnreferenced(storageObjectId) {
    return await transaction(db, async () => {
      await lockObject(db, storageObjectId);
      const object = await loadObjectById(storageObjectId, { includeDeleted: true });
      const references = await countReferences(storageObjectId);
      if (references > 0) return { deleted: false, references };
      await objectStore.deleteObject(object);
      await db.prepare("UPDATE workspace_storage_objects SET deleted_at = ? WHERE id = ?")
        .run(now().toISOString(), object.id);
      return { deleted: true, references: 0 };
    });
  }

  async function cleanupAcquiredObject(object) {
    const digest = normalizeWorkspaceObjectSha256(object?.sha256);
    const id = storageObjectId(digest);
    if (object?.id !== id) throw registryError("storage.object_invalid_id", "存储对象标识无效", 500);
    const canonical = {
      ...object,
      id,
      sha256: digest,
      byteSize: normalizeByteSize(object?.byteSize),
      objectKey: resolveWorkspaceContentObjectKey({ ...object, sha256: digest })
    };
    return await transaction(db, async () => {
      await lockObject(db, id);
      const row = await db.prepare("SELECT id FROM workspace_storage_objects WHERE id = ?").get(id);
      if (row) {
        const registered = await loadObjectById(id, { includeDeleted: true });
        const references = await countReferences(id);
        if (references > 0) return { deleted: false, references, orphan: false };
        await objectStore.deleteObject(registered);
        await db.prepare("UPDATE workspace_storage_objects SET deleted_at = ? WHERE id = ?")
          .run(now().toISOString(), id);
        return { deleted: true, references: 0, orphan: false };
      }
      await objectStore.deleteObject(canonical);
      return { deleted: true, references: 0, orphan: true };
    });
  }

  async function withObjectLock(storageObjectId, callback) {
    if (typeof callback !== "function") throw new TypeError("Workspace storage object lock requires a callback");
    return await transaction(db, async () => {
      await lockObject(db, storageObjectId);
      const object = await loadObjectById(storageObjectId);
      return await callback(object);
    });
  }

  return {
    acquireAndBind,
    acquireObject,
    bindObject,
    cleanupAcquiredObject,
    cleanupIfUnreferenced,
    countReferences,
    loadObjectById,
    releaseObject,
    withObjectLock
  };
}

function resourceTarget(kind) {
  if (kind === "attachment") return { table: "attachments", referenceColumn: "storage_object_id" };
  if (kind === "avatar") return { table: "users", referenceColumn: "avatar_storage_object_id" };
  if (kind === "customEmote") return { table: "workspace_custom_emotes", referenceColumn: "storage_object_id" };
  throw registryError("storage.resource_invalid_kind", "存储资源类型无效", 400);
}

function storageObjectId(sha256) {
  return `wso_${sha256}`;
}

function normalizeByteSize(value) {
  const byteSize = Number(value);
  if (!Number.isSafeInteger(byteSize) || byteSize < 0) {
    throw registryError("storage.object_invalid_size", "存储对象大小无效", 500);
  }
  return byteSize;
}

async function transaction(db, callback) {
  return typeof db.transaction === "function" ? await db.transaction(callback) : await callback();
}

async function lockObject(db, storageObjectId) {
  if (typeof db.lock === "function") await db.lock(`workspace-storage-object:${storageObjectId}`);
}

function registryError(code, message, statusCode) {
  return new WorkspaceError(code, message, statusCode);
}
