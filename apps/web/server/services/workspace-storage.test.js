import { createReadStream } from "node:fs";
import { readFile, rm, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveWorkspaceStoragePath,
  saveUploadStream,
  statStoredAttachment
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
});
