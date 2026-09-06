import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const helperPath = path.join(root, "deploy/production/release-helper.sh");
const oldCommit = "a".repeat(40);
const oldImage = `sha256:${"b".repeat(64)}`;
const oldIdentity = "c".repeat(64);
const restoredIdentity = "d".repeat(64);

function runBash(script, { env = {}, timeout = 15_000 } = {}) {
  return spawnSync(
    "bash",
    ["--noprofile", "--norc", "-euo", "pipefail", "-c", script, "release-go-restore-test"],
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
  const directory = await mkdtemp(path.join(os.tmpdir(), "duallane-release-go-restore-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function restoreHarness() {
  return [
    "set -Eeuo pipefail",
    "source \"$RELEASE_HELPER\"",
    "umask 077",
    "trace() { printf '%s\\n' \"$*\" >> \"$TRACE\"; }",
    "AUTH_COUNT=0",
    "FAKE_RUNNING=false",
    "FAKE_STATUS=created",
    "FAKE_HEALTH=none",
    "FAKE_RESTART_NAME=always",
    "FAKE_RESTART_MAX=0",
    "release_verify_external_files_manifest() { trace external; }",
    "release_verify_pinned_volume_authority() {",
    "  AUTH_COUNT=$((AUTH_COUNT + 1))",
    "  trace \"authority-${AUTH_COUNT}\"",
    "  [[ \"${AUTH_FAIL_AT}\" != \"${AUTH_COUNT}\" ]]",
    "}",
    "go_upgrade_rollback_compose() {",
    "  case \"$1\" in",
    "    up)",
    "      [[ \"$2\" == --no-start && \"$3\" == --pull && \"$4\" == never && \"$5\" == --no-build && \"$6\" == --no-deps && \"$7\" == --force-recreate && \"$8\" == workspace ]] || return 70",
    "      trace compose-up",
    "      return 0",
    "      ;;",
    "    ps)",
    "      [[ \"$2\" == -a && \"$3\" == -q && \"$4\" == workspace ]] || return 71",
    "      trace compose-ps",
    "      printf '%s\\n' \"$RESTORED_ID\"",
    "      return 0",
    "      ;;",
    "    *) return 72 ;;",
    "  esac",
    "}",
    "docker() {",
    "  local operation=\"${1:-}\" id=\"${2:-}\" format=\"${4:-}\" spec",
    "  case \"${operation}\" in",
    "    inspect)",
    "      [[ \"${id}\" == \"${RESTORED_ID}\" ]] || return 1",
    "      case \"${format}\" in",
    "        \"{{.Id}}\") printf '%s\\n' \"${RESTORED_ID}\" ;;",
    "        \"{{.Image}}\") printf '%s\\n' \"${OLD_IMAGE}\" ;;",
    "        \"{{.State.Running}}\") printf '%s\\n' \"${FAKE_RUNNING}\" ;;",
    "        \"{{.State.Status}}\") printf '%s\\n' \"${FAKE_STATUS}\" ;;",
    "        \"{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}\") printf '%s\\n' \"${FAKE_HEALTH}\" ;;",
    "        \"{{.HostConfig.RestartPolicy.Name}}\") printf '%s\\n' \"${FAKE_RESTART_NAME}\" ;;",
    "        \"{{.HostConfig.RestartPolicy.MaximumRetryCount}}\") printf '%s\\n' \"${FAKE_RESTART_MAX}\" ;;",
    "        *com.docker.compose.project*) printf '%s\\n' duallane ;;",
    "        *com.docker.compose.service*) printf '%s\\n' workspace ;;",
    "        *org.opencontainers.image.revision*) printf '%s\\n' \"${OLD_COMMIT}\" ;;",
    "        *org.opencontainers.image.version*) printf '%s\\n' \"${OLD_VERSION}\" ;;",
    "        *) return 1 ;;",
    "      esac",
    "      return 0",
    "      ;;",
    "    update)",
    "      id=\"${3:-}\"",
    "      spec=\"${2#--restart=}\"",
    "      [[ \"${id}\" == \"${RESTORED_ID}\" ]] || return 1",
    "      trace \"update:${spec}\"",
    "      case \"${spec}\" in",
    "        no) FAKE_RESTART_NAME=no; FAKE_RESTART_MAX=0 ;;",
    "        on-failure:3) FAKE_RESTART_NAME=on-failure; FAKE_RESTART_MAX=3 ;;",
    "        *) return 1 ;;",
    "      esac",
    "      return 0",
    "      ;;",
    "    start)",
    "      [[ \"${id}\" == \"${RESTORED_ID}\" ]] || return 1",
    "      trace start",
    "      [[ \"${MODE}\" != start-failure ]] || return 75",
    "      FAKE_RUNNING=true",
    "      FAKE_STATUS=running",
    "      if [[ \"${MODE}\" == health-failure ]]; then FAKE_HEALTH=unhealthy; else FAKE_HEALTH=healthy; fi",
    "      return 0",
    "      ;;",
    "    *) return 1 ;;",
    "  esac",
    "}",
    "RELEASE_PROFILE_NAME=go-full",
    "RELEASE_GO_UPGRADE=true",
    "RELEASE_GO_UPGRADE_OLD_COMPOSE_FILE=canonical-old-compose",
    "RELEASE_GO_UPGRADE_CURRENT_COMPOSE_FILE=canonical-new-compose",
    "RELEASE_GO_UPGRADE_OLD_EXTERNAL_MANIFEST=canonical-old-external",
    "RELEASE_GO_UPGRADE_OLD_VOLUME_MANIFEST=canonical-old-volume",
    "RELEASE_RECOVERY_FILE=\"$RECOVERY\"",
    "RELEASE_GO_UPGRADE_OLD_WORKSPACE_IMAGE_ID=\"$OLD_IMAGE\"",
    "RELEASE_GO_UPGRADE_OLD_COMMIT=\"$OLD_COMMIT\"",
    "RELEASE_GO_UPGRADE_OLD_VERSION=0.15.5",
    "RELEASE_HEALTH_REQUIRED=(workspace)",
    "RELEASE_HEALTH_ATTEMPTS=1",
    "COMPOSE_PROJECT_NAME=duallane",
    "current_commit=\"$OLD_COMMIT\"",
    "expected_app_version=0.16.0",
    "if release_go_upgrade_restore_old_service workspace; then status=0; else status=$?; fi",
    "printf 'status=%s\\n' \"${status}\"",
    "printf 'running=%s\\n' \"${FAKE_RUNNING}\"",
    "printf 'restart=%s:%s\\n' \"${FAKE_RESTART_NAME}\" \"${FAKE_RESTART_MAX}\"",
    "printf 'health=%s\\n' \"${FAKE_HEALTH}\"",
  ].join("\n");
}

function globalOrderHarness() {
  return [
    "set -Eeuo pipefail",
    "source \"$RELEASE_HELPER\"",
    "umask 077",
    "trace() { printf '%s\\n' \"$*\" >> \"$TRACE\"; }",
    "RELEASE_PROFILE_NAME=go-full",
    "RELEASE_GO_UPGRADE=true",
    "RELEASE_GO_UPGRADE_VALIDATED=true",
    "RELEASE_GO_UPGRADE_OLD_COMPOSE_FILE=canonical-old-compose",
    "RELEASE_GO_UPGRADE_OLD_COMMIT=\"$OLD_COMMIT\"",
    "RELEASE_GO_UPGRADE_DAEMON_RECOVERY_DONE=false",
    "RELEASE_RECOVERY_FILE=\"$RECOVERY\"",
    "RELEASE_GO_UPGRADE_NEW_ATTEMPTED_SERVICES=()",
    "release_go_upgrade_previous_owner_record() {",
    "  case \"$1\" in",
    "    p2p) REPLY=\"${P2P_ID}\"$'\\t'\"${P2P_IMAGE}\"$'\\t'\"${OLD_COMMIT}\" ;;",
    "    workspace) REPLY=\"${WORKSPACE_ID}\"$'\\t'\"${WORKSPACE_IMAGE}\"$'\\t'\"${OLD_COMMIT}\" ;;",
    "    worker) REPLY=\"${WORKER_ID}\"$'\\t'\"${WORKER_IMAGE}\"$'\\t'\"${OLD_COMMIT}\" ;;",
    "    web) REPLY=\"${WEB_ID}\"$'\\t'\"${WEB_IMAGE}\"$'\\t'\"${OLD_COMMIT}\" ;;",
    "    *) return 1 ;;",
    "  esac",
    "}",
    "release_current_service_ids() {",
    "  case \"$1\" in",
    "    p2p) printf '%s\\n' \"${P2P_ID}\" ;;",
    "    workspace) printf '%s\\n' \"${WORKSPACE_ID}\" ;;",
    "    worker) printf '%s\\n' \"${WORKER_ID}\" ;;",
    "    web) printf '%s\\n' \"${WEB_ID}\" ;;",
    "    *) return 1 ;;",
    "  esac",
    "}",
    "release_go_upgrade_fence_phase_and_confirm() { trace \"fence:$1:$2\"; }",
    "release_go_upgrade_restore_old_service() { trace \"restore:$1\"; }",
    "release_require_drained_runtime() {",
    "  grep -Fxq 'go_upgrade_daemon_new_owners_fenced=true' \"$RELEASE_RECOVERY_FILE\"",
    "  trace drain",
    "}",
    "release_run_previous_gateway_smoke() { trace smoke; }",
    "release_go_upgrade_recover_all_services",
  ].join("\n");
}

async function runRestore(directory, { mode = "success", authFailAt = 0 } = {}) {
  const recoveryPath = path.join(directory, `${mode}.recovery`);
  const tracePath = path.join(directory, `${mode}.trace`);
  await writeFile(
    recoveryPath,
    [
      `go_upgrade_old_owner\tworkspace\t${oldIdentity}\t${oldImage}\t${oldCommit}`,
      `go_upgrade_fence_target\told\tworkspace\t${oldIdentity}\ton-failure\t3\ttrue\t${oldImage}\t${oldCommit}`,
      `go_upgrade_fence_complete\told\tworkspace\t${oldIdentity}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const result = runBash(restoreHarness(), {
    env: {
      RELEASE_HELPER: helperPath,
      RECOVERY: recoveryPath,
      TRACE: tracePath,
      OLD_ID: oldIdentity,
      RESTORED_ID: restoredIdentity,
      OLD_IMAGE: oldImage,
      OLD_COMMIT: oldCommit,
      OLD_VERSION: "0.15.5",
      MODE: mode,
      AUTH_FAIL_AT: String(authFailAt),
    },
  });
  return {
    result,
    recovery: await readFile(recoveryPath, "utf8"),
    trace: (await readFile(tracePath, "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean),
  };
}

function statusOf(result, label) {
  assert.equal(result.error, undefined, `${label} did not start cleanly: ${result.error?.message ?? "unknown"}`);
  const match = result.stdout.match(/^status=(\d+)$/m);
  assert.ok(match, `${label} did not report a bounded status:\n${result.stdout}\n${result.stderr}`);
  return Number(match[1]);
}

test("Go-to-Go daemon recovery fences every new owner and drains before any old restore", async () => {
  await withTempDirectory(async directory => {
    const recoveryPath = path.join(directory, "global.recovery");
    const tracePath = path.join(directory, "global.trace");
    await writeFile(recoveryPath, "", { mode: 0o600 });
    const result = runBash(globalOrderHarness(), {
      env: {
        RELEASE_HELPER: helperPath,
        RECOVERY: recoveryPath,
        TRACE: tracePath,
        OLD_COMMIT: oldCommit,
        P2P_ID: "1".repeat(64),
        WORKSPACE_ID: "2".repeat(64),
        WORKER_ID: "3".repeat(64),
        WEB_ID: "4".repeat(64),
        P2P_IMAGE: `sha256:${"5".repeat(64)}`,
        WORKSPACE_IMAGE: `sha256:${"6".repeat(64)}`,
        WORKER_IMAGE: `sha256:${"7".repeat(64)}`,
        WEB_IMAGE: `sha256:${"8".repeat(64)}`,
      },
    });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const events = (await readFile(tracePath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean);
    const drainIndex = events.indexOf("drain");
    assert.ok(drainIndex >= 0, `drain was not recorded: ${events.join(" | ")}`);
    for (const service of ["p2p", "workspace", "worker", "web"]) {
      const fenceIndex = events.indexOf(`fence:old:${service}`);
      const restoreIndex = events.indexOf(`restore:${service}`);
      assert.ok(fenceIndex >= 0 && fenceIndex < drainIndex, `${service} was not fenced before drain: ${events.join(" | ")}`);
      assert.ok(restoreIndex > drainIndex, `${service} restored before drain: ${events.join(" | ")}`);
    }
    assert.ok(events.indexOf("smoke") > Math.max(...["p2p", "workspace", "worker", "web"].map(service => events.indexOf(`restore:${service}`))));
    const recovery = await readFile(recoveryPath, "utf8");
    assert.match(recovery, /^go_upgrade_daemon_new_owners_fenced=true$/m);
    assert.match(recovery, /^go_upgrade_daemon_old_owners_restored=true$/m);
  });
});

test("old Go restore rejects authority before start at both pre-create and post-create checks", async () => {
  await withTempDirectory(async directory => {
    for (const [mode, authFailAt, expectedCompose] of [
      ["precreate-authority-failure", 1, false],
      ["postcreate-authority-failure", 2, true],
    ]) {
      const { result, recovery, trace } = await runRestore(directory, { mode, authFailAt });
      const status = statusOf(result, mode);
      assert.notEqual(status, 0, `${mode} unexpectedly passed`);
      assert.ok(trace.includes("authority-1"), `${mode} did not call the initial authority gate`);
      assert.ok(!trace.includes("start"), `${mode} started an owner after authority rejection: ${trace.join(" | ")}`);
      assert.equal(trace.includes("compose-up"), expectedCompose, `${mode} create ordering changed: ${trace.join(" | ")}`);
      if (authFailAt === 1) {
        assert.doesNotMatch(recovery, /^go_upgrade_old_created\t/m);
      } else {
        assert.match(recovery, new RegExp(`^go_upgrade_old_created\\tworkspace\\t${restoredIdentity}\\t`, "m"));
        assert.ok(trace.indexOf("update:no") < trace.indexOf("authority-2"));
      }
    }
  });
});

test("old Go restore records the exact recreated owner before each of three post-create failures", async () => {
  await withTempDirectory(async directory => {
    const cases = [
      ["start-failure", 0],
      ["health-failure", 0],
      ["post-health-authority-failure", 3],
    ];
    for (const [mode, authFailAt] of cases) {
      const { result, recovery, trace } = await runRestore(directory, { mode, authFailAt });
      const status = statusOf(result, mode);
      assert.notEqual(status, 0, `${mode} unexpectedly passed`);
      assert.match(
        recovery,
        new RegExp(`^go_upgrade_old_created\\tworkspace\\t${restoredIdentity}\\t${oldImage}\\t${oldCommit}$`, "m"),
      );
      assert.doesNotMatch(recovery, /^go_upgrade_old_restored\t/m);
      assert.doesNotMatch(recovery, /^replacement_workspace=/m);
      assert.ok(trace.includes("update:no"), `${mode} did not disable restart before start`);
      assert.ok(!trace.includes("update:on-failure:3"), `${mode} restored the captured policy after failure`);
      if (mode === "start-failure") {
        assert.ok(!trace.includes("authority-3"));
      } else if (mode === "health-failure") {
        assert.ok(trace.includes("start"));
        assert.ok(!trace.includes("authority-3"));
      } else {
        assert.deepEqual(trace.slice(-2), ["start", "authority-3"]);
      }
    }
  });
});

test("old Go restore applies the captured on-failure policy only after healthy authority", async () => {
  await withTempDirectory(async directory => {
    const { result, recovery, trace } = await runRestore(directory);
    assert.equal(statusOf(result, "successful old restore"), 0, `${result.stderr}\n${result.stdout}`);
    const expectedOrder = [
      "external",
      "authority-1",
      "compose-up",
      "compose-ps",
      "update:no",
      "authority-2",
      "start",
      "authority-3",
      "update:on-failure:3",
    ];
    let previous = -1;
    for (const event of expectedOrder) {
      const index = trace.indexOf(event);
      assert.ok(index > previous, `${event} was out of order: ${trace.join(" | ")}`);
      previous = index;
    }
    assert.match(recovery, new RegExp(`^replacement_workspace=${restoredIdentity}$`, "m"));
    assert.match(recovery, new RegExp(`^go_upgrade_old_restored\\tworkspace\\t${restoredIdentity}$`, "m"));
    assert.match(result.stdout, /^restart=on-failure:3$/m);
  });
});
