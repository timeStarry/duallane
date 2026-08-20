import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createWorkspaceObjectStore,
  cleanupWorkspaceMultipartUploads,
  loadWorkspaceS3Config,
  workspaceArchiveObjectKey,
  workspaceAttachmentObjectKey,
  workspaceAvatarObjectKey,
  workspaceContentObjectKey,
  workspaceCustomEmoteObjectKey
} from "./workspace-object-store.mjs";
import { resolveWorkspaceStoragePath } from "./workspace-storage.mjs";

describe("workspace object store", () => {
  const directories = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("uses opaque, feature-scoped object keys", () => {
    expect(workspaceAttachmentObjectKey({ spaceId: "spc_default", id: "att-1" }))
      .toBe("workspace/attachments/spc_default/att-1/content");
    expect(workspaceAvatarObjectKey({ userId: "usr_1", version: "version-1" }))
      .toBe("workspace/profile-avatars/usr_1/version-1.webp");
    expect(workspaceCustomEmoteObjectKey({ userId: "usr_1", id: "emote-1" }))
      .toBe("workspace/custom-emotes/usr_1/emote-1/content.webp");
    expect(workspaceArchiveObjectKey({ runId: "run-1", sha256: "a".repeat(64) }))
      .toBe(`workspace/migration-archive/run-1/${"a".repeat(64)}`);
    expect(() => workspaceAttachmentObjectKey({ spaceId: "../escape", id: "att-1" })).toThrow("invalid");
  });

  it("loads MinIO credentials from a private file without echoing their values in failures", async () => {
    const directory = await makeDirectory();
    const credentialsPath = path.join(directory, "credentials.json");
    await writeFile(credentialsPath, JSON.stringify({ accessKey: "access-secret", secretKey: "secret-secret" }));
    const config = await loadWorkspaceS3Config(s3Env(credentialsPath));
    expect(config).toMatchObject({
      endpoint: "http://100.99.0.4:9000",
      publicEndpoint: "https://fs.tsio.top",
      bucket: "duallane",
      ttlSeconds: 300
    });

    await writeFile(credentialsPath, "not-json");
    await expect(loadWorkspaceS3Config(s3Env(credentialsPath))).rejects.toThrow("WORKSPACE_S3_CREDENTIALS_FILE cannot be read");
  });

  it("concurrently ensures, reads, and deletes canonical S3 objects by the stored object key", async () => {
    const directory = await makeDirectory();
    const credentialsPath = path.join(directory, "credentials.json");
    await writeFile(credentialsPath, JSON.stringify({ accessKey: "test-access", secretKey: "test-secret" }));
    const objects = new Map();
    const observedKeys = [];
    const client = {
      async send(command) {
        const name = command.constructor.name;
        const key = command.input.Key;
        if (key) observedKeys.push(key);
        if (name === "HeadObjectCommand") {
          const object = objects.get(key);
          if (!object) throw missingS3Object();
          return { ContentLength: object.body.byteLength, Metadata: object.metadata };
        }
        if (name === "GetObjectCommand") {
          const object = objects.get(key);
          if (!object) throw missingS3Object();
          return { Body: Readable.from(object.body) };
        }
        if (name === "DeleteObjectCommand") {
          objects.delete(key);
          return {};
        }
        return {};
      },
      destroy() {}
    };
    const store = await createWorkspaceObjectStore({
      dataDir: directory,
      env: s3Env(credentialsPath),
      s3Client: client,
      publicS3Client: client,
      presign: async (_client, command) => `https://fs.tsio.top/duallane/${command.input.Key}`,
      uploadFactory: ({ params }) => ({
        async done() {
          const chunks = [];
          for await (const chunk of params.Body) chunks.push(Buffer.from(chunk));
          objects.set(params.Key, { body: Buffer.concat(chunks), metadata: params.Metadata });
        }
      })
    });
    const content = Buffer.from("canonical minio bytes");
    const sha256 = createHash("sha256").update(content).digest("hex");
    await Promise.all([
      store.ensureObject({ sha256, byteSize: content.byteLength, stream: Readable.from(content) }),
      store.ensureObject({ sha256, byteSize: content.byteLength, stream: Readable.from(content) })
    ]);
    expect([...objects.keys()]).toEqual([workspaceContentObjectKey(sha256)]);
    await expect(store.ensureObject({ sha256, byteSize: content.byteLength })).resolves.toMatchObject({ created: false });
    const row = { sha256, byteSize: content.byteLength, objectKey: workspaceContentObjectKey(sha256) };
    await expect(store.readObject(row)).resolves.toEqual(content);
    expect(observedKeys.at(-2)).toBe(row.objectKey);
    await expect(store.readObject({ ...row, objectKey: `workspace/objects/sha256/ff/${sha256}` }))
      .rejects.toMatchObject({ code: "storage.object_invalid_key" });
    const legacyAttachment = {
      id: "att-dual-read",
      spaceId: "spc_default",
      storageKey: "workspace/spc_default/att-dual-read/legacy.bin",
      mimeType: "application/octet-stream",
      byteSize: content.byteLength,
      storageObject: row
    };
    const legacyKey = workspaceAttachmentObjectKey(legacyAttachment);
    objects.set(legacyKey, { body: Buffer.from("legacy attachment data"), metadata: {} });
    await expect(store.getAttachmentDelivery(legacyAttachment)).resolves.toMatchObject({
      kind: "redirect",
      url: `https://fs.tsio.top/duallane/${row.objectKey}`
    });
    await store.deleteObject(row);
    legacyAttachment.byteSize = Buffer.byteLength("legacy attachment data");
    await expect(store.getAttachmentDelivery(legacyAttachment)).resolves.toMatchObject({
      kind: "redirect",
      url: `https://fs.tsio.top/duallane/${legacyKey}`
    });
    await store.deleteObject(row);
    expect([...objects.keys()]).toEqual([legacyKey]);
  });

  it("prefers canonical local bytes and falls back to the retained legacy path only when missing", async () => {
    const directory = await makeDirectory();
    const store = await createWorkspaceObjectStore({ dataDir: directory, env: { WORKSPACE_STORAGE_DRIVER: "local" } });
    const canonical = Buffer.from("canonical bytes");
    const legacy = Buffer.from("legacy bytes");
    const sha256 = createHash("sha256").update(canonical).digest("hex");
    const ensured = await store.ensureObject({
      sha256,
      byteSize: canonical.byteLength,
      stream: Readable.from(canonical)
    });
    const legacyKey = "workspace/spc_default/att-local-dual/legacy.bin";
    const avatarLegacyKey = "profile-avatars/usr-local-dual/legacy.webp";
    const emoteLegacyKey = "custom-emotes/usr-local-dual/emote-local-dual/content.webp";
    const legacyPath = resolveWorkspaceStoragePath(directory, legacyKey);
    await Promise.all([legacyKey, avatarLegacyKey, emoteLegacyKey].map(async (storageKey) => {
      const target = resolveWorkspaceStoragePath(directory, storageKey);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, legacy);
    }));
    const attachment = {
      id: "att-local-dual",
      storageKey: legacyKey,
      byteSize: legacy.byteLength,
      storageObject: { ...ensured, byteSize: canonical.byteLength }
    };
    const canonicalDelivery = await store.getAttachmentDelivery(attachment);
    await expect(readFile(canonicalDelivery.path)).resolves.toEqual(canonical);
    const avatar = {
      storageKey: avatarLegacyKey,
      storageObject: attachment.storageObject
    };
    const emote = {
      storageKey: emoteLegacyKey,
      byteSize: legacy.byteLength,
      storageObject: attachment.storageObject
    };
    await expect(store.getProfileAvatarDelivery(avatar)).resolves.toMatchObject({ path: canonicalDelivery.path });
    await expect(store.readCustomEmoteBytes(emote, 100)).resolves.toEqual(canonical);
    await store.deleteObject(attachment.storageObject);
    const fallbackDelivery = await store.getAttachmentDelivery(attachment);
    expect(fallbackDelivery.path).toBe(legacyPath);
    await expect(readFile(fallbackDelivery.path)).resolves.toEqual(legacy);
    await expect(store.getProfileAvatarDelivery(avatar)).resolves.toMatchObject({
      path: resolveWorkspaceStoragePath(directory, avatarLegacyKey)
    });
    await expect(store.readCustomEmoteBytes(emote, 100)).resolves.toEqual(legacy);
  });

  it("uploads verified attachments to S3 and returns a short public signed URL", async () => {
    const directory = await makeDirectory();
    const credentialsPath = path.join(directory, "credentials.json");
    await writeFile(credentialsPath, JSON.stringify({ accessKey: "test-access", secretKey: "test-secret" }));
    const observed = { uploads: [], commands: [] };
    const client = {
      async send(command) {
        observed.commands.push(command.constructor.name);
        if (command.constructor.name === "HeadObjectCommand") {
          const upload = observed.uploads.at(-1);
          return {
            ContentLength: upload.byteSize,
            Metadata: { "duallane-sha256": upload.metadata["duallane-sha256"] }
          };
        }
        return {};
      },
      destroy() {}
    };
    const store = await createWorkspaceObjectStore({
      dataDir: directory,
      env: s3Env(credentialsPath),
      s3Client: client,
      publicS3Client: client,
      presign: async (_client, command, options) => {
        expect(command.input.Key).toBe("workspace/attachments/spc_default/att-1/content");
        expect(options.expiresIn).toBe(300);
        return "https://fs.tsio.top/duallane/workspace/attachments/spc_default/att-1/content?signed=redacted";
      },
      uploadFactory: ({ params }) => ({
        async done() {
          const chunks = [];
          for await (const chunk of params.Body) chunks.push(Buffer.from(chunk));
          observed.uploads.push({
            key: params.Key,
            byteSize: Buffer.concat(chunks).byteLength,
            metadata: params.Metadata
          });
        }
      })
    });
    const content = Buffer.from("stored in minio");
    const attachment = {
      id: "att-1",
      spaceId: "spc_default",
      storageKey: "workspace/spc_default/att-1/private-name.txt",
      mimeType: "text/plain",
      byteSize: content.byteLength
    };

    await store.assertReady();
    await store.saveAttachment({ attachment, stream: Readable.from(content) });
    expect(observed.uploads[0].key).toBe("workspace/attachments/spc_default/att-1/content");
    expect(observed.uploads[0].metadata["duallane-size"]).toBe(String(content.byteLength));
    expect(JSON.stringify(observed.uploads[0])).not.toContain("private-name.txt");
    await expect(stat(resolveWorkspaceStoragePath(directory, attachment.storageKey))).rejects.toMatchObject({ code: "ENOENT" });

    const delivery = await store.getAttachmentDelivery(attachment, {
      contentType: "text/plain",
      contentDisposition: "attachment; filename=private-name.txt"
    });
    expect(delivery).toMatchObject({ kind: "redirect", expiresAt: expect.any(String) });
    expect(delivery.url).toMatch(/^https:\/\/fs\.tsio\.top\//);
  });

  it("stores personal emotes in their private S3 prefix and serves authenticated bytes", async () => {
    const directory = await makeDirectory();
    const credentialsPath = path.join(directory, "credentials.json");
    await writeFile(credentialsPath, JSON.stringify({ accessKey: "test-access", secretKey: "test-secret" }));
    let uploaded;
    const client = {
      async send(command) {
        if (command.constructor.name === "HeadObjectCommand") {
          return { ContentLength: uploaded.byteSize, Metadata: uploaded.metadata };
        }
        if (command.constructor.name === "GetObjectCommand") {
          return { Body: { transformToByteArray: async () => new Uint8Array(content) } };
        }
        return {};
      },
      destroy() {}
    };
    const store = await createWorkspaceObjectStore({
      dataDir: directory,
      env: s3Env(credentialsPath),
      s3Client: client,
      publicS3Client: client,
      presign: async (_client, command, options) => {
        expect(command.input.Key).toBe("workspace/custom-emotes/usr_1/emote-1/content.webp");
        expect(options.expiresIn).toBe(300);
        return "https://fs.tsio.top/duallane/workspace/custom-emotes/usr_1/emote-1/content.webp?signed=redacted";
      },
      uploadFactory: ({ params }) => ({
        async done() {
          const chunks = [];
          for await (const chunk of params.Body) chunks.push(Buffer.from(chunk));
          uploaded = {
            key: params.Key,
            byteSize: Buffer.concat(chunks).byteLength,
            metadata: params.Metadata
          };
        }
      })
    });
    const content = Buffer.from("normalized-webp");
    const stagingPath = path.join(directory, "staged-emote.webp");
    await writeFile(stagingPath, content);
    const emote = {
      id: "emote-1",
      userId: "usr_1",
      path: stagingPath,
      storageKey: "custom-emotes/usr_1/emote-1/content.webp",
      byteSize: content.byteLength,
      sha256: "a".repeat(64)
    };

    await store.persistCustomEmote(emote);
    expect(uploaded).toMatchObject({
      key: "workspace/custom-emotes/usr_1/emote-1/content.webp",
      byteSize: content.byteLength,
      metadata: expect.objectContaining({
        "duallane-kind": "custom-emote",
        "duallane-id": "emote-1"
      })
    });
    await expect(store.getCustomEmoteDelivery(emote)).resolves.toMatchObject({
      kind: "buffer",
      buffer: content,
      byteSize: content.byteLength
    });
  });

  it("falls back to local bytes only when S3 reports a missing object", async () => {
    const directory = await makeDirectory();
    const credentialsPath = path.join(directory, "credentials.json");
    await writeFile(credentialsPath, JSON.stringify({ accessKey: "test-access", secretKey: "test-secret" }));
    const attachment = {
      id: "att-2",
      spaceId: "spc_default",
      storageKey: "workspace/spc_default/att-2/file.txt",
      mimeType: "text/plain",
      byteSize: 5
    };
    const localPath = resolveWorkspaceStoragePath(directory, attachment.storageKey);
    await mkdir(path.dirname(localPath), { recursive: true });
    await writeFile(localPath, "local");
    const missingClient = {
      async send(command) {
        if (command.constructor.name === "HeadObjectCommand") {
          const error = new Error("missing");
          error.name = "NoSuchKey";
          error.$metadata = { httpStatusCode: 404 };
          throw error;
        }
        return {};
      },
      destroy() {}
    };
    const store = await createWorkspaceObjectStore({
      dataDir: directory,
      env: { ...s3Env(credentialsPath), WORKSPACE_STORAGE_LOCAL_READ_FALLBACK: "true" },
      s3Client: missingClient,
      publicS3Client: missingClient
    });
    await expect(store.getAttachmentDelivery(attachment)).resolves.toMatchObject({
      kind: "stream",
      path: localPath,
      byteSize: 5
    });

    const unavailableClient = {
      async send() {
        throw new Error("socket failed with secret-secret");
      },
      destroy() {}
    };
    const unavailableStore = await createWorkspaceObjectStore({
      dataDir: directory,
      env: { ...s3Env(credentialsPath), WORKSPACE_STORAGE_LOCAL_READ_FALLBACK: "true" },
      s3Client: unavailableClient,
      publicS3Client: unavailableClient
    });
    await expect(unavailableStore.getAttachmentDelivery(attachment)).rejects.toMatchObject({
      code: "file.storage_unavailable",
      statusCode: 503
    });
    await expect(unavailableStore.getAttachmentDelivery(attachment)).rejects.not.toThrow("secret-secret");
    expect(unavailableStore.config).toBeUndefined();
  });

  it("retains a verified local mirror when migration mirror writes are enabled", async () => {
    const directory = await makeDirectory();
    const credentialsPath = path.join(directory, "credentials.json");
    await writeFile(credentialsPath, JSON.stringify({ accessKey: "test-access", secretKey: "test-secret" }));
    let uploaded;
    const client = {
      async send(command) {
        if (command.constructor.name === "HeadObjectCommand") {
          return {
            ContentLength: uploaded.byteSize,
            Metadata: uploaded.metadata
          };
        }
        return {};
      },
      destroy() {}
    };
    const store = await createWorkspaceObjectStore({
      dataDir: directory,
      env: { ...s3Env(credentialsPath), WORKSPACE_STORAGE_LOCAL_MIRROR_WRITE: "true" },
      s3Client: client,
      publicS3Client: client,
      uploadFactory: ({ params }) => ({
        async done() {
          const chunks = [];
          for await (const chunk of params.Body) chunks.push(Buffer.from(chunk));
          uploaded = { byteSize: Buffer.concat(chunks).byteLength, metadata: params.Metadata };
        }
      })
    });
    const content = Buffer.from("mirrored");
    const attachment = {
      id: "att-mirror",
      spaceId: "spc_default",
      storageKey: "workspace/spc_default/att-mirror/file.bin",
      mimeType: "application/octet-stream",
      byteSize: content.byteLength
    };
    await store.saveAttachment({ attachment, stream: Readable.from(content) });
    await expect(readFile(resolveWorkspaceStoragePath(directory, attachment.storageKey))).resolves.toEqual(content);
  });

  it("maps missing local avatars to a stable not-found response", async () => {
    const directory = await makeDirectory();
    const store = await createWorkspaceObjectStore({ dataDir: directory, env: { WORKSPACE_STORAGE_DRIVER: "local" } });
    await expect(store.getProfileAvatarDelivery({
      storageKey: "profile-avatars/usr_1/missing.webp"
    })).rejects.toMatchObject({ code: "avatar.not_found", statusCode: 404 });
  });

  it("aborts only workspace multipart uploads older than seven days", async () => {
    const aborted = [];
    const client = {
      async send(command) {
        if (command.constructor.name === "ListMultipartUploadsCommand") {
          return {
            IsTruncated: false,
            Uploads: [
              { Key: "workspace/attachments/spc_default/old/content", UploadId: "old", Initiated: new Date("2026-07-01T00:00:00Z") },
              { Key: "workspace/attachments/spc_default/new/content", UploadId: "new", Initiated: new Date("2026-08-06T00:00:00Z") },
              { Key: "outside/old", UploadId: "outside", Initiated: new Date("2026-07-01T00:00:00Z") }
            ]
          };
        }
        if (command.constructor.name === "AbortMultipartUploadCommand") {
          aborted.push(command.input);
          return {};
        }
        throw new Error(`unexpected command ${command.constructor.name}`);
      }
    };
    await expect(cleanupWorkspaceMultipartUploads({
      client,
      bucket: "duallane",
      now: new Date("2026-08-07T00:00:00Z")
    })).resolves.toEqual({ aborted: 1 });
    expect(aborted).toEqual([expect.objectContaining({ Key: "workspace/attachments/spc_default/old/content", UploadId: "old" })]);
  });

  it("rejects endpoint path prefixes so signed object paths remain unambiguous", async () => {
    const directory = await makeDirectory();
    const credentialsPath = path.join(directory, "credentials.json");
    await writeFile(credentialsPath, JSON.stringify({ accessKey: "test-access", secretKey: "test-secret" }));
    await expect(loadWorkspaceS3Config({
      ...s3Env(credentialsPath),
      WORKSPACE_S3_PUBLIC_ENDPOINT: "https://fs.tsio.top/minio"
    })).rejects.toThrow("WORKSPACE_S3_PUBLIC_ENDPOINT is invalid");
  });

  async function makeDirectory() {
    const directory = await mkdtemp(path.join(tmpdir(), "duallane-object-store-"));
    directories.push(directory);
    return directory;
  }
});

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

function missingS3Object() {
  const error = new Error("missing");
  error.name = "NoSuchKey";
  error.$metadata = { httpStatusCode: 404 };
  return error;
}
