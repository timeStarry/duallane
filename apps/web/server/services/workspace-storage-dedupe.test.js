import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  createWorkspaceObjectStore,
  workspaceAttachmentObjectKey,
  workspaceContentObjectKey
} from "./workspace-object-store.mjs";
import { openTestDatabase } from "./test-database.mjs";
import { runWorkspaceStorageDedupe } from "./workspace-storage-dedupe.mjs";
import { resolveWorkspaceStoragePath } from "./workspace-storage.mjs";

describe("workspace storage dedupe", () => {
  const directories = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("backfills, verifies, and finalizes shared objects while preserving legacy paths", async () => {
    const dataDir = await makeDirectory();
    const db = openTestDatabase(dataDir);
    const observedLocks = [];
    const lock = db.lock;
    db.lock = async (key) => {
      observedLocks.push(key);
      await lock(key);
    };
    const store = await createWorkspaceObjectStore({ dataDir, env: { WORKSPACE_STORAGE_DRIVER: "local" } });
    const shared = Buffer.from("same bytes for attachment and avatar");
    const distinct = Buffer.from("normalized custom emote");
    const sharedSha256 = digest(shared);
    const distinctSha256 = digest(distinct);
    const attachmentKey = "workspace/spc_default/att-dedupe/private-report.txt";
    const avatarKey = "profile-avatars/usr_owner/dedupe.webp";
    const emoteKey = "custom-emotes/usr_owner/emote-dedupe/content.webp";
    await Promise.all([
      writeStorageFile(dataDir, attachmentKey, shared),
      writeStorageFile(dataDir, avatarKey, shared),
      writeStorageFile(dataDir, emoteKey, distinct)
    ]);
    const now = "2026-08-20T12:00:00.000Z";
    db.prepare(`INSERT INTO attachments (
      id, space_id, uploader_id, conversation_id, visibility, status, file_name, mime_type,
      byte_size, storage_key, upload_transfer_id, created_at, completed_at
    ) VALUES (?, 'spc_default', 'usr_owner', NULL, 'space', 'available', ?, 'text/plain', ?, ?, NULL, ?, ?)`)
      .run("att-dedupe", "private-report.txt", shared.byteLength, attachmentKey, now, now);
    db.prepare(`UPDATE users SET avatar_storage_key = ?, avatar_version = ?, avatar_updated_at = ? WHERE id = 'usr_owner'`)
      .run(avatarKey, "dedupe", now);
    db.prepare(`INSERT INTO workspace_custom_emotes (
      id, user_id, source_type, label, normalized_mime_type, byte_size, sha256,
      storage_key, sort_order, created_at, removed_at
    ) VALUES (?, 'usr_owner', 'upload', 'dedupe', 'image/webp', ?, ?, ?, 0, ?, NULL)`)
      .run("emote-dedupe", distinct.byteLength, distinctSha256, emoteKey, now);
    db.prepare(`INSERT INTO users (
      id, github_id, github_login, email, display_name, avatar_url, kind, created_at, last_login_at
    ) VALUES ('usr_dedupe_clone', 'dedupe-clone', 'dedupe-clone', NULL, 'Dedupe clone', NULL, 'human', ?, NULL)`)
      .run(now);
    db.prepare("UPDATE workspace_custom_emotes SET removed_at = ? WHERE id = 'emote-dedupe'").run(now);
    db.prepare(`INSERT INTO workspace_custom_emotes (
      id, user_id, source_type, source_custom_emote_id, label, normalized_mime_type,
      byte_size, sha256, storage_key, sort_order, created_at, removed_at
    ) VALUES ('emote-dedupe-clone', 'usr_dedupe_clone', 'custom', 'emote-dedupe',
      'dedupe clone', 'image/webp', ?, ?, NULL, 0, ?, NULL)`)
      .run(distinct.byteLength, distinctSha256, now);

    const backfill = await runWorkspaceStorageDedupe({
      db,
      store,
      dataDir,
      runId: "dedupe-20260820",
      mode: "backfill"
    });
    expect(backfill).toMatchObject({
      status: "completed",
      counts: {
        total: 4,
        processed: 4,
        created: 2,
        reused: 1,
        deduplicatedBytes: shared.byteLength + distinct.byteLength
      }
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_storage_objects").get().count).toBe(2);
    expect(db.prepare("SELECT storage_object_id AS storageObjectId FROM attachments WHERE id = 'att-dedupe'").get().storageObjectId)
      .toBe(`wso_${sharedSha256}`);
    const rootEmoteObjectId = db.prepare("SELECT storage_object_id AS id FROM workspace_custom_emotes WHERE id = 'emote-dedupe'").get().id;
    expect(db.prepare("SELECT storage_object_id AS id FROM workspace_custom_emotes WHERE id = 'emote-dedupe-clone'").get().id)
      .toBe(rootEmoteObjectId);
    expect(observedLocks).toContain(`workspace-storage-object:wso_${sharedSha256}`);
    expect(observedLocks).toContain(`workspace-storage-object:wso_${distinctSha256}`);

    const verified = await runWorkspaceStorageDedupe({
      db,
      store,
      dataDir,
      runId: "dedupe-20260820",
      mode: "verify"
    });
    expect(verified.counts).toMatchObject({ verified: 3, finalized: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_storage_objects WHERE verified_at IS NOT NULL").get().count).toBe(2);

    const finalized = await runWorkspaceStorageDedupe({
      db,
      store,
      dataDir,
      runId: "dedupe-20260820",
      mode: "finalize"
    });
    expect(finalized.counts).toMatchObject({ verified: 3, finalized: 3 });
    const attachmentObjectId = db.prepare("SELECT storage_object_id AS id FROM attachments WHERE id = 'att-dedupe'").get().id;
    expect(db.prepare("SELECT avatar_storage_object_id AS id FROM users WHERE id = 'usr_owner'").get().id).toBe(attachmentObjectId);
    expect(db.prepare("SELECT storage_object_id AS id FROM workspace_custom_emotes WHERE id = 'emote-dedupe'").get().id)
      .not.toBe(attachmentObjectId);
    expect(attachmentObjectId).toBe(`wso_${sharedSha256}`);

    await expect(readFile(resolveWorkspaceStoragePath(dataDir, attachmentKey))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(resolveWorkspaceStoragePath(dataDir, avatarKey))).rejects.toMatchObject({ code: "ENOENT" });
    const resumed = await runWorkspaceStorageDedupe({
      db,
      store,
      dataDir,
      runId: "dedupe-20260820",
      mode: "finalize"
    });
    expect(resumed.counts.finalized).toBe(3);
    const verifiedWithoutLegacy = await runWorkspaceStorageDedupe({
      db,
      store,
      dataDir,
      runId: "dedupe-20260820",
      mode: "verify"
    });
    expect(verifiedWithoutLegacy.counts.verified).toBe(3);

    const reportPath = path.join(dataDir, "workspace-storage-dedupe-reports", "dedupe-20260820-finalize.json");
    const reportText = await readFile(reportPath, "utf8");
    expect(reportText).not.toContain("private-report.txt");
    expect(reportText).not.toContain(attachmentKey);
    if (process.platform !== "win32") {
      expect((await stat(reportPath)).mode & 0o077).toBe(0);
      expect((await stat(path.dirname(reportPath))).mode & 0o077).toBe(0);
    }
  });

  it("does not delete any legacy object until every canonical object verifies", async () => {
    const dataDir = await makeDirectory();
    const db = openTestDatabase(dataDir);
    const store = await createWorkspaceObjectStore({ dataDir, env: { WORKSPACE_STORAGE_DRIVER: "local" } });
    const first = Buffer.from("first legacy object");
    const second = Buffer.from("second legacy object");
    const firstKey = "workspace/spc_default/att-first/first.bin";
    const secondKey = "workspace/spc_default/att-second/second.bin";
    await Promise.all([
      writeStorageFile(dataDir, firstKey, first),
      writeStorageFile(dataDir, secondKey, second)
    ]);
    const now = "2026-08-20T12:00:00.000Z";
    const insert = db.prepare(`INSERT INTO attachments (
      id, space_id, uploader_id, conversation_id, visibility, status, file_name, mime_type,
      byte_size, storage_key, upload_transfer_id, created_at, completed_at
    ) VALUES (?, 'spc_default', 'usr_owner', NULL, 'space', 'available', ?, 'application/octet-stream', ?, ?, NULL, ?, ?)`);
    insert.run("att-first", "first.bin", first.byteLength, firstKey, now, now);
    insert.run("att-second", "second.bin", second.byteLength, secondKey, now, now);
    await runWorkspaceStorageDedupe({ db, store, dataDir, runId: "dedupe-atomic", mode: "backfill" });
    const broken = db.prepare(`SELECT object_key AS objectKey FROM workspace_storage_objects
      WHERE sha256 = ?`).get(digest(second));
    await writeFile(resolveWorkspaceStoragePath(dataDir, broken.objectKey), "corrupted");

    await expect(runWorkspaceStorageDedupe({
      db,
      store,
      dataDir,
      runId: "dedupe-atomic",
      mode: "finalize"
    })).rejects.toMatchObject({ record: { kind: "attachment", id: "att-second" } });
    await expect(readFile(resolveWorkspaceStoragePath(dataDir, firstKey))).resolves.toEqual(first);
    await expect(readFile(resolveWorkspaceStoragePath(dataDir, secondKey))).resolves.toEqual(second);
  });

  it("backfills, verifies, finalizes, and re-verifies canonical S3 bytes without legacy fallback", async () => {
    const dataDir = await makeDirectory();
    const db = openTestDatabase(dataDir);
    const credentialsPath = path.join(dataDir, "s3-credentials.json");
    await writeFile(credentialsPath, JSON.stringify({ accessKey: "test-access", secretKey: "test-secret" }));
    const objects = new Map();
    const getObjectKeys = [];
    const client = fakeS3Client(objects, getObjectKeys);
    const store = await createWorkspaceObjectStore({
      dataDir,
      env: s3Env(credentialsPath),
      s3Client: client,
      publicS3Client: client,
      uploadFactory: fakeS3UploadFactory(objects)
    });
    const content = Buffer.from("dedupe S3 full digest bytes");
    const sha256 = digest(content);
    const attachment = {
      id: "att-s3-dedupe",
      spaceId: "spc_default",
      storageKey: "workspace/spc_default/att-s3-dedupe/private-name.bin",
      byteSize: content.byteLength
    };
    const legacyKey = workspaceAttachmentObjectKey(attachment);
    const canonicalKey = workspaceContentObjectKey(sha256);
    objects.set(legacyKey, { body: content, metadata: {} });
    const now = "2026-08-20T12:00:00.000Z";
    db.prepare(`INSERT INTO attachments (
      id, space_id, uploader_id, conversation_id, visibility, status, file_name, mime_type,
      byte_size, storage_key, upload_transfer_id, created_at, completed_at
    ) VALUES (?, 'spc_default', 'usr_owner', NULL, 'space', 'available', ?,
      'application/octet-stream', ?, ?, NULL, ?, ?)`)
      .run(attachment.id, "private-name.bin", content.byteLength, attachment.storageKey, now, now);

    const backfill = await runWorkspaceStorageDedupe({
      db,
      store,
      dataDir,
      runId: "dedupe-s3-20260820",
      mode: "backfill"
    });
    expect(backfill.counts).toMatchObject({ total: 1, created: 1, processed: 1 });
    expect([...objects.keys()].sort()).toEqual([canonicalKey, legacyKey].sort());
    expect(objects.get(canonicalKey)).toMatchObject({
      body: content,
      metadata: {
        "duallane-sha256": sha256,
        "duallane-size": String(content.byteLength)
      }
    });
    expect(db.prepare(`SELECT object_key AS objectKey FROM workspace_storage_objects
      WHERE id = ?`).get(`wso_${sha256}`).objectKey).toBe(canonicalKey);

    const verified = await runWorkspaceStorageDedupe({
      db,
      store,
      dataDir,
      runId: "dedupe-s3-20260820",
      mode: "verify"
    });
    expect(verified.counts.verified).toBe(1);

    const finalized = await runWorkspaceStorageDedupe({
      db,
      store,
      dataDir,
      runId: "dedupe-s3-20260820",
      mode: "finalize"
    });
    expect(finalized.counts).toMatchObject({ verified: 1, finalized: 1, legacyDeleted: 1 });
    expect(objects.has(legacyKey)).toBe(false);
    expect([...objects.keys()]).toEqual([canonicalKey]);

    const verifiedWithoutLegacy = await runWorkspaceStorageDedupe({
      db,
      store,
      dataDir,
      runId: "dedupe-s3-20260820",
      mode: "verify"
    });
    expect(verifiedWithoutLegacy.counts.verified).toBe(1);
    expect(getObjectKeys.filter((key) => key === canonicalKey)).toHaveLength(3);
    await expect(store.readObject({
      sha256,
      byteSize: content.byteLength,
      objectKey: canonicalKey
    })).resolves.toEqual(content);
  });

  it("fails closed with a stable record when custom-emote clone sources form a cycle", async () => {
    const dataDir = await makeDirectory();
    const db = openTestDatabase(dataDir);
    const store = await createWorkspaceObjectStore({ dataDir, env: { WORKSPACE_STORAGE_DRIVER: "local" } });
    const now = "2026-08-20T12:00:00.000Z";
    db.prepare(`INSERT INTO workspace_custom_emotes (
      id, user_id, source_type, label, sort_order, created_at, removed_at
    ) VALUES (?, 'usr_owner', 'custom', ?, 0, ?, NULL)`)
      .run("emote-cycle-a", "cycle a", now);
    db.prepare(`INSERT INTO workspace_custom_emotes (
      id, user_id, source_type, label, sort_order, created_at, removed_at
    ) VALUES (?, 'usr_owner', 'custom', ?, 1, ?, NULL)`)
      .run("emote-cycle-b", "cycle b", now);
    db.prepare("UPDATE workspace_custom_emotes SET source_custom_emote_id = 'emote-cycle-b' WHERE id = 'emote-cycle-a'").run();
    db.prepare("UPDATE workspace_custom_emotes SET source_custom_emote_id = 'emote-cycle-a' WHERE id = 'emote-cycle-b'").run();

    await expect(runWorkspaceStorageDedupe({
      db,
      store,
      dataDir,
      runId: "dedupe-cycle",
      mode: "backfill"
    })).rejects.toMatchObject({
      code: "storage.dedupe_unresolved_clone",
      record: { kind: "customEmote", id: "emote-cycle-a" }
    });
  });

  async function makeDirectory() {
    const directory = await mkdtemp(path.join(tmpdir(), "duallane-storage-dedupe-"));
    directories.push(directory);
    return directory;
  }
});

function digest(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function writeStorageFile(dataDir, storageKey, content) {
  const target = resolveWorkspaceStoragePath(dataDir, storageKey);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

function fakeS3Client(objects, getObjectKeys) {
  return {
    async send(command) {
      const name = command.constructor.name;
      const key = command.input.Key;
      if (name === "DeleteObjectCommand") {
        objects.delete(key);
        return {};
      }
      const object = objects.get(key);
      if (!object) throw missingS3Object();
      if (name === "HeadObjectCommand") {
        return { ContentLength: object.body.byteLength, Metadata: object.metadata };
      }
      if (name === "GetObjectCommand") {
        getObjectKeys.push(key);
        return { Body: Readable.from(object.body) };
      }
      throw new Error(`unexpected command ${name}`);
    },
    destroy() {}
  };
}

function fakeS3UploadFactory(objects) {
  return ({ params }) => ({
    async done() {
      const chunks = [];
      for await (const chunk of params.Body) chunks.push(Buffer.from(chunk));
      objects.set(params.Key, { body: Buffer.concat(chunks), metadata: params.Metadata });
    }
  });
}

function missingS3Object() {
  const error = new Error("missing");
  error.name = "NoSuchKey";
  error.$metadata = { httpStatusCode: 404 };
  return error;
}

function s3Env(credentialsPath) {
  return {
    WORKSPACE_STORAGE_DRIVER: "s3",
    WORKSPACE_S3_ENDPOINT: "http://100.99.0.4:9000",
    WORKSPACE_S3_PUBLIC_ENDPOINT: "https://fs.tsio.top",
    WORKSPACE_S3_BUCKET: "duallane",
    WORKSPACE_S3_REGION: "us-east-1",
    WORKSPACE_S3_CREDENTIALS_FILE: credentialsPath,
    WORKSPACE_S3_SIGNED_URL_TTL_SECONDS: "300",
    WORKSPACE_STORAGE_LOCAL_READ_FALLBACK: "false",
    WORKSPACE_STORAGE_LOCAL_MIRROR_WRITE: "false"
  };
}
