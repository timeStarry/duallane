import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

export const PROBE_MAX_BYTES = 2 * 1024 * 1024;
export const MAX_DOCKER_ENV_VALUE_BYTES = 64 * 1024;
export const MAX_DOCKER_ARGUMENT_BYTES = 256 * 1024;
export const OWNER_LABEL = "com.timestarry.duallane.owner=runtime-permissions";
export const RUN_LABEL_KEY = "com.timestarry.duallane.runtime-permissions-run";
export const PROBE_OWNER = "runtime-permissions";
export const DATA_MOUNT_ROOT = "/app/data";
export const PROBE_DATA_ROOT = "/app/data/workspace-files";

const OWNER_LABEL_KEY = "com.timestarry.duallane.owner";
const SYNTHETIC_LABEL_KEY = "com.timestarry.duallane.synthetic";
const MANIFEST_PATH = "/run/permission-probe/manifest.json";
const SECRET_PATH = "/run/secrets/workspace-s3";
const IMAGE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
export const INIT_SCRIPT = String.raw`
set -eu
umask 077
mkdir -p ${PROBE_DATA_ROOT} /run/permission-probe /run/secrets

canonical_path="${PROBE_DATA_ROOT}/$CANONICAL_KEY"
legacy_path="${PROBE_DATA_ROOT}/$LEGACY_KEY"
mkdir -p "$(dirname "$canonical_path")" "$(dirname "$legacy_path")"

case "$DATA_MODE" in
  small)
    printf '%s' "$CANONICAL_B64" | base64 -d > "$canonical_path"
    printf '%s' "$LEGACY_B64" | base64 -d > "$legacy_path"
    ;;
  boundary|oversize)
    head -c "$DATA_BYTES" /dev/zero > "$canonical_path"
    head -c "$DATA_BYTES" /dev/zero > "$legacy_path"
  ;;
  symlink)
    printf '%s' "$CANONICAL_B64" | base64 -d > ${PROBE_DATA_ROOT}/synthetic-target
    ln -s ${PROBE_DATA_ROOT}/synthetic-target "$canonical_path"
    ln -s ${PROBE_DATA_ROOT}/synthetic-target "$legacy_path"
    ;;
  *)
    exit 41
    ;;
esac

printf '%s' "$SECRET_B64" | base64 -d > ${SECRET_PATH}
printf '%s' "$MANIFEST_B64" | base64 -d > /run/permission-probe/manifest.json

case "$DATA_OWNER" in
  root)
    chown -R 0:0 ${DATA_MOUNT_ROOT}
    ;;
  go)
    chown -R 65532:65532 ${DATA_MOUNT_ROOT}
    ;;
  *)
    exit 42
    ;;
esac
find ${DATA_MOUNT_ROOT} -type d -exec chmod 0700 {} +
find ${DATA_MOUNT_ROOT} -type f -exec chmod 0600 {} +
chmod 0755 /run/permission-probe /run/secrets
chmod 0444 /run/permission-probe/manifest.json

case "$SECRET_OWNER" in
  root)
    chown 0:0 ${SECRET_PATH}
    ;;
  go)
    chown 65532:65532 ${SECRET_PATH}
    ;;
  *)
    exit 43
    ;;
esac
chmod 0600 ${SECRET_PATH}
`;

export function parseOptions(args, environment = process.env) {
  const options = {
    docker: environment.RUNTIME_PERMISSIONS_DOCKER === "1",
    image: String(environment.RUNTIME_PERMISSIONS_IMAGE ?? "").trim(),
    initImage: String(environment.RUNTIME_PERMISSIONS_INIT_IMAGE ?? "").trim(),
    dockerBinary: String(environment.RUNTIME_PERMISSIONS_DOCKER_BIN ?? "docker").trim() || "docker",
    trace: false
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--docker") {
      options.docker = true;
    } else if (argument === "--image") {
      options.image = String(args[++index] ?? "").trim();
      if (!options.image) throw new Error("image_required");
    } else if (argument === "--init-image") {
      options.initImage = String(args[++index] ?? "").trim();
      if (!options.initImage) throw new Error("init_image_required");
    } else if (argument === "--docker-bin") {
      options.dockerBinary = String(args[++index] ?? "").trim();
      if (!options.dockerBinary) throw new Error("docker_binary_required");
    } else if (argument === "--trace") {
      options.trace = true;
    } else if (argument === "--help") {
      options.help = true;
    } else {
      throw new Error("unknown_option");
    }
  }
  if (options.help) return options;
  if (!options.docker) throw new Error("docker_opt_in_required");
  if (!options.image || !IMAGE_NAME_PATTERN.test(options.image)) throw new Error("explicit_image_required");
  if (!options.initImage || !IMAGE_NAME_PATTERN.test(options.initImage)) throw new Error("explicit_init_image_required");
  return options;
}

export function buildSyntheticCases() {
  const smallCanonical = Buffer.from("runtime permission canonical fixture\n", "utf8");
  const smallLegacy = Buffer.from("runtime permission legacy fixture\n", "utf8");
  const secret = Buffer.from("synthetic credential permission fixture\n", "utf8");
  const boundary = Buffer.alloc(PROBE_MAX_BYTES, 0x00);
  const oversize = Buffer.alloc(PROBE_MAX_BYTES + 1, 0x00);

  return [
    makeCase("root-data-denied", "small", "root", "go", smallCanonical, smallLegacy, secret, {
      exitCode: 1,
      root: "permission_denied",
      canonical: "not_run",
      legacy: "not_run",
      secret: "passed"
    }),
    makeCase("owned-positive", "small", "go", "go", smallCanonical, smallLegacy, secret, {
      exitCode: 0,
      root: "passed",
      canonical: "passed",
      legacy: "passed",
      secret: "passed"
    }),
    makeCase("root-secret-denied", "small", "go", "root", smallCanonical, smallLegacy, secret, {
      exitCode: 1,
      root: "passed",
      canonical: "passed",
      legacy: "passed",
      secret: "permission_denied"
    }),
    makeCase("max-bytes-accepted", "boundary", "go", "go", boundary, boundary, secret, {
      exitCode: 0,
      root: "passed",
      canonical: "passed",
      legacy: "passed",
      secret: "passed"
    }),
    makeCase("over-max-rejected", "oversize", "go", "go", oversize, oversize, secret, {
      exitCode: 1,
      root: "passed",
      canonical: "rejected",
      legacy: "rejected",
      canonicalErrorCode: "file.storage_too_large",
      legacyErrorCode: "file.storage_too_large",
      secret: "passed"
    }),
    makeCase("symlinks-rejected", "symlink", "go", "go", smallCanonical, smallCanonical, secret, {
      exitCode: 1,
      root: "passed",
      canonical: "rejected",
      legacy: "rejected",
      canonicalErrorCode: "storage.invalid_key",
      legacyErrorCode: "storage.invalid_key",
      secret: "passed"
    })
  ];
}

function makeCase(id, dataMode, dataOwner, secretOwner, canonicalContent, legacyContent, secretContent, expected) {
  const canonicalDigest = digest(canonicalContent);
  const legacyDigest = digest(legacyContent);
  const manifest = {
    version: 1,
    canonical: {
      key: `workspace/objects/sha256/${canonicalDigest.slice(0, 2)}/${canonicalDigest}`,
      sha256: canonicalDigest,
      byteSize: canonicalContent.byteLength
    },
    legacy: {
      key: `workspace/avatars/runtime-permissions-${id}.bin`,
      sha256: legacyDigest,
      byteSize: legacyContent.byteLength
    },
    secret: {
      path: SECRET_PATH,
      sha256: digest(secretContent),
      byteSize: secretContent.byteLength
    }
  };
  return Object.freeze({
    id,
    dataMode,
    dataOwner,
    secretOwner,
    dataBytes: canonicalContent.byteLength,
    canonicalContent,
    legacyContent,
    secretContent,
    manifest,
    expected: Object.freeze(expected)
  });
}

export function validateContainerInspection(details, expectation) {
  if (!details || typeof details !== "object") throw new Error("container_inspection_invalid");
  const labels = details.Config?.Labels ?? {};
  if (labels[OWNER_LABEL_KEY] !== PROBE_OWNER || labels[RUN_LABEL_KEY] !== expectation.runId || labels[SYNTHETIC_LABEL_KEY] !== "true") {
    throw new Error("container_label_mismatch");
  }
  if (details.Config?.User !== expectation.user) throw new Error("container_user_mismatch");
  if (details.HostConfig?.ReadonlyRootfs !== true) throw new Error("container_rootfs_not_readonly");
  if (details.HostConfig?.NetworkMode !== "none") throw new Error("container_network_not_isolated");

  for (const mount of expectation.mounts) {
    const actual = (details.Mounts ?? []).find((candidate) => candidate.Destination === mount.destination);
    if (!actual || actual.RW !== mount.rw) throw new Error("container_mount_mode_mismatch");
  }
  const expectedDestinations = new Set(expectation.mounts.map((mount) => mount.destination));
  for (const mount of details.Mounts ?? []) {
    if (mount.Destination === "/tmp" || mount.Destination === "/dev/shm") {
      if (mount.Type && mount.Type !== "tmpfs") throw new Error(`container_tmpfs_mismatch:${mount.Destination}`);
      continue;
    }
    if (!expectedDestinations.has(mount.Destination) && mount.RW === true) {
      throw new Error(`container_unexpected_rw_mount:${mount.Destination}`);
    }
  }
  for (const bindings of Object.values(details.NetworkSettings?.Ports ?? {})) {
    for (const binding of bindings ?? []) {
      const hostIp = String(binding.HostIp ?? "");
      if (hostIp && hostIp !== "127.0.0.1" && hostIp !== "::1") throw new Error("container_non_loopback_publish");
    }
  }
  return true;
}

export function runRuntimePermissions({ image, initImage, dockerBinary = "docker", trace = false } = {}) {
  if (!image || !IMAGE_NAME_PATTERN.test(image)) throw new Error("explicit_image_required");
  if (!initImage || !IMAGE_NAME_PATTERN.test(initImage)) throw new Error("explicit_init_image_required");
  const runId = `${Date.now().toString(36)}-${randomUUID().replaceAll("-", "")}`;
  const state = { volumes: [], containers: [] };
  const cases = buildSyntheticCases();
  let report;
  let executionError;
  try {
    requireDockerImage(dockerBinary, image);
    requireDockerImage(dockerBinary, initImage);
    const results = [];
    for (const fixture of cases) {
      traceMessage(trace, `case ${fixture.id}: prepare`);
      results.push(runCase({ dockerBinary, image, initImage, runId, fixture, state, trace }));
    }
    report = {
      version: 1,
      status: "passed",
      mode: "local-filesystem",
      s3: { status: "not_run", reason: "optional_fake_s3_stage" },
      runId,
      cases: results,
      summary: {
        total: results.length,
        passed: results.filter((result) => result.status === "passed").length,
        failed: results.filter((result) => result.status !== "passed").length
      }
    };
  } catch (error) {
    executionError = error;
  }

  let cleanup;
  try {
    cleanup = cleanupDockerResources(dockerBinary, runId, state);
  } catch {
    cleanup = {
      status: "incomplete",
      failures: ["cleanup_unexpected_failure"],
      containers: { removed: 0, alreadyAbsent: 0 },
      volumes: { removed: 0, alreadyAbsent: 0 }
    };
  }
  try {
    assertCleanupComplete(cleanup);
  } catch (cleanupError) {
    if (executionError) cleanupError.cause = executionError;
    throw cleanupError;
  }
  if (executionError) throw executionError;
  return { ...report, cleanup };
}

function runCase({ dockerBinary, image, initImage, runId, fixture, state, trace }) {
  const prefix = `duallane-runtime-permissions-${runId}-${fixture.id}`;
  const volumes = {
    data: createVolume(dockerBinary, `${prefix}-data`, runId, state),
    manifest: createVolume(dockerBinary, `${prefix}-manifest`, runId, state),
    secret: createVolume(dockerBinary, `${prefix}-secret`, runId, state)
  };
  const manifestBase64 = Buffer.from(JSON.stringify(fixture.manifest), "utf8").toString("base64");
  const initEnv = buildFixtureInitEnvironment(fixture, manifestBase64);
  createAndStartContainer({
    dockerBinary,
    image: initImage,
    runId,
    state,
    user: "0:0",
    mounts: [
      { volume: volumes.data, destination: DATA_MOUNT_ROOT, rw: true },
      { volume: volumes.manifest, destination: "/run/permission-probe", rw: true },
      { volume: volumes.secret, destination: "/run/secrets", rw: true }
    ],
    environment: initEnv,
    entrypoint: "/bin/sh",
    command: ["-ceu", INIT_SCRIPT],
    expectedExitCode: 0,
    stage: `${fixture.id}:init`
  });

  traceMessage(trace, `case ${fixture.id}: probe`);
  const probe = createAndStartContainer({
    dockerBinary,
    image,
    runId,
    state,
    user: "65532:65532",
    mounts: [
      { volume: volumes.data, destination: DATA_MOUNT_ROOT, rw: false },
      { volume: volumes.manifest, destination: "/run/permission-probe", rw: false },
      { volume: volumes.secret, destination: "/run/secrets", rw: false }
    ],
    entrypoint: "/usr/local/bin/duallane-permission-probe",
    command: ["--manifest", MANIFEST_PATH],
    expectedExitCode: fixture.expected.exitCode,
    stage: `${fixture.id}:probe`
  });
  const report = parseProbeReport(probe.stdout);
  assertExpectedCase(fixture, report, probe.exitCode);
  return {
    id: fixture.id,
    status: "passed",
    exitCode: probe.exitCode,
    uid: report.uid,
    gid: report.gid,
    checks: {
      root: report.root.status,
      canonical: report.canonical.status,
      legacy: report.legacy.status,
      secret: report.secret?.status ?? "not_run"
    },
    errorCodes: {
      canonical: report.canonical.errorCode ?? null,
      legacy: report.legacy.errorCode ?? null,
      secret: report.secret?.errorCode ?? null
    }
  };
}

export function buildFixtureInitEnvironment(fixture, manifestBase64 = Buffer.from(JSON.stringify(fixture.manifest), "utf8").toString("base64")) {
  const environment = {
    DATA_MODE: fixture.dataMode,
    DATA_OWNER: fixture.dataOwner,
    SECRET_OWNER: fixture.secretOwner,
    DATA_BYTES: String(fixture.dataBytes),
    CANONICAL_KEY: fixture.manifest.canonical.key,
    LEGACY_KEY: fixture.manifest.legacy.key,
    SECRET_B64: fixture.secretContent.toString("base64"),
    MANIFEST_B64: manifestBase64
  };
  if (fixture.dataMode === "small") {
    environment.CANONICAL_B64 = fixture.canonicalContent.toString("base64");
    environment.LEGACY_B64 = fixture.legacyContent.toString("base64");
  } else if (fixture.dataMode === "symlink") {
    environment.CANONICAL_B64 = fixture.canonicalContent.toString("base64");
  }
  validateEnvironmentBudget(environment);
  return environment;
}

function createAndStartContainer({ dockerBinary, image, runId, state, user, mounts, environment, entrypoint, command, expectedExitCode, stage }) {
  const args = [
    "create", "--rm",
    "--label", OWNER_LABEL,
    "--label", `${RUN_LABEL_KEY}=${runId}`,
    "--label", `${SYNTHETIC_LABEL_KEY}=true`,
    "--network", "none",
    "--read-only",
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m",
    "--user", user
  ];
  for (const mount of mounts) args.push("--mount", buildVolumeMountArgument(mount));
  for (const [key, value] of Object.entries(environment ?? {})) args.push("--env", `${key}=${value}`);
  args.push("--entrypoint", entrypoint, image, ...command);
  const created = docker(dockerBinary, args, stage, 30_000);
  const containerID = created.stdout.trim();
  if (!/^[0-9a-f]{12,64}$/i.test(containerID)) throw new Error(`${stage}:container_id_invalid`);
  state.containers.push(containerID);
  const details = inspectContainer(dockerBinary, containerID, stage);
  validateContainerInspection(details, {
    runId,
    user,
    mounts: mounts.map((mount) => ({ destination: mount.destination, rw: mount.rw }))
  });
  const started = docker(dockerBinary, ["start", "--attach", containerID], stage, 30_000, [0, 1]);
  if (started.status !== expectedExitCode) {
    const detail = stage.endsWith(":init") ? summarizeSyntheticOutput(started) : "";
    throw new Error(`${stage}:unexpected_exit${detail ? `:${detail}` : ""}`);
  }
  return { stdout: started.stdout, stderr: started.stderr, exitCode: started.status };
}

export function buildVolumeMountArgument(mount) {
  return `type=volume,source=${mount.volume},target=${mount.destination},volume-nocopy${mount.rw ? "" : ",readonly"}`;
}

function createVolume(dockerBinary, name, runId, state) {
  const existing = docker(dockerBinary, ["volume", "inspect", name], "volume_inspect", 10_000, [0, 1]);
  if (existing.status === 0) throw new Error("synthetic_volume_already_exists");
  const created = docker(dockerBinary, [
    "volume", "create",
    "--label", OWNER_LABEL,
    "--label", `${RUN_LABEL_KEY}=${runId}`,
    "--label", `${SYNTHETIC_LABEL_KEY}=true`,
    name
  ], "volume_create", 10_000);
  state.volumes.push(name);
  if (created.stdout.trim() !== name) throw new Error("synthetic_volume_name_mismatch");
  const inspection = docker(dockerBinary, ["volume", "inspect", name], "volume_verify", 10_000);
  let details;
  try {
    details = JSON.parse(inspection.stdout)[0];
  } catch {
    throw new Error("synthetic_volume_inspection_invalid");
  }
  const labels = details?.Labels ?? {};
  if (labels[OWNER_LABEL_KEY] !== PROBE_OWNER || labels[RUN_LABEL_KEY] !== runId || labels[SYNTHETIC_LABEL_KEY] !== "true") {
    throw new Error("synthetic_volume_label_mismatch");
  }
  return name;
}

function inspectContainer(dockerBinary, id, stage) {
  const result = docker(dockerBinary, ["inspect", id], `${stage}:inspect`, 10_000);
  try {
    return JSON.parse(result.stdout)[0];
  } catch {
    throw new Error(`${stage}:container_inspection_invalid`);
  }
}

function parseProbeReport(stdout) {
  const text = String(stdout ?? "").trim();
  const lines = text ? text.split(/\r?\n/).filter(Boolean) : [];
  if (lines.length !== 1) throw new Error("probe_report_shape_invalid");
  let report;
  try {
    report = JSON.parse(lines[0]);
  } catch {
    throw new Error("probe_report_json_invalid");
  }
  if (report.schema !== "duallane.runtime-permission/v1" || report.version !== 1) throw new Error("probe_report_version_invalid");
  if (!Number.isInteger(report.uid) || !Number.isInteger(report.gid)) throw new Error("probe_identity_invalid");
  for (const name of ["root", "canonical", "legacy"]) {
    if (!report[name] || typeof report[name].status !== "string") throw new Error("probe_check_missing");
  }
  if (report.secret !== undefined && (!report.secret || typeof report.secret.status !== "string")) throw new Error("probe_secret_check_invalid");
  return report;
}

function assertExpectedCase(fixture, report, exitCode) {
  if (report.uid !== 65532 || report.gid !== 65532) throw new Error(`${fixture.id}:probe_identity_mismatch`);
  if (exitCode !== fixture.expected.exitCode) throw new Error(`${fixture.id}:exit_code_mismatch`);
  const expectedTopStatus = fixture.expected.exitCode === 0 ? "passed" : "failed";
  if (report.status !== expectedTopStatus) throw new Error(`${fixture.id}:top_status_mismatch`);
  for (const name of ["root", "canonical", "legacy", "secret"]) {
    const expected = fixture.expected[name];
    if (!expected) continue;
    const actual = report[name]?.status;
    if (actual !== expected) throw new Error(`${fixture.id}:${name}_status_mismatch`);
  }
  for (const [name, expectedCode] of [["canonical", fixture.expected.canonicalErrorCode], ["legacy", fixture.expected.legacyErrorCode]]) {
    if (expectedCode && report[name]?.errorCode !== expectedCode) throw new Error(`${fixture.id}:${name}_error_code_mismatch`);
  }
}

function requireDockerImage(dockerBinary, image) {
  const result = docker(dockerBinary, ["image", "inspect", image], "image_inspect", 15_000);
  if (result.status !== 0) throw new Error("explicit_candidate_image_unavailable");
}

function docker(binary, args, stage, timeoutMs, allowedStatuses = [0]) {
  validateDockerArgumentBudget(args);
  let result;
  try {
    result = spawnSync(binary, args, {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch {
    throw new Error(`${stage}:docker_unavailable`);
  }
  if (result.error && result.error.code === "ETIMEDOUT") throw new Error(`${stage}:docker_timeout`);
  const status = result.status === null ? 125 : result.status;
  if (!allowedStatuses.includes(status)) {
    const detail = stage.endsWith(":init") ? summarizeSyntheticOutput(result) : "";
    throw new Error(`${stage}:docker_failed${detail ? `:${detail}` : ""}`);
  }
  return { status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

export function validateDockerArgumentBudget(args) {
  let totalBytes = 0;
  for (let index = 0; index < args.length; index += 1) {
    const value = String(args[index]);
    const valueBytes = Buffer.byteLength(value, "utf8");
    totalBytes += valueBytes + 1;
    if (args[index - 1] === "--env" && valueBytes > MAX_DOCKER_ENV_VALUE_BYTES) {
      throw new Error("docker_env_argument_too_large");
    }
  }
  if (totalBytes > MAX_DOCKER_ARGUMENT_BYTES) throw new Error("docker_arguments_too_large");
  return true;
}

function validateEnvironmentBudget(environment) {
  const args = [];
  for (const [key, value] of Object.entries(environment)) args.push("--env", `${key}=${value}`);
  return validateDockerArgumentBudget(args);
}

export function summarizeSyntheticOutput(result) {
  if (result?.status === 0) return "exit_zero";
  if (result?.status === 1) return "exit_one";
  return "exit_nonzero";
}

export function assertCleanupComplete(cleanup) {
  if (!cleanup || cleanup.status !== "passed") {
    const failures = Array.isArray(cleanup?.failures) && cleanup.failures.length > 0
      ? cleanup.failures.join(",")
      : "unknown";
    throw new Error(`cleanup_incomplete:${failures}`);
  }
  return true;
}

export function cleanupDockerResources(dockerBinary, runId, state, dockerRunner = docker) {
  const failures = [];
  const containers = { removed: 0, alreadyAbsent: 0 };
  const volumes = { removed: 0, alreadyAbsent: 0 };
  if (!state || !Array.isArray(state.containers) || !Array.isArray(state.volumes)) {
    return {
      status: "incomplete",
      failures: ["cleanup_state_invalid"],
      containers,
      volumes
    };
  }

  let owned;
  try {
    owned = dockerRunner(dockerBinary, [
      "ps", "-aq",
      "--filter", `label=${OWNER_LABEL_KEY}=${PROBE_OWNER}`,
      "--filter", `label=${RUN_LABEL_KEY}=${runId}`
    ], "cleanup_container_list", 10_000, [0]);
  } catch {
    failures.push("cleanup_container_list:failed");
  }
  if (!owned) {
    failures.push("cleanup_container_list:failed");
  } else if (owned.status !== 0) {
    failures.push("cleanup_container_list:failed");
  }
  const ids = owned?.status === 0 ? String(owned.stdout ?? "").trim().split(/\s+/).filter(Boolean) : [];
  for (const id of new Set([...state.containers, ...ids])) {
    let inspection;
    try {
      inspection = dockerRunner(dockerBinary, ["inspect", id], "cleanup_container_inspect", 10_000, [0, 1]);
    } catch {
      failures.push("cleanup_container_inspect:failed");
      continue;
    }
    if (inspection.status !== 0) {
      if (isKnownMissingDockerObject(inspection, "container")) {
        containers.alreadyAbsent += 1;
      } else {
        failures.push("cleanup_container_inspect:unknown");
      }
      continue;
    }
    const details = parseDockerInspection(inspection.stdout, "cleanup_container_inspect", failures);
    if (!details) continue;
    if (!hasExactSyntheticLabels(details.Config?.Labels, runId)) {
      failures.push("cleanup_container_label_mismatch");
      continue;
    }
    let removal;
    try {
      removal = dockerRunner(dockerBinary, ["rm", "-f", id], "cleanup_container_remove", 10_000, [0, 1]);
    } catch {
      failures.push("cleanup_container_remove:failed");
      continue;
    }
    if (removal?.status === 0) {
      containers.removed += 1;
    } else if (removal && isKnownMissingDockerObject(removal, "container")) {
      containers.alreadyAbsent += 1;
    } else {
      failures.push("cleanup_container_remove:failed");
    }
  }

  for (const name of new Set(state.volumes)) {
    let inspection;
    try {
      inspection = dockerRunner(dockerBinary, ["volume", "inspect", name], "cleanup_volume_inspect", 10_000, [0, 1]);
    } catch {
      failures.push("cleanup_volume_inspect:failed");
      continue;
    }
    if (inspection.status !== 0) {
      if (isKnownMissingDockerObject(inspection, "volume")) {
        volumes.alreadyAbsent += 1;
      } else {
        failures.push("cleanup_volume_inspect:unknown");
      }
      continue;
    }
    const details = parseDockerInspection(inspection.stdout, "cleanup_volume_inspect", failures);
    if (!details) continue;
    if (!hasExactSyntheticLabels(details.Labels, runId)) {
      failures.push("cleanup_volume_label_mismatch");
      continue;
    }
    let removal;
    try {
      removal = dockerRunner(dockerBinary, ["volume", "rm", name], "cleanup_volume_remove", 10_000, [0]);
    } catch {
      failures.push("cleanup_volume_remove:failed");
      continue;
    }
    if (removal?.status === 0) {
      volumes.removed += 1;
    } else {
      failures.push("cleanup_volume_remove:failed");
    }
  }

  return {
    status: failures.length === 0 ? "passed" : "incomplete",
    failures,
    containers,
    volumes
  };
}

function parseDockerInspection(stdout, stage, failures) {
  try {
    const parsed = JSON.parse(String(stdout ?? ""));
    if (!Array.isArray(parsed) || parsed.length !== 1 || !parsed[0] || typeof parsed[0] !== "object") {
      throw new Error("shape");
    }
    return parsed[0];
  } catch {
    failures.push(`${stage}:invalid`);
    return null;
  }
}

function hasExactSyntheticLabels(labels, runId) {
  return labels && labels[OWNER_LABEL_KEY] === PROBE_OWNER &&
    labels[RUN_LABEL_KEY] === runId && labels[SYNTHETIC_LABEL_KEY] === "true";
}

function isKnownMissingDockerObject(result, kind) {
  if (!result || result.status !== 1) return false;
  const message = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.toLowerCase();
  return message.includes("no such object") || message.includes(`no such ${kind}`) ||
    message.includes(`${kind} not found`) || message.includes(`${kind} does not exist`);
}

function traceMessage(enabled, message) {
  if (enabled) process.stderr.write(`[runtime-permissions] ${message}\n`);
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isMainModule() {
  return process.argv[1] && process.argv[1].endsWith("runtime-permissions.mjs");
}

if (isMainModule()) {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) {
      process.stdout.write("node scripts/backend/runtime-permissions.mjs --docker --image <explicit-candidate-image> --init-image <explicit-shell-helper-image> [--trace]\n");
      process.exitCode = 0;
    } else {
      const report = runRuntimePermissions(options);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      process.exitCode = report.status === "passed" ? 0 : 1;
    }
  } catch (error) {
    process.stderr.write(`runtime-permissions: ${error instanceof Error ? error.message : "failed"}\n`);
    process.exitCode = 1;
  }
}
