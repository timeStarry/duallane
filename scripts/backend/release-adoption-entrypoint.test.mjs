import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const previousCommit = "a".repeat(40);
const linuxOnly = process.platform !== "linux";
const rootOnly = linuxOnly || process.getuid() !== 0;

async function withEntrypoint(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "duallane-entrypoint-"));
  const checkout = path.join(directory, "checkout");
  const bin = path.join(directory, "bin");
  const dockerLog = path.join(directory, "docker.log");
  const adoptionLog = path.join(directory, "adoption.log");
  const snapshot = path.join(directory, "previous.snapshot.json");
  await mkdir(path.join(checkout, "deploy/production"), { recursive: true });
  await mkdir(bin);
  for (const name of ["deploy.sh", "release-helper.sh", "release-manifest.mjs"]) {
    const source = await readFile(path.join(root, "deploy/production", name), "utf8");
    await writeFile(path.join(checkout, "deploy/production", name), source.replaceAll("\r\n", "\n"));
  }
  await writeFile(path.join(checkout, ".gitignore"), ".env\n");
  await writeFile(path.join(checkout, ".env"), `DUALLANE_PRODUCTION_DIR=${checkout}\n`, { mode: 0o600 });
  await writeFile(snapshot, "{}\n", { mode: 0o600 });
  await writeFile(dockerLog, "");
  await writeFile(adoptionLog, "");
  // No invocation can reach a real daemon, including an unexpected error trap.
  await writeFile(path.join(bin, "docker"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TEST_DOCKER_LOG"\nexit 99\n', { mode: 0o700 });
  await writeFile(path.join(bin, "systemctl"), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  await writeFile(path.join(bin, "node"), [
    "#!/bin/sh",
    'case "$1" in',
    '  */release-adopt-running.mjs) printf "%s\\n" "$@" >> "$TEST_ADOPTION_LOG"; exit "${TEST_ADOPTION_STATUS:-0}" ;;',
    '  *) exec "$TEST_NODE_BINARY" "$@" ;;',
    "esac",
    ""
  ].join("\n"), { mode: 0o700 });

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    DUALLANE_PRODUCTION_DIR: checkout,
    DUALLANE_BACKUP_DIR: path.join(directory, "baselines"),
    DUALLANE_DEPLOY_LOCK_FILE: path.join(directory, "deploy.lock"),
    TEST_NODE_BINARY: process.execPath,
    TEST_DOCKER_LOG: dockerLog,
    TEST_ADOPTION_LOG: adoptionLog
  };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "DUALLANE_ENV_FILE"]) delete env[key];
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: checkout, env, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "--quiet", "-b", "main");
  git("config", "user.name", "Synthetic release test");
  git("config", "user.email", "synthetic@example.invalid");
  git("add", ".");
  git("commit", "--quiet", "-m", "Synthetic production checkout");
  const commit = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", commit);
  const invoke = (args, overrides = {}) => spawnSync("bash", [
    "--noprofile", "--norc", path.join(checkout, "deploy/production/deploy.sh"), ...args
  ], {
    cwd: checkout,
    env: { ...env, ...overrides },
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 256 * 1024
  });
  const upgradeArgs = ["--expected-commit", commit, "--go-upgrade", "--previous-release-snapshot", snapshot];
  const adoptionArgs = ["--expected-commit", commit, "--adopt-running", "--expected-previous-commit", previousCommit];
  try {
    await callback({ checkout, directory, git, commit, invoke, upgradeArgs, adoptionArgs, adoptionLog });
  } finally {
    const dockerCalls = await readFile(dockerLog, "utf8");
    await rm(directory, { recursive: true, force: true });
    assert.equal(dockerCalls, "", "preflight/adoption dispatch must never call Docker");
  }
}

function assertRefusal(result, message, status = 2) {
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, status, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, message);
}

test("production entrypoint rejects the removed branch override before any Docker access", { skip: linuxOnly }, async () => {
  await withEntrypoint(async ({ invoke, upgradeArgs }) => {
    assertRefusal(invoke([...upgradeArgs, "--allow-branch", "feature/unsafe"]), /Unknown argument: --allow-branch/);
  });
});

test("adoption rejects incomplete or conflicting operator inputs without dispatch", { skip: linuxOnly }, async () => {
  await withEntrypoint(async ({ invoke, adoptionArgs, upgradeArgs, adoptionLog }) => {
    for (const extra of [
      ["--go-upgrade"], ["--previous-release-snapshot", "/missing/snapshot"],
      ["--bootstrap"], ["--prepare-go-permissions"], ["--release-profile", "node-default"]
    ]) {
      assertRefusal(invoke([...adoptionArgs, ...extra]), /Adoption requires root/);
    }
    assertRefusal(invoke(adoptionArgs.slice(0, 3)), /Adoption requires root/);
    assertRefusal(invoke([...adoptionArgs.slice(0, -1), "short-sha"]), /Adoption requires root/);
    assertRefusal(invoke(adoptionArgs, { DUALLANE_PRODUCTION_DIR: "" }), /Adoption requires root/);
    assertRefusal(invoke([...upgradeArgs, "--expected-previous-commit", previousCommit]), /only Go-to-Go upgrades/);
    assertRefusal(invoke(["--expected-previous-commit"]), /Missing value for --expected-previous-commit/);
    assert.equal(await readFile(adoptionLog, "utf8"), "");
  });
});

test("adoption requires root even when its inputs are complete", { skip: linuxOnly || process.getuid() === 0 }, async () => {
  await withEntrypoint(async ({ invoke, adoptionArgs, adoptionLog }) => {
    assertRefusal(invoke(adoptionArgs), /Adoption requires root/);
    assert.equal(await readFile(adoptionLog, "utf8"), "");
  });
});

test("shared entrypoint gates reject dirty, non-main, and mismatched release checkouts", { skip: linuxOnly }, async () => {
  const cases = [
    { prepare: async ({ checkout }) => writeFile(path.join(checkout, "unreviewed"), "dirty\n"), message: /worktree must be clean/ },
    { prepare: async ({ git }) => git("switch", "--quiet", "-c", "codex/synthetic"), message: /requires the main branch/ },
    { prepare: async ({ git }) => git("update-ref", "-d", "refs/remotes/origin/main"), message: /requires a fetched origin\/main/ },
    { prepare: async ({ git }) => git("commit", "--quiet", "--allow-empty", "-m", "Unpushed release"), message: /does not match origin\/main/, useCurrentCommit: true }
  ];
  for (const mode of rootOnly ? ["upgrade"] : ["upgrade", "adopt"]) {
    for (const item of cases) {
      await withEntrypoint(async (fixture) => {
        await item.prepare(fixture);
        const args = [...(mode === "upgrade" ? fixture.upgradeArgs : fixture.adoptionArgs)];
        if (item.useCurrentCommit) args[1] = fixture.git("rev-parse", "HEAD");
        assertRefusal(fixture.invoke(args), item.message, 1);
        assert.equal(await readFile(fixture.adoptionLog, "utf8"), "");
      });
    }
  }
});

// These tests exercise real EUID checks and therefore run only when the test
// runner already is root. Ordinary CI never invokes sudo or weakens the gate.
test("root adoption still requires the expected full main commit and canonical env path", { skip: rootOnly }, async () => {
  await withEntrypoint(async ({ invoke, adoptionArgs, directory }) => {
    assertRefusal(invoke(adoptionArgs.slice(2)), /--expected-commit is required/);
    assertRefusal(invoke(["--expected-commit", "short-sha", ...adoptionArgs.slice(2)]), /full 40-character lowercase Git SHA/);
    assertRefusal(invoke(["--expected-commit", previousCommit, ...adoptionArgs.slice(2)]), /not a valid Git commit/);
    assertRefusal(invoke(adoptionArgs, { DUALLANE_ENV_FILE: path.join(directory, "other.env") }), /restores only the production checkout's missing .env/);
  });
});

test("root adoption dispatches only the observed-state helper and preserves helper failure", { skip: rootOnly }, async () => {
  await withEntrypoint(async ({ invoke, adoptionArgs, adoptionLog, checkout, directory }) => {
    await rm(path.join(checkout, ".env"));
    const success = invoke(adoptionArgs);
    assert.equal(success.status, 0, success.stderr);
    const args = (await readFile(adoptionLog, "utf8")).trim().split("\n");
    assert.deepEqual(args.slice(0, 6), [
      path.join(checkout, "deploy/production/release-adopt-running.mjs"),
      "--project-dir", checkout, "--expected-previous-commit", previousCommit, "--output-dir"
    ]);
    assert.ok(args[6].startsWith(path.join(directory, "baselines", "observed-go-baseline-")));
    assert.ok(args[6].endsWith(previousCommit.slice(0, 12)));
    const failed = invoke(adoptionArgs, { TEST_ADOPTION_STATUS: "37" });
    assertRefusal(failed, /Production deployment failed with exit code 37/, 37);
  });
});

test("local Docker guard rejects remote endpoints and requires a real Unix socket", { skip: linuxOnly }, async () => {
  const source = (await readFile(path.join(root, "deploy/production/deploy.sh"), "utf8")).replaceAll("\r\n", "\n");
  const start = source.indexOf("require_local_docker() {");
  const end = source.indexOf("\n\nensure_buildx_builder() {", start);
  assert.ok(start >= 0 && end > start, "local Docker guard is missing");
  const directory = await mkdtemp(path.join(os.tmpdir(), "duallane-daemon-guard-"));
  const socketPath = path.join(directory, "synthetic.sock");
  const plainFile = path.join(directory, "not-a-socket");
  const log = path.join(directory, "docker.log");
  await writeFile(plainFile, "synthetic\n");
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  const script = [
    "set -euo pipefail",
    'docker() { printf "%s\\n" "$*" >> "$TEST_DOCKER_LOG"; [[ "$1" == context && "$2" == inspect ]] || return 99; [[ "${TEST_INSPECT_FAILURE:-0}" == 0 ]] || return 99; printf "%s\\n" "$TEST_CONTEXT_ENDPOINT"; }',
    source.slice(start, end),
    "require_local_docker"
  ].join("\n");
  try {
    for (const [host, context, endpoint, expectedStatus, expectedInspection] of [
      ["tcp://127.0.0.1:2375", "", "", 1, false],
      ["ssh://synthetic.invalid", "", "", 1, false],
      [`unix://${path.join(directory, "absent.sock")}`, "", "", 1, false],
      [`unix://${plainFile}`, "", "", 1, false],
      [`unix://${socketPath}`, "", "", 0, false],
      ["", "", "tcp://synthetic.invalid:2375", 1, true],
      ["", "", `unix://${socketPath}`, 0, true],
      // Docker gives an explicit context priority over DOCKER_HOST.
      [`unix://${socketPath}`, "remote", "ssh://synthetic.invalid", 1, true],
      ["ssh://synthetic.invalid", "local", `unix://${socketPath}`, 0, true]
    ]) {
      await writeFile(log, "");
      const result = spawnSync("bash", ["--noprofile", "--norc", "-c", script], {
        encoding: "utf8", timeout: 5_000,
        env: { ...process.env, DOCKER_HOST: host, DOCKER_CONTEXT: context, TEST_CONTEXT_ENDPOINT: endpoint, TEST_DOCKER_LOG: log }
      });
      assert.equal(result.status, expectedStatus, result.stderr);
      if (expectedStatus !== 0) assert.match(result.stderr, /local Unix Docker daemon/);
      const calls = (await readFile(log, "utf8")).trim().split("\n").filter(Boolean);
      assert.equal(calls.length, expectedInspection ? 1 : 0);
      assert.ok(calls.every(call => call.startsWith("context inspect ")), "only read-only context inspection is permitted");
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
