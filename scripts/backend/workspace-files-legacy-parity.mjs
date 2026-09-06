import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tempRoot = await realpath(tmpdir());
const fixture = await mkdtemp(path.join(tempRoot, "duallane-files-legacy-contract-"));
const contractScript = path.join(root, "scripts/backend/workspace-files-legacy-contract.mjs");

function run(command, args, cwd = root, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd, env: { ...process.env, ...extraEnv }, encoding: "utf8", timeout: 180_000,
    windowsHide: true, maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    // Outputs belong exclusively to the synthetic fixture/test processes.
    process.stderr.write(result.stderr ?? "");
    process.stderr.write(result.stdout ?? "");
    throw new Error("Node/Go legacy file parity stage failed");
  }
}

try {
  run(process.execPath, [contractScript, "--fixture-dir", fixture]);
  run(process.env.GO || "go", ["test", "-count=1", "-race", "./internal/workspace/files", "-run", "TestNodeLegacyFixtureRoundTrip"], path.join(root, "apps/backend"), { DUALLANE_NODE_FILES_LEGACY_FIXTURE: fixture });
  run(process.env.GO || "go", ["test", "-count=1", "-race", "./cmd/workspace", "-run", "TestWorkspaceFactoryReadsActualNodeLegacyFixture"], path.join(root, "apps/backend"), { DUALLANE_NODE_FILES_LEGACY_FIXTURE: fixture });
  run(process.execPath, [contractScript, "--check", "--fixture-dir", fixture]);
} finally {
  // Delete only the directory created by this invocation, never a caller's
  // path or a location inferred from a subprocess report.
  assert.equal(await realpath(fixture), fixture);
  assert.equal(path.dirname(fixture), tempRoot);
  assert.ok(path.basename(fixture).startsWith("duallane-files-legacy-contract-"));
  await rm(fixture, { recursive: true, force: false });
}
process.stdout.write("Node -> Go files + real Workspace factory -> Node: PASS (synthetic fixture cleaned)\n");
