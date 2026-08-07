import { Readable } from "node:stream";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createWorkspaceS3MigrationStore,
  runWorkspaceS3Migration
} from "./workspace-s3-migration.mjs";
import { resolveWorkspaceStoragePath } from "./workspace-storage.mjs";

describe("workspace S3 migration", () => {
  const directories = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("backfills active objects, archives historical bytes, verifies full hashes, and resumes idempotently", async () => {
    const directory = await makeDirectory();
    const credentialsPath = path.join(directory, "credentials.json");
    await writeFile(credentialsPath, JSON.stringify({ accessKey: "test-access", secretKey: "test-secret" }));
    const attachmentKey = "workspace/spc_default/att-1/report.txt";
    const failedKey = "workspace/spc_default/att-failed/old.bin";
    const avatarKey = "profile-avatars/usr_1/ver-1.webp";
    await writeStorageFile(directory, attachmentKey, "attachment bytes");
    await writeStorageFile(directory, failedKey, "historical bytes");
    await writeStorageFile(directory, avatarKey, "avatar bytes");
    const objects = new Map();
    const client = fakeS3Client(objects);
    const store = await createWorkspaceS3MigrationStore({
      env: s3Env(credentialsPath),
      client,
      uploadFactory: fakeUploadFactory(objects)
    });
    const db = fakeDb({
      attachments: [
        { id: "att-1", spaceId: "spc_default", storageKey: attachmentKey, mimeType: "text/plain", byteSize: 16, status: "available" },
        { id: "att-failed", spaceId: "spc_default", storageKey: failedKey, mimeType: "application/octet-stream", byteSize: 16, status: "failed" }
      ],
      avatars: [{ userId: "usr_1", storageKey: avatarKey, version: "ver-1" }]
    });

    await store.assertReady();
    const first = await runWorkspaceS3Migration({ db, dataDir: directory, store, runId: "run-20260807" });
    expect(first).toMatchObject({
      status: "completed",
      counts: { total: 3, uploaded: 3, verified: 3, attachments: 1, avatars: 1, archives: 1 }
    });
    expect([...objects.keys()]).toEqual(expect.arrayContaining([
      "workspace/attachments/spc_default/att-1/content",
      "workspace/profile-avatars/usr_1/ver-1.webp"
    ]));
    const uploadMetadata = [...objects.values()].map((entry) => entry.metadata);
    expect(JSON.stringify(uploadMetadata)).not.toContain("report.txt");
    expect(JSON.stringify(uploadMetadata)).not.toContain("old.bin");

    const second = await runWorkspaceS3Migration({ db, dataDir: directory, store, runId: "run-20260807" });
    expect(second.counts).toMatchObject({ uploaded: 0, skipped: 3, verified: 3 });
    const reportPath = path.join(directory, "workspace-s3-migration-reports", "run-20260807.json");
    expect(JSON.parse(await readFile(reportPath, "utf8"))).toMatchObject({ status: "completed", runId: "run-20260807" });
    if (process.platform !== "win32") {
      expect((await stat(reportPath)).mode & 0o077).toBe(0);
    }
  });

  it("blocks the cutover when an active database object is absent locally and remotely", async () => {
    const directory = await makeDirectory();
    const credentialsPath = path.join(directory, "credentials.json");
    await writeFile(credentialsPath, JSON.stringify({ accessKey: "test-access", secretKey: "test-secret" }));
    const objects = new Map();
    const store = await createWorkspaceS3MigrationStore({
      env: s3Env(credentialsPath),
      client: fakeS3Client(objects),
      uploadFactory: fakeUploadFactory(objects)
    });
    const db = fakeDb({
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

    await expect(runWorkspaceS3Migration({ db, dataDir: directory, store, runId: "run-missing1" }))
      .rejects.toMatchObject({ code: "storage.missing", record: { kind: "attachment", id: "att-missing" } });
    const report = JSON.parse(await readFile(
      path.join(directory, "workspace-s3-migration-reports", "run-missing1.json"),
      "utf8"
    ));
    expect(report).toMatchObject({ status: "failed", failedRecord: { kind: "attachment", id: "att-missing" } });
  });

  async function makeDirectory() {
    const directory = await mkdtemp(path.join(tmpdir(), "duallane-s3-migration-"));
    directories.push(directory);
    return directory;
  }
});

function fakeDb({ attachments, avatars }) {
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
      if (!object) {
        const error = new Error("missing");
        error.name = "NoSuchKey";
        error.$metadata = { httpStatusCode: 404 };
        throw error;
      }
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

async function writeStorageFile(dataDir, storageKey, content) {
  const targetPath = resolveWorkspaceStoragePath(dataDir, storageKey);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content);
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
