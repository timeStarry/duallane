import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const parityScript = path.join(root, "scripts/backend/workspace-emotes-legacy-parity.mjs");
const fixturePrefix = "duallane-emotes-legacy-contract-";

test("Node custom-emote legacy parity emits a safe Go-consumable manifest", async () => {
  const fixtureDir = await mkdtemp(path.join(await realpath(tmpdir()), fixturePrefix));
  try {
    const result = runParity(["--fixture-dir", fixtureDir]);
    assert.equal(result.status, "completed");
    assert.equal(result.fixtureCleaned, false);
    assert.equal(result.recordCount, 7);
    assert.equal(result.caseCount, 5);
    assert.deepEqual(result.go, { requested: false, status: "not-run", test: null });

    const manifest = JSON.parse(await readFile(path.join(fixtureDir, "manifest.json"), "utf8"));
    assert.deepEqual(result.manifest, manifest);
    assert.equal(manifest.contractVersion, 1);
    assert.equal(manifest.source, "node.workspace.custom-emotes.legacy-read");
    assert.equal(manifest.synthetic, true);
    assert.match(manifest.content.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(manifest.content.byteSize));
    assert.ok(manifest.records.some((record) => record.storageObjectId === null && record.storageKey));
    assert.ok(manifest.records.some((record) => record.storageObjectId?.startsWith("wso_") && record.canonicalObjectKey));
    assert.ok(manifest.records.some((record) => record.sourceCustomEmoteId && record.byteSize === null));

    const serialized = JSON.stringify(manifest);
    for (const forbidden of ["contentBytes", "rawContent", "password", "secretKey", "credentials"]) {
      assert.equal(serialized.includes(forbidden), false, `manifest contains ${forbidden}`);
    }
    assert.equal(serialized.includes("Node legacy"), false);
  } finally {
    await removeOwnedFixture(fixtureDir);
  }
});

test("Node custom-emote legacy parity cleans an internally owned fixture", () => {
  const result = runParity([]);
  assert.equal(result.status, "completed");
  assert.equal(result.fixtureDir, null);
  assert.equal(result.manifestPath, null);
  assert.equal(result.fixtureCleaned, true);
  assert.deepEqual(result.go, { requested: false, status: "not-run", test: null });
  assert.equal(result.manifest.synthetic, true);
});

test("Go custom-emote legacy parity is explicit and fail-closed without a test database", () => {
  const result = spawnSync(process.execPath, [parityScript, "--go"], {
    cwd: root,
    env: { ...process.env, TEST_DATABASE_URL: "" },
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
    maxBuffer: 1 * 1024 * 1024
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--go requires TEST_DATABASE_URL/);
  assert.equal(result.stdout, "");
});

function runParity(args) {
  const result = spawnSync(process.execPath, [parityScript, ...args], {
    cwd: root,
    env: { ...process.env },
    encoding: "utf8",
    timeout: 180_000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    process.stderr.write(result.stderr ?? "");
    process.stderr.write(result.stdout ?? "");
    throw new Error("Node custom-emote legacy parity test failed");
  }
  return JSON.parse(result.stdout);
}

async function removeOwnedFixture(value) {
  const resolved = await realpath(value);
  const parent = await realpath(path.dirname(resolved));
  const tempRoot = await realpath(tmpdir());
  assert.equal(parent, tempRoot);
  assert.ok(path.basename(resolved).startsWith(fixturePrefix));
  await rm(resolved, { recursive: true, force: false });
}
