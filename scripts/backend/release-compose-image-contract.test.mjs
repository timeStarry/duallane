import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const baseComposeFile = path.join(root, "docker-compose.yml");
const productionComposeFile = path.join(root, "docker-compose.production.yml");
const goComposeFile = path.join(root, "docker-compose.go-production.yml");
const syntheticProject = "duallane-compose-image-contract";
const syntheticVersion = "0.0.0-compose-contract";
const syntheticCommit = "a".repeat(40);
const allowLocalSkipVariable = "DUALLANE_ALLOW_DOCKER_COMPOSE_CONTRACT_SKIP";
const requireDockerVariable = "DUALLANE_REQUIRE_DOCKER_COMPOSE_CONTRACT";
const goServices = Object.freeze(["p2p", "web", "workspace", "worker", "migrate"]);
const expectedGoImages = Object.freeze({
  p2p: `duallane-go-p2p:${syntheticCommit}`,
  web: `duallane-go-web:${syntheticCommit}`,
  workspace: `duallane-go-workspace:${syntheticCommit}`,
  worker: `duallane-go-workspace:${syntheticCommit}`,
  migrate: `duallane-go-workspace:${syntheticCommit}`,
});

function dockerComposeIsAvailable() {
  return spawnSync("docker", ["compose", "version"], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
}

function requireDockerCompose(t) {
  const probe = dockerComposeIsAvailable();
  if (!probe.error && probe.status === 0) return true;

  const runningInCI = process.env.CI === "true" ||
    process.env.GITHUB_ACTIONS === "true" ||
    process.env[requireDockerVariable] === "true";
  if (!runningInCI && process.env[allowLocalSkipVariable] === "true") {
    t.skip(`Docker Compose is unavailable; local skip requires ${allowLocalSkipVariable}=true`);
    return false;
  }

  const detail = probe.error?.message ?? probe.stderr?.trim() ?? `exit ${probe.status}`;
  assert.fail(`Docker Compose is required for this real-config test: ${detail}`);
}

function syntheticEnvironment(credentialsFile, subscriptionFile) {
  const hostKeys = new Set([
    "PATH", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "SystemRoot", "SYSTEMROOT",
    "TEMP", "TMP", "TMPDIR", "DOCKER_CONFIG", "DOCKER_HOST", "DOCKER_CONTEXT",
    "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH",
  ]);
  const environment = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => hostKeys.has(key))),
    COMPOSE_DISABLE_ENV_FILE: "1",
    COMPOSE_PROJECT_NAME: syntheticProject,
    DUALLANE_APP_VERSION: syntheticVersion,
    DUALLANE_GIT_COMMIT: syntheticCommit,
    DUALLANE_DEBIAN_BUILD_MIRROR: "http://deb.debian.org",
    DUALLANE_EMPTY_ROOM_GRACE_MS: "10000",
    DUALLANE_GO_BUILD_PROXY: "https://proxy.golang.org,direct",
    DUALLANE_LOG_MAX_FILE: "5",
    DUALLANE_LOG_MAX_SIZE: "10m",
    DUALLANE_STUN_URLS: "stun:synthetic.invalid:19302",
    DUALLANE_TURN_CREDENTIAL: "synthetic-turn-credential",
    DUALLANE_TURN_SHARED_SECRET: "synthetic-turn-shared-secret",
    DUALLANE_TURN_TTL_SECONDS: "600",
    DUALLANE_TURN_URLS: "",
    DUALLANE_TURN_USERNAME: "synthetic-turn-user",
    DUALLANE_WEB_BIND: "127.0.0.1",
    DUALLANE_WEB_PORT: "18787",
    GITHUB_CLIENT_ID: "synthetic-github-client-id",
    GITHUB_CLIENT_SECRET: "synthetic-github-client-secret",
    GITHUB_OAUTH_TIMEOUT_MS: "8000",
    GITHUB_PROXY_URL: "http://synthetic-github-proxy.invalid",
    NODE_IMAGE: "synthetic-node:22",
    POSTGRES_DB: "synthetic_db",
    POSTGRES_IMAGE: "synthetic-postgres:17",
    POSTGRES_PASSWORD: "synthetic-postgres-password",
    POSTGRES_USER: "synthetic_user",
    POSTGRES_VOLUME_NAME: "duallane-synthetic-postgres",
    PUBLIC_BASE_URL: "http://synthetic.duallane.invalid",
    SESSION_SECRET: "synthetic-session-secret",
    TRUST_PROXY: "true",
    V2RAY_IMAGE: "synthetic-v2ray:latest",
    V2RAY_SUBSCRIPTION_FILE: subscriptionFile,
    WORKSPACE_ECHO_WORKER_ENABLED: "false",
    WORKSPACE_EMAIL_WORKER_ENABLED: "false",
    WORKSPACE_ENABLED: "true",
    WORKSPACE_FRONTEND_URL: "http://synthetic.duallane.invalid",
    WORKSPACE_MAINTENANCE_WORKER_ENABLED: "false",
    WORKSPACE_NTFY_BASE_URL: "https://synthetic-ntfy.invalid",
    WORKSPACE_NTFY_WORKER_ENABLED: "false",
    WORKSPACE_S3_BUCKET: "synthetic-bucket",
    WORKSPACE_S3_CREDENTIALS_FILE: credentialsFile,
    WORKSPACE_S3_ENDPOINT: "http://synthetic-s3.invalid:9000",
    WORKSPACE_S3_PUBLIC_ENDPOINT: "https://synthetic-files.invalid",
    WORKSPACE_S3_REGION: "us-east-1",
    WORKSPACE_S3_SIGNED_URL_TTL_SECONDS: "300",
    WORKSPACE_SMTP_ENCRYPTION_KEY: "synthetic-smtp-encryption-key",
    WORKSPACE_STORAGE_DEDUPE_MODE: "backfill",
    WORKSPACE_STORAGE_DEDUPE_RUN_ID: "synthetic-dedupe-run",
    WORKSPACE_STORAGE_DRIVER: "local",
    WORKSPACE_STORAGE_LOCAL_MIRROR_WRITE: "false",
    WORKSPACE_STORAGE_LOCAL_READ_FALLBACK: "false",
    WORKSPACE_STORAGE_MIGRATION_MODE: "backfill",
    WORKSPACE_STORAGE_MIGRATION_RUN_ID: "synthetic-migration-run",
    WORKSPACE_WORKER_DATABASE_POOL_MAX: "4",
    DATABASE_POOL_MAX: "10",
  };

  // Do not let a caller's Compose selection or dotenv file add state to this
  // read-only contract check. Docker connection settings remain available.
  delete environment.COMPOSE_FILE;
  delete environment.COMPOSE_PROFILES;
  return environment;
}

function composeConfig(environment, files) {
  const args = [
    "compose",
    "--env-file",
    os.devNull,
    "--project-name",
    syntheticProject,
    ...files.flatMap((file) => ["-f", file]),
    "--profile",
    "rollback",
    "config",
    "--format",
    "json",
  ];
  const result = spawnSync("docker", args, {
    cwd: root,
    env: environment,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `docker compose config failed (${result.status}): ${result.stderr.trim()}`,
  );
  assert.ok(result.stdout.trim(), "docker compose config returned no JSON");
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    assert.fail(`docker compose config returned invalid JSON: ${error.message}`);
  }
}

function service(config, name) {
  const value = config.services?.[name];
  assert.ok(value && typeof value === "object", `missing Compose service ${name}`);
  return value;
}

function normalizedDockerfile(value) {
  return String(value ?? "").replaceAll("\\", "/");
}

function assertBuildMetadata(serviceConfig, name) {
  assert.equal(
    serviceConfig.build?.args?.DUALLANE_APP_VERSION,
    syntheticVersion,
    `${name} build must receive the synthetic application version`,
  );
  assert.equal(
    serviceConfig.build?.args?.DUALLANE_GIT_COMMIT,
    syntheticCommit,
    `${name} build must receive the full synthetic commit`,
  );
}

function assertGoImageContract(config) {
  for (const name of goServices) {
    const configured = service(config, name);
    assert.equal(
      Object.prototype.hasOwnProperty.call(configured, "image"),
      true,
      `${name} must have an explicit image in resolved go-full Compose`,
    );
    assert.equal(configured.image, expectedGoImages[name], `${name} image identity changed`);
    assert.match(configured.image, /:[0-9a-f]{40}$/u, `${name} image must be full-SHA scoped`);
    assertBuildMetadata(configured, name);
  }

  const web = service(config, "web");
  assert.equal(web.image, `duallane-go-web:${syntheticCommit}`);
  assert.equal(normalizedDockerfile(web.build?.dockerfile), "deploy/candidate/Dockerfile.web");

  const workspaceImage = service(config, "workspace").image;
  assert.equal(service(config, "worker").image, workspaceImage);
  assert.equal(service(config, "migrate").image, workspaceImage);
}

function dependencyNames(value) {
  if (Array.isArray(value)) return value;
  return Object.keys(value ?? {});
}

function assertNodeDefaultContract(config) {
  const web = service(config, "web");
  const api = service(config, "api");
  const migrate = service(config, "migrate");

  assert.equal(web.image, undefined, "Node-default Web must not gain a Go image");
  assert.equal(api.image, undefined, "Node-default API must remain build-selected");
  assert.equal(migrate.image, undefined, "Node-default migrate must remain build-selected");
  assert.equal(normalizedDockerfile(web.build?.dockerfile), "Dockerfile.web");
  assert.equal(normalizedDockerfile(api.build?.dockerfile), "Dockerfile.api");
  assert.equal(normalizedDockerfile(migrate.build?.dockerfile), "Dockerfile.api");
  assert.ok(dependencyNames(web.depends_on).includes("api"), "Node-default Web must still depend on API");
  for (const name of ["p2p", "workspace", "worker"]) {
    assert.equal(config.services?.[name], undefined, `Node-default must not add Go service ${name}`);
  }
  assert.doesNotMatch(JSON.stringify(config), /duallane-go-/u, "Node-default config must not contain Go image identities");
}

async function withSyntheticFiles(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "duallane-compose-image-contract-"));
  const credentialsFile = path.join(directory, "workspace-s3.json");
  const subscriptionFile = path.join(directory, "v2ray-subscription.txt");
  await writeFile(credentialsFile, '{"accessKey":"synthetic-access-key","secretKey":"synthetic-secret-key"}\n', { mode: 0o600 });
  await writeFile(subscriptionFile, "https://synthetic-subscription.invalid\n", { mode: 0o600 });
  try {
    return await callback({
      directory,
      environment: syntheticEnvironment(credentialsFile, subscriptionFile),
    });
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("duallane-compose-image-contract-"));
    await rm(directory, { recursive: true, force: true });
  }
}

async function writePreFixGoComposeFixture(directory) {
  const source = await readFile(goComposeFile, "utf8");
  const imageLine = source.match(
    /^    image: duallane-go-web:\$\{DUALLANE_GIT_COMMIT:\?full release commit is required\}\r?\n/mu,
  );
  assert.ok(imageLine, "the real Go Compose file must contain the fixed Web image line");
  const fixture = path.join(directory, "docker-compose.go-production.before-web-image.yml");
  const withoutWebImage = source.slice(0, imageLine.index) + source.slice(imageLine.index + imageLine[0].length);
  await writeFile(fixture, withoutWebImage, { mode: 0o600 });
  return fixture;
}

test("real go-full Compose image contract preserves Node default and build metadata", async (t) => {
  if (!requireDockerCompose(t)) return;

  await withSyntheticFiles(({ environment }) => {
    const nodeDefault = composeConfig(environment, [baseComposeFile, productionComposeFile]);
    assertNodeDefaultContract(nodeDefault);

    const goFull = composeConfig(environment, [baseComposeFile, productionComposeFile, goComposeFile]);
    assertGoImageContract(goFull);
    assert.notEqual(goFull.services.web.image, nodeDefault.services.web.image);
  });
});

test("real Compose contract detects the pre-fix missing Go Web image", async (t) => {
  if (!requireDockerCompose(t)) return;

  await withSyntheticFiles(async ({ directory, environment }) => {
    const preFixGoComposeFile = await writePreFixGoComposeFixture(directory);
    const preFix = composeConfig(environment, [baseComposeFile, productionComposeFile, preFixGoComposeFile]);
    assert.equal(preFix.services.web.image, undefined, "the pre-fix fixture must resolve without Web image");
    assert.throws(
      () => assertGoImageContract(preFix),
      /web must have an explicit image/u,
      "the contract must catch the original missing Web image defect",
    );
  });
});
