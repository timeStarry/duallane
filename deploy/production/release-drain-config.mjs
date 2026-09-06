#!/usr/bin/env node

import { constants as fsConstants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 512 * 1024;
const PRIVATE_MODE = 0o600;
const RELEASE_CHECK_SERVICE = "release-check";
const RELEASE_CHECK_ENTRYPOINT = "/usr/local/bin/duallane-release-check";
const RELEASE_CHECK_COMMAND = Object.freeze(["--check-provider"]);
const RELEASE_CHECK_USER = "65532:65532";
const IMAGE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const NETWORK_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;
const CREDENTIALS_PATH_PATTERN = /^\/run\/secrets\/([A-Za-z0-9][A-Za-z0-9_.-]{0,127})$/;
const SAFE_TEXT_PATTERN = /^[^\u0000-\u001f\u007f]*$/u;

const DATABASE_ENVIRONMENT_KEYS = Object.freeze([
  "DATABASE_URL",
  "PGHOST",
  "PGPORT",
  "PGDATABASE",
  "PGUSER",
  "PGPASSWORD",
  "PGSSLMODE",
  "DATABASE_SSL",
  "DATABASE_SSL_REJECT_UNAUTHORIZED",
]);

const REPORT_COUNT_FIELDS = Object.freeze({
  schema: ["missingItems"],
  uploads: [
    "reserved",
    "staleReserved",
    "missingAttachment",
    "nonPendingAttachment",
    "partRows",
    "partUploadCount",
    "reservedPartRows",
    "unknownStatus",
  ],
  emailJobs: [
    "pending",
    "sending",
    "sent",
    "cancelled",
    "failed",
    "unknownStatus",
    "activeLeases",
    "expiredLeases",
    "sendingMissingLease",
    "sendingExpiredLease",
    "leaseAnomalies",
  ],
  ntfyJobs: [
    "pending",
    "sending",
    "sent",
    "cancelled",
    "failed",
    "unknownStatus",
    "activeLeases",
    "expiredLeases",
    "sendingMissingLease",
    "sendingExpiredLease",
    "leaseAnomalies",
  ],
  emailDigest: [
    "rows",
    "unnotified",
    "notified",
    "activeLeases",
    "expiredLeases",
    "unnotifiedActiveLeases",
    "unnotifiedExpiredLeases",
    "unnotifiedWithoutLease",
    "notifiedWithLease",
  ],
  echoSolicitation: [
    "pending",
    "sent",
    "failed",
    "skipped",
    "unknownStatus",
    "reconcile",
  ],
  echoRelease: [
    "pending",
    "sent",
    "failed",
    "skipped",
    "unknownStatus",
    "reconcile",
  ],
});

const REPORT_TOP_FIELDS = Object.freeze([
  "schema",
  "status",
  "scope",
  "snapshot",
  "provider",
]);
const REPORT_SNAPSHOT_FIELDS = Object.freeze([
  "ready",
  "readOnly",
  "snapshotAt",
  "counts",
  "blockers",
  "writers",
  "provider",
]);

const REPORT_BLOCKER_RULES = Object.freeze([
  ["uploads", "unknownStatus", "upload_unknown_status"],
  ["uploads", "reserved", "upload_reserved"],
  ["uploads", "missingAttachment", "upload_missing_attachment"],
  ["uploads", "nonPendingAttachment", "upload_nonpending_attachment"],
  ["emailJobs", "unknownStatus", "email_unknown_status"],
  ["emailJobs", "sending", "email_sending"],
  ["emailJobs", "leaseAnomalies", "email_lease_anomaly"],
  ["ntfyJobs", "unknownStatus", "ntfy_unknown_status"],
  ["ntfyJobs", "sending", "ntfy_sending"],
  ["ntfyJobs", "leaseAnomalies", "ntfy_lease_anomaly"],
  ["emailDigest", "unnotifiedActiveLeases", "email_digest_active_lease"],
  ["emailDigest", "notifiedWithLease", "email_digest_lease_anomaly"],
  ["echoSolicitation", "unknownStatus", "echo_solicitation_unknown_status"],
  ["echoRelease", "unknownStatus", "echo_release_unknown_status"],
]);

const READ_FLAGS =
  fsConstants.O_RDONLY |
  (fsConstants.O_NOFOLLOW ?? 0) |
  (fsConstants.O_NONBLOCK ?? 0);
const WRITE_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_CREAT |
  fsConstants.O_EXCL |
  (fsConstants.O_NOFOLLOW ?? 0);

class DrainConfigError extends Error {
  constructor(code) {
    super(code);
    this.name = "DrainConfigError";
    this.code = code;
  }
}

function reject(code) {
  throw new DrainConfigError(code);
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireRecord(value, code) {
  if (!isRecord(value)) reject(code);
  return value;
}

function requireExactKeys(value, expected, code) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    reject(code);
  }
}

function cloneJSON(value, code = "invalid_compose") {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    reject(code);
  }
  if (serialized === undefined) reject(code);
  try {
    return JSON.parse(serialized);
  } catch {
    reject(code);
  }
}

function assertSafeText(value, code) {
  if (typeof value !== "string" || !SAFE_TEXT_PATTERN.test(value)) {
    reject(code);
  }
  return value;
}

function assertSupportedPlatform(platform = process.platform) {
  if (platform !== "linux" || typeof fsConstants.O_NOFOLLOW !== "number") {
    reject("linux_only");
  }
}

function assertCanonicalAbsolutePath(value, code) {
  assertSafeText(value, code);
  if (value.length === 0 || !path.isAbsolute(value)) reject(code);
  if (path.normalize(value) !== value) reject(`${code}_not_canonical`);
  return value;
}

function assertImageID(value) {
  if (typeof value !== "string" || !IMAGE_ID_PATTERN.test(value)) {
    reject("invalid_workspace_image");
  }
  return value;
}

function assertEnvironmentKey(value) {
  if (typeof value !== "string" || !ENVIRONMENT_KEY_PATTERN.test(value)) {
    reject("workspace_environment_invalid");
  }
  return value;
}

function assertSecretName(value, code = "secret_name_invalid") {
  if (typeof value !== "string" || !SECRET_NAME_PATTERN.test(value)) {
    reject(code);
  }
  return value;
}

function environmentMap(configured) {
  if (configured === undefined || configured === null) return new Map();
  const entries = [];
  if (Array.isArray(configured)) {
    for (const entry of configured) {
      if (typeof entry !== "string") reject("workspace_environment_invalid");
      const separator = entry.indexOf("=");
      const key = separator < 0 ? entry : entry.slice(0, separator);
      const value = separator < 0 ? null : entry.slice(separator + 1);
      entries.push([key, value]);
    }
  } else if (isRecord(configured)) {
    for (const [key, value] of Object.entries(configured)) {
      if (value !== null && typeof value !== "string") {
        reject("workspace_environment_invalid");
      }
      entries.push([key, value]);
    }
  } else {
    reject("workspace_environment_unsupported");
  }

  const result = new Map();
  for (const [key, value] of entries) {
    assertEnvironmentKey(key);
    if (result.has(key)) reject("workspace_environment_duplicate");
    if (value !== null) assertSafeText(value, "workspace_environment_invalid");
    result.set(key, value);
  }
  return result;
}

function normalizedEnvironmentValue(environment, key, { preserveWhitespace = false } = {}) {
  const value = environment.get(key);
  if (value === null || value === undefined) return undefined;
  if (preserveWhitespace) return value;
  const normalized = value.trim();
  return normalized === "" ? undefined : normalized;
}

function selectDatabaseEnvironment(environment) {
  for (const key of environment.keys()) {
    if (key.startsWith("PG") && !DATABASE_ENVIRONMENT_KEYS.includes(key)) {
      // libpq accepts many PG* variables that ResolveDSN deliberately does
      // not model. Dropping one would silently change connection semantics.
      reject("database_environment_unsupported");
    }
  }
  const databaseURL = normalizedEnvironmentValue(environment, "DATABASE_URL");
  if (databaseURL !== undefined) return { DATABASE_URL: databaseURL };

  const selected = {};
  for (const key of DATABASE_ENVIRONMENT_KEYS) {
    if (key === "DATABASE_URL") continue;
    const value =
      key === "PGPASSWORD"
        ? normalizedEnvironmentValue(environment, key, { preserveWhitespace: true })
        : normalizedEnvironmentValue(environment, key);
    if (value !== undefined) selected[key] = value;
  }
  if (!selected.PGHOST || selected.PGHOST.trim() === "") {
    reject("missing_database_authority");
  }
  return selected;
}

function serviceNetworkNames(service, code) {
  if (service.network_mode !== undefined && service.network_mode !== null) {
    reject(`${code}_network_mode_unsupported`);
  }
  const configured = service.networks;
  if (configured === undefined || configured === null) return ["default"];
  if (Array.isArray(configured)) {
    if (configured.length === 0) reject(`${code}_network_missing`);
    const names = configured.map((name) => {
      if (typeof name !== "string" || !NETWORK_NAME_PATTERN.test(name)) {
        reject(`${code}_network_invalid`);
      }
      return name;
    });
    if (new Set(names).size !== names.length) reject(`${code}_network_duplicate`);
    return names;
  }
  if (!isRecord(configured) || Object.keys(configured).length === 0) {
    reject(`${code}_network_invalid`);
  }
  for (const name of Object.keys(configured)) {
    if (!NETWORK_NAME_PATTERN.test(name)) {
      reject(`${code}_network_invalid`);
    }
  }
  return Object.keys(configured);
}

function normalizeServiceSecrets(configured) {
  if (configured === undefined || configured === null) return [];
  const entries = [];
  if (Array.isArray(configured)) {
    for (const item of configured) {
      if (typeof item === "string") {
        entries.push({ source: item, target: item });
      } else if (isRecord(item)) {
        entries.push(item);
      } else {
        reject("workspace_secrets_invalid");
      }
    }
  } else if (isRecord(configured)) {
    for (const [source, value] of Object.entries(configured)) {
      if (value === null || value === undefined) {
        entries.push({ source, target: source });
      } else if (typeof value === "string") {
        entries.push({ source, target: value });
      } else if (isRecord(value)) {
        entries.push({ source, ...value });
      } else {
        reject("workspace_secrets_invalid");
      }
    }
  } else {
    reject("workspace_secrets_unsupported");
  }

  return entries.map((entry) => {
    const source = assertSecretName(entry.source);
    const target = assertSecretName(entry.target ?? source, "secret_target_invalid");
    const allowed = { source, target };
    for (const key of ["uid", "gid", "mode", "required"]) {
      if (entry[key] !== undefined) {
        const value = entry[key];
        if (
          !(
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean"
          )
        ) {
          reject("workspace_secrets_invalid");
        }
        allowed[key] = value;
      }
    }
    for (const key of Object.keys(entry)) {
      if (!["source", "target", "uid", "gid", "mode", "required"].includes(key)) {
        reject("workspace_secrets_unsupported");
      }
    }
    return allowed;
  });
}

function normalizeTopLevelSecret(secrets, source) {
  if (!isRecord(secrets) || !Object.prototype.hasOwnProperty.call(secrets, source)) {
    reject("storage_secret_missing");
  }
  const configured = requireRecord(secrets[source], "storage_secret_invalid");
  for (const key of ["environment", "content", "driver", "template_driver"]) {
    if (Object.prototype.hasOwnProperty.call(configured, key)) {
      reject("storage_secret_source_unsupported");
    }
  }
  const hasFile = typeof configured.file === "string";
  const external = configured.external === true;
  if (
    Object.prototype.hasOwnProperty.call(configured, "file") &&
    !hasFile
  ) {
    reject("storage_secret_invalid");
  }
  if (external) reject("storage_secret_source_unsupported");
  if (!hasFile) reject("storage_secret_source_unsupported");
  const allowedKeys = ["file", "name", "external"];
  for (const key of Object.keys(configured)) {
    if (!allowedKeys.includes(key)) reject("storage_secret_source_unsupported");
  }
  const result = {};
  if (hasFile) {
    result.file = assertCanonicalAbsolutePath(configured.file, "storage_secret_file");
  }
  if (configured.name !== undefined) {
    result.name = assertSecretName(configured.name, "storage_secret_name_invalid");
  }
  if (configured.external !== undefined) {
    if (typeof configured.external !== "boolean") reject("storage_secret_invalid");
    result.external = configured.external;
  }
  return result;
}

function selectStorageEnvironment(environment, workspace, compose) {
  const rawDriver = normalizedEnvironmentValue(environment, "WORKSPACE_STORAGE_DRIVER");
  const driver = (rawDriver ?? "local").toLowerCase();
  if (driver === "local") {
    return { environment: { WORKSPACE_STORAGE_DRIVER: "local" } };
  }
  if (driver !== "s3") reject("storage_driver_unsupported");

  const endpoint = normalizedEnvironmentValue(environment, "WORKSPACE_S3_ENDPOINT");
  const bucket = normalizedEnvironmentValue(environment, "WORKSPACE_S3_BUCKET");
  const region = normalizedEnvironmentValue(environment, "WORKSPACE_S3_REGION");
  const credentialsFile = normalizedEnvironmentValue(
    environment,
    "WORKSPACE_S3_CREDENTIALS_FILE",
  );
  if (!endpoint || !bucket || !region || !credentialsFile) {
    reject("storage_configuration_incomplete");
  }
  const match = CREDENTIALS_PATH_PATTERN.exec(credentialsFile);
  if (!match) reject("storage_credentials_path_unsupported");
  const target = match[1];
  const serviceSecrets = normalizeServiceSecrets(workspace.secrets);
  const matching = serviceSecrets.filter((entry) => entry.target === target);
  if (matching.length !== 1) reject("storage_credentials_secret_mismatch");
  const secretEntry = matching[0];
  const topLevel = normalizeTopLevelSecret(compose.secrets, secretEntry.source);
  return {
    environment: {
      WORKSPACE_STORAGE_DRIVER: "s3",
      WORKSPACE_S3_ENDPOINT: endpoint,
      WORKSPACE_S3_BUCKET: bucket,
      WORKSPACE_S3_REGION: region,
      WORKSPACE_S3_CREDENTIALS_FILE: credentialsFile,
    },
    secret: {
      source: secretEntry.source,
      entry: secretEntry,
      definition: topLevel,
    },
  };
}

function validateGoCompose(compose) {
  const input = requireRecord(compose, "compose_invalid");
  if (typeof input.name !== "string" || input.name.length === 0) {
    reject("compose_name_missing");
  }
  assertSafeText(input.name, "compose_name_invalid");
  const services = requireRecord(input.services, "compose_services_missing");
  if (Object.prototype.hasOwnProperty.call(services, RELEASE_CHECK_SERVICE)) {
    reject("release_check_service_already_present");
  }
  const requiredServices = ["postgres", "workspace", "worker", "migrate"];
  for (const serviceName of requiredServices) {
    requireRecord(services[serviceName], `compose_service_${serviceName}_missing`);
  }
  const workspace = services.workspace;
  const worker = services.worker;
  const migrate = services.migrate;
  for (const serviceName of ["workspace", "worker", "migrate"]) {
    if (services[serviceName].user !== RELEASE_CHECK_USER) {
      reject(`compose_service_${serviceName}_user_invalid`);
    }
    if (
      typeof services[serviceName].image !== "string" ||
      services[serviceName].image.length === 0
    ) {
      reject(`compose_service_${serviceName}_image_missing`);
    }
  }
  if (worker.image !== workspace.image || migrate.image !== workspace.image) {
    reject("compose_go_image_mismatch");
  }
  const networks = requireRecord(input.networks, "compose_networks_missing");
  const workspaceNetworks = serviceNetworkNames(workspace, "workspace");
  const postgresNetworks = new Set(serviceNetworkNames(services.postgres, "postgres"));
  const sharedNetworks = workspaceNetworks.filter((name) => postgresNetworks.has(name));
  if (sharedNetworks.length === 0) reject("database_network_missing");
  const copiedNetworks = {};
  for (const name of sharedNetworks) {
    if (!Object.prototype.hasOwnProperty.call(networks, name)) {
      reject("database_network_definition_missing");
    }
    const definition = requireRecord(networks[name], "compose_network_invalid");
    if (
      typeof definition.name !== "string" ||
      !NETWORK_NAME_PATTERN.test(definition.name)
    ) {
      reject("database_network_name_invalid");
    }
    if (
      definition.driver !== undefined &&
      definition.driver !== null &&
      definition.driver !== "bridge" &&
      definition.driver !== "default"
    ) {
      reject("database_network_driver_unsupported");
    }
    // The coordinator must inspect this already-existing network. Do not
    // carry creation-only fields such as IPAM into a one-shot Compose file.
    copiedNetworks[name] = { external: true, name: definition.name };
  }
  return { input, services, workspace, copiedNetworks, sharedNetworks };
}

function buildDrainCompose({ compose, workspaceImage }) {
  const validated = validateGoCompose(compose);
  const image = assertImageID(workspaceImage);
  const workspaceEnvironment = environmentMap(validated.workspace.environment);
  const database = selectDatabaseEnvironment(workspaceEnvironment);
  const storage = selectStorageEnvironment(
    workspaceEnvironment,
    validated.workspace,
    validated.input,
  );
  const environment = { ...database, ...storage.environment };
  const service = {
    image,
    entrypoint: [RELEASE_CHECK_ENTRYPOINT],
    command: [...RELEASE_CHECK_COMMAND],
    restart: "no",
    user: RELEASE_CHECK_USER,
    read_only: true,
    cap_drop: ["ALL"],
    security_opt: ["no-new-privileges:true"],
    environment,
    networks: [...validated.sharedNetworks],
  };
  const output = {
    name: validated.input.name,
    services: { [RELEASE_CHECK_SERVICE]: service },
    networks: validated.copiedNetworks,
  };
  if (storage.secret) {
    service.secrets = [storage.secret.entry];
    output.secrets = { [storage.secret.source]: storage.secret.definition };
  }
  return output;
}

function sameIdentity(first, second) {
  return first.dev === second.dev && first.ino === second.ino;
}

function sameFileState(first, second) {
  return ["dev", "ino", "size", "uid", "gid", "mode", "mtimeNs", "ctimeNs"].every(
    (field) => first[field] === second[field],
  );
}

function normalizeFileError(error, prefix) {
  if (error instanceof DrainConfigError) return error;
  switch (error?.code) {
    case "ELOOP":
      return new DrainConfigError(`${prefix}_symlink`);
    case "ENOENT":
    case "ENOTDIR":
      return new DrainConfigError(`${prefix}_missing`);
    case "EACCES":
    case "EPERM":
      return new DrainConfigError(`${prefix}_unreadable`);
    case "EISDIR":
      return new DrainConfigError(`${prefix}_not_regular`);
    default:
      return new DrainConfigError(`${prefix}_unavailable`);
  }
}

async function inspectParentChain(filePath, prefix) {
  // This bounded pre/post check rejects ordinary symlinked or replaced
  // parents. It is not a defense against a process that can race a trusted
  // parent directory after the last check.
  const parsed = path.parse(filePath);
  let current = parsed.root;
  const relative = filePath.slice(parsed.root.length);
  const parts = relative.split(path.sep).filter((part) => part.length > 0);
  try {
    for (let index = 0; index < Math.max(0, parts.length - 1); index += 1) {
      current = path.join(current, parts[index]);
      const info = await lstat(current, { bigint: true });
      if (info.isSymbolicLink()) reject(`${prefix}_parent_symlink`);
      if (!info.isDirectory()) reject(`${prefix}_parent_not_directory`);
    }
  } catch (error) {
    throw normalizeFileError(error, prefix);
  }
}

function assertPrivateMode(info, code) {
  if (!info.isFile()) reject(`${code}_not_regular`);
  const permissionBits =
    typeof info.mode === "bigint" ? info.mode & 0o777n : info.mode & 0o777;
  const expectedBits =
    typeof info.mode === "bigint" ? BigInt(PRIVATE_MODE) : PRIVATE_MODE;
  if (permissionBits !== expectedBits) reject(`${code}_permissions`);
}

async function readBounded(handle) {
  const buffer = Buffer.allocUnsafe(MAX_DOCUMENT_BYTES + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.length - offset,
      null,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

async function assertPathState(filePath, expected, prefix) {
  let current;
  try {
    current = await lstat(filePath, { bigint: true });
  } catch {
    reject(`${prefix}_changed`);
  }
  if (current.isSymbolicLink()) reject(`${prefix}_symlink`);
  if (!current.isFile() || !sameFileState(expected, current)) {
    reject(`${prefix}_changed`);
  }
}

async function readPrivateJSON(filePath, prefix) {
  assertSupportedPlatform();
  const source = assertCanonicalAbsolutePath(filePath, `${prefix}_path`);
  await inspectParentChain(source, prefix);
  let handle;
  let failure;
  let parsed;
  let finished;
  try {
    handle = await open(source, READ_FLAGS);
    const opened = await handle.stat({ bigint: true });
    assertPrivateMode(opened, prefix);
    await assertPathState(source, opened, prefix);
    if (opened.size > BigInt(MAX_DOCUMENT_BYTES)) {
      reject(`${prefix}_too_large`);
    }
    const data = await readBounded(handle);
    if (data.byteLength > MAX_DOCUMENT_BYTES) reject(`${prefix}_too_large`);
    finished = await handle.stat({ bigint: true });
    assertPrivateMode(finished, prefix);
    if (!sameFileState(opened, finished) || finished.size !== BigInt(data.byteLength)) {
      reject(`${prefix}_changed`);
    }
    await assertPathState(source, finished, prefix);
    try {
      parsed = JSON.parse(data.toString("utf8"));
    } catch {
      reject(`${prefix}_invalid_json`);
    }
  } catch (error) {
    failure = normalizeFileError(error, prefix);
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch (error) {
        if (!failure) failure = normalizeFileError(error, prefix);
      }
    }
  }
  try {
    await inspectParentChain(source, prefix);
    if (!failure && finished) await assertPathState(source, finished, prefix);
  } catch (error) {
    if (!failure) failure = normalizeFileError(error, prefix);
  }
  if (failure) throw failure;
  return parsed;
}

async function removeOwnedFile(filePath, identity) {
  if (!identity) return;
  try {
    const current = await lstat(filePath, { bigint: true });
    if (current.isFile() && sameIdentity(current, identity)) await unlink(filePath);
  } catch {
    // Never replace the original safe failure with best-effort cleanup output.
  }
}

async function writePrivateJSON(filePath, value) {
  assertSupportedPlatform();
  const destination = assertCanonicalAbsolutePath(filePath, "output_path");
  await inspectParentChain(destination, "output");
  const payload = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (payload.byteLength > MAX_OUTPUT_BYTES) reject("output_too_large");
  try {
    const existing = await lstat(destination);
    if (existing.isSymbolicLink()) reject("output_symlink");
    reject("output_exists");
  } catch (error) {
    if (error instanceof DrainConfigError) throw error;
    if (error?.code !== "ENOENT") throw normalizeFileError(error, "output");
  }

  let handle;
  let identity;
  let written;
  let failure;
  try {
    handle = await open(destination, WRITE_FLAGS, PRIVATE_MODE);
    identity = await handle.stat({ bigint: true });
    await handle.chmod(PRIVATE_MODE);
    await handle.writeFile(payload);
    await handle.sync();
    written = await handle.stat({ bigint: true });
    assertPrivateMode(written, "output");
    if (
      !sameIdentity(identity, written) ||
      identity.uid !== written.uid ||
      identity.gid !== written.gid ||
      written.size !== BigInt(payload.byteLength)
    ) {
      reject("output_changed");
    }
  } catch (error) {
    failure = normalizeFileError(error, "output");
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch (error) {
        if (!failure) failure = normalizeFileError(error, "output");
      }
    }
  }
  if (failure) {
    await removeOwnedFile(destination, identity);
    throw failure;
  }
  try {
    const finished = await lstat(destination, { bigint: true });
    if (
      !written ||
      !finished.isFile() ||
      !sameFileState(written, finished) ||
      finished.size !== BigInt(payload.byteLength)
    ) {
      reject("output_changed");
    }
    await inspectParentChain(destination, "output");
  } catch (error) {
    await removeOwnedFile(destination, identity);
    throw normalizeFileError(error, "output");
  }
  return payload.byteLength;
}

async function writeDrainCompose({ composePath, workspaceImage, outputPath }) {
  const compose = await readPrivateJSON(composePath, "compose");
  const generated = buildDrainCompose({ compose, workspaceImage });
  const byteSize = await writePrivateJSON(outputPath, generated);
  return {
    status: "completed",
    operation: "create",
    service: RELEASE_CHECK_SERVICE,
    networkCount: Object.keys(generated.networks).length,
    secretCount: Object.keys(generated.secrets ?? {}).length,
    byteSize,
  };
}

function assertNonNegativeSafeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) reject(code);
}

function assertReportString(value, code) {
  if (typeof value !== "string" || value.length === 0 || !SAFE_TEXT_PATTERN.test(value)) {
    reject(code);
  }
}

function expectedReportBlockers(counts) {
  if (counts.schema.missingItems > 0) {
    // Check returns immediately for an incompatible schema, before the
    // aggregate finalizer adds any domain blockers.
    return [{ code: "schema_incompatible", count: counts.schema.missingItems }];
  }
  return REPORT_BLOCKER_RULES.flatMap(([group, field, code]) => {
    const count = counts[group][field];
    return count > 0 ? [{ code, count }] : [];
  });
}

function validateReportBlockers(blockers, expected) {
  if (!Array.isArray(blockers)) reject("report_blockers_present");
  for (const blocker of blockers) {
    const input = requireRecord(blocker, "report_blockers_invalid");
    requireExactKeys(input, ["code", "count"], "report_blockers_fields");
    assertReportString(input.code, "report_blocker_code_invalid");
    if (!Number.isSafeInteger(input.count) || input.count <= 0) {
      reject("report_blocker_count_invalid");
    }
  }
  if (
    blockers.length !== expected.length ||
    blockers.some(
      (blocker, index) =>
        blocker.code !== expected[index].code || blocker.count !== expected[index].count,
    )
  ) {
    reject("report_blockers_mismatch");
  }
}

function validateReportCounts(counts) {
  const input = requireRecord(counts, "report_counts_invalid");
  requireExactKeys(input, Object.keys(REPORT_COUNT_FIELDS), "report_counts_fields");
  for (const [group, fields] of Object.entries(REPORT_COUNT_FIELDS)) {
    const section = requireRecord(input[group], "report_count_group_invalid");
    requireExactKeys(section, fields, "report_count_fields");
    for (const field of fields) {
      assertNonNegativeSafeInteger(section[field], "report_count_value_invalid");
    }
  }
}

/**
 * Validate only a successful `duallane-release-check/v1` report. The Go
 * command's readOnly fields are nested in `snapshot` and `provider`; there is
 * intentionally no top-level readOnly field. The expected storage driver is
 * caller-supplied from the generated Compose authority and is mandatory.
 */
function validateReport(value, expectedStorageDriver) {
  if (expectedStorageDriver !== "local" && expectedStorageDriver !== "s3") {
    reject("expected_storage_driver_invalid");
  }
  const report = requireRecord(value, "report_invalid");
  requireExactKeys(report, REPORT_TOP_FIELDS, "report_fields");
  if (
    report.schema !== "duallane.release-check/v1" ||
    report.status !== "ready" ||
    report.scope !== "database_and_provider_snapshot"
  ) {
    reject("report_not_ready");
  }

  const snapshot = requireRecord(report.snapshot, "report_snapshot_invalid");
  requireExactKeys(snapshot, REPORT_SNAPSHOT_FIELDS, "report_snapshot_fields");
  if (snapshot.ready !== true || snapshot.readOnly !== true) {
    reject("report_snapshot_not_read_only");
  }
  if (
    typeof snapshot.snapshotAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T[^\u0000-\u001f\u007f]+$/u.test(snapshot.snapshotAt) ||
    !Number.isFinite(Date.parse(snapshot.snapshotAt))
  ) {
    reject("report_snapshot_time_invalid");
  }
  validateReportCounts(snapshot.counts);
  const expectedBlockers = expectedReportBlockers(snapshot.counts);
  validateReportBlockers(snapshot.blockers, expectedBlockers);
  if (snapshot.ready !== (expectedBlockers.length === 0)) {
    reject("report_ready_blocker_mismatch");
  }
  if (expectedBlockers.length !== 0) {
    reject("report_blockers_present");
  }

  const writers = requireRecord(snapshot.writers, "report_writers_invalid");
  requireExactKeys(writers, ["status", "reasonCode"], "report_writers_fields");
  if (writers.status !== "not_proven") {
    reject("report_writers_overstated");
  }
  assertReportString(writers.reasonCode, "report_writers_reason_invalid");

  const snapshotProvider = requireRecord(snapshot.provider, "report_snapshot_provider_invalid");
  requireExactKeys(
    snapshotProvider,
    ["status", "reasonCode"],
    "report_snapshot_provider_fields",
  );
  if (snapshotProvider.status !== "not_checked") {
    reject("report_provider_overstated");
  }
  assertReportString(snapshotProvider.reasonCode, "report_provider_reason_invalid");

  const provider = requireRecord(report.provider, "report_provider_invalid");
  requireExactKeys(provider, ["driver", "status", "code", "readOnly"], "report_provider_fields");
  if (provider.readOnly !== true) reject("report_provider_not_read_only");
  if (provider.driver !== expectedStorageDriver) {
    reject("report_provider_driver_mismatch");
  }
  if (expectedStorageDriver === "local") {
    if (provider.status !== "not_applicable" || provider.code !== "provider_not_applicable") {
      reject("report_provider_state_invalid");
    }
  } else if (expectedStorageDriver === "s3") {
    if (provider.status !== "ready" || provider.code !== "storage.multipart_quiescent") {
      reject("report_provider_state_invalid");
    }
  }
  return value;
}

function parseCLI(argv) {
  const command = argv[0] ?? "help";
  if (command === "help" || command === "--help" || command === "-h") {
    return { command: "help" };
  }
  if (command !== "create") reject("invalid_command");
  const options = { command };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!["--compose", "--workspace-image", "--output"].includes(argument)) {
      reject("invalid_argument");
    }
    const key = argument.slice(2).replaceAll("-", "_");
    if (options[key] !== undefined) reject("duplicate_argument");
    const value = argv[++index];
    if (!value) reject("missing_argument_value");
    options[key] = value;
  }
  if (!options.compose || !options.workspace_image || !options.output) {
    reject("missing_argument");
  }
  assertCanonicalAbsolutePath(options.compose, "compose_path");
  assertCanonicalAbsolutePath(options.output, "output_path");
  assertImageID(options.workspace_image);
  return options;
}

function helpText() {
  return [
    "Usage:",
    "  release-drain-config.mjs create --compose <absolute-private-0600-canonical-go-compose.json> --workspace-image <sha256:64-lowercase-hex> --output <absolute-new-private-0600-drain-compose.json>",
    "",
    "Creates a bounded read-only Compose service for /usr/local/bin/duallane-release-check --check-provider.",
    "The canonical Compose input supplies database/storage authority and shared private networks; no business service is started.",
  ].join("\n");
}

async function runCLI(argv) {
  const options = parseCLI(argv);
  if (options.command === "help") {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  const result = await writeDrainCompose({
    composePath: options.compose,
    workspaceImage: options.workspace_image,
    outputPath: options.output,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

export {
  DrainConfigError,
  RELEASE_CHECK_COMMAND,
  RELEASE_CHECK_ENTRYPOINT,
  RELEASE_CHECK_SERVICE,
  RELEASE_CHECK_USER,
  assertSupportedPlatform,
  buildDrainCompose,
  readPrivateJSON,
  validateReport,
  writePrivateJSON,
  writeDrainCompose,
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    await runCLI(process.argv.slice(2));
  } catch (error) {
    const code = error instanceof DrainConfigError ? error.code : "operation_failed";
    process.stderr.write(`release drain config rejected: ${code}\n`);
    process.exitCode = 1;
  }
}
