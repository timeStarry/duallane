import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, open, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { DualLaneAgentClient, DualLaneAgentError } from "../../packages/agent-sdk/src/index.js";
import { loadAgentProfile } from "../../packages/agent-sdk/src/profile-store.js";
import { archiveFiles, MAX_OTA_BYTES, sha256 } from "./operator/ota-archive.mjs";

export { archiveFiles };

const COMMIT = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const REPOSITORIES = { main: "timeStarry/duallane", mobile: "timeStarry/duallane-mobile" };
const CHECKS = {
  main: { "ci.yml": ["Go test, race, analysis, build, and PostgreSQL", "Test, lint, build, and Chromium E2E",
    "Go Workspace Chromium integration and privacy", "Go P2P Chromium privacy and transfer"] },
  mobile: { "check.yml": ["verify"], "android-test.yml": ["package-smoke"] },
};
const MOBILE_LATEST = "/api/v1/mobile/releases/latest";
const OTA_DOWNLOAD = "/api/v1/mobile/android/latest-ota.zip";
const APK_DOWNLOAD = "/api/v1/mobile/android/latest.apk";

class ReleaseGateError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function gate(condition, reason) {
  if (!condition) throw new ReleaseGateError(reason);
}

function reasonFor(error, fallback) {
  return error instanceof ReleaseGateError ? error.code : fallback;
}

function validCode(value) {
  return Number.isInteger(value) && value >= 0 && value <= 2_100_000_000;
}

function newerVersion(target, baseline) {
  const oldParts = baseline.split(".").map(Number);
  const newParts = target.split(".").map(Number);
  const changed = newParts.findIndex((part, index) => part !== oldParts[index]);
  return changed !== -1 && newParts[changed] > oldParts[changed];
}

function validateCandidate(candidate, { allowNative = false } = {}) {
  gate(candidate && Array.isArray(candidate.changes) && candidate.changes.length >= 1 && candidate.changes.length <= 2,
    "candidate_invalid");
  gate(typeof candidate.native === "boolean", "candidate_invalid");
  gate(allowNative || !candidate.native, "native_manual");
  const seen = new Set();
  for (const change of candidate.changes) {
    gate(change && Object.hasOwn(REPOSITORIES, change.repo) && !seen.has(change.repo) &&
      [change.base, change.head, change.tree].every(value => typeof value === "string" && COMMIT.test(value)) &&
      (change.number === null || Number.isSafeInteger(change.number) && change.number > 0), "candidate_invalid");
    seen.add(change.repo);
  }
  if (candidate.goWeb) gate(seen.has("main") && VERSION.test(candidate.goWeb.version), "candidate_invalid");
  if (candidate.ota) {
    gate(seen.has("mobile") && VERSION.test(candidate.ota.version) && validCode(candidate.ota.minNativeVersionCode) &&
      candidate.ota.minNativeVersionCode > 0 && SHA256.test(candidate.ota.sha256) &&
      Array.isArray(candidate.ota.files) && candidate.ota.files.length > 0 && candidate.ota.files.length <= 500 &&
      candidate.ota.files.every(entry => typeof entry?.path === "string" && SHA256.test(entry.sha256)), "candidate_invalid");
  }
}

async function readArchive(fileName) {
  const file = await open(fileName, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const st = await file.stat();
    gate(st.isFile() && st.size >= 64 && st.size <= MAX_OTA_BYTES, "artifact_invalid");
    const output = Buffer.alloc(st.size + 1);
    const { bytesRead } = await file.read(output, { length: output.length });
    gate(bytesRead === st.size, "artifact_invalid");
    return output.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

function matchesContents(bytes, expected) {
  const entries = [...expected].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return isDeepStrictEqual(archiveFiles(bytes), entries);
}

function localOperatorEnvironment(allowlist = []) {
  const names = new Set(["path", "systemroot", "windir", "home", "userprofile", "tmp", "temp", "tmpdir"]);
  for (const name of allowlist) {
    gate(typeof name === "string" && /^[A-Z_][A-Z0-9_]*$/.test(name), "go_operator_unavailable");
    names.add(name.toLowerCase());
  }
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => names.has(name.toLowerCase())));
}

function execute(file, args, options, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { windowsHide: true, ...options }, (error, stdout) => {
      if (error) reject(new ReleaseGateError("operator_command_failed"));
      else {
        try { resolve(JSON.parse(stdout)); }
        catch { reject(new ReleaseGateError("operator_receipt_invalid")); }
      }
    });
    child.stdin.on("error", () => { /* The exit status owns command failure. */ });
    child.stdin.end(input);
  });
}

function githubRead(endpoint) {
  return execute("gh", ["api", "--hostname", "github.com", "--method", "GET", endpoint],
    { timeout: 25_000, maxBuffer: 4 * 1024 * 1024 });
}

function goCommand(production, request) {
  const command = production.goCommand;
  gate(command && typeof command.file === "string" && path.isAbsolute(command.file) &&
    Array.isArray(command.args) && command.args.every(arg => typeof arg === "string"), "go_operator_unavailable");
  const timeout = production.goTimeoutMs ?? 45 * 60_000;
  gate(Number.isInteger(timeout) && timeout > 0 && timeout <= 90 * 60_000 &&
    (command.envAllowlist === undefined || Array.isArray(command.envAllowlist)), "go_operator_unavailable");
  return execute(command.file, command.args, { env: localOperatorEnvironment(command.envAllowlist),
    timeout: request.operation === "inspect" ? 30_000 : timeout, maxBuffer: 64 * 1024 },
  JSON.stringify({ ...request, previousSnapshot: production.goPreviousSnapshot }) + "\n");
}

function releaseOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new ReleaseGateError("production_origin_invalid"); }
  gate(url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" &&
    !url.search && !url.hash, "production_origin_invalid");
  return url.origin;
}

async function download(fetch, origin, resource, limit) {
  const response = await fetch(new URL(resource, origin), { redirect: "error", cache: "no-store",
    signal: AbortSignal.timeout(20_000) });
  gate(response.ok && response.body, "public_release_unavailable");
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      gate(size <= limit, "public_release_invalid");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function readPublicJSON(fetch, origin, resource) {
  try { return JSON.parse(await download(fetch, origin, resource, 128 * 1024)); }
  catch (error) { throw new ReleaseGateError(reasonFor(error, "public_release_unavailable")); }
}

function normalizeGoIdentity(info) {
  gate(info?.status === "completed" && info.healthy === true &&
    COMMIT.test(info.commit) && VERSION.test(info.version) && SHA256.test(info.snapshotSha256), "go_receipt_invalid");
  return { commit: info.commit, version: info.version, snapshotSha256: info.snapshotSha256 };
}

function mobileIdentity(value) {
  const release = value?.release;
  gate(release?.enabled === true && VERSION.test(release.version) && VERSION.test(release.apkVersion) &&
    validCode(release.versionCode) && release.versionCode > 0 &&
    (release.minimumSupportedNativeVersionCode === undefined || validCode(release.minimumSupportedNativeVersionCode)) &&
    SHA256.test(release.sha256) && Number.isSafeInteger(release.byteSize) && release.byteSize > 0 &&
    release.downloadUrl === APK_DOWNLOAD && release.ota?.enabled === true && release.ota.version === release.version &&
    SHA256.test(release.ota.sha256) && release.ota.bundleId === release.ota.sha256.slice(0, 12) &&
    validCode(release.ota.minNativeVersionCode) && release.ota.minNativeVersionCode > 0 &&
    Number.isSafeInteger(release.ota.byteSize) && release.ota.byteSize > 0 && release.ota.byteSize <= MAX_OTA_BYTES &&
    release.ota.downloadUrl === OTA_DOWNLOAD, "mobile_baseline_invalid");
  return { version: release.ota.version, sha256: release.ota.sha256, byteSize: release.ota.byteSize,
    minNativeVersionCode: release.ota.minNativeVersionCode, apkVersion: release.apkVersion, versionCode: release.versionCode,
    minimumSupportedNativeVersionCode: release.minimumSupportedNativeVersionCode ?? 0,
    apkSha256: release.sha256, apkByteSize: release.byteSize };
}

function sameNativeRelease(left, right) {
  return ["apkVersion", "versionCode", "minimumSupportedNativeVersionCode", "apkSha256", "apkByteSize"]
    .every(field => left[field] === right[field]);
}

function sameRepo(value, expected) {
  return typeof value === "string" && value.toLowerCase() === expected.toLowerCase();
}

async function checkWorkflow(github, repo, workflow, names, commit) {
  const query = `branch=main&head_sha=${commit}&event=push&per_page=100`;
  const result = await github(`repos/${repo}/actions/workflows/${workflow}/runs?${query}`);
  gate(Array.isArray(result.workflow_runs) && result.total_count === result.workflow_runs.length, "ci_unverified");
  const records = result.workflow_runs.filter(run => run.head_sha === commit && run.head_branch === "main" &&
    run.event === "push" && run.path === `.github/workflows/${workflow}` && sameRepo(run.repository?.full_name, repo));
  gate(records.length === result.workflow_runs.length, "ci_unverified");
  const run = records.sort((a, b) => b.run_number - a.run_number || b.id - a.id)[0];
  gate(run && run.status === "completed", "ci_pending");
  gate(run.conclusion === "success", "ci_failed");
  gate(Number.isSafeInteger(run.id) && run.id > 0, "ci_unverified");
  const checks = await github(`repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
  gate(Array.isArray(checks.jobs) && checks.total_count === checks.jobs.length, "ci_unverified");
  for (const name of names) {
    const matching = checks.jobs.filter(job => job.name === name);
    gate(matching.length === 1 && matching[0].head_sha === commit && matching[0].head_branch === "main" &&
      matching[0].run_id === run.id && matching[0].status === "completed" && matching[0].conclusion === "success", "ci_unverified");
  }
}

async function packageVersion(github, repo, resource, commit) {
  const result = await github(`repos/${repo}/contents/${resource}?ref=${commit}`);
  gate(result.encoding === "base64" && typeof result.content === "string" && result.content.length < 128 * 1024,
    "go_version_unverified");
  let parsed;
  try { parsed = JSON.parse(Buffer.from(result.content, "base64").toString("utf8")); }
  catch { throw new ReleaseGateError("go_version_unverified"); }
  return parsed.version;
}

export function createProduction({ config, github = githubRead, fetch = globalThis.fetch,
  runGo = request => goCommand(config.production, request), publishOTA } = {}) {
  const production = config.production ?? {};

  function repository(kind) {
    const name = config.repositories?.[kind]?.fullName ?? REPOSITORIES[kind];
    gate(sameRepo(name, REPOSITORIES[kind]), "repository_not_allowed");
    return REPOSITORIES[kind];
  }

  async function currentTip(repo) {
    const branch = await github(`repos/${repo}/git/ref/heads/main`);
    gate(branch.ref === "refs/heads/main" && branch.object?.type === "commit" && COMMIT.test(branch.object.sha), "main_unverified");
    return branch.object.sha;
  }

  async function checkChange(change) {
    gate(change.number !== null, "draft_only");
    const repo = repository(change.repo);
    const pr = await github(`repos/${repo}/pulls/${change.number}`);
    gate(pr.number === change.number && pr.base?.ref === "main" && sameRepo(pr.base.repo?.full_name, repo) &&
      sameRepo(pr.head?.repo?.full_name, repo) && /^codex\//.test(pr.head?.ref ?? "") &&
      pr.base.sha === change.base && pr.head.sha === change.head, "pr_drift");
    if (!pr.merged) throw new ReleaseGateError(pr.state === "open" ? "merge_pending" : "pr_closed");
    gate(sameRepo(pr.merged_by?.login, "timestarry") && COMMIT.test(pr.merge_commit_sha), "merge_actor_invalid");
    const commit = await currentTip(repo);
    gate(commit === pr.merge_commit_sha, "main_drift");
    const merged = await github(`repos/${repo}/git/commits/${commit}`);
    gate(merged.sha === commit && merged.parents?.[0]?.sha === change.base && merged.tree?.sha === change.tree,
      "merge_tree_drift");
    for (const [workflow, names] of Object.entries(CHECKS[change.repo])) await checkWorkflow(github, repo, workflow, names, commit);
    return { repo, commit, tree: change.tree, number: change.number };
  }

  async function assess(candidate) {
    validateCandidate(candidate);
    const targets = {};
    for (const change of candidate.changes) targets[change.repo] = await checkChange(change);
    if (candidate.goWeb) {
      const { repo, commit } = targets.main;
      const versions = await Promise.all(["package.json", "apps/web/package.json"]
        .map(resource => packageVersion(github, repo, resource, commit)));
      gate(versions.every(version => version === candidate.goWeb.version), "go_version_drift");
    }
    let archive;
    if (candidate.ota) {
      try {
        archive = await readArchive(path.join(config.artifactDirectory, `${candidate.ota.sha256}.zip`));
        gate(sha256(archive) === candidate.ota.sha256 && matchesContents(archive, candidate.ota.files), "artifact_drift");
      } catch (error) { throw new ReleaseGateError(reasonFor(error, "artifact_invalid")); }
    }
    return { targets, archive };
  }

  async function inspect(candidate) {
    try {
      const { targets } = await assess(candidate);
      return { ready: true, reason: "ready", targets };
    } catch (error) {
      return { ready: false, reason: reasonFor(error, "release_check_unavailable"), targets: {} };
    }
  }

  async function readGoVersion(origin) {
    const health = await readPublicJSON(fetch, origin, "/api/health");
    gate(health.ok === true && VERSION.test(health.appVersion), "go_health_unverified");
    return health.appVersion;
  }

  async function captureBaseline(candidate) {
    const otaProbe = candidate?.ota === true && Object.keys(candidate).length === 1;
    if (!otaProbe) validateCandidate(candidate, { allowNative: true });
    if (!otaProbe && candidate.ota && config.mode === "production") {
      gate(production.otaAuthority === "exclusive", "ota_authority_unverified");
    }
    if (!otaProbe && (candidate.native || (!candidate.goWeb && !candidate.ota))) return { goWeb: null, ota: null };
    const origin = releaseOrigin(production.origin ?? config.channel?.origin);
    let goWeb = null;
    let ota = null;
    if (candidate.goWeb) {
      goWeb = normalizeGoIdentity(await runGo({ operation: "inspect" }));
      gate(await readGoVersion(origin) === goWeb.version && newerVersion(candidate.goWeb.version, goWeb.version), "go_baseline_invalid");
    }
    if (candidate.ota) {
      ota = mobileIdentity(await readPublicJSON(fetch, origin, MOBILE_LATEST));
      gate(otaProbe || (newerVersion(candidate.ota.version, ota.version) && candidate.ota.minNativeVersionCode <= ota.versionCode &&
        candidate.ota.minNativeVersionCode <= Math.max(ota.minimumSupportedNativeVersionCode, ota.minNativeVersionCode)),
      "mobile_baseline_invalid");
    }
    return { goWeb, ota };
  }

  function sendOTA(origin) {
    if (publishOTA) return publishOTA;
    const name = production.otaProfile;
    gate(typeof name === "string" && !["default", config.channel?.profile].includes(name),
      "ota_operator_unavailable");
    const profile = loadAgentProfile(name);
    gate(profile?.source === "profile" && releaseOrigin(profile.url) === origin, "ota_operator_unavailable");
    const client = new DualLaneAgentClient({ url: origin, token: profile.token, requestTimeoutMs: 120_000,
      fetch: (url, init) => fetch(url, { ...init, redirect: "error" }) });
    return options => client.publishMobileOTA(options);
  }

  async function fetchOTA(origin, description) {
    const bytes = await download(fetch, origin, OTA_DOWNLOAD, MAX_OTA_BYTES);
    gate(bytes.length === description.byteSize && sha256(bytes) === description.sha256, "ota_public_digest_mismatch");
    return bytes;
  }

  async function backupOTA(origin, prior) {
    const bytes = await fetchOTA(origin, prior);
    const backup = path.join(config.artifactDirectory, `previous-${prior.sha256}.zip`);
    const temporary = path.join(config.artifactDirectory, `.previous-${randomUUID()}.tmp`);
    await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
    try { await link(temporary, backup); }
    catch (error) {
      gate(error.code === "EEXIST" && sha256(await readArchive(backup)) === prior.sha256, "ota_backup_unverified");
    } finally {
      await unlink(temporary);
    }
  }

  async function verifyPublishedOTA(origin, candidate, before, receipt) {
    const description = mobileIdentity(await readPublicJSON(fetch, origin, MOBILE_LATEST));
    gate(description.version === candidate.version && description.minNativeVersionCode === candidate.minNativeVersionCode &&
      sameNativeRelease(description, before), "ota_postcondition_unverified");
    if (receipt) gate(isDeepStrictEqual(mobileIdentity(receipt), description), "ota_receipt_invalid");
    const bytes = await fetchOTA(origin, description);
    gate(matchesContents(bytes, candidate.files), "ota_public_contents_mismatch");
    return { version: description.version, sha256: description.sha256, byteSize: description.byteSize };
  }

  async function release(candidate, { baseline, onPhase, signal } = {}) {
    const completed = [];
    let activePhase = null;
    let attempted = false;
    try {
      gate(config.mode === "production", "pilot_only");
      gate(baseline && typeof onPhase === "function", "approval_baseline_required");
      if (candidate?.ota) gate(production.otaAuthority === "exclusive", "ota_authority_unverified");
      const { targets, archive } = await assess(candidate);
      const current = await captureBaseline(candidate);
      gate(isDeepStrictEqual(current, baseline), "production_baseline_drift");
      const origin = candidate.goWeb || candidate.ota ? releaseOrigin(production.origin) : null;

      // Preserve the rollback bytes before either of the production writes.
      const publish = candidate.ota ? sendOTA(origin) : null;
      if (candidate.ota) await backupOTA(origin, current.ota);
      gate(!signal?.aborted, "release_cancelled");
      if (candidate.goWeb) {
        activePhase = "go-web";
        await onPhase({ phase: activePhase, state: "started" });
        gate(!signal?.aborted, "release_cancelled");
        attempted = true;
        const reply = await runGo({ operation: "deploy", target: { commit: targets.main.commit, version: candidate.goWeb.version },
          baseline: current.goWeb });
        if (reply?.status === "blocked") {
          attempted = false;
          throw new ReleaseGateError("go_preflight_blocked");
        }
        const identity = normalizeGoIdentity(reply);
        gate(identity.commit === targets.main.commit && identity.version === candidate.goWeb.version &&
          identity.snapshotSha256 !== current.goWeb.snapshotSha256 && await readGoVersion(origin) === identity.version,
        "go_postcondition_unverified");
        completed.push(activePhase);
        await onPhase({ phase: activePhase, state: "succeeded", receipt: identity });
        attempted = false;
      }

      if (candidate.ota) {
        activePhase = "ota";
        gate(!signal?.aborted, "release_cancelled");
        for (const { repo, commit } of Object.values(targets)) gate(await currentTip(repo) === commit, "main_drift");
        const beforeOTA = mobileIdentity(await readPublicJSON(fetch, origin, MOBILE_LATEST));
        gate(isDeepStrictEqual(beforeOTA, current.ota), "production_baseline_drift");
        await onPhase({ phase: activePhase, state: "started" });
        gate(!signal?.aborted, "release_cancelled");
        attempted = true;
        let response;
        let knownRejected = false;
        try {
          response = await publish({ zipBytes: archive, version: candidate.ota.version,
            minNativeVersionCode: candidate.ota.minNativeVersionCode });
        } catch (error) {
          // A lost HTTP receipt can be reconciled with the published bytes. An
          // unchanged manifest alone cannot prove a timed-out write never ran.
          knownRejected = error instanceof DualLaneAgentError && [400, 401, 403, 413, 426].includes(error.statusCode);
        }
        let receipt;
        try { receipt = await verifyPublishedOTA(origin, candidate.ota, beforeOTA, response); }
        catch (error) {
          if (knownRejected) {
            const observed = mobileIdentity(await readPublicJSON(fetch, origin, MOBILE_LATEST));
            if (isDeepStrictEqual(observed, beforeOTA)) {
              attempted = false;
              throw new ReleaseGateError("ota_rejected");
            }
          }
          throw new ReleaseGateError(reasonFor(error, "ota_write_uncertain"));
        }
        completed.push(activePhase);
        await onPhase({ phase: activePhase, state: "succeeded", receipt });
        attempted = false;
      }
      return { status: "succeeded", reason: "verified", completed };
    } catch (error) {
      const reason = reasonFor(error, attempted ? "release_outcome_uncertain" : "release_check_unavailable");
      if (activePhase) {
        try { await onPhase({ phase: activePhase, state: attempted ? "uncertain" : "failed", reason }); }
        catch { /* The returned receipt still carries the outcome. */ }
      }
      return { status: attempted ? "uncertain" : completed.length ? "partial" : "blocked", reason, completed };
    }
  }

  return { inspect, captureBaseline, release };
}
