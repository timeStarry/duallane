import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fsApi from "node:fs/promises";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertLinuxRoot,
  parseCli,
  prepareCredential,
  prepareVolume,
  StoragePermissionsError,
} from "../../deploy/production/release-storage-permissions.mjs";

const LINUX_ROOT = process.platform === "linux" && process.getuid?.() === 0;
const VOLUME_NAME = "duallane-storage-test";
const PROJECT = "duallane";
const SCRIPT_PATH = fileURLToPath(new URL("../../deploy/production/release-storage-permissions.mjs", import.meta.url));
const IDS = Object.freeze({
  stopped: "1".repeat(64),
  named: "2".repeat(64),
  stoppedBind: "3".repeat(64),
  bind: "4".repeat(64),
});

function expectCode(action, code) {
  return assert.rejects(action, (error) => error instanceof StoragePermissionsError && error.code === code);
}

function mode(info) {
  return Number(info.mode & 0o7777n);
}

async function fixture(t) {
  if (!LINUX_ROOT) {
    t.skip("filesystem mutation fixtures require Linux root");
    return null;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "duallane-release-storage-permissions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function makeVolume(root, name = VOLUME_NAME) {
  const dockerRoot = path.join(root, "docker-root");
  const volumeRoot = path.join(dockerRoot, "volumes", name, "_data");
  await mkdir(volumeRoot, { recursive: true, mode: 0o700 });
  await chmod(dockerRoot, 0o700);
  await chmod(volumeRoot, 0o700);
  return { dockerRoot, volumeRoot, backupDir: path.join(root, "backups") };
}

function mockDocker({ dockerRoot, volumeRoot, volumeName = VOLUME_NAME, project = PROJECT, containers = [], securityOptions = [] }) {
  const byId = new Map(containers.map((container) => [container.id, container.details]));
  const calls = [];
  return {
    calls,
    async info() {
      return { DockerRootDir: dockerRoot, Rootless: false, SecurityOptions: securityOptions };
    },
    async volumeInspect() {
      return [{
        Name: volumeName,
        Driver: "local",
        Options: {},
        Labels: {
          "com.docker.compose.project": project,
          "com.docker.compose.volume": "workspace-data",
        },
        CreatedAt: "2026-09-09T00:00:00Z",
        Mountpoint: volumeRoot,
      }];
    },
    async containerIds() {
      return containers.map((container) => container.id);
    },
    async containerInspect(id) {
      calls.push(id);
      return byId.get(id);
    },
  };
}

function runningDetails(mounts) {
  return { State: { Running: true }, Mounts: mounts };
}

function stoppedDetails() {
  return { State: { Running: false }, Mounts: [] };
}

function namedRwMount(volumeRoot) {
  return { Type: "volume", Name: VOLUME_NAME, Source: volumeRoot, RW: true };
}

function bindRwMount(source) {
  return { Type: "bind", Source: source, RW: true };
}

async function readRun(root, runId) {
  const runDir = path.join(root, "backups", runId);
  const readOptional = async (name) => JSON.parse(await readFile(path.join(runDir, name), "utf8").catch(() => "null"));
  return {
    runDir,
    manifest: await readOptional("manifest.json"),
    phase: await readOptional("phase.json"),
    report: await readOptional("report.json"),
  };
}

function spawnCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT_PATH, ...args], { encoding: "utf8" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test("root guard and explicit subcommands reject non-Linux, non-root, defaults, and bypass flags", () => {
  assert.throws(() => assertLinuxRoot({ platform: "win32", uid: 0 }), /linux_only/);
  assert.throws(() => assertLinuxRoot({ platform: "linux", uid: 1000 }), /root_required/);
  assert.throws(() => parseCli([]), /command_required/);
  assert.throws(() => parseCli(["credential", "--path", "/tmp/secret", "--backup-dir", "/tmp/backup", "--uid", "0"]), /argument_invalid/);
  assert.throws(() => parseCli(["volume", "--volume", VOLUME_NAME, "--backup-dir", "/tmp/backup"]), /project_required/);
  assert.deepEqual(
    parseCli(["credential", "--path", "/tmp/secret", "--backup-dir", "/tmp/backup"]),
    { command: "credential", path: "/tmp/secret", backupDir: "/tmp/backup" },
  );
});

test("credential creates and verifies the backup before repeated manifest transitions and mutation", async (t) => {
  const root = await fixture(t);
  if (!root) return;
  const sourceDir = path.join(root, "source");
  const sourcePath = path.join(sourceDir, "credential");
  const backupDir = path.join(root, "backups");
  const secret = Buffer.from("synthetic credential bytes\n", "utf8");
  await mkdir(sourceDir, { mode: 0o700 });
  await writeFile(sourcePath, secret, { mode: 0o600 });
  await chmod(sourcePath, 0o600);
  let hookObservedVerifiedBackup = false;
  const result = await prepareCredential({
    sourcePath,
    backupDir,
    platform: "linux",
    uid: 0,
    runId: "run-credential-success",
    hooks: {
      async beforeMutation({ ctx }) {
        hookObservedVerifiedBackup = true;
        assert.deepEqual(await readFile(path.join(ctx.dataDir, "credential")), secret);
        const manifest = JSON.parse(await readFile(ctx.manifestPath, "utf8"));
        const phase = JSON.parse(await readFile(ctx.phasePath, "utf8"));
        assert.equal(manifest.status, "verified_original");
        assert.equal(phase.status, "backup_verified");
      },
    },
  });
  assert.equal(hookObservedVerifiedBackup, true);
  assert.equal(result.status, "completed");
  assert.equal(JSON.stringify(result).includes(sourcePath), false);
  assert.equal(JSON.stringify(result).includes(createHash("sha256").update(secret).digest("hex")), false);
  const sourceInfo = await lstat(sourcePath, { bigint: true });
  assert.equal(sourceInfo.uid, 65532n);
  assert.equal(sourceInfo.gid, 65532n);
  assert.equal(mode(sourceInfo), 0o600);
  const { runDir, manifest } = await readRun(root, "run-credential-success");
  assert.equal(manifest.status, "verified_original");
  assert.equal((await lstat(path.join(runDir, "manifest.json"), { bigint: true })).mode & 0o777n, 0o600n);
  assert.equal((await lstat(path.join(runDir, "data"), { bigint: true })).mode & 0o777n, 0o700n);
  assert.deepEqual(await readFile(path.join(runDir, "data", "credential")), secret);
  const report = JSON.parse(await readFile(path.join(runDir, "report.json"), "utf8"));
  assert.equal(report.status, "completed");
});

test("credential drift keeps the original backup and failed metadata without restoring source bytes", async (t) => {
  const root = await fixture(t);
  if (!root) return;
  const sourceDir = path.join(root, "source");
  const sourcePath = path.join(sourceDir, "credential");
  const backupDir = path.join(root, "backups");
  const original = Buffer.from("original-secret", "utf8");
  const changed = Buffer.from("changed-secret!", "utf8");
  await mkdir(sourceDir, { mode: 0o700 });
  await writeFile(sourcePath, original, { mode: 0o600 });
  await chmod(sourcePath, 0o600);
  await expectCode(
    prepareCredential({
      sourcePath,
      backupDir,
      platform: "linux",
      uid: 0,
      runId: "run-credential-drift",
      hooks: { beforeMutation: () => writeFile(sourcePath, changed) },
    }),
    "source_hash_mismatch",
  );
  const { runDir, manifest } = await readRun(root, "run-credential-drift");
  assert.equal(manifest.status, "verified_original");
  assert.equal((await readRun(root, "run-credential-drift")).phase.status, "failed");
  assert.equal((await readRun(root, "run-credential-drift")).report.errorCode, "source_hash_mismatch");
  assert.deepEqual(await readFile(sourcePath), changed);
  assert.deepEqual(await readFile(path.join(runDir, "data", "credential")), original);
  assert.equal((await lstat(path.join(runDir, "report.json"), { bigint: true })).mode & 0o777n, 0o600n);
});

test("credential CLI succeeds through a real process.execPath and emits only safe summary fields", async (t) => {
  const root = await fixture(t);
  if (!root) return;
  const sourceDir = path.join(root, "source");
  const sourcePath = path.join(sourceDir, "credential");
  const backupDir = path.join(root, "backups");
  const secret = "spawned-cli-secret\n";
  await mkdir(sourceDir, { mode: 0o700 });
  await writeFile(sourcePath, secret, { mode: 0o600 });
  await chmod(sourcePath, 0o600);
  const result = await spawnCli(["credential", "--path", sourcePath, "--backup-dir", backupDir]);
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, "");
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, "completed");
  assert.equal(summary.operation, "credential");
  assert.equal(result.stdout.includes(sourcePath), false);
  assert.equal(result.stdout.includes(secret), false);
  assert.equal(result.stdout.includes(createHash("sha256").update(secret).digest("hex")), false);
  const info = await lstat(sourcePath, { bigint: true });
  assert.equal(info.uid, 65532n);
  assert.equal(info.gid, 65532n);
  assert.equal(mode(info), 0o600);
});

test("partial mutation failure retains immutable original manifest and backup bytes", async (t) => {
  const root = await fixture(t);
  if (!root) return;
  const sourceDir = path.join(root, "source");
  const sourcePath = path.join(sourceDir, "credential");
  const backupDir = path.join(root, "backups");
  const original = Buffer.from("partial-mutation-secret", "utf8");
  await mkdir(sourceDir, { mode: 0o700 });
  await writeFile(sourcePath, original, { mode: 0o600 });
  await chmod(sourcePath, 0o600);
  const failingFs = {
    ...fsApi,
    async open(target, ...args) {
      const handle = await fsApi.open(target, ...args);
      if (target !== sourcePath) return handle;
      return new Proxy(handle, {
        get(fileHandle, property) {
          if (property === "chmod") return async () => { throw Object.assign(new Error("synthetic"), { code: "EIO" }); };
          const value = fileHandle[property];
          return typeof value === "function" ? value.bind(fileHandle) : value;
        },
      });
    },
  };
  await expectCode(
    prepareCredential({
      sourcePath,
      backupDir,
      fsApi: failingFs,
      platform: "linux",
      uid: 0,
      runId: "run-credential-partial",
    }),
    "mutation_failed",
  );
  const { runDir, manifest, phase, report } = await readRun(root, "run-credential-partial");
  assert.equal(manifest.status, "verified_original");
  assert.equal(phase.status, "failed");
  assert.equal(report.errorCode, "mutation_failed");
  assert.deepEqual(await readFile(sourcePath), original);
  assert.deepEqual(await readFile(path.join(runDir, "data", "credential")), original);
  const info = await lstat(sourcePath, { bigint: true });
  assert.equal(info.uid, 65532n);
  assert.equal(mode(info), 0o600);
});

test("backup directory fsync failure refuses source mutation and retains copied evidence", async (t) => {
  const root = await fixture(t);
  if (!root) return;
  const sourceDir = path.join(root, "source");
  const sourcePath = path.join(sourceDir, "credential");
  const backupDir = path.join(root, "backups");
  await mkdir(sourceDir, { mode: 0o700 });
  await writeFile(sourcePath, "synthetic-sync-evidence", { mode: 0o600 });
  const failingFs = {
    ...fsApi,
    async open(target, ...args) {
      const handle = await fsApi.open(target, ...args);
      if (target !== path.join(backupDir, "run-sync-failure", "data")) return handle;
      return new Proxy(handle, {
        get(fileHandle, property) {
          if (property === "sync") return async () => { throw new Error("synthetic sync failure"); };
          const value = fileHandle[property];
          return typeof value === "function" ? value.bind(fileHandle) : value;
        },
      });
    },
  };
  await expectCode(prepareCredential({ sourcePath, backupDir, fsApi: failingFs, runId: "run-sync-failure" }), "backup_metadata_sync_failed");
  assert.equal((await lstat(sourcePath)).uid, 0);
  const { runDir, manifest, phase } = await readRun(root, "run-sync-failure");
  assert.equal(manifest, null);
  assert.equal(phase.status, "failed");
  assert.equal(await readFile(path.join(runDir, "data", "credential"), "utf8"), "synthetic-sync-evidence");
});

test("volume success inspects stopped containers, preserves backup evidence, and tightens the full tree", async (t) => {
  const root = await fixture(t);
  if (!root) return;
  const volume = await makeVolume(root);
  const nested = path.join(volume.volumeRoot, "nested");
  const objectPath = path.join(nested, "object");
  await mkdir(nested, { mode: 0o700 });
  await writeFile(objectPath, "synthetic object\n", { mode: 0o600 });
  const runner = mockDocker({
    dockerRoot: volume.dockerRoot,
    volumeRoot: volume.volumeRoot,
    containers: [
      { id: IDS.stopped, details: stoppedDetails() },
    ],
  });
  const result = await prepareVolume({
    volumeName: VOLUME_NAME,
    project: PROJECT,
    backupDir: volume.backupDir,
    runner,
    platform: "linux",
    uid: 0,
    runId: "run-volume-success",
    limits: { maxEntries: 20, maxBytes: 1024 },
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(runner.calls, [IDS.stopped, IDS.stopped, IDS.stopped, IDS.stopped]);
  for (const target of [volume.volumeRoot, nested, objectPath]) {
    const info = await lstat(target, { bigint: true });
    assert.equal(info.uid, 65532n);
    assert.equal(info.gid, 65532n);
    assert.equal(mode(info), info.isDirectory() ? 0o700 : 0o600);
  }
  const { runDir, manifest } = await readRun(root, "run-volume-success");
  assert.equal(manifest.status, "verified_original");
  assert.equal((await readRun(root, "run-volume-success")).phase.status, "completed");
  assert.deepEqual(await readFile(path.join(runDir, "data", "nested", "object")), Buffer.from("synthetic object\n"));
});

test("volume rejects symlink and hardlink escapes before any ownership mutation", async (t) => {
  const root = await fixture(t);
  if (!root) return;
  const symlinkFixture = await makeVolume(root, "duallane-symlink-test");
  const outside = path.join(root, "outside");
  await writeFile(outside, "outside\n", { mode: 0o600 });
  await symlink(outside, path.join(symlinkFixture.volumeRoot, "escape"));
  const symlinkRunner = mockDocker({
    dockerRoot: symlinkFixture.dockerRoot,
    volumeRoot: symlinkFixture.volumeRoot,
    volumeName: "duallane-symlink-test",
  });
  await expectCode(
    prepareVolume({
      volumeName: "duallane-symlink-test",
      project: PROJECT,
      backupDir: symlinkFixture.backupDir,
      runner: symlinkRunner,
      platform: "linux",
      uid: 0,
      runId: "run-volume-symlink",
    }),
    "symlink_rejected",
  );

  const hardlinkFixture = await makeVolume(root, "duallane-hardlink-test");
  const original = path.join(root, "hardlink-source");
  await writeFile(original, "hardlink\n", { mode: 0o600 });
  await link(original, path.join(hardlinkFixture.volumeRoot, "hardlink"));
  const hardlinkRunner = mockDocker({
    dockerRoot: hardlinkFixture.dockerRoot,
    volumeRoot: hardlinkFixture.volumeRoot,
    volumeName: "duallane-hardlink-test",
  });
  await expectCode(
    prepareVolume({
      volumeName: "duallane-hardlink-test",
      project: PROJECT,
      backupDir: hardlinkFixture.backupDir,
      runner: hardlinkRunner,
      platform: "linux",
      uid: 0,
      runId: "run-volume-hardlink",
    }),
    "hardlink_rejected",
  );
  assert.equal((await lstat(path.join(hardlinkFixture.volumeRoot, "hardlink"), { bigint: true })).uid, 0n);
});

test("volume refuses named RW holders and RW bind mounts of an ancestor of the physical volume root", async (t) => {
  const root = await fixture(t);
  if (!root) return;
  const namedFixture = await makeVolume(root, "duallane-named-writer-test");
  const namedRunner = mockDocker({
    dockerRoot: namedFixture.dockerRoot,
    volumeRoot: namedFixture.volumeRoot,
    volumeName: "duallane-named-writer-test",
    containers: [{ id: IDS.stopped, details: stoppedDetails() }, {
      id: IDS.named,
      details: runningDetails([namedRwMount(namedFixture.volumeRoot)]),
    }],
  });
  await expectCode(
    prepareVolume({
      volumeName: "duallane-named-writer-test",
      project: PROJECT,
      backupDir: namedFixture.backupDir,
      runner: namedRunner,
      platform: "linux",
      uid: 0,
      runId: "run-volume-named-writer",
    }),
    "running_writer_detected",
  );
  assert.deepEqual(namedRunner.calls, [IDS.stopped, IDS.named]);

  const bindFixture = await makeVolume(root, "duallane-bind-writer-test");
  const bindRunner = mockDocker({
    dockerRoot: bindFixture.dockerRoot,
    volumeRoot: bindFixture.volumeRoot,
    volumeName: "duallane-bind-writer-test",
    containers: [{ id: IDS.stoppedBind, details: stoppedDetails() }, {
      id: IDS.bind,
      details: runningDetails([bindRwMount(bindFixture.dockerRoot)]),
    }],
  });
  await expectCode(
    prepareVolume({
      volumeName: "duallane-bind-writer-test",
      project: PROJECT,
      backupDir: bindFixture.backupDir,
      runner: bindRunner,
      platform: "linux",
      uid: 0,
      runId: "run-volume-bind-writer",
    }),
    "running_writer_detected",
  );
  assert.deepEqual(bindRunner.calls, [IDS.stoppedBind, IDS.bind]);
});

test("volume fails closed for Docker user namespaces and keeps the backup root outside the source", async (t) => {
  const root = await fixture(t);
  if (!root) return;
  const volume = await makeVolume(root, "duallane-userns-test");
  const runner = mockDocker({
    dockerRoot: volume.dockerRoot,
    volumeRoot: volume.volumeRoot,
    volumeName: "duallane-userns-test",
    securityOptions: ["name=userns"],
  });
  await expectCode(
    prepareVolume({
      volumeName: "duallane-userns-test",
      project: PROJECT,
      backupDir: volume.backupDir,
      runner,
      platform: "linux",
      uid: 0,
      runId: "run-volume-userns",
    }),
    "docker_user_namespace_unsupported",
  );
  await expectCode(
    prepareVolume({
      volumeName: "duallane-userns-test",
      project: PROJECT,
      backupDir: path.join(volume.volumeRoot, "nested-backup"),
      runner: mockDocker({
        dockerRoot: volume.dockerRoot,
        volumeRoot: volume.volumeRoot,
        volumeName: "duallane-userns-test",
      }),
      platform: "linux",
      uid: 0,
      runId: "run-volume-nested-backup",
    }),
    "backup_root_nested",
  );
});

test("small injected limits are test-only API inputs and still retain a failure manifest", async (t) => {
  const root = await fixture(t);
  if (!root) return;
  const volume = await makeVolume(root, "duallane-limit-test");
  await writeFile(path.join(volume.volumeRoot, "too-large"), "123456", { mode: 0o600 });
  const runner = mockDocker({
    dockerRoot: volume.dockerRoot,
    volumeRoot: volume.volumeRoot,
    volumeName: "duallane-limit-test",
  });
  await expectCode(
    prepareVolume({
      volumeName: "duallane-limit-test",
      project: PROJECT,
      backupDir: volume.backupDir,
      runner,
      platform: "linux",
      uid: 0,
      runId: "run-volume-limit",
      limits: { maxEntries: 10, maxBytes: 5 },
    }),
    "tree_bytes_exceeded",
  );
  const { phase, report } = await readRun(root, "run-volume-limit");
  assert.equal(phase.status, "failed");
  assert.equal(report.errorCode, "tree_bytes_exceeded");
});
