import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const posix = path.posix;

export const DEFAULT_LIMITS = Object.freeze({
  maxEntries: 20_000,
  maxBytes: 8 * 1024 * 1024 * 1024,
  deadlineMs: 5 * 60 * 1000,
  maxContainers: 4096,
});
export const CREDENTIAL_MAX_BYTES = 1024 * 1024;
export const TARGET_UID = 65_532;
export const TARGET_GID = 65_532;
export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;
export const MANIFEST_FORMAT = "duallane.release-storage-permissions/v1";

const CHUNK_BYTES = 64 * 1024;
const MAX_DOCKER_OUTPUT_BYTES = 512 * 1024;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const SAFE_ERROR_CODE = /^[a-z0-9_]+$/u;

export class StoragePermissionsError extends Error {
  constructor(code) {
    const safeCode = SAFE_ERROR_CODE.test(String(code)) ? String(code) : "operation_failed";
    super(safeCode);
    this.name = "StoragePermissionsError";
    this.code = safeCode;
  }
}

function reject(code) {
  throw new StoragePermissionsError(code);
}

function safeCode(error, fallback = "operation_failed") {
  if (error instanceof StoragePermissionsError) return error.code;
  return SAFE_ERROR_CODE.test(String(error?.code ?? "")) ? String(error.code) : fallback;
}

function asBigInt(value, code = "metadata_invalid") {
  try {
    return typeof value === "bigint" ? value : BigInt(value);
  } catch {
    reject(code);
  }
}

function asSafeNumber(value, code = "metadata_invalid") {
  const number = Number(asBigInt(value, code));
  if (!Number.isSafeInteger(number) || number < 0) reject(code);
  return number;
}

function modeBits(info) {
  return Number(asBigInt(info.mode) & 0o7777n);
}

function statKind(info) {
  if (info?.isSymbolicLink?.()) return "symlink";
  if (info?.isFile?.()) return "file";
  if (info?.isDirectory?.()) return "directory";
  return "special";
}

function stringStatValue(info, key) {
  const value = info?.[key];
  if (value === undefined || value === null) reject("metadata_invalid");
  return String(value);
}

function statMetadata(info, kind = statKind(info)) {
  if (!["file", "directory"].includes(kind)) reject("special_file_rejected");
  return Object.freeze({
    kind,
    dev: stringStatValue(info, "dev"),
    ino: stringStatValue(info, "ino"),
    nlink: stringStatValue(info, "nlink"),
    uid: asSafeNumber(info.uid),
    gid: asSafeNumber(info.gid),
    mode: modeBits(info),
    size: asSafeNumber(info.size),
    mtimeNs: stringStatValue(info, "mtimeNs"),
    ctimeNs: stringStatValue(info, "ctimeNs"),
  });
}

function sameMetadata(first, second) {
  return first && second && [
    "kind", "dev", "ino", "nlink", "uid", "gid", "mode", "size", "mtimeNs", "ctimeNs",
  ].every((key) => first[key] === second[key]);
}

function sameIdentityAndSize(first, second) {
  return first && second && first.kind === second.kind && first.dev === second.dev
    && first.ino === second.ino && first.nlink === second.nlink && first.size === second.size;
}

function sameIdentity(first, second) {
  return first && second && first.kind === second.kind && first.dev === second.dev && first.ino === second.ino;
}

function assertCanonicalAbsolute(value, code) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || value.includes("\u0000")) {
    reject(code);
  }
  if (!posix.isAbsolute(value) || posix.normalize(value) !== value) reject(`${code}_not_canonical`);
  return value;
}

function assertSafeName(value, code) {
  if (typeof value !== "string" || !SAFE_NAME.test(value)) reject(code);
  return value;
}

function isWithinOrSame(root, candidate) {
  return candidate === root || candidate.startsWith(`${root.endsWith("/") ? root : `${root}/`}`);
}

function assertNoPathOverlap(first, second, code = "backup_root_nested") {
  if (isWithinOrSame(first, second) || isWithinOrSame(second, first)) reject(code);
}

function getUid({ uid, fakeUid } = {}) {
  if (fakeUid !== undefined) return fakeUid;
  if (uid !== undefined) return uid;
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

export function assertLinuxRoot({ platform = process.platform, uid, fakeUid } = {}) {
  if (platform !== "linux") reject("linux_only");
  if (getUid({ uid, fakeUid }) !== 0) reject("root_required");
  return true;
}

function assertLinuxFileFeatures() {
  if (typeof fsConstants.O_NOFOLLOW !== "number" || typeof fsConstants.O_DIRECTORY !== "number") {
    reject("linux_filesystem_features_unavailable");
  }
}

function normalizeLimits(input = {}) {
  const values = { ...DEFAULT_LIMITS, ...input };
  for (const [name, maximum] of Object.entries(DEFAULT_LIMITS)) {
    const value = Number(values[name]);
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) reject(`limit_${name}_invalid`);
    values[name] = value;
  }
  return Object.freeze(values);
}

function makeDeadline(limits, clock = () => Date.now()) {
  const started = Number(clock());
  if (!Number.isFinite(started)) reject("clock_invalid");
  const expiresAt = started + limits.deadlineMs;
  return Object.freeze({
    check() {
      const now = Number(clock());
      if (!Number.isFinite(now) || now > expiresAt) reject("deadline_exceeded");
    },
    remaining() {
      const now = Number(clock());
      if (!Number.isFinite(now)) reject("clock_invalid");
      return Math.max(1, Math.min(30_000, expiresAt - now));
    },
  });
}

async function lstat(fsApi, target, code = "source_unavailable") {
  try {
    return await fsApi.lstat(target, { bigint: true });
  } catch {
    reject(code);
  }
}

async function inspectParents(fsApi, target, code) {
  const parts = target.slice(1).split("/");
  const parentCount = Math.max(0, parts.length - 1);
  let current = "/";
  for (let index = 0; index < parentCount; index += 1) {
    current = posix.join(current, parts[index]);
    const info = await lstat(fsApi, current, `${code}_missing`);
    if (statKind(info) === "symlink") reject(`${code}_symlink`);
    if (statKind(info) !== "directory") reject(`${code}_parent_not_directory`);
  }
}

async function assertNoSymlinkPath(fsApi, target, code) {
  await inspectParents(fsApi, target, code);
  const info = await lstat(fsApi, target, `${code}_missing`);
  const kind = statKind(info);
  if (kind === "symlink") reject(`${code}_symlink`);
  return info;
}

async function openNoFollow(fsApi, target, flags, mode, code) {
  assertLinuxFileFeatures();
  try {
    return await fsApi.open(target, flags | fsConstants.O_NOFOLLOW, mode);
  } catch {
    reject(code);
  }
}

async function readDirectory(fsApi, target) {
  try {
    return await fsApi.readdir(target, { withFileTypes: true });
  } catch {
    reject("source_unavailable");
  }
}

function sourcePathFor(root, relative) {
  return relative === "." ? root : posix.join(root, relative);
}

function backupPathFor(dataRoot, relative) {
  return relative === "." ? dataRoot : posix.join(dataRoot, relative);
}

function backupRelativeFor(record) {
  return record.backupRelative ?? record.relative;
}

function relativeChild(parent, name) {
  if (typeof name !== "string" || name.length === 0 || name.includes("\u0000") || name === "." || name === "..") {
    reject("invalid_entry_name");
  }
  return parent === "." ? name : `${parent}/${name}`;
}

function validateEntry(info, rootDev, relative) {
  const kind = statKind(info);
  if (kind === "symlink") reject("symlink_rejected");
  if (kind === "special") reject("special_file_rejected");
  const metadata = statMetadata(info, kind);
  if (metadata.dev !== rootDev) reject("cross_device_rejected");
  if (kind === "file" && metadata.nlink !== "1") reject("hardlink_rejected");
  return { relative, kind, metadata };
}

async function scanTree({ fsApi, sourcePath, limits, deadline, allowFile = false }) {
  const rootInfo = await assertNoSymlinkPath(fsApi, sourcePath, "source");
  const rootKind = statKind(rootInfo);
  if (rootKind === "symlink") reject("symlink_rejected");
  if (rootKind === "special") reject("special_file_rejected");
  if (rootKind === "file" && !allowFile) reject("source_not_directory");
  const root = validateEntry(rootInfo, statMetadata(rootInfo, rootKind).dev, ".");
  if (rootKind === "file") {
    if (root.metadata.size > limits.maxBytes) reject("tree_bytes_exceeded");
    return { records: [root], totalBytes: root.metadata.size, rootDev: root.metadata.dev };
  }

  const records = [root];
  const seen = new Set([`${root.metadata.dev}:${root.metadata.ino}`]);
  const pending = [{ relative: ".", absolute: sourcePath, metadata: root.metadata }];
  let totalBytes = 0;
  while (pending.length > 0) {
    deadline.check();
    const current = pending.pop();
    const names = await readDirectory(fsApi, current.absolute);
    names.sort((first, second) => String(first.name).localeCompare(String(second.name)));
    for (const dirent of names) {
      deadline.check();
      const name = String(dirent.name);
      const relative = relativeChild(current.relative, name);
      const absolute = sourcePathFor(sourcePath, relative);
      const info = await lstat(fsApi, absolute, "source_unavailable");
      const record = validateEntry(info, root.metadata.dev, relative);
      if (records.length >= limits.maxEntries) reject("tree_entries_exceeded");
      const identity = `${record.metadata.dev}:${record.metadata.ino}`;
      if (seen.has(identity)) reject("hardlink_or_alias_rejected");
      seen.add(identity);
      records.push(record);
      if (record.kind === "file") {
        totalBytes += record.metadata.size;
        if (totalBytes > limits.maxBytes) reject("tree_bytes_exceeded");
      } else {
        pending.push({ relative, absolute, metadata: record.metadata });
      }
    }
    const after = await lstat(fsApi, current.absolute, "source_drift");
    if (statKind(after) !== "directory" || !sameMetadata(statMetadata(after, "directory"), current.metadata)) {
      reject("source_drift");
    }
  }
  return { records, totalBytes, rootDev: root.metadata.dev };
}

async function ensurePrivateDirectory(fsApi, target, code, create = false) {
  if (create) {
    try {
      await fsApi.mkdir(target, { mode: PRIVATE_DIRECTORY_MODE });
    } catch (error) {
      if (error?.code !== "EEXIST") reject(`${code}_create_failed`);
    }
  }
  const info = await lstat(fsApi, target, `${code}_missing`);
  if (statKind(info) !== "directory") reject(`${code}_not_directory`);
  if (modeBits(info) !== PRIVATE_DIRECTORY_MODE || asSafeNumber(info.uid) !== 0) reject(`${code}_not_private`);
  return info;
}

async function createExclusivePrivateDirectory(fsApi, target, code) {
  try {
    await fsApi.mkdir(target, { mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    if (error?.code === "EEXIST") reject(`${code}_exists`);
    reject(`${code}_create_failed`);
  }
  return ensurePrivateDirectory(fsApi, target, code);
}

async function ensureBackupRoot(fsApi, backupDir) {
  await inspectParents(fsApi, backupDir, "backup_dir");
  try {
    await ensurePrivateDirectory(fsApi, backupDir, "backup_dir");
  } catch (error) {
    if (!(error instanceof StoragePermissionsError) || !error.code.endsWith("_missing")) throw error;
    await ensurePrivateDirectory(fsApi, backupDir, "backup_dir", true);
  }
}

function runIdentifier(value) {
  if (value === undefined) return `run-${Date.now().toString(36)}-${randomUUID().replaceAll("-", "")}`;
  if (typeof value !== "string" || !/^run-[A-Za-z0-9-]{1,160}$/u.test(value)) reject("run_id_invalid");
  return value;
}

async function writeExclusiveJSON(fsApi, target, value) {
  const payload = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL;
  let handle;
  try {
    handle = await fsApi.open(target, flags | fsConstants.O_NOFOLLOW, 0o600);
    await handle.writeFile(payload);
    await handle.chmod(PRIVATE_FILE_MODE);
    await handle.sync();
  } catch {
    reject("backup_metadata_write_failed");
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* keep the safe operation code */ }
    }
  }
  const info = await lstat(fsApi, target, "backup_metadata_write_failed");
  if (statKind(info) !== "file" || modeBits(info) !== PRIVATE_FILE_MODE || asSafeNumber(info.uid) !== 0) {
    reject("backup_metadata_write_failed");
  }
  await syncDirectory(fsApi, posix.dirname(target));
  return statMetadata(info, "file");
}

async function syncDirectory(fsApi, target) {
  let handle;
  try {
    handle = await openNoFollow(fsApi, target, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY, 0, "backup_metadata_sync_failed");
    await handle.sync();
  } catch {
    reject("backup_metadata_sync_failed");
  } finally {
    if (handle) try { await handle.close(); } catch { /* retain the original outcome */ }
  }
}

async function writeAtomicJSON(fsApi, target, value) {
  const temporary = `${target}.tmp-${randomUUID().replaceAll("-", "")}`;
  await writeExclusiveJSON(fsApi, temporary, value);
  try {
    let existing;
    try { existing = await fsApi.lstat(target, { bigint: true }); } catch (error) {
      if (error?.code !== "ENOENT") reject("backup_metadata_write_failed");
    }
    if (existing && statKind(existing) !== "file") reject("backup_metadata_write_failed");
    await fsApi.rename(temporary, target);
    await syncDirectory(fsApi, posix.dirname(target));
  } catch (error) {
    if (error instanceof StoragePermissionsError) throw error;
    reject("backup_metadata_write_failed");
  }
}

async function createBackupContext({ fsApi, backupDir, sourcePath, operation, project, runId }) {
  await ensureBackupRoot(fsApi, backupDir);
  const identifier = runIdentifier(runId);
  const runDir = posix.join(backupDir, identifier);
  await createExclusivePrivateDirectory(fsApi, runDir, "backup_run");
  const dataDir = posix.join(runDir, "data");
  await createExclusivePrivateDirectory(fsApi, dataDir, "backup_data");
  const manifestPath = posix.join(runDir, "manifest.json");
  const phasePath = posix.join(runDir, "phase.json");
  const reportPath = posix.join(runDir, "report.json");
  await writeAtomicJSON(fsApi, phasePath, {
    format: MANIFEST_FORMAT,
    version: 1,
    status: "in_progress",
    operation,
    runId: identifier,
    sourcePath,
    project: project ?? null,
    dataDirectory: "data",
    entries: [],
  });
  return {
    operation,
    project: project ?? null,
    sourcePath,
    runId: identifier,
    runDir,
    dataDir,
    manifestPath,
    phasePath,
    reportPath,
    copied: [],
  };
}

function contextEntries(records) {
  return records.map((record) => ({
    relative: record.relative,
    kind: record.kind,
    original: record.metadata,
    backupRelative: record.kind === "file" ? backupRelativeFor(record) : null,
    sha256: record.sha256 ?? null,
  }));
}

async function writeContextPhase(ctx, fsApi, status, records, extra = {}) {
  await writeAtomicJSON(fsApi, ctx.phasePath, {
    format: MANIFEST_FORMAT,
    version: 1,
    status,
    operation: ctx.operation,
    runId: ctx.runId,
    sourcePath: ctx.sourcePath,
    project: ctx.project,
    dataDirectory: "data",
    entries: contextEntries(records),
    copiedEntries: ctx.copied.length,
    copiedBytes: ctx.copied.reduce((sum, item) => sum + item.bytes, 0),
    ...extra,
  });
}

async function writeOriginalManifest(ctx, fsApi, records, totalBytes) {
  await writeExclusiveJSON(fsApi, ctx.manifestPath, {
    format: MANIFEST_FORMAT,
    version: 1,
    status: "verified_original",
    operation: ctx.operation,
    runId: ctx.runId,
    sourcePath: ctx.sourcePath,
    project: ctx.project,
    dataDirectory: "data",
    totalBytes,
    entries: contextEntries(records),
  });
}

async function writeContextReport(ctx, fsApi, report) {
  try {
    await writeExclusiveJSON(fsApi, ctx.reportPath, report);
  } catch {
    // The manifest and copied bytes are the required recovery evidence.
  }
}

async function retainFailure(ctx, fsApi, records, error) {
  const code = safeCode(error);
  try { await writeContextPhase(ctx, fsApi, "failed", records, { errorCode: code }); } catch { /* retain the original outcome */ }
  await writeContextReport(ctx, fsApi, {
    format: MANIFEST_FORMAT,
    version: 1,
    status: "failed",
    operation: ctx.operation,
    errorCode: code,
    copiedEntries: ctx.copied.length,
    copiedBytes: ctx.copied.reduce((sum, item) => sum + item.bytes, 0),
  });
}

async function writeFileFully(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const result = await handle.write(buffer, offset, buffer.length - offset);
    if (!result || result.bytesWritten <= 0) reject("backup_write_failed");
    offset += result.bytesWritten;
  }
}

async function copyOneFile({ fsApi, sourcePath, backupPath, record, deadline }) {
  await assertNoSymlinkPath(fsApi, sourcePath, "source");
  await inspectParents(fsApi, backupPath, "backup_data");
  let sourceHandle;
  let backupHandle;
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    sourceHandle = await openNoFollow(fsApi, sourcePath, fsConstants.O_RDONLY, 0, "source_open_failed");
    const openedSource = statMetadata(await sourceHandle.stat({ bigint: true }), "file");
    if (!sameMetadata(openedSource, record.metadata)) reject("source_drift");
    backupHandle = await openNoFollow(
      fsApi,
      backupPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      PRIVATE_FILE_MODE,
      "backup_file_create_failed",
    );
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    while (true) {
      deadline.check();
      const result = await sourceHandle.read(buffer, 0, buffer.length, null);
      if (!result || result.bytesRead === 0) break;
      const chunk = buffer.subarray(0, result.bytesRead);
      bytes += result.bytesRead;
      if (bytes > record.metadata.size) reject("source_drift");
      hash.update(chunk);
      await writeFileFully(backupHandle, chunk);
    }
    if (bytes !== record.metadata.size) reject("source_drift");
    await backupHandle.chmod(PRIVATE_FILE_MODE);
    await backupHandle.sync();
    const afterSource = statMetadata(await sourceHandle.stat({ bigint: true }), "file");
    if (!sameMetadata(afterSource, record.metadata)) reject("source_drift");
  } catch (error) {
    if (error instanceof StoragePermissionsError) throw error;
    reject("backup_copy_failed");
  } finally {
    if (sourceHandle) {
      try { await sourceHandle.close(); } catch { /* preserve the operation outcome */ }
    }
    if (backupHandle) {
      try { await backupHandle.close(); } catch { /* preserve the operation outcome */ }
    }
  }
  const backupInfo = await lstat(fsApi, backupPath, "backup_file_missing");
  const backupMetadata = statMetadata(backupInfo, "file");
  if (backupMetadata.uid !== 0 || backupMetadata.gid !== 0 || backupMetadata.nlink !== "1"
    || backupMetadata.mode !== PRIVATE_FILE_MODE || backupMetadata.size !== bytes) {
    reject("backup_file_invalid");
  }
  return { sha256: hash.digest("hex"), bytes };
}

async function makeBackup({ fsApi, ctx, records, deadline }) {
  const directories = records.filter((record) => record.kind === "directory")
    .sort((first, second) => first.relative.split("/").length - second.relative.split("/").length);
  for (const record of directories) {
    deadline.check();
    if (record.relative === ".") continue;
    const target = backupPathFor(ctx.dataDir, record.relative);
    await inspectParents(fsApi, target, "backup_data");
    try {
      await fsApi.mkdir(target, { mode: PRIVATE_DIRECTORY_MODE });
    } catch {
      reject("backup_directory_create_failed");
    }
    await ensurePrivateDirectory(fsApi, target, "backup_directory");
  }
  for (const record of records.filter((item) => item.kind === "file")) {
    deadline.check();
    const result = await copyOneFile({
      fsApi,
      sourcePath: sourcePathFor(ctx.sourcePath, record.relative),
      backupPath: backupPathFor(ctx.dataDir, backupRelativeFor(record)),
      record,
      deadline,
    });
    record.sha256 = result.sha256;
    ctx.copied.push({ relative: record.relative, bytes: result.bytes });
  }
  // File fsync alone does not persist its directory entry. Persist the entire
  // private copy and the newly created run/backup links before the immutable
  // original manifest can authorize a source metadata change.
  for (const record of [...directories].reverse()) {
    deadline.check();
    await syncDirectory(fsApi, backupPathFor(ctx.dataDir, record.relative));
  }
  for (const directory of [ctx.dataDir, ctx.runDir, posix.dirname(ctx.runDir), posix.dirname(posix.dirname(ctx.runDir))]) {
    deadline.check();
    await syncDirectory(fsApi, directory);
  }
}

async function hashFile({ fsApi, target, expected, deadline, codePrefix, maxBytes }) {
  await assertNoSymlinkPath(fsApi, target, codePrefix);
  const beforeInfo = await lstat(fsApi, target, `${codePrefix}_missing`);
  if (statKind(beforeInfo) !== "file") reject(`${codePrefix}_not_regular`);
  const before = statMetadata(beforeInfo, "file");
  if (expected && !sameIdentityAndSize(before, expected)) reject(`${codePrefix}_changed`);
  let handle;
  let total = 0;
  const hash = createHash("sha256");
  try {
    handle = await openNoFollow(fsApi, target, fsConstants.O_RDONLY, 0, `${codePrefix}_open_failed`);
    const opened = statMetadata(await handle.stat({ bigint: true }), "file");
    if (!sameIdentityAndSize(opened, before)) reject(`${codePrefix}_changed`);
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    while (true) {
      deadline.check();
      const result = await handle.read(buffer, 0, buffer.length, null);
      if (!result || result.bytesRead === 0) break;
      total += result.bytesRead;
      if (total > maxBytes) reject(`${codePrefix}_too_large`);
      hash.update(buffer.subarray(0, result.bytesRead));
    }
    if (total !== before.size) reject(`${codePrefix}_changed`);
    const after = statMetadata(await handle.stat({ bigint: true }), "file");
    if (!sameIdentityAndSize(after, before)) reject(`${codePrefix}_changed`);
  } catch (error) {
    if (error instanceof StoragePermissionsError) throw error;
    reject(`${codePrefix}_read_failed`);
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* preserve the operation outcome */ }
    }
  }
  return { metadata: before, sha256: hash.digest("hex"), bytes: total };
}

async function verifyBeforeMutation({ fsApi, ctx, records, deadline, maxBytes }) {
  for (const record of records.filter((item) => item.kind === "file")) {
    deadline.check();
    const backup = await hashFile({
      fsApi,
      target: backupPathFor(ctx.dataDir, backupRelativeFor(record)),
      expected: undefined,
      deadline,
      codePrefix: "backup",
      maxBytes: record.metadata.size,
    });
    if (backup.metadata.uid !== 0 || backup.metadata.gid !== 0 || backup.metadata.mode !== PRIVATE_FILE_MODE
      || backup.metadata.nlink !== "1" || backup.bytes !== record.metadata.size) {
      reject("backup_metadata_invalid");
    }
    if (backup.sha256 !== record.sha256) reject("backup_hash_mismatch");
    const source = await hashFile({
      fsApi,
      target: sourcePathFor(ctx.sourcePath, record.relative),
      expected: record.metadata,
      deadline,
      codePrefix: "source",
      maxBytes,
    });
    if (!sameMetadata(source.metadata, record.metadata) || source.sha256 !== backup.sha256) reject("source_drift");
  }
}

async function mutateRecord({ fsApi, target, record, deadline }) {
  deadline.check();
  await assertNoSymlinkPath(fsApi, target, "source");
  const flags = record.kind === "directory"
    ? fsConstants.O_RDONLY | fsConstants.O_DIRECTORY
    : fsConstants.O_RDONLY;
  let handle;
  try {
    handle = await openNoFollow(fsApi, target, flags, 0, "mutation_open_failed");
    const before = statMetadata(await handle.stat({ bigint: true }), record.kind);
    if (!sameIdentityAndSize(before, record.metadata)) reject("source_drift");
    await handle.chown(TARGET_UID, TARGET_GID);
    await handle.chmod(record.kind === "directory" ? PRIVATE_DIRECTORY_MODE : PRIVATE_FILE_MODE);
    await handle.sync();
    const after = statMetadata(await handle.stat({ bigint: true }), record.kind);
    if (after.uid !== TARGET_UID || after.gid !== TARGET_GID
      || after.mode !== (record.kind === "directory" ? PRIVATE_DIRECTORY_MODE : PRIVATE_FILE_MODE)
      || !sameIdentityAndSize(after, record.metadata)) {
      reject("target_metadata_invalid");
    }
  } catch (error) {
    if (error instanceof StoragePermissionsError) throw error;
    reject("mutation_failed");
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* preserve the operation outcome */ }
    }
  }
}

async function mutateTree({ fsApi, ctx, records, deadline }) {
  const ordered = [...records].sort((first, second) => {
    const depth = (value) => value.relative === "." ? 0 : value.relative.split("/").length;
    const byDepth = depth(second) - depth(first);
    if (byDepth !== 0) return byDepth;
    return first.kind === "file" ? -1 : 1;
  });
  for (const record of ordered) {
    await mutateRecord({
      fsApi,
      target: sourcePathFor(ctx.sourcePath, record.relative),
      record,
      deadline,
    });
  }
}

async function verifyTarget({ fsApi, ctx, records, rootDev, deadline }) {
  for (const record of records) {
    deadline.check();
    const info = await assertNoSymlinkPath(fsApi, sourcePathFor(ctx.sourcePath, record.relative), "source");
    const kind = statKind(info);
    if (kind !== record.kind) reject("target_type_changed");
    const metadata = statMetadata(info, kind);
    if (metadata.dev !== rootDev || !sameIdentityAndSize(metadata, record.metadata)
      || metadata.uid !== TARGET_UID || metadata.gid !== TARGET_GID
      || metadata.mode !== (kind === "directory" ? PRIVATE_DIRECTORY_MODE : PRIVATE_FILE_MODE)) {
      reject("target_metadata_invalid");
    }
    if (kind === "file" && metadata.nlink !== "1") reject("hardlink_rejected");
  }
}

async function verifyAfterMutation({ fsApi, ctx, records, deadline, maxBytes, rootDev }) {
  await verifyTarget({ fsApi, ctx, records, rootDev, deadline });
  for (const record of records.filter((item) => item.kind === "file")) {
    const source = await hashFile({
      fsApi,
      target: sourcePathFor(ctx.sourcePath, record.relative),
      expected: record.metadata,
      deadline,
      codePrefix: "source",
      maxBytes,
    });
    if (source.sha256 !== record.sha256) reject("source_hash_mismatch");
    const backup = await hashFile({
      fsApi,
      target: backupPathFor(ctx.dataDir, backupRelativeFor(record)),
      expected: undefined,
      deadline,
      codePrefix: "backup",
      maxBytes: record.metadata.size,
    });
    if (backup.sha256 !== source.sha256) reject("backup_hash_mismatch");
  }
}

function summary(operation, records, totalBytes) {
  return {
    status: "completed",
    operation,
    entryCount: records.length,
    fileCount: records.filter((record) => record.kind === "file").length,
    directoryCount: records.filter((record) => record.kind === "directory").length,
    totalBytes,
    backupVerified: true,
    targetVerified: true,
  };
}

function attachPrivateLocations(result, ctx) {
  Object.defineProperties(result, {
    runDirectory: { value: ctx.runDir, enumerable: false },
    manifestPath: { value: ctx.manifestPath, enumerable: false },
    reportPath: { value: ctx.reportPath, enumerable: false },
  });
  return Object.freeze(result);
}

async function finishOperation({ fsApi, ctx, records, totalBytes, operation }) {
  await writeContextPhase(ctx, fsApi, "completed", records, { totalBytes });
  await writeContextReport(ctx, fsApi, {
    format: MANIFEST_FORMAT,
    version: 1,
    status: "completed",
    operation,
    entryCount: records.length,
    fileCount: records.filter((record) => record.kind === "file").length,
    directoryCount: records.filter((record) => record.kind === "directory").length,
    totalBytes,
  });
  return attachPrivateLocations(summary(operation, records, totalBytes), ctx);
}

function assertCredentialPreconditions(records) {
  if (records.length !== 1 || records[0].kind !== "file") reject("credential_not_regular");
  if (records[0].metadata.mode !== PRIVATE_FILE_MODE) reject("credential_permissions_invalid");
  if (records[0].metadata.size > CREDENTIAL_MAX_BYTES) reject("credential_too_large");
}

async function runFilesystemOperation({
  operation,
  sourcePath,
  backupDir,
  project,
  fsApi = fs,
  platform = process.platform,
  uid,
  fakeUid,
  limits: suppliedLimits,
  clock,
  runId,
  isCredential = false,
  beforeMutation,
  afterMutation,
  writerGuard,
  hooks = {},
  operationDeadline,
}) {
  assertLinuxRoot({ platform, uid, fakeUid });
  assertLinuxFileFeatures();
  const limits = normalizeLimits(suppliedLimits);
  const effectiveLimits = isCredential
    ? Object.freeze({ ...limits, maxEntries: 1, maxBytes: Math.min(limits.maxBytes, CREDENTIAL_MAX_BYTES) })
    : limits;
  const deadline = operationDeadline ?? makeDeadline(effectiveLimits, clock);
  const normalizedSource = assertCanonicalAbsolute(sourcePath, "source_path");
  const normalizedBackup = assertCanonicalAbsolute(backupDir, "backup_dir_path");
  const sourceGuard = isCredential ? posix.dirname(normalizedSource) : normalizedSource;
  assertNoPathOverlap(sourceGuard, normalizedBackup);
  const ctx = await createBackupContext({
    fsApi,
    backupDir: normalizedBackup,
    sourcePath: normalizedSource,
    operation,
    project,
    runId,
  });
  let records = [];
  try {
    deadline.check();
    if (writerGuard) await writerGuard("before_scan", deadline);
    const scanned = await scanTree({
      fsApi,
      sourcePath: normalizedSource,
      limits: effectiveLimits,
      deadline,
      allowFile: isCredential,
    });
    records = scanned.records;
    if (isCredential) {
      assertCredentialPreconditions(records);
      records[0].backupRelative = "credential";
    }
    await writeContextPhase(ctx, fsApi, "scanned", records, { totalBytes: scanned.totalBytes });
    if (writerGuard) await writerGuard("before_backup", deadline);
    await makeBackup({ fsApi, ctx, records, deadline });
    await writeContextPhase(ctx, fsApi, "backup_copied", records, { totalBytes: scanned.totalBytes });
    await verifyBeforeMutation({
      fsApi,
      ctx,
      records,
      deadline,
      maxBytes: effectiveLimits.maxBytes,
    });
    await writeOriginalManifest(ctx, fsApi, records, scanned.totalBytes);
    await writeContextPhase(ctx, fsApi, "backup_verified", records, { totalBytes: scanned.totalBytes });
    if (writerGuard) await writerGuard("before_mutation", deadline);
    if (typeof hooks.beforeMutation === "function") {
      await hooks.beforeMutation({ ctx, records, fsApi, deadline });
    }
    let mutationError;
    try {
      await beforeMutation({ fsApi, ctx, records, deadline });
    } catch (error) {
      mutationError = error;
    }
    if (writerGuard) {
      try {
        await writerGuard("after_mutation", deadline);
      } catch (error) {
        mutationError ??= error;
      }
    }
    if (mutationError) throw mutationError;
    await afterMutation({
      fsApi,
      ctx,
      records,
      deadline,
      maxBytes: effectiveLimits.maxBytes,
      rootDev: scanned.rootDev,
    });
    return await finishOperation({ fsApi, ctx, records, totalBytes: scanned.totalBytes, operation });
  } catch (error) {
    await retainFailure(ctx, fsApi, records, error);
    if (error instanceof StoragePermissionsError) throw error;
    reject(safeCode(error));
  }
}

export async function prepareCredential(options = {}) {
  return runFilesystemOperation({
    ...options,
    operation: "credential",
    sourcePath: options.sourcePath ?? options.path,
    isCredential: true,
    beforeMutation: mutateTree,
    afterMutation: verifyAfterMutation,
    hooks: options.hooks,
  });
}

function parseDockerObject(value, code) {
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { reject(code); }
  }
  if (value && typeof value === "object" && typeof value.stdout === "string") {
    try { return JSON.parse(value.stdout); } catch { reject(code); }
  }
  return value;
}

function assertDockerHostInfo(info) {
  if (!info || typeof info !== "object" || typeof info.DockerRootDir !== "string" || !Array.isArray(info.SecurityOptions)) {
    reject("docker_info_invalid");
  }
  const rootless = info.Rootless === true || String(info.Rootless ?? "").toLowerCase() === "true";
  const security = info.SecurityOptions.map((value) => String(value).toLowerCase()).join(" ");
  if (rootless || /rootless|userns(?:-remap)?|user\s*namespace/u.test(security)) {
    reject("docker_user_namespace_unsupported");
  }
  return assertCanonicalAbsolute(info.DockerRootDir, "docker_root_invalid");
}

function unwrapOne(value, code) {
  const parsed = parseDockerObject(value, code);
  if (Array.isArray(parsed)) {
    if (parsed.length !== 1) reject(code);
    return parsed[0];
  }
  return parsed;
}

async function dockerCall(runner, method, deadline, ...args) {
  if (!runner || typeof runner[method] !== "function") reject("docker_runner_invalid");
  try {
    return await runner[method](...args, deadline);
  } catch (error) {
    if (error instanceof StoragePermissionsError) throw error;
    reject(`docker_${method}_failed`);
  }
}

function volumeOptionsAreEmpty(options) {
  return options === null || options === undefined
    || (typeof options === "object" && !Array.isArray(options) && Object.keys(options).length === 0);
}

function labelsFingerprint(labels) {
  return JSON.stringify(Object.entries(labels).sort(([first], [second]) => first.localeCompare(second)));
}

function validateVolumeInspection(inspected, { dockerRootDir, volumeName, project }, code) {
  if (!inspected || typeof inspected !== "object" || inspected.Name !== volumeName || inspected.Driver !== "local"
    || !volumeOptionsAreEmpty(inspected.Options) || typeof inspected.CreatedAt !== "string" || !inspected.CreatedAt) {
    reject(code);
  }
  const labels = inspected.Labels;
  if (!labels || typeof labels !== "object" || Array.isArray(labels)
    || labels["com.docker.compose.project"] !== project
    || typeof labels["com.docker.compose.volume"] !== "string"
    || !SAFE_NAME.test(labels["com.docker.compose.volume"])) {
    reject(code);
  }
  const mountpoint = assertCanonicalAbsolute(inspected.Mountpoint, "volume_mountpoint");
  const expected = posix.join(dockerRootDir, "volumes", volumeName, "_data");
  if (posix.normalize(expected) !== expected || mountpoint !== expected) reject("volume_mountpoint_invalid");
  return {
    mountpoint,
    createdAt: inspected.CreatedAt,
    labelsFingerprint: labelsFingerprint(labels),
    optionsFingerprint: JSON.stringify(inspected.Options ?? {}),
  };
}

async function resolveVolume({ fsApi, runner, volumeName, project, deadline }) {
  deadline.check();
  const hostInfo = parseDockerObject(await dockerCall(runner, "info", deadline), "docker_info_invalid");
  const dockerRootDir = assertDockerHostInfo(hostInfo);
  deadline.check();
  const inspected = unwrapOne(await dockerCall(runner, "volumeInspect", deadline, volumeName), "volume_inspect_invalid");
  const inspectedIdentity = validateVolumeInspection(inspected, { dockerRootDir, volumeName, project }, "volume_identity_invalid");
  const mountpoint = inspectedIdentity.mountpoint;
  const dockerRootInfo = await assertNoSymlinkPath(fsApi, dockerRootDir, "docker_root");
  if (statKind(dockerRootInfo) !== "directory") reject("docker_root_not_directory");
  const rootInfo = await assertNoSymlinkPath(fsApi, mountpoint, "volume_mountpoint");
  if (statKind(rootInfo) !== "directory") reject("volume_mountpoint_not_directory");
  return {
    dockerRootDir,
    mountpoint,
    volumeName,
    project,
    createdAt: inspectedIdentity.createdAt,
    labelsFingerprint: inspectedIdentity.labelsFingerprint,
    optionsFingerprint: inspectedIdentity.optionsFingerprint,
    dockerRootIdentity: statMetadata(dockerRootInfo, "directory"),
    mountpointIdentity: statMetadata(rootInfo, "directory"),
  };
}

function normalizeContainerIds(value) {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  if (value && typeof value === "object" && typeof value.stdout === "string") value = value.stdout;
  if (typeof value === "string") return value.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean);
  reject("docker_container_list_invalid");
}

function mountWritable(mount) {
  if (mount?.RW === true || mount?.ReadOnly === false) return true;
  if (mount?.RW === false || mount?.ReadOnly === true) return false;
  const type = String(mount?.Type ?? "").toLowerCase();
  if (type === "bind" || type === "volume") reject("docker_mount_mode_unproven");
  return false;
}

async function writerSource(fsApi, source) {
  const canonical = assertCanonicalAbsolute(source, "docker_mount_source_invalid");
  try {
    const resolved = await fsApi.realpath(canonical);
    return assertCanonicalAbsolute(String(resolved), "docker_mount_source_invalid");
  } catch {
    reject("docker_mount_source_unproven");
  }
}

async function verifyVolumeIdentity({ fsApi, runner, volume, deadline }) {
  deadline.check();
  const hostInfo = parseDockerObject(await dockerCall(runner, "info", deadline), "docker_info_invalid");
  const dockerRootDir = assertDockerHostInfo(hostInfo);
  if (dockerRootDir !== volume.dockerRootDir) reject("volume_identity_changed");
  const inspected = unwrapOne(await dockerCall(runner, "volumeInspect", deadline, volume.volumeName), "volume_inspect_invalid");
  const inspectedIdentity = validateVolumeInspection(
    inspected,
    { dockerRootDir, volumeName: volume.volumeName, project: volume.project },
    "volume_identity_changed",
  );
  if (inspectedIdentity.mountpoint !== volume.mountpoint
    || inspectedIdentity.createdAt !== volume.createdAt
    || inspectedIdentity.labelsFingerprint !== volume.labelsFingerprint
    || inspectedIdentity.optionsFingerprint !== volume.optionsFingerprint) {
    reject("volume_identity_changed");
  }
  const dockerRoot = await assertNoSymlinkPath(fsApi, volume.dockerRootDir, "docker_root");
  const mountpoint = await assertNoSymlinkPath(fsApi, volume.mountpoint, "volume_mountpoint");
  if (statKind(dockerRoot) !== "directory" || statKind(mountpoint) !== "directory") reject("volume_identity_changed");
  const dockerRootIdentity = statMetadata(dockerRoot, "directory");
  const mountpointIdentity = statMetadata(mountpoint, "directory");
  if (!sameIdentity(dockerRootIdentity, volume.dockerRootIdentity)
    || !sameIdentity(mountpointIdentity, volume.mountpointIdentity)) {
    reject("volume_identity_changed");
  }
  return true;
}

async function assertNoRunningWriters({ fsApi, runner, volume, volumeRoot, volumeName, deadline }) {
  await verifyVolumeIdentity({ fsApi, runner, volume, deadline });
  deadline.check();
  const ids = normalizeContainerIds(await dockerCall(runner, "containerIds", deadline));
  if (ids.length > DEFAULT_LIMITS.maxContainers) reject("docker_too_many_containers");
  for (const id of ids) {
    deadline.check();
    if (!/^[0-9a-f]{64}$/iu.test(id)) reject("docker_container_id_invalid");
    const details = unwrapOne(await dockerCall(runner, "containerInspect", deadline, id), "docker_container_inspect_invalid");
    const running = details?.State?.Running;
    if (typeof running !== "boolean") reject("docker_container_state_invalid");
    if (!running) continue;
    if (!Array.isArray(details.Mounts)) reject("docker_mounts_unproven");
    for (const mount of details.Mounts) {
      if (!mountWritable(mount)) continue;
      const type = String(mount?.Type ?? "").toLowerCase();
      const name = typeof mount?.Name === "string" ? mount.Name : "";
      if (name === volumeName) reject("running_writer_detected");
      if (!mount || (type !== "bind" && type !== "volume" && typeof mount.Source !== "string")) continue;
      if (typeof mount.Source !== "string" || mount.Source.length === 0) reject("docker_mount_source_unproven");
      const source = await writerSource(fsApi, mount.Source);
      if (isWithinOrSame(source, volumeRoot) || isWithinOrSame(volumeRoot, source)) reject("running_writer_detected");
    }
  }
}

export function createDockerRunner({ binary = "docker", spawn = spawnSync } = {}) {
  function command(args, deadline) {
    deadline.check();
    let result;
    try {
      result = spawn(binary, args, {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: deadline.remaining(),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      reject("docker_unavailable");
    }
    if (result?.error?.code === "ETIMEDOUT") reject("docker_timeout");
    if (result?.status !== 0) reject("docker_command_failed");
    const output = String(result?.stdout ?? "");
    if (Buffer.byteLength(output, "utf8") > MAX_DOCKER_OUTPUT_BYTES) reject("docker_output_too_large");
    return output;
  }
  return {
    async info(deadline) {
      return parseDockerObject(command(["info", "--format", "{{json .}}"], deadline), "docker_info_invalid");
    },
    async volumeInspect(volumeName, deadline) {
      return parseDockerObject(command(["volume", "inspect", volumeName], deadline), "volume_inspect_invalid");
    },
    async containerIds(deadline) {
      return command(["container", "ls", "--all", "--quiet", "--no-trunc"], deadline);
    },
    async containerInspect(id, deadline) {
      return parseDockerObject(command(["container", "inspect", id], deadline), "docker_container_inspect_invalid");
    },
  };
}

export async function prepareVolume(options = {}) {
  assertLinuxRoot({ platform: options.platform ?? process.platform, uid: options.uid, fakeUid: options.fakeUid });
  assertLinuxFileFeatures();
  const fsApi = options.fsApi ?? fs;
  const limits = normalizeLimits(options.limits);
  const deadline = makeDeadline(limits, options.clock);
  const volumeName = assertSafeName(options.volumeName ?? options.volume, "volume_name_invalid");
  const project = assertSafeName(options.project, "project_invalid");
  const backupDir = assertCanonicalAbsolute(options.backupDir, "backup_dir_path");
  const runner = options.runner ?? createDockerRunner();
  const volume = await resolveVolume({ fsApi, runner, volumeName, project, deadline });
  assertNoPathOverlap(volume.mountpoint, backupDir);
  const guard = (stage, currentDeadline) => assertNoRunningWriters({
    fsApi,
    runner,
    volume,
    volumeRoot: volume.mountpoint,
    volumeName,
    deadline: currentDeadline,
    stage,
  });
  try {
    const result = await runFilesystemOperation({
      operation: "volume",
      sourcePath: volume.mountpoint,
      backupDir,
      project,
      fsApi,
      platform: options.platform ?? process.platform,
      uid: options.uid,
      fakeUid: options.fakeUid,
      limits,
      clock: options.clock,
      runId: options.runId,
      operationDeadline: deadline,
      beforeMutation: mutateTree,
      afterMutation: verifyAfterMutation,
      writerGuard: guard,
      hooks: options.hooks,
    });
    return result;
  } catch (error) {
    if (error instanceof StoragePermissionsError) throw error;
    reject(safeCode(error));
  }
}

export function parseCli(argv) {
  if (!Array.isArray(argv) || argv.length === 0) reject("command_required");
  const command = argv[0];
  if (command === "help" || command === "--help" || command === "-h") return { command: "help" };
  if (command !== "credential" && command !== "volume") reject("command_invalid");
  const values = { command };
  const allowed = command === "credential"
    ? new Set(["path", "backup-dir"])
    : new Set(["volume", "backup-dir", "project"]);
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (typeof argument !== "string" || !argument.startsWith("--") || !allowed.has(argument.slice(2))) reject("argument_invalid");
    const key = argument.slice(2);
    if (values[key] !== undefined) reject("argument_duplicate");
    const value = argv[++index];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) reject("argument_value_missing");
    values[key] = value;
  }
  if (!values["backup-dir"]) reject("backup_dir_required");
  assertCanonicalAbsolute(values["backup-dir"], "backup_dir_path");
  if (command === "credential") {
    if (!values.path) reject("credential_path_required");
    assertCanonicalAbsolute(values.path, "credential_path");
    return { command, path: values.path, backupDir: values["backup-dir"] };
  }
  if (!values.volume) reject("volume_name_required");
  if (!values.project) reject("project_required");
  assertSafeName(values.volume, "volume_name_invalid");
  assertSafeName(values.project, "project_invalid");
  return { command, volume: values.volume, project: values.project, backupDir: values["backup-dir"] };
}

export function helpText() {
  return [
    "Usage:",
    "  release-storage-permissions.mjs credential --path <absolute-path> --backup-dir <absolute-private-dir>",
    "  release-storage-permissions.mjs volume --volume <name> --project <compose-project> --backup-dir <absolute-private-dir>",
    "",
    "Linux root only. The command takes an offline backup, verifies bytes, then tightens ownership and modes.",
    "It never stops Docker containers or restores source bytes/metadata automatically.",
  ].join("\n");
}

function safeSummary(result) {
  return {
    status: result.status,
    operation: result.operation,
    entryCount: result.entryCount,
    fileCount: result.fileCount,
    directoryCount: result.directoryCount,
    totalBytes: result.totalBytes,
    backupVerified: result.backupVerified,
    targetVerified: result.targetVerified,
  };
}

export async function runCli(argv, context = {}) {
  assertLinuxRoot({ platform: context.platform ?? process.platform, uid: context.uid, fakeUid: context.fakeUid });
  const options = parseCli(argv);
  const output = context.stdout ?? process.stdout;
  if (options.command === "help") {
    output.write(`${helpText()}\n`);
    return;
  }
  const result = options.command === "credential"
    ? await prepareCredential({
      path: options.path,
      backupDir: options.backupDir,
      fsApi: context.fsApi,
      platform: context.platform,
      uid: context.uid,
      fakeUid: context.fakeUid,
      limits: context.limits,
      clock: context.clock,
      runId: context.runId,
    })
    : await prepareVolume({
      volume: options.volume,
      project: options.project,
      backupDir: options.backupDir,
      fsApi: context.fsApi,
      runner: context.runner,
      platform: context.platform,
      uid: context.uid,
      fakeUid: context.fakeUid,
      limits: context.limits,
      clock: context.clock,
      runId: context.runId,
    });
  output.write(`${JSON.stringify(safeSummary(result))}\n`);
  return safeSummary(result);
}

export {
  normalizeLimits,
  scanTree,
  assertNoRunningWriters,
  resolveVolume,
};

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    await runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`release storage permissions rejected: ${safeCode(error)}\n`);
    process.exitCode = 1;
  }
}
