import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";
import { DualLaneAgentError } from "../../packages/agent-sdk/src/index.js";
import { archiveFiles, createProduction } from "./production.mjs";
import { sha256 } from "./operator/ota-archive.mjs";

const main = "timeStarry/duallane";
const mobile = "timeStarry/duallane-mobile";
const checks = {
  "ci.yml": ["Go test, race, analysis, build, and PostgreSQL", "Test, lint, build, and Chromium E2E",
    "Go Workspace Chromium integration and privacy", "Go P2P Chromium privacy and transfer"],
  "check.yml": ["verify"],
  "android-test.yml": ["package-smoke"],
};
const origin = "https://releases.example.test";

function zip(entries, useDescriptor = false) {
  const contents = [];
  const directory = [];
  let offset = 0;
  for (const [file, html] of entries) {
    const name = Buffer.from(file);
    const bytes = Buffer.from(html);
    const body = useDescriptor ? deflateRawSync(bytes) : bytes;
    const local = Buffer.alloc(30);
    const central = Buffer.alloc(46);
    const descriptor = useDescriptor ? Buffer.alloc(16) : Buffer.alloc(0);
    const flags = useDescriptor ? 0x0808 : 0x0800;
    const method = useDescriptor ? 8 : 0;
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(name.length, 26);
    if (useDescriptor) {
      descriptor.writeUInt32LE(0x08074b50);
      descriptor.writeUInt32LE(crc32(bytes), 4);
      descriptor.writeUInt32LE(body.length, 8);
      descriptor.writeUInt32LE(bytes.length, 12);
    } else {
      local.writeUInt32LE(crc32(bytes), 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(bytes.length, 22);
    }
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(bytes), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    contents.push(local, name, body, descriptor);
    directory.push(central, name);
    offset += local.length + name.length + body.length + descriptor.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(Buffer.concat(directory).length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...contents, ...directory, end]);
}

const assets = [["index.html", "<main>Reviewed candidate</main>"], ["assets/main.js", "console.log('1.1.2')"]];
const candidateArchive = zip(assets);
const publicArchive = zip(assets, true);
const previousArchive = zip([["index.html", "<main>Stable OTA</main>"]], true);

function mobileRelease(version, bytes) {
  const digest = sha256(bytes);
  return { release: {
    enabled: true, version, apkVersion: "1.1.0", versionCode: 10100,
    minimumSupportedNativeVersionCode: 10100, byteSize: 200, sha256: "d".repeat(64),
    downloadUrl: "/api/v1/mobile/android/latest.apk",
    ota: { enabled: true, version, minNativeVersionCode: 10051, sha256: digest, byteSize: bytes.length,
      bundleId: digest.slice(0, 12), downloadUrl: "/api/v1/mobile/android/latest-ota.zip" },
  } };
}

async function fixture(t) {
  const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), "duallane-release-test-"));
  t.after(async () => {
    assert.equal(path.dirname(artifactDirectory), os.tmpdir());
    await rm(artifactDirectory, { recursive: true });
  });
  const config = { mode: "production", artifactDirectory, production: { origin, otaAuthority: "exclusive" } };
  const changes = [
    { repo: "main", number: 32, base: "1".repeat(40), head: "2".repeat(40), tree: "3".repeat(40) },
    { repo: "mobile", number: 19, base: "4".repeat(40), head: "5".repeat(40), tree: "6".repeat(40) },
  ];
  const candidate = { summary: "Unread count and saved stickers", native: false, changes, goWeb: { version: "1.2.4" },
    ota: { version: "1.1.2", minNativeVersionCode: 10051, sha256: sha256(candidateArchive), files: archiveFiles(candidateArchive) },
    evidence: [] };
  const artifact = path.join(artifactDirectory, `${candidate.ota.sha256}.zip`);
  await writeFile(artifact, candidateArchive);
  const states = new Map();
  for (const change of changes) {
    const repo = change.repo === "main" ? main : mobile;
    const commit = (change.repo === "main" ? "7" : "8").repeat(40);
    states.set(repo, {
      commit, change, main: commit, version: "1.2.4",
      pr: { number: change.number, state: "closed", merged: true, merged_by: { login: "timeStarry" },
        base: { ref: "main", sha: change.base, repo: { full_name: repo } },
        head: { ref: "codex/dl-fixture", sha: change.head, repo: { full_name: repo } }, merge_commit_sha: commit },
      ciStatus: "completed", ciConclusion: "success", wrongJob: false,
    });
  }
  const runs = new Map();
  const requests = [];
  const effects = [];
  const phases = [];
  const live = { go: { status: "completed", healthy: true, commit: "9".repeat(40), version: "1.2.3",
    snapshotSha256: "a".repeat(64) }, release: mobileRelease("1.1.1", previousArchive), bytes: previousArchive };
  const seams = {
    config,
    async github(endpoint) {
      requests.push(endpoint);
      const match = /^repos\/(timeStarry\/[^/]+)\/(.*)$/.exec(endpoint);
      assert.ok(match && states.has(match[1]));
      const [, repo, resource] = match;
      const data = states.get(repo);
      if (resource === `pulls/${data.change.number}`) return data.pr;
      if (resource === "git/ref/heads/main") return { ref: "refs/heads/main", object: { type: "commit", sha: data.main } };
      if (resource === `git/commits/${data.commit}`) return { sha: data.commit, parents: [{ sha: data.change.base }],
        tree: { sha: data.change.tree } };
      if (resource.startsWith("contents/")) return { encoding: "base64",
        content: Buffer.from(JSON.stringify({ version: data.version })).toString("base64") };
      const workflow = /^actions\/workflows\/([^/]+)\/runs\?branch=main&head_sha=([a-f\d]{40})&event=push&per_page=100$/.exec(resource);
      if (workflow) {
        assert.equal(workflow[2], data.commit);
        const id = runs.size + 1;
        runs.set(id, { repo, workflow: workflow[1], sha: workflow[2] });
        return { total_count: 1, workflow_runs: [{ id, head_sha: data.commit, head_branch: "main", event: "push",
          path: `.github/workflows/${workflow[1]}`, status: data.ciStatus, conclusion: data.ciConclusion, repository: { full_name: repo } }] };
      }
      const jobs = /^actions\/runs\/(\d+)\/jobs\?filter=latest&per_page=100$/.exec(resource);
      assert.ok(jobs, resource);
      const id = Number(jobs[1]);
      const { workflow: file, sha } = runs.get(id);
      return { total_count: checks[file].length, jobs: checks[file].map(name => ({ name,
        head_sha: data.wrongJob ? "b".repeat(40) : sha, head_branch: "main", run_id: id, status: "completed", conclusion: "success" })) };
    },
    async fetch(url, init) {
      assert.equal(url.origin, origin);
      assert.equal(init.redirect, "error");
      if (url.pathname === "/api/health") return Response.json({ ok: true, appVersion: live.go.version });
      if (url.pathname === "/api/v1/mobile/releases/latest") return Response.json(live.release);
      assert.equal(url.pathname, "/api/v1/mobile/android/latest-ota.zip");
      return new Response(live.bytes);
    },
    async runGo(request) {
      if (request.operation === "inspect") return { ...live.go };
      effects.push("go-web");
      assert.equal(request.baseline.snapshotSha256, live.go.snapshotSha256);
      assert.equal(request.target.commit, states.get(main).commit);
      live.go = { status: "completed", healthy: true, ...request.target, snapshotSha256: "b".repeat(64) };
      return live.go;
    },
    async publishOTA(request) {
      effects.push("ota");
      assert.equal(live.go.version, "1.2.4");
      assert.deepEqual(request.zipBytes, candidateArchive);
      assert.equal(request.minNativeVersionCode, candidate.ota.minNativeVersionCode);
      live.bytes = publicArchive;
      live.release = mobileRelease(request.version, publicArchive);
      return live.release;
    },
  };
  return { seams, controller: createProduction(seams), candidate, states, live, requests, effects, phases, artifact,
    options: baseline => ({ baseline, onPhase: event => phases.push(event) }) };
}

test("archive digest projection agrees across store and Go-style normalized deflate", () => {
  assert.notEqual(sha256(candidateArchive), sha256(publicArchive));
  assert.deepEqual(archiveFiles(candidateArchive), archiveFiles(publicArchive));
  for (const bad of [["../escape.txt", "bad"], ["assets/www/alias.js", "bad"], ["0.apk", "bad"], ["index.html", "second"]]) {
    assert.throws(() => archiveFiles(zip([...assets, bad])), /invalid_ota_archive/);
  }
  const corruption = Buffer.from(candidateArchive);
  corruption[40] ^= 1;
  assert.throws(() => archiveFiles(corruption), /invalid_ota_archive/);
});

test("release gate distinguishes unmerged and running CI from changed approval or failed CI", async t => {
  const { controller, candidate, states, effects } = await fixture(t);
  const state = states.get(main);
  state.pr.merged = false;
  state.pr.state = "open";
  assert.equal((await controller.inspect(candidate)).reason, "merge_pending");
  state.pr.merged = true;
  state.ciStatus = "in_progress";
  assert.equal((await controller.inspect(candidate)).reason, "ci_pending");
  state.ciStatus = "completed";
  state.ciConclusion = "failure";
  assert.equal((await controller.inspect(candidate)).reason, "ci_failed");
  state.ciConclusion = "success";
  states.get(mobile).wrongJob = true;
  assert.equal((await controller.inspect(candidate)).reason, "ci_unverified");
  states.get(mobile).wrongJob = false;
  state.pr.merged_by.login = "different-maintainer";
  assert.equal((await controller.inspect(candidate)).reason, "merge_actor_invalid");
  state.pr.merged_by.login = "timeStarry";
  state.main = "a".repeat(40);
  assert.equal((await controller.inspect(candidate)).reason, "main_drift");
  state.main = state.commit;
  state.version = "1.2.5";
  assert.equal((await controller.inspect(candidate)).reason, "go_version_drift");
  assert.deepEqual(effects, []);
});

test("pilot mode and approval, artifact or production drift cannot call a writer", async t => {
  const { seams, controller, candidate, effects, live, artifact, options } = await fixture(t);
  const baseline = await controller.captureBaseline(candidate);
  seams.config.mode = "pilot";
  assert.equal((await controller.release(candidate, options(baseline))).reason, "pilot_only");
  seams.config.mode = "production";
  assert.equal((await controller.release(candidate)).reason, "approval_baseline_required");
  const authority = seams.config.production.otaAuthority;
  delete seams.config.production.otaAuthority;
  assert.equal((await controller.release(candidate, options(baseline))).reason, "ota_authority_unverified");
  seams.config.production.otaAuthority = authority;
  await writeFile(artifact, previousArchive);
  assert.equal((await controller.release(candidate, options(baseline))).reason, "artifact_drift");
  await writeFile(artifact, candidateArchive);
  live.go.snapshotSha256 = "e".repeat(64);
  assert.equal((await controller.release(candidate, options(baseline))).reason, "production_baseline_drift");
  assert.deepEqual(effects, []);
});

test("OTA policy can be read before building and a docs-only merge does not access production", async t => {
  const { seams, candidate, controller, effects, options } = await fixture(t);
  assert.equal((await controller.captureBaseline({ ota: true })).ota.version, "1.1.1");
  const docs = { ...candidate, changes: [candidate.changes[0]], goWeb: null, ota: null };
  const noNetwork = createProduction({ ...seams, config: { mode: "production" },
    fetch() { assert.fail("docs-only merge reached production"); } });
  const baseline = await noNetwork.captureBaseline(docs);
  assert.deepEqual(baseline, { goWeb: null, ota: null });
  assert.deepEqual(await noNetwork.release(docs, options(baseline)), { status: "succeeded", reason: "verified", completed: [] });
  assert.deepEqual(effects, []);
});

test("dual release verifies exact merge and executes Go before a verified OTA with rollback bytes", async t => {
  const { seams, controller, candidate, effects, phases, options } = await fixture(t);
  assert.equal((await controller.inspect(candidate)).ready, true);
  const baseline = await controller.captureBaseline(candidate);
  const released = await controller.release(candidate, options(baseline));
  assert.deepEqual(released, { status: "succeeded", reason: "verified", completed: ["go-web", "ota"] });
  assert.deepEqual(effects, ["go-web", "ota"]);
  assert.deepEqual(phases.map(({ phase, state }) => [phase, state]), [
    ["go-web", "started"], ["go-web", "succeeded"], ["ota", "started"], ["ota", "succeeded"],
  ]);
  assert.equal(phases.at(-1).receipt.sha256, sha256(publicArchive));
  assert.deepEqual(await readFile(path.join(seams.config.artifactDirectory, `previous-${sha256(previousArchive)}.zip`)), previousArchive);
});

test("an OTA rejection after Go is partial, a lost write with no proof is uncertain", async t => {
  for (const rejected of [true, false]) {
    await t.test(rejected ? "known rejection" : "unknown write", async it => {
      const { seams, candidate, effects, phases, options } = await fixture(it);
      seams.publishOTA = () => {
        effects.push("ota");
        if (rejected) throw new DualLaneAgentError("auth.forbidden", "synthetic rejection", { statusCode: 403 });
        throw new Error("synthetic connection loss");
      };
      const controller = createProduction(seams);
      const release = await controller.release(candidate, options(await controller.captureBaseline(candidate)));
      assert.equal(release.status, rejected ? "partial" : "uncertain");
      assert.equal(phases.at(-1).state, rejected ? "failed" : "uncertain");
      assert.deepEqual(release.completed, ["go-web"]);
      assert.deepEqual(effects, ["go-web", "ota"]);
    });
  }
});

test("lost OTA response reconciles against exact normalized contents without a second upload", async t => {
  const { seams, candidate, effects, options } = await fixture(t);
  const deliver = seams.publishOTA;
  seams.publishOTA = async request => {
    await deliver(request);
    throw new Error("synthetic connection loss after write");
  };
  const controller = createProduction(seams);
  const result = await controller.release(candidate, options(await controller.captureBaseline(candidate)));
  assert.equal(result.status, "succeeded");
  assert.deepEqual(effects, ["go-web", "ota"]);
});

test("native release and unrelated operator request have no automated write path", async t => {
  const { controller, candidate } = await fixture(t);
  assert.equal((await controller.inspect({ ...candidate, native: true })).reason, "native_manual");
  const script = fileURLToPath(new URL("./operator/go-web.mjs", import.meta.url));
  const stdout = execFileSync(process.execPath, [script], { input: '{"operation":"shell","command":"echo escape"}',
    encoding: "utf8", windowsHide: true });
  assert.deepEqual(JSON.parse(stdout), { status: "blocked" });
});
