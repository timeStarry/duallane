import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { captureComposeSnapshot, writeRecoverableCompose } from "../../deploy/production/release-compose-snapshot.mjs";

test("real Compose recovery preserves resolved literal dollars against a changed environment", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "duallane-compose-recovery-"));
  try {
    const image = `sha256:${"a".repeat(64)}`;
    const names = ["p2p", "workspace", "worker", "web", "migrate"];
    const literal = "old$SYNTHETIC_VALUE:${SYNTHETIC_VALUE}:$$:end";
    const source = path.join(directory, "source.json");
    const envFile = path.join(directory, "changed.env");
    await writeFile(envFile, "SYNTHETIC_VALUE=changed-file-value\n", { mode: 0o600 });
    await writeFile(source, JSON.stringify({
      name: "duallane-synthetic-recovery",
      services: Object.fromEntries(names.map((name) => [name, {
        image, environment: { SYNTHETIC_LITERAL: "${SYNTHETIC_LITERAL}" },
        command: ["printf", "%s", "${SYNTHETIC_LITERAL}"], restart: "no"
      }]))
    }), { mode: 0o600 });
    const resolveCompose = (file, value) => {
      // Configuration only: no daemon, container, registry or production files.
      const result = spawnSync("docker", [
        "compose", "--env-file", envFile, "-f", file, "config", "--format", "json"
      ], {
        cwd: directory,
        env: { ...process.env, SYNTHETIC_LITERAL: value, SYNTHETIC_VALUE: "changed-process-value", COMPOSE_DISABLE_ENV_FILE: "1" },
        encoding: "utf8", timeout: 10_000, maxBuffer: 256 * 1024, windowsHide: true
      });
      assert.equal(result.status, 0, "synthetic Compose recovery configuration must parse");
      return JSON.parse(result.stdout);
    };
    const priorResolved = resolveCompose(source, literal);
    const snapshot = captureComposeSnapshot({
      profile: "go-full", project: "duallane-synthetic-recovery",
      commit: "b".repeat(40), semver: "0.15.5", schemaVersion: 33,
      imageIDs: Object.fromEntries(names.map((name) => [name, image])),
      compose: priorResolved
    });
    const recovered = path.join(directory, "recovered.json");
    await writeRecoverableCompose(recovered, snapshot);
    const resolved = resolveCompose(recovered, "new-environment-must-not-replace-old-values");
    for (const name of names) {
      assert.equal(resolved.services[name].image, image);
      assert.deepEqual(resolved.services[name].environment, priorResolved.services[name].environment);
      assert.deepEqual(resolved.services[name].command, priorResolved.services[name].command);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
