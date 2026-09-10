import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { spawnOwnedProcess, stopOwnedProcess, waitForExit } from "../../e2e/support/owned-process.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const backendRoot = path.join(root, "apps/backend");
const testdataRoot = path.join(root, "scripts/backend/testdata");
const sourceCommit = "8d346a04317d0d3396293caca14ca1c65c7b5163";
const materializedClone = "/home/timestarry/.local/share/duallane-validation/chat-0170-after-bridge-mN5ND8";
const materializedCloneHead = "6ebc0f6858d67cf2be516d19ecf062c3ae75b505";
const loopbackDatabaseHosts = new Set(["127.0.0.1", "[::1]"]);
const goTestTimeoutMs = 180_000;
const stopGraceMs = 5_000;
const maxOutputTailChars = 64 * 1024;
const ambientDatabaseRoutingVariables = Object.freeze([
  "DATABASE_URL",
  "PGHOST",
  "PGHOSTADDR",
  "PGPORT",
  "PGDATABASE",
  "PGUSER",
  "PGPASSWORD",
  "PGSERVICE",
  "PGSERVICEFILE",
  "PGPASSFILE",
  "PGOPTIONS"
]);

const targets = Object.freeze({
  files: Object.freeze({
    artifact: "frozen-legacy-files.json",
    kind: "frozen-node-legacy-files",
    source: "node.workspace.files.legacy-read",
    fixturePrefix: "duallane-files-legacy-contract-",
    fixtureEnv: "DUALLANE_NODE_FILES_LEGACY_FIXTURE",
    tests: [
      ["Go files legacy round trip", ["test", "-count=1", "-race", "./internal/workspace/files", "-run", "TestNodeLegacyFixtureRoundTrip"]],
      ["Go Workspace factory file layout", ["test", "-count=1", "-race", "./cmd/workspace", "-run", "TestWorkspaceFactoryReadsActualNodeLegacyFixture"]]
    ]
  }),
  emotes: Object.freeze({
    artifact: "frozen-legacy-emotes.json",
    kind: "frozen-node-legacy-emotes",
    source: "node.workspace.custom-emotes.legacy-read",
    fixturePrefix: "duallane-emotes-legacy-contract-",
    fixtureEnv: "DUALLANE_NODE_EMOTES_LEGACY_FIXTURE",
    tests: [
      ["Go Workspace emote legacy integration", ["test", "-tags=postgres_integration", "-count=1", "-race", "./cmd/workspace", "-run", "TestWorkspaceReadsActualNodeLegacyEmotes"]]
    ]
  })
});

const expectedProvenance = Object.freeze({
  files: Object.freeze({
    sourceGitBlob: "6ddaf95fa213a9636beb15db5c0942ee4ca458a5",
    sourceSha256: "efed9f2a31fcbdb4a8c9ad133eaecb02db93f72aefaae59de4cbe8fbdf841df4"
  }),
  emotes: Object.freeze({
    sourceGitBlob: "263b1e08e720280ebebf7122eb4afacbf8f155e6",
    sourceSha256: "538b260e81c586a030f96c62fb9e3c89339e6be68cdf422a627f98802ab4b236"
  })
});

const activeChildren = new Set();
let interrupted = false;

if (isMainModule()) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}

export {
  assertLocalTestDatabase,
  childEnvironment,
  loadArtifact,
  materializeFixture,
  parseArguments,
  removeOwnedFixture,
  runTarget,
  validateArtifact
};

async function main(args) {
  const options = parseArguments(args);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (options.targets.includes("emotes")) assertLocalTestDatabase();

  const removeSignalHandlers = installSignalHandlers();
  let operationError;
  let results;
  try {
    results = [];
    for (const target of options.targets) {
      if (interrupted) throw new Error("frozen legacy harness interrupted before the next target");
      results.push(await runTarget(target));
    }
    if (interrupted) throw new Error("frozen legacy harness interrupted");
  } catch (error) {
    operationError = error;
  }
  let finalCleanupError;
  try {
    finalCleanupError = await stopOwnedChildren();
  } catch (error) {
    finalCleanupError = error;
  }
  removeSignalHandlers();
  if (operationError && finalCleanupError) {
    throw new AggregateError([operationError, finalCleanupError], "frozen legacy harness and child cleanup failed");
  }
  if (operationError) throw operationError;
  if (finalCleanupError) throw finalCleanupError;
  process.stdout.write(`${JSON.stringify({ status: "passed", results }, null, 2)}\n`);
}

function parseArguments(args) {
  const selected = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help") return { help: true, targets: [] };
    if (argument === "--files") {
      selected.add("files");
      continue;
    }
    if (argument === "--emotes") {
      selected.add("emotes");
      continue;
    }
    if (argument === "--all") {
      selected.add("files");
      selected.add("emotes");
      continue;
    }
    throw new Error(`unknown option: ${argument}`);
  }
  return { help: false, targets: selected.size === 0 ? ["files"] : ["files", "emotes"].filter((target) => selected.has(target)) };
}

function usage() {
  return [
    "Usage: node scripts/backend/frozen-legacy-contract.test.mjs [--files|--emotes|--all]",
    "",
    "  --files   materialize frozen Node file bytes and run the two non-PostgreSQL Go legacy assertions (default)",
    "  --emotes  materialize frozen Node emote bytes and run the opt-in PostgreSQL Go legacy assertion",
    "  --all     run both targets; --emotes requires an explicit loopback TEST_DATABASE_URL",
    "",
    "The harness writes only owned temporary directories using the existing Go-test prefixes and removes them on completion or interruption.",
    "It never creates or migrates a database. Use a disposable local TEST_DATABASE_URL only for --emotes."
  ].join("\n");
}

async function runTarget(name) {
  const spec = targets[name];
  assert.ok(spec, `unknown frozen legacy target ${name}`);
  if (name === "emotes") assertLocalTestDatabase();
  if (interrupted) throw new Error(`frozen legacy harness interrupted before ${name}`);
  const artifact = await loadArtifact(name);
  validateArtifact(name, artifact);

  const tempRoot = await realpath(tmpdir());
  const fixtureDir = await mkdtemp(path.join(tempRoot, spec.fixturePrefix));
  let operationError;
  let cleanupError;
  let completedTests = 0;
  try {
    await materializeFixture(name, artifact, fixtureDir);
    for (const [label, args] of spec.tests) {
      if (interrupted) throw new Error(`frozen legacy harness interrupted before ${label}`);
      await runGoTest(label, args, { [spec.fixtureEnv]: fixtureDir });
      completedTests += 1;
    }
  } catch (error) {
    operationError = error;
  }
  let childCleanupError;
  try {
    childCleanupError = await stopOwnedChildren();
  } catch (error) {
    childCleanupError = error;
  }
  try {
    if (childCleanupError || activeChildren.size !== 0) {
      throw childCleanupError || new Error(`${name} fixture retained because an owned Go child is still active`);
    }
    await removeOwnedFixture(fixtureDir, tempRoot, spec.fixturePrefix);
  } catch (error) {
    cleanupError = childCleanupError || error;
  }
  if (operationError && cleanupError) {
    throw new AggregateError([operationError, cleanupError], `${name} legacy fixture failed and cleanup failed`);
  }
  if (operationError) throw operationError;
  if (cleanupError) throw cleanupError;
  return {
    target: name,
    status: "passed",
    tests: completedTests,
    artifact: path.relative(root, artifact.path).replaceAll(path.sep, "/"),
    artifactSha256: artifact.sha256,
    contentCount: artifact.value.content.length,
    fixturePrefix: spec.fixturePrefix,
    fixtureCleaned: true
  };
}

async function loadArtifact(name) {
  const spec = targets[name];
  const artifactPath = path.join(testdataRoot, spec.artifact);
  const raw = await readFile(artifactPath);
  let value;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    throw new Error(`invalid frozen ${name} artifact JSON: ${error.message}`);
  }
  return { path: artifactPath, value, sha256: sha256(raw) };
}

function validateArtifact(name, artifact) {
  const spec = targets[name];
  const expectedSource = expectedProvenance[name];
  const value = artifact.value;
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.kind, spec.kind);
  assert.equal(value.synthetic, true);
  assert.deepEqual(value.provenance?.sourceCommit, sourceCommit);
  assert.deepEqual(value.provenance?.materializedClone, materializedClone);
  assert.deepEqual(value.provenance?.materializedCloneHead, materializedCloneHead);
  assert.equal(value.provenance?.verifiedBlobEquality, true);
  assert.equal(value.provenance?.sourceGitBlob, expectedSource.sourceGitBlob);
  assert.equal(value.provenance?.sourceSha256, expectedSource.sourceSha256);
  assert.equal(value.provenance?.sourcePath, `scripts/backend/${name === "files" ? "workspace-files" : "workspace-emotes"}-legacy-contract.mjs`);
  assert.ok(Array.isArray(value.provenance?.excluded));
  assert.deepEqual(value.manifest?.contractVersion, 1);
  assert.equal(value.manifest.source, spec.source);
  assert.ok(Array.isArray(value.content) && value.content.length > 0);

  const serializedManifest = JSON.stringify(value.manifest);
  for (const forbidden of ["contentBytes", "rawContent", "password", "secretKey", "credentials"]) {
    assert.equal(serializedManifest.includes(forbidden), false, `frozen manifest contains forbidden field ${forbidden}`);
  }
  if (name === "files") {
    assert.equal(value.manifest.owner, "node");
    assert.equal(value.manifest.attachment.storageObjectId, null);
    assert.equal(value.manifest.attachment.status, "available");
  } else {
    assert.equal(value.manifest.synthetic, true);
    assert.equal(value.manifest.records.length, 7);
    assert.equal(value.manifest.cases.length, 5);
  }

  const expectedPaths = expectedContentPaths(name, value.manifest);
  const observedPaths = new Set();
  for (const entry of value.content) {
    assert.equal(typeof entry.path, "string");
    assert.equal(entry.path.startsWith("workspace-files/"), true);
    assert.equal(entry.path.includes("\\"), false);
    assert.equal(path.posix.normalize(entry.path), entry.path);
    assert.equal(entry.path.split("/").includes(".."), false);
    assert.equal(observedPaths.has(entry.path), false, `duplicate frozen content path ${entry.path}`);
    observedPaths.add(entry.path);
    assert.ok(Number.isSafeInteger(entry.byteSize) && entry.byteSize > 0);
    assert.match(entry.sha256 ?? "", /^[a-f0-9]{64}$/);
    assert.match(entry.base64 ?? "", /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
    const bytes = Buffer.from(entry.base64, "base64");
    assert.equal(bytes.byteLength, entry.byteSize);
    assert.equal(bytes.toString("base64"), entry.base64);
    assert.equal(sha256(bytes), entry.sha256);
  }
  assert.deepEqual([...observedPaths].sort(), [...expectedPaths].sort());
  return value;
}

function expectedContentPaths(name, manifest) {
  if (name === "files") {
    return [`workspace-files/${manifest.attachment.legacyStorageKey}`];
  }
  return manifest.records
    .map((record) => record.storageKey)
    .filter((storageKey) => isSafeStorageKey(storageKey))
    .map((storageKey) => `workspace-files/${storageKey}`);
}

function isSafeStorageKey(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || value.startsWith("/")) return false;
  const segments = value.split("/");
  return !segments.includes("..") && path.posix.normalize(value) === value;
}

async function materializeFixture(name, artifact, fixtureDir) {
  const spec = targets[name];
  validateArtifact(name, artifact);
  await writeFile(path.join(fixtureDir, "manifest.json"), `${JSON.stringify(artifact.value.manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });
  for (const entry of artifact.value.content) {
    const destination = safeFixturePath(fixtureDir, entry.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, Buffer.from(entry.base64, "base64"), { mode: 0o600, flag: "wx" });
  }
  assert.equal(path.basename(fixtureDir).startsWith(spec.fixturePrefix), true);
}

function safeFixturePath(fixtureDir, relativePath) {
  const resolvedRoot = path.resolve(fixtureDir);
  const resolved = path.resolve(fixtureDir, ...relativePath.split("/"));
  const rootPrefix = `${resolvedRoot}${path.sep}`;
  assert.equal(resolved.startsWith(rootPrefix), true, "frozen content path escaped its owned fixture");
  return resolved;
}

function assertLocalTestDatabase(environment = process.env) {
  const raw = String(environment.TEST_DATABASE_URL ?? "").trim();
  if (!raw) throw new Error("--emotes requires an explicit TEST_DATABASE_URL for a disposable local database");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("--emotes requires a valid local TEST_DATABASE_URL");
  }
  if (!(["postgres:", "postgresql:"].includes(parsed.protocol) && loopbackDatabaseHosts.has(parsed.hostname))) {
    throw new Error("--emotes requires TEST_DATABASE_URL to target a loopback PostgreSQL host");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName || ["postgres", "template0", "template1"].includes(databaseName.toLowerCase())) {
    throw new Error("--emotes requires a named disposable PostgreSQL database");
  }
  if ([...parsed.searchParams.keys()].some((parameter) => parameter !== "sslmode") || parsed.hash !== "") {
    throw new Error("--emotes rejects TEST_DATABASE_URL runtime routing overrides");
  }
}

async function runGoTest(label, args, extraEnv) {
  if (interrupted) throw new Error(`frozen legacy harness interrupted before ${label}`);
  const command = String(process.env.GO ?? "go").trim() || "go";
  const state = {
    child: spawnOwnedProcess(command, args, {
      cwd: backendRoot,
      env: childEnvironment(extraEnv),
      stdio: ["ignore", "pipe", "pipe"]
    }),
    stopPromise: null,
    stopError: null,
    timedOut: false,
    spawnError: null,
    stdout: "",
    stderr: ""
  };
  activeChildren.add(state);
  state.child.stdout.setEncoding("utf8");
  state.child.stderr.setEncoding("utf8");
  state.child.stdout.on("data", (chunk) => { state.stdout = appendTail(state.stdout, chunk); });
  state.child.stderr.on("data", (chunk) => { state.stderr = appendTail(state.stderr, chunk); });
  state.child.once("error", (error) => { state.spawnError = error; });

  const exit = waitForExit(state.child);
  const timeout = setTimeout(() => {
    state.timedOut = true;
    void requestStop(state);
  }, goTestTimeoutMs);
  timeout.unref?.();
  let result;
  try {
    result = await exit;
  } finally {
    clearTimeout(timeout);
    await requestStop(state);
  }
  if (state.stopError) throw new Error(`${label} owned child cleanup failed`);
  activeChildren.delete(state);
  if (state.spawnError) throw new Error(`${label} could not start: ${state.spawnError.message}`);
  if (interrupted) throw new Error(`${label} interrupted`);
  if (state.timedOut) throw new Error(`${label} timed out after ${goTestTimeoutMs}ms`);
  if (result.code !== 0) {
    const signal = result.signal || `exit ${result.code}`;
    const diagnostic = [state.stdout.trim(), state.stderr.trim()].filter(Boolean).join("\n");
    const suffix = diagnostic ? `; output=${summarizeOutput(diagnostic)}` : "";
    throw new Error(`${label} failed (${signal})${suffix}`);
  }
  return { label, status: "passed" };
}

function childEnvironment(extraEnv) {
  const environment = { ...process.env, ...extraEnv };
  for (const variable of ambientDatabaseRoutingVariables) delete environment[variable];
  if (extraEnv.TEST_DATABASE_URL) environment.TEST_DATABASE_URL = extraEnv.TEST_DATABASE_URL;
  return environment;
}

function appendTail(current, chunk) {
  const combined = current + chunk;
  return combined.length > maxOutputTailChars ? combined.slice(-maxOutputTailChars) : combined;
}

function summarizeOutput(value) {
  const secrets = [
    process.env.TEST_DATABASE_URL,
    process.env.DATABASE_URL,
    process.env.PGPASSWORD,
    process.env.PGSERVICEFILE
  ].filter((secret) => typeof secret === "string" && secret.length > 0);
  let redacted = value;
  for (const secret of secrets) redacted = redacted.replaceAll(secret, "<redacted>");
  try {
    const databaseURL = new URL(String(process.env.TEST_DATABASE_URL ?? ""));
    for (const secret of [databaseURL.username, databaseURL.password].filter(Boolean)) {
      redacted = redacted.replaceAll(secret, "<redacted>");
    }
  } catch {
    // The explicit database guard reports malformed URLs before a child starts.
  }
  const lines = redacted.split(/\r?\n/).filter(Boolean);
  return lines.slice(-12).join("\\n").slice(0, 4000);
}

async function removeOwnedFixture(fixtureDir, tempRoot, prefix) {
  const resolved = await realpath(fixtureDir);
  const parent = await realpath(path.dirname(resolved));
  assert.equal(parent, tempRoot);
  assert.equal(path.basename(resolved).startsWith(prefix), true);
  await rm(resolved, { recursive: true, force: false });
}

function installSignalHandlers() {
  const handleSignal = () => {
    interrupted = true;
    for (const state of activeChildren) void requestStop(state);
  };
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);
  return () => {
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
  };
}

function requestStop(state) {
  if (state.stopPromise) return state.stopPromise;
  state.stopError = null;
  if (state.spawnError) {
    state.stopPromise = Promise.resolve().finally(() => {
      state.stopPromise = null;
      activeChildren.delete(state);
    });
    return state.stopPromise;
  }
  state.stopPromise = Promise.resolve()
    .then(() => stopOwnedProcess(state.child, stopGraceMs))
    .catch((error) => {
      state.stopError = error;
    })
    .finally(() => {
      state.stopPromise = null;
      if (state.spawnError || state.child.exitCode !== null || state.child.signalCode !== null) activeChildren.delete(state);
    });
  return state.stopPromise;
}

async function stopOwnedChildren() {
  const states = [...activeChildren];
  await Promise.all(states.map((state) => requestStop(state)));
  const errors = states.map((state) => state.stopError).filter(Boolean);
  if (errors.length > 0) {
    throw new AggregateError(errors, "owned Go child cleanup failed");
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}
