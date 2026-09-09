import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const helperPath = path.join(root, "deploy/production/release-helper.sh");
const expectedImage = `sha256:${"a".repeat(64)}`;
const expectedRun = "b".repeat(64);
const ownerID = "c".repeat(64);
const replacementID = "d".repeat(64);
const secondID = "e".repeat(64);
const expectedCommit = "f".repeat(40);

function runBash(script, { env = {}, args = [], timeout = 10_000 } = {}) {
  return spawnSync(
    "bash",
    ["--noprofile", "--norc", "-euo", "pipefail", "-c", script, "release-cleanup-test", ...args],
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
  const directory = await mkdtemp(path.join(os.tmpdir(), "duallane-release-cleanup-"));
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
  assert.ok(match, `${label} did not report a bounded status:\n${result.stdout}\n${result.stderr}`);
  return Number(match[1]);
}

function cleanupHarness() {
  return [
    "set -Eeuo pipefail",
    "source \"$RELEASE_HELPER\"",
    "umask 077",
    "trace() { printf '%s\\n' \"$*\" >> \"$TRACE\"; }",
    "RELEASE_PROFILE_NAME=go-full",
    "RELEASE_RECOVERY_FILE=$RECOVERY",
    "RELEASE_GO_RUN_ID=$EXPECTED_RUN",
    "RELEASE_GO_IMAGE_ID=$EXPECTED_IMAGE",
    "RELEASE_GO_P2P_IMAGE_ID=$EXPECTED_IMAGE",
    "RELEASE_GO_WEB_IMAGE_ID=$EXPECTED_IMAGE",
    "COMPOSE_PROJECT_NAME=duallane",
    "CURRENT_IDS=$OWNER_ID",
    "ACTUAL_PROJECT=duallane",
    "ACTUAL_SERVICE=workspace",
    "ACTUAL_IMAGE=$EXPECTED_IMAGE",
    "ACTUAL_RUN=$EXPECTED_RUN",
    "ACTUAL_RESTART=no",
    "ACTUAL_RUNNING=false",
    "DELETED=",
    "compose() {",
    "  trace \"compose:$*\"",
    "  if [[ \"$1\" == config && \"$2\" == --services ]]; then",
    "    printf '%s\\n' workspace",
    "    return 0",
    "  fi",
    "  if [[ \"$1\" == ps && \"$2\" == -a && \"$3\" == -q && \"$4\" == workspace ]]; then",
    "    printf '%s\\n' \"$CURRENT_IDS\"",
    "    return 0",
    "  fi",
    "  return 71",
    "}",
    "docker() {",
    "  trace \"docker:$*\"",
    "  if [[ \"$1\" == rm ]]; then",
    "    [[ \"$2\" != -f ]] || return 80",
    "    [[ \"$2\" == \"$OWNER_ID\" ]] || return 81",
    "    DELETED=$2",
    "    if [[ \"$MODE\" == postdelete-race ]]; then CURRENT_IDS=$REPLACEMENT_ID; else CURRENT_IDS=; fi",
    "    return 0",
    "  fi",
    "  [[ \"$1\" == inspect ]] || return 82",
    "  local target=\"$2\" format=\"$4\"",
    "  [[ \"$target\" == \"$OWNER_ID\" ]] || return 83",
    "  case \"$format\" in",
    "    '{{.Id}}') printf '%s\\n' \"$OWNER_ID\" ;;",
    "    '{{.Image}}') printf '%s\\n' \"$ACTUAL_IMAGE\" ;;",
    "    '{{.State.Running}}') printf '%s\\n' \"$ACTUAL_RUNNING\" ;;",
    "    '{{.HostConfig.RestartPolicy.Name}}') printf '%s\\n' \"$ACTUAL_RESTART\" ;;",
    "    '{{.HostConfig.RestartPolicy.MaximumRetryCount}}') printf '0\\n' ;;",
    "    *com.duallane.release-run*) printf '%s\\n' \"$ACTUAL_RUN\" ;;",
    "    *com.docker.compose.project*) printf '%s\\n' \"$ACTUAL_PROJECT\" ;;",
    "    *com.docker.compose.service*) printf '%s\\n' \"$ACTUAL_SERVICE\" ;;",
    "    *) return 84 ;;",
    "  esac",
    "}",
    "case \"$MODE\" in",
    "  foreign-run) ACTUAL_RUN=foreign-run ;;",
    "  foreign-image) ACTUAL_IMAGE=sha256:$(printf '9%.0s' {1..64}) ;;",
    "  foreign-project) ACTUAL_PROJECT=foreign-project ;;",
    "  missing-fence) : >\"$RECOVERY\"; printf 'fence_complete\\tworkspace\\n' >>\"$RECOVERY\" ;;",
    "  running) ACTUAL_RUNNING=true ;;",
    "  restart-always) ACTUAL_RESTART=always ;;",
    "  multiple-ids) CURRENT_IDS=\"$OWNER_ID\"$'\\n'\"$SECOND_ID\" ;;",
    "esac",
    "status=0",
    "if release_remove_service_if_present workspace; then status=0; else status=$?; fi",
    "printf 'status=%s\\n' \"$status\"",
    "printf 'deleted=%s\\n' \"$DELETED\"",
    "printf 'current=%s\\n' \"$CURRENT_IDS\"",
  ].join("\n");
}

async function runCleanup(directory, mode) {
  const tracePath = path.join(directory, `${mode}.trace`);
  const recoveryPath = path.join(directory, `${mode}.recovery`);
  await writeFile(
    recoveryPath,
    `fence_target\tworkspace\t${ownerID}\talways\t0\ttrue\nfence_complete\tworkspace\n`,
    { mode: 0o600 },
  );
  const result = runBash(cleanupHarness(), {
    env: {
      RELEASE_HELPER: helperPath,
      TRACE: tracePath,
      RECOVERY: recoveryPath,
      MODE: mode,
      EXPECTED_RUN: expectedRun,
      EXPECTED_IMAGE: expectedImage,
      OWNER_ID: ownerID,
      REPLACEMENT_ID: replacementID,
      SECOND_ID: secondID,
    },
  });
  const trace = (await readFile(tracePath, "utf8").catch(() => ""))
    .trim()
    .split("\n")
    .filter(Boolean);
  return { result, trace };
}

function restoreHarness() {
  return [
    "set -Eeuo pipefail",
    "source \"$RELEASE_HELPER\"",
    "umask 077",
    "trace() { printf '%s\\n' \"$*\" >> \"$TRACE\"; }",
    "RELEASE_PROFILE_NAME=go-full",
    "RELEASE_RECOVERY_FILE=$RECOVERY",
    "RELEASE_SNAPSHOT_FILE=$SNAPSHOT",
    "RELEASE_PREVIOUS_NODE_COMMIT=$EXPECTED_COMMIT",
    "RELEASE_PREVIOUS_NODE_VERSION=0.15.1",
    "COMPOSE_PROJECT_NAME=duallane",
    "CURRENT_ID=$OWNER_ID",
    "AUTHORITY_COUNT=0",
    "STARTED=false",
    "release_verify_activation_authority() {",
    "  AUTHORITY_COUNT=$((AUTHORITY_COUNT + 1))",
    "  trace \"authority:$AUTHORITY_COUNT\"",
    "  [[ \"$AUTHORITY_FAILURE\" != \"$AUTHORITY_COUNT\" ]]",
    "}",
    "release_rollback_compose() {",
    "  if [[ \"$1\" == up ]]; then",
    "    [[ \"$*\" == 'up --no-start --pull never --no-build --no-deps --force-recreate api' ]] || return 70",
    "    trace create",
    "    return 0",
    "  fi",
    "  return 71",
    "}",
    "release_rollback_service_ids() {",
    "  trace ids",
    "  printf '%s\\n' \"$CURRENT_ID\"",
    "}",
    "release_verify_fence_owner() { trace owner; }",
    "release_record_replacement() { trace record; }",
    "release_wait_container_ready() { trace ready; }",
    "release_restore_fenced_policy_on_container() { trace policy; }",
    "docker() {",
    "  trace \"docker:$*\"",
    "  if [[ \"$1\" == start ]]; then",
    "    STARTED=true",
    "    return 0",
    "  fi",
    "  [[ \"$1\" == inspect && \"$2\" == \"$OWNER_ID\" ]] || return 80",
    "  local format=\"$4\"",
    "  case \"$format\" in",
    "    '{{.Image}}') printf '%s\\n' \"$EXPECTED_IMAGE\" ;;",
    "    *org.opencontainers.image.revision*) printf '%s\\n' \"$EXPECTED_COMMIT\" ;;",
    "    *org.opencontainers.image.version*) printf '0.15.1\\n' ;;",
    "    '{{.State.Running}}') printf '%s\\n' \"$STARTED\" ;;",
    "    *) return 81 ;;",
    "  esac",
    "}",
    "status=0",
    "if release_restore_pinned_node_service api; then status=0; else status=$?; fi",
    "printf 'status=%s\\n' \"$status\"",
    "printf 'started=%s\\n' \"$STARTED\"",
  ].join("\n");
}

async function runRestore(directory, authorityFailure = "none") {
  const tracePath = path.join(directory, `restore-${authorityFailure}.trace`);
  const recoveryPath = path.join(directory, `restore-${authorityFailure}.recovery`);
  const snapshotPath = path.join(directory, `restore-${authorityFailure}.snapshot`);
  await writeFile(recoveryPath, "", { mode: 0o600 });
  await writeFile(
    snapshotPath,
    `api\t${ownerID}\t${expectedImage}\tduallane/api:old\ttrue\trunning\thealthy\n`,
    { mode: 0o600 },
  );
  const result = runBash(restoreHarness(), {
    env: {
      RELEASE_HELPER: helperPath,
      TRACE: tracePath,
      RECOVERY: recoveryPath,
      SNAPSHOT: snapshotPath,
      AUTHORITY_FAILURE: authorityFailure,
      EXPECTED_COMMIT: expectedCommit,
      EXPECTED_IMAGE: expectedImage,
      OWNER_ID: ownerID,
    },
  });
  const trace = (await readFile(tracePath, "utf8").catch(() => ""))
    .trim()
    .split("\n")
    .filter(Boolean);
  return { result, trace };
}

test("release cleanup removes only an exact stopped owned Go container", async () => {
  await withTempDirectory(async (directory) => {
    const success = await runCleanup(directory, "success");
    assert.equal(resultStatus(success.result, "owned cleanup"), 0, success.result.stderr);
    assert.deepEqual(success.trace.filter((entry) => entry.startsWith("docker:rm")), [`docker:rm ${ownerID}`]);
    assert.equal(success.trace.some((entry) => entry.includes("docker:rm -f")), false);
    assert.match(success.result.stdout, new RegExp(`^deleted=${ownerID}$`, "m"));

    for (const mode of [
      "foreign-run",
      "foreign-image",
      "foreign-project",
      "missing-fence",
      "running",
      "restart-always",
      "multiple-ids",
    ]) {
      const rejected = await runCleanup(directory, mode);
      assert.notEqual(resultStatus(rejected.result, `${mode} cleanup`), 0, `${mode} unexpectedly succeeded`);
      assert.equal(rejected.trace.some((entry) => entry.startsWith("docker:rm")), false, `${mode} deleted a container`);
    }

    const race = await runCleanup(directory, "postdelete-race");
    assert.notEqual(resultStatus(race.result, "post-delete race cleanup"), 0);
    assert.deepEqual(race.trace.filter((entry) => entry.startsWith("docker:rm")), [`docker:rm ${ownerID}`]);
    assert.equal(race.trace.some((entry) => entry.includes(replacementID)), false);
    assert.match(race.result.stdout, new RegExp(`^current=${replacementID}$`, "m"));
  });
});

test("Node recovery authority gates bracket recreation, start, and policy restoration", async () => {
  await withTempDirectory(async (directory) => {
    const success = await runRestore(directory);
    assert.equal(resultStatus(success.result, "Node recovery order"), 0, success.result.stderr);
    const expectedOrder = [
      "authority:1",
      "create",
      "ids",
      "owner",
      `docker:inspect ${ownerID} --format {{.Image}}`,
      `docker:inspect ${ownerID} --format {{index .Config.Labels "org.opencontainers.image.revision"}}`,
      `docker:inspect ${ownerID} --format {{index .Config.Labels "org.opencontainers.image.version"}}`,
      `docker:inspect ${ownerID} --format {{.State.Running}}`,
      "authority:2",
      "record",
      `docker:start ${ownerID}`,
      "ready",
      "authority:3",
      "policy",
    ];
    let previous = -1;
    for (const entry of expectedOrder) {
      const index = success.trace.indexOf(entry);
      assert.ok(index > previous, `recovery order missing/out of order: ${entry}\n${success.trace.join("\n")}`);
      previous = index;
    }
    assert.match(success.result.stdout, /^started=true$/m);

    const failed = await runRestore(directory, "2");
    assert.notEqual(resultStatus(failed.result, "new authority failure"), 0);
    assert.equal(failed.trace.includes("authority:1"), true);
    assert.equal(failed.trace.includes("create"), true);
    assert.equal(failed.trace.includes("authority:2"), true);
    assert.equal(failed.trace.some((entry) => entry.startsWith("docker:start")), false);
    assert.equal(failed.trace.includes("policy"), false);
    assert.match(failed.result.stdout, /^started=false$/m);
  });
});
