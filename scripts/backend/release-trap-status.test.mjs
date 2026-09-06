import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const helperPath = process.env.DUALLANE_RELEASE_TRAP_HELPER_PATH ??
  path.join(root, "deploy/production/release-helper.sh");
const helperSourcePath = process.env.DUALLANE_RELEASE_TRAP_HELPER_SOURCE_PATH ?? helperPath;
const deploySourcePath = process.env.DUALLANE_RELEASE_TRAP_DEPLOY_PATH ??
  path.join(root, "deploy/production/deploy.sh");
const bashCommand = process.env.DUALLANE_RELEASE_TRAP_BASH ?? "bash";

function runBash(script, leafStatus) {
  return spawnSync(
    bashCommand,
    ["--noprofile", "--norc", "-euo", "pipefail", "-c", script, "release-trap-status-test"],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 256 * 1024,
      windowsHide: true,
      env: {
        ...process.env,
        RELEASE_HELPER: helperPath,
        LEAF_STATUS: String(leafStatus),
      },
    },
  );
}

function trapStatusHarness() {
  return [
    "set -Eeuo pipefail",
    "source \"$RELEASE_HELPER\"",
    "[[ \"$LEAF_STATUS\" == 0 || \"$LEAF_STATUS\" == 37 ]]",
    "compose() {",
    "  if [[ \"$1\" == config && \"$2\" == --services ]]; then printf 'workspace\\n'; return 0; fi",
    "  if [[ \"$1\" == ps && \"$2\" == -a && \"$3\" == -q && \"$4\" == workspace ]]; then printf 'current-id\\n'; return \"$LEAF_STATUS\"; fi",
    "  return 99",
    "}",
    "rollback_compose() {",
    "  if [[ \"$1\" == config && \"$2\" == --services ]]; then printf 'workspace\\n'; return 0; fi",
    "  if [[ \"$1\" == ps && \"$2\" == -a && \"$3\" == -q && \"$4\" == workspace ]]; then printf 'rollback-id\\n'; return \"$LEAF_STATUS\"; fi",
    "  return 99",
    "}",
    "# These are downstream leaves only; the functions under test remain sourced from release-helper.sh.",
    "go_upgrade_rollback_compose() { return \"$LEAF_STATUS\"; }",
    "release_go_upgrade_recover_service() { return \"$LEAF_STATUS\"; }",
    "RELEASE_PROFILE_NAME=go-full",
    "RELEASE_GO_UPGRADE=true",
    "release_trap_handler() {",
    "  local original=\"$1\" status",
    "  if release_current_service_ids workspace >/dev/null; then status=0; else status=$?; fi",
    "  printf 'current=%s\\n' \"$status\"",
    "  if release_rollback_service_ids workspace >/dev/null; then status=0; else status=$?; fi",
    "  printf 'rollback=%s\\n' \"$status\"",
    "  if release_go_upgrade_rollback_compose ps >/dev/null; then status=0; else status=$?; fi",
    "  printf 'rollback_compose=%s\\n' \"$status\"",
    "  if release_start_recovery_service workspace >/dev/null; then status=0; else status=$?; fi",
    "  printf 'recovery=%s\\n' \"$status\"",
    "  printf 'trap_original=%s\\n' \"$original\"",
    "  return \"$original\"",
    "}",
    "trap 'release_trap_handler \"$?\"' ERR",
    "trigger_failure() { return 74; }",
    "trigger_failure",
  ].join("\n");
}

function assertTrapResult(result, leafStatus) {
  assert.equal(result.error, undefined, `ERR trap harness did not start: ${result.error?.message ?? "unknown"}`);
  assert.equal(result.status, 74, `ERR trap harness did not retain the triggering status:\n${result.stdout}\n${result.stderr}`);
  assert.equal(result.stderr.trim(), "", `ERR trap harness emitted unexpected diagnostics: ${result.stderr}`);
  assert.deepEqual(
    result.stdout.trim().split("\n"),
    [
      `current=${leafStatus}`,
      `rollback=${leafStatus}`,
      `rollback_compose=${leafStatus}`,
      `recovery=${leafStatus}`,
      "trap_original=74",
    ],
  );
}

test("delegated release statuses survive an ERR trap while the original failure remains 74", () => {
  for (const leafStatus of [0, 37]) {
    assertTrapResult(runBash(trapStatusHarness(), leafStatus), leafStatus);
  }
});

test("release helper and deploy adapters contain no bare return", async () => {
  const bareReturn = /^[ \t]*return[ \t]*$/mu;
  const [helperSource, deploySource] = await Promise.all([
    readFile(helperSourcePath, "utf8"),
    readFile(deploySourcePath, "utf8"),
  ]);
  assert.equal(bareReturn.test(helperSource.replaceAll("\r\n", "\n")), false, "release-helper.sh has a bare return");
  assert.equal(bareReturn.test(deploySource.replaceAll("\r\n", "\n")), false, "deploy.sh has a bare return");
});
