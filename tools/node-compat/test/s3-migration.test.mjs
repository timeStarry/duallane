import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  createWorkspaceS3MigrationStore,
  runWorkspaceS3Migration
} from "../lib/s3-migration.mjs";
import {
  resolveWorkspaceStoragePath
} from "../lib/storage-paths.mjs";

const directories = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("S3 migration backfills active records, archives unconsumed keys, verifies hashes, and resumes", async () => {
  const dataDir = await makeDirectory("duallane-node-compat-migration-");
  const credentialsPath = path.join(dataDir, "credentials.json");
  await writeFile(credentialsPath, JSON.stringify({ accessKey: "test-access", secretKey: "test-secret" }));
  const attachmentKey = "workspace/spc_default/att-1/report.txt";
  const historicalKey = "workspace/spc_default/att-old/old.bin";
  const avatarKey = "profile-avatars/usr_1/ver-1.webp";
  await writeStorageFile(dataDir, attachmentKey, "attachment bytes");
  await writeStorageFile(dataDir, historicalKey, "historical bytes");
  await writeStorageFile(dataDir, avatarKey, "avatar bytes");
  const objects = new Map();
  const store = await createWorkspaceS3MigrationStore({
    env: s3Env(credentialsPath),
    client: fakeS3Client(objects),
    uploadFactory: fakeUploadFactory(objects)
  });
  const db = fakeMigrationDb({
    attachments: [
      { id: "att-1", spaceId: "spc_default", storageKey: attachmentKey, mimeType: "text/plain", byteSize: 16, status: "available" },
      { id: "att-old", spaceId: "spc_default", storageKey: historicalKey, mimeType: "application/octet-stream", byteSize: 15, status: "failed" }
    ],
    avatars: [{ userId: "usr_1", storageKey: avatarKey, version: "ver-1" }]
  });

  await store.assertReady();
  const first = await runWorkspaceS3Migration({
    db,
    dataDir,
    store,
    runId: "run-20260807",
    mode: "backfill"
  });
  assert.deepEqual(first.counts, {
    total: 3,
    uploaded: 3,
    skipped: 0,
    verified: 3,
    attachments: 1,
    avatars: 1,
    archives: 1
  });
  assert.ok(objects.has("workspace/attachments/spc_default/att-1/content"));
  assert.ok(objects.has("workspace/profile-avatars/usr_1/ver-1.webp"));
  const archiveDigest = digest(Buffer.from("historical bytes"));
  assert.ok(objects.has(`workspace/migration-archive/run-20260807/${archiveDigest}`));
  assert.ok(!JSON.stringify([...objects.values()]).includes("report.txt"));

  const resumed = await runWorkspaceS3Migration({
    db,
    dataDir,
    store,
    runId: "run-20260807",
    mode: "backfill"
  });
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.counts.uploaded, 0);
  assert.equal(resumed.counts.skipped, 3);
  assert.equal(resumed.counts.verified, 3);
  const reportPath = path.join(dataDir, "workspace-s3-migration-reports", "run-20260807.json");
  assert.equal(JSON.parse(await readFile(reportPath, "utf8")).status, "completed");
  if (process.platform !== "win32") assert.equal((await stat(reportPath)).mode & 0o077, 0);
});

test("S3 migration fails closed on a remote body hash mismatch and writes a private failure report", async () => {
  const dataDir = await makeDirectory("duallane-node-compat-migration-failure-");
  const credentialsPath = path.join(dataDir, "credentials.json");
  await writeFile(credentialsPath, JSON.stringify({ accessKey: "test-access", secretKey: "test-secret" }));
  const key = "workspace/attachments/spc_default/att-verify/content";
  const objects = new Map([[key, {
    body: Buffer.from("corrupted-body"),
    metadata: {
      "duallane-size": "15",
      "duallane-sha256": digest(Buffer.from("expected-body"))
    }
  }]]);
  const store = await createWorkspaceS3MigrationStore({
    env: s3Env(credentialsPath),
    client: fakeS3Client(objects),
    uploadFactory: fakeUploadFactory(objects)
  });
  const db = fakeMigrationDb({
    attachments: [{
      id: "att-verify",
      spaceId: "spc_default",
      storageKey: "workspace/spc_default/att-verify/legacy.bin",
      mimeType: "application/octet-stream",
      byteSize: 15,
      status: "available"
    }],
    avatars: []
  });

  await assert.rejects(
    runWorkspaceS3Migration({ db, dataDir, store, runId: "run-bad-hash", mode: "verify" }),
    (error) => error.code === "storage.mismatch" && error.record?.id === "att-verify"
  );
  const report = JSON.parse(await readFile(
    path.join(dataDir, "workspace-s3-migration-reports", "run-bad-hash.json"),
    "utf8"
  ));
  assert.equal(report.status, "failed");
  assert.deepEqual(report.failedRecord, { kind: "attachment", id: "att-verify" });
  if (process.platform !== "win32") {
    assert.equal((await stat(path.join(dataDir, "workspace-s3-migration-reports", "run-bad-hash.json"))).mode & 0o077, 0);
  }
});

test("S3 migration rejects an active record missing both local and remote bytes", async () => {
  const dataDir = await makeDirectory("duallane-node-compat-migration-missing-");
  const credentialsPath = path.join(dataDir, "credentials.json");
  await writeFile(credentialsPath, JSON.stringify({ accessKey: "test-access", secretKey: "test-secret" }));
  const store = await createWorkspaceS3MigrationStore({
    env: s3Env(credentialsPath),
    client: fakeS3Client(new Map()),
    uploadFactory: fakeUploadFactory(new Map())
  });
  const db = fakeMigrationDb({
    attachments: [{
      id: "att-missing",
      spaceId: "spc_default",
      storageKey: "workspace/spc_default/att-missing/file.txt",
      mimeType: "text/plain",
      byteSize: 10,
      status: "available"
    }],
    avatars: []
  });

  await assert.rejects(
    runWorkspaceS3Migration({ db, dataDir, store, runId: "run-missing1", mode: "backfill" }),
    (error) => error.code === "storage.missing" && error.record?.id === "att-missing"
  );
});

async function makeDirectory(prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

async function writeStorageFile(dataDir, storageKey, content) {
  const targetPath = resolveWorkspaceStoragePath(dataDir, storageKey);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content);
}

function fakeMigrationDb({ attachments, avatars }) {
  return {
    prepare(sql) {
      return {
        async all() {
          return sql.includes("FROM attachments") ? attachments : avatars;
        }
      };
    }
  };
}

function fakeS3Client(objects) {
  return {
    async send(command) {
      const name = command.constructor.name;
      if (name === "HeadBucketCommand") return {};
      const object = objects.get(command.input.Key);
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

function fakeUploadFactory(objects) {
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
    WORKSPACE_S3_ENDPOINT: "http://100.99.0.4:9000",
    WORKSPACE_S3_PUBLIC_ENDPOINT: "https://fs.tsio.top",
    WORKSPACE_S3_BUCKET: "duallane",
    WORKSPACE_S3_REGION: "us-east-1",
    WORKSPACE_S3_CREDENTIALS_FILE: credentialsPath,
    WORKSPACE_S3_SIGNED_URL_TTL_SECONDS: "300"
  };
}
