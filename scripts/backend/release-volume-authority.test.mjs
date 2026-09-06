import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  VOLUME_AUTHORITY_FORMAT,
  VOLUME_AUTHORITY_TARGETS,
  canonicalComposeHash,
  captureVolumeAuthority,
  verifyVolumeAuthority,
} from "../../deploy/production/release-volume-authority.mjs";

const AUTHORITY_MODULE = fileURLToPath(
  new URL("../../deploy/production/release-volume-authority.mjs", import.meta.url),
);
const PROJECT = "duallane-volume-test";
const IDS = Object.freeze({
  postgres: "a".repeat(64),
  workspace: "b".repeat(64),
  worker: "c".repeat(64),
});
const NAMES = Object.freeze({
  postgres: "duallane-postgres-authority",
  workspace: "duallane-data-authority",
  worker: "duallane-data-authority",
});
const S3_SECRET_NAME = "workspace-s3";
const S3_SECRET_FILE = "/var/lib/duallane/synthetic/workspace-s3-credentials.json";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function environmentObjectToDockerEntries(environment) {
  return Object.entries(environment).map(([key, value]) => key + "=" + String(value).replaceAll("$$", "$"));
}

function postgresImageEnvironmentEntries() {
  return [
    "PG_MAJOR=17",
    "PG_VERSION=17.6",
    "PG_SHA256=synthetic-image-digest",
    "PGDATA=/var/lib/postgresql/data",
  ];
}

function makeCompose({
  project = PROJECT,
  storageDriver = "local",
  dollarDataDir = false,
} = {}) {
  const dataDir = "/app/data";
  const storage = {
    WORKSPACE_STORAGE_DRIVER: storageDriver,
    DUALLANE_DATA_DIR: dataDir,
    WORKSPACE_STORAGE_LOCAL_READ_FALLBACK: "false",
    WORKSPACE_STORAGE_LOCAL_MIRROR_WRITE: "false",
  };
  if (storageDriver === "s3") {
    Object.assign(storage, {
      WORKSPACE_S3_ENDPOINT: "http://minio.internal:9000",
      WORKSPACE_S3_PUBLIC_ENDPOINT: "https://files.example.test",
      WORKSPACE_S3_BUCKET: "duallane",
      WORKSPACE_S3_REGION: "us-east-1",
      WORKSPACE_S3_CREDENTIALS_FILE: "/run/secrets/workspace-s3",
      WORKSPACE_S3_PATH_STYLE: "true",
      WORKSPACE_S3_SIGNED_URL_TTL_SECONDS: "300",
    });
  }
  const workspaceEnvironment = {
    PGHOST: "postgres",
    PGPORT: "5432",
    PGDATABASE: "duallane",
    PGUSER: "synthetic",
    PGPASSWORD: dollarDataDir ? "synthetic-$$-password" : "synthetic-password",
    ...storage,
  };
  const workerEnvironment = {
    PGHOST: "postgres",
    PGPORT: "5432",
    PGDATABASE: "duallane",
    PGUSER: "synthetic",
    PGPASSWORD: dollarDataDir ? "synthetic-$$-password" : "synthetic-password",
    ...storage,
  };
  const compose = {
    name: project,
    services: {
      postgres: {
        environment: {
          POSTGRES_DB: "duallane",
          POSTGRES_USER: "synthetic",
        },
        volumes: [
          {
            type: "volume",
            source: "postgres-authority",
            target: VOLUME_AUTHORITY_TARGETS.postgres,
          },
        ],
      },
      workspace: {
        environment: workspaceEnvironment,
        volumes: [
          {
            type: "volume",
            source: "workspace-authority",
            target: VOLUME_AUTHORITY_TARGETS.workspace,
          },
        ],
      },
      worker: {
        environment: workerEnvironment,
        volumes: [
          {
            type: "volume",
            source: "workspace-authority",
            target: VOLUME_AUTHORITY_TARGETS.worker,
          },
        ],
      },
      migrate: {
        environment: {
          PGHOST: "postgres",
          PGPORT: "5432",
          PGDATABASE: "duallane",
          PGUSER: "synthetic",
        },
      },
    },
    volumes: {
      "postgres-authority": {
        driver: "local",
        name: NAMES.postgres,
      },
      "workspace-authority": {
        driver: "local",
        name: NAMES.workspace,
      },
    },
  };
  if (storageDriver === "s3") {
    compose.services.workspace.secrets = [
      { source: S3_SECRET_NAME, target: S3_SECRET_NAME, mode: "0600" },
    ];
    compose.services.worker.secrets = [
      { source: S3_SECRET_NAME, target: S3_SECRET_NAME, mode: "0600" },
    ];
    compose.secrets = {
      [S3_SECRET_NAME]: { file: S3_SECRET_FILE },
    };
  }
  return compose;
}

function volumeMetadata(name, createdAt) {
  return {
    Name: name,
    Driver: "local",
    CreatedAt: createdAt,
    Labels: {
      "com.docker.compose.project": PROJECT,
      "com.docker.compose.volume": name,
    },
    Options: {},
    Scope: "local",
  };
}

function makeFakeDocker(compose, {
  containerOverrides = {},
  volumeOverrides = {},
  missingVolumeNames = [],
  listOutput = {},
  failureStage = null,
  failureSecret = "",
} = {}) {
  const calls = [];
  const volumes = {
    [NAMES.postgres]: volumeMetadata(
      NAMES.postgres,
      "2026-09-07T00:00:00Z",
    ),
    [NAMES.workspace]: volumeMetadata(
      NAMES.workspace,
      "2026-09-07T00:01:00Z",
    ),
  };
  for (const [name, value] of Object.entries(volumeOverrides)) {
    volumes[name] = { ...volumes[name], ...clone(value) };
  }

  const services = {};
  for (const serviceName of ["postgres", "workspace", "worker"]) {
    const source = compose.services[serviceName].volumes[0].source;
    const environment = compose.services[serviceName].environment;
    const secretMounts = (compose.services[serviceName].secrets ?? []).map(
      (entry) => {
        const sourceName = typeof entry === "string" ? entry : entry.source;
        const targetName =
          typeof entry === "string" ? entry : entry.target ?? entry.source;
        return {
          Type: "bind",
          Source: compose.secrets[sourceName].file,
          Destination: "/run/secrets/" + targetName,
          RW: false,
          Mode: "ro",
        };
      },
    );
    const container = {
      Config: {
        Labels: {
          "com.docker.compose.project": compose.name,
          "com.docker.compose.service": serviceName,
        },
        Env:
          serviceName === "postgres"
            ? environmentObjectToDockerEntries(environment).concat(
                postgresImageEnvironmentEntries(),
              )
            : environmentObjectToDockerEntries(environment),
      },
      State: { Running: true },
      Mounts: [
        {
          Type: "volume",
          Name: NAMES[serviceName],
          Destination: VOLUME_AUTHORITY_TARGETS[serviceName],
          RW: true,
          Source: "/var/lib/docker/volumes/" + NAMES[serviceName] + "/_data",
        },
        ...secretMounts,
      ],
      SyntheticLogicalSource: source,
    };
    services[serviceName] = {
      ...container,
      ...(containerOverrides[serviceName]
        ? clone(containerOverrides[serviceName])
        : {}),
    };
  }
  const byID = {
    [IDS.postgres]: services.postgres,
    [IDS.workspace]: services.workspace,
    [IDS.worker]: services.worker,
  };

  const runner = async (args, stage) => {
    calls.push([...args]);
    if (failureStage === stage) {
      return {
        status: 1,
        stdout: "",
        stderr: failureSecret || "synthetic docker failure",
      };
    }
    if (args[0] === "ps") {
      const serviceFilter = args.find((value) =>
        value.startsWith("label=com.docker.compose.service="),
      );
      const serviceName = serviceFilter?.slice(
        "label=com.docker.compose.service=".length,
      );
      if (listOutput[serviceName] !== undefined) {
        return { status: 0, stdout: listOutput[serviceName], stderr: "" };
      }
      return { status: 0, stdout: IDS[serviceName] + "\n", stderr: "" };
    }
    if (args[0] === "inspect") {
      return {
        status: 0,
        stdout: JSON.stringify([byID[args[1]]]),
        stderr: "",
      };
    }
    if (args[0] === "volume" && args[1] === "inspect") {
      if (missingVolumeNames.includes(args[2])) {
        return {
          status: 1,
          stdout: "",
          stderr: "missing synthetic volume",
        };
      }
      const metadata = volumes[args[2]];
      if (!metadata) {
        return { status: 1, stdout: "", stderr: "missing synthetic volume" };
      }
      return { status: 0, stdout: JSON.stringify([metadata]), stderr: "" };
    }
    throw new Error("unexpected docker command");
  };
  return { calls, runner, services, volumes };
}

function assertReadOnlyDockerCalls(calls) {
  for (const args of calls) {
    assert.ok(
      args[0] === "ps" ||
        args[0] === "inspect" ||
        (args[0] === "volume" && args[1] === "inspect"),
      "unexpected Docker operation",
    );
  }
}

async function writePrivateJSON(filePath, value, mode = 0o600) {
  await writeFile(filePath, JSON.stringify(value, null, 2) + "\n");
  await chmod(filePath, mode);
}

async function withFixture(callback) {
  const directory = await mkdtemp(path.join(tmpdir(), "duallane-volume-authority-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function assertRejected(operation, code) {
  await assert.rejects(operation, (error) => {
    assert.equal(error?.code, code);
    assert.equal(error?.message, code);
    return true;
  });
}

async function captureFixture(directory, {
  compose = makeCompose(),
  dockerOptions = {},
} = {}) {
  const composePath = path.join(directory, "compose.json");
  const outputPath = path.join(directory, "authority.json");
  await writePrivateJSON(composePath, compose);
  const docker = makeFakeDocker(compose, dockerOptions);
  const result = await captureVolumeAuthority({
    composePath,
    outputPath,
    dockerRunner: docker.runner,
  });
  return {
    compose,
    composePath,
    docker,
    manifest: JSON.parse(await readFile(outputPath, "utf8")),
    outputPath,
    result,
  };
}

test("captures a private authority manifest from exact running Compose services", async () => {
  await withFixture(async (directory) => {
    const fixture = await captureFixture(directory, {
      compose: makeCompose({ storageDriver: "s3", dollarDataDir: true }),
    });
    assert.equal(fixture.result.status, "captured");
    assert.equal(fixture.manifest.format, VOLUME_AUTHORITY_FORMAT);
    assert.equal(fixture.manifest.version, 1);
    assert.equal(
      fixture.manifest.composeSha256,
      canonicalComposeHash(fixture.compose),
    );
    assert.equal(fixture.manifest.project, PROJECT);
    assert.equal(fixture.manifest.connections.postgres.host, "postgres");
    assert.equal(fixture.manifest.connections.postgres.port, 5432);
    assert.equal(fixture.manifest.connections.postgres.database, "duallane");
    assert.equal(fixture.manifest.connections.postgres.user, "synthetic");
    assert.equal(fixture.manifest.mounts.postgres.name, NAMES.postgres);
    assert.equal(fixture.manifest.mounts.workspace.name, NAMES.workspace);
    assert.equal(fixture.manifest.mounts.worker.name, NAMES.worker);
    assert.equal(
      fixture.manifest.storage.workspace.dataDir,
      "/app/data",
    );
    assert.equal(
      fixture.manifest.storage.workspace.s3.credentialsFile,
      "/run/secrets/workspace-s3",
    );
    assert.deepEqual(
      fixture.manifest.storage.workspace,
      fixture.manifest.storage.worker,
    );
    assert.equal((await stat(fixture.outputPath)).mode & 0o777, 0o600);
    assertReadOnlyDockerCalls(fixture.docker.calls);
    assert.ok(
      fixture.docker.calls.some(
        (args) =>
          args[0] === "ps" &&
          args[1] === "-a" &&
          args.includes("label=com.docker.compose.service=postgres"),
      ),
    );
  });
});

test("verifies unchanged logical sources, physical names, metadata, storage and container env", async () => {
  await withFixture(async (directory) => {
    const oldFixture = await captureFixture(directory);
    const currentComposePath = path.join(directory, "current-compose.json");
    await writePrivateJSON(currentComposePath, oldFixture.compose);
    const currentDocker = makeFakeDocker(oldFixture.compose);
    const result = await verifyVolumeAuthority({
      previousComposePath: oldFixture.composePath,
      currentComposePath,
      inputPath: oldFixture.outputPath,
      dockerRunner: currentDocker.runner,
    });
    assert.equal(result.status, "verified");
    assertReadOnlyDockerCalls(currentDocker.calls);
  });
});

test("accepts Compose $$ escaping only after one decode for actual container env", async () => {
  await withFixture(async (directory) => {
    const compose = makeCompose({ storageDriver: "s3", dollarDataDir: true });
    const fixture = await captureFixture(directory, { compose });
    assert.equal(
      fixture.manifest.storage.workspace.s3.credentialsFile,
      "/run/secrets/workspace-s3",
    );
    assert.equal(
      fixture.docker.services.workspace.Config.Env.includes(
        "WORKSPACE_S3_CREDENTIALS_FILE=/run/secrets/workspace-s3",
      ),
      true,
    );
    assert.equal(
      fixture.docker.services.workspace.Config.Env.includes(
        "PGPASSWORD=synthetic-$-password",
      ),
      true,
    );
  });
});

test("rejects a bind mount, read-only volume, or split workspace/worker source", async () => {
  await withFixture(async (directory) => {
    const bindCompose = makeCompose();
    bindCompose.services.workspace.volumes[0] = {
      type: "bind",
      source: "/host/private",
      target: "/app/data",
    };
    const bindPath = path.join(directory, "bind.json");
    await writePrivateJSON(bindPath, bindCompose);
    await assertRejected(
      captureVolumeAuthority({
        composePath: bindPath,
        outputPath: path.join(directory, "bind-out.json"),
        dockerRunner: makeFakeDocker(bindCompose).runner,
      }),
      "bind_mount_forbidden",
    );

    const readOnlyCompose = makeCompose();
    readOnlyCompose.services.workspace.volumes[0].read_only = true;
    const readOnlyPath = path.join(directory, "read-only.json");
    await writePrivateJSON(readOnlyPath, readOnlyCompose);
    await assertRejected(
      captureVolumeAuthority({
        composePath: readOnlyPath,
        outputPath: path.join(directory, "read-only-out.json"),
        dockerRunner: makeFakeDocker(readOnlyCompose).runner,
      }),
      "volume_read_only",
    );

    const splitCompose = makeCompose();
    splitCompose.services.worker.volumes[0].source = "other-authority";
    splitCompose.volumes["other-authority"] = {
      driver: "local",
      name: "other-authority",
    };
    const splitPath = path.join(directory, "split.json");
    await writePrivateJSON(splitPath, splitCompose);
    await assertRejected(
      captureVolumeAuthority({
        composePath: splitPath,
        outputPath: path.join(directory, "split-out.json"),
        dockerRunner: makeFakeDocker(splitCompose).runner,
      }),
      "workspace_worker_source_mismatch",
    );
  });
});

test("rejects non-private, symlinked and already-existing sidecar paths", async () => {
  await withFixture(async (directory) => {
    const compose = makeCompose();
    const publicComposePath = path.join(directory, "public-compose.json");
    await writePrivateJSON(publicComposePath, compose, 0o644);
    await assertRejected(
      captureVolumeAuthority({
        composePath: publicComposePath,
        outputPath: path.join(directory, "out.json"),
        dockerRunner: makeFakeDocker(compose).runner,
      }),
      "compose_permissions",
    );

    const privateComposePath = path.join(directory, "compose.json");
    await writePrivateJSON(privateComposePath, compose);
    const existingOutput = path.join(directory, "existing.json");
    await writePrivateJSON(existingOutput, { synthetic: true });
    await assertRejected(
      captureVolumeAuthority({
        composePath: privateComposePath,
        outputPath: existingOutput,
        dockerRunner: makeFakeDocker(compose).runner,
      }),
      "output_exists",
    );

    const symlinkPath = path.join(directory, "compose-link.json");
    try {
      await fsSymlink(privateComposePath, symlinkPath);
    } catch (error) {
      assert.fail("symlink fixture could not be created: " + error.message);
    }
    await assertRejected(
      captureVolumeAuthority({
        composePath: symlinkPath,
        outputPath: path.join(directory, "symlink-out.json"),
        dockerRunner: makeFakeDocker(compose).runner,
      }),
      "compose_symlink",
    );
  });
});

async function fsSymlink(target, linkPath) {
  const { symlink } = await import("node:fs/promises");
  await symlink(target, linkPath);
}

test("rejects unsupported DATABASE_URL, PGOPTIONS and storage configuration", async () => {
  await withFixture(async (directory) => {
    const compose = makeCompose();
    compose.services.workspace.environment.DATABASE_URL =
      "postgres://synthetic:do-not-leak@postgres/duallane";
    const composePath = path.join(directory, "database-url.json");
    await writePrivateJSON(composePath, compose);
    await assertRejected(
      captureVolumeAuthority({
        composePath,
        outputPath: path.join(directory, "database-url-out.json"),
        dockerRunner: makeFakeDocker(compose).runner,
      }),
      "unproven_database_connection",
    );

    const pgOptionsCompose = makeCompose();
    pgOptionsCompose.services.worker.environment.PGOPTIONS =
      "-c search_path=private";
    const pgOptionsPath = path.join(directory, "pgoptions.json");
    await writePrivateJSON(pgOptionsPath, pgOptionsCompose);
    await assertRejected(
      captureVolumeAuthority({
        composePath: pgOptionsPath,
        outputPath: path.join(directory, "pgoptions-out.json"),
        dockerRunner: makeFakeDocker(pgOptionsCompose).runner,
      }),
      "unproven_database_connection",
    );

    const sslCompose = makeCompose();
    sslCompose.services.workspace.environment.DATABASE_SSL = "true";
    const sslPath = path.join(directory, "ssl.json");
    await writePrivateJSON(sslPath, sslCompose);
    await assertRejected(
      captureVolumeAuthority({
        composePath: sslPath,
        outputPath: path.join(directory, "ssl-out.json"),
        dockerRunner: makeFakeDocker(sslCompose).runner,
      }),
      "unproven_database_connection",
    );

    const unknownStorageCompose = makeCompose();
    unknownStorageCompose.services.workspace.environment.WORKSPACE_S3_UNKNOWN =
      "synthetic-secret";
    const unknownStoragePath = path.join(directory, "unknown-storage.json");
    await writePrivateJSON(unknownStoragePath, unknownStorageCompose);
    await assertRejected(
      captureVolumeAuthority({
        composePath: unknownStoragePath,
        outputPath: path.join(directory, "unknown-storage-out.json"),
        dockerRunner: makeFakeDocker(unknownStorageCompose).runner,
      }),
      "unproven_storage_configuration",
    );
  });
});

test("rejects project/service identity, singleton and mount authority mismatches", async () => {
  await withFixture(async (directory) => {
    const compose = makeCompose();
    const projectMismatchDocker = makeFakeDocker(compose, {
      containerOverrides: {
        workspace: {
          Config: {
            Labels: {
              "com.docker.compose.project": "other-project",
              "com.docker.compose.service": "workspace",
            },
            Env: environmentObjectToDockerEntries(
              compose.services.workspace.environment,
            ),
          },
        },
      },
    });
    const composePath = path.join(directory, "project-mismatch.json");
    await writePrivateJSON(composePath, compose);
    await assertRejected(
      captureVolumeAuthority({
        composePath,
        outputPath: path.join(directory, "project-mismatch-out.json"),
        dockerRunner: projectMismatchDocker.runner,
      }),
      "container_project_mismatch",
    );

    const duplicateDocker = makeFakeDocker(compose, {
      listOutput: {
        postgres: IDS.postgres + "\n" + IDS.workspace + "\n",
      },
    });
    await assertRejected(
      captureVolumeAuthority({
        composePath,
        outputPath: path.join(directory, "duplicate-out.json"),
        dockerRunner: duplicateDocker.runner,
      }),
      "container_singleton_required",
    );

    const mountMismatchDocker = makeFakeDocker(compose, {
      containerOverrides: {
        worker: {
          Mounts: [
            {
              Type: "volume",
              Name: "different-volume",
              Destination: "/app/data",
              RW: true,
            },
          ],
        },
      },
      volumeOverrides: {
        "different-volume": volumeMetadata(
          "different-volume",
          "2026-09-07T00:02:00Z",
        ),
      },
    });
    await assertRejected(
      captureVolumeAuthority({
        composePath,
        outputPath: path.join(directory, "mount-mismatch-out.json"),
        dockerRunner: mountMismatchDocker.runner,
      }),
      "container_volume_name_mismatch",
    );
  });
});

test("requires canonical physical volume names and permits Postgres image metadata only", async () => {
  await withFixture(async (directory) => {
    const compose = makeCompose();
    compose.volumes["workspace-authority"].name = "configured-other";
    const composePath = path.join(directory, "physical-name.json");
    await writePrivateJSON(composePath, compose);
    const nameMismatchDocker = makeFakeDocker(compose);
    await assertRejected(
      captureVolumeAuthority({
        composePath,
        outputPath: path.join(directory, "physical-name-out.json"),
        dockerRunner: nameMismatchDocker.runner,
      }),
      "container_volume_name_mismatch",
    );

    compose.volumes["workspace-authority"].name = NAMES.workspace;
    await writePrivateJSON(composePath, compose);
    const imageMetadataDocker = makeFakeDocker(compose);
    assert.ok(imageMetadataDocker.services.postgres.Config.Env.includes("PG_MAJOR=17"));
    assert.ok(imageMetadataDocker.services.postgres.Config.Env.includes("PG_VERSION=17.6"));
    assert.ok(imageMetadataDocker.services.postgres.Config.Env.includes("PG_SHA256=synthetic-image-digest"));
    assert.ok(imageMetadataDocker.services.postgres.Config.Env.includes("PGDATA=/var/lib/postgresql/data"));
    imageMetadataDocker.services.postgres.Config.Env =
      imageMetadataDocker.services.postgres.Config.Env.map((entry) =>
        entry.startsWith("PGDATA=") ? "PGDATA=/var/lib/postgresql/data" : entry,
      );
    await captureVolumeAuthority({
      composePath,
      outputPath: path.join(directory, "image-metadata-out.json"),
      dockerRunner: imageMetadataDocker.runner,
    });

    const badPostgresDocker = makeFakeDocker(compose);
    badPostgresDocker.services.postgres.Config.Env =
      badPostgresDocker.services.postgres.Config.Env.map((entry) =>
        entry.startsWith("PGDATA=") ? "PGDATA=/var/lib/postgresql/data/pgdata" : entry,
      );
    await assertRejected(
      captureVolumeAuthority({
        composePath,
        outputPath: path.join(directory, "bad-pgdata-out.json"),
        dockerRunner: badPostgresDocker.runner,
      }),
      "container_database_environment_mismatch",
    );

    const badWorkerDocker = makeFakeDocker(compose);
    badWorkerDocker.services.worker.Config.Env.push("PGDATA=/var/lib/postgresql/data");
    await assertRejected(
      captureVolumeAuthority({
        composePath,
        outputPath: path.join(directory, "worker-pgdata-out.json"),
        dockerRunner: badWorkerDocker.runner,
      }),
      "unproven_database_connection",
    );
  });
});

test("requires migrate and matches canonical Postgres user across all clients", async () => {
  await withFixture(async (directory) => {
    const base = makeCompose();
    const missingMigrate = clone(base);
    delete missingMigrate.services.migrate;
    const missingPath = path.join(directory, "missing-migrate.json");
    await writePrivateJSON(missingPath, missingMigrate);
    await assertRejected(
      captureVolumeAuthority({
        composePath: missingPath,
        outputPath: path.join(directory, "missing-migrate-out.json"),
        dockerRunner: makeFakeDocker(missingMigrate).runner,
      }),
      "missing_compose_service",
    );

    const badMigrate = clone(base);
    badMigrate.services.migrate.environment.PGUSER = "other-user";
    const badMigratePath = path.join(directory, "bad-migrate-user.json");
    await writePrivateJSON(badMigratePath, badMigrate);
    await assertRejected(
      captureVolumeAuthority({
        composePath: badMigratePath,
        outputPath: path.join(directory, "bad-migrate-user-out.json"),
        dockerRunner: makeFakeDocker(badMigrate).runner,
      }),
      "database_connection_mismatch",
    );

    const badClient = clone(base);
    badClient.services.workspace.environment.PGUSER = "other-user";
    const badClientPath = path.join(directory, "bad-client-user.json");
    await writePrivateJSON(badClientPath, badClient);
    await assertRejected(
      captureVolumeAuthority({
        composePath: badClientPath,
        outputPath: path.join(directory, "bad-client-user-out.json"),
        dockerRunner: makeFakeDocker(badClient).runner,
      }),
      "database_connection_mismatch",
    );
  });
});

test("requires the verified /app/data local storage root", async () => {
  await withFixture(async (directory) => {
    const compose = makeCompose();
    compose.services.workspace.environment.DUALLANE_DATA_DIR = "/app/data-other";
    compose.services.worker.environment.DUALLANE_DATA_DIR = "/app/data-other";
    const composePath = path.join(directory, "wrong-root.json");
    await writePrivateJSON(composePath, compose);
    await assertRejected(
      captureVolumeAuthority({
        composePath,
        outputPath: path.join(directory, "wrong-root-out.json"),
        dockerRunner: makeFakeDocker(compose).runner,
      }),
      "storage_local_root_unproven",
    );
  });
});

test("capture requires running holders while verify accepts stopped or zero Workspace/worker holders", async () => {
  await withFixture(async (directory) => {
    const oldFixture = await captureFixture(directory);
    const currentComposePath = path.join(directory, "current-compose.json");
    await writePrivateJSON(currentComposePath, oldFixture.compose);

    const stoppedDocker = makeFakeDocker(oldFixture.compose, {
      containerOverrides: {
        postgres: { State: { Running: false } },
        workspace: { State: { Running: false } },
        worker: { State: { Running: false } },
      },
    });
    await assertRejected(
      captureVolumeAuthority({
        composePath: oldFixture.composePath,
        outputPath: path.join(directory, "stopped-capture-out.json"),
        dockerRunner: stoppedDocker.runner,
      }),
      "container_not_running",
    );
    const stoppedResult = await verifyVolumeAuthority({
      previousComposePath: oldFixture.composePath,
      currentComposePath,
      inputPath: oldFixture.outputPath,
      dockerRunner: stoppedDocker.runner,
    });
    assert.equal(stoppedResult.status, "verified");

    const zeroHolderDocker = makeFakeDocker(oldFixture.compose, {
      listOutput: {
        workspace: "",
        worker: "",
      },
    });
    const zeroHolderResult = await verifyVolumeAuthority({
      previousComposePath: oldFixture.composePath,
      currentComposePath,
      inputPath: oldFixture.outputPath,
      dockerRunner: zeroHolderDocker.runner,
    });
    assert.equal(zeroHolderResult.status, "verified");
    assert.ok(
      zeroHolderDocker.calls.some(
        (args) =>
          args[0] === "ps" &&
          args.includes("-a") &&
          args.includes("label=com.docker.compose.service=workspace"),
      ),
    );
    assert.ok(
      zeroHolderDocker.calls.some(
        (args) =>
          args[0] === "volume" &&
          args[1] === "inspect" &&
          args[2] === NAMES.workspace,
      ),
    );

    const missingVolumeDocker = makeFakeDocker(oldFixture.compose, {
      listOutput: {
        workspace: "",
        worker: "",
      },
      missingVolumeNames: [NAMES.workspace],
    });
    await assertRejected(
      verifyVolumeAuthority({
        previousComposePath: oldFixture.composePath,
        currentComposePath,
        inputPath: oldFixture.outputPath,
        dockerRunner: missingVolumeDocker.runner,
      }),
      "docker_volume_inspect_failed",
    );

    const rebuiltZeroHolderDocker = makeFakeDocker(oldFixture.compose, {
      listOutput: {
        workspace: "",
        worker: "",
      },
      volumeOverrides: {
        [NAMES.workspace]: {
          CreatedAt: "2026-09-07T06:00:00Z",
        },
      },
    });
    await assertRejected(
      verifyVolumeAuthority({
        previousComposePath: oldFixture.composePath,
        currentComposePath,
        inputPath: oldFixture.outputPath,
        dockerRunner: rebuiltZeroHolderDocker.runner,
      }),
      "volume_metadata_mismatch",
    );

    const missingPostgresDocker = makeFakeDocker(oldFixture.compose, {
      listOutput: {
        postgres: "",
      },
    });
    await assertRejected(
      verifyVolumeAuthority({
        previousComposePath: oldFixture.composePath,
        currentComposePath,
        inputPath: oldFixture.outputPath,
        dockerRunner: missingPostgresDocker.runner,
      }),
      "container_singleton_required",
    );
    assertReadOnlyDockerCalls(zeroHolderDocker.calls);
    assertReadOnlyDockerCalls(missingVolumeDocker.calls);
    assertReadOnlyDockerCalls(rebuiltZeroHolderDocker.calls);
    assertReadOnlyDockerCalls(missingPostgresDocker.calls);
  });
});

test("rejects container storage or database environment drift without exposing values", async () => {
  await withFixture(async (directory) => {
    const compose = makeCompose();
    const composePath = path.join(directory, "container-env.json");
    await writePrivateJSON(composePath, compose);
    const storageDriftDocker = makeFakeDocker(compose, {
      containerOverrides: {
        workspace: {
          Config: {
            Labels: {
              "com.docker.compose.project": PROJECT,
              "com.docker.compose.service": "workspace",
            },
            Env: [
              "PGHOST=postgres",
              "PGPORT=5432",
              "PGDATABASE=duallane",
              "PGUSER=synthetic",
              "WORKSPACE_STORAGE_DRIVER=local",
              "DUALLANE_DATA_DIR=/app/data",
              "WORKSPACE_STORAGE_LOCAL_READ_FALLBACK=true",
              "WORKSPACE_STORAGE_LOCAL_MIRROR_WRITE=false",
            ],
          },
        },
      },
    });
    await assertRejected(
      captureVolumeAuthority({
        composePath,
        outputPath: path.join(directory, "container-env-out.json"),
        dockerRunner: storageDriftDocker.runner,
      }),
      "container_storage_environment_mismatch",
    );

    const databaseDriftDocker = makeFakeDocker(compose, {
      containerOverrides: {
        worker: {
          Config: {
            Labels: {
              "com.docker.compose.project": PROJECT,
              "com.docker.compose.service": "worker",
            },
            Env: [
              "PGHOST=other-postgres",
              "PGPORT=5432",
              "PGDATABASE=duallane",
              "PGUSER=synthetic",
              "WORKSPACE_STORAGE_DRIVER=local",
              "DUALLANE_DATA_DIR=/app/data",
              "WORKSPACE_STORAGE_LOCAL_READ_FALLBACK=false",
              "WORKSPACE_STORAGE_LOCAL_MIRROR_WRITE=false",
            ],
          },
        },
      },
    });
    await assertRejected(
      captureVolumeAuthority({
        composePath,
        outputPath: path.join(directory, "database-env-out.json"),
        dockerRunner: databaseDriftDocker.runner,
      }),
      "container_database_environment_mismatch",
    );
  });
});

test("verifies S3 authority fields, path style and rejects changed storage authority", async () => {
  await withFixture(async (directory) => {
    const compose = makeCompose({ storageDriver: "s3" });
    const oldFixture = await captureFixture(directory, { compose });
    assert.equal(oldFixture.manifest.storage.workspace.s3.pathStyle, true);
    assert.equal(
      oldFixture.manifest.storage.workspace.s3.credentialsFile,
      "/run/secrets/workspace-s3",
    );

    const secretSourceDriftDocker = makeFakeDocker(compose, {
      containerOverrides: {
        workspace: {
          Mounts: [
            {
              Type: "volume",
              Name: NAMES.workspace,
              Destination: VOLUME_AUTHORITY_TARGETS.workspace,
              RW: true,
            },
            {
              Type: "bind",
              Source: "/var/lib/duallane/synthetic/wrong-credentials.json",
              Destination: "/run/secrets/workspace-s3",
              RW: false,
              Mode: "ro",
            },
          ],
        },
      },
    });
    await assertRejected(
      captureVolumeAuthority({
        composePath: oldFixture.composePath,
        outputPath: path.join(directory, "secret-source-drift-out.json"),
        dockerRunner: secretSourceDriftDocker.runner,
      }),
      "container_secret_mount_mismatch",
    );

    const changedSecretCompose = clone(compose);
    changedSecretCompose.secrets[S3_SECRET_NAME].file =
      "/var/lib/duallane/synthetic/changed-credentials.json";
    const changedSecretPath = path.join(directory, "changed-secret.json");
    await writePrivateJSON(changedSecretPath, changedSecretCompose);
    await assertRejected(
      verifyVolumeAuthority({
        previousComposePath: oldFixture.composePath,
        currentComposePath: changedSecretPath,
        inputPath: oldFixture.outputPath,
        dockerRunner: makeFakeDocker(changedSecretCompose).runner,
      }),
      "secret_authority_changed",
    );

    const changedCompose = clone(compose);
    changedCompose.services.workspace.environment.WORKSPACE_S3_BUCKET =
      "other-bucket";
    changedCompose.services.worker.environment.WORKSPACE_S3_BUCKET =
      "other-bucket";
    const changedPath = path.join(directory, "changed-s3.json");
    await writePrivateJSON(changedPath, changedCompose);
    await assertRejected(
      verifyVolumeAuthority({
        previousComposePath: oldFixture.composePath,
        currentComposePath: changedPath,
        inputPath: oldFixture.outputPath,
        dockerRunner: makeFakeDocker(changedCompose).runner,
      }),
      "current_authority_mismatch",
    );

    const badPathStyle = makeCompose({ storageDriver: "s3" });
    badPathStyle.services.workspace.environment.WORKSPACE_S3_PATH_STYLE = "false";
    const badPath = path.join(directory, "bad-path-style.json");
    await writePrivateJSON(badPath, badPathStyle);
    await assertRejected(
      captureVolumeAuthority({
        composePath: badPath,
        outputPath: path.join(directory, "bad-path-style-out.json"),
        dockerRunner: makeFakeDocker(badPathStyle).runner,
      }),
      "storage_path_style_invalid",
    );
  });
});

test("rejects missing, rebuilt and changed volume metadata", async () => {
  await withFixture(async (directory) => {
    const oldFixture = await captureFixture(directory);
    const currentComposePath = path.join(directory, "current.json");
    await writePrivateJSON(currentComposePath, oldFixture.compose);

    const missingDocker = makeFakeDocker(oldFixture.compose, {
      failureStage: "volume_inspect",
    });
    await assertRejected(
      verifyVolumeAuthority({
        previousComposePath: oldFixture.composePath,
        currentComposePath,
        inputPath: oldFixture.outputPath,
        dockerRunner: missingDocker.runner,
      }),
      "docker_volume_inspect_failed",
    );

    const rebuiltDocker = makeFakeDocker(oldFixture.compose, {
      volumeOverrides: {
        [NAMES.workspace]: {
          CreatedAt: "2026-09-07T05:00:00Z",
        },
      },
    });
    await assertRejected(
      verifyVolumeAuthority({
        previousComposePath: oldFixture.composePath,
        currentComposePath,
        inputPath: oldFixture.outputPath,
        dockerRunner: rebuiltDocker.runner,
      }),
      "volume_metadata_mismatch",
    );

    const changedLabelsDocker = makeFakeDocker(oldFixture.compose, {
      volumeOverrides: {
        [NAMES.workspace]: {
          Labels: {
            "com.docker.compose.project": PROJECT,
            "com.docker.compose.volume": "different",
          },
        },
      },
    });
    await assertRejected(
      verifyVolumeAuthority({
        previousComposePath: oldFixture.composePath,
        currentComposePath,
        inputPath: oldFixture.outputPath,
        dockerRunner: changedLabelsDocker.runner,
      }),
      "volume_metadata_mismatch",
    );
  });
});

test("binds the manifest to the previous canonical Compose hash", async () => {
  await withFixture(async (directory) => {
    const oldFixture = await captureFixture(directory);
    const tamperedCompose = clone(oldFixture.compose);
    tamperedCompose.services.workspace.environment.DUALLANE_DATA_DIR =
      "/app/tampered";
    const tamperedPath = path.join(directory, "tampered.json");
    await writePrivateJSON(tamperedPath, tamperedCompose);
    await assertRejected(
      verifyVolumeAuthority({
        previousComposePath: tamperedPath,
        currentComposePath: oldFixture.composePath,
        inputPath: oldFixture.outputPath,
        dockerRunner: makeFakeDocker(oldFixture.compose).runner,
      }),
      "previous_compose_hash_mismatch",
    );
  });
});

test("runner failures and raw Docker diagnostics stay content-free", async () => {
  await withFixture(async (directory) => {
    const compose = makeCompose();
    const composePath = path.join(directory, "runner-failure.json");
    await writePrivateJSON(composePath, compose);
    const secret = "synthetic-secret-must-not-appear";
    let failure;
    try {
      await captureVolumeAuthority({
        composePath,
        outputPath: path.join(directory, "runner-failure-out.json"),
        dockerRunner: makeFakeDocker(compose, {
          failureStage: "container_list",
          failureSecret: secret,
        }).runner,
      });
    } catch (error) {
      failure = error;
    }
    assert.equal(failure?.code, "docker_container_list_failed");
    assert.equal(failure?.message.includes(secret), false);
    assert.equal(String(failure).includes(secret), false);
  });
});

test("CLI rejects an unsafe Compose path without echoing path or content", async () => {
  await withFixture(async (directory) => {
    const secret = "synthetic-cli-secret";
    const composePath = path.join(directory, "unsafe-compose.json");
    await writeFile(
      composePath,
      JSON.stringify({
        secret,
        services: {},
      }),
    );
    await chmod(composePath, 0o644);
    const outputPath = path.join(directory, "cli-output.json");
    const result = spawnSync(
      process.execPath,
      [
        AUTHORITY_MODULE,
        "capture",
        "--compose",
        composePath,
        "--output",
        outputPath,
      ],
      {
        encoding: "utf8",
        env: { PATH: process.env.PATH },
      },
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /release-volume-authority rejected: compose_permissions/u);
    assert.equal(result.stderr.includes(composePath), false);
    assert.equal(result.stderr.includes(secret), false);
  });
});
