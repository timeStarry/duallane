import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  NodeAuthorityError,
  parseCLIArguments,
  verifyNodeAuthority,
} from "../../deploy/production/release-node-authority.mjs";

const PROJECT = "duallane-authority-test";
const IDS = Object.freeze({
  api: "a".repeat(64),
  postgres: "b".repeat(64),
});
const PHYSICAL_NAMES = Object.freeze({
  data: "duallane-authority-data",
  postgres: "duallane-authority-postgres",
});
const DATABASE = "duallane";
const USER = "duallane";
const SECRET_FILE = "/private/workspace-s3.json";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function environmentObjectToDockerEntries(environment) {
  return Object.entries(environment).map(([key, value]) =>
    key + "=" + String(value).replaceAll("$$", "$"),
  );
}

function storageEnvironment(driver, {
  fallback = "false",
  mirror = "false",
  credentials = false,
} = {}) {
  const result = {
    DUALLANE_DATA_DIR: "/app/data",
    WORKSPACE_STORAGE_DRIVER: driver,
    WORKSPACE_STORAGE_LOCAL_READ_FALLBACK: fallback,
    WORKSPACE_STORAGE_LOCAL_MIRROR_WRITE: mirror,
  };
  if (driver === "s3") {
    Object.assign(result, {
      WORKSPACE_S3_ENDPOINT: "http://minio.internal:9000",
      WORKSPACE_S3_PUBLIC_ENDPOINT: "https://files.example.test",
      WORKSPACE_S3_BUCKET: "duallane",
      WORKSPACE_S3_REGION: "us-east-1",
      WORKSPACE_S3_CREDENTIALS_FILE: "/run/secrets/workspace-s3",
      WORKSPACE_S3_SIGNED_URL_TTL_SECONDS: "300",
    });
  } else if (credentials) {
    result.WORKSPACE_S3_CREDENTIALS_FILE = "/run/secrets/workspace-s3";
  }
  return result;
}

function makePair({
  storageDriver = "local",
  nodeSecret = true,
  goSecret = storageDriver === "s3",
  database = DATABASE,
  goDatabase = database,
  project = PROJECT,
} = {}) {
  const nodeConnection = {
    PGHOST: "postgres",
    PGPORT: "5432",
    PGDATABASE: database,
    PGUSER: USER,
  };
  const goConnection = {
    PGHOST: "postgres",
    PGPORT: "5432",
    PGDATABASE: goDatabase,
    PGUSER: USER,
  };
  const nodeEnvironment = {
    ...nodeConnection,
    DATABASE_SSL: "false",
    ...storageEnvironment(storageDriver, { credentials: nodeSecret }),
  };
  const goEnvironment = {
    ...goConnection,
    DATABASE_SSL: "false",
    ...storageEnvironment(storageDriver, { credentials: goSecret }),
  };
  const nodeServices = {
    api: {
      environment: nodeEnvironment,
      volumes: [
        {
          type: "volume",
          source: "workspace-data",
          target: "/app/data",
        },
      ],
      ...(nodeSecret
        ? {
            secrets: [
              { source: "workspace-s3", target: "workspace-s3", mode: "0600" },
            ],
          }
        : {}),
    },
    migrate: {
      environment: {
        ...nodeConnection,
        DATABASE_SSL: "false",
      },
    },
    postgres: {
      environment: {
        POSTGRES_DB: database,
        POSTGRES_USER: USER,
        PGDATA: "/var/lib/postgresql/data",
      },
      volumes: [
        {
          type: "volume",
          source: "postgres-data",
          target: "/var/lib/postgresql/data",
        },
      ],
    },
  };
  const goServices = {
    workspace: {
      environment: goEnvironment,
      volumes: [
        {
          type: "volume",
          source: "workspace-data",
          target: "/app/data",
        },
      ],
      ...(goSecret
        ? {
            secrets: [
              { source: "workspace-s3", target: "workspace-s3", mode: "0600" },
            ],
          }
        : {}),
    },
    worker: {
      environment: { ...goEnvironment },
      volumes: [
        {
          type: "volume",
          source: "workspace-data",
          target: "/app/data",
        },
      ],
      ...(goSecret
        ? {
            secrets: [
              { source: "workspace-s3", target: "workspace-s3", mode: "0600" },
            ],
          }
        : {}),
    },
    migrate: {
      environment: {
        ...goConnection,
        DATABASE_SSL: "false",
      },
    },
    postgres: {
      environment: {
        POSTGRES_DB: goDatabase,
        POSTGRES_USER: USER,
        PGDATA: "/var/lib/postgresql/data",
      },
      volumes: [
        {
          type: "volume",
          source: "postgres-data",
          target: "/var/lib/postgresql/data",
        },
      ],
    },
  };
  const volumes = {
    "workspace-data": { driver: "local", name: PHYSICAL_NAMES.data },
    "postgres-data": { driver: "local", name: PHYSICAL_NAMES.postgres },
  };
  const secrets = {
    ...(nodeSecret || goSecret
      ? { "workspace-s3": { file: SECRET_FILE } }
      : {}),
  };
  return {
    node: { name: project, services: nodeServices, volumes, secrets },
    go: { name: project, services: goServices, volumes, secrets },
  };
}

function makeFakeDocker(nodeCompose, {
  apiOverrides = {},
  postgresOverrides = {},
  listOutput = {},
} = {}) {
  const calls = [];
  const apiSecret =
    nodeCompose.services.api.environment.WORKSPACE_S3_CREDENTIALS_FILE;
  const apiMounts = [
    {
      Type: "volume",
      Name: PHYSICAL_NAMES.data,
      Destination: "/app/data",
      RW: true,
    },
  ];
  if (apiSecret) {
    apiMounts.push({
      Type: "bind",
      Source: SECRET_FILE,
      Destination: apiSecret,
      RW: false,
      Mode: "ro",
    });
  }
  const containers = {
    api: {
      Id: IDS.api,
      Config: {
        Labels: {
          "com.docker.compose.project": nodeCompose.name,
          "com.docker.compose.service": "api",
        },
        Env: environmentObjectToDockerEntries(
          nodeCompose.services.api.environment,
        ),
      },
      State: { Running: false },
      Mounts: apiMounts,
      ...clone(apiOverrides),
    },
    postgres: {
      Id: IDS.postgres,
      Config: {
        Labels: {
          "com.docker.compose.project": nodeCompose.name,
          "com.docker.compose.service": "postgres",
        },
        Env: environmentObjectToDockerEntries(
          nodeCompose.services.postgres.environment,
        ),
      },
      State: { Running: true },
      Mounts: [
        {
          Type: "volume",
          Name: PHYSICAL_NAMES.postgres,
          Destination: "/var/lib/postgresql/data",
          RW: true,
        },
      ],
      ...clone(postgresOverrides),
    },
  };
  const byID = { [IDS.api]: containers.api, [IDS.postgres]: containers.postgres };
  const runner = async (args) => {
    calls.push([...args]);
    if (args[0] === "ps") {
      const serviceFilter = args.find((value) =>
        value.startsWith("label=com.docker.compose.service="),
      );
      const serviceName = serviceFilter?.slice(
        "label=com.docker.compose.service=".length,
      );
      return {
        status: 0,
        stdout: listOutput[serviceName] ?? IDS[serviceName] + "\n",
        stderr: "",
      };
    }
    if (args[0] === "inspect") {
      const document = byID[args[1]];
      if (!document) {
        return { status: 1, stdout: "", stderr: "not found" };
      }
      return { status: 0, stdout: JSON.stringify([document]), stderr: "" };
    }
    throw new Error("unexpected docker operation");
  };
  return { calls, containers, runner };
}

function assertReadOnlyDockerCalls(calls) {
  for (const args of calls) {
    assert.ok(args[0] === "ps" || args[0] === "inspect");
  }
  assert.equal(calls.some((args) => args[0] === "ps" && args.includes("-a")), true);
}

async function writePrivateJSON(filePath, value, mode = 0o600) {
  await writeFile(filePath, JSON.stringify(value) + "\n");
  await chmod(filePath, mode);
}

async function withPair(pair, callback) {
  const directory = await mkdtemp(path.join(tmpdir(), "duallane-node-authority-"));
  const composePath = path.join(directory, "go.json");
  const nodeComposePath = path.join(directory, "node.json");
  try {
    await writePrivateJSON(composePath, pair.go);
    await writePrivateJSON(nodeComposePath, pair.node);
    return await callback({ composePath, nodeComposePath, directory });
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

test("accepts the retained stopped Node API singleton with matching authority", async () => {
  const pair = makePair();
  const docker = makeFakeDocker(pair.node);
  await withPair(pair, async (paths) => {
    const result = await verifyNodeAuthority({
      composePath: paths.composePath,
      nodeComposePath: paths.nodeComposePath,
      dockerRunner: docker.runner,
    });
    assert.deepEqual(result, { verified: true });
  });
  assert.equal(docker.containers.api.State.Running, false);
  assertReadOnlyDockerCalls(docker.calls);
});

test("accepts S3 authority and verifies the API read-only file secret", async () => {
  const pair = makePair({ storageDriver: "s3" });
  const docker = makeFakeDocker(pair.node);
  await withPair(pair, async (paths) => {
    assert.deepEqual(
      await verifyNodeAuthority({
        composePath: paths.composePath,
        nodeComposePath: paths.nodeComposePath,
        dockerRunner: docker.runner,
      }),
      { verified: true },
    );
  });
});

test("rejects an explicit non-path-style S3 setting", async () => {
  const pair = makePair({ storageDriver: "s3" });
  pair.go.services.workspace.environment.WORKSPACE_S3_PATH_STYLE = "false";
  const docker = makeFakeDocker(pair.node);
  await withPair(pair, (paths) =>
    assertRejected(
      verifyNodeAuthority({
        composePath: paths.composePath,
        nodeComposePath: paths.nodeComposePath,
        dockerRunner: docker.runner,
      }),
      "storage_authority_unproven",
    ),
  );
  assert.deepEqual(docker.calls, []);
});

test("rejects database drift before any Docker inspection", async () => {
  const pair = makePair({ goDatabase: "other-database" });
  const docker = makeFakeDocker(pair.node);
  await withPair(pair, (paths) =>
    assertRejected(
      verifyNodeAuthority({
        composePath: paths.composePath,
        nodeComposePath: paths.nodeComposePath,
        dockerRunner: docker.runner,
      }),
      "database_authority_changed",
    ),
  );
  assert.deepEqual(docker.calls, []);
});

test("rejects storage drift before any Docker inspection", async () => {
  const pair = makePair();
  pair.go.services.worker.environment.WORKSPACE_STORAGE_LOCAL_MIRROR_WRITE = "true";
  const docker = makeFakeDocker(pair.node);
  await withPair(pair, (paths) =>
    assertRejected(
      verifyNodeAuthority({
        composePath: paths.composePath,
        nodeComposePath: paths.nodeComposePath,
        dockerRunner: docker.runner,
      }),
      "storage_authority_changed",
    ),
  );
  assert.deepEqual(docker.calls, []);
});

test("rejects a changed API data mount", async () => {
  const pair = makePair();
  const docker = makeFakeDocker(pair.node, {
    apiOverrides: {
      Mounts: [
        {
          Type: "volume",
          Name: "foreign-data-volume",
          Destination: "/app/data",
          RW: true,
        },
      ],
    },
  });
  await withPair(pair, (paths) =>
    assertRejected(
      verifyNodeAuthority({
        composePath: paths.composePath,
        nodeComposePath: paths.nodeComposePath,
        dockerRunner: docker.runner,
      }),
      "container_volume_authority_changed",
    ),
  );
});

test("rejects a changed PostgreSQL data mount", async () => {
  const pair = makePair();
  const docker = makeFakeDocker(pair.node, {
    postgresOverrides: {
      Mounts: [
        {
          Type: "volume",
          Name: "foreign-postgres-volume",
          Destination: "/var/lib/postgresql/data",
          RW: true,
        },
      ],
    },
  });
  await withPair(pair, (paths) =>
    assertRejected(
      verifyNodeAuthority({
        composePath: paths.composePath,
        nodeComposePath: paths.nodeComposePath,
        dockerRunner: docker.runner,
      }),
      "container_volume_authority_changed",
    ),
  );
});

test("rejects a planned read-only data volume", async () => {
  const pair = makePair();
  pair.go.services.workspace.volumes[0].read_only = true;
  const docker = makeFakeDocker(pair.node);
  await withPair(pair, (paths) =>
    assertRejected(
      verifyNodeAuthority({
        composePath: paths.composePath,
        nodeComposePath: paths.nodeComposePath,
        dockerRunner: docker.runner,
      }),
      "volume_authority_unproven",
    ),
  );
  assert.deepEqual(docker.calls, []);
});

test("rejects a foreign-owner API even when its service name is selected", async () => {
  const pair = makePair();
  const docker = makeFakeDocker(pair.node, {
    apiOverrides: {
      Config: {
        Labels: {
          "com.docker.compose.project": "foreign-owner",
          "com.docker.compose.service": "api",
        },
        Env: environmentObjectToDockerEntries(
          pair.node.services.api.environment,
        ),
      },
    },
  });
  await withPair(pair, (paths) =>
    assertRejected(
      verifyNodeAuthority({
        composePath: paths.composePath,
        nodeComposePath: paths.nodeComposePath,
        dockerRunner: docker.runner,
      }),
      "container_project_mismatch",
    ),
  );
});

test("rejects a writable credential bind and does not expose its path", async () => {
  const pair = makePair({ storageDriver: "s3" });
  const docker = makeFakeDocker(pair.node, {
    apiOverrides: {
      Mounts: [
        {
          Type: "volume",
          Name: PHYSICAL_NAMES.data,
          Destination: "/app/data",
          RW: true,
        },
        {
          Type: "bind",
          Source: SECRET_FILE,
          Destination: "/run/secrets/workspace-s3",
          RW: true,
          Mode: "rw",
        },
      ],
    },
  });
  await withPair(pair, async (paths) => {
    await assertRejected(
      verifyNodeAuthority({
        composePath: paths.composePath,
        nodeComposePath: paths.nodeComposePath,
        dockerRunner: docker.runner,
      }),
      "container_secret_mount_invalid",
    );
  });
  assert.equal(
    docker.calls.some((args) => args.join(" ").includes(SECRET_FILE)),
    false,
  );
});

test("rejects DATABASE_URL and unsupported PG keys with fixed errors", async (t) => {
  for (const key of ["DATABASE_URL", "PGSERVICE"]) {
    await t.test(key, async () => {
      const pair = makePair();
      pair.node.services.api.environment[key] = "do-not-leak-this-value";
      const docker = makeFakeDocker(pair.node);
      await withPair(pair, async (paths) => {
        await assertRejected(
          verifyNodeAuthority({
            composePath: paths.composePath,
            nodeComposePath: paths.nodeComposePath,
            dockerRunner: docker.runner,
          }),
          "database_authority_unproven",
        );
      });
      assert.deepEqual(docker.calls, []);
    });
  }
});

test("preserves literal double dollars in actual Docker environment values", async () => {
  const pair = makePair({ database: "duallane$$$$database" });
  const docker = makeFakeDocker(pair.node);
  await withPair(pair, async (paths) => {
    assert.deepEqual(
      await verifyNodeAuthority({
        composePath: paths.composePath,
        nodeComposePath: paths.nodeComposePath,
        dockerRunner: docker.runner,
      }),
      { verified: true },
    );
  });
});

test("requires exactly one retained API and rejects zero matches", async () => {
  const pair = makePair();
  const docker = makeFakeDocker(pair.node, { listOutput: { api: "" } });
  await withPair(pair, (paths) =>
    assertRejected(
      verifyNodeAuthority({
        composePath: paths.composePath,
        nodeComposePath: paths.nodeComposePath,
        dockerRunner: docker.runner,
      }),
      "container_singleton_required",
    ),
  );
});

test("CLI rejects unknown options without echoing argument values", () => {
  assert.throws(
    () => parseCLIArguments(["verify", "--unknown", "secret-value"]),
    (error) => {
      assert.ok(error instanceof NodeAuthorityError);
      assert.equal(error.code, "invalid_cli_arguments");
      assert.equal(String(error).includes("secret-value"), false);
      return true;
    },
  );
});

test("requires private 0600 resolved Compose inputs", { skip: process.platform !== "linux" }, async () => {
  const pair = makePair();
  const docker = makeFakeDocker(pair.node);
  await withPair(pair, async (paths) => {
    await chmod(paths.composePath, 0o644);
    await assertRejected(
      verifyNodeAuthority({
        composePath: paths.composePath,
        nodeComposePath: paths.nodeComposePath,
        dockerRunner: docker.runner,
      }),
      "compose_permissions",
    );
  });
});
