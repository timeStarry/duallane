import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { runDrainCheck } from "../../deploy/production/release-drain-run.mjs";
import {
  readPrivateJSON,
  validateReport,
  writePrivateJSON,
} from "../../deploy/production/release-drain-config.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const goImage = String(process.env.DUALLANE_DRAIN_TEST_IMAGE ?? "").trim();
const postgresImage = String(
  process.env.DUALLANE_DRAIN_TEST_POSTGRES_IMAGE ?? "",
).trim();
const imageIDPattern = /^sha256:[0-9a-f]{64}$/u;
const containerIDPattern = /^[0-9a-f]{64}$/u;
const containerReferencePattern = /^[0-9a-f]{12,64}$/u;
const ownerLabel = "com.duallane.release-drain-docker-test";
const caseLabel = "com.duallane.release-drain-docker-case";
const commandTimeoutMs = 10_000;
const migrationTimeoutMs = 60_000;
const postgresReadyTimeoutMs = 30_000;
const maxDockerOutputBytes = 64 * 1024;

class DockerGateError extends Error {
  constructor(code) {
    super(code);
    this.name = "DockerGateError";
    this.code = code;
  }
}

function fail(code) {
  throw new DockerGateError(code);
}

function validateImage(value, name) {
  if (!imageIDPattern.test(String(value ?? ""))) {
    throw new Error(`${name} must be an exact local sha256 image ID`);
  }
  return value;
}

function runDocker(args, timeoutMs = commandTimeoutMs) {
  if (!Array.isArray(args) || args.some((value) => typeof value !== "string")) {
    fail("docker_arguments_invalid");
  }
  const result = spawnSync("docker", args, {
    cwd: repoRoot,
    env: { ...process.env, COMPOSE_DISABLE_ENV_FILE: "1" },
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: maxDockerOutputBytes,
    windowsHide: true,
  });
  if (result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM") {
    fail("docker_timeout");
  }
  if (result.error) fail("docker_unavailable");
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  if (
    Buffer.byteLength(stdout, "utf8") > maxDockerOutputBytes ||
    Buffer.byteLength(stderr, "utf8") > maxDockerOutputBytes
  ) {
    fail("docker_output_too_large");
  }
  return { status: result.status, stdout, stderr };
}

function requireSuccess(result, code) {
  if (!result || result.status !== 0) fail(code);
  return result.stdout;
}

function oneLine(result, code) {
  const source = requireSuccess(result, code).trim();
  const lines = source.split(/\r?\n/u).filter(Boolean);
  if (lines.length !== 1) fail(`${code}_invalid`);
  return lines[0];
}

function composeServiceIDs(project, composePath, service) {
  const result = runDocker([
    "compose",
    "--project-name",
    project,
    "--file",
    composePath,
    "ps",
    "--all",
    "--quiet",
    service,
  ]);
  const source = requireSuccess(result, "compose_ps_failed").trim();
  const ids = source === "" ? [] : source.split(/\s+/u);
  if (ids.some((id) => !containerReferencePattern.test(id))) {
    fail("compose_ps_invalid");
  }
  return ids;
}

function inspectJSON(result, code) {
  const source = requireSuccess(result, code).trim();
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    fail(`${code}_invalid`);
  }
  if (!Array.isArray(value) || value.length !== 1 || !value[0] || typeof value[0] !== "object") {
    fail(`${code}_invalid`);
  }
  return value[0];
}

function inspectImage(image) {
  const actual = oneLine(
    runDocker(["image", "inspect", "--format", "{{.Id}}", image]),
    "image_inspect_failed",
  );
  if (actual !== image) fail("image_identity_mismatch");
}

function inspectContainer(id) {
  if (!containerReferencePattern.test(id)) fail("container_id_invalid");
  const container = inspectJSON(
    runDocker(["container", "inspect", id]),
    "container_inspect_failed",
  );
  if (!containerIDPattern.test(container.Id)) fail("container_id_invalid");
  return container;
}

function inspectNetwork(id) {
  return inspectJSON(
    runDocker(["network", "inspect", id]),
    "network_inspect_failed",
  );
}

function inspectVolume(name) {
  return inspectJSON(
    runDocker(["volume", "inspect", name]),
    "volume_inspect_failed",
  );
}

function assertLabels(value, expected) {
  const labels = value && typeof value === "object" ? value : null;
  assert.ok(labels, "owned Docker object labels are missing");
  for (const [key, expectedValue] of Object.entries(expected)) {
    assert.equal(labels[key], expectedValue, `owned Docker object label ${key} changed`);
  }
}

function assertImageIdentity(container, expectedImage) {
  assert.equal(container.Image, expectedImage, "container image ID changed");
  assert.equal(container.Config?.Image, expectedImage, "container configured image changed");
}

function assertNetworkBinding(
  container,
  networkName,
  networkID,
  { allowEmptyCreated = false, allowEmptyStopped = false } = {},
) {
  const networks = container.NetworkSettings?.Networks;
  assert.ok(networks && typeof networks === "object", "container network metadata is missing");
  assert.deepEqual(Object.keys(networks), [networkName], "owned container has an unexpected network");
  const binding = networks[networkName];
  assert.ok(binding && typeof binding === "object", "owned container network binding is missing");
  const emptyIDAllowed =
    binding.NetworkID === "" &&
    ((allowEmptyCreated && container.State?.Status === "created") ||
      (allowEmptyStopped && (container.State?.Status === "exited" || container.State?.Status === "dead")));
  if (emptyIDAllowed) {
    assert.equal(container.HostConfig?.NetworkMode, networkName, "empty network id lost its pinned mode");
    return;
  }
  if (binding.NetworkID !== networkID) {
    assert.fail("owned container network changed");
  }
}

function assertOwnedContainer(container, {
  runID,
  project,
  service,
  image,
  networkName,
  networkID,
  allowEmptyCreated = false,
  allowEmptyStopped = false,
}) {
  assert.match(container.Id, containerIDPattern);
  assertImageIdentity(container, image);
  assertLabels(container.Config?.Labels, {
    [ownerLabel]: runID,
    [caseLabel]: project,
    "com.docker.compose.project": project,
    "com.docker.compose.service": service,
  });
  assertNetworkBinding(container, networkName, networkID, { allowEmptyCreated, allowEmptyStopped });
}

function assertOwnedNetwork(network, { runID, project, networkName, requireEmpty }) {
  assert.match(network.Id, containerIDPattern);
  assert.equal(network.Name, networkName);
  assert.equal(network.Driver, "bridge");
  assertLabels(network.Labels, {
    [ownerLabel]: runID,
    [caseLabel]: project,
    "com.docker.compose.project": project,
    "com.docker.compose.network": "private",
  });
  const containers = network.Containers && typeof network.Containers === "object"
    ? network.Containers
    : {};
  if (requireEmpty) assert.equal(Object.keys(containers).length, 0, "owned network still has attachments");
}

function assertOwnedVolume(volume, { runID, project, volumeName, requireUnused }) {
  assert.equal(volume.Name, volumeName);
  assert.equal(volume.Driver, "local");
  assertLabels(volume.Labels, {
    [ownerLabel]: runID,
    [caseLabel]: project,
    "com.docker.compose.project": project,
  });
  if (requireUnused && volume.UsageData?.RefCount !== undefined) {
    assert.equal(volume.UsageData.RefCount, 0, "owned volume is still referenced");
  }
}

function assertNoNamedObject(kind, name) {
  const result = runDocker([kind, "inspect", name]);
  if (result.status === 0) fail(`${kind}_already_exists`);
}

function createNetwork({ runID, project, networkName }) {
  const id = oneLine(
    runDocker([
      "network",
      "create",
      "--driver",
      "bridge",
      "--label",
      `${ownerLabel}=${runID}`,
      "--label",
      `${caseLabel}=${project}`,
      "--label",
      `com.docker.compose.project=${project}`,
      "--label",
      "com.docker.compose.network=private",
      networkName,
    ]),
    "network_create_failed",
  );
  if (!containerIDPattern.test(id)) fail("network_id_invalid");
  return id;
}

function createVolume({ runID, project, volumeName }) {
  const created = oneLine(
    runDocker([
      "volume",
      "create",
      "--label",
      `${ownerLabel}=${runID}`,
      "--label",
      `${caseLabel}=${project}`,
      "--label",
      `com.docker.compose.project=${project}`,
      volumeName,
    ]),
    "volume_create_failed",
  );
  if (created !== volumeName) fail("volume_identity_mismatch");
  return volumeName;
}

function createPostgres({
  project,
  composePath,
}) {
  const create = runDocker([
    "compose",
    "--project-name",
    project,
    "--file",
    composePath,
    "create",
    "--pull",
    "never",
    "--no-build",
    "postgres",
  ]);
  requireSuccess(create, "postgres_compose_create_failed");
  const references = composeServiceIDs(project, composePath, "postgres");
  if (references.length !== 1) fail("postgres_compose_ps_count_invalid");
  if (!containerReferencePattern.test(references[0])) fail("postgres_compose_ps_invalid");
  return references[0];
}

function createMigration({
  runID,
  project,
  containerName,
  networkName,
  postgresDatabase,
  postgresUser,
  postgresPassword,
}) {
  const id = oneLine(
    runDocker([
      "container",
      "create",
      "--pull=never",
      "--name",
      containerName,
      "--label",
      `${ownerLabel}=${runID}`,
      "--label",
      `${caseLabel}=${project}`,
      "--label",
      `com.docker.compose.project=${project}`,
      "--label",
      "com.docker.compose.service=migrate",
      "--label",
      "com.docker.compose.oneoff=False",
      "--label",
      "com.docker.compose.container-number=1",
      "--user",
      "65532:65532",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--network",
      networkName,
      "--env",
      "DUALLANE_MIGRATIONS_DIR=/app/migrations",
      "--env",
      "PGHOST=postgres",
      "--env",
      "PGPORT=5432",
      "--env",
      `PGDATABASE=${postgresDatabase}`,
      "--env",
      `PGUSER=${postgresUser}`,
      "--env",
      `PGPASSWORD=${postgresPassword}`,
      "--entrypoint",
      "/usr/local/bin/duallane-migrate",
      goImage,
    ]),
    "migration_create_failed",
  );
  if (!containerIDPattern.test(id)) fail("migration_id_invalid");
  return id;
}

function startContainer(id, code) {
  requireSuccess(runDocker(["container", "start", id]), code);
}

function waitContainer(id, timeoutMs, code) {
  const value = oneLine(
    runDocker(["container", "wait", id], timeoutMs),
    code,
  );
  if (!/^(?:0|[1-9][0-9]{0,2})$/u.test(value) || Number(value) > 255) {
    fail(`${code}_invalid`);
  }
  return Number(value);
}

async function waitForPostgres(containerID, postgresUser, postgresDatabase) {
  const deadline = Date.now() + postgresReadyTimeoutMs;
  while (Date.now() < deadline) {
    const result = runDocker([
      "exec",
      containerID,
      "pg_isready",
      // The image starts a Unix-only bootstrap server while initializing.
      // Require the final TCP listener that the migration container uses.
      "-h",
      "127.0.0.1",
      "-U",
      postgresUser,
      "-d",
      postgresDatabase,
    ], 5_000);
    if (result.status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  fail("postgres_not_ready");
}

function removeOwnedContainer(id, expected) {
  const container = inspectContainer(id);
  assertOwnedContainer(container, expected);
  requireSuccess(runDocker(["container", "rm", "--force", id]), "container_remove_failed");
  const remaining = runDocker(["container", "inspect", id]);
  if (remaining.status === 0) fail("container_remove_incomplete");
}

function removeOwnedVolume(volumeName, expected) {
  const volume = inspectVolume(volumeName);
  assertOwnedVolume(volume, { ...expected, requireUnused: true });
  requireSuccess(runDocker(["volume", "rm", volumeName]), "volume_remove_failed");
  if (runDocker(["volume", "inspect", volumeName]).status === 0) {
    fail("volume_remove_incomplete");
  }
}

function removeOwnedNetwork(networkID, expected) {
  const network = inspectNetwork(networkID);
  assertOwnedNetwork(network, { ...expected, requireEmpty: true });
  requireSuccess(runDocker(["network", "rm", networkID]), "network_remove_failed");
  if (runDocker(["network", "inspect", networkID]).status === 0) {
    fail("network_remove_incomplete");
  }
}

function assertNoReleaseCheckContainer(project) {
  const result = runDocker([
    "container",
    "ls",
    "--all",
    "--filter",
    `label=com.docker.compose.project=${project}`,
    "--filter",
    "label=com.docker.compose.service=release-check",
    "--format",
    "{{.ID}}",
  ]);
  if (result.status !== 0) fail("release_check_cleanup_lookup_failed");
  if (result.stdout.trim() !== "") fail("release_check_container_remained");
}

function canonicalCompose({
  project,
  runID,
  networkName,
  volumeName,
  postgresDatabase,
  postgresUser,
  postgresPassword,
}) {
  const workspaceEnvironment = {
    PGHOST: "postgres",
    PGPORT: "5432",
    PGDATABASE: postgresDatabase,
    PGUSER: postgresUser,
    PGPASSWORD: postgresPassword,
    WORKSPACE_STORAGE_DRIVER: "local",
  };
  const sharedService = {
    image: goImage,
    user: "65532:65532",
    environment: workspaceEnvironment,
    networks: { private: {} },
  };
  return {
    name: project,
    services: {
      postgres: {
        image: postgresImage,
        labels: {
          [ownerLabel]: runID,
          [caseLabel]: project,
        },
        environment: {
          POSTGRES_DB: postgresDatabase,
          POSTGRES_USER: postgresUser,
          POSTGRES_PASSWORD: postgresPassword,
        },
        networks: { private: {} },
        volumes: [{
          type: "volume",
          source: volumeName,
          target: "/var/lib/postgresql/data",
        }],
      },
      workspace: sharedService,
      worker: { ...sharedService },
      migrate: { ...sharedService },
    },
    networks: {
      private: { name: networkName, external: true },
    },
    volumes: {
      [volumeName]: { name: volumeName, external: true },
    },
  };
}

function assertReadyReport(report) {
  assert.equal(report.status, "ready");
  assert.equal(report.scope, "database_and_provider_snapshot");
  assert.equal(report.snapshot?.ready, true);
  assert.equal(report.snapshot?.readOnly, true);
  assert.deepEqual(report.snapshot?.blockers, []);
  assert.equal(report.snapshot?.writers?.status, "not_proven");
  assert.equal(report.snapshot?.provider?.status, "not_checked");
  assert.deepEqual(report.provider, {
    driver: "local",
    status: "not_applicable",
    code: "provider_not_applicable",
    readOnly: true,
  });
  assert.equal(validateReport(report, "local"), report);
}

async function cleanupResources(resources) {
  const errors = [];
  const attempt = async (callback) => {
    try {
      await callback();
    } catch (error) {
      errors.push(error);
    }
  };

  if (resources.migrationID) {
    await attempt(() => removeOwnedContainer(resources.migrationID, {
      ...resources.migrationExpected,
      allowEmptyCreated: true,
      allowEmptyStopped: true,
    }));
  }
  if (resources.postgresID) {
    await attempt(() => removeOwnedContainer(resources.postgresID, {
      ...resources.postgresExpected,
      allowEmptyCreated: true,
      allowEmptyStopped: true,
    }));
  }
  if (resources.volumeName) {
    await attempt(() => removeOwnedVolume(resources.volumeName, resources.volumeExpected));
  }
  if (resources.networkID) {
    await attempt(() => removeOwnedNetwork(resources.networkID, resources.networkExpected));
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "release drain Docker fixture cleanup failed");
  }
}

test("release-drain Docker gate requires exact image IDs without contacting Docker", () => {
  assert.throws(
    () => validateImage("duallane-workspace:latest", "DUALLANE_DRAIN_TEST_IMAGE"),
    /exact local sha256 image ID/u,
  );
  assert.throws(
    () => validateImage(`sha256:${"A".repeat(64)}`, "DUALLANE_DRAIN_TEST_POSTGRES_IMAGE"),
    /exact local sha256 image ID/u,
  );
});

test("release-drain real Docker gate migrates and observes an isolated PostgreSQL stack", {
  skip: goImage && postgresImage
    ? false
    : "set DUALLANE_DRAIN_TEST_IMAGE and DUALLANE_DRAIN_TEST_POSTGRES_IMAGE to exact local sha256 IDs",
  timeout: 180_000,
}, async (t) => {
  if (process.platform !== "linux") {
    t.skip("the disposable Docker gate is Linux-only");
    return;
  }
  validateImage(goImage, "DUALLANE_DRAIN_TEST_IMAGE");
  validateImage(postgresImage, "DUALLANE_DRAIN_TEST_POSTGRES_IMAGE");

  const runID = randomBytes(32).toString("hex");
  const taskUUID = randomUUID().replaceAll("-", "");
  const project = `duallane-drain-${taskUUID}`;
  const networkName = `${project}-private`;
  const volumeName = `${project}-pg`;
  const migrationContainerName = `${project}-migrate`;
  const postgresDatabase = "duallane";
  const postgresUser = "duallane";
  const postgresPassword = "duallane-drain-synthetic-password";
  const directory = await mkdtemp(path.join(os.tmpdir(), "duallane-release-drain-docker-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const composePath = path.join(directory, "canonical.json");
  const generatedPath = path.join(directory, "generated.json");
  const reportPath = path.join(directory, "report.json");
  const compose = canonicalCompose({
    project,
    runID,
    networkName,
    volumeName,
    postgresDatabase,
    postgresUser,
    postgresPassword,
  });
  const resources = {
    networkID: null,
    volumeName: null,
    postgresID: null,
    migrationID: null,
    networkExpected: { runID, project, networkName },
    volumeExpected: { runID, project, volumeName },
    postgresExpected: {
      runID,
      project,
      service: "postgres",
      image: postgresImage,
      networkName,
      networkID: null,
    },
    migrationExpected: {
      runID,
      project,
      service: "migrate",
      image: goImage,
      networkName,
      networkID: null,
    },
  };
  let primaryError;
  try {
    inspectImage(goImage);
    inspectImage(postgresImage);
    assertNoNamedObject("network", networkName);
    assertNoNamedObject("volume", volumeName);
    assertNoNamedObject("container", migrationContainerName);

    resources.networkID = createNetwork({ runID, project, networkName });
    assertOwnedNetwork(
      inspectNetwork(resources.networkID),
      { runID, project, networkName, requireEmpty: false },
    );
    resources.volumeName = createVolume({ runID, project, volumeName });
    assertOwnedVolume(inspectVolume(resources.volumeName), {
      runID,
      project,
      volumeName,
      requireUnused: true,
    });

    await writePrivateJSON(composePath, compose);
    if (composeServiceIDs(project, composePath, "postgres").length !== 0) {
      fail("postgres_compose_exists");
    }
    resources.postgresID = createPostgres({
      project,
      composePath,
    });
    resources.postgresExpected.networkID = resources.networkID;
    const postgres = inspectContainer(resources.postgresID);
    resources.postgresID = postgres.Id;
    assertOwnedContainer(postgres, {
      ...resources.postgresExpected,
      allowEmptyCreated: true,
    });
    const postgresMounts = postgres.Mounts;
    assert.ok(
      Array.isArray(postgresMounts) && postgresMounts.length === 1,
      "PostgreSQL must have one data volume",
    );
    assert.equal(postgresMounts[0].Type, "volume");
    assert.equal(postgresMounts[0].Name, volumeName);
    assert.equal(postgresMounts[0].Destination, "/var/lib/postgresql/data");
    assert.equal(postgresMounts[0].RW, true);
    assert.equal(postgres.State?.Status, "created");

    startContainer(resources.postgresID, "postgres_start_failed");
    await waitForPostgres(resources.postgresID, postgresUser, postgresDatabase);
    assertOwnedContainer(inspectContainer(resources.postgresID), resources.postgresExpected);

    resources.migrationID = createMigration({
      runID,
      project,
      containerName: migrationContainerName,
      networkName,
      postgresDatabase,
      postgresUser,
      postgresPassword,
    });
    resources.migrationExpected.networkID = resources.networkID;
    const migration = inspectContainer(resources.migrationID);
    assertOwnedContainer(migration, {
      ...resources.migrationExpected,
      allowEmptyCreated: true,
    });
    assert.equal(migration.Config?.User, "65532:65532");
    assert.deepEqual(migration.Config?.Entrypoint, ["/usr/local/bin/duallane-migrate"]);
    assert.deepEqual(migration.Mounts ?? [], []);
    startContainer(resources.migrationID, "migration_start_failed");
    const migrationExit = waitContainer(
      resources.migrationID,
      migrationTimeoutMs,
      "migration_wait_failed",
    );
    assert.equal(migrationExit, 0, "canonical Go migration must succeed");
    removeOwnedContainer(resources.migrationID, {
      ...resources.migrationExpected,
      allowEmptyCreated: true,
      allowEmptyStopped: true,
    });
    resources.migrationID = null;

    const result = await runDrainCheck({
      composePath,
      outputPath: generatedPath,
      reportPath,
      workspaceImage: goImage,
      runID,
    });
    assert.deepEqual(result, { status: "ready", exitCode: 0, reportWritten: true });
    const generated = await readPrivateJSON(generatedPath, "generated");
    assert.equal(generated.name, project);
    assert.equal(generated.services?.["release-check"]?.image, goImage);
    assert.deepEqual(generated.networks?.private, { external: true, name: networkName });
    const report = await readPrivateJSON(reportPath, "report");
    assertReadyReport(report);
    assertNoReleaseCheckContainer(project);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await cleanupResources(resources);
    } catch (cleanupError) {
      if (primaryError) {
        throw new AggregateError([primaryError, cleanupError], "release drain Docker gate failed");
      }
      throw cleanupError;
    }
  }
});
