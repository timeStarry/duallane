import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  DrainConfigError,
  RELEASE_CHECK_COMMAND,
  RELEASE_CHECK_ENTRYPOINT,
  RELEASE_CHECK_SERVICE,
  RELEASE_CHECK_USER,
  buildDrainCompose,
  validateReport,
  writeDrainCompose,
} from "../../deploy/production/release-drain-config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const helper = path.join(root, "deploy/production/release-drain-config.mjs");
const workspaceImage = `sha256:${"a".repeat(64)}`;

function validCompose() {
  const workspaceRef = "registry.example/duallane-workspace:old";
  return {
    name: "duallane-synthetic",
    services: {
      postgres: {
        image: "postgres:17",
        networks: {
          private: { aliases: ["postgres"] },
        },
      },
      workspace: {
        image: workspaceRef,
        user: RELEASE_CHECK_USER,
        environment: {
          PGHOST: "postgres",
          PGPORT: "5432",
          PGDATABASE: "duallane",
          PGUSER: "duallane",
          PGPASSWORD: "synthetic-db-password",
          WORKSPACE_STORAGE_DRIVER: "s3",
          WORKSPACE_S3_ENDPOINT: "http://minio.internal:9000",
          WORKSPACE_S3_BUCKET: "duallane",
          WORKSPACE_S3_REGION: "us-east-1",
          WORKSPACE_S3_CREDENTIALS_FILE: "/run/secrets/workspace-s3",
          WORKSPACE_ENABLED: "true",
          WORKSPACE_EMAIL_WORKER_ENABLED: "true",
          WORKSPACE_NTFY_BASE_URL: "https://notify.invalid",
          GITHUB_CLIENT_SECRET: "synthetic-oauth-secret",
          DUALLANE_DATA_DIR: "/app/data",
        },
        networks: {
          private: { aliases: ["workspace"] },
          metrics: { aliases: ["workspace-metrics"] },
        },
        secrets: [
          { source: "workspace-s3", target: "workspace-s3", mode: "0600" },
          { source: "oauth", target: "oauth", mode: "0600" },
        ],
        volumes: [{ type: "volume", source: "duallane-data", target: "/app/data" }],
        ports: [{ target: 8787, published: 8787 }],
      },
      worker: {
        image: workspaceRef,
        user: RELEASE_CHECK_USER,
        environment: { WORKSPACE_ENABLED: "true", WORKER_VALIDATE_ONLY: "false" },
        networks: { private: {} },
      },
      migrate: {
        image: workspaceRef,
        user: RELEASE_CHECK_USER,
        networks: { private: {} },
      },
    },
    networks: {
      private: {
        name: "duallane-private",
        driver: "bridge",
        external: true,
        ipam: { config: [{ subnet: "172.30.0.0/24" }] },
      },
      metrics: { name: "duallane-metrics", internal: true },
    },
    secrets: {
      "workspace-s3": { file: path.join(root, "synthetic-s3-credentials.json") },
      oauth: { file: path.join(root, "synthetic-oauth-secret") },
    },
    volumes: { "duallane-data": { name: "duallane-data" } },
  };
}

function expectCode(callback, code) {
  assert.throws(callback, (error) => error instanceof DrainConfigError && error.code === code);
}

function clone(value) {
  return structuredClone(value);
}

function validReport(driver = "s3") {
  const zero = {
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
  return {
    schema: "duallane.release-check/v1",
    status: "ready",
    scope: "database_and_provider_snapshot",
    snapshot: {
      ready: true,
      readOnly: true,
      snapshotAt: "2026-09-07T00:00:00.123456Z",
      counts: zero,
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
    provider:
      driver === "local"
        ? {
            driver: "local",
            status: "not_applicable",
            code: "provider_not_applicable",
            readOnly: true,
          }
        : {
            driver: "s3",
            status: "ready",
            code: "storage.multipart_quiescent",
            readOnly: true,
          },
  };
}

function runCLI(args) {
  return spawnSync(process.execPath, [helper, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
    maxBuffer: 256 * 1024,
    env: { ...process.env },
  });
}

function runComposeConfig(file, cwd, environment = {}) {
  const result = spawnSync(
    "docker",
    ["compose", "-f", file, "config", "--format", "json"],
    {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 512 * 1024,
      windowsHide: true,
      env: {
        ...process.env,
        COMPOSE_DISABLE_ENV_FILE: "1",
        ...environment,
      },
    },
  );
  if (result.error?.code === "ENOENT") throw new Error("docker_unavailable");
  if (result.status !== 0) throw new Error("compose_config_failed");
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error("compose_config_invalid_json");
  }
}

async function privateFixture(t, value, filename = "compose.json") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "duallane-release-drain-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, filename);
  await writeFile(file, value, { mode: 0o600 });
  await chmod(file, 0o600);
  return { directory, file };
}

test("builds only a bounded release-check service from canonical S3 authority", () => {
  const compose = validCompose();
  const generated = buildDrainCompose({ compose, workspaceImage });
  assert.deepEqual(Object.keys(generated).sort(), ["name", "networks", "secrets", "services"]);
  assert.equal(generated.name, compose.name);
  assert.deepEqual(Object.keys(generated.services), [RELEASE_CHECK_SERVICE]);

  const service = generated.services[RELEASE_CHECK_SERVICE];
  assert.equal(service.image, workspaceImage);
  assert.deepEqual(service.entrypoint, [RELEASE_CHECK_ENTRYPOINT]);
  assert.deepEqual(service.command, [...RELEASE_CHECK_COMMAND]);
  assert.equal(service.restart, "no");
  assert.equal(service.user, RELEASE_CHECK_USER);
  assert.equal(service.read_only, true);
  assert.deepEqual(service.cap_drop, ["ALL"]);
  assert.deepEqual(service.security_opt, ["no-new-privileges:true"]);
  assert.deepEqual(service.networks, ["private"]);
  assert.deepEqual(generated.networks, {
    private: { external: true, name: compose.networks.private.name },
  });
  assert.deepEqual(service.secrets, [compose.services.workspace.secrets[0]]);
  assert.deepEqual(generated.secrets, { "workspace-s3": compose.secrets["workspace-s3"] });

  assert.deepEqual(service.environment, {
    PGHOST: "postgres",
    PGPORT: "5432",
    PGDATABASE: "duallane",
    PGUSER: "duallane",
    PGPASSWORD: "synthetic-db-password",
    WORKSPACE_STORAGE_DRIVER: "s3",
    WORKSPACE_S3_ENDPOINT: "http://minio.internal:9000",
    WORKSPACE_S3_BUCKET: "duallane",
    WORKSPACE_S3_REGION: "us-east-1",
    WORKSPACE_S3_CREDENTIALS_FILE: "/run/secrets/workspace-s3",
  });
  assert.equal("synthetic-oauth-secret" in service.environment, false);
  assert.equal("WORKSPACE_ENABLED" in service.environment, false);
  assert.equal("WORKSPACE_EMAIL_WORKER_ENABLED" in service.environment, false);
  assert.equal("WORKSPACE_NTFY_BASE_URL" in service.environment, false);
  assert.equal("DUALLANE_DATA_DIR" in service.environment, false);
  assert.equal("volumes" in service, false);
  assert.equal("ports" in service, false);
  assert.equal("configs" in service, false);
  assert.equal("volumes" in generated, false);
  assert.equal("configs" in generated, false);
});

test("uses DATABASE_URL as the canonical database authority and local needs no secret", () => {
  const compose = validCompose();
  compose.services.workspace.environment = {
    DATABASE_URL: " postgres://duallane:db-secret@postgres:5432/duallane ",
    PGHOST: "stale-host-that-must-not-win",
    PGUSER: "stale-user-that-must-not-win",
    WORKSPACE_STORAGE_DRIVER: "local",
    WORKSPACE_S3_ENDPOINT: "must-not-copy",
  };
  const generated = buildDrainCompose({ compose, workspaceImage });
  const service = generated.services[RELEASE_CHECK_SERVICE];
  assert.deepEqual(service.environment, {
    DATABASE_URL: "postgres://duallane:db-secret@postgres:5432/duallane",
    WORKSPACE_STORAGE_DRIVER: "local",
  });
  assert.equal("secrets" in service, false);
  assert.equal("secrets" in generated, false);
});

test("rejects missing authority, non-Go shapes, unsupported storage, and ambiguous secrets", () => {
  const missingDatabase = validCompose();
  delete missingDatabase.services.workspace.environment.PGHOST;
  expectCode(() => buildDrainCompose({ compose: missingDatabase, workspaceImage }), "missing_database_authority");

  const missingWorker = validCompose();
  delete missingWorker.services.worker;
  expectCode(() => buildDrainCompose({ compose: missingWorker, workspaceImage }), "compose_service_worker_missing");

  const imageMismatch = validCompose();
  imageMismatch.services.worker.image = "registry.example/other:old";
  expectCode(() => buildDrainCompose({ compose: imageMismatch, workspaceImage }), "compose_go_image_mismatch");

  const badImage = validCompose();
  expectCode(() => buildDrainCompose({ compose: badImage, workspaceImage: "registry.example/workspace:latest" }), "invalid_workspace_image");

  const noSharedNetwork = validCompose();
  noSharedNetwork.services.postgres.networks = { database: {} };
  expectCode(() => buildDrainCompose({ compose: noSharedNetwork, workspaceImage }), "database_network_missing");

  const hostNetwork = validCompose();
  hostNetwork.services.workspace.network_mode = "host";
  expectCode(() => buildDrainCompose({ compose: hostNetwork, workspaceImage }), "workspace_network_mode_unsupported");

  const invalidNetwork = validCompose();
  invalidNetwork.services.workspace.networks = ["private/escape"];
  expectCode(() => buildDrainCompose({ compose: invalidNetwork, workspaceImage }), "workspace_network_invalid");

  const hostDriver = validCompose();
  hostDriver.networks.private.driver = "host";
  expectCode(() => buildDrainCompose({ compose: hostDriver, workspaceImage }), "database_network_driver_unsupported");

  const unnamedNetwork = validCompose();
  delete unnamedNetwork.networks.private.name;
  expectCode(() => buildDrainCompose({ compose: unnamedNetwork, workspaceImage }), "database_network_name_invalid");

  const badDriver = validCompose();
  badDriver.services.workspace.environment.WORKSPACE_STORAGE_DRIVER = "hybrid";
  expectCode(() => buildDrainCompose({ compose: badDriver, workspaceImage }), "storage_driver_unsupported");

  const missingStorage = validCompose();
  delete missingStorage.services.workspace.environment.WORKSPACE_S3_BUCKET;
  expectCode(() => buildDrainCompose({ compose: missingStorage, workspaceImage }), "storage_configuration_incomplete");

  const badCredentialPath = validCompose();
  badCredentialPath.services.workspace.environment.WORKSPACE_S3_CREDENTIALS_FILE = "/etc/secret.json";
  expectCode(() => buildDrainCompose({ compose: badCredentialPath, workspaceImage }), "storage_credentials_path_unsupported");

  const missingSecretMount = validCompose();
  missingSecretMount.services.workspace.secrets = [{ source: "workspace-s3", target: "other" }];
  expectCode(() => buildDrainCompose({ compose: missingSecretMount, workspaceImage }), "storage_credentials_secret_mismatch");

  const environmentSecret = validCompose();
  environmentSecret.secrets["workspace-s3"] = { environment: "S3_CREDENTIALS" };
  expectCode(() => buildDrainCompose({ compose: environmentSecret, workspaceImage }), "storage_secret_source_unsupported");

  const ambiguousSecret = validCompose();
  ambiguousSecret.secrets["workspace-s3"] = {
    file: path.join(root, "synthetic-s3-credentials.json"),
    external: true,
  };
  expectCode(() => buildDrainCompose({ compose: ambiguousSecret, workspaceImage }), "storage_secret_source_unsupported");

  const externalSecret = validCompose();
  externalSecret.secrets["workspace-s3"] = { external: true };
  expectCode(() => buildDrainCompose({ compose: externalSecret, workspaceImage }), "storage_secret_source_unsupported");

  const duplicateEnvironment = validCompose();
  duplicateEnvironment.services.workspace.environment = ["PGHOST=postgres", "PGHOST=other"];
  expectCode(() => buildDrainCompose({ compose: duplicateEnvironment, workspaceImage }), "workspace_environment_duplicate");

  for (const unsupportedKey of ["PGOPTIONS", "PGSERVICE", "PGPASSFILE", "PGSSLROOTCERT"]) {
    const unsupportedPG = validCompose();
    unsupportedPG.services.workspace.environment[unsupportedKey] = "synthetic-unsupported-value";
    expectCode(() => buildDrainCompose({ compose: unsupportedPG, workspaceImage }), "database_environment_unsupported");
  }
});

test("validateReport accepts the exact successful Go command shape without top-level readOnly", () => {
  for (const driver of ["local", "s3"]) {
    const report = validReport(driver);
    const before = JSON.stringify(report);
    assert.equal(validateReport(report, driver), report);
    assert.equal(JSON.stringify(report), before);
  }

  const observationalCounts = validReport("local");
  observationalCounts.snapshot.counts.uploads.staleReserved = 2;
  observationalCounts.snapshot.counts.emailJobs.pending = 3;
  observationalCounts.snapshot.counts.emailJobs.expiredLeases = 4;
  assert.equal(validateReport(observationalCounts, "local"), observationalCounts);
});

test("validateReport rejects false success, extra fields, unsafe counts, and overstated evidence", () => {
  const topLevelReadOnly = validReport();
  topLevelReadOnly.readOnly = true;
  expectCode(() => validateReport(topLevelReadOnly, "s3"), "report_fields");

  const errorReport = validReport();
  errorReport.errorCode = "provider_failed";
  expectCode(() => validateReport(errorReport, "s3"), "report_fields");

  const snapshotNotReadOnly = validReport();
  snapshotNotReadOnly.snapshot.readOnly = false;
  expectCode(() => validateReport(snapshotNotReadOnly, "s3"), "report_snapshot_not_read_only");

  const blocker = validReport();
  blocker.snapshot.blockers = [{ code: "upload_reserved", count: 1 }];
  expectCode(() => validateReport(blocker, "s3"), "report_blockers_mismatch");

  const contradictoryReady = validReport();
  contradictoryReady.snapshot.counts.uploads.reserved = 1;
  expectCode(() => validateReport(contradictoryReady, "s3"), "report_blockers_mismatch");

  const unsafeCount = validReport();
  unsafeCount.snapshot.counts.uploads.reserved = -1;
  expectCode(() => validateReport(unsafeCount, "s3"), "report_count_value_invalid");

  const extraCount = validReport();
  extraCount.snapshot.counts.uploads.extra = 0;
  expectCode(() => validateReport(extraCount, "s3"), "report_count_fields");

  const wrongWriter = validReport();
  wrongWriter.snapshot.writers.status = "proven";
  expectCode(() => validateReport(wrongWriter, "s3"), "report_writers_overstated");

  const wrongProvider = validReport();
  wrongProvider.provider.status = "blocked";
  expectCode(() => validateReport(wrongProvider, "s3"), "report_provider_state_invalid");

  const wrongScope = validReport();
  wrongScope.scope = "durable_database_snapshot";
  expectCode(() => validateReport(wrongScope, "s3"), "report_not_ready");

  expectCode(() => validateReport(validReport("local")), "expected_storage_driver_invalid");
  expectCode(() => validateReport(validReport("local"), "s3"), "report_provider_driver_mismatch");
  expectCode(() => validateReport(validReport("s3"), "local"), "report_provider_driver_mismatch");
});

test("CLI help and errors are fixed-code only", () => {
  const help = runCLI(["--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /release-drain-config\.mjs create/);
  assert.equal(help.stderr, "");

  const invalid = runCLI([
    "create",
    "--compose",
    path.join(root, "synthetic-compose.json"),
    "--workspace-image",
    "not-an-image-id",
    "--output",
    path.join(root, "synthetic-output.json"),
  ]);
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, "");
  assert.equal(invalid.stderr.trim(), "release drain config rejected: invalid_workspace_image");
  assert.equal(invalid.stderr.includes("synthetic-compose"), false);
});

test("private input/output files are bounded, exclusive, and symlink-safe", async (t) => {
  if (process.platform !== "linux") {
    t.skip("private file checks require the production Linux O_NOFOLLOW boundary");
    return;
  }
  const input = await privateFixture(t, `${JSON.stringify(validCompose())}\n`);
  const output = path.join(input.directory, "drain.json");
  const result = await writeDrainCompose({
    composePath: input.file,
    workspaceImage,
    outputPath: output,
  });
  assert.deepEqual(result, {
    status: "completed",
    operation: "create",
    service: RELEASE_CHECK_SERVICE,
    networkCount: 1,
    secretCount: 1,
    byteSize: (await stat(output)).size,
  });
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  const parsed = JSON.parse(await readFile(output, "utf8"));
  assert.equal(parsed.services[RELEASE_CHECK_SERVICE].image, workspaceImage);
  await assert.rejects(
    writeDrainCompose({ composePath: input.file, workspaceImage, outputPath: output }),
    (error) => error?.code === "output_exists",
  );

  await chmod(input.file, 0o644);
  await assert.rejects(
    writeDrainCompose({ composePath: input.file, workspaceImage, outputPath: path.join(input.directory, "mode.json") }),
    (error) => error?.code === "compose_permissions",
  );
  await chmod(input.file, 0o600);

  const inputLink = path.join(input.directory, "compose-link.json");
  await symlink(input.file, inputLink);
  await assert.rejects(
    writeDrainCompose({ composePath: inputLink, workspaceImage, outputPath: path.join(input.directory, "link-output.json") }),
    (error) => error?.code === "compose_symlink",
  );

  const linkedParent = path.join(input.directory, "linked-parent");
  await symlink(input.directory, linkedParent);
  await assert.rejects(
    writeDrainCompose({ composePath: path.join(linkedParent, "compose.json"), workspaceImage, outputPath: path.join(input.directory, "parent-link.json") }),
    (error) => error?.code === "compose_parent_symlink",
  );

  const outputLink = path.join(input.directory, "output-link.json");
  await symlink(input.file, outputLink);
  await assert.rejects(
    writeDrainCompose({ composePath: input.file, workspaceImage, outputPath: outputLink }),
    (error) => error?.code === "output_symlink",
  );

  const malformed = await privateFixture(t, "{not-json}\n", "malformed.json");
  await assert.rejects(
    writeDrainCompose({ composePath: malformed.file, workspaceImage, outputPath: path.join(malformed.directory, "out.json") }),
    (error) => error?.code === "compose_invalid_json",
  );

  const oversized = await privateFixture(t, `${"x".repeat(4 * 1024 * 1024 + 1)}\n`, "oversized.json");
  await assert.rejects(
    writeDrainCompose({ composePath: oversized.file, workspaceImage, outputPath: path.join(oversized.directory, "out.json") }),
    (error) => error?.code === "compose_too_large",
  );
});

test("CLI creates a private config without printing authority values", async (t) => {
  if (process.platform !== "linux") {
    t.skip("CLI creation checks require the production Linux O_NOFOLLOW boundary");
    return;
  }
  const input = await privateFixture(t, `${JSON.stringify(validCompose())}\n`);
  const output = path.join(input.directory, "drain.json");
  const result = runCLI([
    "create",
    "--compose",
    input.file,
    "--workspace-image",
    workspaceImage,
    "--output",
    output,
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    status: "completed",
    operation: "create",
    service: RELEASE_CHECK_SERVICE,
    networkCount: 1,
    secretCount: 1,
    byteSize: (await stat(output)).size,
  });
  assert.equal(result.stdout.includes("synthetic-db-password"), false);
  assert.equal(result.stdout.includes("s3-credentials"), false);
  assert.equal(result.stdout.includes(input.file), false);
  assert.equal((await stat(output)).mode & 0o777, 0o600);
});

test("optional real Compose roundtrip preserves canonical literal dollar authority", async (t) => {
  if (process.env.DUALLANE_RELEASE_DRAIN_COMPOSE_ROUNDTRIP !== "1") {
    t.skip("set DUALLANE_RELEASE_DRAIN_COMPOSE_ROUNDTRIP=1 to run the Docker Compose config-only gate");
    return;
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "duallane-release-drain-compose-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const canonicalPath = path.join(directory, "canonical.yml");
  const generatedPath = path.join(directory, "generated.json");
  const workspaceRef = "registry.example/duallane-workspace:old";
  const syntheticDatabaseURL = "postgres://duallane:literal$$password@postgres:5432/duallane";
  const variable = "${SYNTHETIC_DATABASE_URL}";
  const canonicalYAML = `name: duallane-release-drain-roundtrip
services:
  postgres:
    image: postgres:17
    networks: [private]
  workspace:
    image: ${workspaceRef}
    user: "${RELEASE_CHECK_USER}"
    environment:
      DATABASE_URL: "${variable}"
      PGHOST: postgres
      WORKSPACE_STORAGE_DRIVER: local
    networks: [private]
  worker:
    image: ${workspaceRef}
    user: "${RELEASE_CHECK_USER}"
    networks: [private]
  migrate:
    image: ${workspaceRef}
    user: "${RELEASE_CHECK_USER}"
    networks: [private]
networks:
  private:
    name: duallane-release-drain-roundtrip-private
    driver: bridge
    ipam:
      config:
        - subnet: 172.31.0.0/24
`;
  await writeFile(canonicalPath, canonicalYAML, { mode: 0o600 });
  await chmod(canonicalPath, 0o600);

  const canonical = runComposeConfig(canonicalPath, directory, {
    SYNTHETIC_DATABASE_URL: syntheticDatabaseURL,
  });
  const canonicalURL = canonical.services.workspace.environment.DATABASE_URL;
  assert.equal(typeof canonicalURL, "string");
  assert.match(canonicalURL, /\$/u);

  const generated = buildDrainCompose({ compose: canonical, workspaceImage });
  assert.equal(
    generated.services[RELEASE_CHECK_SERVICE].environment.DATABASE_URL,
    canonicalURL,
  );
  await writeFile(generatedPath, `${JSON.stringify(generated)}\n`, { mode: 0o600 });
  await chmod(generatedPath, 0o600);

  const resolved = runComposeConfig(generatedPath, directory, {
    SYNTHETIC_DATABASE_URL: "must-not-replace-canonical-authority",
  });
  assert.equal(
    resolved.services[RELEASE_CHECK_SERVICE].environment.DATABASE_URL,
    canonicalURL,
  );
});
