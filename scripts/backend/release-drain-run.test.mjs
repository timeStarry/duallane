import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  createDockerRunner,
  MAX_DOCKER_OUTPUT_BYTES,
  RELEASE_RUN_LABEL,
  runDrainCheck,
} from "../../deploy/production/release-drain-run.mjs";
import {
  buildDrainCompose,
  RELEASE_CHECK_COMMAND,
  RELEASE_CHECK_ENTRYPOINT,
  RELEASE_CHECK_SERVICE,
  RELEASE_CHECK_USER,
} from "../../deploy/production/release-drain-config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const helper = path.join(root, "deploy/production/release-drain-run.mjs");
const workspaceImage = `sha256:${"a".repeat(64)}`;
const project = "duallane-release-run-test";
const networkName = "duallane-release-run-private";
const runID = "b".repeat(64);
const postgresID = "1".repeat(64);
const networkID = "2".repeat(64);
const ownedID = "3".repeat(64);

function validCompose() {
  const workspaceRef = "registry.example/duallane-workspace:old";
  return {
    name: project,
    services: {
      postgres: {
        image: "postgres:17",
        networks: { private: { aliases: ["postgres"] } },
      },
      workspace: {
        image: workspaceRef,
        user: RELEASE_CHECK_USER,
        environment: {
          PGHOST: "postgres",
          PGPORT: "5432",
          PGDATABASE: "duallane",
          PGUSER: "duallane",
          PGPASSWORD: "synthetic-password",
          WORKSPACE_STORAGE_DRIVER: "local",
        },
        networks: { private: { aliases: ["workspace"] } },
      },
      worker: {
        image: workspaceRef,
        user: RELEASE_CHECK_USER,
        networks: { private: {} },
      },
      migrate: {
        image: workspaceRef,
        user: RELEASE_CHECK_USER,
        networks: { private: {} },
      },
    },
    networks: {
      private: { name: networkName, driver: "bridge" },
    },
  };
}

function zeroCounts() {
  return {
    schema: { missingItems: 0 },
    uploads: {
      reserved: 0,
      staleReserved: 0,
      missingAttachment: 0,
      nonPendingAttachment: 0,
      partRows: 0,
      partUploadCount: 0,
      reservedPartRows: 0,
      unknownStatus: 0,
    },
    emailJobs: {
      pending: 0,
      sending: 0,
      sent: 0,
      cancelled: 0,
      failed: 0,
      unknownStatus: 0,
      activeLeases: 0,
      expiredLeases: 0,
      sendingMissingLease: 0,
      sendingExpiredLease: 0,
      leaseAnomalies: 0,
    },
    ntfyJobs: {
      pending: 0,
      sending: 0,
      sent: 0,
      cancelled: 0,
      failed: 0,
      unknownStatus: 0,
      activeLeases: 0,
      expiredLeases: 0,
      sendingMissingLease: 0,
      sendingExpiredLease: 0,
      leaseAnomalies: 0,
    },
    emailDigest: {
      rows: 0,
      unnotified: 0,
      notified: 0,
      activeLeases: 0,
      expiredLeases: 0,
      unnotifiedActiveLeases: 0,
      unnotifiedExpiredLeases: 0,
      unnotifiedWithoutLease: 0,
      notifiedWithLease: 0,
    },
    echoSolicitation: {
      pending: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
      unknownStatus: 0,
      reconcile: 0,
    },
    echoRelease: {
      pending: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
      unknownStatus: 0,
      reconcile: 0,
    },
  };
}

function readyReport(driver = "local") {
  return {
    schema: "duallane.release-check/v1",
    status: "ready",
    scope: "database_and_provider_snapshot",
    snapshot: {
      ready: true,
      readOnly: true,
      snapshotAt: "2026-09-07T00:00:00.123456Z",
      counts: zeroCounts(),
      blockers: [],
      writers: {
        status: "not_proven",
        reasonCode: "complete_writer_view_unsupported",
      },
      provider: {
        status: "not_checked",
        reasonCode: "provider_state_outside_postgresql",
      },
    },
    provider: driver === "s3"
      ? {
          driver: "s3",
          status: "ready",
          code: "storage.multipart_quiescent",
          readOnly: true,
        }
      : {
          driver: "local",
          status: "not_applicable",
          code: "provider_not_applicable",
          readOnly: true,
        },
  };
}

function blockedReport() {
  const report = readyReport("local");
  report.status = "blocked";
  report.snapshot.ready = false;
  report.snapshot.counts.uploads.reserved = 1;
  report.snapshot.blockers = [{ code: "upload_reserved", count: 1 }];
  report.provider = {
    driver: "unknown",
    status: "not_checked",
    code: "database_not_ready",
    readOnly: true,
  };
  return report;
}

function providerBlockedReport() {
  const report = readyReport("s3");
  report.status = "blocked";
  report.errorCode = "provider_not_quiescent";
  report.provider = {
    driver: "s3",
    status: "blocked",
    code: "storage.multipart_not_quiescent",
    readOnly: true,
  };
  return report;
}

function postgresContainer() {
  return {
    Id: postgresID,
    Config: {
      Labels: {
        "com.docker.compose.project": project,
        "com.docker.compose.service": "postgres",
      },
    },
    NetworkSettings: {
      Networks: {
        [networkName]: { NetworkID: networkID },
      },
    },
  };
}

function network() {
  return {
    Id: networkID,
    Name: networkName,
    Driver: "bridge",
    Labels: {
      "com.docker.compose.project": project,
      "com.docker.compose.network": "private",
    },
    Containers: {
      [postgresID]: { Name: "postgres" },
    },
  };
}

function ownedContainer(mode, environment, secretPath) {
  const image = mode === "wrong-image" ? `sha256:${"c".repeat(64)}` : workspaceImage;
  const labels = {
    [RELEASE_RUN_LABEL]: mode === "foreign-container" ? "d".repeat(64) : runID,
    "com.docker.compose.project": project,
    "com.docker.compose.service": RELEASE_CHECK_SERVICE,
  };
  const env = Object.entries(environment).map(([key, value]) =>
    `${key}=${value.replaceAll("$$", "$")}`,
  );
  if (mode === "duplicate-env") env.push(env[0]);
  if (mode === "unsupported-env") env.push("PGOPTIONS=-c search_path=public");
  env.push(
    `DUALLANE_MIGRATIONS_DIR=${mode === "asset-env-drift" ? "/wrong" : "/app/migrations"}`,
    "DUALLANE_EMOTE_CATALOG_PATH=/app/assets/emote-packs.json",
    "DUALLANE_ECHO_RELEASE_CATALOG_PATH=/app/assets/echo-release-guides.json",
  );
  return {
    Id: ownedID,
    Image: image,
    Config: {
      Image: image,
      User: RELEASE_CHECK_USER,
      Entrypoint: [RELEASE_CHECK_ENTRYPOINT],
      Cmd: [...RELEASE_CHECK_COMMAND],
      Labels: labels,
      Env: env,
    },
    HostConfig: {
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      RestartPolicy: { Name: "no" },
      PortBindings: null,
      NetworkMode: networkName,
    },
    Mounts: mode === "s3" || mode === "provider-blocked" || mode === "secret-source-mismatch"
      ? [{
          Type: "bind",
          Source: mode === "secret-source-mismatch"
            ? path.join(path.dirname(secretPath), "wrong-s3-credentials.json")
            : secretPath,
          Destination: "/run/secrets/workspace-s3",
          RW: false,
          Mode: "ro",
        }]
      : [],
    NetworkSettings: {
      Networks: {
        [networkName]: {
          NetworkID: mode === "created-empty-network" || mode === "running-empty-network"
            ? ""
            : networkID,
          EndpointID: "",
        },
      },
    },
    State: { Status: "created", Running: mode === "already-started" },
  };
}

function createFakeRunner({ mode = "happy", environment = {}, secretPath } = {}) {
  let created = false;
  const calls = [];
  const container = ownedContainer(mode, environment, secretPath);
  const report = mode === "blocked"
    ? blockedReport()
    : mode === "provider-blocked"
      ? providerBlockedReport()
      : readyReport(mode === "s3" ? "s3" : "local");
  const runner = {
    calls,
    removed: false,
    async run(args, options) {
      calls.push({ args: [...args], options: { ...options } });
      if (args[0] === "image" && args[1] === "inspect") {
        if (mode === "missing-image") return { status: 1, stdout: "" };
        return { status: 0, stdout: `${workspaceImage}\n` };
      }
      if (args[0] === "network" && args[1] === "inspect") {
        if (mode === "missing-network") return { status: 1, stdout: "" };
        return { status: 0, stdout: JSON.stringify([network()]) };
      }
      if (args[0] === "inspect") {
        const id = args.at(-1);
        if (id === postgresID) {
          return { status: 0, stdout: JSON.stringify([postgresContainer()]) };
        }
        if (id === ownedID) {
          return { status: 0, stdout: JSON.stringify([container]) };
        }
        return { status: 1, stdout: "" };
      }
      if (args[0] === "compose") {
        const operation = args.includes("create") ? "create" : args.includes("ps") ? "ps" : "";
        const service = args.at(-1);
        if (operation === "ps" && service === "postgres") {
          return { status: 0, stdout: `${postgresID}\n` };
        }
        if (operation === "ps" && service === RELEASE_CHECK_SERVICE) {
          if (mode === "existing") return { status: 0, stdout: `${ownedID}\n` };
          if (mode === "ambiguous-created" && created) {
            return { status: 0, stdout: `${ownedID}\n${"4".repeat(64)}\n` };
          }
          return { status: 0, stdout: created ? `${ownedID}\n` : "" };
        }
        if (operation === "create") {
          if (mode === "create-fail") return { status: 1, stdout: "" };
          created = true;
          return { status: 0, stdout: "" };
        }
        throw new Error(`unexpected compose operation ${operation}`);
      }
      if (args[0] === "start") {
        if (mode === "start-fail") return { status: 1, stdout: "" };
        container.State.Status = mode === "created-empty-network" ? "exited" : "running";
        if (mode === "running-empty-network") {
          container.NetworkSettings.Networks[networkName].NetworkID = "";
        }
        return { status: 0, stdout: `${ownedID}\n` };
      }
      if (args[0] === "wait") {
        if (mode === "timeout") return { status: null, stdout: "", timedOut: true };
        const exitCode = mode === "blocked" || mode === "provider-blocked"
          ? 2
          : mode === "failed"
            ? 1
            : 0;
        return { status: 0, stdout: `${exitCode}\n` };
      }
      if (args[0] === "logs") {
        if (mode === "logs-oversize") {
          return { status: 0, stdout: "x".repeat(MAX_DOCKER_OUTPUT_BYTES + 1) };
        }
        return { status: 0, stdout: JSON.stringify(report) };
      }
      if (args[0] === "rm") {
        runner.removed = true;
        return { status: 0, stdout: "" };
      }
      throw new Error(`unexpected Docker operation ${args[0]}`);
    },
  };
  return runner;
}

function s3Compose(secretPath) {
  const compose = validCompose();
  compose.services.workspace.environment = {
    ...compose.services.workspace.environment,
    WORKSPACE_STORAGE_DRIVER: "s3",
    WORKSPACE_S3_ENDPOINT: "http://minio.synthetic:9000",
    WORKSPACE_S3_BUCKET: "duallane",
    WORKSPACE_S3_REGION: "us-east-1",
    WORKSPACE_S3_CREDENTIALS_FILE: "/run/secrets/workspace-s3",
  };
  compose.services.workspace.secrets = [{ source: "workspace-s3", target: "workspace-s3", mode: "0600" }];
  compose.secrets = { "workspace-s3": { file: secretPath } };
  return compose;
}

async function fixture(t, mode = "happy") {
  if (process.platform !== "linux") {
    t.skip("release-run private-file and Docker identity tests run on Linux");
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "duallane-release-run-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const composePath = path.join(directory, "canonical.json");
  const outputPath = path.join(directory, "generated.json");
  const reportPath = path.join(directory, "report.json");
  const secretPath = path.join(directory, "s3-credentials.json");
  const compose = mode === "s3" || mode === "provider-blocked" || mode === "secret-source-mismatch"
    ? s3Compose(secretPath)
    : validCompose();
  if (mode === "dollar-env") {
    const environment = compose.services.workspace.environment;
    for (const key of ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD"]) {
      delete environment[key];
    }
    environment.DATABASE_URL = "postgres://duallane:synthetic$$password@postgres:5432/duallane";
  }
  if (mode === "s3" || mode === "provider-blocked" || mode === "secret-source-mismatch") {
    await writeFile(secretPath, "synthetic-secret", { mode: 0o600 });
    await chmod(secretPath, 0o600);
  }
  await writeFile(composePath, `${JSON.stringify(compose)}\n`, { mode: 0o600 });
  await chmod(composePath, 0o600);
  const generated = buildDrainCompose({ compose, workspaceImage });
  const dockerRunner = createFakeRunner({
    mode,
    environment: generated.services[RELEASE_CHECK_SERVICE].environment,
    secretPath,
  });
  return {
    directory,
    composePath,
    outputPath,
    reportPath,
    dockerRunner,
    options: {
      composePath,
      outputPath,
      reportPath,
      workspaceImage,
      runID,
      dockerRunner,
    },
  };
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => error?.code === code);
}

function command(args) {
  return spawnSync(process.execPath, [helper, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 128 * 1024,
    windowsHide: true,
    env: { ...process.env },
  });
}

test("runDrainCheck creates, validates, observes, writes, and removes one owned container", async (t) => {
  const state = await fixture(t);
  const result = await runDrainCheck(state.options);
  assert.deepEqual(result, { status: "ready", exitCode: 0, reportWritten: true });
  assert.equal(state.dockerRunner.removed, true);
  const generated = JSON.parse(await readFile(state.outputPath, "utf8"));
  assert.deepEqual(generated.services[RELEASE_CHECK_SERVICE].labels, {
    [RELEASE_RUN_LABEL]: runID,
  });
  assert.deepEqual(JSON.parse(await readFile(state.reportPath, "utf8")), readyReport());
  const dockerArgs = state.dockerRunner.calls.map((call) => call.args.join(" "));
  assert.equal(dockerArgs.some((value) => value.includes(" network create ")), false);
  assert.equal(dockerArgs.some((value) => value.includes(" compose down")), false);
  assert.equal(dockerArgs.some((value) => value.includes(" compose start")), false);
});

test("runDrainCheck writes a safe blocked report and returns exit status 2", async (t) => {
  const state = await fixture(t, "blocked");
  const result = await runDrainCheck(state.options);
  assert.deepEqual(result, { status: "blocked", exitCode: 2, reportWritten: true });
  assert.deepEqual(JSON.parse(await readFile(state.reportPath, "utf8")), blockedReport());
  assert.equal(state.dockerRunner.removed, true);
});

test("provider multipart blocking is accepted only as the S3 blocked report shape", async (t) => {
  const state = await fixture(t, "provider-blocked");
  const result = await runDrainCheck(state.options);
  assert.deepEqual(result, { status: "blocked", exitCode: 2, reportWritten: true });
  assert.deepEqual(JSON.parse(await readFile(state.reportPath, "utf8")), providerBlockedReport());
  assert.equal(state.dockerRunner.removed, true);
});

test("S3 authority keeps its one credential mount read-only and rejects other mounts", async (t) => {
  const state = await fixture(t, "s3");
  const result = await runDrainCheck(state.options);
  assert.deepEqual(result, { status: "ready", exitCode: 0, reportWritten: true });
  const generated = JSON.parse(await readFile(state.outputPath, "utf8"));
  assert.deepEqual(generated.services[RELEASE_CHECK_SERVICE].secrets, [
    { source: "workspace-s3", target: "workspace-s3", mode: "0600" },
  ]);
  assert.equal(state.dockerRunner.removed, true);
});

test("container env accepts exactly one Compose dollar decoding layer", async (t) => {
  const state = await fixture(t, "dollar-env");
  const result = await runDrainCheck(state.options);
  assert.deepEqual(result, { status: "ready", exitCode: 0, reportWritten: true });
});

test("the fixed runtime asset environment is accepted only at its baked-in values", async (t) => {
  const state = await fixture(t, "asset-env-drift");
  await expectCode(runDrainCheck(state.options), "container_environment_unsupported");
  assert.equal(state.dockerRunner.removed, true);
  const dockerfile = await readFile(path.join(root, "Dockerfile.workspace"), "utf8");
  assert.match(dockerfile, /DUALLANE_MIGRATIONS_DIR=\/app\/migrations/);
  assert.match(dockerfile, /DUALLANE_EMOTE_CATALOG_PATH=\/app\/assets\/emote-packs\.json/);
  assert.match(dockerfile, /DUALLANE_ECHO_RELEASE_CATALOG_PATH=\/app\/assets\/echo-release-guides\.json/);
});

test("a checker that has already started is rejected before this runner starts it", async (t) => {
  const state = await fixture(t, "already-started");
  await expectCode(runDrainCheck(state.options), "container_already_started");
  assert.equal(state.dockerRunner.calls.some(call => call.args[0] === "start"), false);
  assert.equal(state.dockerRunner.removed, true);
});

test("secret bind source must be the generated canonical file", async (t) => {
  const state = await fixture(t, "secret-source-mismatch");
  await expectCode(runDrainCheck(state.options), "container_mount_source_mismatch");
  assert.equal(state.dockerRunner.removed, true);
});

test("duplicate or unsupported image authority env fails closed", async (t) => {
  const duplicate = await fixture(t, "duplicate-env");
  await expectCode(runDrainCheck(duplicate.options), "container_environment_duplicate");
  assert.equal(duplicate.dockerRunner.removed, true);

  const unsupported = await fixture(t, "unsupported-env");
  await expectCode(runDrainCheck(unsupported.options), "container_environment_unsupported");
  assert.equal(unsupported.dockerRunner.removed, true);
});

test("created containers may have empty endpoint ids only with an exact pinned network", async (t) => {
  const state = await fixture(t, "created-empty-network");
  const result = await runDrainCheck(state.options);
  assert.deepEqual(result, { status: "ready", exitCode: 0, reportWritten: true });
});

test("a running container with an empty network id is rejected", async (t) => {
  const state = await fixture(t, "running-empty-network");
  await expectCode(runDrainCheck(state.options), "container_networks_mismatch");
  assert.equal(state.dockerRunner.removed, true);
});

test("nonzero checker exit fails closed without accepting logs as a report", async (t) => {
  const state = await fixture(t, "failed");
  await expectCode(runDrainCheck(state.options), "checker_failed");
  assert.equal(state.dockerRunner.removed, true);
  assert.equal(state.dockerRunner.calls.some((call) => call.args[0] === "logs"), false);
});

test("missing network is rejected before Compose create", async (t) => {
  const state = await fixture(t, "missing-network");
  await expectCode(runDrainCheck(state.options), "network_inspect_failed");
  assert.equal(state.dockerRunner.calls.some((call) => call.args.includes("create")), false);
  assert.equal(state.dockerRunner.removed, false);
});

test("an existing fixed release-check service blocks before create", async (t) => {
  const state = await fixture(t, "existing");
  await expectCode(runDrainCheck(state.options), "owned_compose_exists");
  assert.equal(state.dockerRunner.calls.some((call) => call.args.includes("create")), false);
  assert.equal(state.dockerRunner.removed, false);
});

test("ambiguous creation is fail-closed and does not guess a container to remove", async (t) => {
  const state = await fixture(t, "ambiguous-created");
  await expectCode(runDrainCheck(state.options), "created_container_ambiguous");
  assert.equal(state.dockerRunner.removed, false);
});

test("foreign run label is never removed", async (t) => {
  const state = await fixture(t, "foreign-container");
  await expectCode(runDrainCheck(state.options), "cleanup_identity_unverified");
  assert.equal(state.dockerRunner.removed, false);
});

test("wrong image is never removed even when the container id is known", async (t) => {
  const state = await fixture(t, "wrong-image");
  await expectCode(runDrainCheck(state.options), "cleanup_identity_unverified");
  assert.equal(state.dockerRunner.removed, false);
});

test("start failure still cleans only the strongly identified container", async (t) => {
  const state = await fixture(t, "start-fail");
  await expectCode(runDrainCheck(state.options), "container_start_failed");
  assert.equal(state.dockerRunner.removed, true);
});

test("wait timeout still cleans only the strongly identified container", async (t) => {
  const state = await fixture(t, "timeout");
  await expectCode(runDrainCheck(state.options), "checker_wait_timeout");
  assert.equal(state.dockerRunner.removed, true);
  const waitCall = state.dockerRunner.calls.find((call) => call.args[0] === "wait");
  assert.equal(waitCall.options.timeoutMs, 20_000);
  assert.equal(waitCall.options.maxOutputBytes, 64 * 1024);
});

test("oversized checker logs fail closed while still cleaning the owned id", async (t) => {
  const state = await fixture(t, "logs-oversize");
  await expectCode(runDrainCheck(state.options), "docker_output_too_large");
  assert.equal(state.dockerRunner.removed, true);
});

test("cleanup is ordered after wait/report processing and uses exact id only", async (t) => {
  const state = await fixture(t);
  await runDrainCheck(state.options);
  const operations = state.dockerRunner.calls.map((call) => call.args[0] === "compose"
    ? call.args.slice(0, 2).join(":")
    : call.args[0]);
  const waitIndex = operations.indexOf("wait");
  const logsIndex = operations.indexOf("logs");
  const cleanupInspectIndex = operations.lastIndexOf("inspect");
  const removeIndex = operations.indexOf("rm");
  assert.ok(waitIndex >= 0 && logsIndex > waitIndex);
  assert.ok(cleanupInspectIndex > logsIndex && removeIndex > cleanupInspectIndex);
  const remove = state.dockerRunner.calls[removeIndex];
  assert.deepEqual(remove.args, ["rm", "--force", ownedID]);
});

test("image absence is checked before any Compose or network operation", async (t) => {
  const state = await fixture(t, "missing-image");
  await expectCode(runDrainCheck(state.options), "image_unavailable");
  assert.deepEqual(state.dockerRunner.calls.map((call) => call.args[0]), ["image"]);
});

test("CLI help is bounded and does not contact Docker", () => {
  const result = command(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /release-drain-run\.mjs run/);
  assert.equal(result.stderr, "");
});

test("the real Docker runner bounds child output and execution time", async () => {
  const runner = createDockerRunner({ binary: process.execPath });
  await assert.rejects(
    runner.run(["-e", `process.stdout.write("x".repeat(${MAX_DOCKER_OUTPUT_BYTES + 1}))`]),
    (error) => error?.code === "docker_output_too_large",
  );
  await assert.rejects(
    runner.run(["-e", "setTimeout(() => {}, 1000)"], { timeoutMs: 25 }),
    (error) => error?.code === "docker_timeout",
  );
});
