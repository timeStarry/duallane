import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, rm, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureContentAddressedStream,
  readContentAddressedBytes,
  removeContentAddressedObject,
  resolveWorkspaceStoragePath,
  saveUploadStream,
  statStoredAttachment,
  workspaceContentObjectKey
} from "./workspace-storage.mjs";

describe("workspace storage service", () => {
  let dataDir;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "duallane-storage-test-"));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("writes upload streams inside the workspace storage root", async () => {
    const sourcePath = path.join(dataDir, "source.txt");
    await writeFile(sourcePath, "stored body");

    const stored = await saveUploadStream(
      dataDir,
      "workspace/spc_default/att-1/source.txt",
      createReadStream(sourcePath),
      Buffer.byteLength("stored body")
    );

    expect(stored.byteSize).toBe(Buffer.byteLength("stored body"));
    await expect(readFile(stored.path, "utf8")).resolves.toBe("stored body");
    await expect(statStoredAttachment(dataDir, "workspace/spc_default/att-1/source.txt", stored.byteSize)).resolves.toEqual({
      path: stored.path,
      byteSize: stored.byteSize
    });
  });

  it("rejects path traversal and mismatched upload sizes", async () => {
    expect(() => resolveWorkspaceStoragePath(dataDir, "../escape.txt")).toThrow("文件存储路径无效");

    const sourcePath = path.join(dataDir, "source.txt");
    await writeFile(sourcePath, "too short");

    await expect(
      saveUploadStream(
        dataDir,
        "workspace/spc_default/att-2/source.txt",
        createReadStream(sourcePath),
        Buffer.byteLength("too short") + 1
      )
    ).rejects.toThrow("上传内容大小与预留不一致");

    const targetPath = resolveWorkspaceStoragePath(dataDir, "workspace/spc_default/att-2/source.txt");
    await expect(readFile(targetPath)).rejects.toThrow();
  });

  it("concurrently ensures one immutable SHA-256 object and deletes it idempotently", async () => {
    const content = Buffer.from("shared canonical bytes");
    const sha256 = createHash("sha256").update(content).digest("hex");
    const [first, second] = await Promise.all([
      ensureContentAddressedStream(dataDir, { sha256, byteSize: content.byteLength, stream: Readable.from(content) }),
      ensureContentAddressedStream(dataDir, { sha256, byteSize: content.byteLength, stream: Readable.from(content) })
    ]);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    expect(first.storageKey).toBe(`workspace/objects/sha256/${sha256.slice(0, 2)}/${sha256}`);
    const object = { sha256, byteSize: content.byteLength, objectKey: first.storageKey };
    await expect(readContentAddressedBytes(dataDir, object)).resolves.toEqual(content);
    expect(() => workspaceContentObjectKey("../escape")).toThrow("存储对象摘要无效");
    await expect(readContentAddressedBytes(dataDir, {
      ...object,
      objectKey: `workspace/objects/sha256/ff/${sha256}`
    })).rejects.toMatchObject({ code: "storage.object_invalid_key" });
    await removeContentAddressedObject(dataDir, object);
    await removeContentAddressedObject(dataDir, object);
    await expect(readContentAddressedBytes(dataDir, object)).rejects.toMatchObject({ code: "file.storage_missing" });
  });
});
