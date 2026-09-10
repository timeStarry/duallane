import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { createWorkspaceObjectStore, workspaceAttachmentObjectKey, workspaceContentObjectKey } from "../lib/object-store.mjs";
import { runWorkspaceStorageDedupe } from "../lib/storage-dedupe.mjs";
import { resolveWorkspaceStoragePath } from "../lib/storage-paths.mjs";

const directories = [];
const databases = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("local dedupe backfills shared objects, binds clones, and refuses finalize before every hash verifies", async () => {
  const dataDir = await makeDirectory("duallane-node-compat-dedupe-local-");
  const { db, locks } = makeStorageDb();
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
  insertAttachment(db, "att-dedupe", attachmentKey, shared.byteLength, "text/plain");
  db.prepare(`INSERT INTO users (id, avatar_storage_key, avatar_storage_object_id, avatar_version)
    VALUES (?, ?, NULL, ?)`)
    .run("usr_owner", avatarKey, "dedupe");
  insertEmote(db, "emote-dedupe", "usr_owner", emoteKey, distinct.byteLength, distinctSha256, null, "image/webp");
  insertEmote(db, "emote-dedupe-clone", "usr_dedupe_clone", null, distinct.byteLength, distinctSha256, "emote-dedupe", "image/webp");

  const backfill = await runWorkspaceStorageDedupe({
    db,
    store,
    dataDir,
    runId: "dedupe-20260820",
    mode: "backfill"
  });
  assert.equal(backfill.status, "completed");
  assert.deepEqual({
    total: backfill.counts.total,
    processed: backfill.counts.processed,
    created: backfill.counts.created,
    reused: backfill.counts.reused,
    deduplicatedBytes: backfill.counts.deduplicatedBytes
  }, {
    total: 4,
    processed: 4,
    created: 2,
    reused: 1,
    deduplicatedBytes: shared.byteLength + distinct.byteLength
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM workspace_storage_objects").get().count, 2);
  assert.equal(
    db.prepare("SELECT storage_object_id AS storageObjectId FROM attachments WHERE id = ?").get("att-dedupe").storageObjectId,
    `wso_${sharedSha256}`
  );
  const rootObjectId = db.prepare(
    "SELECT storage_object_id AS storageObjectId FROM workspace_custom_emotes WHERE id = ?"
  ).get("emote-dedupe").storageObjectId;
  assert.equal(
    db.prepare("SELECT storage_object_id AS storageObjectId FROM workspace_custom_emotes WHERE id = ?")
      .get("emote-dedupe-clone").storageObjectId,
    rootObjectId
  );
  assert.ok(locks.includes(`workspace-storage-object:wso_${sharedSha256}`));
  assert.ok(locks.includes(`workspace-storage-object:wso_${distinctSha256}`));

  const verified = await runWorkspaceStorageDedupe({
    db,
    store,
    dataDir,
    runId: "dedupe-20260820",
    mode: "verify"
  });
  assert.deepEqual({ verified: verified.counts.verified, finalized: verified.counts.finalized }, { verified: 3, finalized: 0 });
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM workspace_storage_objects WHERE verified_at IS NOT NULL").get().count,
    2
  );

  const brokenObject = db.prepare("SELECT object_key AS objectKey FROM workspace_storage_objects WHERE sha256 = ?")
    .get(distinctSha256);
  await writeFile(resolveWorkspaceStoragePath(dataDir, brokenObject.objectKey), "corrupted canonical bytes");
  await assert.rejects(
    runWorkspaceStorageDedupe({
      db,
      store,
      dataDir,
      runId: "dedupe-20260820",
      mode: "finalize"
    }),
    (error) => error.code === "file.storage_mismatch" &&
      error.record?.kind === "customEmote" && error.record?.id === "emote-dedupe"
  );
  assert.deepEqual(await readFile(resolveWorkspaceStoragePath(dataDir, attachmentKey)), shared);
  assert.deepEqual(await readFile(resolveWorkspaceStoragePath(dataDir, avatarKey)), shared);
  assert.deepEqual(await readFile(resolveWorkspaceStoragePath(dataDir, emoteKey)), distinct);
  const failedReport = JSON.parse(await readFile(
    path.join(dataDir, "workspace-storage-dedupe-reports", "dedupe-20260820-finalize.json"),
    "utf8"
  ));
  assert.equal(failedReport.status, "failed");
  assert.deepEqual(failedReport.failedRecord, { kind: "customEmote", id: "emote-dedupe" });
  assert.doesNotMatch(JSON.stringify(failedReport), /private-report\.txt|workspace\/spc_default/);

  await writeStorageFile(dataDir, brokenObject.objectKey, distinct);
  const finalized = await runWorkspaceStorageDedupe({
    db,
    store,
    dataDir,
    runId: "dedupe-20260820",
    mode: "finalize"
  });
  assert.deepEqual({ verified: finalized.counts.verified, finalized: finalized.counts.finalized }, { verified: 3, finalized: 3 });
  await assert.rejects(readFile(resolveWorkspaceStoragePath(dataDir, attachmentKey)), { code: "ENOENT" });
  await assert.rejects(readFile(resolveWorkspaceStoragePath(dataDir, avatarKey)), { code: "ENOENT" });
  await assert.rejects(readFile(resolveWorkspaceStoragePath(dataDir, emoteKey)), { code: "ENOENT" });
  assert.deepEqual(await readFile(resolveWorkspaceStoragePath(dataDir, brokenObject.objectKey)), distinct);

  const resumed = await runWorkspaceStorageDedupe({
    db,
    store,
    dataDir,
    runId: "dedupe-20260820",
    mode: "finalize"
  });
  assert.equal(resumed.counts.finalized, 3);
  const reportPath = path.join(dataDir, "workspace-storage-dedupe-reports", "dedupe-20260820-finalize.json");
  assert.equal(JSON.parse(await readFile(reportPath, "utf8")).status, "completed");
  if (process.platform !== "win32") {
    assert.equal((await stat(reportPath)).mode & 0o077, 0);
    assert.equal((await stat(path.dirname(reportPath))).mode & 0o077, 0);
  }
});

test("S3 dedupe verifies canonical bodies and deletes only the feature-scoped legacy object", async () => {
  const dataDir = await makeDirectory("duallane-node-compat-dedupe-s3-");
  const { db } = makeStorageDb();
  const credentialsPath = path.join(dataDir, "s3-credentials.json");
  await writeFile(credentialsPath, JSON.stringify({ accessKey: "test-access", secretKey: "test-secret" }));
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
  const objects = new Map([[legacyKey, { body: content, metadata: {} }]]);
  const client = fakeS3Client(objects);
  const store = await createWorkspaceObjectStore({
    dataDir,
    env: s3Env(credentialsPath),
    s3Client: client,
    uploadFactory: fakeS3UploadFactory(objects)
  });
  await store.assertReady();
  insertAttachment(db, attachment.id, attachment.storageKey, content.byteLength, "application/octet-stream");

  const backfill = await runWorkspaceStorageDedupe({
    db,
    store,
    dataDir,
    runId: "dedupe-s3-20260820",
    mode: "backfill"
  });
  assert.deepEqual({ total: backfill.counts.total, created: backfill.counts.created }, { total: 1, created: 1 });
  assert.deepEqual([...objects.keys()].sort(), [canonicalKey, legacyKey].sort());
  assert.deepEqual(objects.get(canonicalKey), {
    body: content,
    metadata: {
      "duallane-kind": "content-object",
      "duallane-id": sha256,
      "duallane-size": String(content.byteLength),
      "duallane-sha256": sha256
    }
  });

  objects.get(canonicalKey).body = Buffer.alloc(content.byteLength, 0x78);
  await assert.rejects(
    runWorkspaceStorageDedupe({
      db,
      store,
      dataDir,
      runId: "dedupe-s3-20260820",
      mode: "finalize"
    }),
    (error) => error.code === "storage.dedupe_object_mismatch" && error.record?.id === attachment.id
  );
  assert.ok(objects.has(legacyKey), "legacy S3 object must remain after failed verification");
  objects.get(canonicalKey).body = content;

  const finalized = await runWorkspaceStorageDedupe({
    db,
    store,
    dataDir,
    runId: "dedupe-s3-20260820",
    mode: "finalize"
  });
  assert.deepEqual({ verified: finalized.counts.verified, finalized: finalized.counts.finalized }, { verified: 1, finalized: 1 });
  assert.equal(objects.has(legacyKey), false);
  assert.equal(objects.get(canonicalKey).body.equals(content), true);
  const verifiedWithoutLegacy = await runWorkspaceStorageDedupe({
    db,
    store,
    dataDir,
    runId: "dedupe-s3-20260820",
    mode: "verify"
  });
  assert.equal(verifiedWithoutLegacy.counts.verified, 1);
});

test("dedupe fails closed for a custom-emote clone cycle and writes a private failure report", async () => {
  const dataDir = await makeDirectory("duallane-node-compat-dedupe-cycle-");
  const { db } = makeStorageDb();
  const store = await createWorkspaceObjectStore({ dataDir, env: { WORKSPACE_STORAGE_DRIVER: "local" } });
  insertEmote(db, "emote-cycle-a", "usr_owner", null, null, null, "emote-cycle-b", "image/webp");
  insertEmote(db, "emote-cycle-b", "usr_owner", null, null, null, "emote-cycle-a", "image/webp");

  await assert.rejects(
    runWorkspaceStorageDedupe({ db, store, dataDir, runId: "dedupe-cycle", mode: "backfill" }),
    (error) => error.code === "storage.dedupe_unresolved_clone" &&
      error.record?.kind === "customEmote" && error.record?.id === "emote-cycle-a"
  );
  const report = JSON.parse(await readFile(
    path.join(dataDir, "workspace-storage-dedupe-reports", "dedupe-cycle-backfill.json"),
    "utf8"
  ));
  assert.equal(report.status, "failed");
  assert.deepEqual(report.failedRecord, { kind: "customEmote", id: "emote-cycle-a" });
});

function makeStorageDb() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(`
    CREATE TABLE attachments (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      storage_key TEXT,
      storage_object_id TEXT,
      mime_type TEXT,
      byte_size INTEGER,
      status TEXT NOT NULL
    );
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      avatar_storage_key TEXT,
      avatar_storage_object_id TEXT,
      avatar_version TEXT
    );
    CREATE TABLE workspace_custom_emotes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      source_custom_emote_id TEXT,
      storage_key TEXT,
      storage_object_id TEXT,
      normalized_mime_type TEXT,
      byte_size INTEGER,
      sha256 TEXT,
      removed_at TEXT
    );
    CREATE TABLE workspace_storage_objects (
      id TEXT PRIMARY KEY,
      sha256 TEXT NOT NULL UNIQUE,
      object_key TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      content_type TEXT,
      created_at TEXT NOT NULL,
      verified_at TEXT,
      deleted_at TEXT
    );
  `);
  const locks = [];
  const db = {
    prepare(sql) {
      const statement = raw.prepare(sql);
      return {
        all(...values) { return statement.all(...values); },
        get(...values) { return statement.get(...values); },
        run(...values) { return statement.run(...values); }
      };
    },
    async transaction(callback) {
      raw.exec("BEGIN");
      try {
        const result = await callback();
        raw.exec("COMMIT");
        return result;
      } catch (error) {
        raw.exec("ROLLBACK");
        throw error;
      }
    },
    async lock(key) {
      locks.push(key);
    }
  };
  const result = { db, locks, close: () => raw.close() };
  databases.push(result);
  return result;
}

function insertAttachment(db, id, storageKey, byteSize, contentType) {
  db.prepare(`INSERT INTO attachments (
    id, space_id, storage_key, storage_object_id, mime_type, byte_size, status
  ) VALUES (?, 'spc_default', ?, NULL, ?, ?, 'available')`).run(
    id, storageKey, contentType, byteSize
  );
}

function insertEmote(db, id, userId, storageKey, byteSize, sha256, sourceId, contentType) {
  db.prepare(`INSERT INTO workspace_custom_emotes (
    id, user_id, source_custom_emote_id, storage_key, storage_object_id,
    normalized_mime_type, byte_size, sha256, removed_at
  ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL)`).run(
    id, userId, sourceId, storageKey, contentType, byteSize, sha256
  );
}

async function makeDirectory(prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

async function writeStorageFile(dataDir, storageKey, content) {
  const target = resolveWorkspaceStoragePath(dataDir, storageKey);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

function fakeS3Client(objects) {
  return {
    async send(command) {
      const name = command.constructor.name;
      const key = command.input.Key;
      if (name === "HeadBucketCommand") return {};
      if (name === "DeleteObjectCommand") {
        objects.delete(key);
        return {};
      }
      const object = objects.get(key);
      if (!object) throw missingS3Object();
      if (name === "HeadObjectCommand") {
        return { ContentLength: object.body.byteLength, Metadata: object.metadata };
      }
      if (name === "GetObjectCommand") return { Body: Readable.from(object.body) };
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

function digest(content) {
  return createHash("sha256").update(content).digest("hex");
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
