import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceObjectStore } from "./workspace-object-store.mjs";
import { createWorkspaceStorageObjectRegistry } from "./workspace-storage-objects.mjs";
import { openTestDatabase } from "./test-database.mjs";

describe("workspace storage object registry", () => {
  const directories = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("acquires one digest row and deletes bytes only after the last reference is released", async () => {
    const dataDir = await makeDirectory();
    const db = openTestDatabase(dataDir);
    const objectStore = await createWorkspaceObjectStore({ dataDir, env: { WORKSPACE_STORAGE_DRIVER: "local" } });
    const registry = createWorkspaceStorageObjectRegistry({ db, objectStore });
    const content = Buffer.from("registry shared bytes");
    const sha256 = createHash("sha256").update(content).digest("hex");
    const [first, second] = await Promise.all([
      registry.acquireObject({ sha256, byteSize: content.byteLength, stream: Readable.from(content) }),
      registry.acquireObject({ sha256, byteSize: content.byteLength, stream: Readable.from(content) })
    ]);
    expect(first.id).toBe(second.id);
    expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_storage_objects").get().count).toBe(1);

    const now = new Date().toISOString();
    const insert = db.prepare(`INSERT INTO attachments (
      id, space_id, uploader_id, conversation_id, visibility, status, file_name, mime_type,
      byte_size, storage_key, upload_transfer_id, created_at, completed_at
    ) VALUES (?, 'spc_default', 'usr_owner', NULL, 'space', 'available', ?, 'text/plain', ?, ?, NULL, ?, ?)`);
    insert.run("att-registry-1", "one.txt", content.byteLength, "legacy/one.txt", now, now);
    db.prepare(`INSERT INTO users (
      id, github_id, github_login, email, display_name, avatar_url, kind, created_at, last_login_at
    ) VALUES ('usr_registry_other', 'registry-other', 'registry-other', NULL, 'Registry other', NULL, 'human', ?, NULL)`)
      .run(now);
    db.prepare(`UPDATE users SET avatar_storage_key = 'legacy/avatar.webp', avatar_version = 'registry'
      WHERE id = 'usr_registry_other'`).run();
    db.prepare(`INSERT INTO workspace_custom_emotes (
      id, user_id, source_type, label, normalized_mime_type, byte_size, sha256,
      storage_key, sort_order, created_at, removed_at
    ) VALUES ('emote-registry', 'usr_owner', 'upload', 'registry', 'image/webp', ?, ?,
      'legacy/emote.webp', 0, ?, NULL)`).run(content.byteLength, sha256, now);
    await expect(registry.acquireAndBind({
      kind: "attachment",
      resourceId: "att-registry-1",
      sha256,
      byteSize: content.byteLength
    })).resolves.toMatchObject({ object: { id: first.id }, previousStorageObjectId: null });
    await registry.bindObject({ kind: "avatar", resourceId: "usr_registry_other", storageObjectId: first.id });
    await registry.bindObject({ kind: "customEmote", resourceId: "emote-registry", storageObjectId: first.id });
    await expect(registry.countReferences(first.id)).resolves.toBe(3);

    await expect(registry.releaseObject({
      kind: "attachment",
      resourceId: "att-registry-1",
      storageObjectId: first.id
    })).resolves.toMatchObject({ released: true, deleted: false, references: 2 });
    await expect(objectStore.readObject(first)).resolves.toEqual(content);
    await expect(registry.releaseObject({
      kind: "avatar",
      resourceId: "usr_registry_other",
      storageObjectId: first.id
    })).resolves.toMatchObject({ released: true, deleted: false, references: 1 });
    await expect(registry.releaseObject({
      kind: "customEmote",
      resourceId: "emote-registry",
      storageObjectId: first.id
    })).resolves.toMatchObject({ released: true, deleted: true, references: 0 });
    await expect(objectStore.readObject(first)).rejects.toMatchObject({ code: "file.storage_missing" });
    await expect(registry.loadObjectById(first.id)).rejects.toMatchObject({ code: "storage.object_not_found" });

    const reacquired = await registry.acquireObject({
      sha256,
      byteSize: content.byteLength,
      stream: Readable.from(content)
    });
    expect(reacquired).toMatchObject({ id: first.id, deletedAt: null });
    await expect(objectStore.readObject(reacquired)).resolves.toEqual(content);
  });

  it("defers previous-object cleanup until an outer mutation has committed", async () => {
    const dataDir = await makeDirectory();
    const db = openTestDatabase(dataDir);
    const objectStore = await createWorkspaceObjectStore({ dataDir, env: { WORKSPACE_STORAGE_DRIVER: "local" } });
    const registry = createWorkspaceStorageObjectRegistry({ db, objectStore });
    const previousBytes = Buffer.from("previous bytes");
    const nextBytes = Buffer.from("next bytes");
    const previous = await registry.acquireObject({
      sha256: createHash("sha256").update(previousBytes).digest("hex"),
      byteSize: previousBytes.byteLength,
      stream: Readable.from(previousBytes)
    });
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO attachments (
      id, space_id, uploader_id, conversation_id, visibility, status, file_name, mime_type,
      byte_size, storage_key, upload_transfer_id, created_at, completed_at, storage_object_id
    ) VALUES ('att-deferred', 'spc_default', 'usr_owner', NULL, 'space', 'available',
      'deferred.txt', 'text/plain', ?, 'legacy/deferred.txt', NULL, ?, ?, ?)`)
      .run(previousBytes.byteLength, now, now, previous.id);

    const rebound = await registry.acquireAndBind({
      kind: "attachment",
      resourceId: "att-deferred",
      sha256: createHash("sha256").update(nextBytes).digest("hex"),
      byteSize: nextBytes.byteLength,
      stream: Readable.from(nextBytes),
      cleanupPrevious: false
    });
    expect(rebound.previousStorageObjectId).toBe(previous.id);
    await expect(registry.countReferences(previous.id)).resolves.toBe(0);
    await expect(objectStore.readObject(previous)).resolves.toEqual(previousBytes);
    await expect(registry.cleanupIfUnreferenced(previous.id)).resolves.toMatchObject({ deleted: true });
    await expect(objectStore.readObject(previous)).rejects.toMatchObject({ code: "file.storage_missing" });
  });

  it("cleans a physical orphan when an outer acquire-and-bind transaction rolls back", async () => {
    const dataDir = await makeDirectory();
    const db = openTestDatabase(dataDir);
    const objectStore = await createWorkspaceObjectStore({ dataDir, env: { WORKSPACE_STORAGE_DRIVER: "local" } });
    const registry = createWorkspaceStorageObjectRegistry({ db, objectStore });
    const content = Buffer.from("rolled back canonical bytes");
    const sha256 = createHash("sha256").update(content).digest("hex");
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO attachments (
      id, space_id, uploader_id, conversation_id, visibility, status, file_name, mime_type,
      byte_size, storage_key, upload_transfer_id, created_at, completed_at
    ) VALUES ('att-rollback', 'spc_default', 'usr_owner', NULL, 'space', 'available',
      'rollback.txt', 'text/plain', ?, 'legacy/rollback.txt', NULL, ?, ?)`)
      .run(content.byteLength, now, now);
    let acquired;
    await expect(db.transaction(async () => {
      const binding = await registry.acquireAndBind({
        kind: "attachment",
        resourceId: "att-rollback",
        sha256,
        byteSize: content.byteLength,
        stream: Readable.from(content),
        cleanupPrevious: false
      });
      acquired = binding.object;
      throw new Error("later metadata mutation failed");
    })).rejects.toThrow("later metadata mutation failed");
    expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_storage_objects WHERE id = ?").get(acquired.id).count).toBe(0);
    await expect(objectStore.readObject(acquired)).resolves.toEqual(content);
    await expect(registry.cleanupAcquiredObject(acquired)).resolves.toEqual({
      deleted: true,
      references: 0,
      orphan: true
    });
    await expect(registry.cleanupAcquiredObject(acquired)).resolves.toMatchObject({ deleted: true, orphan: true });
    await expect(objectStore.readObject(acquired)).rejects.toMatchObject({ code: "file.storage_missing" });
  });

  async function makeDirectory() {
    const directory = await mkdtemp(path.join(tmpdir(), "duallane-storage-registry-"));
    directories.push(directory);
    return directory;
  }
});
