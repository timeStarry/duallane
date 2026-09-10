import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const deployPath = path.join(root, "deploy/production/deploy.sh");
const helperPath = path.join(root, "deploy/production/release-helper.sh");
const expectedCommit = "a".repeat(40);
const expectedImage = `sha256:${"a".repeat(64)}`;
const edgeP2PImage = `sha256:${"b".repeat(64)}`;
const edgeWebImage = `sha256:${"c".repeat(64)}`;
const workspaceImage = `sha256:${"d".repeat(64)}`;
const containerID = "e".repeat(64);

function extractFunction(source, name, nextName) {
  const startMarker = `${name}() {`;
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `${name} was not found`);
  const endMarker = `\n\n${nextName}() {`;
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `${name} end boundary was not found`);
  return source.slice(start, end);
}

function runBash(script, { env = {}, args = [], timeout = 10_000 } = {}) {
  return spawnSync(
    "bash",
    ["--noprofile", "--norc", "-euo", "pipefail", "-c", script, "release-activation-test", ...args],
    {
      cwd: root,
      encoding: "utf8",
      timeout,
      maxBuffer: 256 * 1024,
      windowsHide: true,
      env: { ...process.env, ...env },
    },
  );
}

async function withTempDirectory(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "duallane-release-activation-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function resultStatus(result, label) {
  assert.equal(result.error, undefined, `${label} did not start cleanly: ${result.error?.message ?? "unknown error"}`);
  assert.equal(result.status, 0, `${label} harness failed:\n${result.stderr}\n${result.stdout}`);
  const match = result.stdout.match(/^status=(\d+)$/m);
  assert.ok(match, `${label} did not report a bounded status:\n${result.stdout}`);
  return Number(match[1]);
}

function activationHarness(verifyContainerRelease, startReleaseService) {
  return [
    "set -Eeuo pipefail",
    "source \"$RELEASE_HELPER\"",
    verifyContainerRelease,
    startReleaseService,
    "umask 077",
    "trace() { printf '%s\\n' \"$*\" >> \"$TRACE\"; }",
    "RELEASE_PROFILE_NAME=go-full",
    "RELEASE_GO_UPGRADE=true",
    "RELEASE_GO_IMAGE_ID=$EXPECTED_IMAGE",
    "RELEASE_GO_P2P_IMAGE_ID=$EXPECTED_IMAGE",
    "RELEASE_GO_WEB_IMAGE_ID=$EXPECTED_IMAGE",
    "RELEASE_RECOVERY_FILE=$RECOVERY",
    "RELEASE_HEALTH_REQUIRED=(workspace)",
    "RELEASE_HEALTH_ATTEMPTS=1",
    "COMPOSE_PROJECT_NAME=duallane",
    "current_commit=$EXPECTED_COMMIT",
    "expected_app_version=0.16.0",
    "CONTAINER_ID=$CONTAINER_ID",
    "CONTAINER_IMAGE=$CONTAINER_IMAGE",
    "CONTAINER_REVISION=$CONTAINER_REVISION",
    "CONTAINER_VERSION=0.16.0",
    "OWNER_PROJECT=$OWNER_PROJECT",
    "OWNER_SERVICE=workspace",
    "CONTAINER_RUNNING=false",
    "CONTAINER_STATUS=created",
    "CONTAINER_HEALTH=none",
    "EXPECTED_NEW_OWNER=\$(printf 'go_upgrade_new_owner\\tworkspace\\t%s\\t%s\\t%s' \"$CONTAINER_ID\" \"$EXPECTED_IMAGE\" \"$current_commit\")",
    "compose() {",
    "  trace \"compose:$*\"",
    "  if [[ \"$1\" == config && \"$2\" == --services ]]; then",
    "    printf '%s\\n' workspace",
    "    return 0",
    "  fi",
    "  if [[ \"$1\" == ps && \"$2\" == -a && \"$3\" == -q && \"$4\" == workspace ]]; then",
    "    printf '%s\\n' \"$CONTAINER_ID\"",
    "    return 0",
    "  fi",
    "  if [[ \"$1\" == up ]]; then",
    "    [[ \"$2\" == --no-start && \"$3\" == --pull && \"$4\" == never && \"$5\" == --no-build && \"$6\" == --no-deps && \"$7\" == --force-recreate && \"$8\" == workspace ]] || return 70",
    "    return 0",
    "  fi",
    "  return 71",
    "}",
    "docker() {",
    "  trace \"docker:$*\"",
    "  if [[ \"$1\" == start ]]; then",
    "    if grep -Fxq \"$EXPECTED_NEW_OWNER\" \"$RELEASE_RECOVERY_FILE\"; then",
    "      trace start:recorded",
    "    else",
    "      trace start:missing-record",
    "    fi",
    "    [[ \"$MODE\" != start-failure ]] || return 75",
    "    CONTAINER_RUNNING=true",
    "    CONTAINER_STATUS=running",
    "    if [[ \"$MODE\" == health-failure ]]; then CONTAINER_HEALTH=unhealthy; else CONTAINER_HEALTH=healthy; fi",
    "    return 0",
    "  fi",
    "  [[ \"$1\" == inspect ]] || return 72",
    "  local format=\"$4\"",
    "  if [[ \"$format\" == \"{{.Id}}\" ]]; then printf '%s\\n' \"$CONTAINER_ID\"; return 0; fi",
    "  if [[ \"$format\" == \"{{.Image}}\" ]]; then printf '%s\\n' \"$CONTAINER_IMAGE\"; return 0; fi",
    "  if [[ \"$format\" == \"{{.State.Running}}\" ]]; then printf '%s\\n' \"$CONTAINER_RUNNING\"; return 0; fi",
    "  if [[ \"$format\" == \"{{.State.Status}}\" ]]; then printf '%s\\n' \"$CONTAINER_STATUS\"; return 0; fi",
    "  if [[ \"$format\" == \"{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}\" ]]; then printf '%s\\n' \"$CONTAINER_HEALTH\"; return 0; fi",
    "  if [[ \"$format\" == *com.docker.compose.project* ]]; then printf '%s\\n' \"$OWNER_PROJECT\"; return 0; fi",
    "  if [[ \"$format\" == *com.docker.compose.service* ]]; then printf '%s\\n' \"$OWNER_SERVICE\"; return 0; fi",
    "  if [[ \"$format\" == *org.opencontainers.image.revision* ]]; then printf '%s\\n' \"$CONTAINER_REVISION\"; return 0; fi",
    "  if [[ \"$format\" == *org.opencontainers.image.version* ]]; then printf '%s\\n' \"$CONTAINER_VERSION\"; return 0; fi",
    "  return 73",
    "}",
    "status=0",
    "if start_release_service workspace; then status=0; else status=$?; fi",
    "printf 'status=%s\\n' \"$status\"",
  ].join("\n");
}

async function runActivation(directory, mode, verifyContainerRelease, startReleaseService) {
  const tracePath = path.join(directory, `${mode}.trace`);
  const recoveryPath = path.join(directory, `${mode}.recovery`);
  await writeFile(recoveryPath, "", { mode: 0o600 });
  const result = runBash(activationHarness(verifyContainerRelease, startReleaseService), {
    env: {
      RELEASE_HELPER: helperPath,
      TRACE: tracePath,
      RECOVERY: recoveryPath,
      MODE: mode,
      EXPECTED_COMMIT: expectedCommit,
      EXPECTED_IMAGE: expectedImage,
      CONTAINER_ID: containerID,
      CONTAINER_IMAGE: mode === "wrong-image" ? `sha256:${"f".repeat(64)}` : expectedImage,
      CONTAINER_REVISION: mode === "wrong-revision" ? "b".repeat(40) : expectedCommit,
      OWNER_PROJECT: mode === "wrong-owner" ? "foreign-project" : "duallane",
    },
  });
  const trace = (await readFile(tracePath, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
  const recovery = await readFile(recoveryPath, "utf8");
  return { result, trace, recovery };
}

function edgeHarness() {
  return [
    "set -Eeuo pipefail",
    "source \"$RELEASE_HELPER\"",
    "umask 077",
    "trace() { printf '%s\\n' \"$*\" >> \"$TRACE\"; }",
    "RELEASE_PROFILE_NAME=go-full",
    "RELEASE_RECOVERY_FILE=$RECOVERY",
    "current_commit=$EXPECTED_COMMIT",
    "expected_app_version=0.16.0",
    "RELEASE_GO_IMAGE_ID=$WORKSPACE_IMAGE",
    "P2P_REF=synthetic/p2p:tag",
    "WEB_REF=synthetic/web:tag",
    "compose() {",
    "  trace \"compose:$*\"",
    "  if [[ \"$1\" == config && \"$2\" == --format && \"$3\" == json ]]; then",
    "    printf '%s\\n' '{\"services\":{\"p2p\":{\"image\":\"synthetic/p2p:tag\"},\"web\":{\"image\":\"synthetic/web:tag\"}}}'",
    "    return 0",
    "  fi",
    "  return 1",
    "}",
    "docker() {",
    "  trace \"docker:$*\"",
    "  [[ \"$1\" == image && \"$2\" == inspect ]] || return 1",
    "  local target=\"$3\" format=\"$5\"",
    "  if [[ \"$format\" == \"{{.Id}}\" ]]; then",
    "    if [[ \"$MODE\" == id-invalid && \"$target\" == \"$P2P_REF\" ]]; then printf '%s\\n' not-an-image; else if [[ \"$target\" == \"$P2P_REF\" ]]; then printf '%s\\n' \"$P2P_IMAGE\"; else printf '%s\\n' \"$WEB_IMAGE\"; fi; fi",
    "    return 0",
    "  fi",
    "  if [[ \"$format\" == *org.opencontainers.image.revision* ]]; then",
    "    if [[ \"$MODE\" == metadata-failure ]]; then printf '%s\\n' \"${WRONG_COMMIT}\"; else printf '%s\\n' \"$EXPECTED_COMMIT\"; fi",
    "    return 0",
    "  fi",
    "  if [[ \"$format\" == *org.opencontainers.image.version* ]]; then",
    "    if [[ \"$MODE\" == metadata-failure ]]; then printf '%s\\n' 0.15.9; else printf '%s\\n' 0.16.0; fi",
    "    return 0",
    "  fi",
    "  return 1",
    "}",
    "status=0",
    "if release_verify_go_edge_images; then status=0; else status=$?; fi",
    "if [[ \"$status\" == 0 ]]; then",
    "  for service in p2p web workspace worker migrate; do",
    "    release_expected_go_service_image_id \"$service\"",
    "    printf 'expected:%s=%s\\n' \"$service\" \"$REPLY\"",
    "  done",
    "fi",
    "printf 'status=%s\\n' \"$status\"",
  ].join("\n");
}

async function runEdge(directory, mode) {
  const tracePath = path.join(directory, `${mode}.edge.trace`);
  const recoveryPath = path.join(directory, `${mode}.edge.recovery`);
  await writeFile(recoveryPath, "", { mode: 0o600 });
  const result = runBash(edgeHarness(), {
    env: {
      RELEASE_HELPER: helperPath,
      TRACE: tracePath,
      RECOVERY: recoveryPath,
      MODE: mode,
      EXPECTED_COMMIT: expectedCommit,
      WRONG_COMMIT: "f".repeat(40),
      P2P_IMAGE: edgeP2PImage,
      WEB_IMAGE: edgeWebImage,
      WORKSPACE_IMAGE: workspaceImage,
    },
  });
  const trace = (await readFile(tracePath, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
  const recovery = await readFile(recoveryPath, "utf8");
  return { result, trace, recovery };
}

function runVersion(candidate, current) {
  const script = [
    "set -Eeuo pipefail",
    "source \"$RELEASE_HELPER\"",
    "if version_is_greater \"$1\" \"$2\"; then printf 'greater\\n'; else printf 'not-greater\\n'; fi",
  ].join("\n");
  return runBash(script, {
    args: [candidate, current],
    env: { RELEASE_HELPER: helperPath },
  });
}

async function runSchema(directory, verified) {
  const projectPath = path.join(directory, "project");
  const migrationPath = path.join(projectPath, "apps/web/server/migrations");
  await mkdir(migrationPath, { recursive: true });
  await writeFile(path.join(migrationPath, "001_initial.sql"), "-- synthetic\n");
  await writeFile(path.join(migrationPath, "007_workspace.sql"), "-- synthetic\n");
  const script = [
    "set -Eeuo pipefail",
    "source \"$RELEASE_HELPER\"",
    "PROJECT_DIR=$PROJECT",
    "RELEASE_GO_MIGRATION_VERIFIED=$VERIFIED",
    "DUALLANE_SCHEMA_VERSION=999999",
    "schema=",
    "status=0",
    "if schema=$(release_current_schema_version); then status=0; else status=$?; fi",
    "printf 'status=%s schema=%s\\n' \"$status\" \"$schema\"",
  ].join("\n");
  return runBash(script, {
    env: {
      RELEASE_HELPER: helperPath,
      PROJECT: projectPath,
      VERIFIED: verified ? "true" : "false",
    },
  });
}

function gatewaySmokeHarness() {
  return [
    "set -Eeuo pipefail",
    "source \"$RELEASE_HELPER\"",
    "umask 077",
    "trace() { printf '%s\\n' \"$*\" >> \"$TRACE\"; }",
    "RELEASE_PROFILE_NAME=go-full",
    "RELEASE_RECOVERY_FILE=$RECOVERY",
    "COMPOSE_PROJECT_NAME=duallane",
    "WEB_ID=1111111111111111111111111111111111111111111111111111111111111111",
    "OBSERVED_VERSION=0.16.0",
    "OBSERVED_COMMIT=$OBSERVED_COMMIT_VALUE",
    "compose() {",
    "  trace \"compose:$*\"",
    "  if [[ \"$1\" == config && \"$2\" == --services ]]; then printf '%s\\n' web; return 0; fi",
    "  if [[ \"$1\" == ps && \"$2\" == -a && \"$3\" == -q && \"$4\" == web ]]; then printf '%s\\n' \"$WEB_ID\"; return 0; fi",
    "  return 1",
    "}",
    "docker() {",
    "  trace \"docker:$*\"",
    "  [[ \"$1\" == inspect ]] || return 1",
    "  local format=\"$4\"",
    "  if [[ \"$format\" == *com.docker.compose.project* ]]; then printf '%s\\n' duallane; return 0; fi",
    "  if [[ \"$format\" == *com.docker.compose.service* ]]; then printf '%s\\n' web; return 0; fi",
    "  if [[ \"$format\" == *org.opencontainers.image.version* ]]; then printf '%s\\n' \"$OBSERVED_VERSION\"; return 0; fi",
    "  if [[ \"$format\" == *org.opencontainers.image.revision* ]]; then printf '%s\\n' \"$OBSERVED_COMMIT\"; return 0; fi",
    "  if [[ \"$format\" == \"{{json .NetworkSettings.Ports}}\" ]]; then",
    "    if [[ \"$MODE\" == unsupported-bind ]]; then printf '%s\\n' '{\"8080/tcp\":[{\"HostIp\":\"10.0.0.9\",\"HostPort\":\"8787\"}]}'" ,
    "    else printf '%s\\n' '{\"8080/tcp\":[{\"HostIp\":\"127.0.0.1\",\"HostPort\":\"18787\"}]}'" ,
    "    fi",
    "    return 0",
    "  fi",
    "  return 1",
    "}",
    "status=0",
    "if release_run_gateway_smoke go-full \"$EXPECTED_VERSION\" \"$EXPECTED_COMMIT\"; then status=0; else status=$?; fi",
    "printf 'status=%s\\n' \"$status\"",
  ].join("\n");
}

async function runGatewaySmoke(directory, mode) {
  const tracePath = path.join(directory, `${mode}.gateway.trace`);
  const recoveryPath = path.join(directory, `${mode}.gateway.recovery`);
  const fakeNodePath = path.join(directory, "node");
  await writeFile(recoveryPath, "", { mode: 0o600 });
  await writeFile(fakeNodePath, [
    "#!/usr/bin/env bash",
    "if [[ \"$1\" == -e ]]; then exec \"$REAL_NODE\" \"$@\"; fi",
    "printf '%s\\n' smoke-invoked >> \"$TRACE\"",
    "printf 'smoke-args:%s\\n' \"$*\" >> \"$TRACE\"",
    "if [[ \"$MODE\" == success ]]; then exit 0; fi",
    "exit 99",
    "",
  ].join("\n"), { mode: 0o700 });
  const result = runBash(gatewaySmokeHarness(), {
    env: {
      PATH: `${directory}${path.delimiter}${process.env.PATH ?? ""}`,
      RELEASE_HELPER: helperPath,
      TRACE: tracePath,
      RECOVERY: recoveryPath,
      MODE: mode,
      REAL_NODE: process.execPath,
      EXPECTED_VERSION: mode === "old-version" ? "0.15.9" : "0.16.0",
      EXPECTED_COMMIT: mode === "wrong-revision" ? "b".repeat(40) : expectedCommit,
      OBSERVED_COMMIT_VALUE: expectedCommit,
    },
  });
  const trace = (await readFile(tracePath, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
  return { result, trace };
}

test("Go activation creates without pull/build, verifies ownership, and records the new owner before start", async () => {
  const deploySource = await readFile(deployPath, "utf8");
  const verifyContainerRelease = extractFunction(deploySource, "verify_container_release", "wait_for_candidate");
  const startReleaseService = extractFunction(deploySource, "start_release_service", "stop_legacy_services_for_go");
  assert.match(startReleaseService, /compose up --no-start --pull never --no-build --no-deps/);
  assert.match(startReleaseService, /release_go_upgrade_record_new_owner \"\$\{service\}\" \"\$\{id\}\" \|\| return 1/);

  await withTempDirectory(async (directory) => {
    const successful = await runActivation(directory, "success", verifyContainerRelease, startReleaseService);
    const successStatus = resultStatus(successful.result, "successful activation");
    assert.equal(successStatus, 0);
    const createIndex = successful.trace.indexOf("compose:up --no-start --pull never --no-build --no-deps --force-recreate workspace");
    const startIndex = successful.trace.findIndex((line) => line.startsWith("docker:start "));
    assert.ok(createIndex >= 0, `create flags were not recorded: ${successful.trace.join(" | ")}`);
    assert.ok(startIndex > createIndex, `start did not follow create: ${successful.trace.join(" | ")}`);
    assert.ok(successful.trace.includes("start:recorded"), `start did not observe a durable owner record: ${successful.trace.join(" | ")} recovery=${successful.recovery}`);
    assert.match(successful.recovery, new RegExp(`^go_upgrade_new_owner\\tworkspace\\t${containerID}\\t${expectedImage}\\t${expectedCommit}$`, "m"));

    for (const mode of ["wrong-image", "wrong-revision", "wrong-owner"]) {
      const refused = await runActivation(directory, mode, verifyContainerRelease, startReleaseService);
      const refusedStatus = resultStatus(refused.result, `${mode} activation`);
      assert.notEqual(refusedStatus, 0, `${mode} unexpectedly passed`);
      assert.equal(refused.trace.some((line) => line.startsWith("docker:start ")), false, `${mode} started a container`);
    }

    for (const mode of ["start-failure", "health-failure"]) {
      const failed = await runActivation(directory, mode, verifyContainerRelease, startReleaseService);
      const failedStatus = resultStatus(failed.result, `${mode} activation`);
      assert.notEqual(failedStatus, 0, `${mode} unexpectedly passed`);
      assert.ok(failed.trace.includes("start:recorded"), `${mode} started before recording its owner`);
      assert.match(failed.recovery, new RegExp(`^go_upgrade_new_owner\\tworkspace\\t${containerID}\\t${expectedImage}\\t${expectedCommit}$`, "m"));
    }
  });
});

test("Go edge verification records exact image IDs and reads release metadata by ID", async () => {
  await withTempDirectory(async (directory) => {
    const successful = await runEdge(directory, "tag-only-metadata");
    const status = resultStatus(successful.result, "edge identity verification");
    assert.equal(status, 0);
    const metadataInspects = successful.trace.filter((line) => line.includes("org.opencontainers.image."));
    assert.equal(metadataInspects.length, 4, `unexpected metadata inspect trace: ${metadataInspects.join(" | ")}`);
    assert.ok(metadataInspects.every((line) => line.includes(edgeP2PImage) || line.includes(edgeWebImage)),
      `metadata was not inspected by immutable ID: ${metadataInspects.join(" | ")}`);
    assert.match(successful.recovery, new RegExp(`^go_p2p_image_id=${edgeP2PImage}$`, "m"));
    assert.match(successful.recovery, new RegExp(`^go_web_image_id=${edgeWebImage}$`, "m"));
    assert.doesNotMatch(successful.recovery, /synthetic\/(?:p2p|web):tag/);
    assert.match(successful.result.stdout, new RegExp(`^expected:p2p=${edgeP2PImage}$`, "m"));
    assert.match(successful.result.stdout, new RegExp(`^expected:web=${edgeWebImage}$`, "m"));
    assert.match(successful.result.stdout, new RegExp(`^expected:workspace=${workspaceImage}$`, "m"));
    assert.match(successful.result.stdout, new RegExp(`^expected:worker=${workspaceImage}$`, "m"));
    assert.match(successful.result.stdout, new RegExp(`^expected:migrate=${workspaceImage}$`, "m"));

    const invalidID = await runEdge(directory, "id-invalid");
    assert.notEqual(resultStatus(invalidID.result, "invalid edge identity verification"), 0);

    const wrongMetadata = await runEdge(directory, "metadata-failure");
    assert.notEqual(resultStatus(wrongMetadata.result, "wrong edge metadata verification"), 0);
  });
});

test("version_is_greater accepts only strict numeric three-component versions", () => {
  const cases = [
    ["1.2.4", "1.2.3", "greater"],
    ["10.0.0", "2.99.99", "greater"],
    ["999999999999999999999999.0.0", "10.0.0", "greater"],
    ["1.2.3", "1.2.3", "not-greater"],
    ["1.2.2", "1.2.3", "not-greater"],
    ["1.2", "1.1.0", "not-greater"],
    ["1.2.3.4", "1.2.3", "not-greater"],
    ["v1.2.3", "1.2.2", "not-greater"],
    ["1.2.x", "1.2.2", "not-greater"],
  ];
  for (const [candidate, current, expected] of cases) {
    const result = runVersion(candidate, current);
    assert.equal(result.error, undefined, `${candidate}/${current} did not start cleanly`);
    assert.equal(result.status, 0, `${candidate}/${current} harness failed: ${result.stderr}`);
    assert.equal(result.stdout.trim(), expected, `${candidate}/${current} comparison mismatch`);
  }
});

test("schema snapshot version requires verified migration and ignores DUALLANE_SCHEMA_VERSION", async () => {
  await withTempDirectory(async (directory) => {
    const unverified = await runSchema(directory, false);
    assert.equal(unverified.error, undefined);
    assert.equal(unverified.status, 0, `${unverified.stderr}\n${unverified.stdout}`);
    assert.equal(unverified.stdout.trim(), "status=1 schema=");

    const verified = await runSchema(directory, true);
    assert.equal(verified.error, undefined);
    assert.equal(verified.status, 0, `${verified.stderr}\n${verified.stdout}`);
    assert.equal(verified.stdout.trim(), "status=0 schema=7");
  });
});

test("gateway smoke rejects stale metadata and unsupported published bindings before invoking HTTP", async () => {
  await withTempDirectory(async (directory) => {
    for (const mode of ["old-version", "wrong-revision", "unsupported-bind"]) {
      const refused = await runGatewaySmoke(directory, mode);
      assert.notEqual(resultStatus(refused.result, `${mode} gateway smoke`), 0, `${mode} unexpectedly passed`);
      assert.equal(refused.trace.includes("smoke-invoked"), false, `${mode} invoked the HTTP smoke CLI`);
    }
  });
});

test("gateway smoke uses the published mapping of the checked-in Nginx port", async () => {
  for (const file of ["deploy/candidate/Dockerfile.web"]) {
    assert.match(await readFile(path.join(root, file), "utf8"), /^EXPOSE 8080$/m);
  }
  await withTempDirectory(async (directory) => {
    const accepted = await runGatewaySmoke(directory, "success");
    assert.equal(resultStatus(accepted.result, "gateway public binding"), 0);
    assert.ok(accepted.trace.includes("smoke-invoked"));
    assert.ok(accepted.trace.some((line) => line.includes("--base-url http://127.0.0.1:18787 --expected-version 0.16.0")));
  });
});

test("whole-backend activation checks drain after fencing and never starts on a failed gate", async () => {
  const source = await readFile(deployPath, "utf8");
  const activate = extractFunction(source, "start_release_backend", "start_release_edge");
  for (const upgrade of ["true", "false"]) {
    for (const blocked of ["true", "false"]) {
      const result = runBash([
        "source \"$RELEASE_HELPER\"",
        activate,
        "RELEASE_PROFILE_NAME=go-full",
        "RELEASE_BACKEND_SERVICES=(p2p workspace)",
        "RELEASE_WORKER_SERVICES=(worker)",
        "release_snapshot_validate_for_go_cutover() { echo snapshot; }",
        "release_go_upgrade_fence_old_services() { echo fence-go; }",
        "stop_legacy_services_for_go() { echo fence-node; }",
        "release_require_drained_runtime() { echo drain; [[ $BLOCKED == false ]]; }",
        "start_release_service() { echo start-$1; }",
        "if start_release_backend; then echo result-ready; else echo result-blocked; fi",
      ].join("\n"), { env: { RELEASE_HELPER: helperPath, RELEASE_GO_UPGRADE: upgrade, BLOCKED: blocked } });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.stdout.trim().split("\n"), [
        "snapshot", upgrade === "true" ? "fence-go" : "fence-node", "drain",
        ...(blocked === "true" ? ["result-blocked"] : ["start-p2p", "start-workspace", "start-worker", "result-ready"]),
      ]);
    }
  }
});

test("Go rollback retries fence every recreated owner even after only a partial activation", async () => {
  for (const blocked of ["true", "false"]) {
    await withTempDirectory(async directory => {
      const recovery = path.join(directory, "recovery");
      await writeFile(recovery, "go_upgrade_old_owners_fenced=true\n", { mode: 0o600 });
      const result = runBash([
        "source \"$RELEASE_HELPER\"",
        "RELEASE_PROFILE_NAME=go-full; RELEASE_GO_UPGRADE=true; RELEASE_GO_UPGRADE_VALIDATED=true",
        "RELEASE_GO_UPGRADE_OLD_COMPOSE_FILE=synthetic; RELEASE_RECOVERY_FILE=$RECOVERY",
        "RELEASE_GO_UPGRADE_OLD_COMMIT=old-commit; RELEASE_GO_UPGRADE_NEW_ATTEMPTED_SERVICES=(p2p workspace)",
        "declare -A fenced=()",
        "release_go_upgrade_previous_owner_record() { REPLY=\"$1-old\"$'\timage\told-commit'; }",
        "release_current_service_ids() { echo $1-recreated; }",
        "release_go_upgrade_is_recreated_old_owner() { return 0; }",
        "release_go_upgrade_fence_phase_and_confirm() { fenced[$2]=true; echo fence-$2; }",
        "release_require_drained_runtime() { local service; for service in p2p workspace worker web; do [[ ${fenced[$service]:-false} == true ]] || return 1; done; echo drain-$1; [[ $BLOCKED == false ]]; }",
        "release_go_upgrade_restore_old_service() { echo restore-$1; }",
        "release_run_previous_gateway_smoke() { echo smoke-old; }",
        "if release_go_upgrade_rollback_application; then echo result-ready; else echo result-blocked; fi",
      ].join("\n"), { env: { RELEASE_HELPER: helperPath, RECOVERY: recovery, BLOCKED: blocked } });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.stdout.trim().split("\n"), [
        "fence-p2p", "fence-workspace", "fence-worker", "fence-web", "drain-recovery",
        ...(blocked === "true" ? ["result-blocked"] : ["restore-p2p", "restore-workspace", "restore-worker", "restore-web", "smoke-old", "result-ready"]),
      ]);
    });
  }
});

test("Node rollback keeps failed Go owners stopped when the fresh drain is blocked", async () => {
  await withTempDirectory(async directory => {
    const snapshot = path.join(directory, "snapshot");
    await writeFile(snapshot, "", { mode: 0o600 });
    const result = runBash([
      "source \"$RELEASE_HELPER\"",
      "RELEASE_PROFILE_NAME=go-full; RELEASE_SNAPSHOT_FILE=$SNAPSHOT",
      "RELEASE_GO_SERVICES=(p2p workspace worker); RELEASE_ROLLBACK_ORDER=(api web)",
      "release_stop_service_and_confirm() { echo fence-$1; }",
      "release_require_drained_runtime() { echo drain-$1; return 1; }",
      "release_restore_snapshot_service() { echo forbidden-restore; }",
      "release_retag_snapshot_images() { echo forbidden-tag; }",
      "if release_rollback_application; then echo result-ready; else echo result-blocked; fi",
    ].join("\n"), { env: { RELEASE_HELPER: helperPath, SNAPSHOT: snapshot } });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split("\n"), ["fence-p2p", "fence-workspace", "fence-worker", "fence-api", "drain-recovery", "result-blocked"]);
  });
});

test("Node recovery freezes resolved configuration and immutable API/Web images before build", async () => {
  await withTempDirectory(async directory => {
    const raw = path.join(directory, "node.json");
    const snapshot = path.join(directory, "snapshot");
    const recovery = path.join(directory, "recovery");
    const nodeImage = `sha256:${"1".repeat(64)}`;
    const webImage = `sha256:${"2".repeat(64)}`;
    await writeFile(raw, JSON.stringify({
      name: "synthetic-node-recovery",
      services: {
        api: { image: "mutable-api", build: { context: "." }, environment: { SYNTHETIC: "original$$literal" } },
        web: { image: "mutable-web", build: { context: "." } },
      },
    }), { mode: 0o600 });
    await writeFile(snapshot, [
      ["api", "a".repeat(64), nodeImage, "mutable-api", "true", "running", "healthy"].join("\t"),
      ["web", "b".repeat(64), webImage, "mutable-web", "true", "running", "healthy"].join("\t"),
      "",
    ].join("\n"), { mode: 0o600 });
    const result = runBash([
      "source \"$RELEASE_HELPER\"",
      "RELEASE_PROFILE_NAME=go-full; RELEASE_SNAPSHOT_FILE=$SNAPSHOT; RELEASE_RECOVERY_FILE=$RECOVERY",
      "release_rollback_compose() { command cat \"$RAW\"; }",
      "release_freeze_node_recovery_compose",
    ].join("\n"), { env: {
      RELEASE_HELPER: helperPath, RAW: raw, SNAPSHOT: snapshot, RECOVERY: recovery,
      COMPOSE_PROJECT_NAME: "synthetic-node-recovery",
    } });
    assert.equal(result.status, 0, result.stderr);
    const frozen = JSON.parse(await readFile(`${recovery}.node-recovery.compose.json`, "utf8"));
    assert.equal(frozen.services.api.image, nodeImage);
    assert.equal(frozen.services.web.image, webImage);
    assert.equal(frozen.services.api.build, undefined);
    assert.equal(frozen.services.web.build, undefined);
    assert.equal(frozen.services.api.pull_policy, "never");
    assert.equal(frozen.services.api.environment.SYNTHETIC, "original$$literal");
    const external = JSON.parse(await readFile(`${recovery}.node-recovery.compose.json.external.json`, "utf8"));
    assert.deepEqual(external.services, ["api", "web"]);
  });
});

test("project ownership is taken from resolved Compose, not the checkout directory name", () => {
  const result = runBash([
    "source \"$RELEASE_HELPER\"",
    "PROJECT_DIR=/synthetic/wrong-project",
    "compose() { printf '%s\\n' '{\"name\":\"canonical-project\"}'; }",
    "release_pin_compose_project",
    "release_compose_project_name",
  ].join("\n"), { env: { RELEASE_HELPER: helperPath } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "canonical-project");
});
