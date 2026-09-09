#!/usr/bin/env node

import { constants as fsConstants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SNAPSHOT_FORMAT = "duallane.release-compose-snapshot";
const SNAPSHOT_VERSION = 1;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const IMAGE_SERVICES = Object.freeze(["p2p", "workspace", "worker", "web", "migrate"]);
const SNAPSHOT_FIELDS = Object.freeze([
  "format", "version", "profile", "project", "commit", "semver", "schemaVersion", "imageIDs", "compose"
]);
const PROJECT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const IMAGE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SEMVER_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const READ_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);

class SnapshotError extends Error {
  constructor(code) {
    super(code);
    this.name = "SnapshotError";
    this.code = code;
  }
}

function reject(code) {
  throw new SnapshotError(code);
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
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
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) reject(code);
}

function cloneJSON(value, code) {
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

function validateProfile(value) {
  if (value !== "go-full") reject("invalid_profile");
  return value;
}

function validateProject(value) {
  if (typeof value !== "string" || !PROJECT_PATTERN.test(value)) reject("invalid_project");
  return value;
}

function validateCommit(value) {
  if (typeof value !== "string" || !COMMIT_PATTERN.test(value)) reject("invalid_commit");
  return value;
}

function validateSemver(value) {
  if (typeof value !== "string" || !SEMVER_PATTERN.test(value)) reject("invalid_semver");
  return value;
}

function validateSchemaVersion(value) {
  if (!Number.isSafeInteger(value) || value < 0) reject("invalid_schema_version");
  return value;
}

function validateImageIDs(value) {
  const input = requireRecord(value, "invalid_image_ids");
  requireExactKeys(input, IMAGE_SERVICES, "incomplete_image_ids");
  const imageIDs = {};
  for (const service of IMAGE_SERVICES) {
    if (typeof input[service] !== "string" || !IMAGE_ID_PATTERN.test(input[service])) reject("invalid_image_id");
    imageIDs[service] = input[service];
  }
  if (imageIDs.workspace !== imageIDs.worker || imageIDs.workspace !== imageIDs.migrate) {
    reject("workspace_worker_migrate_image_mismatch");
  }
  return imageIDs;
}

function validateCompose(value, project) {
  const compose = requireRecord(value, "invalid_compose");
  if (typeof compose.name !== "string" || compose.name.length === 0) reject("missing_compose_project");
  if (compose.name !== project) reject("compose_project_mismatch");
  const services = requireRecord(compose.services, "missing_compose_services");
  for (const serviceName of IMAGE_SERVICES) {
    const service = requireRecord(services[serviceName], "missing_compose_service");
    if (typeof service.image !== "string" || service.image.trim() === "") reject("missing_compose_image");
  }
  return compose;
}

function validateExpected(snapshot, expected) {
  if (expected === undefined) return;
  const input = requireRecord(expected, "invalid_expected_snapshot");
  if (input.version !== undefined && input.version !== snapshot.version) reject("snapshot_version_mismatch");
  for (const field of ["profile", "project", "commit", "semver", "schemaVersion"]) {
    if (input[field] !== undefined && input[field] !== snapshot[field]) reject(`snapshot_${field}_mismatch`);
  }
  if (input.imageIDs !== undefined) {
    const expectedIDs = validateImageIDs(input.imageIDs);
    for (const service of IMAGE_SERVICES) {
      if (expectedIDs[service] !== snapshot.imageIDs[service]) reject("snapshot_image_ids_mismatch");
    }
  }
}

function validateSnapshotShape(value) {
  const snapshot = requireRecord(value, "invalid_snapshot");
  requireExactKeys(snapshot, SNAPSHOT_FIELDS, "invalid_snapshot_fields");
  if (snapshot.format !== SNAPSHOT_FORMAT || snapshot.version !== SNAPSHOT_VERSION) reject("unsupported_snapshot_version");
  validateProfile(snapshot.profile);
  validateProject(snapshot.project);
  validateCommit(snapshot.commit);
  validateSemver(snapshot.semver);
  validateSchemaVersion(snapshot.schemaVersion);
  const imageIDs = validateImageIDs(snapshot.imageIDs);
  const compose = validateCompose(snapshot.compose, snapshot.project);
  for (const service of IMAGE_SERVICES) {
    if (compose.services[service].image !== imageIDs[service]) reject("image_not_pinned");
  }
  return snapshot;
}

function captureComposeSnapshot(input) {
  const request = requireRecord(input, "invalid_capture_input");
  const profile = validateProfile(request.profile);
  const project = validateProject(request.project);
  const imageIDs = validateImageIDs(request.imageIDs);
  const compose = cloneJSON(request.compose, "invalid_compose");
  validateCompose(compose, project);
  for (const service of IMAGE_SERVICES) compose.services[service].image = imageIDs[service];
  const snapshot = {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    profile,
    project,
    commit: validateCommit(request.commit),
    semver: validateSemver(request.semver),
    schemaVersion: validateSchemaVersion(request.schemaVersion),
    imageIDs,
    compose
  };
  return validateSnapshotShape(snapshot);
}

function absolutePath(value, code) {
  if (typeof value !== "string" || !path.isAbsolute(value)) reject(code);
  return path.resolve(value);
}

function fileModeIs0600(info) {
  return (info.mode & 0o777) === 0o600;
}

async function inspectExistingDestination(filePath) {
  try {
    const info = await lstat(filePath);
    if (info.isSymbolicLink()) reject("destination_symlink");
    if (!info.isFile()) reject("destination_not_regular");
    reject("destination_exists");
  } catch (error) {
    if (error instanceof SnapshotError) throw error;
    if (error?.code !== "ENOENT") reject("destination_unavailable");
  }
}

async function removeOwnedFile(filePath, identity) {
  if (!identity) return;
  try {
    const current = await lstat(filePath);
    if (current.dev === identity.dev && current.ino === identity.ino) await unlink(filePath);
  } catch {
    // Cleanup is best effort and must never replace the original safe error.
  }
}

async function writeJSONExclusive(filePath, value, prefix) {
  const destination = absolutePath(filePath, "output_path_must_be_absolute");
  const serialized = JSON.stringify(value);
  const payload = Buffer.from(`${serialized}\n`, "utf8");
  if (payload.length > MAX_FILE_BYTES) reject(`${prefix}_too_large`);
  await inspectExistingDestination(destination);

  let handle;
  try {
    handle = await open(destination, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") reject("destination_exists");
    reject("destination_unavailable");
  }
  let identity;
  try {
    identity = await handle.stat();
    await handle.chmod(0o600);
    await handle.writeFile(payload);
    await handle.sync();
  } catch {
    await handle.close().catch(() => {});
    await removeOwnedFile(destination, identity);
    reject(`${prefix}_write_failed`);
  }
  try {
    await handle.close();
  } catch {
    await removeOwnedFile(destination, identity);
    reject(`${prefix}_write_failed`);
  }
  return { path: destination, byteSize: payload.length };
}

function sameFileIdentity(first, second) {
  return first.dev === second.dev && first.ino === second.ino;
}

async function assertReadPathIdentity(source, opened, prefix) {
  let current;
  try {
    current = await lstat(source);
  } catch {
    throw new SnapshotError(`${prefix}_changed`);
  }
  if (current.isSymbolicLink()) throw new SnapshotError(`${prefix}_symlink`);
  if (!current.isFile() || !sameFileIdentity(opened, current)) throw new SnapshotError(`${prefix}_changed`);
}

async function readBounded(handle) {
  const buffer = Buffer.allocUnsafe(MAX_FILE_BYTES + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

function normalizeReadError(error, prefix) {
  if (error instanceof SnapshotError) return error;
  if (error?.code === "ELOOP") return new SnapshotError(`${prefix}_symlink`);
  if (error?.code === "EISDIR" || error?.code === "ENOTDIR") return new SnapshotError(`${prefix}_not_regular`);
  return new SnapshotError(`${prefix}_unreadable`);
}

async function readJSONDocument(filePath, { requirePrivateMode, prefix }) {
  const source = absolutePath(filePath, "input_path_must_be_absolute");
  let handle;
  let parsed;
  let failure;
  try {
    handle = await open(source, READ_FLAGS);
    const opened = await handle.stat();
    if (!opened.isFile()) throw new SnapshotError(`${prefix}_not_regular`);
    if (requirePrivateMode && !fileModeIs0600(opened)) throw new SnapshotError(`${prefix}_permissions`);
    await assertReadPathIdentity(source, opened, prefix);
    if (opened.size > MAX_FILE_BYTES) throw new SnapshotError(`${prefix}_too_large`);
    const data = await readBounded(handle);
    if (data.byteLength > MAX_FILE_BYTES) throw new SnapshotError(`${prefix}_too_large`);
    const finished = await handle.stat();
    if (!finished.isFile() || !sameFileIdentity(opened, finished) ||
        (requirePrivateMode && !fileModeIs0600(finished))) {
      throw new SnapshotError(`${prefix}_changed`);
    }
    if (finished.size > MAX_FILE_BYTES) throw new SnapshotError(`${prefix}_too_large`);
    if (finished.size !== data.byteLength) throw new SnapshotError(`${prefix}_changed`);
    await assertReadPathIdentity(source, finished, prefix);
    try {
      parsed = JSON.parse(data.toString("utf8"));
    } catch {
      throw new SnapshotError(`${prefix}_invalid_json`);
    }
  } catch (error) {
    failure = normalizeReadError(error, prefix);
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch (error) {
        if (!failure) failure = normalizeReadError(error, prefix);
      }
    }
  }
  if (failure) throw failure;
  return parsed;
}

function summary(operation, snapshot, byteSize) {
  return {
    status: "completed",
    operation,
    format: snapshot.format,
    version: snapshot.version,
    profile: snapshot.profile,
    project: snapshot.project,
    commit: snapshot.commit,
    semver: snapshot.semver,
    schemaVersion: snapshot.schemaVersion,
    serviceCount: Object.keys(snapshot.compose.services).length,
    pinnedServices: [...IMAGE_SERVICES],
    workspaceWorkerMigrateImageMatch: true,
    ...(byteSize === undefined ? {} : { byteSize })
  };
}

async function writeSnapshot(filePath, snapshot) {
  const verified = verifySnapshot(snapshot);
  return writeJSONExclusive(filePath, verified, "snapshot");
}

async function readSnapshot(filePath, expected) {
  const parsed = await readJSONDocument(filePath, { requirePrivateMode: true, prefix: "snapshot" });
  return verifySnapshot(parsed, expected);
}

function verifySnapshot(snapshot, expected) {
  const verified = validateSnapshotShape(snapshot);
  validateExpected(verified, expected);
  return verified;
}

async function writeRecoverableCompose(filePath, snapshot) {
  const verified = verifySnapshot(snapshot);
  // The input is canonical `docker compose config --format json` output,
  // which already escapes literal '$' values for a subsequent Compose parse.
  // Escaping again would silently change passwords/commands during recovery.
  // File references are not frozen bytes; callers verify those separately.
  const compose = cloneJSON(verified.compose, "invalid_compose");
  return writeJSONExclusive(filePath, compose, "compose");
}

async function readCaptureInput(filePath) {
  return readJSONDocument(filePath, { requirePrivateMode: true, prefix: "input" });
}

function parseCLI(argv) {
  const command = argv[0] ?? "help";
  if (command === "help" || command === "--help" || command === "-h") return { command: "help" };
  if (!["capture", "read", "verify", "recover"].includes(command)) reject("invalid_command");
  const options = { command };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--input" || argument === "--output") {
      const value = argv[++index];
      if (!value) reject("missing_argument_value");
      options[argument.slice(2)] = value;
      continue;
    }
    reject("invalid_argument");
  }
  if (!options.input) reject("missing_input");
  if ((command === "capture" || command === "recover") && !options.output) reject("missing_output");
  if ((command === "read" || command === "verify") && options.output) reject("unexpected_output");
  return options;
}

function helpText() {
  return [
    "Usage:",
    "  release-compose-snapshot.mjs capture --input <capture-json> --output <snapshot-json>",
    "  release-compose-snapshot.mjs read --input <snapshot-json>",
    "  release-compose-snapshot.mjs verify --input <snapshot-json>",
    "  release-compose-snapshot.mjs recover --input <snapshot-json> --output <compose-json>",
    "",
    "capture input is JSON: {compose, imageIDs, profile, project, commit, semver, schemaVersion}",
    "compose must be canonical docker compose config --format json output, not raw container inspection",
    "external bind, config, and secret file bytes are not snapshotted"
  ].join("\n");
}

async function runCLI(argv) {
  const options = parseCLI(argv);
  if (options.command === "help") {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  if (options.command === "capture") {
    const input = await readCaptureInput(options.input);
    const snapshot = captureComposeSnapshot(input);
    const written = await writeSnapshot(options.output, snapshot);
    process.stdout.write(`${JSON.stringify(summary("capture", snapshot, written.byteSize))}\n`);
    return;
  }
  const snapshot = await readSnapshot(options.input);
  if (options.command === "recover") {
    if (path.resolve(options.input) === path.resolve(options.output)) reject("recovery_output_must_differ");
    const written = await writeRecoverableCompose(options.output, snapshot);
    process.stdout.write(`${JSON.stringify(summary("recover", snapshot, written.byteSize))}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(summary(options.command, snapshot))}\n`);
}

export {
  IMAGE_SERVICES,
  MAX_FILE_BYTES,
  SNAPSHOT_FORMAT,
  SNAPSHOT_VERSION,
  SnapshotError,
  captureComposeSnapshot,
  readSnapshot,
  verifySnapshot,
  writeRecoverableCompose,
  writeSnapshot
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await runCLI(process.argv.slice(2));
  } catch (error) {
    const code = error instanceof SnapshotError ? error.code : "operation_failed";
    process.stderr.write(`release compose snapshot rejected: ${code}\n`);
    process.exitCode = 1;
  }
}
