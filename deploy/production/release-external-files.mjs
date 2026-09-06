#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MANIFEST_FORMAT = "duallane.release-external-files";
const MANIFEST_VERSION = 1;
const GO_RECOVERY_SERVICES = Object.freeze([
  "p2p",
  "workspace",
  "worker",
  "web",
  "migrate",
]);
const NODE_RECOVERY_SERVICES = Object.freeze(["api", "web"]);
const EXTERNAL_KINDS = Object.freeze(["secret", "config", "bind"]);
const MAX_FILES = 32;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const PRIVATE_MODE = 0o600;
const READ_FLAGS =
  fsConstants.O_RDONLY |
  (fsConstants.O_NOFOLLOW ?? 0) |
  (fsConstants.O_NONBLOCK ?? 0);
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;

class ExternalFilesError extends Error {
  constructor(code) {
    super(code);
    this.name = "ExternalFilesError";
    this.code = code;
  }
}

function reject(code) {
  throw new ExternalFilesError(code);
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
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
  )
    reject(code);
}

function assertSupportedPlatform(platform = process.platform) {
  if (platform !== "linux" || typeof fsConstants.O_NOFOLLOW !== "number")
    reject("linux_only");
}

function assertAbsoluteCanonicalPath(value, code) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\u0000") ||
    !path.posix.isAbsolute(value)
  ) {
    reject(code);
  }
  if (path.posix.normalize(value) !== value) reject(`${code}_not_canonical`);
  return value;
}

function assertSafeText(value, code) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    reject(code);
  return value;
}

function safeNumber(value, code) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) reject(code);
  return number;
}

function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJSON(value) {
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJSON(item)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) reject("compose_invalid");
  return serialized;
}

function canonicalComposeHash(compose) {
  return hashBytes(Buffer.from(canonicalJSON(compose), "utf8"));
}

function normalizeServices(value) {
  const services = typeof value === "string" ? value.split(",") : value;
  if (
    !Array.isArray(services) ||
    services.some(
      (service) => typeof service !== "string" || service.length === 0,
    )
  )
    reject("invalid_services");
  const actual = [...services].sort();
  for (const expectedServices of [
    GO_RECOVERY_SERVICES,
    NODE_RECOVERY_SERVICES,
  ]) {
    const expected = [...expectedServices].sort();
    if (
      actual.length === expected.length &&
      actual.every((service, index) => service === expected[index])
    )
      return [...expectedServices];
  }
  reject("invalid_services");
}

function normalizeFsError(error, prefix) {
  if (error instanceof ExternalFilesError) return error;
  switch (error?.code) {
    case "ELOOP":
      return new ExternalFilesError(`${prefix}_symlink`);
    case "ENOENT":
    case "ENOTDIR":
      return new ExternalFilesError(`${prefix}_missing`);
    case "EACCES":
    case "EPERM":
      return new ExternalFilesError(`${prefix}_unreadable`);
    case "EISDIR":
      return new ExternalFilesError(`${prefix}_not_regular`);
    default:
      return new ExternalFilesError(`${prefix}_unavailable`);
  }
}

/**
 * External paths must have a real, non-symlink parent chain. This is an
 * explicit deployment-user trust boundary: the pre/post checks do not defend
 * against a privileged root swapping a path away and back during the call.
 */
async function inspectParentChain(filePath, prefix) {
  const parts = filePath.slice(1).split("/");
  const parentCount = Math.max(0, parts.length - 1);
  const chain = [];
  let current = "/";
  try {
    for (let index = -1; index < parentCount; index += 1) {
      if (index >= 0) current = path.posix.join(current, parts[index]);
      const info = await lstat(current, { bigint: true });
      if (info.isSymbolicLink()) reject(`${prefix}_parent_symlink`);
      if (!info.isDirectory()) reject(`${prefix}_parent_not_directory`);
      chain.push({ path: current, dev: info.dev, ino: info.ino });
    }
  } catch (error) {
    throw normalizeFsError(error, prefix);
  }
  return chain;
}

function sameParentChain(first, second) {
  return (
    first.length === second.length &&
    first.every((item, index) => {
      const other = second[index];
      return (
        item.path === other.path &&
        item.dev === other.dev &&
        item.ino === other.ino
      );
    })
  );
}

function fileMetadata(info, prefix) {
  if (!info.isFile()) reject(`${prefix}_not_regular`);
  const uid = safeNumber(info.uid, `${prefix}_metadata_invalid`);
  const gid = safeNumber(info.gid, `${prefix}_metadata_invalid`);
  const size = safeNumber(info.size, `${prefix}_metadata_invalid`);
  return {
    dev: info.dev.toString(),
    ino: info.ino.toString(),
    uid,
    gid,
    mode: Number(info.mode & 0o7777n),
    size,
  };
}

function sameIdentity(first, second) {
  return (
    first.dev === second.dev &&
    first.ino === second.ino &&
    first.isFile() === second.isFile()
  );
}

function sameStableStat(first, second) {
  return (
    first.dev === second.dev &&
    first.ino === second.ino &&
    first.uid === second.uid &&
    first.gid === second.gid &&
    first.mode === second.mode &&
    first.size === second.size &&
    first.mtimeNs === second.mtimeNs &&
    first.ctimeNs === second.ctimeNs
  );
}

async function readStableFile(
  filePath,
  {
    prefix,
    maxBytes,
    requireMode,
    collectBytes,
    sizeLimitBytes = maxBytes,
    sizeLimitCode = `${prefix}_too_large`,
    tooLargeCode = `${prefix}_too_large`,
  },
) {
  assertAbsoluteCanonicalPath(filePath, `${prefix}_path`);
  let handle = null;
  let failure = null;
  let result = null;
  try {
    const parentsBefore = await inspectParentChain(filePath, prefix);
    try {
      handle = await open(filePath, READ_FLAGS);
    } catch (error) {
      throw normalizeFsError(error, prefix);
    }
    const before = await handle.stat({ bigint: true });
    const metadataBefore = fileMetadata(before, prefix);
    const pathBefore = await lstat(filePath, { bigint: true });
    if (pathBefore.isSymbolicLink()) reject(`${prefix}_symlink`);
    if (!sameIdentity(pathBefore, before)) reject(`${prefix}_changed`);
    if (requireMode !== undefined && metadataBefore.mode !== requireMode)
      reject(`${prefix}_permissions`);
    if (metadataBefore.size > sizeLimitBytes) reject(sizeLimitCode);
    if (metadataBefore.size > maxBytes) reject(tooLargeCode);

    const hash = createHash("sha256");
    const chunks = collectBytes ? [] : null;
    let total = 0;
    while (true) {
      if (total === maxBytes) break;
      const buffer = Buffer.allocUnsafe(
        Math.min(CHUNK_BYTES, maxBytes - total),
      );
      const readResult = await handle.read(buffer, 0, buffer.length, null);
      if (readResult.bytesRead === 0) break;
      const bytes = buffer.subarray(0, readResult.bytesRead);
      total += readResult.bytesRead;
      if (total > maxBytes) reject(tooLargeCode);
      hash.update(bytes);
      if (chunks) chunks.push(bytes);
      if (total === maxBytes) break;
    }

    const after = await handle.stat({ bigint: true });
    const metadataAfter = fileMetadata(after, prefix);
    const pathAfter = await lstat(filePath, { bigint: true });
    const parentsAfter = await inspectParentChain(filePath, prefix);
    if (metadataAfter.size > sizeLimitBytes) reject(sizeLimitCode);
    if (metadataAfter.size > maxBytes) reject(tooLargeCode);
    if (
      !sameStableStat(before, after) ||
      !sameIdentity(pathAfter, after) ||
      !sameParentChain(parentsBefore, parentsAfter) ||
      total !== metadataAfter.size
    ) {
      reject(`${prefix}_changed`);
    }
    if (requireMode !== undefined && metadataAfter.mode !== requireMode)
      reject(`${prefix}_changed`);
    result = {
      ...metadataAfter,
      sha256: hash.digest("hex"),
      ...(chunks ? { bytes: Buffer.concat(chunks, total) } : {}),
    };
  } catch (error) {
    failure = normalizeFsError(error, prefix);
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch (error) {
        if (!failure) failure = normalizeFsError(error, prefix);
      }
    }
  }
  if (failure) throw failure;
  if (result) return result;
  reject(`${prefix}_unavailable`);
}

async function readJSONDocument(filePath, { prefix, requireMode }) {
  const document = await readStableFile(filePath, {
    prefix,
    maxBytes: MAX_DOCUMENT_BYTES,
    requireMode,
    collectBytes: true,
  });
  let value;
  try {
    value = JSON.parse(document.bytes.toString("utf8"));
  } catch {
    reject(`${prefix}_invalid_json`);
  }
  return { value, sha256: canonicalComposeHash(value) };
}

function validateCompose(compose, requiredServices) {
  const input = requireRecord(compose, "compose_invalid");
  const services = requireRecord(input.services, "compose_services_missing");
  for (const service of normalizeServices(requiredServices)) {
    requireRecord(services[service], "compose_service_missing");
  }
  return input;
}

function serviceReferences(value, kind, serviceName) {
  if (value === undefined) return [];
  const references = [];
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === "string") {
        references.push({
          kind,
          service: serviceName,
          name: assertSafeText(entry, `${kind}_reference_invalid`),
          target: entry,
        });
      } else if (isRecord(entry)) {
        const name = entry.source ?? entry.name;
        if (typeof name !== "string") reject(`${kind}_reference_invalid`);
        const target = entry.target ?? name;
        references.push({
          kind,
          service: serviceName,
          name: assertSafeText(name, `${kind}_reference_invalid`),
          target: assertSafeText(target, `${kind}_reference_invalid`),
        });
      } else {
        reject(`${kind}_reference_invalid`);
      }
    }
    return references;
  }
  if (isRecord(value)) {
    for (const [name, entry] of Object.entries(value)) {
      if (entry !== undefined && entry !== null && !isRecord(entry))
        reject(`${kind}_reference_invalid`);
      const target = isRecord(entry) ? (entry.target ?? name) : name;
      references.push({
        kind,
        service: serviceName,
        name: assertSafeText(name, `${kind}_reference_invalid`),
        target: assertSafeText(target, `${kind}_reference_invalid`),
      });
    }
    return references;
  }
  reject(`${kind}_reference_invalid`);
}

function bindReferenceFromObject(mount, serviceName) {
  if (mount.type === "volume" || mount.type === "tmpfs") return null;
  if (mount.type !== "bind") reject("bind_unsupported");
  const mode = typeof mount.mode === "string" ? mount.mode.split(",") : [];
  if (
    mount.read_only !== true &&
    mount.readOnly !== true &&
    !mode.includes("ro")
  )
    reject("bind_not_read_only");
  if (
    mount.read_only === false ||
    mount.readOnly === false ||
    mode.includes("rw")
  )
    reject("bind_not_read_only");
  if (typeof mount.source !== "string" || typeof mount.target !== "string")
    reject("bind_invalid");
  return {
    kind: "bind",
    service: serviceName,
    name: assertSafeText(mount.target, "bind_invalid"),
    target: assertSafeText(mount.target, "bind_invalid"),
    source: assertAbsoluteCanonicalPath(mount.source, "bind_path"),
  };
}

function bindReferenceFromString(mount, serviceName, namedVolumes) {
  const parts = mount.split(":");
  if (parts.length < 2) reject("bind_invalid");
  const source = parts[0];
  const target = parts[1];
  if (Object.prototype.hasOwnProperty.call(namedVolumes, source)) return null;
  if (!path.posix.isAbsolute(source)) reject("bind_path");
  const mode = (parts[2] ?? "").split(",");
  if (!mode.includes("ro") || mode.includes("rw")) reject("bind_not_read_only");
  return {
    kind: "bind",
    service: serviceName,
    name: assertSafeText(target, "bind_invalid"),
    target: assertSafeText(target, "bind_invalid"),
    source: assertAbsoluteCanonicalPath(source, "bind_path"),
  };
}

function collectExternalReferences(compose, services) {
  const definitions = {
    secret: compose.secrets,
    config: compose.configs,
  };
  const namedVolumes = isRecord(compose.volumes) ? compose.volumes : {};
  const bySource = new Map();
  const addReference = (reference) => {
    let source = reference.source;
    if (!source) {
      const definition = definitions[reference.kind]?.[reference.name];
      if (
        !isRecord(definition) ||
        definition.external === true ||
        definition.environment !== undefined ||
        typeof definition.file !== "string"
      ) {
        reject(`${reference.kind}_source_not_file`);
      }
      source = assertAbsoluteCanonicalPath(
        definition.file,
        `${reference.kind}_path`,
      );
    }
    let entry = bySource.get(source);
    if (!entry) {
      entry = { source, references: [] };
      bySource.set(source, entry);
    }
    const key = JSON.stringify({
      kind: reference.kind,
      service: reference.service,
      name: reference.name,
      target: reference.target,
    });
    if (!entry.references.some((item) => JSON.stringify(item) === key)) {
      entry.references.push({
        kind: reference.kind,
        service: reference.service,
        name: reference.name,
        target: reference.target,
      });
    }
  };

  for (const serviceName of services) {
    const service = compose.services[serviceName];
    for (const kind of ["secret", "config"]) {
      for (const reference of serviceReferences(
        service[`${kind}s`],
        kind,
        serviceName,
      ))
        addReference(reference);
    }
    if (service.volumes === undefined) continue;
    if (!Array.isArray(service.volumes)) reject("bind_invalid");
    for (const mount of service.volumes) {
      const reference =
        typeof mount === "string"
          ? bindReferenceFromString(mount, serviceName, namedVolumes)
          : bindReferenceFromObject(
              requireRecord(mount, "bind_invalid"),
              serviceName,
            );
      if (reference) addReference(reference);
    }
  }
  const entries = [...bySource.values()].sort((first, second) =>
    first.source.localeCompare(second.source),
  );
  for (const entry of entries) {
    entry.references.sort((first, second) =>
      JSON.stringify(first).localeCompare(JSON.stringify(second)),
    );
  }
  if (entries.length > MAX_FILES) reject("too_many_files");
  return entries;
}

function manifestFileFromObservation(entry, observation) {
  return {
    source: entry.source,
    dev: observation.dev,
    ino: observation.ino,
    uid: observation.uid,
    gid: observation.gid,
    mode: observation.mode,
    size: observation.size,
    sha256: observation.sha256,
    references: entry.references,
  };
}

function validateManifest(value) {
  const manifest = requireRecord(value, "manifest_invalid");
  requireExactKeys(
    manifest,
    ["format", "version", "composeSha256", "services", "files", "totalBytes"],
    "manifest_fields_invalid",
  );
  if (
    manifest.format !== MANIFEST_FORMAT ||
    manifest.version !== MANIFEST_VERSION
  )
    reject("manifest_version_invalid");
  if (
    typeof manifest.composeSha256 !== "string" ||
    !HASH_PATTERN.test(manifest.composeSha256)
  )
    reject("manifest_hash_invalid");
  const services = normalizeServices(manifest.services);
  if (!Array.isArray(manifest.files) || manifest.files.length > MAX_FILES)
    reject("manifest_files_invalid");
  const totalBytes = safeNumber(manifest.totalBytes, "manifest_total_invalid");
  if (totalBytes > MAX_TOTAL_BYTES) reject("manifest_total_invalid");
  let calculatedTotal = 0;
  const sources = new Set();
  for (const file of manifest.files) {
    requireExactKeys(
      file,
      [
        "source",
        "dev",
        "ino",
        "uid",
        "gid",
        "mode",
        "size",
        "sha256",
        "references",
      ],
      "manifest_file_invalid",
    );
    const source = assertAbsoluteCanonicalPath(
      file.source,
      "manifest_file_path",
    );
    if (sources.has(source)) reject("manifest_file_duplicate");
    sources.add(source);
    if (
      typeof file.dev !== "string" ||
      !DECIMAL_PATTERN.test(file.dev) ||
      typeof file.ino !== "string" ||
      !DECIMAL_PATTERN.test(file.ino)
    )
      reject("manifest_identity_invalid");
    safeNumber(file.uid, "manifest_identity_invalid");
    safeNumber(file.gid, "manifest_identity_invalid");
    safeNumber(file.mode, "manifest_mode_invalid");
    if (file.mode > 0o7777) reject("manifest_mode_invalid");
    const size = safeNumber(file.size, "manifest_size_invalid");
    if (size > MAX_FILE_BYTES) reject("manifest_size_invalid");
    if (typeof file.sha256 !== "string" || !HASH_PATTERN.test(file.sha256))
      reject("manifest_hash_invalid");
    if (!Array.isArray(file.references) || file.references.length === 0)
      reject("manifest_references_invalid");
    const referenceKeys = new Set();
    for (const reference of file.references) {
      requireExactKeys(
        reference,
        ["kind", "service", "name", "target"],
        "manifest_reference_invalid",
      );
      if (
        !EXTERNAL_KINDS.includes(reference.kind) ||
        !services.includes(reference.service)
      )
        reject("manifest_reference_invalid");
      assertSafeText(reference.name, "manifest_reference_invalid");
      assertSafeText(reference.target, "manifest_reference_invalid");
      const key = JSON.stringify(reference);
      if (referenceKeys.has(key)) reject("manifest_reference_duplicate");
      referenceKeys.add(key);
    }
    calculatedTotal += size;
    if (calculatedTotal > MAX_TOTAL_BYTES) reject("manifest_total_invalid");
  }
  if (calculatedTotal !== totalBytes) reject("manifest_total_invalid");
  return { ...manifest, services, totalBytes };
}

function comparableReferences(entries) {
  return entries
    .map((entry) => ({ source: entry.source, references: entry.references }))
    .sort((first, second) => first.source.localeCompare(second.source));
}

function assertReferenceSetMatches(currentEntries, manifestFiles) {
  const current = comparableReferences(currentEntries);
  const recorded = comparableReferences(manifestFiles);
  if (JSON.stringify(current) !== JSON.stringify(recorded))
    reject("external_reference_changed");
}

function assertObservationMatches(record, observation) {
  if (record.dev !== observation.dev || record.ino !== observation.ino)
    reject("external_file_identity_changed");
  if (
    record.uid !== observation.uid ||
    record.gid !== observation.gid ||
    record.mode !== observation.mode
  ) {
    reject("external_file_changed");
  }
  if (record.size !== observation.size || record.sha256 !== observation.sha256)
    reject("external_file_changed");
}

async function loadCompose(composePath, requiredServices) {
  const pathValue = assertAbsoluteCanonicalPath(composePath, "compose_path");
  const document = await readJSONDocument(pathValue, {
    prefix: "compose",
    requireMode: PRIVATE_MODE,
  });
  const compose = validateCompose(document.value, requiredServices);
  return { compose, sha256: canonicalComposeHash(compose) };
}

async function loadManifest(manifestPath) {
  const pathValue = assertAbsoluteCanonicalPath(manifestPath, "manifest_path");
  const document = await readJSONDocument(pathValue, {
    prefix: "manifest",
    requireMode: PRIVATE_MODE,
  });
  return validateManifest(document.value);
}

async function removeOwnedFile(filePath, identity) {
  if (!identity) return;
  try {
    const current = await lstat(filePath, { bigint: true });
    if (current.dev === identity.dev && current.ino === identity.ino)
      await unlink(filePath);
  } catch {
    // Cleanup never replaces the original safe error and never emits filesystem details.
  }
}

async function writeManifest(manifestPath, manifest) {
  const destination = assertAbsoluteCanonicalPath(
    manifestPath,
    "manifest_path",
  );
  const parentsBefore = await inspectParentChain(destination, "manifest");
  const payload = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  let handle = null;
  let identity = null;
  let failure = null;
  try {
    try {
      handle = await open(destination, "wx", PRIVATE_MODE);
    } catch (error) {
      if (error?.code === "EEXIST") reject("manifest_exists");
      throw normalizeFsError(error, "manifest");
    }
    identity = await handle.stat({ bigint: true });
    if (!identity.isFile()) reject("manifest_not_regular");
    await handle.chmod(PRIVATE_MODE);
    await handle.writeFile(payload);
    await handle.sync();
    const finished = await handle.stat({ bigint: true });
    const pathAfter = await lstat(destination, { bigint: true });
    const parentsAfter = await inspectParentChain(destination, "manifest");
    if (
      !finished.isFile() ||
      !sameIdentity(identity, finished) ||
      !sameIdentity(pathAfter, finished) ||
      !sameParentChain(parentsBefore, parentsAfter) ||
      Number(finished.mode & 0o7777n) !== PRIVATE_MODE ||
      finished.size !== BigInt(payload.length)
    ) {
      reject("manifest_write_failed");
    }
  } catch (error) {
    failure = normalizeFsError(error, "manifest");
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch (error) {
        if (!failure) failure = normalizeFsError(error, "manifest");
      }
    }
  }
  if (failure) {
    await removeOwnedFile(destination, identity);
    throw failure;
  }
}

function resultSummary(operation, files, totalBytes) {
  return Object.freeze({
    status: "completed",
    operation,
    format: MANIFEST_FORMAT,
    version: MANIFEST_VERSION,
    fileCount: files,
    totalBytes,
  });
}

/**
 * Capture fingerprints only; no source file is copied, chmodded, chowned, or
 * replaced. Callers must provide absolute canonical paths under a trusted
 * deployment-user-controlled parent chain.
 */
async function captureExternalFiles({ composePath, services, outputPath }) {
  assertSupportedPlatform();
  const normalizedServices = normalizeServices(services);
  const { compose, sha256: composeSha256 } = await loadCompose(
    composePath,
    normalizedServices,
  );
  const entries = collectExternalReferences(compose, normalizedServices);
  const files = [];
  let totalBytes = 0;
  for (const entry of entries) {
    const remainingTotalBytes = MAX_TOTAL_BYTES - totalBytes;
    if (remainingTotalBytes <= 0) reject("too_many_total_bytes");
    const observation = await readStableFile(entry.source, {
      prefix: "external_file",
      maxBytes: Math.min(MAX_FILE_BYTES, remainingTotalBytes),
      sizeLimitBytes: MAX_FILE_BYTES,
      sizeLimitCode: "external_file_too_large",
      tooLargeCode:
        remainingTotalBytes < MAX_FILE_BYTES
          ? "too_many_total_bytes"
          : "external_file_too_large",
      collectBytes: false,
    });
    totalBytes += observation.size;
    if (totalBytes > MAX_TOTAL_BYTES) reject("too_many_total_bytes");
    files.push(manifestFileFromObservation(entry, observation));
  }
  const manifest = {
    format: MANIFEST_FORMAT,
    version: MANIFEST_VERSION,
    composeSha256,
    services: normalizedServices,
    files,
    totalBytes,
  };
  await writeManifest(outputPath, manifest);
  return resultSummary("capture", files.length, totalBytes);
}

/**
 * Verify the frozen Compose and external-file fingerprints in place. This is
 * Linux-only and does not copy or repair files; callers must run as a trusted
 * deployment identity with read access to the original absolute paths.
 */
async function verifyExternalFiles({ composePath, inputPath }) {
  assertSupportedPlatform();
  const manifest = await loadManifest(inputPath);
  const { compose, sha256: composeSha256 } = await loadCompose(
    composePath,
    manifest.services,
  );
  if (manifest.composeSha256 !== composeSha256) reject("compose_changed");
  const entries = collectExternalReferences(compose, manifest.services);
  assertReferenceSetMatches(entries, manifest.files);
  let totalBytes = 0;
  for (const entry of entries) {
    const record = manifest.files.find((file) => file.source === entry.source);
    if (!record) reject("external_reference_changed");
    const remainingTotalBytes = MAX_TOTAL_BYTES - totalBytes;
    if (remainingTotalBytes < 0) reject("manifest_total_invalid");
    const maxBytes = Math.min(record.size, MAX_FILE_BYTES, remainingTotalBytes);
    const observation = await readStableFile(entry.source, {
      prefix: "external_file",
      maxBytes,
      sizeLimitBytes: record.size,
      sizeLimitCode: "external_file_changed",
      tooLargeCode:
        record.size > remainingTotalBytes
          ? "too_many_total_bytes"
          : "external_file_changed",
      collectBytes: false,
    });
    assertObservationMatches(record, observation);
    totalBytes += observation.size;
  }
  if (totalBytes !== manifest.totalBytes || totalBytes > MAX_TOTAL_BYTES)
    reject("manifest_total_invalid");
  return resultSummary("verify", entries.length, totalBytes);
}

function parseServicesArgument(value) {
  if (!value) reject("missing_services");
  return normalizeServices(value);
}

function parseCLI(argv) {
  const command = argv[0] ?? "help";
  if (command === "help" || command === "--help" || command === "-h")
    return { command: "help" };
  if (command !== "capture" && command !== "verify") reject("invalid_command");
  const options = { command };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!["--compose", "--services", "--output", "--input"].includes(argument))
      reject("invalid_argument");
    const key = argument.slice(2);
    if (options[key] !== undefined) reject("duplicate_argument");
    const value = argv[++index];
    if (!value) reject("missing_argument_value");
    options[key] = value;
  }
  if (!options.compose) reject("missing_compose");
  assertAbsoluteCanonicalPath(options.compose, "compose_path");
  if (command === "capture") {
    if (!options.services) reject("missing_services");
    if (!options.output) reject("missing_output");
    if (options.input) reject("unexpected_input");
    assertAbsoluteCanonicalPath(options.output, "manifest_path");
    options.services = parseServicesArgument(options.services);
  } else {
    if (!options.input) reject("missing_input");
    if (options.output || options.services) reject("unexpected_argument");
    assertAbsoluteCanonicalPath(options.input, "manifest_path");
  }
  return options;
}

function helpText() {
  return [
    "Usage:",
    "  release-external-files.mjs capture --compose <absolute-private-compose.json> --services p2p,workspace,worker,web,migrate --output <absolute-new-manifest>",
    "  release-external-files.mjs capture --compose <absolute-private-node-compose.json> --services api,web --output <absolute-new-manifest>",
    "  release-external-files.mjs verify --compose <same-frozen-compose.json> --input <absolute-0600-manifest>",
    "",
    "Linux only; captures fingerprints for used secret/config files and read-only regular-file binds.",
    "No external file is copied, changed, or replaced.",
    "External paths must be absolute canonical paths with no symlinked parents.",
    "Parent checks require a trusted deployment user and do not defeat a privileged root swap-and-restore.",
  ].join("\n");
}

async function runCLI(argv) {
  if (![undefined, "help", "--help", "-h"].includes(argv[0]))
    assertSupportedPlatform();
  const options = parseCLI(argv);
  if (options.command === "help") {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  const result =
    options.command === "capture"
      ? await captureExternalFiles({
          composePath: options.compose,
          services: options.services,
          outputPath: options.output,
        })
      : await verifyExternalFiles({
          composePath: options.compose,
          inputPath: options.input,
        });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

export {
  ExternalFilesError,
  GO_RECOVERY_SERVICES,
  NODE_RECOVERY_SERVICES,
  MANIFEST_FORMAT,
  MANIFEST_VERSION,
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  assertSupportedPlatform,
  captureExternalFiles,
  verifyExternalFiles,
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    await runCLI(process.argv.slice(2));
  } catch (error) {
    const code =
      error instanceof ExternalFilesError ? error.code : "operation_failed";
    process.stderr.write(`release external files rejected: ${code}\n`);
    process.exitCode = 1;
  }
}
