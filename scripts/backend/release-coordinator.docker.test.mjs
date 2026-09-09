import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildGoUpgradeCycle } from "./testdata/go-upgrade-coordinator.mjs";
import { buildPassiveCandidateComposeAdapter, buildPassiveCandidateFixture } from "./testdata/passive-candidate-fixture.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const imagePattern = /^sha256:[0-9a-f]{64}$/u;
const idPattern = /^[0-9a-f]{64}$/u;
const ownerLabel = "com.duallane.release-coordinator-test";
const selected = process.env.DUALLANE_RELEASE_COORDINATOR_DOCKER_TEST === "true";
const upgradeSelected = process.env.DUALLANE_RELEASE_COORDINATOR_UPGRADE_TEST === "true";
const imageVariables = {
  node: "DUALLANE_RELEASE_COORDINATOR_NODE_IMAGE",
  nodeWeb: "DUALLANE_RELEASE_COORDINATOR_NODE_WEB_IMAGE",
  goWorkspace: "DUALLANE_RELEASE_COORDINATOR_GO_IMAGE",
  goP2P: "DUALLANE_RELEASE_COORDINATOR_P2P_IMAGE",
  goWeb: "DUALLANE_RELEASE_COORDINATOR_WEB_IMAGE",
  postgres: "DUALLANE_RELEASE_COORDINATOR_POSTGRES_IMAGE",
};

const permissionScenarios = new Set(["permissions", "permissions-failure"]);
const passiveScenarios = new Set(["passive", ...permissionScenarios]);
const permissionCanonicalBytes = Buffer.from("synthetic-canonical-object-v1", "utf8");
const permissionLegacyBytes = Buffer.from("synthetic-legacy-object-v1", "utf8");
const permissionCanonicalDigest = createHash("sha256").update(permissionCanonicalBytes).digest("hex");
const permissionLegacyDigest = createHash("sha256").update(permissionLegacyBytes).digest("hex");
const permissionFixtureFiles = Object.freeze({
  canonical: `workspace/objects/sha256/${permissionCanonicalDigest.slice(0, 2)}/${permissionCanonicalDigest}`,
  legacy: "legacy/synthetic-legacy.bin",
});

function isPermissionScenario(scenario) { return permissionScenarios.has(scenario); }
function isPassiveScenario(scenario) { return passiveScenarios.has(scenario); }

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function permissionInitCommand() {
  const canonicalParent = path.posix.dirname(permissionFixtureFiles.canonical);
  const legacyParent = path.posix.dirname(permissionFixtureFiles.legacy);
  const canonicalPath = `/app/data/workspace-files/${permissionFixtureFiles.canonical}`;
  const legacyPath = `/app/data/workspace-files/${permissionFixtureFiles.legacy}`;
  return [
    "set -eu",
    `mkdir -p /app/data/workspace-files/${canonicalParent} /app/data/workspace-files/${legacyParent}`,
    `printf '%s' ${shellQuote(permissionCanonicalBytes.toString("utf8"))} > ${shellQuote(canonicalPath)}`,
    `printf '%s' ${shellQuote(permissionLegacyBytes.toString("utf8"))} > ${shellQuote(legacyPath)}`,
    "chown -R 0:0 /app/data",
    "find /app/data -type d -exec chmod 0755 {} +",
    "find /app/data -type f -exec chmod 0755 {} +",
    `test "$(stat -c '%u:%g:%a' /app/data)" = 0:0:755`,
    `test "$(stat -c '%u:%g:%a' /app/data/workspace-files)" = 0:0:755`,
    `test "$(stat -c '%u:%g:%a' ${shellQuote(canonicalPath)})" = 0:0:755`,
    `test "$(stat -c '%u:%g:%a' ${shellQuote(legacyPath)})" = 0:0:755`,
    `test "$(cat ${shellQuote(canonicalPath)})" = ${shellQuote(permissionCanonicalBytes.toString("utf8"))}`,
    `test "$(cat ${shellQuote(legacyPath)})" = ${shellQuote(permissionLegacyBytes.toString("utf8"))}`,
  ].join("\n");
}

async function privatePathInfo(target, kind, mode, code) {
  let info;
  try { info = await lstat(target); } catch { reject(code); }
  if ((kind === "file" && !info.isFile()) || (kind === "directory" && !info.isDirectory()) ||
      info.isSymbolicLink() || (info.mode & 0o777) !== mode) reject(code);
  return info;
}

async function privateJSON(target, code) {
  try { return JSON.parse(await readFile(target, "utf8")); } catch { reject(code); }
}

async function verifyPermissionBackupEvidence(recoveryPath) {
  const backupRoot = `${recoveryPath}.data-backup`;
  await privatePathInfo(backupRoot, "directory", 0o700, "permission_backup_root_invalid");
  const runEntries = await readdir(backupRoot, { withFileTypes: true }).catch(() => reject("permission_backup_run_invalid"));
  if (runEntries.length !== 1 || !runEntries[0].isDirectory() || runEntries[0].isSymbolicLink()) {
    reject("permission_backup_run_invalid");
  }
  const runDirectory = path.join(backupRoot, runEntries[0].name);
  const dataDirectory = path.join(runDirectory, "data");
  await privatePathInfo(runDirectory, "directory", 0o700, "permission_backup_run_invalid");
  await privatePathInfo(dataDirectory, "directory", 0o700, "permission_backup_data_invalid");
  const manifestPath = path.join(runDirectory, "manifest.json");
  const phasePath = path.join(runDirectory, "phase.json");
  const reportPath = path.join(runDirectory, "report.json");
  await privatePathInfo(manifestPath, "file", 0o600, "permission_backup_manifest_invalid");
  await privatePathInfo(phasePath, "file", 0o600, "permission_backup_phase_invalid");
  await privatePathInfo(reportPath, "file", 0o600, "permission_backup_report_invalid");

  const expectedBytes = permissionCanonicalBytes.length + permissionLegacyBytes.length;
  const report = await privateJSON(reportPath, "permission_backup_report_invalid");
  if (report.status !== "completed" || report.operation !== "volume" || report.fileCount !== 2 ||
      report.totalBytes !== expectedBytes) reject("permission_backup_report_invalid");
  const manifest = await privateJSON(manifestPath, "permission_backup_manifest_invalid");
  if (manifest.status !== "verified_original" || manifest.operation !== "volume" ||
      manifest.totalBytes !== expectedBytes || !Array.isArray(manifest.entries)) {
    reject("permission_backup_manifest_invalid");
  }
  const phase = await privateJSON(phasePath, "permission_backup_phase_invalid");
  if (phase.status !== "completed" || phase.operation !== "volume" || phase.copiedEntries !== 2 ||
      phase.copiedBytes !== expectedBytes || !Array.isArray(phase.entries)) {
    reject("permission_backup_phase_invalid");
  }

  const expected = [
    [permissionFixtureFiles.canonical, permissionCanonicalBytes, permissionCanonicalDigest],
    [permissionFixtureFiles.legacy, permissionLegacyBytes, permissionLegacyDigest],
  ];
  const expectedManifestPaths = new Set(expected.map(([relative]) => path.posix.join("workspace-files", relative)));
  const fileEntries = manifest.entries.filter((entry) => entry?.kind === "file");
  if (fileEntries.length !== expected.length ||
      fileEntries.some((entry) => !expectedManifestPaths.has(entry.relative))) {
    reject("permission_backup_manifest_invalid");
  }
  const phaseFileEntries = phase.entries.filter((entry) => entry?.kind === "file");
  if (phaseFileEntries.length !== expected.length ||
      phaseFileEntries.some((entry) => !expectedManifestPaths.has(entry.relative))) {
    reject("permission_backup_phase_invalid");
  }

  const directories = new Set([dataDirectory]);
  for (const [relative, bytes, digest] of expected) {
    const sourceRelative = path.posix.join("workspace-files", relative);
    const entry = fileEntries.find((item) => item.relative === sourceRelative);
    if (!entry || entry.sha256 !== digest || entry.original?.mode !== 0o755 || entry.original?.uid !== 0 ||
        entry.original?.gid !== 0 || entry.original?.size !== bytes.length) {
      reject("permission_backup_manifest_invalid");
    }
    const phaseEntry = phaseFileEntries.find((item) => item.relative === sourceRelative);
    if (!phaseEntry || phaseEntry.sha256 !== digest || phaseEntry.backupRelative !== sourceRelative ||
        phaseEntry.original?.mode !== 0o755 || phaseEntry.original?.uid !== 0 ||
        phaseEntry.original?.gid !== 0 || phaseEntry.original?.size !== bytes.length) {
      reject("permission_backup_phase_invalid");
    }
    const backupFile = path.join(dataDirectory, ...sourceRelative.split("/"));
    await privatePathInfo(backupFile, "file", 0o600, "permission_backup_file_invalid");
    let parent = path.dirname(backupFile);
    while (parent.startsWith(`${dataDirectory}${path.sep}`)) {
      directories.add(parent);
      parent = path.dirname(parent);
    }
    let copied;
    try { copied = await readFile(backupFile); } catch { reject("permission_backup_file_invalid"); }
    if (!copied.equals(bytes)) reject("permission_backup_file_invalid");
  }
  for (const directory of directories) await privatePathInfo(directory, "directory", 0o700, "permission_backup_directory_invalid");
}

async function verifyPermissionTargetAfterRecovery(apiContainer) {
  const expected = [
    { kind: "directory", path: "/app/data", mode: 0o700, uid: 65532, gid: 65532 },
    { kind: "directory", path: "/app/data/workspace-files", mode: 0o700, uid: 65532, gid: 65532 },
    { kind: "directory", path: "/app/data/workspace-files/workspace", mode: 0o700, uid: 65532, gid: 65532 },
    { kind: "directory", path: "/app/data/workspace-files/workspace/objects", mode: 0o700, uid: 65532, gid: 65532 },
    { kind: "directory", path: "/app/data/workspace-files/workspace/objects/sha256", mode: 0o700, uid: 65532, gid: 65532 },
    { kind: "directory", path: `/app/data/workspace-files/workspace/objects/sha256/${permissionCanonicalDigest.slice(0, 2)}`,
      mode: 0o700, uid: 65532, gid: 65532 },
    { kind: "directory", path: "/app/data/workspace-files/legacy", mode: 0o700, uid: 65532, gid: 65532 },
    { kind: "file", path: `/app/data/workspace-files/${permissionFixtureFiles.canonical}`, mode: 0o600,
      uid: 65532, gid: 65532, size: permissionCanonicalBytes.length, sha256: permissionCanonicalDigest },
    { kind: "file", path: `/app/data/workspace-files/${permissionFixtureFiles.legacy}`, mode: 0o600,
      uid: 65532, gid: 65532, size: permissionLegacyBytes.length, sha256: permissionLegacyDigest },
  ];
  const script = [
    "const fs=require('node:fs');",
    "const crypto=require('node:crypto');",
    `const expected=${JSON.stringify(expected)};`,
    "const rows=expected.map(item=>{const s=fs.lstatSync(item.path); const row={kind:s.isDirectory()?'directory':'file',path:item.path,mode:s.mode&0o777,uid:s.uid,gid:s.gid,size:s.size}; if(s.isFile()) row.sha256=crypto.createHash('sha256').update(fs.readFileSync(item.path)).digest('hex'); return row;});",
    "process.stdout.write(JSON.stringify(rows));",
  ].join("");
  let rows;
  try { rows = JSON.parse(docker(["exec", apiContainer.Id, "node", "-e", script]).stdout); } catch { reject("permission_target_invalid"); }
  if (!Array.isArray(rows) || rows.length !== expected.length) reject("permission_target_invalid");
  for (let index = 0; index < expected.length; index += 1) {
    const actual = rows[index], wanted = expected[index];
    if (actual.kind !== wanted.kind || actual.path !== wanted.path || actual.mode !== wanted.mode ||
        actual.uid !== wanted.uid || actual.gid !== wanted.gid ||
        (wanted.kind === "file" && (actual.size !== wanted.size || actual.sha256 !== wanted.sha256))) {
      reject("permission_target_invalid");
    }
  }
}

function reject(code) { throw new Error(code); }

const upgradeImageVariables = {
  goWorkspace: "DUALLANE_RELEASE_COORDINATOR_UPGRADE_GO_IMAGE",
  goP2P: "DUALLANE_RELEASE_COORDINATOR_UPGRADE_P2P_IMAGE",
  goWeb: "DUALLANE_RELEASE_COORDINATOR_UPGRADE_WEB_IMAGE",
};

function selectedImages(environment, variables = imageVariables) {
  return Object.fromEntries(Object.entries(variables).map(([name, key]) => {
    const image = environment[key];
    if (!imagePattern.test(image ?? "")) reject(`invalid_${name}_image`);
    return [name, image];
  }));
}

function docker(args, { timeout = 30_000, allowFailure = false } = {}) {
  const result = spawnSync("docker", args, {
    cwd: root, encoding: "utf8", timeout, maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_HOST: "unix:///var/run/docker.sock", COMPOSE_DISABLE_ENV_FILE: "1" },
  });
  if (result.error || result.signal) reject("docker_execution_failed");
  if (!allowFailure && result.status !== 0) {
    const reason = ["dependency", "unhealthy", "permission denied", "no such container", "port is already allocated", "invalid mount"]
      .find((value) => result.stderr.toLowerCase().includes(value));
    reject(`docker_${args[0]}_failed${reason ? `_${reason.replaceAll(" ", "_")}` : ""}`);
  }
  return result;
}

function inspect(kind, id) {
  const result = docker([kind, "inspect", id]);
  let value;
  try { value = JSON.parse(result.stdout); } catch { reject("docker_inspect_invalid"); }
  if (!Array.isArray(value) || value.length !== 1) reject("docker_inspect_count_invalid");
  return value[0];
}

function exactImage(image) {
  const value = inspect("image", image);
  if (value.Id !== image) reject("image_identity_changed");
  return value.Config?.Labels ?? {};
}

function releaseMetadata(labels) {
  const commit = labels["org.opencontainers.image.revision"];
  const version = labels["org.opencontainers.image.version"];
  if (!/^[0-9a-f]{40}$/u.test(commit ?? "") || !/^\d+\.\d+\.\d+$/u.test(version ?? "")) {
    reject("release_metadata_invalid");
  }
  return { commit, version };
}

function extractFunction(source, name) {
  const start = source.indexOf(`\n${name}() {`);
  if (start < 0) reject("release_function_missing");
  const end = source.indexOf("\n}\n", start);
  if (end < 0) reject("release_function_unbounded");
  return source.slice(start + 1, end + 2);
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function ownedContainers(project, runID, allowedImages) {
  const result = docker(["ps", "-a", "--no-trunc", "-q", "--filter", `label=com.docker.compose.project=${project}`]);
  return result.stdout.trim().split(/\s+/u).filter(Boolean).map((id) => {
    if (!idPattern.test(id)) reject("container_identity_invalid");
    const container = inspect("container", id);
    if (container.Id !== id || container.Config?.Labels?.[ownerLabel] !== runID ||
        container.Config?.Labels?.["com.docker.compose.project"] !== project ||
        !allowedImages.has(container.Image)) reject("container_ownership_changed");
    return container;
  });
}

function removeExactContainer(container, project, runID, allowedImages) {
  const current = inspect("container", container.Id);
  if (current.Id !== container.Id || current.Image !== container.Image ||
      current.Config?.Labels?.[ownerLabel] !== runID ||
      current.Config?.Labels?.["com.docker.compose.project"] !== project ||
      !allowedImages.has(current.Image)) reject("cleanup_owner_changed");
  // Cleanup is not evidence that the coordinator fenced an owner. Stop only
  // this disposable fixture's exact ID, then require a stopped identity before
  // removal; a failed lifecycle assertion still fails the test.
  if (current.State?.Running) docker(["stop", "--time", "10", container.Id]);
  const stopped = inspect("container", container.Id);
  if (stopped.Id !== current.Id || stopped.Image !== current.Image || stopped.State?.Running ||
      stopped.Config?.Labels?.[ownerLabel] !== runID ||
      stopped.Config?.Labels?.["com.docker.compose.project"] !== project) reject("cleanup_stop_unverified");
  docker(["rm", container.Id]);
}

function coordinatorScript(deploySource, scenario = "success", candidateAdapter = "") {
  if (!["success", "after-backend", "after-capture", "go-upgrade", "passive", ...permissionScenarios].includes(scenario)) reject("coordinator_scenario_invalid");
  const functions = ["verify_container_release", "start_release_service", "stop_legacy_services_for_go",
    "start_release_backend", "start_release_edge", "cleanup_candidates", "rollback_app",
    "restore_runtime_after_daemon_restart", "on_error", "go_upgrade_rollback_compose"].map((name) => extractFunction(deploySource, name));
  const permissionScenario = isPermissionScenario(scenario);
  const passiveScenario = isPassiveScenario(scenario);
  return [
    "set -Eeuo pipefail", "umask 077", 'source "$ROOT/deploy/production/release-helper.sh"',
    ...functions,
    // Only the Compose input adapter differs from production: all lifecycle,
    // authority, drain, migration, smoke and recovery functions are real.
    'compose() { local files=(-f "${RELEASE_GO_ACTIVATION_COMPOSE_FILE:-$GO_COMPOSE}"); if [[ -z "$RELEASE_GO_ACTIVATION_COMPOSE_FILE" && -n "$RELEASE_GO_IMAGE_OVERRIDE_FILE" ]]; then files+=(-f "$RELEASE_GO_IMAGE_OVERRIDE_FILE"); fi; docker compose --project-name "$PROJECT" --profile rollback "${files[@]}" "$@"; }',
    'rollback_compose() { docker compose --project-name "$PROJECT" -f "${RELEASE_NODE_RECOVERY_COMPOSE_FILE:-$NODE_COMPOSE}" "$@"; }',
    ...(passiveScenario ? [candidateAdapter] : []),
    'phase() { printf "%s\\n" "$1" >> "$PHASE_FILE"; }',
    'app_replaced=false; trap on_error ERR',
    // A deterministic failure enters the actual production ERR handler. No
    // cleanup, fence, recovery or health decision is replaced by the fixture.
    'inject_failure() { phase injected_failure; return 74; }',
    'PROJECT_DIR=$ROOT; COMPOSE_PROJECT_NAME=$PROJECT; export COMPOSE_PROJECT_NAME; current_commit=$GO_COMMIT; expected_app_version=$GO_VERSION',
    'release_load_profile go-full',
    'RELEASE_GO_UPGRADE=false; RELEASE_SNAPSHOT_FILE=$SNAPSHOT; RELEASE_RECOVERY_FILE=$RECOVERY',
    'RELEASE_PREVIOUS_NODE_COMMIT=$NODE_COMMIT; RELEASE_PREVIOUS_NODE_VERSION=$NODE_VERSION',
    'RELEASE_STOP_TIMEOUT=10; RELEASE_STOP_ATTEMPTS=15; RELEASE_HEALTH_ATTEMPTS=30',
    ...(permissionScenario ? ['prepare_go_permissions=true', 'release_preflight_permission_tools'] : []),
    ': > "$RECOVERY"; phase snapshot',
    'release_validate_resolved_compose; release_pin_compose_project',
    'release_snapshot_app_state "$SNAPSHOT"; release_snapshot_validate_for_go_cutover',
    ...(permissionScenario ? ['phase permission_inputs; release_prepare_permission_inputs'] : []),
    'release_freeze_node_recovery_compose',
    'phase pin; release_verify_go_edge_images; release_verify_go_image_identity',
    'release_freeze_go_activation_compose; release_verify_activation_authority',
    'phase migrate; release_run_go_migration_and_verify',
    ...(permissionScenario ? [
      'phase permission_offline; app_replaced=true; stop_legacy_services_for_go; release_require_drained_runtime activation; release_prepare_offline_data_permissions',
      ...(scenario === "permissions-failure" ? ['inject_failure'] : []),
    ] : []),
    ...(passiveScenario ? [
      'phase candidates; release_start_candidates',
      ...(scenario === "passive" ? [
        // The old application remains the only active writer during preflight.
        '[[ "$(rollback_compose ps -a -q api)" == "$ORIGINAL_NODE_API" ]]',
        '[[ "$(docker inspect "$ORIGINAL_NODE_API" --format "{{.State.Running}}:{{.State.Health.Status}}")" == true:healthy ]]',
        '[[ "$(rollback_compose ps -a -q web)" == "$ORIGINAL_NODE_WEB" ]]',
        '[[ "$(docker inspect "$ORIGINAL_NODE_WEB" --format "{{.State.Running}}:{{.State.Health.Status}}")" == true:healthy ]]',
      ] : [
        // Permission preparation intentionally creates an outage. Prove only
        // that the retained Node writer is fenced; do not require old health
        // while the offline data operation is in progress.
        '[[ "$(docker inspect "$ORIGINAL_NODE_API" --format "{{.State.Running}}")" == false ]]',
      ]),
      '[[ "${#RELEASE_CANDIDATE_RECORDS[@]}" == 0 ]]',
      'if docker network inspect "$EXPECTED_CANDIDATE_NETWORK" >/dev/null 2>&1; then false; fi',
    ] : []),
    'phase activate; start_release_backend',
    ...(scenario === "after-backend" ? ['inject_failure'] : []),
    'start_release_edge',
    'phase smoke; release_run_gateway_smoke go-full "$GO_VERSION" "$GO_COMMIT"',
    ...(scenario === "permissions-failure" ? [] : ['phase capture; release_capture_successful_go_snapshot']),
    ...(scenario === "after-capture" ? ['inject_failure'] : []),
    ...(scenario === "go-upgrade" ? [buildGoUpgradeCycle()] : []),
    'phase rollback; release_rollback_application',
    'phase complete',
  ].join("\n");
}

function releaseErrorCatalog(source, prefix) {
  return source.split("\n").flatMap((line, index) => {
    const message = line.match(/^\s*echo "([^"]+)" >&2\s*$/u)?.[1];
    if (!message) return [];
    const pattern = message.split(/\$\{[^}]+\}/u)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("[^\\n]*");
    return [{ code: `${prefix}_${index + 1}`, pattern: new RegExp(`^${pattern}$`, "mu") }];
  });
}

async function runCoordinator(scriptPath, environment, timeout = 360_000) {
  const errorCatalog = [];
  for (const [filename, prefix] of [["deploy.sh", "deploy_line"], ["release-helper.sh", "helper_line"]]) {
    const source = (await readFile(path.join(root, "deploy/production", filename), "utf8")).replaceAll("\r\n", "\n");
    errorCatalog.push(...releaseErrorCatalog(source, prefix));
  }
  return await new Promise((resolve, rejectPromise) => {
    const child = spawn("bash", ["--noprofile", "--norc", scriptPath], {
      cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_HOST: "unix:///var/run/docker.sock", COMPOSE_DISABLE_ENV_FILE: "1", ...environment },
    });
    let bytes = 0, terminationTimer, failure, errors = "", reports = "";
    const terminate = (code) => {
      if (failure) return;
      failure = code;
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* child already exited */ }
      terminationTimer = setTimeout(() => {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* owned group already exited */ }
      }, 3000);
    };
    const timer = setTimeout(() => terminate("coordinator_timeout"), timeout);
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) terminate("coordinator_output_limit");
      if (stream === child.stderr && bytes <= 1024 * 1024) errors += chunk.toString("utf8");
      if (stream === child.stdout && bytes <= 1024 * 1024) reports += chunk.toString("utf8");
      // Never publish Compose environments, HTTP bodies or process diagnostics.
    });
    child.once("error", () => {
      clearTimeout(timer); clearTimeout(terminationTimer);
      rejectPromise(new Error("coordinator_spawn_failed"));
    });
    child.once("close", (status) => {
      clearTimeout(timer); clearTimeout(terminationTimer);
      const codes = [...errors.matchAll(/^release (?:drain run|node authority|volume authority|external files|storage permissions) rejected: ([a-z_]+)$/gmu)]
        .map((match) => match[1]);
      // Report the known source location, not interpolated values (which may
      // contain private configuration paths or other recovery authority).
      for (const entry of errorCatalog) if (entry.pattern.test(errors)) codes.push(entry.code);
      for (const match of errors.matchAll(/^Production deployment failed with exit code (\d+)$/gmu)) {
        codes.push(`deployment_failed_${match[1]}`);
      }
      // Retain only shell identifiers, never raw arguments or environment
      // values, when a fixture omitted a production initialization variable.
      for (const match of errors.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*): unbound variable\b/gu)) {
        codes.push(`unbound_${match[1]}`);
      }
      for (const [message, code] of [
        ["Production deployment failed and automatic runtime recovery was incomplete", "automatic_recovery_incomplete"],
        ["gateway smoke requires one supported local application binding", "gateway_binding_invalid"],
        ["gateway release metadata differs from the expected release", "gateway_metadata_mismatch"],
        ["gateway smoke requires verified release metadata", "gateway_expected_metadata_invalid"],
      ]) if (errors.includes(message)) codes.push(code);
      for (const line of errors.split("\n")) {
        try {
          const report = JSON.parse(line);
          if (report.status === "FAIL" && /^[a-z_]+$/u.test(report.code ?? "")) {
            codes.push(`permission_probe_${report.code}`);
          }
        } catch { /* Permission helpers expose only fixed, content-free codes. */ }
      }
      for (const line of reports.split("\n")) {
        try {
          const report = JSON.parse(line);
          if (report.status === "FAIL" && /^[a-z_-]+$/u.test(report.error?.stage ?? "") &&
              /^[a-z_]+$/u.test(report.error?.code ?? "")) codes.push(`${report.error.stage}_${report.error.code}`);
        } catch { /* Only the smoke helper's content-free error fields are retained. */ }
      }
      resolve({ status, failure, codes });
    });
  });
}

test("coordinator gate rejects mutable images and extracts only scoped release functions", async () => {
  assert.throws(() => selectedImages({}), /invalid_node_image/u);
  const env = Object.fromEntries(Object.values(imageVariables).map((name) => [name, `sha256:${"a".repeat(64)}`]));
  assert.equal(Object.keys(selectedImages(env)).length, 6);
  env.DUALLANE_RELEASE_COORDINATOR_GO_IMAGE = "workspace:latest";
  assert.throws(() => selectedImages(env), /invalid_goWorkspace_image/u);
  const source = (await readFile(path.join(root, "deploy/production/deploy.sh"), "utf8")).replaceAll("\r\n", "\n");
  const script = coordinatorScript(source);
  assert.match(script, /release_rollback_application/u);
  assert.match(script, /trap on_error ERR/u);
  for (const scenario of ["after-backend", "after-capture"]) {
    const failureScript = coordinatorScript(source, scenario);
    assert.match(failureScript, /\ninject_failure\n/u);
    assert.match(failureScript, /local exit_code=\$\?/u);
  }
  assert.throws(() => coordinatorScript(source, "unknown"), /coordinator_scenario_invalid/u);
  const passiveScript = coordinatorScript(source, "passive", "candidate_compose() { false; }");
  assert.ok(passiveScript.indexOf("phase candidates; release_start_candidates") < passiveScript.indexOf("phase activate; start_release_backend"));
  assert.match(passiveScript, /ORIGINAL_NODE_API/u);
  const networkGuard = passiveScript.split("\n").find((line) => line.startsWith('if docker network inspect "$EXPECTED_CANDIDATE_NETWORK"'));
  assert.match(networkGuard, /then false; fi$/u);
  for (const scenario of ["permissions", "permissions-failure"]) {
    const permissionScript = coordinatorScript(source, scenario, "candidate_compose() { false; }");
    assert.match(permissionScript, /prepare_go_permissions=true/u);
    assert.ok(permissionScript.indexOf("release_snapshot_validate_for_go_cutover") < permissionScript.indexOf("release_prepare_permission_inputs"));
    assert.ok(permissionScript.indexOf("release_prepare_permission_inputs") < permissionScript.indexOf("release_freeze_node_recovery_compose"));
    assert.ok(permissionScript.indexOf("release_run_go_migration_and_verify") < permissionScript.indexOf("release_prepare_offline_data_permissions"));
    assert.ok(permissionScript.indexOf("release_prepare_offline_data_permissions") < permissionScript.indexOf("phase candidates; release_start_candidates"));
    assert.match(permissionScript, /COMPOSE_PROJECT_NAME=\$PROJECT/u);
    if (scenario === "permissions-failure") {
      assert.ok(permissionScript.indexOf("release_prepare_offline_data_permissions") < permissionScript.indexOf("\ninject_failure\n"));
      assert.doesNotMatch(permissionScript, /phase capture; release_capture_successful_go_snapshot/u);
    }
  }
  if (process.platform === "linux") {
    for (const present of [true, false]) {
      const result = spawnSync("bash", ["--noprofile", "--norc", "-c", [
        "set -Eeuo pipefail",
        "trap 'status=$?; printf recovery_entered; exit \"$status\"' ERR",
        "EXPECTED_CANDIDATE_NETWORK=synthetic",
        `docker() { return ${present ? 0 : 1}; }`, networkGuard, "printf cleanup_confirmed",
      ].join("\n")], { encoding: "utf8", timeout: 5000, maxBuffer: 4096 });
      assert.equal(result.error, undefined);
      assert.equal(result.status, present ? 1 : 0);
      assert.equal(result.stdout, present ? "recovery_entered" : "cleanup_confirmed");
    }
  }
  const upgradeScript = coordinatorScript(source, "go-upgrade");
  assert.match(upgradeScript, /exec bash --noprofile --norc -s/u);
  assert.ok(upgradeScript.indexOf("release_capture_successful_go_snapshot") < upgradeScript.indexOf("exec bash --noprofile --norc -s"));
  const catalog = releaseErrorCatalog('  echo "cannot inspect ${private_path} (owner)" >&2', "fixture");
  assert.equal(catalog[0].pattern.test("cannot inspect secret-value (owner)"), true);
  assert.equal(catalog[0].code, "fixture_1");
  assert.doesNotMatch(script, /systemctl|git pull|compose build|deploy\.sh --/u);
});

test("disposable release fixtures expose only Web to the gateway network", async () => {
  const { buildReleaseFixtures } = await import("./testdata/release-fixture.mjs");
  const { validateResolvedCompose, profileOrFail } = await import("../../deploy/production/release-manifest.mjs");
  const options = { project: "dl-release-fixture", root, port: 18789, secretPath: path.join(root, "synthetic-secret.json"),
    images: Object.fromEntries(Object.keys(imageVariables).map((name) => [name, `sha256:${"a".repeat(64)}`])),
    versions: { node: "0.15.5", go: "0.16.0" }, commits: { node: "b".repeat(40), go: "c".repeat(40) },
    names: { network: "dl-release-private", gatewayNetwork: "dl-release-gateway", postgresVolume: "dl-release-pg", dataVolume: "dl-release-data" } };
  assert.throws(() => buildReleaseFixtures({ ...options, names: { ...options.names, gatewayNetwork: undefined } }), /gateway_network_invalid/u);
  const { nodeCompose, goCompose } = buildReleaseFixtures(options);
  for (const [profile, compose] of [["node-default", nodeCompose], ["go-full", goCompose]]) {
    validateResolvedCompose(profileOrFail(profile), compose);
    assert.equal(compose.networks.default.external, true);
    assert.equal(compose.networks.gateway.external, true);
    for (const [name, service] of Object.entries(compose.services)) {
      assert.deepEqual(service.networks, name === "web" ? ["default", "gateway"] : ["default"]);
      if (name === "web") assert.deepEqual(service.ports, ["127.0.0.1:18789:8080"]);
      else assert.equal(service.ports, undefined);
      for (const worker of ["EMAIL", "NTFY", "ECHO"]) {
        assert.notEqual(service.environment?.[`WORKSPACE_${worker}_WORKER_ENABLED`], "true");
      }
    }
  }
  assert.equal(goCompose.services.p2p.volumes, undefined);
  assert.equal(goCompose.services.p2p.secrets, undefined);
  assert.equal(Object.keys(goCompose.services.p2p.environment).some((name) => /^(?:PG|DATABASE|WORKSPACE_S3)/u.test(name)), false);
});

async function rehearseCoordinator(t, scenario) {
  if (process.platform !== "linux") { t.skip("Linux-only disposable Docker gate"); return; }
  if (isPermissionScenario(scenario) && process.getuid?.() !== 0) {
    t.skip("permission rehearsal is root-only because the real offline volume helper requires Linux root");
    return;
  }
  const images = selectedImages(process.env);
  const labels = Object.fromEntries(Object.entries(images).map(([name, image]) => [name, exactImage(image)]));
  const node = releaseMetadata(labels.node), go = releaseMetadata(labels.goWorkspace);
  assert.deepEqual(releaseMetadata(labels.nodeWeb), node, "Node images must identify one release");
  assert.deepEqual(releaseMetadata(labels.goP2P), go, "Go P2P must identify the Workspace release");
  assert.deepEqual(releaseMetadata(labels.goWeb), go, "Go Web must identify the Workspace release");
  if (node.commit === go.commit) reject("rehearsal_requires_distinct_releases");
  let upgradeImages, upgrade;
  if (scenario === "go-upgrade") {
    upgradeImages = selectedImages(process.env, upgradeImageVariables);
    upgrade = releaseMetadata(exactImage(upgradeImages.goWorkspace));
    for (const image of [upgradeImages.goP2P, upgradeImages.goWeb]) {
      assert.deepEqual(releaseMetadata(exactImage(image)), upgrade, "upgrade images must identify one release");
    }
    const before = go.version.split(".").map(BigInt), after = upgrade.version.split(".").map(BigInt);
    const different = after.findIndex((value, index) => value !== before[index]);
    if (upgrade.commit === go.commit || different < 0 || after[different] <= before[different]) reject("upgrade_requires_newer_distinct_release");
  }
  const runID = randomBytes(24).toString("hex"), project = `dl-release-${runID.slice(0, 20)}`;
  const names = { network: `${project}-private`, gatewayNetwork: `${project}-gateway`,
    postgresVolume: `${project}-pg`, dataVolume: `${project}-data` };
  const directory = await mkdtemp(path.join(os.tmpdir(), "duallane-coordinator-"));
  const paths = Object.fromEntries(["node", "go", "secret", "phases", "snapshot", "recovery", "script", "upgrade", "upgradeSnapshot", "upgradeRecovery", "candidate"]
    .map((name) => [name, path.join(directory, name + (name === "script" ? ".sh" : ".json"))]));
  const allowedImages = new Set([...Object.values(images), ...Object.values(upgradeImages ?? {})]);
  const resources = { networks: [], volumes: [] };
  let phase = "fixture", primary;
  try {
    const { buildReleaseFixtures } = await import("./testdata/release-fixture.mjs");
    const fixtureOptions = { project, images, versions: { node: node.version, go: go.version },
      commits: { node: node.commit, go: go.commit }, names, port: await availablePort(), secretPath: paths.secret, root };
    const fixtures = buildReleaseFixtures(fixtureOptions);
    if (isPermissionScenario(scenario)) fixtures.nodeCompose.services.api.user = "0:0";
    const candidate = isPassiveScenario(scenario) && buildPassiveCandidateFixture(fixtureOptions);
    const candidateNetwork = candidate && scenario !== "permissions-failure";
    const candidateAdapter = candidate && buildPassiveCandidateComposeAdapter({ project, commit: go.commit,
      candidateComposePath: paths.candidate, candidateOverlayPath: candidate.candidateOverlayPath });
    const upgradeCompose = upgrade && buildReleaseFixtures({ ...fixtureOptions, images: { ...images, ...upgradeImages },
      versions: { node: node.version, go: upgrade.version }, commits: { node: node.commit, go: upgrade.commit } }).goCompose;
    for (const compose of [fixtures.nodeCompose, fixtures.goCompose, ...(upgradeCompose ? [upgradeCompose] : []),
      ...(candidate ? [candidate.candidateCompose] : [])]) {
      for (const service of Object.values(compose.services)) service.labels = { ...service.labels, [ownerLabel]: runID };
    }
    await writeFile(paths.secret, JSON.stringify({ accessKey: "synthetic", secretKey: "synthetic-only" }), { mode: 0o600, flag: "wx" });
    await writeFile(paths.node, JSON.stringify(fixtures.nodeCompose), { mode: 0o600, flag: "wx" });
    await writeFile(paths.go, JSON.stringify(fixtures.goCompose), { mode: 0o600, flag: "wx" });
    if (upgradeCompose) await writeFile(paths.upgrade, JSON.stringify(upgradeCompose), { mode: 0o600, flag: "wx" });
    if (candidate) await writeFile(paths.candidate, JSON.stringify(candidate.candidateCompose), { mode: 0o600, flag: "wx" });
    phase = "node-config";
    docker(["compose", "--project-name", project, "-f", paths.node, "config", "--quiet"]);
    phase = "go-config";
    docker(["compose", "--project-name", project, "--profile", "rollback", "-f", paths.go, "config", "--quiet"]);
    if (upgradeCompose) docker(["compose", "--project-name", project, "--profile", "rollback", "-f", paths.upgrade, "config", "--quiet"]);
    if (docker(["ps", "-a", "-q", "--filter", `label=com.docker.compose.project=${project}`]).stdout.trim()) reject("project_already_exists");
    if (candidate) {
      for (const name of Object.values(candidate.candidateContainerNames)) {
        if (docker(["container", "inspect", name], { allowFailure: true }).status === 0) reject("candidate_name_already_exists");
      }
    }
    // Pre-create and inventory the disposable candidate network. The real
    // helper verifies/reuses it and owns normal cleanup; its create branch is
    // deliberately not claimed by this rehearsal.
    for (const [name, logical, internal] of [[names.network, "default", true], [names.gatewayNetwork, "gateway", false],
      ...(candidateNetwork ? [[candidate.candidateNetworkName, "candidate", true]] : [])]) {
      if (docker(["network", "inspect", name], { allowFailure: true }).status === 0) reject("network_already_exists");
      // Record intent before a mutating CLI call: a lost response must not leave
      // a newly created disposable resource outside the cleanup inventory.
      const resource = { name, id: null, internal };
      resources.networks.push(resource);
      resource.id = docker(["network", "create", ...(internal ? ["--internal"] : []), "--driver", "bridge",
        "--opt", "com.docker.network.bridge.host_binding_ipv4=127.0.0.1", "--label", `${ownerLabel}=${runID}`,
        "--label", `com.docker.compose.project=${project}`, "--label", `com.docker.compose.network=${logical}`,
        ...(logical === "candidate" ? ["--label", "com.duallane.release-owned=true", "--label", "com.duallane.release-profile=go-full",
          "--label", `com.duallane.release-commit=${go.commit}`] : []), name]).stdout.trim();
      if (!idPattern.test(resource.id)) reject("network_id_invalid");
      const network = inspect("network", resource.id);
      if (network.Internal !== internal || network.Name !== name || network.Labels?.[ownerLabel] !== runID) reject("network_not_isolated");
    }
    for (const [name, logical] of [[names.postgresVolume, "duallane-postgres"], [names.dataVolume, "duallane-data"]]) {
      if (docker(["volume", "inspect", name], { allowFailure: true }).status === 0) reject("volume_already_exists");
      resources.volumes.push(name);
      const created = docker(["volume", "create", "--label", `${ownerLabel}=${runID}`,
        "--label", `com.docker.compose.project=${project}`, "--label", `com.docker.compose.volume=${logical}`, name]).stdout.trim();
      if (created !== name) reject("volume_name_changed");
    }
    const base = ["compose", "--project-name", project, "-f", paths.node];
    phase = "permissions";
    const initCommand = isPermissionScenario(scenario)
      ? permissionInitCommand()
      : "mkdir -p /app/data/workspace-files && chown 65532:65532 /app/data /app/data/workspace-files && chmod 0770 /app/data /app/data/workspace-files";
    const init = docker(["create", "--pull=never", "--network", "none", "--user", "0:0", "--label", `${ownerLabel}=${runID}`,
      "--label", `com.docker.compose.project=${project}`, "--mount", `type=volume,source=${names.dataVolume},target=/app/data`,
      "--entrypoint", "/bin/sh", images.goWorkspace, "-c", initCommand]).stdout.trim();
    if (!idPattern.test(init)) reject("permission_container_id_invalid");
    docker(["start", "--attach", init]);
    const initialized = inspect("container", init);
    if (initialized.State?.ExitCode !== 0) reject("permission_initialization_failed");
    removeExactContainer(initialized, project, runID, allowedImages);
    phase = "node-postgres";
    docker([...base, "up", "-d", "--no-deps", "--pull", "never", "--no-build", "--wait", "--wait-timeout", "60", "postgres"], { timeout: 75_000 });
    const pgID = docker([...base, "ps", "-a", "-q", "postgres"]).stdout.trim();
    docker(["exec", pgID, "pg_isready", "-h", "127.0.0.1", "-U", "duallane", "-d", "duallane"]);
    phase = "node-migrate";
    docker([...base, "up", "--no-start", "--no-deps", "--pull", "never", "--no-build", "migrate"]);
    const migrationID = docker([...base, "ps", "-a", "-q", "migrate"]).stdout.trim();
    docker(["start", "--attach", migrationID], { timeout: 75_000 });
    const migration = inspect("container", migrationID);
    if (migration.State?.ExitCode !== 0) reject("node_migration_failed");
    for (const service of ["api", "web"]) {
      phase = `node-${service}`;
      docker([...base, "up", "-d", "--no-deps", "--pull", "never", "--no-build", "--wait", "--wait-timeout", "60", service], { timeout: 75_000 });
    }
    removeExactContainer(migration, project, runID, allowedImages);
    const originalPG = inspect("container", pgID).Id;
    const originalAPI = docker([...base, "ps", "-a", "-q", "api"]).stdout.trim();
    const originalWeb = docker([...base, "ps", "-a", "-q", "web"]).stdout.trim();
    if (isPermissionScenario(scenario)) {
      const nodeUser = inspect("container", originalAPI).Config?.User;
      if (nodeUser !== "0:0") reject("permission_node_user_invalid");
    }
    const deploy = (await readFile(path.join(root, "deploy/production/deploy.sh"), "utf8")).replaceAll("\r\n", "\n");
    await writeFile(paths.script, coordinatorScript(deploy, scenario, candidateAdapter?.script), { mode: 0o600, flag: "wx" });
    phase = "coordinator";
    const result = await runCoordinator(paths.script, { ROOT: root, PROJECT: project, NODE_COMPOSE: paths.node, GO_COMPOSE: paths.go,
      NODE_COMMIT: node.commit, NODE_VERSION: node.version, GO_COMMIT: go.commit, GO_VERSION: go.version,
      SNAPSHOT: paths.snapshot, RECOVERY: paths.recovery, PHASE_FILE: paths.phases,
      ...(candidate ? { ORIGINAL_NODE_API: originalAPI, ORIGINAL_NODE_WEB: originalWeb,
        EXPECTED_CANDIDATE_NETWORK: candidate.candidateNetworkName } : {}),
      ...(upgrade ? { UPGRADE_GO_COMPOSE: paths.upgrade, UPGRADE_COMMIT: upgrade.commit, UPGRADE_VERSION: upgrade.version,
        UPGRADE_SNAPSHOT: paths.upgradeSnapshot, UPGRADE_RECOVERY: paths.upgradeRecovery,
        PREVIOUS_GO_SNAPSHOT: `${paths.recovery}.go-compose.snapshot.json` } : {}),
    // The permission scenario adds a real dump, full copy/hash/fsync and UID
    // canary before the existing candidate/activation/recovery cycle. Give
    // that extra bounded stage the same rehearsal budget as a Go upgrade;
    // production helper timeouts and fail-closed gates are unchanged.
    }, upgrade || isPermissionScenario(scenario) ? 600_000 : 360_000);
    const phases = (await readFile(paths.phases, "utf8").catch(() => "")).trim().split("\n");
    const injectedFailure = ["after-backend", "after-capture", "permissions-failure"].includes(scenario);
    const expectedStatus = injectedFailure ? 74 : 0;
    if (result.status !== expectedStatus || result.failure) reject(`coordinator_failed_status${result.status}_${result.failure ?? "none"}_${phases.filter((value) => /^[a-z_]+(?:=\d+)?$/u.test(value)).slice(-2).join("_")}_${result.codes.join("_")}`);
    const expectedPhases = ["snapshot", ...(isPermissionScenario(scenario) ? ["permission_inputs"] : []), "pin", "migrate",
      ...(isPermissionScenario(scenario) ? ["permission_offline"] : [])];
    if (scenario === "permissions-failure") {
      expectedPhases.push("injected_failure");
    } else {
      expectedPhases.push(...(candidate ? ["candidates"] : []), "activate");
      if (scenario !== "after-backend") expectedPhases.push("smoke", "capture");
    }
    if (upgrade) expectedPhases.push(...["validate", "snapshot", "pin", "freeze", "migrate", "fence_drain_activate", "edge", "smoke", "capture", "rollback", "complete"].map((name) => `upgrade_${name}`));
    if (scenario !== "permissions-failure") expectedPhases.push(...(injectedFailure ? ["injected_failure"] : ["rollback", "complete"]));
    assert.deepEqual(phases, expectedPhases);
    if (injectedFailure) assert.ok(result.codes.includes("deployment_failed_74"), "actual ERR handler must preserve the injected failure status");
    for (const recovery of [paths.recovery, ...(upgrade ? [paths.upgradeRecovery] : [])]) {
      const snapshotPath = `${recovery}.go-compose.snapshot.json`;
      for (const suffix of ["after-backend", "permissions-failure"].includes(scenario) ? [] : ["", ".compose.json", ".external.json", ".volumes.json"]) {
        const metadata = await stat(snapshotPath + suffix);
        if ((metadata.mode & 0o777) !== 0o600) reject("snapshot_not_private");
      }
    }
    if (scenario === "permissions-failure" && await stat(`${paths.recovery}.go-compose.snapshot.json`).then(() => true).catch(() => false)) {
      reject("preactivation_go_snapshot_present");
    }
    const current = ownedContainers(project, runID, allowedImages);
    if (candidate) {
      for (const name of Object.values(candidate.candidateContainerNames)) {
        if (docker(["container", "inspect", name], { allowFailure: true }).status === 0) reject("passive_candidate_remained");
      }
      if (docker(["network", "inspect", candidate.candidateNetworkName], { allowFailure: true }).status === 0) reject("passive_network_remained");
    }
    for (const [service, image] of [["api", images.node], ["web", images.nodeWeb], ["postgres", images.postgres]]) {
      const matches = current.filter((container) => container.Config.Labels["com.docker.compose.service"] === service);
      if (matches.length !== 1 || !matches[0].State?.Running || matches[0].State?.Health?.Status !== "healthy" || matches[0].Image !== image) reject(`recovery_${service}_invalid`);
      if (service === "postgres" && (matches[0].Id !== originalPG ||
          matches[0].Mounts?.find((mount) => mount.Destination === "/var/lib/postgresql/data")?.Name !== names.postgresVolume)) {
        reject("postgres_authority_changed");
      }
    }
    const recoveredAPI = current.find((container) => container.Config.Labels["com.docker.compose.service"] === "api");
    if (!recoveredAPI || recoveredAPI.Mounts?.find((mount) => mount.Destination === "/app/data")?.Name !== names.dataVolume) {
      reject("data_authority_changed");
    }
    if (isPermissionScenario(scenario) && recoveredAPI) {
      await verifyPermissionBackupEvidence(paths.recovery);
      await verifyPermissionTargetAfterRecovery(recoveredAPI);
    }
    if (current.some((container) => ["p2p", "workspace", "worker"].includes(container.Config.Labels["com.docker.compose.service"]))) reject("candidate_owner_remained");
    t.diagnostic(scenario === "permissions-failure" ? "real root-only permission-stage failure recovered Node with unchanged PostgreSQL/data authority and private backup evidence"
      : candidate && isPermissionScenario(scenario) ? "real permission rehearsal passed root-only offline preparation, passive candidates while Node API was fenced, Go activation, private backup/data evidence and Node recovery"
      : candidate ? "real passive candidates passed mode, read-only, no-published-port and cleanup checks while exact Node API/Web stayed healthy, followed by Go activation and Node recovery"
      : upgrade ? "real pinned Go-to-Go activation and exact previous Go rollback passed before final exact Node recovery"
      : scenario === "success"
      ? "real Node migration, pinned Go activation, drain, gateway smoke, four private snapshot artifacts and exact Node recovery passed"
      : `actual ERR recovery passed after ${scenario}: original failure status, exact Node health and unchanged PostgreSQL identity`);
  } catch (error) {
    primary = new Error(`release_fixture_${phase}: ${/^[a-zA-Z0-9_= :.-]+$/u.test(error.message) ? error.message : "check_failed"}`);
    // Content-free failure evidence from this test's already verified owners.
    // Do not emit raw application/health logs, configuration or response bodies.
    try {
      for (const container of ownedContainers(project, runID, allowedImages)) {
        const logs = docker(["logs", "--tail", "80", container.Id], { allowFailure: true });
        const codes = [...new Set((logs.stdout + logs.stderr).match(/\b(?:EACCES|EPERM|ENOENT|ENOTFOUND|ECONNREFUSED|ERR_[A-Z_]+)\b/gu) ?? [])];
        const frames = [...new Set((logs.stdout + logs.stderr).match(/[a-z][a-z-]+\.mjs:\d+:\d+/gu) ?? [])].slice(0, 5);
        const bindings = container.Config.Labels["com.docker.compose.service"] === "web"
          ? container.NetworkSettings?.Ports?.["8080/tcp"]?.map((binding) => ({
            loopback: ["127.0.0.1", "::1"].includes(binding.HostIp), hasPort: /^[0-9]+$/u.test(binding.HostPort ?? "") })) ?? []
          : undefined;
        t.diagnostic(JSON.stringify({ service: container.Config.Labels["com.docker.compose.service"],
          running: container.State?.Running, exit: container.State?.ExitCode,
          health: container.State?.Health?.Status, restarts: container.RestartCount, codes, frames, bindings }));
      }
    } catch { t.diagnostic("owned_fixture_diagnostics_unavailable"); }
  } finally {
    let cleanupFailure;
    try {
      for (const container of ownedContainers(project, runID, allowedImages)) removeExactContainer(container, project, runID, allowedImages);
      for (const name of resources.volumes) {
        const present = docker(["volume", "ls", "--format", "{{.Name}}"])
          .stdout.trim().split("\n").includes(name);
        if (!present) continue;
        const volume = inspect("volume", name);
        if (volume.Name !== name || volume.Driver !== "local" || volume.Labels?.[ownerLabel] !== runID) reject("cleanup_volume_owner_changed");
        docker(["volume", "rm", name]);
      }
      for (const resource of resources.networks) {
        const present = docker(["network", "ls", "--format", "{{.Name}}"])
          .stdout.trim().split("\n").includes(resource.name);
        if (present) {
          const network = inspect("network", resource.name);
          if (!idPattern.test(network.Id) || (resource.id && network.Id !== resource.id) ||
              network.Name !== resource.name || network.Internal !== resource.internal ||
              network.Labels?.[ownerLabel] !== runID || Object.keys(network.Containers ?? {}).length) reject("cleanup_network_owner_changed");
          docker(["network", "rm", network.Id]);
        }
      }
    } catch { cleanupFailure = new Error("release_fixture_cleanup_failed"); }
    // Temporary files contain only this test's synthetic configuration. Keep
    // them private for operator recovery if exact Docker cleanup was refused.
    if (!cleanupFailure) await rm(directory, { recursive: true, force: true });
    if (cleanupFailure) throw new AggregateError(primary ? [primary, cleanupFailure] : [cleanupFailure], "release_fixture_failed");
  }
  if (primary) throw primary;
}

for (const [scenario, name] of [
  ["success", "real Node-to-Go activation captures a recovery snapshot and restores the exact Node gateway"],
  ["after-backend", "real ERR handler recovers Node after Go backend activation fails before edge startup"],
  ["after-capture", "real ERR handler recovers Node after a complete Go activation and snapshot"],
  ["go-upgrade", "real Go-to-Go upgrade restores the previous Go release before exact Node recovery"],
  ["passive", "real passive Go candidates preserve the active Node release before cutover and recovery"],
  ["permissions", "root-only permission preparation runs passive candidates, Go activation and exact Node recovery"],
  ["permissions-failure", "root-only permission preparation failure before activation recovers the exact Node authority"],
]) {
  test(name, {
    skip: !selected ? "set DUALLANE_RELEASE_COORDINATOR_DOCKER_TEST=true and the six immutable release image variables"
      : scenario === "go-upgrade" && !upgradeSelected ? "set DUALLANE_RELEASE_COORDINATOR_UPGRADE_TEST=true and the three immutable upgrade image variables"
      : isPermissionScenario(scenario) && (process.platform !== "linux" || process.getuid?.() !== 0)
      ? "permission scenarios are root-only Linux rehearsals because the real offline volume helper changes disposable volume metadata"
      : false,
    timeout: scenario === "go-upgrade" || isPermissionScenario(scenario) ? 720_000 : 480_000,
  }, (t) => rehearseCoordinator(t, scenario));
}
