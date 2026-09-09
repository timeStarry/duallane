import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const image = process.env.DUALLANE_RESTART_POLICY_TEST_IMAGE;
const helper = fileURLToPath(new URL("../../deploy/production/release-helper.sh", import.meta.url));
const ownerKey = "com.timestarry.duallane.restart-policy-probe";

function command(binary, args, options = {}) {
  return spawnSync(binary, args, {
    encoding: "utf8", timeout: 15_000, maxBuffer: 128 * 1024,
    windowsHide: true, ...options
  });
}

function docker(args) {
  const result = command("docker", args);
  assert.equal(result.status, 0, `synthetic Docker ${args[0]} must succeed`);
  return result.stdout.trim();
}

function inspectOwned(id, run, project) {
  assert.match(id, /^[0-9a-f]{64}$/);
  const [container] = JSON.parse(docker(["inspect", id]));
  assert.equal(container.Id, id);
  assert.equal(container.Config.Labels[ownerKey], run);
  assert.equal(container.Config.Labels["com.docker.compose.project"], project);
  assert.equal(container.Config.Labels["com.docker.compose.service"], "api");
  assert.equal(container.Image, image);
  assert.deepEqual(container.Mounts, []);
  assert.equal(container.HostConfig.NetworkMode, "none");
  assert.equal(container.HostConfig.ReadonlyRootfs, true);
  return container;
}

test("real Docker fencing disables and restores only the captured synthetic owner's restart policy", {
  skip: image ? false : "requires an explicit exact local shell-capable image and disposable Docker permission",
  timeout: 120_000
}, async (t) => {
  assert.equal(process.platform, "linux", "this disposable Docker gate runs on Linux");
  assert.match(image, /^sha256:[0-9a-f]{64}$/);
  assert.equal(JSON.parse(docker(["image", "inspect", image]))[0].Id, image);

  for (const policy of ["always", "on-failure:3"]) {
    await t.test(policy, async () => {
      const run = randomUUID();
      const project = `duallane-restart-probe-${run.slice(0, 8)}`;
      const directory = await mkdtemp(path.join(os.tmpdir(), `${project}-`));
      const composeFile = path.join(directory, "compose.json");
      const recoveryFile = path.join(directory, "private.recovery");
      let id;
      try {
        await writeFile(composeFile, JSON.stringify({
          name: project,
          services: {
            api: {
              image, pull_policy: "never", entrypoint: ["/bin/sleep", "300"],
              restart: policy, network_mode: "none", read_only: true,
              user: "65532:65532", cap_drop: ["ALL"],
              security_opt: ["no-new-privileges:true"],
              labels: { [ownerKey]: run }
            }
          }
        }), { mode: 0o600 });
        await writeFile(recoveryFile, "", { mode: 0o600 });
        const compose = ["compose", "-p", project, "-f", composeFile];
        docker([...compose, "create", "--no-build", "api"]);
        const created = docker([...compose, "ps", "-a", "-q", "api"]);
        // Resolve Compose's ID to the canonical identity before any mutation.
        id = docker(["inspect", created, "--format", "{{.Id}}"]);
        inspectOwned(id, run, project);
        docker(["start", id]);
        const before = inspectOwned(id, run, project);
        assert.equal(before.State.Running, true);
        const expectedPolicy = policy === "always"
          ? { Name: "always", MaximumRetryCount: 0 }
          : { Name: "on-failure", MaximumRetryCount: 3 };
        assert.deepEqual(before.HostConfig.RestartPolicy, expectedPolicy);

        const callHelper = (action, expectedProject = project) => command("bash", ["-c", String.raw`
set -euo pipefail
source "$PROBE_HELPER"
compose() { docker compose -p "$PROBE_PROJECT" -f "$PROBE_COMPOSE" "$@"; }
COMPOSE_PROJECT_NAME="$PROBE_EXPECTED_PROJECT"
RELEASE_RECOVERY_FILE="$PROBE_RECOVERY"
RELEASE_STOP_TIMEOUT=2
RELEASE_STOP_ATTEMPTS=2
RELEASE_HEALTH_ATTEMPTS=2
case "$PROBE_ACTION" in
  fence) release_fence_service_and_confirm api ;;
  recover) release_restore_fenced_service api ;;
  *) exit 64 ;;
esac
`, "release-restart-probe"], {
          env: {
            PATH: process.env.PATH, PROBE_HELPER: helper,
            PROBE_PROJECT: project, PROBE_EXPECTED_PROJECT: expectedProject,
            PROBE_COMPOSE: composeFile, PROBE_RECOVERY: recoveryFile,
            PROBE_ACTION: action, COMPOSE_DISABLE_ENV_FILE: "1"
          },
          timeout: 30_000
        });

        assert.notEqual(callHelper("fence", `${project}-wrong`).status, 0,
          "mismatched owner must fail before policy update or stop");
        const refused = inspectOwned(id, run, project);
        assert.equal(refused.State.Running, true);
        assert.deepEqual(refused.HostConfig.RestartPolicy, expectedPolicy);
        assert.equal(await readFile(recoveryFile, "utf8"), "");

        assert.equal(callHelper("fence").status, 0, "actual owner fencing must succeed");
        const fenced = inspectOwned(id, run, project);
        assert.equal(fenced.State.Running, false);
        assert.deepEqual(fenced.HostConfig.RestartPolicy, { Name: "no", MaximumRetryCount: 0 });
        const records = (await readFile(recoveryFile, "utf8")).trim().split("\n");
        assert.deepEqual(records.map((record) => record.split("\t")[0]), [
          "fence_target", "fence_updated", "fence_stopped", "fence_complete"
        ]);
        assert.equal(records[0].split("\t")[2], id);

        assert.equal(callHelper("recover").status, 0, "known-good owner recovery must succeed");
        const recovered = inspectOwned(id, run, project);
        assert.equal(recovered.State.Running, true);
        assert.deepEqual(recovered.HostConfig.RestartPolicy, expectedPolicy);
      } finally {
        // No daemon restart, prune, Compose down, or broad label-based removal.
        // A failed identity check deliberately leaves the resource for inspection.
        if (id) {
          inspectOwned(id, run, project);
          docker(["update", "--restart=no", id]);
          docker(["rm", "--force", id]);
        }
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});
