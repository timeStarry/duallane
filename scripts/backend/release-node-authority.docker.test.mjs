import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createDockerRunner,
  verifyNodeAuthority,
} from "../../deploy/production/release-node-authority.mjs";

const NODE_IMAGE = String(
  process.env.DUALLANE_NODE_AUTHORITY_NODE_IMAGE ?? "",
).trim();
const POSTGRES_IMAGE = String(
  process.env.DUALLANE_NODE_AUTHORITY_POSTGRES_IMAGE ?? "",
).trim();
const DOCKER_TIMEOUT_MS = 20_000;
const MAX_DOCKER_OUTPUT_BYTES = 256 * 1024;
const PROJECT_LABEL = "com.docker.compose.project";
const SERVICE_LABEL = "com.docker.compose.service";
const TASK_LABEL = "com.duallane.release-node-authority.task";
const IMAGE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const CONTAINER_ID_PATTERN = /^[0-9a-f]{64}$/u;
const VOLUME_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/u;
const SECRET_TARGET = "/run/secrets/workspace-s3";
const DATA_TARGET = "/app/data";
const POSTGRES_DATA_TARGET = "/var/lib/postgresql/data";

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

function inspectContainer(id) {
  const result = runDocker(["inspect", id], "container_inspect");
  const documents = parseDockerJSON(result.stdout, "container_inspect");
  if (!Array.isArray(documents) || documents.length !== 1) {
    throw new Error("synthetic Docker container inspection shape is invalid");
  }
  const container = documents[0];
  if (!container || container.Id !== id) {
    throw new Error("synthetic Docker container identity changed");
  }
  return container;
}

function inspectVolume(name) {
  const result = runDocker(["volume", "inspect", name], "volume_inspect");
  const documents = parseDockerJSON(result.stdout, "volume_inspect");
  if (!Array.isArray(documents) || documents.length !== 1) {
    throw new Error("synthetic Docker volume inspection shape is invalid");
  }
  const volume = documents[0];
  if (!volume || volume.Name !== name) {
    throw new Error("synthetic Docker volume identity changed");
  }
  return volume;
}

function expectedLabels(project, service, task) {
  return {
    [PROJECT_LABEL]: project,
    [SERVICE_LABEL]: service,
    [TASK_LABEL]: task,
  };
}

function assertContainerOwner(id, expected) {
  const container = inspectContainer(id);
  const labels = container.Config?.Labels;
  assert.ok(labels && typeof labels === "object");
  assert.equal(labels[PROJECT_LABEL], expected.project);
  assert.equal(labels[SERVICE_LABEL], expected.service);
  assert.equal(labels[TASK_LABEL], expected.task);
  assert.equal(container.Image, expected.image);
  return container;
}

function assertVolumeOwner(name, expected) {
  const volume = inspectVolume(name);
  assert.equal(volume.Driver, "local");
  assert.deepEqual(volume.Labels, expectedLabels(
    expected.project,
    expected.service,
    expected.task,
  ));
  return volume;
}

function labelArgs(labels) {
  return Object.entries(labels).flatMap(([key, value]) => [
    "--label",
    `${key}=${value}`,
  ]);
}

function volumeMount(source, target) {
  return `type=volume,src=${source},dst=${target}`;
}

function bindMount(source, target) {
  return `type=bind,src=${source},dst=${target},readonly`;
}

function makeLocalStorage({ credentialsFile = null } = {}) {
  return {
    DUALLANE_DATA_DIR: "/app/data",
    WORKSPACE_STORAGE_DRIVER: "local",
    WORKSPACE_STORAGE_LOCAL_READ_FALLBACK: "false",
    WORKSPACE_STORAGE_LOCAL_MIRROR_WRITE: "false",
    ...(credentialsFile
      ? { WORKSPACE_S3_CREDENTIALS_FILE: SECRET_TARGET }
      : {}),
  };
}

function makeAuthorityPair({
  project,
  dataVolume,
  postgresVolume,
  secretFile,
  database = "duallane",
} = {}) {
  const nodeConnection = {
    PGHOST: "postgres",
    PGPORT: "5432",
    PGDATABASE: database,
    PGUSER: "duallane",
  };
  const goConnection = { ...nodeConnection };
  const nodeAPIEnvironment = {
    ...nodeConnection,
    DATABASE_SSL: "false",
    PGPASSWORD: "synthetic-password",
    ...makeLocalStorage({ credentialsFile: secretFile }),
  };
  const goWorkspaceEnvironment = {
    ...goConnection,
    DATABASE_SSL: "false",
    PGPASSWORD: "synthetic-password",
    ...makeLocalStorage(),
  };
  const volumes = {
    "workspace-data": { driver: "local", name: dataVolume },
    "postgres-data": { driver: "local", name: postgresVolume },
  };
  const secrets = { "workspace-s3": { file: secretFile } };
  return {
    node: {
      name: project,
      services: {
        api: {
          environment: nodeAPIEnvironment,
          volumes: [
            { type: "volume", source: "workspace-data", target: DATA_TARGET },
          ],
          secrets: [{ source: "workspace-s3", target: "workspace-s3", mode: "0600" }],
        },
        migrate: { environment: { ...nodeConnection, DATABASE_SSL: "false" } },
        postgres: {
          environment: {
            POSTGRES_DB: database,
            POSTGRES_USER: "duallane",
            POSTGRES_PASSWORD: "synthetic-password",
            PGDATA: POSTGRES_DATA_TARGET,
          },
          volumes: [
            {
              type: "volume",
              source: "postgres-data",
              target: POSTGRES_DATA_TARGET,
            },
          ],
        },
      },
      volumes,
      secrets,
    },
    go: {
      name: project,
      services: {
        workspace: {
          environment: goWorkspaceEnvironment,
          volumes: [
            { type: "volume", source: "workspace-data", target: DATA_TARGET },
          ],
        },
        worker: {
          environment: { ...goWorkspaceEnvironment },
          volumes: [
            { type: "volume", source: "workspace-data", target: DATA_TARGET },
          ],
        },
        migrate: { environment: { ...goConnection, DATABASE_SSL: "false" } },
        postgres: {
          environment: {
            POSTGRES_DB: database,
            POSTGRES_USER: "duallane",
            POSTGRES_PASSWORD: "synthetic-password",
            PGDATA: POSTGRES_DATA_TARGET,
          },
          volumes: [
            {
              type: "volume",
              source: "postgres-data",
              target: POSTGRES_DATA_TARGET,
            },
          ],
        },
      },
      volumes: clone(volumes),
      secrets: clone(secrets),
    },
  };
}

function createVolume(state, { name, project, service, task }) {
  assert.match(name, VOLUME_NAME_PATTERN);
  const labels = expectedLabels(project, service, task);
  const output = runDockerText(
    ["volume", "create", ...labelArgs(labels), name],
    "volume_create",
  );
  if (output !== name) {
    throw new Error("synthetic Docker volume create returned an unexpected name");
  }
  const record = { name, project, service, task };
  state.volumes.push(record);
  assertVolumeOwner(name, record);
  return name;
}

function createContainer(state, {
  image,
  name,
  project,
  service,
  task,
  environment,
  mounts,
}) {
  const output = runDockerText(
    [
      "create",
      "--pull=never",
      "--name",
      name,
      "--network",
      "none",
      "--read-only",
      ...labelArgs(expectedLabels(project, service, task)),
      ...Object.entries(environment).flatMap(([key, value]) => [
        "--env",
        `${key}=${value}`,
      ]),
      ...mounts.flatMap((mount) => ["--mount", mount]),
      "--entrypoint",
      "/bin/true",
      image,
    ],
    "container_create",
  );
  if (!CONTAINER_ID_PATTERN.test(output)) {
    throw new Error("synthetic Docker create returned an invalid container ID");
  }
  const record = { id: output, image, project, service, task };
  state.containers.push(record);
  assertContainerOwner(output, record);
  return output;
}

function createAPIContainer(state, fixture) {
  return createContainer(state, {
    image: NODE_IMAGE,
    name: fixture.apiName,
    project: fixture.project,
    service: "api",
    task: fixture.task,
    environment: {
      HOST: "0.0.0.0",
      PORT: "8787",
      PGHOST: "postgres",
      PGPORT: "5432",
      PGDATABASE: "duallane",
      PGUSER: "duallane",
      PGPASSWORD: "synthetic-password",
      DATABASE_SSL: "false",
      DUALLANE_DATA_DIR: "/app/data",
      WORKSPACE_STORAGE_DRIVER: "local",
      WORKSPACE_STORAGE_LOCAL_READ_FALLBACK: "false",
      WORKSPACE_STORAGE_LOCAL_MIRROR_WRITE: "false",
      WORKSPACE_S3_CREDENTIALS_FILE: SECRET_TARGET,
    },
    mounts: [
      volumeMount(fixture.dataVolume, DATA_TARGET),
      bindMount(fixture.secretFile, SECRET_TARGET),
    ],
  });
}

function createPostgresContainer(state, fixture) {
  return createContainer(state, {
    image: POSTGRES_IMAGE,
    name: fixture.postgresName,
    project: fixture.project,
    service: "postgres",
    task: fixture.task,
    environment: {
      POSTGRES_DB: "duallane",
      POSTGRES_USER: "duallane",
      POSTGRES_PASSWORD: "synthetic-password",
      PGDATA: POSTGRES_DATA_TARGET,
    },
    mounts: [volumeMount(fixture.postgresVolume, POSTGRES_DATA_TARGET)],
  });
}

function removeOwnedContainer(record) {
  assertContainerOwner(record.id, record);
  const removal = runDocker(
    ["rm", "--force", record.id],
    "container_remove",
  );
  assert.equal(removal.status, 0);
  const absent = runDocker(["inspect", record.id], "container_absence", [0, 1]);
  if (absent.status === 0) {
    throw new Error("synthetic Docker container cleanup left the owned ID");
  }
}

function removeOwnedVolume(record) {
  assertVolumeOwner(record.name, record);
  const removal = runDocker(
    ["volume", "rm", record.name],
    "volume_remove",
  );
  assert.equal(removal.status, 0);
  const absent = runDocker(
    ["volume", "inspect", record.name],
    "volume_absence",
    [0, 1],
  );
  if (absent.status === 0) {
    throw new Error("synthetic Docker volume cleanup left the owned name");
  }
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
    await rm(directory, { recursive: true, force: false });
  } catch {
    failures.push("fixture_directory_cleanup_failed");
  }
  if (failures.length > 0) {
    throw new Error(`synthetic Docker cleanup incomplete: ${failures.join(",")}`);
  }
}

async function withDockerFixture(callback) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "duallane-node-authority-docker-"),
  );
  const task = randomUUID();
  const project = `duallane-node-authority-${task.slice(0, 12)}`;
  const state = { containers: [], volumes: [] };
  const fixture = {
    directory,
    task,
    project,
    dataVolume: `${project}-data`,
    postgresVolume: `${project}-postgres`,
    apiName: `${project}-api`,
    postgresName: `${project}-postgres`,
    secretFile: path.join(directory, "workspace-s3.json"),
  };
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
    createVolume(state, {
      name: fixture.dataVolume,
      project,
      service: "api",
      task,
    });
    createVolume(state, {
      name: fixture.postgresVolume,
      project,
      service: "postgres",
      task,
    });
    fixture.apiID = createAPIContainer(state, fixture);
    fixture.postgresID = createPostgresContainer(state, fixture);
    await callback(fixture, state);
  } catch (error) {
    primaryError = error;
  }
  try {
    await cleanupFixture(state, directory);
  } catch (error) {
    cleanupError = error;
  }
  if (primaryError && cleanupError) {
    throw new AggregateError([primaryError, cleanupError], "Docker rehearsal and cleanup failed");
  }
  if (cleanupError) throw cleanupError;
  if (primaryError) throw primaryError;
}

async function writePrivateJSON(filePath, value) {
  await writeFile(filePath, JSON.stringify(value) + "\n", { mode: 0o600 });
  await chmod(filePath, 0o600);
}

async function verifyPair(fixture, pair, suffix, dockerRunner) {
  const goPath = path.join(fixture.directory, `go-${suffix}.json`);
  const nodePath = path.join(fixture.directory, `node-${suffix}.json`);
  await writePrivateJSON(goPath, pair.go);
  await writePrivateJSON(nodePath, pair.node);
  return verifyNodeAuthority({
    composePath: goPath,
    nodeComposePath: nodePath,
    dockerRunner,
  });
}

async function assertAuthorityDrift(fixture, pair, suffix, expectedCode) {
  const calls = [];
  const dockerRunner = createDockerRunner();
  const recordingRunner = async (args, stage) => {
    calls.push([...args]);
    return dockerRunner(args, stage);
  };
  await assert.rejects(
    verifyPair(fixture, pair, suffix, recordingRunner),
    (error) => error?.code === expectedCode,
  );
  assert.deepEqual(calls, []);
}

test("rehearses Node authority against physically created stopped containers", {
  skip:
    NODE_IMAGE && POSTGRES_IMAGE
      ? false
      : "requires DUALLANE_NODE_AUTHORITY_NODE_IMAGE and DUALLANE_NODE_AUTHORITY_POSTGRES_IMAGE",
  timeout: 120_000,
}, async () => {
  assert.equal(process.platform, "linux", "the disposable Docker gate runs on Linux");
  assertExactImageID(
    NODE_IMAGE,
    "DUALLANE_NODE_AUTHORITY_NODE_IMAGE",
  );
  assertExactImageID(
    POSTGRES_IMAGE,
    "DUALLANE_NODE_AUTHORITY_POSTGRES_IMAGE",
  );
  const imageInspection = parseDockerJSON(
    runDocker(["image", "inspect", NODE_IMAGE], "node_image_inspect").stdout,
    "node_image_inspect",
  );
  assert.equal(imageInspection.length, 1);
  assert.equal(imageInspection[0].Id, NODE_IMAGE);
  const postgresImageInspection = parseDockerJSON(
    runDocker(["image", "inspect", POSTGRES_IMAGE], "postgres_image_inspect").stdout,
    "postgres_image_inspect",
  );
  assert.equal(postgresImageInspection.length, 1);
  assert.equal(postgresImageInspection[0].Id, POSTGRES_IMAGE);

  await withDockerFixture(async (fixture) => {
    const pair = makeAuthorityPair({
      project: fixture.project,
      dataVolume: fixture.dataVolume,
      postgresVolume: fixture.postgresVolume,
      secretFile: fixture.secretFile,
    });
    const api = assertContainerOwner(
      fixture.apiID,
      {
        project: fixture.project,
        service: "api",
        task: fixture.task,
        image: NODE_IMAGE,
      },
    );
    assert.equal(api.State.Running, false);
    assert.deepEqual(
      await verifyPair(fixture, pair, "base", createDockerRunner()),
      { verified: true },
    );

    const databaseDrift = clone(pair);
    databaseDrift.go.services.workspace.environment.PGDATABASE = "other-database";
    databaseDrift.go.services.worker.environment.PGDATABASE = "other-database";
    databaseDrift.go.services.migrate.environment.PGDATABASE = "other-database";
    databaseDrift.go.services.postgres.environment.POSTGRES_DB = "other-database";
    await assertAuthorityDrift(
      fixture,
      databaseDrift,
      "database-drift",
      "database_authority_changed",
    );

    const volumeDrift = clone(pair);
    volumeDrift.go.volumes["workspace-data"].name = `${fixture.project}-other-data`;
    await assertAuthorityDrift(
      fixture,
      volumeDrift,
      "volume-drift",
      "volume_authority_changed",
    );

    const providerDrift = clone(pair);
    for (const serviceName of ["workspace", "worker"]) {
      Object.assign(providerDrift.go.services[serviceName].environment, {
        WORKSPACE_STORAGE_DRIVER: "s3",
        WORKSPACE_S3_ENDPOINT: "http://other-provider.invalid:9000",
        WORKSPACE_S3_BUCKET: "other-bucket",
        WORKSPACE_S3_REGION: "us-west-2",
        WORKSPACE_S3_CREDENTIALS_FILE: SECRET_TARGET,
        WORKSPACE_S3_PATH_STYLE: "true",
      });
      providerDrift.go.services[serviceName].secrets = [
        { source: "workspace-s3", target: "workspace-s3", mode: "0600" },
      ];
    }
    await assertAuthorityDrift(
      fixture,
      providerDrift,
      "provider-drift",
      "storage_authority_changed",
    );

    const secretDrift = clone(pair);
    const otherSecretFile = path.join(fixture.directory, "other-secret.json");
    await writePrivateJSON(otherSecretFile, { synthetic: true });
    secretDrift.go.services.workspace.environment.WORKSPACE_S3_CREDENTIALS_FILE = SECRET_TARGET;
    secretDrift.go.services.worker.environment.WORKSPACE_S3_CREDENTIALS_FILE = SECRET_TARGET;
    secretDrift.go.services.workspace.secrets = [
      { source: "workspace-s3", target: "workspace-s3", mode: "0600" },
    ];
    secretDrift.go.services.worker.secrets = [
      { source: "workspace-s3", target: "workspace-s3", mode: "0600" },
    ];
    secretDrift.go.secrets["workspace-s3"].file = otherSecretFile;
    await assertAuthorityDrift(
      fixture,
      secretDrift,
      "secret-drift",
      "secret_authority_changed",
    );
  });
});
