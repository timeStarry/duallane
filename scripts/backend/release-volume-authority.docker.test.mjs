import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  captureVolumeAuthority,
  createDockerRunner,
  verifyVolumeAuthority,
  VOLUME_AUTHORITY_TARGETS,
} from "../../deploy/production/release-volume-authority.mjs";

const OPT_IN = process.env.DUALLANE_VOLUME_AUTHORITY_DOCKER_TEST === "true";
const GO_IMAGE = String(
  process.env.DUALLANE_VOLUME_AUTHORITY_GO_IMAGE ?? "",
).trim();
const POSTGRES_IMAGE = String(
  process.env.DUALLANE_VOLUME_AUTHORITY_POSTGRES_IMAGE ?? "",
).trim();
const DOCKER_TIMEOUT_MS = 20_000;
const MAX_DOCKER_OUTPUT_BYTES = 512 * 1024;
const IMAGE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const CONTAINER_ID_PATTERN = /^[0-9a-f]{64}$/u;
const RESOURCE_ID_PATTERN = /^[0-9a-f]{64}$/u;
const PROJECT_LABEL = "com.docker.compose.project";
const SERVICE_LABEL = "com.docker.compose.service";
const TASK_LABEL = "com.duallane.release-volume-authority.task";
const ROLE_LABEL = "com.duallane.release-volume-authority.role";
const SECRET_NAME = "workspace-s3";
const SECRET_TARGET = "/run/secrets/workspace-s3";
const DATA_TARGET = VOLUME_AUTHORITY_TARGETS.workspace;
const POSTGRES_DATA_TARGET = VOLUME_AUTHORITY_TARGETS.postgres;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertExactImageID(value, variableName) {
  assert.match(
    value,
    IMAGE_ID_PATTERN,
    `${variableName} must be an exact local sha256 image ID`,
  );
}

function runDocker(args, operation, allowedStatuses = [0]) {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    timeout: DOCKER_TIMEOUT_MS,
    maxBuffer: MAX_DOCKER_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (result.error || !allowedStatuses.includes(result.status)) {
    throw new Error(`synthetic Docker ${operation} failed`);
  }
  const stdout = String(result.stdout ?? "");
  if (Buffer.byteLength(stdout, "utf8") > MAX_DOCKER_OUTPUT_BYTES) {
    throw new Error(`synthetic Docker ${operation} output exceeded its bound`);
  }
  return { status: result.status, stdout };
}

function runDockerText(args, operation) {
  return runDocker(args, operation).stdout.trim();
}

function parseDockerJSON(stdout, operation) {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`synthetic Docker ${operation} returned invalid JSON`);
  }
}

function inspectImage(image) {
  const documents = parseDockerJSON(
    runDocker(["image", "inspect", image], "image_inspect").stdout,
    "image_inspect",
  );
  assert.ok(Array.isArray(documents) && documents.length === 1);
  assert.equal(documents[0].Id, image);
  return documents[0];
}

function inspectContainer(id) {
  const documents = parseDockerJSON(
    runDocker(["inspect", id], "container_inspect").stdout,
    "container_inspect",
  );
  assert.ok(Array.isArray(documents) && documents.length === 1);
  const container = documents[0];
  assert.equal(container.Id, id);
  return container;
}

function inspectVolume(name) {
  const documents = parseDockerJSON(
    runDocker(["volume", "inspect", name], "volume_inspect").stdout,
    "volume_inspect",
  );
  assert.ok(Array.isArray(documents) && documents.length === 1);
  const volume = documents[0];
  assert.equal(volume.Name, name);
  return volume;
}

function inspectNetwork(name) {
  const documents = parseDockerJSON(
    runDocker(["network", "inspect", name], "network_inspect").stdout,
    "network_inspect",
  );
  assert.ok(Array.isArray(documents) && documents.length === 1);
  const network = documents[0];
  assert.equal(network.Name, name);
  return network;
}

function expectedLabels(fixture, role) {
  return {
    [PROJECT_LABEL]: fixture.project,
    [TASK_LABEL]: fixture.task,
    [ROLE_LABEL]: role,
  };
}

function labelArguments(labels) {
  return Object.entries(labels).flatMap(([key, value]) => [
    "--label",
    `${key}=${value}`,
  ]);
}

function assertOwnedContainer(record, running) {
  assert.match(record.id, CONTAINER_ID_PATTERN);
  const container = inspectContainer(record.id);
  const labels = container.Config?.Labels;
  assert.ok(labels && typeof labels === "object");
  assert.equal(labels[PROJECT_LABEL], record.project);
  assert.equal(labels[SERVICE_LABEL], record.service);
  assert.equal(labels[TASK_LABEL], record.task);
  assert.equal(labels[ROLE_LABEL], "holder");
  assert.equal(container.Image, record.image);
  if (running !== undefined) {
    assert.equal(container.State?.Running, running);
  }
  return container;
}

function assertOwnedVolume(record) {
  const volume = inspectVolume(record.name);
  assert.equal(volume.Driver, "local");
  const labels = volume.Labels;
  assert.ok(labels && typeof labels === "object");
  assert.equal(labels[PROJECT_LABEL], record.project);
  assert.equal(labels[TASK_LABEL], record.task);
  assert.equal(labels[ROLE_LABEL], record.role);
  return volume;
}

function assertOwnedNetwork(record) {
  const network = inspectNetwork(record.name);
  assert.equal(network.Id, record.id);
  const labels = network.Labels;
  assert.ok(labels && typeof labels === "object");
  assert.equal(labels[PROJECT_LABEL], record.project);
  assert.equal(labels[TASK_LABEL], record.task);
  assert.equal(labels[ROLE_LABEL], "network");
  assert.equal(network.Internal, true);
  return network;
}

function makeCompose(fixture, { storageDriver = "local", secretFile = null } = {}) {
  const connection = {
    PGHOST: "postgres",
    PGPORT: "5432",
    PGDATABASE: "duallane",
    PGUSER: "duallane",
    PGPASSWORD: "synthetic-password",
  };
  const storage = {
    WORKSPACE_STORAGE_DRIVER: storageDriver,
    DUALLANE_DATA_DIR: DATA_TARGET,
    WORKSPACE_STORAGE_LOCAL_READ_FALLBACK: "false",
    WORKSPACE_STORAGE_LOCAL_MIRROR_WRITE: "false",
  };
  if (storageDriver === "s3") {
    assert.equal(typeof secretFile, "string");
    Object.assign(storage, {
      WORKSPACE_S3_ENDPOINT: "http://127.0.0.1:19000",
      WORKSPACE_S3_BUCKET: "duallane",
      WORKSPACE_S3_REGION: "synthetic-1",
      WORKSPACE_S3_CREDENTIALS_FILE: SECRET_TARGET,
      WORKSPACE_S3_PATH_STYLE: "true",
    });
  }
  const compose = {
    name: fixture.project,
    services: {
      postgres: {
        environment: {
          POSTGRES_DB: connection.PGDATABASE,
          POSTGRES_USER: connection.PGUSER,
          PGDATA: POSTGRES_DATA_TARGET,
        },
        volumes: [
          {
            type: "volume",
            source: "postgres-authority",
            target: POSTGRES_DATA_TARGET,
          },
        ],
      },
      workspace: {
        environment: { ...connection, ...storage },
        volumes: [
          {
            type: "volume",
            source: "workspace-authority",
            target: DATA_TARGET,
          },
        ],
      },
      worker: {
        environment: { ...connection, ...storage },
        volumes: [
          {
            type: "volume",
            source: "workspace-authority",
            target: DATA_TARGET,
          },
        ],
      },
      migrate: {
        environment: {
          PGHOST: connection.PGHOST,
          PGPORT: connection.PGPORT,
          PGDATABASE: connection.PGDATABASE,
          PGUSER: connection.PGUSER,
        },
      },
    },
    volumes: {
      "postgres-authority": {
        driver: "local",
        name: fixture.postgresVolume,
      },
      "workspace-authority": {
        driver: "local",
        name: fixture.dataVolume,
      },
    },
  };
  if (storageDriver === "s3") {
    const secretEntry = { source: SECRET_NAME, target: SECRET_NAME, mode: "0600" };
    compose.services.workspace.secrets = [secretEntry];
    compose.services.worker.secrets = [clone(secretEntry)];
    compose.secrets = {
      [SECRET_NAME]: { file: secretFile },
    };
  }
  return compose;
}

async function writePrivateJSON(filePath, value) {
  await writeFile(filePath, JSON.stringify(value) + "\n", { mode: 0o600 });
  await chmod(filePath, 0o600);
}

function makeRecordingDockerRunner() {
  const calls = [];
  const dockerRunner = createDockerRunner({ timeoutMs: DOCKER_TIMEOUT_MS });
  return {
    calls,
    runner: async (args, stage) => {
      calls.push([...args]);
      return dockerRunner(args, stage);
    },
  };
}

function assertReadOnlyAuthorityCalls(calls) {
  for (const args of calls) {
    assert.ok(
      args[0] === "ps" ||
        args[0] === "inspect" ||
        (args[0] === "volume" && args[1] === "inspect"),
      "authority helper issued an unexpected Docker operation",
    );
  }
}

function createNetwork(state, fixture) {
  const id = runDockerText(
    [
      "network",
      "create",
      "--internal",
      ...labelArguments(expectedLabels(fixture, "network")),
      fixture.networkName,
    ],
    "network_create",
  );
  assert.match(id, RESOURCE_ID_PATTERN);
  const record = {
    id,
    name: fixture.networkName,
    project: fixture.project,
    task: fixture.task,
  };
  assertOwnedNetwork(record);
  state.network = record;
  return record;
}

function createVolume(state, fixture, name, role) {
  const labels = expectedLabels(fixture, role);
  const output = runDockerText(
    ["volume", "create", "--driver", "local", ...labelArguments(labels), name],
    "volume_create",
  );
  assert.equal(output, name);
  const record = {
    name,
    project: fixture.project,
    task: fixture.task,
    role,
  };
  assertOwnedVolume(record);
  state.volumes.push(record);
  return record;
}

function environmentArguments(environment) {
  return Object.entries(environment).flatMap(([key, value]) => [
    "--env",
    `${key}=${value}`,
  ]);
}

function mountArguments(mounts) {
  return mounts.flatMap((mount) => ["--mount", mount]);
}

function createHolder(state, fixture, compose, phase, serviceName, image) {
  const service = compose.services[serviceName];
  const mounts = [
    `type=volume,src=${
      serviceName === "postgres" ? fixture.postgresVolume : fixture.dataVolume
    },dst=${
      serviceName === "postgres" ? POSTGRES_DATA_TARGET : DATA_TARGET
    }`,
  ];
  if (serviceName !== "postgres" && compose.services[serviceName].secrets) {
    const secret = compose.services[serviceName].secrets[0];
    const secretSource = compose.secrets[secret.source].file;
    const secretTarget = secret.target ?? secret.source;
    mounts.push(
      `type=bind,src=${secretSource},dst=/run/secrets/${secretTarget},readonly`,
    );
  }
  const name = `${fixture.project}-${phase}-${serviceName}`;
  const output = runDockerText(
    [
      "create",
      "--pull=never",
      "--name",
      name,
      "--network",
      fixture.networkName,
      "--read-only",
      "--restart",
      "no",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      ...labelArguments({
        [PROJECT_LABEL]: fixture.project,
        [SERVICE_LABEL]: serviceName,
        [TASK_LABEL]: fixture.task,
        [ROLE_LABEL]: "holder",
      }),
      ...environmentArguments(service.environment),
      ...mountArguments(mounts),
      "--entrypoint",
      "/bin/sleep",
      image,
      "300",
    ],
    "container_create",
  );
  assert.match(output, CONTAINER_ID_PATTERN);
  const record = {
    id: output,
    image,
    name,
    project: fixture.project,
    service: serviceName,
    task: fixture.task,
    removed: false,
  };
  assertOwnedContainer(record, false);
  state.containers.push(record);
  runDocker(["start", record.id], "container_start");
  assertOwnedContainer(record, true);
  return record;
}

function stopOwnedContainer(record) {
  assert.equal(record.removed, false);
  assertOwnedContainer(record, true);
  runDocker(["stop", "--time", "5", record.id], "container_stop");
  assertOwnedContainer(record, false);
}

function removeOwnedContainer(record) {
  if (record.removed) {
    return;
  }
  assertOwnedContainer(record);
  runDocker(["rm", "--force", record.id], "container_remove");
  const absent = runDocker(["inspect", record.id], "container_absence", [0, 1]);
  assert.equal(absent.status, 1);
  record.removed = true;
}

function removeOwnedVolume(record) {
  if (record.removed) {
    return;
  }
  assertOwnedVolume(record);
  runDocker(["volume", "rm", record.name], "volume_remove");
  const absent = runDocker(
    ["volume", "inspect", record.name],
    "volume_absence",
    [0, 1],
  );
  assert.equal(absent.status, 1);
  record.removed = true;
}

function removeOwnedNetwork(record) {
  if (!record || record.removed) {
    return;
  }
  assertOwnedNetwork(record);
  runDocker(["network", "rm", record.name], "network_remove");
  const absent = runDocker(
    ["network", "inspect", record.name],
    "network_absence",
    [0, 1],
  );
  assert.equal(absent.status, 1);
  record.removed = true;
}

async function cleanupFixture(state, directory) {
  const failures = [];
  for (const record of [...state.containers].reverse()) {
    try {
      removeOwnedContainer(record);
    } catch {
      failures.push("container_cleanup_failed");
    }
  }
  for (const record of [...state.volumes].reverse()) {
    try {
      removeOwnedVolume(record);
    } catch {
      failures.push("volume_cleanup_failed");
    }
  }
  try {
    removeOwnedNetwork(state.network);
  } catch {
    failures.push("network_cleanup_failed");
  }
  try {
    await rm(directory, { recursive: true, force: false });
  } catch {
    failures.push("fixture_directory_cleanup_failed");
  }
  if (failures.length > 0) {
    throw new Error(`synthetic Docker cleanup incomplete: ${failures.join(",")}`);
  }
}

async function assertAuthorityRejected(operation, expectedCode) {
  await assert.rejects(operation, (error) => {
    assert.equal(error?.code, expectedCode);
    assert.equal(error?.message, expectedCode);
    return true;
  });
}

async function verifyWithCompose({
  previousComposePath,
  currentCompose,
  directory,
  suffix,
  inputPath,
  dockerRunner,
}) {
  const currentComposePath = path.join(directory, `${suffix}-current.json`);
  await writePrivateJSON(currentComposePath, currentCompose);
  return verifyVolumeAuthority({
    previousComposePath,
    currentComposePath,
    inputPath,
    dockerRunner,
  });
}

test("rehearses real Docker volume authority capture, stop, zero-holder verify and drift rejection", {
  skip: OPT_IN
    ? false
    : "requires DUALLANE_VOLUME_AUTHORITY_DOCKER_TEST=true and exact local image IDs",
  timeout: 180_000,
}, async () => {
  assert.equal(process.platform, "linux", "the disposable Docker gate runs on Linux");
  assertExactImageID(GO_IMAGE, "DUALLANE_VOLUME_AUTHORITY_GO_IMAGE");
  assertExactImageID(
    POSTGRES_IMAGE,
    "DUALLANE_VOLUME_AUTHORITY_POSTGRES_IMAGE",
  );
  inspectImage(GO_IMAGE);
  const postgresImage = inspectImage(POSTGRES_IMAGE);
  const postgresImageEnv = new Map(
    (postgresImage.Config?.Env ?? []).map((entry) => {
      const separator = entry.indexOf("=");
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    }),
  );
  if (postgresImageEnv.has("PGDATA")) {
    assert.equal(postgresImageEnv.get("PGDATA"), POSTGRES_DATA_TARGET);
  }

  const directory = await mkdtemp(
    path.join(os.tmpdir(), "duallane-volume-authority-docker-"),
  );
  const task = randomUUID();
  const project = `duallane-volume-authority-${task.slice(0, 12)}`;
  const fixture = {
    directory,
    task,
    project,
    networkName: `${project}-network`,
    dataVolume: `${project}-data`,
    postgresVolume: `${project}-postgres`,
    secretFile: path.join(directory, "workspace-s3-credentials.json"),
  };
  const state = { containers: [], volumes: [], network: null };
  let primaryError;
  let cleanupError;
  try {
    await writeFile(
      fixture.secretFile,
      JSON.stringify({
        accessKeyId: "synthetic-access-key",
        secretAccessKey: "synthetic-secret-key",
      }) + "\n",
      { mode: 0o600 },
    );
    await chmod(fixture.secretFile, 0o600);

    createNetwork(state, fixture);
    createVolume(state, fixture, fixture.dataVolume, "workspace-data");
    createVolume(state, fixture, fixture.postgresVolume, "postgres-data");

    const localCompose = makeCompose(fixture);
    const localComposePath = path.join(directory, "local-compose.json");
    const localCurrentPath = path.join(directory, "local-current.json");
    const localManifestPath = path.join(directory, "local-authority.json");
    await writePrivateJSON(localComposePath, localCompose);
    await writePrivateJSON(localCurrentPath, localCompose);

    const postgres = createHolder(
      state,
      fixture,
      localCompose,
      "local",
      "postgres",
      POSTGRES_IMAGE,
    );
    const workspace = createHolder(
      state,
      fixture,
      localCompose,
      "local",
      "workspace",
      GO_IMAGE,
    );
    const worker = createHolder(
      state,
      fixture,
      localCompose,
      "local",
      "worker",
      GO_IMAGE,
    );
    assertOwnedContainer(postgres, true);
    assertOwnedContainer(workspace, true);
    assertOwnedContainer(worker, true);

    const authorityDocker = makeRecordingDockerRunner();
    const captured = await captureVolumeAuthority({
      composePath: localComposePath,
      outputPath: localManifestPath,
      dockerRunner: authorityDocker.runner,
    });
    assert.equal(captured.status, "captured");
    assert.equal(captured.manifest.storage.workspace.driver, "local");
    assertReadOnlyAuthorityCalls(authorityDocker.calls);

    stopOwnedContainer(workspace);
    stopOwnedContainer(worker);
    const stoppedVerification = await verifyVolumeAuthority({
      previousComposePath: localComposePath,
      currentComposePath: localCurrentPath,
      inputPath: localManifestPath,
      dockerRunner: authorityDocker.runner,
    });
    assert.equal(stoppedVerification.status, "verified");

    removeOwnedContainer(workspace);
    removeOwnedContainer(worker);
    const zeroHolderVerification = await verifyVolumeAuthority({
      previousComposePath: localComposePath,
      currentComposePath: localCurrentPath,
      inputPath: localManifestPath,
      dockerRunner: authorityDocker.runner,
    });
    assert.equal(zeroHolderVerification.status, "verified");
    assertOwnedContainer(postgres, true);
    assertOwnedVolume({
      name: fixture.dataVolume,
      project: fixture.project,
      task: fixture.task,
      role: "workspace-data",
    });
    assertReadOnlyAuthorityCalls(authorityDocker.calls);

    const physicalDrift = clone(localCompose);
    physicalDrift.volumes["workspace-authority"].name =
      `${fixture.dataVolume}-rebuilt`;
    await assertAuthorityRejected(
      verifyWithCompose({
        previousComposePath: localComposePath,
        currentCompose: physicalDrift,
        directory,
        suffix: "physical-drift",
        inputPath: localManifestPath,
        dockerRunner: authorityDocker.runner,
      }),
      "current_authority_mismatch",
    );

    const databaseDrift = clone(localCompose);
    for (const serviceName of ["postgres", "workspace", "worker", "migrate"]) {
      const environment = databaseDrift.services[serviceName].environment;
      if (serviceName === "postgres") {
        environment.POSTGRES_DB = "other-database";
      } else {
        environment.PGDATABASE = "other-database";
      }
    }
    await assertAuthorityRejected(
      verifyWithCompose({
        previousComposePath: localComposePath,
        currentCompose: databaseDrift,
        directory,
        suffix: "database-drift",
        inputPath: localManifestPath,
        dockerRunner: authorityDocker.runner,
      }),
      "current_authority_mismatch",
    );

    const providerDrift = clone(localCompose);
    for (const serviceName of ["workspace", "worker"]) {
      Object.assign(providerDrift.services[serviceName].environment, {
        WORKSPACE_STORAGE_DRIVER: "s3",
        WORKSPACE_S3_ENDPOINT: "http://127.0.0.1:19001",
        WORKSPACE_S3_BUCKET: "other-bucket",
        WORKSPACE_S3_REGION: "synthetic-2",
        WORKSPACE_S3_CREDENTIALS_FILE: SECRET_TARGET,
        WORKSPACE_S3_PATH_STYLE: "true",
      });
      providerDrift.services[serviceName].secrets = [
        { source: SECRET_NAME, target: SECRET_NAME, mode: "0600" },
      ];
    }
    providerDrift.secrets = {
      [SECRET_NAME]: { file: fixture.secretFile },
    };
    await assertAuthorityRejected(
      verifyWithCompose({
        previousComposePath: localComposePath,
        currentCompose: providerDrift,
        directory,
        suffix: "provider-drift",
        inputPath: localManifestPath,
        dockerRunner: authorityDocker.runner,
      }),
      // Switching local to S3 adds a credential authority, rejected before
      // the storage manifest comparison. S3 endpoint drift is covered below.
      "secret_authority_changed",
    );

    const s3Compose = makeCompose(fixture, {
      storageDriver: "s3",
      secretFile: fixture.secretFile,
    });
    const s3ComposePath = path.join(directory, "s3-compose.json");
    const s3CurrentPath = path.join(directory, "s3-current.json");
    const s3ManifestPath = path.join(directory, "s3-authority.json");
    await writePrivateJSON(s3ComposePath, s3Compose);
    await writePrivateJSON(s3CurrentPath, s3Compose);
    const s3Workspace = createHolder(
      state,
      fixture,
      s3Compose,
      "s3",
      "workspace",
      GO_IMAGE,
    );
    const s3Worker = createHolder(
      state,
      fixture,
      s3Compose,
      "s3",
      "worker",
      GO_IMAGE,
    );
    const s3Captured = await captureVolumeAuthority({
      composePath: s3ComposePath,
      outputPath: s3ManifestPath,
      dockerRunner: authorityDocker.runner,
    });
    assert.equal(s3Captured.status, "captured");
    assert.equal(s3Captured.manifest.storage.workspace.driver, "s3");
    assertOwnedContainer(s3Workspace, true);
    assertOwnedContainer(s3Worker, true);

    const changedSecretFile = path.join(
      directory,
      "changed-workspace-s3-credentials.json",
    );
    await writePrivateJSON(changedSecretFile, { synthetic: true });
    const secretDrift = clone(s3Compose);
    secretDrift.secrets[SECRET_NAME].file = changedSecretFile;
    await assertAuthorityRejected(
      verifyWithCompose({
        previousComposePath: s3ComposePath,
        currentCompose: secretDrift,
        directory,
        suffix: "secret-drift",
        inputPath: s3ManifestPath,
        dockerRunner: authorityDocker.runner,
      }),
      "secret_authority_changed",
    );

    const s3ProviderDrift = clone(s3Compose);
    for (const serviceName of ["workspace", "worker"]) {
      s3ProviderDrift.services[serviceName].environment.WORKSPACE_S3_ENDPOINT =
        "http://127.0.0.1:19001";
    }
    await assertAuthorityRejected(
      verifyWithCompose({
        previousComposePath: s3ComposePath,
        currentCompose: s3ProviderDrift,
        directory,
        suffix: "s3-provider-drift",
        inputPath: s3ManifestPath,
        dockerRunner: authorityDocker.runner,
      }),
      "current_authority_mismatch",
    );

    stopOwnedContainer(s3Workspace);
    stopOwnedContainer(s3Worker);
    removeOwnedContainer(s3Workspace);
    removeOwnedContainer(s3Worker);
    const s3ZeroVerification = await verifyVolumeAuthority({
      previousComposePath: s3ComposePath,
      currentComposePath: s3CurrentPath,
      inputPath: s3ManifestPath,
      dockerRunner: authorityDocker.runner,
    });
    assert.equal(s3ZeroVerification.status, "verified");
    assertReadOnlyAuthorityCalls(authorityDocker.calls);
  } catch (error) {
    primaryError = error;
  }
  try {
    await cleanupFixture(state, directory);
  } catch (error) {
    cleanupError = error;
  }
  if (primaryError && cleanupError) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "Docker rehearsal and cleanup failed",
    );
  }
  if (cleanupError) {
    throw cleanupError;
  }
  if (primaryError) {
    throw primaryError;
  }
});
