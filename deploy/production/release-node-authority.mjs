#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  DrainConfigError,
  readPrivateJSON,
} from "./release-drain-config.mjs";

const DOCKER_TIMEOUT_MS = 10_000;
const MAX_DOCKER_OUTPUT_BYTES = 512 * 1024;
const MAX_ENVIRONMENT_ENTRIES = 256;
const MAX_SECRET_ENTRIES = 32;
const PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/u;
const DOCKER_ID_PATTERN = /^[0-9a-f]{12,64}$/iu;
const FULL_DOCKER_ID_PATTERN = /^[0-9a-f]{64}$/u;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/u;
const SECRET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const CREDENTIALS_PATH_PATTERN = /^\/run\/secrets\/([A-Za-z0-9][A-Za-z0-9_.-]{0,127})$/u;
const SAFE_ABSOLUTE_PATH_PATTERN = /^\/[A-Za-z0-9_./-]+$/u;
const CONNECTION_ENVIRONMENT_KEYS = new Set([
  "PGHOST",
  "PGPORT",
  "PGDATABASE",
  "PGUSER",
  "PGPASSWORD",
  "PGSSLMODE",
]);
const STORAGE_ENVIRONMENT_KEYS = new Set([
  "DUALLANE_DATA_DIR",
  "WORKSPACE_STORAGE_DRIVER",
  "WORKSPACE_STORAGE_LOCAL_READ_FALLBACK",
  "WORKSPACE_STORAGE_LOCAL_MIRROR_WRITE",
  "WORKSPACE_S3_ENDPOINT",
  "WORKSPACE_S3_PUBLIC_ENDPOINT",
  "WORKSPACE_S3_BUCKET",
  "WORKSPACE_S3_REGION",
  "WORKSPACE_S3_CREDENTIALS_FILE",
  "WORKSPACE_S3_PATH_STYLE",
  "WORKSPACE_S3_SIGNED_URL_TTL_SECONDS",
]);
const PG_IMAGE_ENVIRONMENT_KEYS = new Set([
  "PG_MAJOR",
  "PG_VERSION",
  "PG_SHA256",
  "PGDATA",
]);
const API_DATA_TARGET = "/app/data";
const POSTGRES_DATA_TARGET = "/var/lib/postgresql/data";
const SECRET_PREFIX = "/run/secrets/";

export class NodeAuthorityError extends Error {
  constructor(code) {
    super(String(code));
    this.name = "NodeAuthorityError";
    this.code = String(code);
  }
}

function reject(code) {
  throw new NodeAuthorityError(code);
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertRecord(value, code) {
  if (!isRecord(value)) {
    reject(code);
  }
  return value;
}

function assertSafeText(value, code, { allowEmpty = false } = {}) {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > 4096 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    reject(code);
  }
  return value;
}

function assertSafeName(value, code, pattern = NAME_PATTERN) {
  if (typeof value !== "string" || !pattern.test(value)) {
    reject(code);
  }
  return value;
}

function assertSafeAbsolutePath(value, code) {
  if (
    typeof value !== "string" ||
    !SAFE_ABSOLUTE_PATH_PATTERN.test(value) ||
    path.posix.normalize(value) !== value
  ) {
    reject(code);
  }
  return value;
}

function assertSafeProject(value) {
  if (typeof value !== "string" || !PROJECT_NAME_PATTERN.test(value)) {
    reject("invalid_compose_project");
  }
  return value;
}

function composeServices(compose, kind) {
  const services = assertRecord(compose.services, "invalid_" + kind + "_services");
  return services;
}

function requireService(services, serviceName, kind) {
  return assertRecord(
    services[serviceName],
    "missing_" + kind + "_service",
  );
}

function parseEnvironment(raw, code, { decodeComposeDollars = true } = {}) {
  const result = new Map();
  if (Array.isArray(raw)) {
    if (raw.length > MAX_ENVIRONMENT_ENTRIES) {
      reject(code);
    }
    for (const entry of raw) {
      if (typeof entry !== "string") {
        reject(code);
      }
      const separator = entry.indexOf("=");
      if (separator <= 0) {
        reject(code);
      }
      const key = entry.slice(0, separator);
      if (!ENVIRONMENT_KEY_PATTERN.test(key) || result.has(key)) {
        reject(code);
      }
      const value = entry.slice(separator + 1);
      result.set(
        key,
        decodeComposeDollars ? value.replaceAll("$$", "$") : value,
      );
    }
    return result;
  }
  if (!isRecord(raw) || Object.keys(raw).length > MAX_ENVIRONMENT_ENTRIES) {
    reject(code);
  }
  for (const key of Object.keys(raw)) {
    if (!ENVIRONMENT_KEY_PATTERN.test(key) || result.has(key)) {
      reject(code);
    }
    const value = raw[key];
    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      reject(code);
    }
    const text = String(value);
    result.set(
      key,
      decodeComposeDollars ? text.replaceAll("$$", "$") : text,
    );
  }
  return result;
}

function parseContainerEnvironment(raw, code) {
  if (!Array.isArray(raw)) {
    reject(code);
  }
  return parseEnvironment(raw, code, { decodeComposeDollars: false });
}

function assertDatabaseKeys(environment, { allowPostgresImageMetadata = false } = {}) {
  for (const key of environment.keys()) {
    if (
      key === "DATABASE_URL" ||
      key === "PGOPTIONS" ||
      (key.startsWith("PG") &&
        !CONNECTION_ENVIRONMENT_KEYS.has(key) &&
        !(allowPostgresImageMetadata && PG_IMAGE_ENVIRONMENT_KEYS.has(key)))
    ) {
      reject("database_authority_unproven");
    }
  }
  if (
    environment.has("DATABASE_SSL") &&
    environment.get("DATABASE_SSL") !== "false"
  ) {
    reject("database_authority_unproven");
  }
  if (
    environment.has("PGSSLMODE") &&
    environment.get("PGSSLMODE") !== "disable"
  ) {
    reject("database_authority_unproven");
  }
}

function selectedConnection(environment) {
  assertDatabaseKeys(environment);
  const required = ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER"];
  if (required.some((key) => !environment.has(key))) {
    reject("database_authority_unproven");
  }
  const connection = {
    host: environment.get("PGHOST"),
    port: environment.get("PGPORT"),
    database: environment.get("PGDATABASE"),
    user: environment.get("PGUSER"),
  };
  if (
    connection.host !== "postgres" ||
    connection.port !== "5432" ||
    !connection.database ||
    !connection.user
  ) {
    reject("database_authority_unproven");
  }
  for (const value of Object.values(connection)) {
    assertSafeText(value, "database_authority_unproven");
  }
  return Object.freeze(connection);
}

function postgresDatabase(environment) {
  assertDatabaseKeys(environment, { allowPostgresImageMetadata: true });
  const database = environment.get("POSTGRES_DB");
  if (!database) {
    reject("database_authority_unproven");
  }
  assertSafeText(database, "database_authority_unproven");
  if (
    environment.has("PGDATA") &&
    environment.get("PGDATA") !== POSTGRES_DATA_TARGET
  ) {
    reject("database_authority_unproven");
  }
  return database;
}

function sameConnection(left, right) {
  return (
    left.host === right.host &&
    left.port === right.port &&
    left.database === right.database &&
    left.user === right.user
  );
}

function normalizeEndpoint(value) {
  assertSafeText(value, "storage_authority_unproven");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    reject("storage_authority_unproven");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "" && parsed.pathname !== "/")
  ) {
    reject("storage_authority_unproven");
  }
  return parsed.toString().replace(/\/$/u, "");
}

function storageConfiguration(environment) {
  for (const key of environment.keys()) {
    if (
      (key.startsWith("WORKSPACE_STORAGE_") || key.startsWith("WORKSPACE_S3_")) &&
      !STORAGE_ENVIRONMENT_KEYS.has(key)
    ) {
      reject("storage_authority_unproven");
    }
  }
  const driver = environment.get("WORKSPACE_STORAGE_DRIVER");
  const dataDir = environment.get("DUALLANE_DATA_DIR");
  const fallback = environment.get("WORKSPACE_STORAGE_LOCAL_READ_FALLBACK");
  const mirror = environment.get("WORKSPACE_STORAGE_LOCAL_MIRROR_WRITE");
  if (
    !["local", "s3"].includes(driver) ||
    dataDir !== "/app/data" ||
    !["true", "false"].includes(fallback) ||
    !["true", "false"].includes(mirror)
  ) {
    reject("storage_authority_unproven");
  }
  const result = {
    driver,
    dataDir,
    localReadFallback: fallback,
    localMirrorWrite: mirror,
    s3: null,
  };
  if (driver === "s3") {
    const endpoint = environment.get("WORKSPACE_S3_ENDPOINT");
    const bucket = environment.get("WORKSPACE_S3_BUCKET");
    const region = environment.get("WORKSPACE_S3_REGION");
    const credentialsFile = environment.get("WORKSPACE_S3_CREDENTIALS_FILE");
    const pathStyle = environment.get("WORKSPACE_S3_PATH_STYLE");
    if (
      !endpoint ||
      !bucket ||
      !region ||
      !credentialsFile ||
      (pathStyle !== undefined && pathStyle !== "true") ||
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(bucket) ||
      !CREDENTIALS_PATH_PATTERN.test(credentialsFile)
    ) {
      reject("storage_authority_unproven");
    }
    result.s3 = {
      endpoint: normalizeEndpoint(endpoint),
      bucket,
      region: assertSafeText(region, "storage_authority_unproven"),
      credentialsFile,
      pathStyle: true,
    };
  }
  return Object.freeze(result);
}

function sameStorage(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function resolveNamedVolume(compose, service, serviceName, target) {
  if (!Array.isArray(service.volumes) || service.volumes.length > 64) {
    reject("volume_authority_unproven");
  }
  const definitions = assertRecord(
    compose.volumes,
    "volume_authority_unproven",
  );
  const matches = [];
  for (const entry of service.volumes) {
    let source;
    let entryTarget;
    let type;
    let readOnly = false;
    if (typeof entry === "string") {
      const parts = entry.split(":");
      if (parts.length < 2) {
        reject("volume_authority_unproven");
      }
      source = parts[0];
      entryTarget = parts[1];
      type = "volume";
      const options = parts.slice(2).flatMap((part) => part.split(","));
      readOnly = options.includes("ro") || options.includes("readonly");
    } else if (isRecord(entry)) {
      source = entry.source;
      entryTarget = entry.target;
      type = entry.type;
      readOnly = entry.read_only === true || entry.readOnly === true;
    } else {
      reject("volume_authority_unproven");
    }
    if (entryTarget !== target) {
      continue;
    }
    if (readOnly) {
      reject("volume_authority_unproven");
    }
    if (
      type !== "volume" ||
      typeof source !== "string" ||
      !NAME_PATTERN.test(source) ||
      !Object.prototype.hasOwnProperty.call(definitions, source)
    ) {
      reject("volume_authority_unproven");
    }
    const definition = assertRecord(
      definitions[source],
      "volume_authority_unproven",
    );
    const physicalName = definition.name;
    if (typeof physicalName !== "string" || !NAME_PATTERN.test(physicalName)) {
      reject("volume_authority_unproven");
    }
    matches.push(Object.freeze({ source, target, physicalName }));
  }
  if (matches.length !== 1) {
    reject("volume_authority_unproven");
  }
  return matches[0];
}

function parseServiceSecrets(service) {
  if (service.secrets === undefined) {
    return [];
  }
  if (!Array.isArray(service.secrets) || service.secrets.length > MAX_SECRET_ENTRIES) {
    reject("secret_authority_unproven");
  }
  return service.secrets.map((entry) => {
    let source;
    let target;
    if (typeof entry === "string") {
      source = entry;
      target = entry;
    } else if (isRecord(entry)) {
      source = entry.source;
      target = entry.target ?? entry.source;
    } else {
      reject("secret_authority_unproven");
    }
    if (
      typeof source !== "string" ||
      typeof target !== "string" ||
      !SECRET_NAME_PATTERN.test(source) ||
      !SECRET_NAME_PATTERN.test(target)
    ) {
      reject("secret_authority_unproven");
    }
    return { source, target };
  });
}

function resolveFileSecret(compose, service, expectedTarget) {
  const entries = parseServiceSecrets(service);
  const matches = entries.filter((entry) => entry.target === expectedTarget);
  if (matches.length > 1) {
    reject("secret_authority_unproven");
  }
  if (matches.length === 0) {
    return null;
  }
  const definitions = assertRecord(compose.secrets, "secret_authority_unproven");
  const definition = assertRecord(
    definitions[matches[0].source],
    "secret_authority_unproven",
  );
  if (typeof definition.file !== "string") {
    reject("secret_authority_unproven");
  }
  const file = assertSafeAbsolutePath(definition.file, "secret_authority_unproven");
  if (
    definition.external === true ||
    Object.prototype.hasOwnProperty.call(definition, "environment") ||
    Object.prototype.hasOwnProperty.call(definition, "content")
  ) {
    reject("secret_authority_unproven");
  }
  return Object.freeze({
    source: matches[0].source,
    target: SECRET_PREFIX + expectedTarget,
    file,
  });
}

function rejectUnexpectedSecrets(service) {
  if (parseServiceSecrets(service).length > 0) {
    reject("secret_authority_unproven");
  }
}

function assertSameSecret(left, right) {
  if (
    !left ||
    !right ||
    left.source !== right.source ||
    left.target !== right.target ||
    left.file !== right.file
  ) {
    reject("secret_authority_changed");
  }
}

function validateCompose(compose, kind) {
  assertRecord(compose, "invalid_" + kind + "_compose");
  const project = assertSafeProject(compose.name);
  const services = composeServices(compose, kind);
  const api = kind === "node" ? requireService(services, "api", kind) : null;
  const workspace = kind === "go" ? requireService(services, "workspace", kind) : null;
  const worker = kind === "go" ? requireService(services, "worker", kind) : null;
  const migrate = requireService(services, "migrate", kind);
  const postgres = requireService(services, "postgres", kind);
  const apiOrWorkspace = api ?? workspace;
  const primaryEnvironment = parseEnvironment(
    apiOrWorkspace.environment,
    kind + "_primary_environment",
  );
  const connection = selectedConnection(primaryEnvironment);
  const migrateConnection = selectedConnection(
    parseEnvironment(migrate.environment, kind + "_migrate_environment"),
  );
  if (!sameConnection(connection, migrateConnection)) {
    reject("database_authority_changed");
  }
  const database = postgresDatabase(
    parseEnvironment(postgres.environment, kind + "_postgres_environment"),
  );
  if (database !== connection.database) {
    reject("database_authority_changed");
  }
  const storage = storageConfiguration(primaryEnvironment);
  const mounts = {
    data: resolveNamedVolume(compose, apiOrWorkspace, api ? "api" : "workspace", API_DATA_TARGET),
    postgres: resolveNamedVolume(compose, postgres, "postgres", POSTGRES_DATA_TARGET),
  };
  if (worker) {
    const workerEnvironment = parseEnvironment(
      worker.environment,
      "go_worker_environment",
    );
    if (!sameConnection(connection, selectedConnection(workerEnvironment))) {
      reject("database_authority_changed");
    }
    if (!sameStorage(storage, storageConfiguration(workerEnvironment))) {
      reject("storage_authority_changed");
    }
    const workerMount = resolveNamedVolume(
      compose,
      worker,
      "worker",
      API_DATA_TARGET,
    );
    if (
      workerMount.source !== mounts.data.source ||
      workerMount.physicalName !== mounts.data.physicalName
    ) {
      reject("volume_authority_changed");
    }
    mounts.worker = workerMount;
  }
  const configuredCredentialsFile = primaryEnvironment.get(
    "WORKSPACE_S3_CREDENTIALS_FILE",
  );
  if (
    configuredCredentialsFile !== undefined &&
    !CREDENTIALS_PATH_PATTERN.test(configuredCredentialsFile)
  ) {
    reject("secret_authority_unproven");
  }
  const credentialsFile =
    storage.s3?.credentialsFile ?? configuredCredentialsFile ?? null;
  let secret = null;
  if (credentialsFile) {
    const expectedTarget = credentialsFile.slice(SECRET_PREFIX.length);
    secret = resolveFileSecret(compose, apiOrWorkspace, expectedTarget);
    if (!secret) {
      reject("secret_authority_unproven");
    }
    if (worker) {
      const workerSecret = resolveFileSecret(compose, worker, expectedTarget);
      assertSameSecret(secret, workerSecret);
    }
  } else {
    rejectUnexpectedSecrets(apiOrWorkspace);
    if (worker) rejectUnexpectedSecrets(worker);
  }
  return Object.freeze({
    kind,
    project,
    connection,
    database,
    storage,
    mounts: Object.freeze(mounts),
    secret,
  });
}

function compareNodeAndGoPlans(nodePlan, goPlan) {
  if (nodePlan.project !== goPlan.project) {
    reject("project_authority_changed");
  }
  if (!sameConnection(nodePlan.connection, goPlan.connection)) {
    reject("database_authority_changed");
  }
  if (!sameStorage(nodePlan.storage, goPlan.storage)) {
    reject("storage_authority_changed");
  }
  if (
    nodePlan.mounts.data.source !== goPlan.mounts.data.source ||
    nodePlan.mounts.data.physicalName !== goPlan.mounts.data.physicalName ||
    nodePlan.mounts.postgres.source !== goPlan.mounts.postgres.source ||
    nodePlan.mounts.postgres.physicalName !== goPlan.mounts.postgres.physicalName
  ) {
    reject("volume_authority_changed");
  }
  if (nodePlan.secret && goPlan.secret) {
    assertSameSecret(nodePlan.secret, goPlan.secret);
  } else if (
    (!nodePlan.secret && goPlan.secret) ||
    (nodePlan.storage.driver === "s3" && !goPlan.secret)
  ) {
    reject("secret_authority_changed");
  }
}

function parseDockerJSON(stdout, code) {
  if (typeof stdout !== "string" && !Buffer.isBuffer(stdout)) {
    reject(code);
  }
  const bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout, "utf8");
  if (bytes.length > MAX_DOCKER_OUTPUT_BYTES) {
    reject(code);
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    reject(code);
  }
}

async function callDocker(dockerRunner, args, stage) {
  const readOnly = args[0] === "ps" || args[0] === "inspect";
  if (!readOnly) {
    reject("docker_mutation_forbidden");
  }
  let result;
  try {
    result = await dockerRunner(args, stage);
  } catch {
    reject("docker_" + stage + "_failed");
  }
  if (
    !result ||
    result.status !== 0 ||
    (typeof result.stdout !== "string" && !Buffer.isBuffer(result.stdout))
  ) {
    reject("docker_" + stage + "_failed");
  }
  return result.stdout;
}

export function createDockerRunner({
  executable = "docker",
  timeoutMs = DOCKER_TIMEOUT_MS,
} = {}) {
  return async (args) => {
    if (
      !Array.isArray(args) ||
      args.length === 0 ||
      args.some((arg) => typeof arg !== "string")
    ) {
      reject("docker_arguments");
    }
    let result;
    try {
      result = spawnSync(executable, args, {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: MAX_DOCKER_OUTPUT_BYTES,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      reject("docker_unavailable");
    }
    return {
      status: result.status,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
    };
  };
}

function parseContainerID(stdout) {
  if (typeof stdout !== "string" && !Buffer.isBuffer(stdout)) {
    reject("container_singleton_required");
  }
  const text = Buffer.isBuffer(stdout) ? stdout.toString("utf8") : stdout;
  const ids = text
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);
  if (ids.length !== 1 || !DOCKER_ID_PATTERN.test(ids[0])) {
    reject("container_singleton_required");
  }
  return ids[0];
}

async function inspectServiceContainer(dockerRunner, project, serviceName) {
  const listOutput = await callDocker(
    dockerRunner,
    [
      "ps",
      "-a",
      "--filter",
      "label=com.docker.compose.project=" + project,
      "--filter",
      "label=com.docker.compose.service=" + serviceName,
      "--format",
      "{{.ID}}",
    ],
    "container_list",
  );
  const id = parseContainerID(listOutput);
  const inspectOutput = await callDocker(
    dockerRunner,
    ["inspect", id],
    "container_inspect",
  );
  const documents = parseDockerJSON(inspectOutput, "container_inspect_json");
  if (!Array.isArray(documents) || documents.length !== 1) {
    reject("container_inspect_shape");
  }
  const container = assertRecord(documents[0], "container_inspect_shape");
  const labels = assertRecord(container.Config?.Labels, "container_labels_missing");
  if (labels["com.docker.compose.project"] !== project) {
    reject("container_project_mismatch");
  }
  if (labels["com.docker.compose.service"] !== serviceName) {
    reject("container_service_mismatch");
  }
  const state = assertRecord(container.State, "container_state_missing");
  if (typeof state.Running !== "boolean") {
    reject("container_state_missing");
  }
  if (!Array.isArray(container.Mounts)) {
    reject("container_mounts_missing");
  }
  const environment = parseContainerEnvironment(
    container.Config?.Env,
    "container_" + serviceName + "_environment_missing",
  );
  const idFromInspect = container.Id;
  if (
    typeof idFromInspect !== "string" ||
    !FULL_DOCKER_ID_PATTERN.test(idFromInspect) ||
    !idFromInspect.startsWith(id)
  ) {
    reject("container_identity_mismatch");
  }
  return Object.freeze({ container, environment });
}

function actualVolumeMount(container, target) {
  const matches = container.Mounts.filter(
    (mount) => isRecord(mount) && mount.Destination === target,
  );
  if (matches.length !== 1) {
    reject("container_mount_target_required");
  }
  const mount = matches[0];
  if (
    mount.Type !== "volume" ||
    typeof mount.Name !== "string" ||
    !NAME_PATTERN.test(mount.Name) ||
    mount.RW !== true
  ) {
    reject("container_volume_mount_invalid");
  }
  return mount.Name;
}

function actualSecretMount(container, expected) {
  if (!expected) {
    if (
      container.Mounts.some(
        (mount) =>
          isRecord(mount) &&
          typeof mount.Destination === "string" &&
          mount.Destination.startsWith(SECRET_PREFIX),
      )
    ) {
      reject("container_secret_mount_invalid");
    }
    return null;
  }
  const matches = container.Mounts.filter(
    (mount) => isRecord(mount) && mount.Destination === expected.target,
  );
  if (matches.length !== 1) {
    reject("container_secret_mount_required");
  }
  const mount = matches[0];
  if (
    mount.Type !== "bind" ||
    mount.Source !== expected.file ||
    mount.RW !== false
  ) {
    reject("container_secret_mount_invalid");
  }
  return expected;
}

async function verifyWithPlans(nodePlan, goPlan, dockerRunner) {
  compareNodeAndGoPlans(nodePlan, goPlan);
  const api = await inspectServiceContainer(
    dockerRunner,
    nodePlan.project,
    "api",
  );
  const postgres = await inspectServiceContainer(
    dockerRunner,
    nodePlan.project,
    "postgres",
  );
  const actualConnection = selectedConnection(api.environment);
  if (!sameConnection(actualConnection, nodePlan.connection)) {
    reject("container_database_authority_changed");
  }
  if (postgresDatabase(postgres.environment) !== nodePlan.database) {
    reject("container_database_authority_changed");
  }
  const actualStorage = storageConfiguration(api.environment);
  if (!sameStorage(actualStorage, nodePlan.storage)) {
    reject("container_storage_authority_changed");
  }
  if (
    actualVolumeMount(api.container, API_DATA_TARGET) !==
    nodePlan.mounts.data.physicalName
  ) {
    reject("container_volume_authority_changed");
  }
  if (
    actualVolumeMount(postgres.container, POSTGRES_DATA_TARGET) !==
    nodePlan.mounts.postgres.physicalName
  ) {
    reject("container_volume_authority_changed");
  }
  actualSecretMount(api.container, nodePlan.secret);
  return Object.freeze({ verified: true });
}

async function loadPrivateCompose(filePath, prefix) {
  try {
    return await readPrivateJSON(filePath, prefix);
  } catch (error) {
    if (error instanceof DrainConfigError) {
      reject(error.code);
    }
    reject(prefix + "_read_failed");
  }
}

export async function verifyNodeAuthority({
  composePath,
  nodeComposePath,
  dockerRunner = createDockerRunner(),
} = {}) {
  if (typeof composePath !== "string" || typeof nodeComposePath !== "string") {
    reject("compose_path_required");
  }
  const [goCompose, nodeCompose] = await Promise.all([
    loadPrivateCompose(composePath, "compose"),
    loadPrivateCompose(nodeComposePath, "node_compose"),
  ]);
  const nodePlan = validateCompose(nodeCompose, "node");
  const goPlan = validateCompose(goCompose, "go");
  return verifyWithPlans(nodePlan, goPlan, dockerRunner);
}

export function parseCLIArguments(args) {
  if (!Array.isArray(args) || args.length === 0 || args[0] !== "verify") {
    reject("invalid_cli_arguments");
  }
  const result = { command: "verify", compose: null, nodeCompose: null };
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index];
    if (option !== "--compose" && option !== "--node-compose") {
      reject("invalid_cli_arguments");
    }
    const value = args[index + 1];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      reject("invalid_cli_arguments");
    }
    if (option === "--compose") {
      if (result.compose !== null) reject("invalid_cli_arguments");
      result.compose = value;
    } else {
      if (result.nodeCompose !== null) reject("invalid_cli_arguments");
      result.nodeCompose = value;
    }
    index += 1;
  }
  if (result.compose === null || result.nodeCompose === null) {
    reject("invalid_cli_arguments");
  }
  return Object.freeze(result);
}

export async function runCLI(args = process.argv.slice(2)) {
  const options = parseCLIArguments(args);
  const result = await verifyNodeAuthority({
    composePath: options.compose,
    nodeComposePath: options.nodeCompose,
  });
  if (!result?.verified) {
    reject("verification_failed");
  }
  process.stdout.write("release node authority verified\n");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    await runCLI();
  } catch (error) {
    const code = error instanceof NodeAuthorityError
      ? error.code
      : error instanceof DrainConfigError
        ? error.code
        : "operation_failed";
    process.stderr.write(`release node authority rejected: ${code}\n`);
    process.exitCode = 1;
  }
}
