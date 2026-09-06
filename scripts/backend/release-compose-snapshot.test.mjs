import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  IMAGE_SERVICES,
  MAX_FILE_BYTES,
  SNAPSHOT_FORMAT,
  SNAPSHOT_VERSION,
  captureComposeSnapshot,
  readSnapshot,
  verifySnapshot,
  writeRecoverableCompose,
  writeSnapshot
} from "../../deploy/production/release-compose-snapshot.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const helper = path.join(root, "deploy/production/release-compose-snapshot.mjs");

const imageIDs = Object.freeze({
  p2p: `sha256:${"1".repeat(64)}`,
  workspace: `sha256:${"2".repeat(64)}`,
  worker: `sha256:${"2".repeat(64)}`,
  web: `sha256:${"3".repeat(64)}`,
  migrate: `sha256:${"2".repeat(64)}`
});

function fixtureInput() {
  return {
    profile: "go-full",
    project: "duallane-production",
    commit: "a".repeat(40),
    semver: "0.15.5-go.1+synthetic",
    schemaVersion: 33,
    imageIDs: { ...imageIDs },
    compose: {
      name: "duallane-production",
      version: "3.9",
      services: {
        p2p: {
          image: "registry.example/p2p:old",
          environment: { P2P_MODE: "direct", SYNTHETIC_SECRET: "do-not-print" },
          entrypoint: ["/app/p2p"],
          command: ["serve", "--synthetic"],
          volumes: [{ type: "volume", source: "p2p-data", target: "/app/data", read_only: true }],
          networks: ["private"],
          restart: "always",
          healthcheck: { test: ["CMD", "/usr/local/bin/duallane-healthcheck", "http://127.0.0.1:8787/api/health"] },
          depends_on: { postgres: { condition: "service_healthy" } },
          configs: ["p2p-config"]
        },
        workspace: {
          image: "registry.example/workspace:old",
          environment: { WORKSPACE_ENABLED: "true", SYNTHETIC_SECRET: "do-not-print" },
          entrypoint: "/app/workspace",
          command: ["serve", "--http"],
          volumes: ["legacy-data:/app/data:rw"],
          networks: { private: { aliases: ["workspace"] } },
          restart: "always",
          healthcheck: { interval: "5s", test: ["CMD", "readyz"] },
          depends_on: {
            postgres: { condition: "service_healthy" },
            migrate: { condition: "service_completed_successfully" }
          },
          configs: { workspace: { source: "workspace-config", target: "/etc/duallane/config" } }
        },
        worker: {
          image: "registry.example/workspace:old",
          environment: ["WORKSPACE_ENABLED=true", "WORKER_VALIDATE_ONLY=true"],
          entrypoint: ["/app/worker"],
          command: "run",
          volumes: [{ type: "bind", source: "/synthetic/data", target: "/app/data" }],
          networks: ["private", "metrics"],
          restart: { condition: "on-failure", max_attempts: 3 },
          healthcheck: { test: ["CMD", "readyz"], timeout: "3s" },
          depends_on: { postgres: { condition: "service_healthy" }, migrate: { condition: "service_completed_successfully" } }
        },
        web: {
          image: "registry.example/web:old",
          environment: { PUBLIC_BASE_URL: "https://synthetic.invalid" },
          entrypoint: ["/docker-entrypoint.sh"],
          command: ["nginx", "-g", "daemon off;"],
          volumes: ["web-cache:/var/cache/nginx"],
          networks: ["private"],
          restart: "always",
          healthcheck: { test: ["CMD", "curl", "--fail", "http://127.0.0.1:8080/api/health"] },
          depends_on: { p2p: { condition: "service_healthy" }, workspace: { condition: "service_healthy" } }
        },
        migrate: {
          image: "registry.example/workspace:old",
          environment: { MIGRATIONS_DIR: "/app/migrations" },
          entrypoint: ["/app/migrate"],
          command: ["up"],
          volumes: [{ type: "volume", source: "legacy-data", target: "/app/data" }],
          networks: ["private"],
          restart: "no",
          depends_on: { postgres: { condition: "service_healthy" } }
        },
        postgres: {
          image: "postgres:17",
          environment: { POSTGRES_PASSWORD: "do-not-print" },
          networks: ["private"],
          restart: "always",
          healthcheck: { test: ["CMD", "pg_isready"] }
        }
      },
      networks: {
        private: { driver: "bridge" },
        metrics: { internal: true }
      },
      volumes: {
        "p2p-data": { name: "duallane-p2p" },
        "legacy-data": { name: "duallane-data" },
        "web-cache": {}
      },
      configs: {
        "p2p-config": { file: "./synthetic-p2p.conf" },
        "workspace-config": { file: "./synthetic-workspace.conf" }
      },
      secrets: { synthetic: { file: "./synthetic.secret" } },
      "x-release-extension": { owner: "synthetic", preserve: true }
    }
  };
}

function expectCode(callback, code) {
  assert.throws(callback, (error) => error?.code === code);
}

async function temporaryDirectory() {
  return mkdtemp(path.join(await realpath(os.tmpdir()), "duallane-release-compose-snapshot-"));
}

function runCLI(args, env = {}, timeout = 30_000) {
  return spawnSync(process.execPath, [helper, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout,
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024
  });
}

test("capture pins only owner images and recover writes an exact private Compose copy", async () => {
  const directory = await temporaryDirectory();
  try {
    const input = fixtureInput();
    input.compose.services.workspace.environment.DOLLAR_VALUE = "abc$$FOO";
    input.compose.services.worker.command = ["run", "$$COMMAND"];
    input.compose["x$extension"] = { "key$literal": "$$VALUE" };
    const originalCompose = structuredClone(input.compose);
    const snapshot = captureComposeSnapshot(input);
    const originalSnapshot = structuredClone(snapshot);
    assert.deepEqual(input.compose, originalCompose);
    assert.equal(snapshot.format, SNAPSHOT_FORMAT);
    assert.equal(snapshot.version, SNAPSHOT_VERSION);
    for (const service of IMAGE_SERVICES) assert.equal(snapshot.compose.services[service].image, imageIDs[service]);
    assert.deepEqual(snapshot.compose.services.workspace.environment, originalCompose.services.workspace.environment);
    assert.deepEqual(snapshot.compose.services.worker.command, originalCompose.services.worker.command);
    assert.deepEqual(snapshot.compose.services.worker.volumes, originalCompose.services.worker.volumes);
    assert.deepEqual(snapshot.compose.networks, originalCompose.networks);
    assert.deepEqual(snapshot.compose.configs, originalCompose.configs);
    assert.deepEqual(snapshot.compose.secrets, originalCompose.secrets);

    const snapshotPath = path.join(directory, "snapshot.json");
    const composePath = path.join(directory, "recovery-compose.json");
    const written = await writeSnapshot(snapshotPath, snapshot);
    assert.equal((await stat(snapshotPath)).mode & 0o777, 0o600);
    assert.equal(written.byteSize, (await stat(snapshotPath)).size);
    const verified = await readSnapshot(snapshotPath, { ...input, version: SNAPSHOT_VERSION });
    assert.deepEqual(verified, snapshot);
    await writeRecoverableCompose(composePath, verified);
    assert.equal((await stat(composePath)).mode & 0o777, 0o600);
    const recoveredCompose = JSON.parse(await readFile(composePath, "utf8"));
    assert.equal(recoveredCompose.services.workspace.environment.DOLLAR_VALUE, "abc$$FOO");
    assert.deepEqual(recoveredCompose.services.worker.command, ["run", "$$COMMAND"]);
    assert.equal(recoveredCompose["x$extension"]["key$literal"], "$$VALUE");
    assert.deepEqual(recoveredCompose, snapshot.compose);
    assert.deepEqual(snapshot, originalSnapshot);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("capture and verification reject partial owners, malformed identities, and unpinned Compose", () => {
  const input = fixtureInput();
  const incomplete = structuredClone(input);
  delete incomplete.imageIDs.web;
  expectCode(() => captureComposeSnapshot(incomplete), "incomplete_image_ids");

  const malformed = structuredClone(input);
  malformed.imageIDs.p2p = "sha256:short";
  expectCode(() => captureComposeSnapshot(malformed), "invalid_image_id");

  const mixed = structuredClone(input);
  mixed.imageIDs.worker = `sha256:${"4".repeat(64)}`;
  expectCode(() => captureComposeSnapshot(mixed), "workspace_worker_migrate_image_mismatch");

  const missingService = structuredClone(input);
  delete missingService.compose.services.web;
  expectCode(() => captureComposeSnapshot(missingService), "missing_compose_service");

  const missingProject = structuredClone(input);
  delete missingProject.compose.name;
  expectCode(() => captureComposeSnapshot(missingProject), "missing_compose_project");
  const mismatchedProject = structuredClone(input);
  mismatchedProject.compose.name = "another-project";
  expectCode(() => captureComposeSnapshot(mismatchedProject), "compose_project_mismatch");

  const invalidMetadata = structuredClone(input);
  invalidMetadata.commit = "not-a-full-commit";
  expectCode(() => captureComposeSnapshot(invalidMetadata), "invalid_commit");
  invalidMetadata.commit = "a".repeat(40);
  invalidMetadata.semver = "v0.15.5";
  expectCode(() => captureComposeSnapshot(invalidMetadata), "invalid_semver");
  invalidMetadata.semver = "0.15.5";
  invalidMetadata.schemaVersion = -1;
  expectCode(() => captureComposeSnapshot(invalidMetadata), "invalid_schema_version");

  const snapshot = captureComposeSnapshot(input);
  const unpinned = structuredClone(snapshot);
  unpinned.compose.services.web.image = "registry.example/web:changed";
  expectCode(() => verifySnapshot(unpinned), "image_not_pinned");
  expectCode(() => verifySnapshot(snapshot, { commit: "b".repeat(40) }), "snapshot_commit_mismatch");
});

test("exclusive private files enforce all destination and read guards", async () => {
  const directory = await temporaryDirectory();
  try {
    const snapshot = captureComposeSnapshot(fixtureInput());
    const existing = path.join(directory, "existing.json");
    await writeFile(existing, "synthetic-existing", { mode: 0o600 });
    await assert.rejects(writeSnapshot(existing, snapshot), (error) => error?.code === "destination_exists");
    assert.equal(await readFile(existing, "utf8"), "synthetic-existing");

    const link = path.join(directory, "link.json");
    await symlink(existing, link);
    await assert.rejects(writeSnapshot(link, snapshot), (error) => error?.code === "destination_symlink");
    await assert.rejects(readSnapshot(link), (error) => error?.code === "snapshot_symlink");

    const nonRegular = path.join(directory, "directory.json");
    await mkdir(nonRegular);
    await assert.rejects(writeSnapshot(nonRegular, snapshot), (error) => error?.code === "destination_not_regular");

    const snapshotPath = path.join(directory, "mode.json");
    await writeSnapshot(snapshotPath, snapshot);
    await chmod(snapshotPath, 0o644);
    await assert.rejects(readSnapshot(snapshotPath), (error) => error?.code === "snapshot_permissions");
    await chmod(snapshotPath, 0o600);

    const trailerPath = path.join(directory, "trailer.json");
    await writeFile(trailerPath, `${JSON.stringify(snapshot)}\nsynthetic-trailer\n`, { mode: 0o600 });
    await assert.rejects(readSnapshot(trailerPath), (error) => error?.code === "snapshot_invalid_json");

    const boundary = structuredClone(snapshot);
    boundary.compose["x-padding"] = "";
    const emptyPaddingBytes = Buffer.byteLength(`${JSON.stringify(boundary)}\n`);
    boundary.compose["x-padding"] = "x".repeat(MAX_FILE_BYTES - emptyPaddingBytes);
    const boundaryPath = path.join(directory, "boundary.json");
    await writeFile(boundaryPath, `${JSON.stringify(boundary)}\n`, { mode: 0o600 });
    assert.equal((await stat(boundaryPath)).size, MAX_FILE_BYTES);
    assert.deepEqual(await readSnapshot(boundaryPath), boundary);

    const oversizedPath = path.join(directory, "oversized.json");
    await writeFile(oversizedPath, `${JSON.stringify({ ...boundary, compose: { ...boundary.compose, "x-padding": `${boundary.compose["x-padding"]}x` } })}\n`, { mode: 0o600 });
    await assert.rejects(readSnapshot(oversizedPath), (error) => error?.code === "snapshot_too_large");

    const replacedPath = path.join(directory, "replaced.json");
    const retainedPath = path.join(directory, "retained.json");
    await writeSnapshot(replacedPath, snapshot);
    await rename(replacedPath, retainedPath);
    await symlink(retainedPath, replacedPath);
    await assert.rejects(readSnapshot(replacedPath), (error) => error?.code === "snapshot_symlink");

    const fifoPath = path.join(directory, "snapshot.fifo");
    const fifo = spawnSync("mkfifo", [fifoPath], { encoding: "utf8", windowsHide: true });
    assert.equal(fifo.status, 0, fifo.stderr);
    const started = Date.now();
    const fifoRejected = runCLI(["verify", "--input", fifoPath], {}, 2_000);
    assert.ok(Date.now() - started < 2_000, "FIFO verification must fail without blocking");
    assert.notEqual(fifoRejected.status, 0);
    assert.equal(fifoRejected.stdout, "");
    assert.match(fifoRejected.stderr, /snapshot_not_regular/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI emits only a safe summary and keeps capture/recovery JSON in 0600 files", async () => {
  const directory = await temporaryDirectory();
  try {
    const inputPath = path.join(directory, "capture-input.json");
    const snapshotPath = path.join(directory, "snapshot.json");
    const composePath = path.join(directory, "recovery.json");
    const input = fixtureInput();
    await writeFile(inputPath, JSON.stringify(input), { mode: 0o600 });

    const captured = runCLI(["capture", "--input", inputPath, "--output", snapshotPath]);
    assert.equal(captured.status, 0, captured.stderr);
    assert.equal(captured.stderr, "");
    assert.equal(JSON.parse(captured.stdout).operation, "capture");
    for (const secret of ["do-not-print", "SYNTHETIC_SECRET", "environment", imageIDs.p2p]) {
      assert.equal(captured.stdout.includes(secret), false, `capture stdout leaked ${secret}`);
    }

    const verified = runCLI(["verify", "--input", snapshotPath]);
    assert.equal(verified.status, 0, verified.stderr);
    assert.equal(JSON.parse(verified.stdout).operation, "verify");
    assert.equal(verified.stdout.includes("do-not-print"), false);

    const recovered = runCLI(["recover", "--input", snapshotPath, "--output", composePath]);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(JSON.parse(recovered.stdout).operation, "recover");
    assert.equal(recovered.stdout.includes("do-not-print"), false);
    assert.deepEqual(JSON.parse(await readFile(composePath, "utf8")), (await readSnapshot(snapshotPath)).compose);
    assert.equal((await stat(composePath)).mode & 0o777, 0o600);

    const publicInputPath = path.join(directory, "public-input.json");
    await writeFile(publicInputPath, JSON.stringify(input), { mode: 0o644 });
    await chmod(publicInputPath, 0o644);
    const publicRejected = runCLI(["capture", "--input", publicInputPath, "--output", path.join(directory, "public-snapshot.json")]);
    assert.notEqual(publicRejected.status, 0);
    assert.equal(publicRejected.stdout, "");
    assert.match(publicRejected.stderr, /input_permissions/);
    assert.equal(publicRejected.stderr.includes("do-not-print"), false);

    const badInput = structuredClone(input);
    badInput.imageIDs.p2p = "credential-secret";
    await writeFile(path.join(directory, "bad-input.json"), JSON.stringify(badInput), { mode: 0o600 });
    const rejected = runCLI(["capture", "--input", path.join(directory, "bad-input.json"), "--output", path.join(directory, "bad-snapshot.json")]);
    assert.notEqual(rejected.status, 0);
    assert.equal(rejected.stdout, "");
    assert.equal(rejected.stderr.includes("credential-secret"), false);
    assert.equal(rejected.stderr.includes("environment"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
