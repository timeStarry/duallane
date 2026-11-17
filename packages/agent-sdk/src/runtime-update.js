import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { compareRuntimeSemver, DUALLANE_AGENT_SDK_VERSION } from "./index.js";
import { requestGateway, readGatewayBytes } from "./transport.js";

const RUNTIME_MAX_BYTES = 5 * 1024 * 1024;

function runtimeUpdateError(code) {
  return Object.assign(new Error("Official runtime update could not complete safely."), { code });
}

function runtimeAtomicWrite(file, bytes, mode = 0o600) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", mode);
    fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, file);
    if (process.platform !== "win32") {
      const directory = fs.openSync(path.dirname(file), "r");
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function runtimeReadPrivateJson(file, maximum = 8192) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maximum) throw runtimeUpdateError("runtime.unsafe_target");
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw runtimeUpdateError("runtime.recovery_required"); }
}

function runtimeAcquireUpdateLock(target) {
  const lock = `${target}.update-lock`;
  const owner = { pid: process.pid, nonce: crypto.randomUUID() };
  const alive = (pid) => {
    if (!Number.isSafeInteger(pid) || pid < 1) return true;
    try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
  };
  const create = () => fs.writeFileSync(lock, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
  try { create(); } catch (error) {
    if (error.code !== "EEXIST" || alive(runtimeReadPrivateJson(lock).pid)) throw runtimeUpdateError("runtime.update_busy");
    const gate = `${lock}.recovery`;
    try { fs.mkdirSync(gate, { mode: 0o700 }); } catch { throw runtimeUpdateError("runtime.update_busy"); }
    try {
      if (alive(runtimeReadPrivateJson(lock).pid)) throw runtimeUpdateError("runtime.update_busy");
      fs.unlinkSync(lock); create();
    } finally { fs.rmdirSync(gate); }
  }
  return () => {
    if (runtimeReadPrivateJson(lock).nonce === owner.nonce) fs.unlinkSync(lock);
  };
}

function runtimeRecoverUpdate(target) {
  const journalPath = `${target}.update.json`;
  if (!fs.existsSync(journalPath)) return;
  const journal = runtimeReadPrivateJson(journalPath);
  if (journal.version !== 1 || !/^[a-f0-9]{64}$/u.test(journal.next?.sha256 || "") ||
      journal.next.fileName !== path.basename(target) || journal.next.format !== "duallane.official-runtime") throw runtimeUpdateError("runtime.recovery_required");
  const identity = runtimeFileIdentity(target);
  const installed = runtimeInstallRecord(target);
  if (installed && installed.sha256 !== journal.previous?.sha256 && installed.sha256 !== journal.next.sha256) throw runtimeUpdateError("runtime.recovery_required");
  if (identity?.sha256 === journal.next.sha256) {
    runtimeAtomicWrite(`${target}.install.json`, JSON.stringify(journal.next) + "\n");
  } else if ((identity?.sha256 || null) === (journal.previous?.sha256 || null)) {
    if (journal.previous) runtimeAtomicWrite(`${target}.install.json`, JSON.stringify(journal.previous) + "\n");
    else if (installed) fs.unlinkSync(`${target}.install.json`);
  } else {
    throw runtimeUpdateError("runtime.recovery_required");
  }
  fs.unlinkSync(journalPath);
}

function runtimeFileIdentity(target) {
  if (!target || !fs.existsSync(target)) return null;
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > RUNTIME_MAX_BYTES) throw runtimeUpdateError("runtime.unsafe_target");
  let parent = path.dirname(path.resolve(target));
  while (true) {
    if (fs.lstatSync(parent).isSymbolicLink()) throw runtimeUpdateError("runtime.unsafe_target");
    const next = path.dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  return { sha256: crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex"), byteSize: stat.size };
}

function runtimeInstallRecord(target) {
  const recordPath = `${target}.install.json`;
  if (!fs.existsSync(recordPath)) return null;
  const stat = fs.lstatSync(recordPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096) throw runtimeUpdateError("runtime.invalid_install_record");
  try {
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    if (record.format !== "duallane.official-runtime" || record.version !== 1 || !/^[a-f0-9]{64}$/u.test(record.sha256)) throw new Error();
    return record;
  } catch { throw runtimeUpdateError("runtime.invalid_install_record"); }
}

export async function inspectOfficialRuntime({ origin, targetPath, fetchImpl = globalThis.fetch, timeoutMs = 6000 } = {}) {
  let base;
  try { base = new URL(origin); } catch { throw runtimeUpdateError("runtime.invalid_origin"); }
  if (!["https:", "http:"].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== "/") throw runtimeUpdateError("runtime.invalid_origin");
  const manifest = await requestGateway({
    fetchImpl, url: new URL("/integrations/duallane-agent.manifest.json", base), timeoutMs,
    init: { method: "GET", headers: { accept: "application/json", "cache-control": "no-cache" } },
  });
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u.test(manifest.version || "") ||
      !/^[a-f0-9]{64}$/u.test(manifest.sha256 || "") || !Number.isSafeInteger(manifest.byteSize) ||
      manifest.byteSize < 1024 || manifest.byteSize > RUNTIME_MAX_BYTES) throw runtimeUpdateError("runtime.invalid_manifest");
  const compatibility = manifest.compatibility;
  if (compatibility && (compatibility.gatewayVersion !== 1 || compatibility.bridgeProtocolVersion !== 1)) throw runtimeUpdateError("runtime.incompatible");
  const current = runtimeFileIdentity(targetPath);
  const record = targetPath ? runtimeInstallRecord(targetPath) : null;
  const contentChanged = current ? current.sha256 !== manifest.sha256 : null;
  const versionOrder = compareRuntimeSemver(manifest.version, DUALLANE_AGENT_SDK_VERSION);
  return {
    currentVersion: DUALLANE_AGENT_SDK_VERSION,
    latestVersion: manifest.version,
    updateAvailable: versionOrder > 0 || (versionOrder === 0 && contentChanged === true),
    contentChanged,
    sameVersionDrift: versionOrder === 0 && contentChanged === true,
    managed: Boolean(current && record && record.sha256 === current.sha256 && record.origin === base.origin && record.fileName === path.basename(targetPath)),
    locallyModified: Boolean(current && record && record.sha256 !== current.sha256),
    sha256: manifest.sha256,
    byteSize: manifest.byteSize,
    buildId: typeof manifest.buildId === "string" && /^[a-f0-9]{64}$/u.test(manifest.buildId) ? manifest.buildId : null,
    compatibility: compatibility || { gatewayVersion: 1, bridgeProtocolVersion: 1 },
    downloadUrl: new URL("/integrations/duallane-agent.mjs", base).href,
    highlights: Array.isArray(manifest.highlights) ? manifest.highlights.filter((v) => typeof v === "string" && v.length < 300).slice(0, 8) : [],
  };
}

export async function installOfficialRuntime({ origin, targetPath, force = false, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const target = path.resolve(targetPath);
  if (path.basename(target) !== "duallane-agent.mjs") throw runtimeUpdateError("runtime.unmanaged_target");
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let ancestor = dir;
  while (true) {
    if (fs.lstatSync(ancestor).isSymbolicLink()) throw runtimeUpdateError("runtime.unsafe_target");
    const next = path.dirname(ancestor); if (next === ancestor) break; ancestor = next;
  }
  const release = runtimeAcquireUpdateLock(target);
  try {
  runtimeRecoverUpdate(target);
  const check = await inspectOfficialRuntime({ origin, targetPath: target, fetchImpl, timeoutMs });
  const original = runtimeFileIdentity(target);
  // An exact published bundle may establish provenance without overwriting it.
  // Unknown old bundles and local extensions require a separate clean install.
  if (original && !check.managed && original.sha256 !== check.sha256) throw runtimeUpdateError("runtime.local_changes_preserved");
  if (check.locallyModified) throw runtimeUpdateError("runtime.local_changes_preserved");
  if (!check.updateAvailable && !force && original?.sha256 === check.sha256 && check.managed) return { ...check, updated: false, targetPath: target };
  if (compareRuntimeSemver(check.latestVersion, DUALLANE_AGENT_SDK_VERSION) < 0) throw runtimeUpdateError("runtime.downgrade_denied");
  const bytes = await requestGateway({
    fetchImpl, url: check.downloadUrl, timeoutMs,
    init: { method: "GET", headers: { "cache-control": "no-cache" } },
    read: (response) => readGatewayBytes(response, RUNTIME_MAX_BYTES),
  });
  if (bytes.byteLength !== check.byteSize || crypto.createHash("sha256").update(bytes).digest("hex") !== check.sha256) throw runtimeUpdateError("runtime.integrity_mismatch");
  const syntax = spawnSync(process.execPath, ["--input-type=module", "--check"], { input: bytes, timeout: 10_000, encoding: "utf8", maxBuffer: 64 * 1024, windowsHide: true });
  if (syntax.status !== 0) throw runtimeUpdateError("runtime.invalid_script");
  const current = runtimeFileIdentity(target);
  if (current?.sha256 !== original?.sha256) throw runtimeUpdateError("runtime.target_changed");
  const previousBytes = original ? fs.readFileSync(target) : null;
  const previous = runtimeInstallRecord(target);
  const journalPath = `${target}.update.json`;
  const record = { format: "duallane.official-runtime", version: 1, origin: new URL(origin).origin, fileName: path.basename(target), sha256: check.sha256, byteSize: bytes.byteLength, sdkVersion: check.latestVersion };
  runtimeAtomicWrite(journalPath, JSON.stringify({ version: 1, previous: previous || (original ? { ...record, ...original } : null), next: record }));
  try {
    runtimeAtomicWrite(target, bytes, 0o755);
    runtimeAtomicWrite(`${target}.install.json`, JSON.stringify(record) + "\n");
    fs.unlinkSync(journalPath);
  } catch {
    try {
      if (runtimeFileIdentity(target)?.sha256 === record.sha256) {
        if (previousBytes) runtimeAtomicWrite(target, previousBytes, 0o755);
        else fs.unlinkSync(target);
      }
      const currentRecord = runtimeInstallRecord(target);
      if (currentRecord?.sha256 === record.sha256 && previous?.sha256 !== record.sha256) {
        if (previous) runtimeAtomicWrite(`${target}.install.json`, JSON.stringify(previous) + "\n");
        else fs.unlinkSync(`${target}.install.json`);
      }
      fs.unlinkSync(journalPath);
    } catch {
      // The journal records both legitimate identities for the next locked run.
    }
    throw runtimeUpdateError("runtime.install_failed");
  }
  return { ...check, managed: true, updated: original?.sha256 !== check.sha256, targetPath: target };
  } finally { release(); }
}
