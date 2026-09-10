import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CANARY, runProbe } from "../../deploy/production/release-permission-probe.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const image = `sha256:${"a".repeat(64)}`;
const id = "b".repeat(64);
const writer = "c".repeat(64);
const volume = "synthetic-data";
const secret = "/synthetic/private/credential.json";

function fixture({ policy = {}, runningWriter = false, startFailure = false, changedOwner = false } = {}) {
  const calls = [];
  let container;
  const runner = args => {
    calls.push(args);
    if (args[0] === "volume") return JSON.stringify([{ Name: volume, Driver: "local", Mountpoint: "/synthetic/volumes/synthetic-data/_data" }]);
    if (args[0] === "image") return JSON.stringify([{ Id: image }]);
    if (args[0] === "ps") return runningWriter ? writer : "";
    if (args[0] === "create") {
      const label = args[args.indexOf("--label") + 1].split("=");
      container = {
        Id: id, Image: image,
        Config: { User: "65532:65532", Labels: { [label[0]]: label[1] } },
        State: { Running: false, ExitCode: 0 },
        HostConfig: { NetworkMode: "none", ReadonlyRootfs: true, RestartPolicy: { Name: "no" }, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"], PidsLimit: 32, Memory: 64 * 1024 * 1024 },
        Mounts: [{ Type: "volume", Name: volume, Destination: "/app/data", RW: true }],
        ...policy,
      };
      if (args.some(arg => arg.startsWith("type=bind"))) container.Mounts.push({ Type: "bind", Source: secret, Destination: "/run/secrets/workspace-s3", RW: false });
      return id;
    }
    if (args[0] === "container") {
      if (args[2] === writer) return JSON.stringify([{ Id: writer, Mounts: [{ Type: "bind", Source: "/synthetic", RW: true }] }]);
      const inspected = structuredClone(container);
      if (changedOwner && calls.some(c => c[0] === "start")) inspected.Image = `sha256:${"d".repeat(64)}`;
      return JSON.stringify([inspected]);
    }
    if (args[0] === "start") {
      if (startFailure) { container.State.Running = true; throw new Error("synthetic opaque error"); }
      return "";
    }
    if (args[0] === "stop") { container.State.Running = false; return ""; }
    if (args[0] === "rm") return "";
    throw new Error("unexpected fake Docker command");
  };
  return { runner, calls };
}

test("the offline canary runs as the real Go UID with no network and cleans its exact container", () => {
  for (const credential of [secret, "-"]) {
    const f = fixture();
    assert.deepEqual(runProbe({ volume, image, secret: credential }, f.runner), {
      status: "PASS", uid: 65532, gid: 65532, syntheticWrite: "verified", cleanup: "completed",
    });
    const create = f.calls.find(c => c[0] === "create");
    assert.equal(create[create.indexOf("--user") + 1], "65532:65532");
    assert.equal(create[create.indexOf("--network") + 1], "none");
    assert.ok(create.includes("--read-only"));
    assert.ok(create.includes("ALL"));
    assert.ok(create.includes("no-new-privileges"));
    assert.ok(create.includes("type=volume,source=synthetic-data,target=/app/data,volume-nocopy"));
    assert.ok(create.includes(CANARY));
    assert.deepEqual(f.calls.at(-1), ["rm", id]);
  }
});

test("canary rejects an active ancestor bind writer and mutable image before create", () => {
  const f = fixture({ runningWriter: true });
  assert.throws(() => runProbe({ volume, image, secret }, f.runner), /writer_not_fenced/u);
  assert.equal(f.calls.some(c => c[0] === "create"), false);
  assert.throws(() => runProbe({ volume, image: "synthetic:latest", secret }, f.runner), /invalid_arguments/u);
  assert.throws(() => runProbe({ volume, image, secret: "/secret,readonly=false" }, f.runner), /invalid_arguments/u);
});

test("canary failure stops and removes only its own known container", () => {
  const f = fixture({ startFailure: true });
  assert.throws(() => runProbe({ volume, image, secret }, f.runner), /synthetic opaque error/u);
  assert.deepEqual(f.calls.filter(c => c[0] === "stop"), [["stop", "--time", "5", id]]);
  assert.deepEqual(f.calls.at(-1), ["rm", id]);
});

test("canary ownership drift refuses cleanup and wrong isolation refuses startup", () => {
  const drift = fixture({ changedOwner: true });
  assert.throws(() => runProbe({ volume, image, secret }, drift.runner), /probe_cleanup_failed/u);
  assert.equal(drift.calls.some(c => c[0] === "rm" || c[0] === "stop"), false);
  const invalid = fixture({ policy: { HostConfig: { NetworkMode: "bridge", ReadonlyRootfs: true, RestartPolicy: { Name: "no" } } } });
  assert.throws(() => runProbe({ volume, image, secret }, invalid.runner), /probe_policy_invalid/u);
  assert.equal(invalid.calls.some(c => c[0] === "start"), false);
  assert.deepEqual(invalid.calls.at(-1), ["rm", id]);
});

test("the canary CLI emits fixed codes and does not echo input secrets", () => {
  const result = spawnSync(process.execPath, [path.join(root, "deploy/production/release-permission-probe.mjs"), "--unexpected", "private-value"], { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.includes("private-value"), false);
  assert.equal(JSON.parse(result.stderr).status, "FAIL");
});

test("current deployment rejects the retired first-cutover permission entrypoint", { skip: process.platform === "win32" }, () => {
  for (const args of [[], ["--go-upgrade"], ["--bootstrap"]]) {
    const result = spawnSync("bash", [path.join(root, "deploy/production/deploy.sh"), "--prepare-go-permissions", ...args], { encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Node runtime retired: only Go-to-Go upgrades/u);
  }
  const noop = spawnSync("bash", ["-euc", 'source "$1/deploy/production/release-helper.sh"; release_preflight_permission_tools; release_prepare_permission_inputs; release_prepare_offline_data_permissions', "probe-test", root], { encoding: "utf8", timeout: 10_000 });
  assert.equal(noop.status, 0, noop.stderr);
});

test("offline stage requires a verified quiescent dump before volume mutation and canary", { skip: process.platform !== "linux" || process.getuid?.() !== 0 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "duallane-permission-stage-"));
  try {
    for (const mode of ["success", "invalid-dump", "volume-failure", "probe-failure"]) {
      const recovery = path.join(directory, mode);
      const trace = recovery + ".trace";
      await writeFile(recovery, "", { mode: 0o600 });
      const script = `
source "$ROOT/deploy/production/release-helper.sh"
prepare_go_permissions=true
app_replaced=true
RELEASE_RECOVERY_FILE=$RECOVERY
RELEASE_PERMISSION_VOLUME=synthetic-data
RELEASE_PERMISSION_SECRET=-
RELEASE_GO_IMAGE_ID=$IMAGE
release_verify_activation_authority() { echo authority >> "$TRACE"; }
release_compose_project_name() { echo synthetic; }
compose() {
  if [[ "$*" == *pg_restore* ]]; then echo restore-list >> "$TRACE"; [[ "$MODE" != invalid-dump ]];
  else echo dump >> "$TRACE"; printf '%s' synthetic-dump; fi
}
node() {
  if [[ "$1" == *release-storage-permissions.mjs ]]; then echo volume >> "$TRACE"; [[ "$MODE" != volume-failure ]];
  else echo probe >> "$TRACE"; [[ "$MODE" != probe-failure ]]; fi
}
release_append_recovery_record() { echo record >> "$TRACE"; }
release_prepare_offline_data_permissions
`;
      const result = spawnSync("bash", ["--noprofile", "--norc", "-euo", "pipefail", "-c", script], {
        encoding: "utf8", timeout: 10_000,
        env: { ...process.env, ROOT: root, RECOVERY: recovery, TRACE: trace, MODE: mode, IMAGE: image },
      });
      const events = (await readFile(trace, "utf8")).trim().split("\n");
      const expected = ["authority", "dump", "restore-list"];
      if (mode !== "invalid-dump") expected.push("authority", "volume");
      if (mode === "success" || mode === "probe-failure") expected.push("probe");
      if (mode === "success") expected.push("authority", "record");
      assert.deepEqual(events, expected, result.stderr);
      assert.equal(result.status, mode === "success" ? 0 : 1, result.stderr);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("permission preflight honors a remote context over a local host and refuses maintenance", { skip: process.platform === "win32" }, () => {
  const script = `
source "$1/deploy/production/release-helper.sh"
prepare_go_permissions=true
DOCKER_CONTEXT=synthetic-remote
DOCKER_HOST=unix:///var/run/docker.sock
node() { return 0; }
docker() {
  [[ "$1 $2 $3" == 'context inspect synthetic-remote' ]] || return 91
  printf '%s\\n' 'ssh://synthetic-remote'
}
compose() { echo unexpected-maintenance; return 92; }
release_preflight_permission_tools
`;
  const result = spawnSync("bash", ["-euc", script, "preflight-test", root], { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires the local Unix Docker daemon/u);
  assert.equal(result.stdout.includes("unexpected-maintenance"), false);
});

test("historical first-cutover helpers keep snapshot, offline fence and candidate ordering", async () => {
  const source = await readFile(path.join(root, "deploy/production/deploy.sh"), "utf8");
  const sequence = ["release_snapshot_app_state \"${release_state_file}\"", "release_prepare_permission_inputs\n", "release_freeze_node_recovery_compose\n", "compose build \"${RELEASE_BUILD_SERVICES[@]}\""];
  let cursor = 0;
  for (const item of sequence) { const index = source.indexOf(item, cursor); assert.ok(index >= cursor, item); cursor = index + item.length; }
  const cutover = source.slice(source.lastIndexOf('  if [[ "${prepare_go_permissions}" == true ]]'));
  cursor = 0;
  for (const item of ["app_replaced=true", "stop_legacy_services_for_go", "release_require_drained_runtime activation", "release_prepare_offline_data_permissions", "preflight_candidates", "start_release_backend", "start_release_edge"]) {
    const index = cutover.indexOf(item, cursor); assert.ok(index >= cursor, item); cursor = index + item.length;
  }
});
