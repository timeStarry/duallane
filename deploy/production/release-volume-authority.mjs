#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import {
  DrainConfigError,
  readPrivateJSON as readReviewedPrivateJSON,
  writePrivateJSON as writeReviewedPrivateJSON,
} from "./release-drain-config.mjs";

export const VOLUME_AUTHORITY_FORMAT = "duallane.release-volume-authority";
export const VOLUME_AUTHORITY_VERSION = 1;
export const VOLUME_AUTHORITY_SERVICES = Object.freeze([
  "postgres",
  "workspace",
  "worker",
]);
const COMPOSE_CONNECTION_SERVICES = Object.freeze([
  "postgres",
  "workspace",
  "worker",
  "migrate",
]);
export const VOLUME_AUTHORITY_TARGETS = Object.freeze({
  postgres: "/var/lib/postgresql/data",
  workspace: "/app/data",
  worker: "/app/data",
});

const MAX_DOCKER_OUTPUT_BYTES = 8 * 1024 * 1024;
const DOCKER_TIMEOUT_MS = 10_000;
const PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const DOCKER_ID_PATTERN = /^[0-9a-f]{12,64}$/i;
const SAFE_TEXT_MAX = 4096;
const SECRET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const CREDENTIALS_PATH_PATTERN =
  /^\/run\/secrets\/([A-Za-z0-9][A-Za-z0-9_.-]{0,127})$/u;
const SAFE_ABSOLUTE_PATH_PATTERN = /^\/[A-Za-z0-9_./-]+$/u;
const SECRET_PREFIX = "/run/secrets/";
const VOLUME_METADATA_KEYS = Object.freeze([
  "Name",
  "Driver",
  "CreatedAt",
  "Labels",
  "Options",
  "Scope",
]);
const MANIFEST_KEYS = Object.freeze([
  "format",
  "version",
  "composeSha256",
  "project",
  "connections",
  "storage",
  "mounts",
]);
const MOUNT_KEYS = Object.freeze(["source", "target", "name", "volume"]);
const CONNECTION_KEYS = Object.freeze(["host", "port", "database", "user"]);
const STORAGE_KEYS = Object.freeze([
  "driver",
  "dataDir",
  "localReadFallback",
  "localMirrorWrite",
  "s3",
]);
const S3_STORAGE_KEYS = Object.freeze([
  "endpoint",
  "bucket",
  "region",
  "credentialsFile",
  "pathStyle",
]);
const STORAGE_ENV_KEYS = Object.freeze([
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
const CONNECTION_ENV_KEYS = Object.freeze([
  "PGHOST",
  "PGPORT",
  "PGDATABASE",
  "PGUSER",
  "PGPASSWORD",
  "PGSSLMODE",
  "PGSSLROOTCERT",
  "PGSSLCERT",
  "PGSSLKEY",
]);
const POSTGRES_IMAGE_ENV_KEYS = Object.freeze([
  "PG_MAJOR",
  "PG_VERSION",
  "PG_SHA256",
  "PGDATA",
]);

export class VolumeAuthorityError extends Error {
  constructor(code) {
    super(String(code));
    this.name = "VolumeAuthorityError";
    this.code = String(code);
  }
}

function reject(code) {
  throw new VolumeAuthorityError(code);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertRecord(value, code) {
  if (!isRecord(value)) {
    reject(code);
  }
  return value;
}

function assertExactKeys(value, keys, code) {
  assertRecord(value, code);
  const expected = new Set(keys);
  const actual = Object.keys(value);
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) {
    reject(code);
  }
}

function assertSafeText(value, code, { allowEmpty = false } = {}) {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > SAFE_TEXT_MAX ||
    /[\u0000-\u001f\u007f]/u.test(value)
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

function canonicalizeJSON(value) {
  if (Array.isArray(value)) {
    return "[" + value.map((item) => canonicalizeJSON(item)).join(",") + "]";
  }
  if (isRecord(value)) {
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + canonicalizeJSON(value[key]))
        .join(",") +
      "}"
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    reject("non_finite_json");
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    reject("invalid_json_value");
  }
  return serialized;
}

export function canonicalComposeHash(compose) {
  return createHash("sha256")
    .update(canonicalizeJSON(compose), "utf8")
    .digest("hex");
}

function parseEnvironment(service, serviceName) {
  if (Object.prototype.hasOwnProperty.call(service, "env_file")) {
    reject("unproven_database_connection");
  }
  const raw = service.environment;
  const result = new Map();
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry !== "string") {
        reject("invalid_" + serviceName + "_environment");
      }
      const separator = entry.indexOf("=");
      if (separator <= 0) {
        reject("invalid_" + serviceName + "_environment");
      }
      const key = entry.slice(0, separator);
      const value = entry.slice(separator + 1);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || result.has(key)) {
        reject("invalid_" + serviceName + "_environment");
      }
      result.set(key, value.replaceAll("$$", "$"));
    }
    return result;
  }
  if (!isRecord(raw)) {
    reject("invalid_" + serviceName + "_environment");
  }
  for (const key of Object.keys(raw)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || result.has(key)) {
      reject("invalid_" + serviceName + "_environment");
    }
    const value = raw[key];
    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      reject("invalid_" + serviceName + "_environment");
    }
    result.set(key, String(value).replaceAll("$$", "$"));
  }
  return result;
}

function parseContainerEnvironment(raw, serviceName) {
  if (!Array.isArray(raw)) {
    reject("container_" + serviceName + "_environment_missing");
  }
  const result = new Map();
  for (const entry of raw) {
    if (typeof entry !== "string") {
      reject("container_" + serviceName + "_environment_invalid");
    }
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      reject("container_" + serviceName + "_environment_invalid");
    }
    const key = entry.slice(0, separator);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || result.has(key)) {
      reject("container_" + serviceName + "_environment_invalid");
    }
    result.set(key, entry.slice(separator + 1));
  }
  return result;
}

function assertKnownConnectionKeys(
  environment,
  { allowPostgresImageMetadata = false } = {},
) {
  const allowedPostgresKeys = allowPostgresImageMetadata
    ? POSTGRES_IMAGE_ENV_KEYS
    : [];
  for (const key of environment.keys()) {
    if (
      key === "DATABASE_URL" ||
      key === "PGOPTIONS" ||
      (key.startsWith("PG") &&
        !CONNECTION_ENV_KEYS.includes(key) &&
        !allowedPostgresKeys.includes(key))
    ) {
      reject("unproven_database_connection");
    }
  }
}

function assertSupportedDatabaseTransport(environment) {
  if (
    environment.get("DATABASE_SSL") !== undefined &&
    environment.get("DATABASE_SSL") !== "false"
  ) {
    reject("unproven_database_connection");
  }
  if (
    environment.get("PGSSLMODE") !== undefined &&
    environment.get("PGSSLMODE") !== "disable"
  ) {
    reject("unproven_database_connection");
  }
  for (const key of ["PGSSLROOTCERT", "PGSSLCERT", "PGSSLKEY"]) {
    if (environment.has(key)) {
      reject("unproven_database_connection");
    }
  }
}

function assertSelectedConnection(environment, connection, code) {
  assertKnownConnectionKeys(environment);
  assertSupportedDatabaseTransport(environment);
  if (
    environment.get("PGHOST") !== connection.host ||
    environment.get("PGPORT") !== String(connection.port) ||
    environment.get("PGDATABASE") !== connection.database ||
    environment.get("PGUSER") !== connection.user
  ) {
    reject(code);
  }
}

function proveDatabaseConnection(services) {
  const postgresEnv = parseEnvironment(services.postgres, "postgres");
  const database = postgresEnv.get("POSTGRES_DB");
  const user = postgresEnv.get("POSTGRES_USER");
  if (!database || !user) {
    reject("database_name_unproven");
  }
  assertSafeText(database, "database_name_unproven");
  assertSafeText(user, "database_user_unproven");

  const allowedPostgres = new Set([
    "POSTGRES_DB",
    "POSTGRES_USER",
    ...POSTGRES_IMAGE_ENV_KEYS,
  ]);
  for (const key of postgresEnv.keys()) {
    if (
      key === "DATABASE_URL" ||
      key === "PGOPTIONS" ||
      (key.startsWith("PG") && !allowedPostgres.has(key))
    ) {
      reject("unproven_database_connection");
    }
  }
  if (
    postgresEnv.has("PGDATA") &&
    postgresEnv.get("PGDATA") !== "/var/lib/postgresql/data"
  ) {
    reject("postgres_data_path_mismatch");
  }
  assertSupportedDatabaseTransport(postgresEnv);

  const connection = {
    host: "postgres",
    port: 5432,
    database,
    user,
  };
  for (const serviceName of ["workspace", "worker", "migrate"]) {
    const environment = parseEnvironment(services[serviceName], serviceName);
    assertSelectedConnection(
      environment,
      connection,
      "database_connection_mismatch",
    );
  }

  return Object.freeze(connection);
}

function storageValue(environment, key, code, { required = false } = {}) {
  const value = environment.get(key);
  if (value === undefined || value === "") {
    if (required) {
      reject(code);
    }
    return "";
  }
  return assertSafeText(value, code);
}

function normalizeS3Endpoint(value, code) {
  if (value === "") {
    return "";
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    reject(code);
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
    reject(code);
  }
  return parsed.toString().replace(/\/$/u, "");
}

function normalizeS3Bucket(value, code) {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(value)) {
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

function parseServiceSecrets(service) {
  const raw = service.secrets;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 32) {
    reject("storage_s3_secret_unproven");
  }
  return raw.map((entry) => {
    let source;
    let target;
    if (typeof entry === "string") {
      source = entry;
      target = entry;
    } else if (isRecord(entry)) {
      source = entry.source;
      target = entry.target ?? entry.source;
    } else {
      reject("storage_s3_secret_unproven");
    }
    if (
      typeof source !== "string" ||
      typeof target !== "string" ||
      !SECRET_NAME_PATTERN.test(source) ||
      !SECRET_NAME_PATTERN.test(target)
    ) {
      reject("storage_s3_secret_unproven");
    }
    return { source, target };
  });
}

function resolveStorageSecret(compose, service, credentialsFile) {
  const match = CREDENTIALS_PATH_PATTERN.exec(credentialsFile);
  if (!match) {
    reject("storage_s3_credentials_unproven");
  }
  const expectedTarget = match[1];
  const entries = parseServiceSecrets(service);
  const matches = entries.filter((entry) => entry.target === expectedTarget);
  if (matches.length !== 1) {
    reject("storage_s3_secret_unproven");
  }
  const definitions = assertRecord(compose.secrets, "storage_s3_secret_unproven");
  const definition = assertRecord(
    definitions[matches[0].source],
    "storage_s3_secret_unproven",
  );
  if (
    (Object.prototype.hasOwnProperty.call(definition, "external") &&
      definition.external !== false) ||
    Object.prototype.hasOwnProperty.call(definition, "environment") ||
    Object.prototype.hasOwnProperty.call(definition, "content") ||
    definition.external === true ||
    typeof definition.file !== "string"
  ) {
    reject("storage_s3_secret_unproven");
  }
  const file = assertSafeAbsolutePath(
    definition.file,
    "storage_s3_secret_unproven",
  );
  return Object.freeze({
    source: matches[0].source,
    target: expectedTarget,
    destination: SECRET_PREFIX + expectedTarget,
    file,
  });
}

function proveStorageService(environment) {
  for (const key of environment.keys()) {
    if (
      (key.startsWith("WORKSPACE_STORAGE_") ||
        key.startsWith("WORKSPACE_S3_")) &&
      !STORAGE_ENV_KEYS.includes(key)
    ) {
      reject("unproven_storage_configuration");
    }
  }

  const driver = storageValue(environment, "WORKSPACE_STORAGE_DRIVER", "storage_driver_invalid", {
    required: true,
  }).toLowerCase();
  if (driver !== "local" && driver !== "s3") {
    reject("storage_driver_invalid");
  }
  const dataDir = storageValue(environment, "DUALLANE_DATA_DIR", "storage_local_root_unproven", {
    required: true,
  });
  if (dataDir !== "/app/data") {
    reject("storage_local_root_unproven");
  }
  const localReadFallback = storageValue(
    environment,
    "WORKSPACE_STORAGE_LOCAL_READ_FALLBACK",
    "storage_boolean_invalid",
  ) || "false";
  const localMirrorWrite = storageValue(
    environment,
    "WORKSPACE_STORAGE_LOCAL_MIRROR_WRITE",
    "storage_boolean_invalid",
  ) || "false";
  if (!["true", "false"].includes(localReadFallback) || !["true", "false"].includes(localMirrorWrite)) {
    reject("storage_boolean_invalid");
  }

  const result = {
    driver,
    dataDir,
    localReadFallback,
    localMirrorWrite,
    s3: null,
  };
  if (driver === "s3") {
    const endpoint = storageValue(environment, "WORKSPACE_S3_ENDPOINT", "storage_s3_unproven", {
      required: true,
    });
    const bucket = storageValue(environment, "WORKSPACE_S3_BUCKET", "storage_s3_unproven", {
      required: true,
    });
    const region = storageValue(environment, "WORKSPACE_S3_REGION", "storage_s3_unproven", {
      required: true,
    });
    const credentialsFile = storageValue(
      environment,
      "WORKSPACE_S3_CREDENTIALS_FILE",
      "storage_s3_credentials_unproven",
      { required: true },
    );
    if (!CREDENTIALS_PATH_PATTERN.test(credentialsFile)) {
      reject("storage_s3_credentials_unproven");
    }
    const pathStyle = storageValue(
      environment,
      "WORKSPACE_S3_PATH_STYLE",
      "storage_path_style_invalid",
    ) || "true";
    if (pathStyle !== "true") {
      reject("storage_path_style_invalid");
    }
    result.s3 = {
      endpoint: normalizeS3Endpoint(endpoint, "storage_s3_unproven"),
      bucket: normalizeS3Bucket(bucket, "storage_s3_unproven"),
      region,
      credentialsFile,
      pathStyle: true,
    };
  }
  return result;
}

function proveStorageConfiguration(services) {
  const workspace = proveStorageService(
    parseEnvironment(services.workspace, "workspace"),
  );
  const worker = proveStorageService(
    parseEnvironment(services.worker, "worker"),
  );
  if (!compareJSON(workspace, worker)) {
    reject("workspace_worker_storage_mismatch");
  }
  return Object.freeze({ workspace, worker });
}

function assertContainerEnvironment(
  serviceName,
  environment,
  connection,
  storage,
) {
  if (serviceName === "postgres") {
    assertKnownConnectionKeys(environment, {
      allowPostgresImageMetadata: true,
    });
    assertSupportedDatabaseTransport(environment);
    if (
      environment.get("POSTGRES_DB") !== connection.database ||
      environment.get("POSTGRES_USER") !== connection.user ||
      environment.get("PGDATA") !== "/var/lib/postgresql/data"
    ) {
      reject("container_database_environment_mismatch");
    }
    return;
  }
  assertSelectedConnection(
    environment,
    connection,
    "container_database_environment_mismatch",
  );
  const actualStorage = proveStorageService(environment);
  if (!compareJSON(actualStorage, storage)) {
    reject("container_storage_environment_mismatch");
  }
}

function resolveNamedVolume(compose, service, serviceName, target) {
  if (!Array.isArray(service.volumes)) {
    reject("invalid_" + serviceName + "_volumes");
  }
  const definitions = assertRecord(compose.volumes, "invalid_compose_volumes");
  const matches = [];

  for (const entry of service.volumes) {
    let source;
    let entryTarget;
    let readOnly = false;
    let type;

    if (typeof entry === "string") {
      const parts = entry.split(":");
      if (parts.length < 2) {
        continue;
      }
      source = parts[0];
      entryTarget = parts[1];
      const options = parts.slice(2).flatMap((part) => part.split(","));
      readOnly = options.some((option) => option === "ro" || option === "readonly");
      type = "volume";
    } else if (isRecord(entry)) {
      type = entry.type;
      source = entry.source;
      entryTarget = entry.target;
      readOnly = entry.read_only === true || entry.readOnly === true;
    } else {
      reject("invalid_" + serviceName + "_volumes");
    }

    if (entryTarget !== target) {
      continue;
    }
    if (type !== "volume") {
      reject("bind_mount_forbidden");
    }
    assertSafeText(source, "invalid_volume_source");
    if (
      source.startsWith("/") ||
      source === "." ||
      source.startsWith("./") ||
      source === ".." ||
      source.startsWith("../")
    ) {
      reject("bind_mount_forbidden");
    }
    if (readOnly) {
      reject("volume_read_only");
    }
    if (!Object.prototype.hasOwnProperty.call(definitions, source)) {
      reject("logical_volume_missing");
    }
    if (!isRecord(definitions[source])) {
      reject("invalid_compose_volumes");
    }
    assertSafeText(definitions[source].name, "logical_volume_name_missing");
    matches.push({
      source,
      target,
      name: definitions[source].name,
    });
  }

  if (matches.length !== 1) {
    reject("volume_target_required");
  }
  return matches[0];
}

function validateComposeDocument(compose) {
  assertRecord(compose, "invalid_compose_json");
  const project = assertSafeProject(compose.name);
  const services = assertRecord(compose.services, "invalid_compose_services");
  const selectedServices = {};
  for (const serviceName of COMPOSE_CONNECTION_SERVICES) {
    selectedServices[serviceName] = assertRecord(
      services[serviceName],
      "missing_compose_service",
    );
  }
  const mounts = {};
  for (const serviceName of VOLUME_AUTHORITY_SERVICES) {
    mounts[serviceName] = resolveNamedVolume(
      compose,
      selectedServices[serviceName],
      serviceName,
      VOLUME_AUTHORITY_TARGETS[serviceName],
    );
  }
  if (mounts.workspace.source !== mounts.worker.source) {
    reject("workspace_worker_source_mismatch");
  }
  const connection = proveDatabaseConnection(selectedServices);
  const storage = proveStorageConfiguration(selectedServices);
  const secretMounts = {};
  for (const serviceName of ["workspace", "worker"]) {
    secretMounts[serviceName] =
      storage[serviceName].driver === "s3"
        ? resolveStorageSecret(
            compose,
            selectedServices[serviceName],
            storage[serviceName].s3.credentialsFile,
          )
        : null;
  }
  if (!compareJSON(secretMounts.workspace, secretMounts.worker)) {
    reject("workspace_worker_secret_mismatch");
  }
  return Object.freeze({
    project,
    mounts: Object.freeze(mounts),
    connection,
    storage,
    secretMounts: Object.freeze(secretMounts),
  });
}

export const validateCompose = validateComposeDocument;

function parseDockerJSON(stdout, code) {
  if (typeof stdout !== "string" && !Buffer.isBuffer(stdout)) {
    reject(code);
  }
  const bytes = Buffer.isBuffer(stdout)
    ? stdout
    : Buffer.from(stdout, "utf8");
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
  const readOnly =
    args[0] === "ps" ||
    args[0] === "inspect" ||
    (args[0] === "volume" && args[1] === "inspect");
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

function parseContainerIDs(stdout, { allowZero = false } = {}) {
  if (typeof stdout !== "string" && !Buffer.isBuffer(stdout)) {
    reject("container_singleton_required");
  }
  const text = Buffer.isBuffer(stdout) ? stdout.toString("utf8") : stdout;
  const ids = text
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);
  if (allowZero && ids.length === 0) {
    return null;
  }
  if (ids.length !== 1 || !DOCKER_ID_PATTERN.test(ids[0])) {
    reject("container_singleton_required");
  }
  return ids[0];
}

async function inspectServiceContainer(
  dockerRunner,
  project,
  serviceName,
  target,
  { requireRunning = true, allowZero = false, expectedSecret = null } = {},
) {
  const listArguments = [
    "ps",
    "-a",
    "--filter",
    "label=com.docker.compose.project=" + project,
    "--filter",
    "label=com.docker.compose.service=" + serviceName,
    "--format",
    "{{.ID}}",
  ];
  const listOutput = await callDocker(
    dockerRunner,
    listArguments,
    "container_list",
  );
  const id = parseContainerIDs(listOutput, { allowZero });
  if (id === null) {
    return null;
  }
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
  if (typeof container.State?.Running !== "boolean") {
    reject("container_state_invalid");
  }
  if (requireRunning && container.State.Running !== true) {
    reject("container_not_running");
  }
  if (!Array.isArray(container.Mounts)) {
    reject("container_mounts_missing");
  }
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
    !mount.Name ||
    mount.RW !== true
  ) {
    reject("container_volume_mount_invalid");
  }
  assertSafeText(mount.Name, "container_volume_name_invalid");
  if (expectedSecret) {
    const secretMatches = container.Mounts.filter(
      (candidate) =>
        isRecord(candidate) &&
        candidate.Destination === expectedSecret.destination,
    );
    if (secretMatches.length !== 1) {
      reject("container_secret_mount_required");
    }
    const secretMount = secretMatches[0];
    if (
      secretMount.Type !== "bind" ||
      secretMount.Source !== expectedSecret.file ||
      secretMount.RW !== false
    ) {
      reject("container_secret_mount_mismatch");
    }
  }
  const environment = parseContainerEnvironment(container.Config?.Env, serviceName);
  return Object.freeze({ name: mount.Name, environment });
}

function normalizeMetadataMap(value, code) {
  if (value === null) {
    return null;
  }
  assertRecord(value, code);
  const result = {};
  for (const key of Object.keys(value)) {
    assertSafeText(key, code);
    const item = value[key];
    if (typeof item !== "string" && item !== null) {
      reject(code);
    }
    result[key] = item;
  }
  return result;
}

function normalizeVolumeMetadata(value) {
  const metadata = assertRecord(value, "volume_metadata_shape");
  for (const key of VOLUME_METADATA_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(metadata, key)) {
      reject("volume_metadata_shape");
    }
  }
  const result = {
    Name: assertSafeText(metadata.Name, "volume_metadata_name"),
    Driver: assertSafeText(metadata.Driver, "volume_metadata_driver"),
    CreatedAt: assertSafeText(metadata.CreatedAt, "volume_metadata_created"),
    Labels: normalizeMetadataMap(metadata.Labels, "volume_metadata_labels"),
    Options: normalizeMetadataMap(metadata.Options, "volume_metadata_options"),
    Scope: assertSafeText(metadata.Scope, "volume_metadata_scope"),
  };
  return Object.freeze(result);
}

async function inspectVolume(dockerRunner, name) {
  const output = await callDocker(
    dockerRunner,
    ["volume", "inspect", name],
    "volume_inspect",
  );
  const documents = parseDockerJSON(output, "volume_inspect_json");
  if (!Array.isArray(documents) || documents.length !== 1) {
    reject("volume_inspect_shape");
  }
  const metadata = normalizeVolumeMetadata(documents[0]);
  if (metadata.Name !== name) {
    reject("volume_name_mismatch");
  }
  return metadata;
}

async function readAuthorityState(
  compose,
  plan,
  dockerRunner,
  { requireRunning = true, allowWorkspaceWorkerAbsence = false } = {},
) {
  const mounts = {};
  for (const serviceName of VOLUME_AUTHORITY_SERVICES) {
    const containerMount = await inspectServiceContainer(
      dockerRunner,
      plan.project,
      serviceName,
      VOLUME_AUTHORITY_TARGETS[serviceName],
      {
        requireRunning,
        allowZero:
          allowWorkspaceWorkerAbsence && serviceName !== "postgres",
        expectedSecret: plan.secretMounts[serviceName],
      },
    );
    if (!containerMount && serviceName === "postgres") {
      reject("container_singleton_required");
    }
    const name = containerMount?.name ?? plan.mounts[serviceName].name;
    if (name !== plan.mounts[serviceName].name) {
      reject("container_volume_name_mismatch");
    }
    if (containerMount) {
      assertContainerEnvironment(
        serviceName,
        containerMount.environment,
        plan.connection,
        serviceName === "postgres" ? null : plan.storage[serviceName],
      );
    }
    const volume = await inspectVolume(dockerRunner, name);
    mounts[serviceName] = {
      source: plan.mounts[serviceName].source,
      target: plan.mounts[serviceName].target,
      name,
      volume,
    };
  }
  if (mounts.workspace.name !== mounts.worker.name) {
    reject("workspace_worker_name_mismatch");
  }
  return Object.freeze({
    project: plan.project,
    mounts: Object.freeze(mounts),
    connection: plan.connection,
    storage: plan.storage,
    composeSha256: canonicalComposeHash(compose),
  });
}

function manifestMount(value, serviceName) {
  assertExactKeys(value, MOUNT_KEYS, "invalid_authority_manifest_mount");
  assertSafeText(value.source, "invalid_authority_manifest_source");
  if (value.target !== VOLUME_AUTHORITY_TARGETS[serviceName]) {
    reject("invalid_authority_manifest_target");
  }
  assertSafeText(value.name, "invalid_authority_manifest_name");
  const volume = normalizeVolumeMetadata(value.volume);
  if (volume.Name !== value.name) {
    reject("invalid_authority_manifest_name");
  }
  return {
    source: value.source,
    target: value.target,
    name: value.name,
    volume,
  };
}

function validateStorageManifestService(value) {
  assertExactKeys(value, STORAGE_KEYS, "invalid_authority_manifest_storage");
  if (value.driver !== "local" && value.driver !== "s3") {
    reject("invalid_authority_manifest_storage");
  }
  assertSafeText(value.dataDir, "invalid_authority_manifest_storage");
  if (value.dataDir !== "/app/data") {
    reject("invalid_authority_manifest_storage");
  }
  if (!["true", "false"].includes(value.localReadFallback)) {
    reject("invalid_authority_manifest_storage");
  }
  if (!["true", "false"].includes(value.localMirrorWrite)) {
    reject("invalid_authority_manifest_storage");
  }
  if (value.driver === "local") {
    if (value.s3 !== null) {
      reject("invalid_authority_manifest_storage");
    }
    return {
      driver: value.driver,
      dataDir: value.dataDir,
      localReadFallback: value.localReadFallback,
      localMirrorWrite: value.localMirrorWrite,
      s3: null,
    };
  }
  assertExactKeys(value.s3, S3_STORAGE_KEYS, "invalid_authority_manifest_s3");
  const endpoint = normalizeS3Endpoint(
    value.s3.endpoint,
    "invalid_authority_manifest_s3",
  );
  const bucket = normalizeS3Bucket(
    value.s3.bucket,
    "invalid_authority_manifest_s3",
  );
  assertSafeText(value.s3.region, "invalid_authority_manifest_s3");
  assertSafeText(value.s3.credentialsFile, "invalid_authority_manifest_s3");
  if (!CREDENTIALS_PATH_PATTERN.test(value.s3.credentialsFile)) {
    reject("invalid_authority_manifest_s3");
  }
  if (value.s3.pathStyle !== true) {
    reject("invalid_authority_manifest_s3");
  }
  return {
    driver: value.driver,
    dataDir: value.dataDir,
    localReadFallback: value.localReadFallback,
    localMirrorWrite: value.localMirrorWrite,
    s3: {
      endpoint,
      bucket,
      region: value.s3.region,
      credentialsFile: value.s3.credentialsFile,
      pathStyle: true,
    },
  };
}

function validateStorageManifest(value) {
  assertExactKeys(
    value,
    ["workspace", "worker"],
    "invalid_authority_manifest_storage",
  );
  const workspace = validateStorageManifestService(value.workspace);
  const worker = validateStorageManifestService(value.worker);
  if (!compareJSON(workspace, worker)) {
    reject("workspace_worker_storage_mismatch");
  }
  return Object.freeze({ workspace, worker });
}

function validateAuthorityManifest(manifest) {
  assertExactKeys(manifest, MANIFEST_KEYS, "invalid_authority_manifest");
  if (
    manifest.format !== VOLUME_AUTHORITY_FORMAT ||
    manifest.version !== VOLUME_AUTHORITY_VERSION
  ) {
    reject("invalid_authority_manifest_version");
  }
  if (!/^[0-9a-f]{64}$/u.test(manifest.composeSha256)) {
    reject("invalid_authority_manifest_hash");
  }
  const project = assertSafeProject(manifest.project);
  assertExactKeys(
    manifest.connections,
    ["postgres"],
    "invalid_authority_manifest_connection",
  );
  const connection = manifest.connections.postgres;
  assertExactKeys(
    connection,
    CONNECTION_KEYS,
    "invalid_authority_manifest_connection",
  );
  if (connection.host !== "postgres" || connection.port !== 5432) {
    reject("invalid_authority_manifest_connection");
  }
  assertSafeText(connection.database, "invalid_authority_manifest_database");
  assertSafeText(connection.user, "invalid_authority_manifest_user");
  const storage = validateStorageManifest(manifest.storage);

  assertExactKeys(
    manifest.mounts,
    VOLUME_AUTHORITY_SERVICES,
    "invalid_authority_manifest_mounts",
  );
  const mounts = {};
  for (const serviceName of VOLUME_AUTHORITY_SERVICES) {
    mounts[serviceName] = manifestMount(manifest.mounts[serviceName], serviceName);
  }
  if (mounts.workspace.source !== mounts.worker.source) {
    reject("workspace_worker_source_mismatch");
  }
  if (mounts.workspace.name !== mounts.worker.name) {
    reject("workspace_worker_name_mismatch");
  }
  return Object.freeze({
    format: manifest.format,
    version: manifest.version,
    composeSha256: manifest.composeSha256,
    project,
    connections: Object.freeze({ postgres: { ...connection } }),
    storage,
    mounts: Object.freeze(mounts),
  });
}

function compareJSON(left, right) {
  return canonicalizeJSON(left) === canonicalizeJSON(right);
}

function assertManifestMatchesPlan(manifest, plan, code) {
  if (manifest.project !== plan.project) {
    reject(code);
  }
  if (
    manifest.connections.postgres.host !== plan.connection.host ||
    manifest.connections.postgres.port !== plan.connection.port ||
    manifest.connections.postgres.database !== plan.connection.database ||
    manifest.connections.postgres.user !== plan.connection.user
  ) {
    reject(code);
  }
  if (!compareJSON(manifest.storage, plan.storage)) {
    reject(code);
  }
  for (const serviceName of VOLUME_AUTHORITY_SERVICES) {
    const expected = manifest.mounts[serviceName];
    const actual = plan.mounts[serviceName];
    if (
      expected.source !== actual.source ||
      expected.target !== actual.target ||
      expected.name !== actual.name
    ) {
      reject(code);
    }
  }
}

export async function captureVolumeAuthority({
  composePath,
  outputPath,
  dockerRunner = createDockerRunner(),
}) {
  const compose = await readReviewedPrivateJSON(composePath, "compose");
  const plan = validateComposeDocument(compose);
  const state = await readAuthorityState(compose, plan, dockerRunner, {
    requireRunning: true,
    allowWorkspaceWorkerAbsence: false,
  });
  const manifest = {
    format: VOLUME_AUTHORITY_FORMAT,
    version: VOLUME_AUTHORITY_VERSION,
    composeSha256: state.composeSha256,
    project: state.project,
    connections: {
      postgres: { ...state.connection },
    },
    storage: {
      workspace: state.storage.workspace,
      worker: state.storage.worker,
    },
    mounts: {
      postgres: { ...state.mounts.postgres },
      workspace: { ...state.mounts.workspace },
      worker: { ...state.mounts.worker },
    },
  };
  await writeReviewedPrivateJSON(outputPath, manifest);
  return Object.freeze({ status: "captured", manifest: validateAuthorityManifest(manifest) });
}

export async function verifyVolumeAuthority({
  previousComposePath,
  currentComposePath,
  inputPath,
  dockerRunner = createDockerRunner(),
}) {
  const previousCompose = await readReviewedPrivateJSON(
    previousComposePath,
    "previous_compose",
  );
  const currentCompose = await readReviewedPrivateJSON(
    currentComposePath,
    "current_compose",
  );
  const manifestDocument = await readReviewedPrivateJSON(
    inputPath,
    "authority_manifest",
  );
  const manifest = validateAuthorityManifest(manifestDocument);
  if (manifest.composeSha256 !== canonicalComposeHash(previousCompose)) {
    reject("previous_compose_hash_mismatch");
  }
  const previousPlan = validateComposeDocument(previousCompose);
  const currentPlan = validateComposeDocument(currentCompose);
  if (!compareJSON(previousPlan.secretMounts, currentPlan.secretMounts)) {
    reject("secret_authority_changed");
  }
  assertManifestMatchesPlan(manifest, previousPlan, "previous_authority_mismatch");
  assertManifestMatchesPlan(manifest, currentPlan, "current_authority_mismatch");
  const currentState = await readAuthorityState(
    currentCompose,
    currentPlan,
    dockerRunner,
    {
      requireRunning: false,
      allowWorkspaceWorkerAbsence: true,
    },
  );
  if (currentState.project !== manifest.project) {
    reject("current_project_mismatch");
  }
  for (const serviceName of VOLUME_AUTHORITY_SERVICES) {
    const expected = manifest.mounts[serviceName];
    const actual = currentState.mounts[serviceName];
    if (
      actual.source !== expected.source ||
      actual.target !== expected.target ||
      actual.name !== expected.name
    ) {
      reject("logical_volume_authority_changed");
    }
    if (!compareJSON(actual.volume, expected.volume)) {
      reject("volume_metadata_mismatch");
    }
  }
  if (
    currentState.connection.host !== manifest.connections.postgres.host ||
    currentState.connection.port !== manifest.connections.postgres.port ||
    currentState.connection.database !== manifest.connections.postgres.database ||
    currentState.connection.user !== manifest.connections.postgres.user
  ) {
    reject("database_authority_changed");
  }
  if (!compareJSON(currentState.storage, manifest.storage)) {
    reject("storage_authority_changed");
  }
  return Object.freeze({ status: "verified", format: VOLUME_AUTHORITY_FORMAT });
}

function parseOptionArguments(args, command, names) {
  const values = {};
  const allowed = new Set(names);
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (!allowed.has(option) || index + 1 >= args.length || option in values) {
      reject("invalid_cli_arguments");
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      reject("invalid_cli_arguments");
    }
    values[option] = value;
    index += 1;
  }
  if (command === "capture" && (!values["--compose"] || !values["--output"])) {
    reject("invalid_cli_arguments");
  }
  if (
    command === "verify" &&
    (!values["--previous-compose"] ||
      !values["--current-compose"] ||
      !values["--input"])
  ) {
    reject("invalid_cli_arguments");
  }
  return values;
}

export function parseCLIArguments(args) {
  if (!Array.isArray(args) || args.length < 1) {
    reject("invalid_cli_arguments");
  }
  const command = args[0];
  if (command === "capture") {
    const values = parseOptionArguments(args.slice(1), command, [
      "--compose",
      "--output",
    ]);
    return Object.freeze({
      command,
      composePath: values["--compose"],
      outputPath: values["--output"],
    });
  }
  if (command === "verify") {
    const values = parseOptionArguments(args.slice(1), command, [
      "--previous-compose",
      "--current-compose",
      "--input",
    ]);
    return Object.freeze({
      command,
      previousComposePath: values["--previous-compose"],
      currentComposePath: values["--current-compose"],
      inputPath: values["--input"],
    });
  }
  reject("invalid_cli_arguments");
}

export async function main(args = process.argv.slice(2)) {
  try {
    const options = parseCLIArguments(args);
    if (options.command === "capture") {
      await captureVolumeAuthority(options);
    } else {
      await verifyVolumeAuthority(options);
    }
    process.stdout.write(options.command + " ok\n");
    return 0;
  } catch (error) {
    const safeCode =
      error instanceof VolumeAuthorityError || error instanceof DrainConfigError
        ? error.code
        : "operation_failed";
    process.stderr.write("release-volume-authority rejected: " + safeCode + "\n");
    return 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
const modulePath = path.resolve(fileURLToPath(import.meta.url));
if (invokedPath && pathToFileURL(invokedPath).href === pathToFileURL(modulePath).href) {
  const exitCode = await main();
  process.exitCode = exitCode;
}
