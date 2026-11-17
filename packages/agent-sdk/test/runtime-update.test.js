import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectOfficialRuntime, installOfficialRuntime } from "../src/runtime-update.js";
import { DUALLANE_AGENT_SDK_VERSION } from "../src/index.js";

function officialBundle(suffix = "") {
  const bytes = Buffer.from(`export const version = '${DUALLANE_AGENT_SDK_VERSION}';\n//${"x".repeat(1100)}${suffix}\n`);
  return { bytes, manifest: { version: DUALLANE_AGENT_SDK_VERSION, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), byteSize: bytes.length, compatibility: { gatewayVersion: 1, bridgeProtocolVersion: 1 } } };
}
function updaterFixture(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dl-update-contract-"));
  const targetPath = path.join(dir, "duallane-agent.mjs");
  const params = { origin: "https://gateway.example", targetPath };
  return Promise.resolve().then(() => run({ dir, targetPath, params })).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}
const serveBundle = (bundle) => async (url, init) => {
  assert.equal(init.redirect, "error");
  assert.equal(init.headers.authorization, undefined);
  return String(url).includes("manifest.json")
    ? new Response(JSON.stringify(bundle.manifest), { headers: { "content-type": "application/json" } })
    : new Response(bundle.bytes);
};

test("same version digest drift is detectable and an owned official runtime can update", () => updaterFixture(async ({ params, targetPath }) => {
  const first = officialBundle();
  await installOfficialRuntime({ ...params, fetchImpl: serveBundle(first) });
  assert.equal(JSON.parse(fs.readFileSync(`${targetPath}.install.json`)).sha256, first.manifest.sha256);
  const second = officialBundle("next build");
  const check = await inspectOfficialRuntime({ ...params, fetchImpl: serveBundle(second) });
  assert.equal(check.sameVersionDrift, true);
  assert.equal(check.updateAvailable, true);
  assert.equal(check.managed, true);
  const updated = await installOfficialRuntime({ ...params, fetchImpl: serveBundle(second) });
  assert.equal(updated.updated, true);
  assert.deepEqual(fs.readFileSync(targetPath), second.bytes);
}));

test("unknown or locally modified runtime is preserved even with force", () => updaterFixture(async ({ params, targetPath, dir }) => {
  const bundle = officialBundle();
  fs.writeFileSync(targetPath, "local confidentiality policy");
  const bridge = path.join(dir, "bridge.mjs");
  fs.writeFileSync(bridge, "independent bridge");
  await assert.rejects(installOfficialRuntime({ ...params, force: true, fetchImpl: serveBundle(bundle) }), (e) => e.code === "runtime.local_changes_preserved");
  assert.equal(fs.readFileSync(targetPath, "utf8"), "local confidentiality policy");
  fs.unlinkSync(targetPath);
  await installOfficialRuntime({ ...params, fetchImpl: serveBundle(bundle) });
  fs.appendFileSync(targetPath, "\n// local change");
  await assert.rejects(installOfficialRuntime({ ...params, force: true, fetchImpl: serveBundle(bundle) }), (e) => e.code === "runtime.local_changes_preserved");
  assert.equal(fs.readFileSync(bridge, "utf8"), "independent bridge");
}));

test("manifest integrity, protocol and target identity are mandatory", () => updaterFixture(async ({ params, targetPath }) => {
  for (const mutate of [b => delete b.manifest.sha256, b => { b.manifest.byteSize += 1; }, b => { b.manifest.compatibility.bridgeProtocolVersion = 99; }, b => { b.bytes = Buffer.from("different bytes"); }]) {
    const bundle = officialBundle(); mutate(bundle);
    await assert.rejects(installOfficialRuntime({ ...params, fetchImpl: serveBundle(bundle) }));
    assert.equal(fs.existsSync(targetPath), false);
  }
  await assert.rejects(installOfficialRuntime({ ...params, targetPath: targetPath.replace("duallane-agent", "comet-runtime"), fetchImpl: serveBundle(officialBundle()) }), (e) => e.code === "runtime.unmanaged_target");
}));

test("an install-record failure restores the old matching runtime and receipt", () => updaterFixture(async ({ params, targetPath }) => {
  const old = officialBundle();
  await installOfficialRuntime({ ...params, fetchImpl: serveBundle(old) });
  const rename = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (String(destination).endsWith(".install.json")) throw Object.assign(new Error("synthetic permission denial"), { code: "EACCES" });
    return rename(source, destination);
  };
  try {
    await assert.rejects(installOfficialRuntime({ ...params, fetchImpl: serveBundle(officialBundle("next")) }), (e) => e.code === "runtime.install_failed");
  } finally { fs.renameSync = rename; }
  assert.deepEqual(fs.readFileSync(targetPath), old.bytes);
  assert.equal(JSON.parse(fs.readFileSync(`${targetPath}.install.json`)).sha256, old.manifest.sha256);
  assert.equal((await inspectOfficialRuntime({ ...params, fetchImpl: serveBundle(old) })).managed, true);
}));

test("a journal recovers a crash between runtime and install-record replacement", () => updaterFixture(async ({ params, targetPath }) => {
  const old = officialBundle();
  await installOfficialRuntime({ ...params, fetchImpl: serveBundle(old) });
  const previous = JSON.parse(fs.readFileSync(`${targetPath}.install.json`));
  const nextBundle = officialBundle("new build");
  const next = { ...previous, sha256: nextBundle.manifest.sha256, byteSize: nextBundle.bytes.length };
  fs.writeFileSync(`${targetPath}.update.json`, JSON.stringify({ version: 1, previous, next }), { mode: 0o600 });
  fs.writeFileSync(targetPath, nextBundle.bytes);
  const result = await installOfficialRuntime({ ...params, fetchImpl: serveBundle(nextBundle) });
  assert.equal(result.managed, true);
  assert.equal(fs.existsSync(`${targetPath}.update.json`), false);
  assert.equal(JSON.parse(fs.readFileSync(`${targetPath}.install.json`)).sha256, next.sha256);
}));

test("concurrent installers cannot replace the same runtime", () => updaterFixture(async ({ params }) => {
  const bundle = officialBundle();
  let resume;
  const gate = new Promise((resolve) => { resume = resolve; });
  const first = installOfficialRuntime({ ...params, fetchImpl: async (...args) => { await gate; return serveBundle(bundle)(...args); } });
  await assert.rejects(installOfficialRuntime({ ...params, fetchImpl: serveBundle(bundle) }), (e) => e.code === "runtime.update_busy");
  resume(); await first;
}));
