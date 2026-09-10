import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  normalizeWorkspaceObjectSha256,
  resolveWorkspaceContentObjectKey,
  resolveWorkspaceStoragePath,
  workspaceContentObjectKey,
  workspaceStorageRoot
} from "../lib/storage-paths.mjs";

const directories = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("canonical object keys are digest-only and stable", () => {
  const digest = "A".repeat(64);
  const normalized = normalizeWorkspaceObjectSha256(digest);
  assert.equal(normalized, digest.toLowerCase());
  assert.equal(
    workspaceContentObjectKey(digest),
    `workspace/objects/sha256/aa/${"a".repeat(64)}`
  );
  assert.equal(
    resolveWorkspaceContentObjectKey({ sha256: digest, objectKey: workspaceContentObjectKey(digest) }),
    workspaceContentObjectKey(digest)
  );
  assert.throws(
    () => resolveWorkspaceContentObjectKey({ sha256: digest, objectKey: "workspace/other/key" }),
    (error) => error.code === "storage.object_invalid_key"
  );
});

test("legacy storage paths reject traversal and null-byte input", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "duallane-node-compat-paths-"));
  directories.push(dataDir);
  const root = workspaceStorageRoot(dataDir);
  assert.equal(resolveWorkspaceStoragePath(dataDir, "workspace/objects/file.bin").startsWith(`${root}${path.sep}`), true);
  assert.throws(
    () => resolveWorkspaceStoragePath(dataDir, "../outside"),
    (error) => error.code === "file.invalid_storage_key"
  );
  assert.throws(
    () => resolveWorkspaceStoragePath(dataDir, "workspace/\0secret"),
    (error) => error.code === "file.invalid_storage_key"
  );
});
