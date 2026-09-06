import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixturePrefix = "duallane-emotes-legacy-contract-";
const contractScript = path.join(root, "scripts/backend/workspace-emotes-legacy-contract.mjs");
const options = parseArguments(process.argv.slice(2));
if (options.runGo && !String(process.env.TEST_DATABASE_URL ?? "").trim()) {
  throw new Error("--go requires TEST_DATABASE_URL; Go parity is never skipped");
}
const requestedFixture = options.fixtureDir;
const temporaryFixture = !requestedFixture;
const fixtureDir = requestedFixture || await mkdtemp(path.join(await realpath(tmpdir()), fixturePrefix));
let output;
let operationError;
let cleanupError;
let cleanupSucceeded = !temporaryFixture;

try {
  const created = runContract(["--fixture-dir", fixtureDir]);
  assert.equal(created.status, "completed");
  if (options.runGo) runGoParity(fixtureDir);
  const checked = runContract(["--check", "--fixture-dir", fixtureDir]);
  assert.equal(checked.status, "completed");
  const manifestPath = path.join(fixtureDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.synthetic, true);
  assert.equal(manifest.source, "node.workspace.custom-emotes.legacy-read");
  output = {
    status: "completed",
    source: manifest.source,
    contractVersion: manifest.contractVersion,
    recordCount: manifest.records.length,
    caseCount: manifest.cases.length,
    go: {
      requested: options.runGo,
      status: options.runGo ? "passed" : "not-run",
      test: options.runGo ? "TestWorkspaceReadsActualNodeLegacyEmotes" : null
    },
    fixtureDir: temporaryFixture ? null : fixtureDir,
    manifestPath: temporaryFixture ? null : manifestPath,
    fixtureCleaned: false,
    manifest
  };
} catch (error) {
  operationError = error;
} finally {
  if (temporaryFixture) {
    try {
      await removeOwnedFixture(fixtureDir);
      cleanupSucceeded = true;
    } catch (error) {
      cleanupError = error;
    }
  }
}

if (operationError || cleanupError) {
  if (operationError) process.stderr.write(`${operationError?.stack || operationError}\n`);
  if (cleanupError) process.stderr.write(`fixture cleanup failed: ${cleanupError?.stack || cleanupError}\n`);
  process.exitCode = 1;
} else {
  output.fixtureCleaned = temporaryFixture && cleanupSucceeded;
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

function runContract(args) {
  const result = spawnSync(process.execPath, [contractScript, ...args], {
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
    throw new Error("Node custom-emote legacy parity stage failed");
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Node custom-emote legacy stage did not return JSON: ${error.message}`);
  }
}

function runGoParity(fixture) {
  const backendRoot = path.join(root, "apps/backend");
  const result = spawnSync(process.env.GO || "go", [
    "test",
    "-tags=postgres_integration",
    "-count=1",
    "-race",
    "./cmd/workspace",
    "-run",
    "TestWorkspaceReadsActualNodeLegacyEmotes"
  ], {
    cwd: backendRoot,
    env: {
      ...process.env,
      DUALLANE_NODE_EMOTES_LEGACY_FIXTURE: path.resolve(fixture)
    },
    encoding: "utf8",
    timeout: 180_000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    process.stderr.write(result.stderr ?? "");
    process.stderr.write(result.stdout ?? "");
    throw new Error("Go custom-emote legacy parity stage failed");
  }
}

function parseArguments(args) {
  let fixtureDir = "";
  let runGo = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--fixture-dir") {
      fixtureDir = String(args[++index] ?? "").trim();
      if (!fixtureDir) throw new Error("--fixture-dir requires a value");
      continue;
    }
    if (args[index] === "--go") {
      runGo = true;
      continue;
    }
    if (args[index] === "--help") {
      process.stdout.write("node scripts/backend/workspace-emotes-legacy-parity.mjs [--go] [--fixture-dir <synthetic-dir>]\n");
      process.exit(0);
    }
    throw new Error(`unknown option: ${args[index]}`);
  }
  if (fixtureDir && !path.basename(path.resolve(fixtureDir)).startsWith(fixturePrefix)) {
    throw new Error(`--fixture-dir must be a synthetic ${fixturePrefix}* directory`);
  }
  return { fixtureDir, runGo };
}

async function removeOwnedFixture(value) {
  const resolved = await realpath(value);
  const parent = await realpath(path.dirname(resolved));
  const tempRoot = await realpath(tmpdir());
  assert.equal(parent, tempRoot);
  assert.ok(path.basename(resolved).startsWith(fixturePrefix));
  await rm(resolved, { recursive: true, force: false });
}
