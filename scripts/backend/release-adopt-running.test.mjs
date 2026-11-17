import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AdoptionError, adoptRunning, containerEnvironment, observationFingerprint, observedLogging, parseCLI, recoverEnvironment, serializeEnvironment, validateObservedContainers, verifyAdoptionEvidence, verifyRuntimeAgainstCompose } from "../../deploy/production/release-adopt-running.mjs";

const COMMIT = "a".repeat(40);
const PROJECT = "duallane-synthetic-adoption";
const HASH = text => createHash("sha256").update(text).digest("hex");
const clone = value => JSON.parse(JSON.stringify(value));
const escaped = value => value.replaceAll("$", () => "$$");
const literal = value => value.replaceAll("$$", "$");
const platform = process.platform === "linux";
const schemaName = "001_synthetic_schema.sql";
const schemaSQL = "CREATE TABLE synthetic_fixture (id integer);\n";

function fixture(secretPath = "/synthetic/secret.json") {
  const env = {
    PGHOST: "postgres", PGPORT: "5432", PGDATABASE: "duallane", PGUSER: "synthetic", PGPASSWORD: "synthetic-$$-password",
    WORKSPACE_ENABLED: "true", DATABASE_SSL: "false", DATABASE_POOL_MAX: "10", DUALLANE_DATA_DIR: "/app/data",
    DUALLANE_APP_VERSION: "1.0.14", DUALLANE_GIT_COMMIT: COMMIT,
    WORKSPACE_STORAGE_DRIVER: "s3", WORKSPACE_STORAGE_LOCAL_READ_FALLBACK: "false", WORKSPACE_STORAGE_LOCAL_MIRROR_WRITE: "true",
    WORKSPACE_S3_ENDPOINT: "http://minio.internal:9000", WORKSPACE_S3_BUCKET: "synthetic", WORKSPACE_S3_REGION: "us-east-1", WORKSPACE_S3_CREDENTIALS_FILE: "/run/secrets/workspace-s3",
    WORKSPACE_EMAIL_WORKER_ENABLED: "false", WORKSPACE_NTFY_WORKER_ENABLED: "false", WORKSPACE_MAINTENANCE_WORKER_ENABLED: "false", WORKSPACE_ECHO_WORKER_ENABLED: "false",
  };
  const compose = { name: PROJECT, services: {}, networks: { default: { name: `${PROJECT}_default` } }, volumes: { data: { name: `${PROJECT}_data` }, db: { name: `${PROJECT}_postgres` } }, secrets: { "workspace-s3": { file: secretPath } } };
  const images = {};
  const observed = {};
  const names = ["p2p", "workspace", "worker", "web", "postgres"];
  for (const [index, name] of names.entries()) {
    const id = String(index + 1).repeat(64);
    const imageID = "sha256:" + (name === "worker" ? "2" : String(index + 1)).repeat(64);
    const imageLabels = name === "postgres" ? {} : { "org.opencontainers.image.revision": COMMIT, "org.opencontainers.image.version": "1.0.14" };
    const image = { Id: imageID, Config: { Env: ["PATH=/usr/local/bin:/usr/bin:/bin"], Entrypoint: [`/usr/local/bin/${name === "worker" ? "workspace" : name}`], Cmd: null, WorkingDir: "/app", User: name === "web" ? "101:101" : name === "postgres" ? "" : "65532:65532", Labels: imageLabels } };
    if (name === "postgres") image.Config.Env.push("PGDATA=/var/lib/postgresql/data");
    images[imageID] = image;
    let environment = {};
    if (name === "p2p") environment = { DUALLANE_APP_VERSION: "1.0.14", DUALLANE_GIT_COMMIT: COMMIT };
    if (name === "workspace" || name === "worker") environment = clone(env);
    if (name === "worker") {
      environment.DATABASE_POOL_MAX = "4";
      for (const key of Object.keys(environment).filter(key => /WORKER_ENABLED$/.test(key))) environment[key] = "true";
    }
    if (name === "postgres") environment = { POSTGRES_DB: "duallane", POSTGRES_USER: "synthetic", POSTGRES_PASSWORD: "synthetic-$$-password" };
    const service = { image: imageID, user: image.Config.User, environment, read_only: name !== "postgres", restart: "always", logging: { driver: "json-file", options: { "max-size": "10m", "max-file": "5" } }, networks: { default: null } };
    if (name === "worker") service.entrypoint = ["/usr/local/bin/worker"];
    service.healthcheck = { test: ["CMD", "/usr/local/bin/duallane-healthcheck", "http://127.0.0.1:8787/readyz"], interval: "3s", timeout: "4s", retries: 20 };
    if (["workspace", "worker"].includes(name)) {
      service.depends_on = { postgres: { condition: "service_healthy" }, migrate: { condition: "service_completed_successfully" } };
      service.volumes = [{ type: "volume", source: "data", target: "/app/data" }];
      service.secrets = [{ source: "workspace-s3", target: "workspace-s3", mode: 0o600 }];
      service.tmpfs = ["/tmp"];
    }
    if (name === "postgres") service.volumes = [{ type: "volume", source: "db", target: "/var/lib/postgresql/data" }];
    if (name === "web") {
      service.depends_on = { p2p: { condition: "service_healthy" }, workspace: { condition: "service_healthy" } };
      service.ports = [{ target: 8080, published: "8787", protocol: "tcp", host_ip: "127.0.0.1" }];
    }
    compose.services[name] = service;
    const mounts = (service.volumes ?? []).map(m => ({ Type: "volume", Name: compose.volumes[m.source].name, Source: `/var/lib/docker/volumes/${compose.volumes[m.source].name}/_data`, Destination: m.target, RW: true, Propagation: "" }));
    if (service.secrets) mounts.push({ Type: "bind", Source: secretPath, Destination: "/run/secrets/workspace-s3", RW: false, Propagation: "rprivate" });
    observed[name] = {
      Id: id, Name: `/${PROJECT}-${name}-1`, Image: imageID, RestartCount: 0,
      Config: { User: service.user, Hostname: id.slice(0, 12), Env: [...image.Config.Env, ...Object.entries(environment).map(([k, v]) => `${k}=${literal(v)}`)], Labels: { ...imageLabels, "com.docker.compose.project": PROJECT, "com.docker.compose.service": name }, Entrypoint: service.entrypoint ?? image.Config.Entrypoint, Cmd: null, WorkingDir: "/app", Healthcheck: service.healthcheck ? { Test: service.healthcheck.test, Interval: 3e9, Timeout: 4e9, Retries: 20 } : undefined },
      HostConfig: { ReadonlyRootfs: service.read_only, RestartPolicy: { Name: "always", MaximumRetryCount: 0 }, Tmpfs: service.tmpfs ? { "/tmp": "" } : null, LogConfig: { Type: "json-file", Config: service.logging.options }, PortBindings: name === "web" ? { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "8787" }] } : {}, ShmSize: 67108864, OomKillDisable: null, MaskedPaths: ["/proc/acpi", "/proc/asound", "/proc/interrupts", "/proc/kcore", "/proc/keys", "/proc/latency_stats", "/proc/sched_debug", "/proc/scsi", "/proc/timer_list", "/proc/timer_stats", "/sys/devices/virtual/powercap", "/sys/firmware"], ReadonlyPaths: ["/proc/bus", "/proc/fs", "/proc/irq", "/proc/sys", "/proc/sysrq-trigger"] },
      State: { Running: true, Status: "running", Health: { Status: "healthy" }, StartedAt: "2026-11-17T00:00:00Z" },
      Mounts: mounts,
      NetworkSettings: { Networks: { [`${PROJECT}_default`]: { Aliases: [`${PROJECT}-${name}-1`, name], IPAMConfig: null } } },
    };
  }
  compose.services.migrate = { image: observed.workspace.Image, environment: { PGHOST: "postgres", PGPORT: "5432", PGDATABASE: "duallane", PGUSER: "synthetic", PGPASSWORD: "synthetic-$$-password" }, entrypoint: ["/usr/local/bin/duallane-migrate"], restart: "no", depends_on: { postgres: { condition: "service_healthy" } } };
  return { compose, observed, images };
}

function expectCode(callback, code) { assert.throws(callback, error => error instanceof AdoptionError && error.code === code); }

test("observed owners must be unique, healthy, and share the expected release", () => {
  const f = fixture();
  const input = Object.values(f.observed);
  assert.deepEqual(validateObservedContainers(input, { project: PROJECT, expectedPreviousCommit: COMMIT }), f.observed);
  expectCode(() => validateObservedContainers(input.slice(1), { project: PROJECT, expectedPreviousCommit: COMMIT }), "missing_service_owner");
  expectCode(() => validateObservedContainers([...input, input[0]], { project: PROJECT, expectedPreviousCommit: COMMIT }), "duplicate_service_owner");
  const wrong = clone(input); wrong[1].Config.Labels["org.opencontainers.image.revision"] = "b".repeat(40);
  expectCode(() => validateObservedContainers(wrong, { project: PROJECT, expectedPreviousCommit: COMMIT }), "owner_release_mismatch");
  const unhealthy = clone(input); unhealthy[0].State.Health.Status = "unhealthy";
  expectCode(() => validateObservedContainers(unhealthy, { project: PROJECT, expectedPreviousCommit: COMMIT }), "owner_not_healthy");
  const api = clone(input[0]); api.Config.Labels["com.docker.compose.service"] = "api";
  expectCode(() => validateObservedContainers([...input, api], { project: PROJECT, expectedPreviousCommit: COMMIT }), "mixed_node_owner");
});

test("runtime comparison rejects environment, secret, network, privilege and listener drift", () => {
  const f = fixture();
  assert.equal(verifyRuntimeAgainstCompose(f.compose, f.observed, f.images), true);
  const cases = [
    [c => { c.workspace.Config.Env.push("UNKNOWN_SECRET=must-not-be-ignored"); }, "runtime_environment_mismatch_workspace"],
    [c => { c.workspace.Mounts[1].Source = "/other/secret.json"; }, "runtime_mounts_mismatch_workspace"],
    [c => { c.web.HostConfig.PortBindings["8080/tcp"][0].HostIp = "0.0.0.0"; }, "runtime_ports_mismatch_web"],
    [c => { c.worker.HostConfig.Privileged = true; }, "unsupported_host_config"],
    [c => { c.worker.HostConfig.Devices = [{ PathOnHost: "/dev/sda" }]; }, "unsupported_host_config"],
    [c => { c.p2p.NetworkSettings.Networks[`${PROJECT}_default`].Aliases.push("foreign"); }, "runtime_network_aliases_mismatch_p2p"],
    [c => { c.worker.HostConfig.Memory = 1; }, "unsupported_host_config"],
    [c => { c.worker.Config.StopSignal = "SIGKILL"; }, "runtime_stop_signal_mismatch_worker"],
    [c => { c.worker.Config.StopTimeout = 1; }, "runtime_stop_timeout_mismatch_worker"],
    [c => { c.worker.HostConfig.OomKillDisable = true; }, "unsupported_host_config"],
    [c => { c.worker.HostConfig.ShmSize = 1024; }, "runtime_shm_size_mismatch_worker"],
    [c => { c.worker.HostConfig.MaskedPaths = []; }, "unsupported_system_paths"],
    [c => { c.worker.HostConfig.ReadonlyPaths.push("/custom"); }, "unsupported_system_paths"],
    [c => { c.worker.Config.Hostname = "custom"; }, "runtime_hostname_mismatch_worker"],
  ];
  for (const [mutate, code] of cases) {
    const containers = clone(f.observed); mutate(containers);
    expectCode(() => verifyRuntimeAgainstCompose(f.compose, containers, f.images), code);
  }
});

test("Compose null commands inherit image defaults while explicit empty values clear them", () => {
  const inheritedEntry = ["/docker-entrypoint.sh"];
  const inheritedCommand = ["nginx", "-g", "daemon off;"];
  const cases = [
    { entrypoint: undefined, command: undefined, entry: inheritedEntry, cmd: inheritedCommand },
    { entrypoint: null, command: null, entry: inheritedEntry, cmd: inheritedCommand },
    { entrypoint: [], command: null, entry: [], cmd: null },
    { entrypoint: "", command: null, entry: null, cmd: [] },
    { entrypoint: null, command: [], entry: inheritedEntry, cmd: [] },
    { entrypoint: null, command: "", entry: inheritedEntry, cmd: null },
    { entrypoint: ["/wrapper"], command: null, entry: ["/wrapper"], cmd: null },
    { entrypoint: ["/wrapper"], command: [], entry: ["/wrapper"], cmd: [] },
    { entrypoint: ["/wrapper"], command: ["explicit"], entry: ["/wrapper"], cmd: ["explicit"] },
    { entrypoint: [], command: ["explicit"], entry: null, cmd: ["explicit"] },
  ];
  for (const scenario of cases) {
    const f = fixture();
    const service = f.compose.services.web;
    const actual = f.observed.web.Config;
    const base = f.images[f.observed.web.Image].Config;
    base.Entrypoint = inheritedEntry;
    base.Cmd = inheritedCommand;
    service.entrypoint = scenario.entrypoint;
    service.command = scenario.command;
    actual.Entrypoint = scenario.entry;
    actual.Cmd = scenario.cmd;
    assert.equal(verifyRuntimeAgainstCompose(f.compose, f.observed, f.images), true);
    actual.Cmd = ["unexpected-override"];
    expectCode(() => verifyRuntimeAgainstCompose(f.compose, f.observed, f.images), "runtime_command_mismatch_web");
  }
});

test("null optional stop and health fields retain the image defaults", () => {
  const f = fixture();
  const service = f.compose.services.web;
  const actual = f.observed.web.Config;
  const base = f.images[f.observed.web.Image].Config;
  base.StopSignal = "SIGQUIT";
  actual.StopSignal = "SIGQUIT";
  base.StopTimeout = 12;
  actual.StopTimeout = 12;
  base.Healthcheck = clone(actual.Healthcheck);
  service.stop_signal = null;
  service.stop_grace_period = null;
  service.healthcheck = { test: null, interval: null, timeout: null, retries: null, start_period: null, start_interval: null };
  assert.equal(verifyRuntimeAgainstCompose(f.compose, f.observed, f.images), true);
  actual.StopTimeout = 10;
  expectCode(() => verifyRuntimeAgainstCompose(f.compose, f.observed, f.images), "runtime_stop_timeout_mismatch_web");
});

test("Compose build labels may differ from live worker ownership without hiding custom labels", () => {
  const f = fixture();
  const labels = f.images[f.observed.workspace.Image].Config.Labels;
  Object.assign(labels, {
    "com.docker.compose.project": "synthetic-build-project",
    "com.docker.compose.service": "workspace",
    "com.docker.compose.version": "5.1.0",
  });
  f.observed.worker.Config.Labels["com.docker.compose.version"] = "5.1.1";
  assert.equal(f.observed.worker.Config.Labels["com.docker.compose.service"], "worker");
  assert.deepEqual(validateObservedContainers(Object.values(f.observed), { project: PROJECT, expectedPreviousCommit: COMMIT }), f.observed);
  assert.equal(verifyRuntimeAgainstCompose(f.compose, f.observed, f.images), true);
  labels["com.example.runtime-contract"] = "must-be-preserved";
  f.observed.workspace.Config.Labels["com.example.runtime-contract"] = "must-be-preserved";
  expectCode(() => verifyRuntimeAgainstCompose(f.compose, f.observed, f.images), "runtime_labels_mismatch_worker");
  f.observed.worker.Config.Labels["com.example.runtime-contract"] = "must-be-preserved";
  assert.equal(verifyRuntimeAgainstCompose(f.compose, f.observed, f.images), true);
  f.observed.worker.Config.Labels["com.docker.compose.project"] = "foreign-project";
  expectCode(() => validateObservedContainers(Object.values(f.observed), { project: PROJECT, expectedPreviousCommit: COMMIT }), "container_identity_invalid");
});

test("env recovery uses worker enablement and physical mounts without copying unrelated image values", () => {
  const f = fixture();
  const values = recoverEnvironment(f.observed, "/synthetic/production", "${WORKSPACE_ENABLED:-false} ${DUALLANE_APP_VERSION:?required} ${DUALLANE_GIT_COMMIT:?required} ${DATABASE_POOL_MAX:-10}");
  assert.equal(values.WORKSPACE_EMAIL_WORKER_ENABLED, "true");
  assert.equal(values.WORKSPACE_WORKER_DATABASE_POOL_MAX, "4");
  assert.equal(values.DATABASE_POOL_MAX, "10");
  assert.equal(values.POSTGRES_PASSWORD, "synthetic-$-password");
  assert.equal(values.POSTGRES_VOLUME_NAME, `${PROJECT}_postgres`);
  assert.equal(values.WORKSPACE_S3_CREDENTIALS_FILE, "/synthetic/secret.json");
  assert.equal(values.PATH, undefined);
  assert.match(serializeEnvironment(values), /POSTGRES_PASSWORD='synthetic-\$-password'/);
});

test("observed logging preserves supported json-file options and rejects unknown drivers or options", () => {
  assert.deepEqual(observedLogging({ HostConfig: { LogConfig: { Type: "json-file", Config: {} } } }), { driver: "json-file" });
  const options = { "max-size": "10m", "max-file": "5", compress: "true" };
  assert.deepEqual(observedLogging({ HostConfig: { LogConfig: { Type: "json-file", Config: options } } }), { driver: "json-file", options });
  expectCode(() => observedLogging({ HostConfig: { LogConfig: { Type: "syslog", Config: {} } } }), "logging_unsupported");
  expectCode(() => observedLogging({ HostConfig: { LogConfig: { Type: "json-file", Config: { env: "SECRET" } } } }), "logging_options_unsupported");
  expectCode(() => observedLogging({ HostConfig: { LogConfig: { Type: "json-file", Config: { "max-file": "0" } } } }), "logging_options_unsupported");
});

test("state fingerprints ignore health log timestamps but detect restarts and effective changes", () => {
  const f = fixture(); const prior = observationFingerprint(f.observed, f.images);
  const after = clone(f.observed); after.web.State.Health.Log = [{ End: "now" }];
  assert.equal(observationFingerprint(after, f.images), prior);
  after.web.RestartCount++;
  assert.notEqual(observationFingerprint(after, f.images), prior);
});

test("CLI rejects duplicate and missing arguments without reflecting values", () => {
  assert.deepEqual(parseCLI(["verify", "--snapshot", "/tmp/snapshot"]), { verify: "/tmp/snapshot" });
  expectCode(() => parseCLI(["--project-dir", "/one", "--project-dir", "secret-value"]), "invalid_arguments");
  expectCode(() => parseCLI(["--project-dir", "/one"]), "invalid_arguments");
  expectCode(() => containerEnvironment({ Config: { Env: ["KEY=one", "KEY=two"] } }), "container_environment_invalid");
});

test("real Compose roundtrip preserves literal dollars, quotes, backslashes, multiline and empty values", { skip: !platform }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "duallane-adoption-env-"));
  try {
    const values = { ONE: "old$SYNTHETIC:${SYNTHETIC}:$$:end", TWO: "quote'and\\backslash", THREE: "line1\nline2", EMPTY: "", PATH_VALUE: "/safe/path" };
    const env = path.join(dir, "values.env"), config = path.join(dir, "compose.json");
    await writeFile(env, serializeEnvironment(values), { mode: 0o600 });
    await writeFile(config, JSON.stringify({ services: { synthetic: { image: "synthetic:never-run", environment: Object.fromEntries(Object.keys(values).map(k => [k, "${" + k + "}"])) } } }));
    const result = spawnSync("docker", ["compose", "--project-name", "duallane-adoption-env", "--env-file", env, "-f", config, "config", "--format", "json"], { env: { PATH: process.env.PATH, HOME: process.env.HOME, COMPOSE_DISABLE_ENV_FILE: "1" }, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, "Compose must parse the synthetic env");
    const actual = JSON.parse(result.stdout).services.synthetic.environment;
    assert.deepEqual(actual, Object.fromEntries(Object.entries(values).map(([k, v]) => [k, escaped(v)])));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

async function withAdoptionFixture(callback) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "duallane-adoption-"));
  try {
    const projectDir = path.join(dir, "production");
    await mkdir(projectDir, { mode: 0o700 });
    const secretPath = path.join(dir, "secret.json");
    await writeFile(secretPath, '{"accessKey":"synthetic","secretKey":"synthetic"}\n', { mode: 0o600 });
    const f = fixture(secretPath);
    const calls = [];
    let inspectionCount = 0;
    const outputDir = path.join(projectDir, "backups", "production", "observed");
    const variableNames = new Set(Object.values(f.compose.services).flatMap(s => Object.keys(s.environment ?? {})));
    const template = [...variableNames].map(key => "${" + key + ":-}").join("\n");
    const mutate = { finalObservation: null, badSchema: false };
    const runner = (exe, args, options) => {
      calls.push([exe, ...args]);
      if (exe === "docker" && args[0] === "context") return "unix:///synthetic/docker.sock\n";
      if (exe === "docker") {
        assert.equal(args[0], "--host");
        assert.equal(args[1], "unix:///synthetic/docker.sock");
        assert.equal(options.env.DOCKER_HOST, undefined);
        assert.equal(options.env.DOCKER_CONTEXT, undefined);
        args = args.slice(2);
      }
      if (exe === "git") {
        const a = args.slice(2);
        if (a[0] === "ls-tree") return `${schemaName}\n`;
        if (a[0] === "show") {
          if (a[1].endsWith(":package.json")) return '{"version":"1.0.14"}';
          if (a[1].endsWith(`/${schemaName}`)) return schemaSQL;
          return template;
        }
      }
      if (exe === "docker") {
        if (args[0] === "ps") {
          const selected = args.find(v => v.startsWith("label=com.docker.compose.service="))?.split("=").at(-1);
          return selected ? f.observed[selected].Id : Object.values(f.observed).map(c => c.Id).join("\n");
        }
        if (args[0] === "inspect") {
          if (args.length > 2) {
            inspectionCount++;
            const current = clone(f.observed);
            if (inspectionCount > 1) mutate.finalObservation?.(current);
            return JSON.stringify(Object.values(current));
          }
          return JSON.stringify([Object.values(f.observed).find(c => c.Id === args[1])]);
        }
        if (args[0] === "image") return JSON.stringify([f.images[args[2]]]);
        if (args[0] === "compose") {
          const file = args[args.lastIndexOf("-f") + 1];
          return file.endsWith("observed.compose.json") ? readFileSync(file, "utf8") : JSON.stringify(f.compose);
        }
        if (args[0] === "exec") return args[1] === f.observed.postgres.Id ? `${schemaName}\n` : `${mutate.badSchema ? "0".repeat(64) : HASH(schemaSQL)}  ${schemaName}\n`;
        if (args[0] === "volume" && args[1] === "inspect") return JSON.stringify([{ Name: args[2], Driver: "local", CreatedAt: "2026-11-17T00:00:00Z", Labels: { "com.docker.compose.project": PROJECT }, Options: null, Scope: "local" }]);
      }
      throw new Error("unexpected synthetic command");
    };
    await callback({ ...f, projectDir, outputDir, calls, runner, mutate, secretPath, dependencies: { commandRunner: runner, gatewaySmoke: async () => ({ status: "PASS" }), verifyLocalSocket: async () => {} } });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test("adoption captures verified evidence and env without lifecycle Docker calls", { skip: !platform }, async () => withAdoptionFixture(async f => {
  // PostgreSQL predates the newer template's log rotation configuration.
  // Capturing its actual defaults must not alter it or weaken new Web defaults.
  f.observed.postgres.HostConfig.LogConfig.Config = {};
  const result = await adoptRunning({ projectDir: f.projectDir, outputDir: f.outputDir, expectedPreviousCommit: COMMIT, project: PROJECT }, f.dependencies);
  assert.equal(result.status, "PASS");
  const evidence = JSON.parse(await readFile(`${result.snapshotPath}.adoption.json`, "utf8"));
  assert.equal(evidence.historicalReleaseEvidence, "unavailable");
  assert.equal(evidence.source, "observed-running-go");
  const snapshot = JSON.parse(await readFile(result.snapshotPath, "utf8"));
  assert.equal(snapshot.compose["x-duallane-recovery-source"], "observed-running-go");
  assert.deepEqual(snapshot.compose.services.postgres.logging, { driver: "json-file" });
  assert.deepEqual(snapshot.compose.services.web.logging, { driver: "json-file", options: { "max-size": "10m", "max-file": "5" } });
  assert.match(await readFile(path.join(f.projectDir, ".env"), "utf8"), /DUALLANE_LOG_MAX_SIZE=10m\n/);
  assert.equal((await stat(path.join(f.projectDir, ".env"))).mode & 0o777, 0o600);
  assert.equal((await verifyAdoptionEvidence(result.snapshotPath)).status, "PASS");
  const renamed = path.join(f.outputDir, "renamed.snapshot.json");
  await writeFile(renamed, JSON.stringify(snapshot), { mode: 0o600 });
  await assert.rejects(verifyAdoptionEvidence(renamed), { code: "ENOENT" });
  for (const [exe, ...rawArgs] of f.calls) if (exe === "docker") {
    if (rawArgs[0] === "context") continue;
    const args = rawArgs.slice(2);
    assert.ok(["ps", "inspect", "image", "compose", "exec", "volume"].includes(args[0]));
    if (args[0] === "compose") assert.ok(args.includes("config"));
    if (args[0] === "exec") assert.ok(args.at(-1).includes("READ ONLY") || args.at(-1).includes("sha256sum"));
  }
  await writeFile(`${result.snapshotPath}.compose.json`, "{}", { mode: 0o600 });
  await assert.rejects(verifyAdoptionEvidence(result.snapshotPath), error => error.code === "adoption_artifact_changed");
}));

test("adoption leaves env absent when runtime changes or schema bytes differ", { skip: !platform }, async () => {
  for (const kind of ["state", "schema"]) await withAdoptionFixture(async f => {
    if (kind === "state") f.mutate.finalObservation = current => { current.web.State.StartedAt = "2026-11-17T00:10:00Z"; };
    else f.mutate.badSchema = true;
    await assert.rejects(adoptRunning({ projectDir: f.projectDir, outputDir: f.outputDir, expectedPreviousCommit: COMMIT, project: PROJECT }, f.dependencies), error => error.code === (kind === "state" ? "observed_runtime_changed" : "schema_bytes_mismatch"));
    await assert.rejects(stat(path.join(f.projectDir, ".env")), { code: "ENOENT" });
  });
});

test("existing env and symlinked destinations are refused before reading Docker", { skip: !platform }, async () => withAdoptionFixture(async f => {
  const env = path.join(f.projectDir, ".env");
  await symlink(f.secretPath, env);
  await assert.rejects(adoptRunning({ projectDir: f.projectDir, outputDir: f.outputDir, expectedPreviousCommit: COMMIT, project: PROJECT }, { commandRunner: f.runner }), error => error.code === "environment_already_exists");
  assert.equal(f.calls.length, 0);
  await rm(env);
  const linked = path.join(path.dirname(f.projectDir), "linked");
  await symlink(f.projectDir, linked);
  await assert.rejects(adoptRunning({ projectDir: linked, outputDir: f.outputDir, expectedPreviousCommit: COMMIT, project: PROJECT }, { commandRunner: f.runner }), error => error.code === "symlinked_path");
  assert.equal(f.calls.length, 0);
}));

test("current Git Compose templates reconstruct runtime values and retain proxy and adoption provenance", { skip: !platform }, async () => withAdoptionFixture(async f => {
  const names = ["docker-compose.yml", "docker-compose.production.yml", "docker-compose.go-production.yml"];
  const sourceDir = path.join(f.projectDir, "source");
  await mkdir(sourceDir, { mode: 0o700 });
  const sources = {};
  for (const name of names) {
    sources[name] = await readFile(new URL(`../../${name}`, import.meta.url), "utf8");
    await writeFile(path.join(sourceDir, name), sources[name], { mode: 0o600 });
  }
  const original = {
    DUALLANE_APP_VERSION: "1.0.14", DUALLANE_GIT_COMMIT: COMMIT,
    DUALLANE_WEB_BIND: "127.0.0.1", DUALLANE_WEB_PORT: "8787", WORKSPACE_ENABLED: "true",
    POSTGRES_PASSWORD: "synthetic-$:$$:${NAME}:'quote'", POSTGRES_VOLUME_NAME: `${PROJECT}_postgres`,
    POSTGRES_IMAGE: f.observed.postgres.Image, WORKSPACE_STORAGE_DRIVER: "s3", WORKSPACE_S3_CREDENTIALS_FILE: f.secretPath,
    PUBLIC_BASE_URL: "https://synthetic.example", WORKSPACE_SMTP_ENCRYPTION_KEY: "synthetic$not-a-real-key",
    COMPOSE_PROFILES: "github-proxy", V2RAY_IMAGE: `sha256:${"6".repeat(64)}`,
  };
  const sourceEnv = path.join(sourceDir, "original.env");
  await writeFile(sourceEnv, serializeEnvironment(original), { mode: 0o600 });
  const resolve = (envFile, files, profiles = []) => {
    const result = spawnSync("docker", ["compose", "--project-name", PROJECT, "--project-directory", sourceDir, "--env-file", envFile, ...profiles, ...files.flatMap(name => ["-f", name]), "config", "--format", "json"], { env: { PATH: process.env.PATH, HOME: process.env.HOME, COMPOSE_DISABLE_ENV_FILE: "1" }, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, `synthetic source configuration must parse: ${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  const files = names.map(name => path.join(sourceDir, name));
  const prior = resolve(sourceEnv, files);
  for (const [name, c] of Object.entries(f.observed)) c.Config.Env = Object.entries(prior.services[name].environment ?? {}).map(([k, v]) => `${k}=${literal(v)}`);
  f.observed.v2ray = { Image: original.V2RAY_IMAGE };
  const recovered = recoverEnvironment(f.observed, f.projectDir, Object.values(sources).join("\n"));
  const recoveredEnv = path.join(sourceDir, "recovered.env");
  await writeFile(recoveredEnv, serializeEnvironment(recovered), { mode: 0o600 });
  const after = resolve(recoveredEnv, files);
  assert.deepEqual(after, prior);
  after.services.postgres.logging = observedLogging({ HostConfig: { LogConfig: { Type: "json-file", Config: {} } } });
  after["x-duallane-recovery-source"] = "observed-running-go";
  const frozen = path.join(sourceDir, "frozen.json");
  await writeFile(frozen, JSON.stringify(after), { mode: 0o600 });
  const roundtrip = resolve("/dev/null", [frozen], ["--profile", "github-proxy"]);
  assert.deepEqual(roundtrip, after);
  assert.ok(roundtrip.services.v2ray);
  assert.equal(roundtrip["x-duallane-recovery-source"], "observed-running-go");
}));
