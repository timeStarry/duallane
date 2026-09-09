import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  profileNames,
  profiles,
  validateProfile,
  validateResolvedCompose,
} from "../../deploy/production/release-manifest.mjs";
import {
  captureComposeSnapshot,
  writeRecoverableCompose,
  writeSnapshot,
} from "../../deploy/production/release-compose-snapshot.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const helper = path.join(root, "deploy/production/release-helper.sh");
const fakeIdentity = (hexDigit) => hexDigit.repeat(64);

function environment(entries) {
  return Object.fromEntries(entries.map((entry) => {
    const index = entry.indexOf("=");
    return [entry.slice(0, index), entry.slice(index + 1)];
  }));
}

function healthcheck(pathname) {
  return {
    test: ["CMD", "/usr/local/bin/duallane-healthcheck", `http://127.0.0.1:8787${pathname}`],
  };
}

function validGoCompose() {
  const service = (name, pathname, env = []) => ({
    image: `registry.example/${name}:synthetic`,
    environment: environment(env),
    healthcheck: healthcheck(pathname),
  });
  return {
    services: {
      api: { healthcheck: healthcheck("/api/health") },
      p2p: service("p2p", "/api/health"),
      workspace: {
        ...service("workspace", "/readyz", ["WORKSPACE_ENABLED=true"]),
        image: "registry.example/workspace:synthetic",
        user: "65532:65532",
        volumes: ["legacy-data:/app/data"],
        depends_on: {
          postgres: { condition: "service_healthy" },
          migrate: { condition: "service_completed_successfully" },
        },
      },
      worker: {
        ...service("worker", "/readyz", ["WORKSPACE_ENABLED=true"]),
        image: "registry.example/workspace:synthetic",
        user: "65532:65532",
        volumes: ["legacy-data:/app/data"],
        depends_on: {
          postgres: { condition: "service_healthy" },
          migrate: { condition: "service_completed_successfully" },
        },
      },
      web: {
        healthcheck: healthcheck("/api/health"),
        depends_on: {
          p2p: { condition: "service_healthy" },
          workspace: { condition: "service_healthy" },
        },
      },
      migrate: {
        image: "registry.example/workspace:synthetic",
        restart: "no",
        depends_on: { postgres: { condition: "service_healthy" } },
      },
      postgres: { healthcheck: { test: ["CMD", "pg_isready"] } },
    },
  };
}

const goUpgradeOldCommit = "a".repeat(40);
const goUpgradeNewCommit = "b".repeat(40);
const goUpgradeRetryModes = Object.freeze([
  "go-upgrade-old-start-retry",
  "go-upgrade-old-health-retry",
  "go-upgrade-old-smoke-retry",
]);

function goUpgradeImage(hexDigit) {
  return "sha256:" + hexDigit.repeat(64);
}

const rollbackGoImage = goUpgradeImage("9");
const rollbackGoRunID = "d".repeat(64);

function goUpgradeSnapshotInput() {
  const compose = structuredClone(validGoCompose());
  compose.name = "duallane";
  compose.services.web.image = "registry.example/web:synthetic";
  compose.volumes = { "legacy-data": {} };
  return {
    compose,
    imageIDs: {
      p2p: goUpgradeImage("1"),
      workspace: goUpgradeImage("2"),
      worker: goUpgradeImage("2"),
      web: goUpgradeImage("3"),
      migrate: goUpgradeImage("2"),
    },
    profile: "go-full",
    project: "duallane",
    commit: goUpgradeOldCommit,
    semver: "0.15.5",
    schemaVersion: 42,
  };
}

async function writeGoUpgradeSnapshotArtifacts(directory) {
  const snapshotPath = path.join(directory, "previous-go.snapshot.json");
  const composePath = snapshotPath + ".compose.json";
  const externalPath = snapshotPath + ".external.json";
  const volumePath = snapshotPath + ".volumes.json";
  const snapshot = captureComposeSnapshot(goUpgradeSnapshotInput());
  await writeSnapshot(snapshotPath, snapshot);
  await writeRecoverableCompose(composePath, snapshot);
  // This harness models volume authority; real inspection/refusal behavior
  // belongs to release-volume-authority.test.mjs and container rehearsals.
  await writeFile(volumePath, "{}\n", { mode: 0o600 });
  const external = spawnSync(
    process.execPath,
    [
      path.join(root, "deploy/production/release-external-files.mjs"),
      "capture",
      "--compose",
      composePath,
      "--services",
      "p2p,workspace,worker,web,migrate",
      "--output",
      externalPath,
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (external.status !== 0) {
    throw new Error("synthetic external-file snapshot failed: " + external.stderr);
  }
  return { snapshotPath, composePath, externalPath };
}

test("release manifest exposes only the fixed profiles and preserves Node default", () => {
  assert.deepEqual(profileNames, ["node-default", "go-full"]);
  assert.deepEqual(profiles["node-default"].services, ["postgres", "migrate", "api", "web"]);
  assert.deepEqual(profiles["node-default"].build, ["api", "web", "migrate"]);
  assert.deepEqual(profiles["node-default"].candidates, ["api", "web"]);
  assert.deepEqual(profiles["go-full"].goWriters, ["workspace", "worker"]);
  assert.deepEqual(profiles["go-full"].stopBeforeBackend, ["api"]);
  assert.deepEqual(profiles["go-full"].healthRequired, ["postgres", "api", "p2p", "workspace", "worker", "web"]);
  assert.equal(validateProfile(profiles["node-default"]).name, "node-default");
  assert.equal(validateProfile(profiles["go-full"]).name, "go-full");
});

test("candidate overlay keeps upstream aliases off the PostgreSQL network", async () => {
  const overlay = await readFile(path.join(root, "deploy/production/go-candidate.compose.yml"), "utf8");
  assert.match(overlay, /external:\s*true/);
  assert.match(overlay, /name:\s*\$\{DUALLANE_GO_CANDIDATE_NETWORK:\?candidate network is required\}/);
  assert.match(overlay, /workspace:\s*\n\s+networks:\s*\n\s+default:\s*\{\}\s*\n\s+candidate:/);
  assert.match(overlay, /worker:\s*\n\s+networks:\s*\n\s+default:\s*\{\}\s*\n\s+candidate:/);
  assert.match(overlay, /aliases:\s*\n\s+- workspace/);
  assert.match(overlay, /workspace:[\s\S]*?volumes:\s*\n\s+- duallane-data:\/app\/data:ro/);
  assert.match(overlay, /worker:[\s\S]*?volumes:\s*\n\s+- duallane-data:\/app\/data:ro/);
});

test("production candidate composition delegates Node candidates to the real compose function", async () => {
  const deploySource = (await readFile(path.join(root, "deploy/production/deploy.sh"), "utf8"))
    .replaceAll("\r\n", "\n");
  const functionStart = deploySource.indexOf("candidate_compose() {");
  const functionEnd = deploySource.indexOf("\n\nrollback_compose() {", functionStart);
  assert.ok(functionStart >= 0 && functionEnd > functionStart, "candidate_compose was not found in deploy.sh");
  const candidateFunction = deploySource.slice(functionStart, functionEnd);
  const harness = [
    "set -Eeuo pipefail",
    "BASE_COMPOSE_FILES=(--env-file node-env -f node-base -f node-production)",
    "PROJECT_DIR=/repo",
    "release_profile=node-default",
    "docker() { printf 'docker:%s\\n' \"$*\"; }",
    "compose() { printf 'compose:%s\\n' \"$*\"; }",
    candidateFunction,
    "candidate_compose run -d api",
    "release_profile=go-full",
    "candidate_compose run -d web",
  ].join("\n");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-euo", "pipefail", "-c", harness], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines[0], "compose:run -d api");
  assert.match(lines[1], /^docker:compose --env-file node-env -f node-base -f node-production --profile rollback -f \/repo\/docker-compose\.go-production\.yml -f \/repo\/deploy\/production\/go-candidate\.compose\.yml run -d web$/);
});

test("go-full rejects missing runtime dependency and passive wiring", () => {
  const compose = validGoCompose();
  assert.equal(validateResolvedCompose(profiles["go-full"], compose), true);

  const missingWorker = structuredClone(compose);
  delete missingWorker.services.worker;
  assert.throws(
    () => validateResolvedCompose(profiles["go-full"], missingWorker),
    /requires Compose service worker/,
  );

  const badWorkspaceGate = structuredClone(compose);
  badWorkspaceGate.services.workspace.environment.WORKSPACE_ENABLED = "TRUE";
  assert.throws(
    () => validateResolvedCompose(profiles["go-full"], badWorkspaceGate),
    /WORKSPACE_ENABLED=true/,
  );

  const badHealth = structuredClone(compose);
  badHealth.services.worker.healthcheck.test = ["CMD", "wget http://127.0.0.1:8787/readyz"];
  assert.throws(
    () => validateResolvedCompose(profiles["go-full"], badHealth),
    /parent-provided read-only health binary/,
  );

  const badUser = structuredClone(compose);
  badUser.services.workspace.user = "0:0";
  assert.throws(
    () => validateResolvedCompose(profiles["go-full"], badUser),
    /non-root 65532:65532 user/,
  );

  const badDataMount = structuredClone(compose);
  badDataMount.services.worker.volumes = [];
  assert.throws(
    () => validateResolvedCompose(profiles["go-full"], badDataMount),
    /legacy local data mount/,
  );
});

function initialState(mode) {
  const old = {
    "pg-old": { image: "sha256:pg-old", ref: "postgres:old", running: true, status: "running", health: "healthy", env: [], labels: {} },
    "api-old": { image: "sha256:api-old", ref: "duallane-api:old", running: true, status: "running", health: "healthy", env: [], labels: { version: "0.15.4", revision: "old-commit" } },
    "web-old": { image: "sha256:web-old", ref: "duallane-web:old", running: true, status: "running", health: "healthy", env: [], labels: { version: "0.15.4", revision: "old-commit" } },
    "v2ray-old": { image: "sha256:v2ray-old", ref: "v2ray:old", running: true, status: "running", health: "none", env: [], labels: {} },
  };
  const state = {
    daemon: "2",
    candidateModeFailure: mode === "permission-failure",
    candidateMountWritable: mode === "candidate-rw",
    candidateRootfsWritable: mode === "candidate-rootfs-rw",
    candidateEnvInvalid: mode === "node-candidate-env-invalid",
    candidateEnvDuplicate: mode === "node-candidate-env-duplicate",
    candidatePathMounted: mode === "node-candidate-path-mounted",
    restartUpdateFailure: mode === "node-fence-update-failure",
    restartStopFailure: mode === "node-fence-stop-failure",
    fenceIdentityDrift: mode === "node-fence-identity-drift",
    fenceDaemonRestart: mode === "node-fence-daemon-restart",
    fenceMultiple: mode === "node-fence-multiple",
    fenceProjectMismatch: mode === "node-fence-project-mismatch",
    fenceServiceMismatch: mode === "node-fence-service-mismatch",
    fenceInvalidIdentity: mode === "node-fence-invalid-identity",
    rollbackFenceMidFailure: mode === "rollback-fence-mid-failure",
    serviceInventoryFailure: mode === "inventory-failure",
    servicePsFailure: mode === "ps-failure",
    imageInspectFailure: mode === "image-inspect-failure",
   imageId: `sha256:${"a".repeat(64)}`,
   imageRevision: "a".repeat(40),
   imageVersion: "0.15.5",
    imageRevisionById: "a".repeat(40),
    imageVersionById: "0.15.5",
    migrationImage: `sha256:${"a".repeat(64)}`,
   migrationExitCode: 0,
   migrationContainerId: mode === "migration-invalid-id" ? "not-a-container-id" : "f".repeat(64),
   migrationOwnerProject: mode === "migration-owner-mismatch" ? "foreign-project" : "duallane",
   migrationOwnerRun: mode === "migration-run-mismatch" ? "b".repeat(64) : "",
    migrationDriftAfterWait: mode === "migration-post-wait-drift",
   databaseMutated: false,
    composeConfig: {
      services: {
        workspace: { image: "duallane-go-workspace:new" },
        worker: { image: "duallane-go-workspace:new" },
        migrate: { image: "duallane-go-workspace:new" },
      },
    },
    replacementOnUp: mode === "rollback-daemon",
   calls: [],
    candidateRuns: [],
    imageInspects: [],
   networks: {},
    tags: [],
    containers: old,
    current: {
      postgres: ["pg-old"],
      api: ["api-old"],
      web: ["web-old"],
      v2ray: ["v2ray-old"],
    },
    restoreIds: { api: "api-old", web: "web-old" },
    goUpgradeRecreateOld: goUpgradeRetryModes.includes(mode),
    goUpgradeOldRestoreFailureMode: mode === "go-upgrade-old-start-retry"
      ? "start"
      : mode === "go-upgrade-old-health-retry"
        ? "health"
        : "",
    goUpgradeOldRestoreFailureService: goUpgradeRetryModes.includes(mode) ? "workspace" : "",
    goUpgradeOldRestoreFailuresRemaining: mode === "go-upgrade-old-start-retry" || mode === "go-upgrade-old-health-retry"
      ? 1
      : 0,
    goUpgradeOldCreateCounts: {},
    goUpgradeOldCreatedIds: {},
    goUpgradeOldCreatedHistory: {},
    requireOldCreatedBeforeStart: goUpgradeRetryModes.includes(mode),
  };
  if (mode === "node-fence-multiple") {
    state.containers["api-old-2"] = {
      ...state.containers["api-old"],
      labels: { ...state.containers["api-old"].labels },
    };
    state.current.api = ["api-old", "api-old-2"];
  }
  if (mode === "rollback" || mode === "rollback-daemon" || mode === "rollback-fence-mid-failure") {
    state.containers["api-new"] = { image: "sha256:api-new", ref: "duallane-api:new", running: true, status: "running", health: "healthy", env: [], labels: { version: "0.15.5", revision: "new-commit" } };
    state.containers["web-new"] = { image: "sha256:web-new", ref: "duallane-web:new", running: true, status: "running", health: "healthy", env: [], labels: { version: "0.15.5", revision: "new-commit" } };
    const makeRollbackGoContainer = (service) => ({
      image: rollbackGoImage,
      ref: "duallane-" + service + ":new",
      running: true,
      status: "running",
      health: "healthy",
      env: [],
      restartName: "always",
      restartMax: 0,
      labels: {
        version: "0.15.5",
        revision: "new-commit",
        "com.docker.compose.project": "duallane",
        "com.docker.compose.service": service,
        "com.duallane.release-run": rollbackGoRunID,
      },
    });
    state.containers["p2p-new"] = makeRollbackGoContainer("p2p");
    state.containers["workspace-new"] = makeRollbackGoContainer("workspace");
    state.containers["worker-new"] = makeRollbackGoContainer("worker");
    state.current = { postgres: ["pg-old"], api: ["api-old"], web: ["web-old"], v2ray: ["v2ray-old"] };
  }
  if (mode === "node-active") {
    state.containers["workspace-live"] = {
      image: "sha256:workspace-live",
      ref: "duallane-go-workspace:live",
      running: true,
      status: "running",
      health: "healthy",
      env: [],
      user: "65532:65532",
      labels: {
        version: "0.15.5",
        revision: "go-commit",
        "com.docker.compose.project": "duallane",
        "com.docker.compose.service": "workspace",
      },
    };
  }
  if (mode === "candidate-collision") {
    state.containers["duallane-go-full-candidate-workspace-new-commit"] = {
      image: "sha256:foreign-candidate",
      ref: "duallane-workspace:foreign",
      running: true,
      status: "running",
      health: "healthy",
      env: [],
      user: "65532:65532",
      labels: {
        version: "0.15.5",
        revision: "new-commit",
        "com.duallane.release-owned": "true",
        "com.duallane.release-profile": "go-full",
        "com.duallane.release-commit": "new-commit",
        "com.duallane.release-service": "workspace",
        "com.docker.compose.project": "another-project",
        "com.docker.compose.service": "workspace",
      },
    };
  }
  if (mode === "success-daemon") {
    for (const service of ["p2p", "workspace", "worker", "web"]) {
      state.containers[service + "-new"] = {
        image: "sha256:" + service + "-new",
        ref: "duallane-" + service + ":new",
        running: true,
        status: "running",
        health: "healthy",
        env: [],
        labels: { version: "0.15.5", revision: "new-commit" },
      };
    }
  }
  if (mode === "image-ref-mismatch") {
    state.composeConfig.services.worker.image = "duallane-go-workspace:other";
  }
  if (mode === "image-id-invalid") {
    state.imageId = "sha256:not-a-canonical-id";
  }
  if (mode === "image-revision-mismatch") {
    state.imageRevisionById = "b".repeat(40);
  }
  if (mode === "image-version-mismatch") {
    state.imageVersionById = "0.15.4";
  }
  if (mode === "image-tag-metadata-drift") {
    state.imageRevision = "b".repeat(40);
    state.imageVersion = "0.15.4";
  }
  if (mode === "image-service-id") {
    for (const service of ["workspace", "worker"]) {
      const id = service + "-active";
      state.containers[id] = {
        image: state.imageId,
        ref: "duallane-go-workspace:new",
        running: true,
        status: "running",
        health: "healthy",
        labels: { version: "0.15.5", revision: "a".repeat(40) },
      };
      state.current[service] = [id];
    }
  }
  if (mode === "image-service-id-mismatch") {
    const id = "workspace-active";
    state.containers[id] = {
      image: `sha256:${"c".repeat(64)}`,
      ref: "duallane-go-workspace:new",
      running: true,
      status: "running",
      health: "healthy",
      labels: { version: "0.15.5", revision: "a".repeat(40) },
    };
    state.current.workspace = [id];
  }
  if (mode === "migration-tag-drift") {
    state.migrationImage = "sha256:" + "c".repeat(64);
  }
  if (mode === "migration-wrong-id") {
    state.migrationOverrideImage = "sha256:" + "c".repeat(64);
  }
  if (mode === "migration-exit-failure") {
    state.migrationExitCode = 1;
  }
  if (["go-upgrade-valid", "go-upgrade-interleaved", "go-upgrade-fence-failure", "go-success-snapshot", ...goUpgradeRetryModes].includes(mode)) {
    const oldIds = {
      p2p: "1".repeat(64),
      workspace: "2".repeat(64),
      worker: "3".repeat(64),
      web: "4".repeat(64),
    };
    const newIds = {
      p2p: "5".repeat(64),
      workspace: "6".repeat(64),
      worker: "7".repeat(64),
      web: "8".repeat(64),
    };
    const oldImages = {
      p2p: goUpgradeImage("1"),
      workspace: goUpgradeImage("2"),
      worker: goUpgradeImage("2"),
      web: goUpgradeImage("3"),
    };
    const newImage = goUpgradeImage("9");
    const makeGoContainer = (service, image, identity, revision) => ({
      image,
      ref: "duallane-" + service + ":go",
      identity,
      running: true,
      status: "running",
      health: "healthy",
      env: [],
      restartName: "always",
      restartMax: 0,
      labels: {
        version: "0.15.5",
        revision,
        "com.docker.compose.project": "duallane",
        "com.docker.compose.service": service,
      },
    });
    state.goUpgradeOldIds = oldIds;
    state.goUpgradeNewIds = newIds;
    state.goUpgradeNewStopFailureService = mode === "go-upgrade-fence-failure" ? "worker" : "";
    state.containers = {
      "api-old": {
        image: "sha256:" + "a".repeat(64),
        ref: "duallane-api:old",
        running: false,
        status: "exited",
        health: "healthy",
        env: [],
        labels: {
          version: "0.15.4",
          revision: "old-node-commit",
          "com.docker.compose.project": "duallane",
          "com.docker.compose.service": "api",
        },
      },
    };
    for (const service of Object.keys(oldIds)) {
      state.containers[oldIds[service]] = makeGoContainer(
        service,
        oldImages[service],
        oldIds[service],
        goUpgradeOldCommit,
      );
    }
    if (goUpgradeRetryModes.includes(mode)) {
      state.containers[oldIds.workspace].restartName = "on-failure";
      state.containers[oldIds.workspace].restartMax = 3;
    }
    for (const service of Object.keys(newIds)) {
      state.containers[newIds[service]] = makeGoContainer(
        service,
        newImage,
        newIds[service],
        goUpgradeNewCommit,
      );
    }
    state.current = {
      api: ["api-old"],
      p2p: [oldIds.p2p],
      workspace: [oldIds.workspace],
      worker: [oldIds.worker],
      web: [oldIds.web],
    };
    state.restoreIds = {};
    state.composeConfig = structuredClone(validGoCompose());
    state.composeConfig.name = "duallane";
    state.composeConfig.services.web.image = "registry.example/web:synthetic";
    state.composeConfig.volumes = { "legacy-data": {} };
    for (const service of ["p2p", "workspace", "worker", "web", "migrate"]) {
      state.composeConfig.services[service].image = service === "p2p"
        ? oldImages.p2p
        : service === "web"
          ? oldImages.web
          : oldImages.workspace;
    }
    if (goUpgradeRetryModes.includes(mode)) {
      state.containers["foreign-workspace"] = {
        ...makeGoContainer("workspace", "sha256:foreign", "g".repeat(64), "foreign-commit"),
        ref: "duallane-workspace:foreign",
        running: true,
        status: "running",
        health: "healthy",
        labels: {
          version: "9.9.9",
          revision: "foreign-commit",
          "com.docker.compose.project": "foreign-project",
          "com.docker.compose.service": "workspace",
        },
      };
    }
  }
  const identityById = {
    "pg-old": "f".repeat(64),
    "api-old": "a".repeat(64),
    "api-old-2": "6".repeat(64),
    "web-old": "e".repeat(64),
    "v2ray-old": "1".repeat(64),
    "api-new": "2".repeat(64),
    "web-new": "3".repeat(64),
    "api-old-restored": "4".repeat(64),
    "web-old-restored": "5".repeat(64),
    "p2p-new": "b".repeat(64),
    "workspace-new": "c".repeat(64),
    "worker-new": "d".repeat(64),
  };
  const fallbackIdentity = (id) => {
    let encoded = "";
    for (const character of id) encoded += character.charCodeAt(0).toString(16);
    return (encoded + "0".repeat(64)).slice(0, 64);
  };
  for (const [id, value] of Object.entries(state.containers)) {
    const ref = value.ref ?? "";
    const service = ref.match(/^duallane-(?:go-)?(api|p2p|workspace|worker|web):/)?.[1]
      ?? (ref.startsWith("postgres:") ? "postgres" : ref.startsWith("v2ray:") ? "v2ray" : "");
    value.identity = value.identity ?? identityById[id] ?? fallbackIdentity(id);
    value.labels ??= {};
    value.labels["com.docker.compose.project"] ??= "duallane";
    if (service) value.labels["com.docker.compose.service"] ??= service;
    value.restartName ??= "always";
    value.restartMax ??= 0;
  }
  if (mode === "node-fence-project-mismatch") {
    state.containers["api-old"].labels["com.docker.compose.project"] = "foreign-project";
  }
  if (mode === "node-fence-service-mismatch") {
    state.containers["api-old"].labels["com.docker.compose.service"] = "web";
  }
  if (mode === "node-fence-invalid-identity") {
    state.containers["api-old"].identity = "api-old";
  }
  return state;
}

const fakeDockerSource = String.raw`#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const statePath = process.env.FAKE_DOCKER_STATE;
const state = JSON.parse(readFileSync(statePath, "utf8"));
const args = process.argv.slice(2);
const save = () => writeFileSync(statePath, JSON.stringify(state));
const record = (value) => { state.calls.push(value); };
const container = (id) => state.containers[id]
  ?? Object.values(state.containers).find((value) => value.identity === id);
const serviceId = (service) => (state.current[service] ?? []).join("\n");
const formatValue = (value, format) => {
  if (format.includes(".Id")) return value.identity ?? "";
  if (format.includes(".Mounts")) {
    if (format.includes("println .Destination")) {
      return (value.mounts ?? []).map((mount) => mount.Destination).join("\n") + ((value.mounts ?? []).length ? "\n" : "");
    }
    return (value.mounts ?? [])
      .filter((mount) => mount.Destination === "/app/data")
      .map((mount) => String(mount.RW))
      .join("");
  }
  if (format.includes(".HostConfig.ReadonlyRootfs")) return value.readOnlyRootfs ? "true" : "false";
  if (format.includes(".HostConfig.RestartPolicy.Name")) return value.restartName ?? "no";
  if (format.includes(".HostConfig.RestartPolicy.MaximumRetryCount")) return String(value.restartMax ?? 0);
  if (format.includes(".Config.Labels")) {
    const match = format.match(/index \.Config\.Labels \"([^\"]+)\"/);
    if (!match) return "";
    if (match[1] === "org.opencontainers.image.version") return value.labels?.version ?? "";
    if (match[1] === "org.opencontainers.image.revision") return value.labels?.revision ?? "";
    return value.labels?.[match[1]] ?? "";
  }
  if (format.includes(".Config.Image")) return value.ref;
  if (format.includes(".Config.User")) return value.user ?? "";
  if (format.includes(".Image")) return value.image;
  if (format.includes(".State.Running")) return value.running ? "true" : "false";
  if (format.includes(".State.Health.Status")) return value.health;
  if (format.includes(".State.Status")) return value.status;
  if (format.includes(".HostConfig.PortBindings")) return "null";
  if (format.includes(".Config.Env")) return (value.env ?? []).join("\n") + ((value.env ?? []).length ? "\n" : "");
  if (format.includes("json .NetworkSettings.Networks")) return JSON.stringify(value.networks ?? {});
  return "";
};

if (args[0] === "set-daemon") {
  state.daemon = args[1]; save(); process.exit(0);
}
if (args[0] === "set-current") {
  state.current[args[1]] = [args[2]]; save(); process.exit(0);
}
if (args[0] === "set-running") {
  const value = container(args[1]);
  if (!value) process.exit(1);
  value.running = args[2] === "true"; value.status = value.running ? "running" : "exited"; save(); process.exit(0);
}
if (args[0] === "rm") {
  const ids = args.slice(1).filter((value) => !value.startsWith("-"));
  for (const id of ids) {
    const actualKey = Object.hasOwn(state.containers, id)
      ? id
      : Object.entries(state.containers).find(([, value]) => value.identity === id)?.[0] ?? id;
    for (const network of Object.values(state.networks)) {
      delete network.containers[id];
      delete network.containers[actualKey];
    }
    delete state.containers[actualKey];
    for (const [service, currentIds] of Object.entries(state.current)) {
      state.current[service] = currentIds.filter((currentId) => currentId !== id && currentId !== actualKey);
    }
  }
  record(["rm", ...ids]); save(); process.exit(0);
}
if (args[0] === "ps") {
  const filters = [];
  for (let index = 1; index < args.length - 1; index += 1) {
    if (args[index] === "--filter") filters.push(args[index + 1]);
  }
  const ids = Object.entries(state.containers).filter(([id, value]) => filters.every((filter) => {
    const [key, expected] = filter.split("=");
    if (key === "status") return expected === "running" ? value.running : true;
    if (key === "name") {
      const match = expected.match(/^\^\/(.*)\$$/);
      return match ? (value.name ?? id) === match[1] : false;
    }
    if (key === "label") {
      const labelFilter = filter.slice("label=".length);
      const separator = labelFilter.indexOf("=");
      const label = labelFilter.slice(0, separator);
      const labelValue = labelFilter.slice(separator + 1);
      return value.labels?.[label] === labelValue;
    }
    return false;
  })).map(([id, value]) => {
    value.name ??= id;
    return id;
  });
  process.stdout.write(ids.join("\n")); process.exit(0);
}
if (args[0] === "network") {
  const operation = args[1];
  if (operation === "inspect") {
    const name = args[2];
    const network = state.networks[name];
    if (!network) process.exit(1);
    const index = args.indexOf("--format");
    const format = index >= 0 ? args[index + 1] : "";
    if (format.includes("com.duallane.release-owned")) process.stdout.write(network.labels.owned);
    else if (format.includes("com.duallane.release-profile")) process.stdout.write(network.labels.profile);
    else if (format.includes("com.duallane.release-commit")) process.stdout.write(network.labels.commit);
    process.exit(0);
  }
  if (operation === "create") {
    const name = args.at(-1);
    const labels = { owned: "", profile: "", commit: "" };
    for (let index = 2; index < args.length - 1; index += 1) {
      if (args[index] !== "--label") continue;
      const [key, value] = args[index + 1].split("=");
      if (key === "com.duallane.release-owned") labels.owned = value;
      if (key === "com.duallane.release-profile") labels.profile = value;
      if (key === "com.duallane.release-commit") labels.commit = value;
    }
    state.networks[name] = { labels, containers: {} };
    record(["network-create", name]); save(); process.stdout.write(name); process.exit(0);
  }
  if (operation === "rm") {
    const name = args[2];
    if (!state.networks[name] || Object.keys(state.networks[name].containers).length > 0) process.exit(1);
    delete state.networks[name]; record(["network-rm", name]); save(); process.exit(0);
  }
  if (operation === "connect") {
    const aliasIndex = args.indexOf("--alias");
    const alias = aliasIndex >= 0 ? args[aliasIndex + 1] : "";
    const name = args[aliasIndex >= 0 ? aliasIndex + 2 : 2];
    const id = args[aliasIndex >= 0 ? aliasIndex + 3 : 3];
    if (!state.networks[name] || !container(id)) process.exit(1);
    state.networks[name].containers[id] = { Name: id, Aliases: alias ? [alias] : [] };
    state.containers[id].networks ??= {};
    state.containers[id].networks[name] = { Aliases: alias ? [alias] : [] };
    record(["network-connect", name, id, alias]); save(); process.exit(0);
  }
  if (operation === "disconnect") {
    const name = args[2];
    const id = args[3];
    if (!state.networks[name] || !container(id)) process.exit(1);
    delete state.networks[name].containers[id];
    if (container(id).networks) delete container(id).networks[name];
    record(["network-disconnect", name, id]); save(); process.exit(0);
  }
}
if (args[0] === "systemctl" && args[1] === "show") {
  process.stdout.write(state.daemon); process.exit(0);
}
if (args[0] === "info") process.exit(0);
if (args[0] === "update") {
  const restartIndex = args.findIndex((value) => value === "--restart" || value.startsWith("--restart="));
  const restartSpec = restartIndex < 0
    ? ""
    : args[restartIndex].startsWith("--restart=") ? args[restartIndex].slice("--restart=".length) : args[restartIndex + 1];
  const id = args.at(-1);
  const value = container(id);
  if (!value || !restartSpec) process.exit(1);
  if ((state.restartUpdateFailure && value.ref === "duallane-api:old") ||
      (state.rollbackFenceMidFailure && value.ref === "duallane-workspace:new")) {
    record(["update-failed", id, restartSpec]); save(); process.exit(1);
  }
  if (restartSpec === "no" || restartSpec === "always" || restartSpec === "unless-stopped") {
    value.restartName = restartSpec;
    value.restartMax = 0;
  } else if (restartSpec === "on-failure") {
    value.restartName = "on-failure";
    value.restartMax = 0;
  } else if (restartSpec.startsWith("on-failure:")) {
    const retryCount = restartSpec.slice("on-failure:".length);
    if (!/^\d+$/.test(retryCount)) process.exit(1);
    value.restartName = "on-failure";
    value.restartMax = Number(retryCount);
  } else process.exit(1);
  if (state.fenceDaemonRestart && value.ref === "duallane-api:old") state.daemon = "3";
  record(["update", id, restartSpec]); save(); process.exit(0);
}
if (args[0] === "stop") {
  const id = args.at(-1);
  const value = container(id);
  if (!value) process.exit(1);
  const service = value.labels?.["com.docker.compose.service"] ?? "";
  if (state.goUpgradeNewStopFailureService === service &&
      value.labels?.revision === "b".repeat(40)) {
    record(["go-upgrade-stop-failed", service, id]); save(); process.exit(1);
  }
  if (state.restartStopFailure && value.ref === "duallane-api:old") {
    record(["stop-failed", id]); save(); process.exit(1);
  }
  value.running = false;
  value.status = "exited";
  if (state.fenceDaemonRestart && value.ref === "duallane-api:old") state.daemon = "3";
  record(["stop", id]); save(); process.exit(0);
}
if (args[0] === "start") {
  const value = container(args[1]);
  if (!value) process.exit(1);
  const service = value.labels?.["com.docker.compose.service"] ?? "";
  if (value.recreatedOld && state.requireOldCreatedBeforeStart) {
    let recovery = "";
    if (process.env.RELEASE_RECOVERY_FILE) {
      try {
        recovery = readFileSync(process.env.RELEASE_RECOVERY_FILE, "utf8");
      } catch {
        recovery = "";
      }
    }
    const prefix = "go_upgrade_old_created\t" + service + "\t" + args[1] + "\t";
    if (!recovery.split("\n").some((line) => line.startsWith(prefix))) {
      record(["old-start-before-record", service, args[1]]); save(); process.exit(1);
    }
  }
  if (value.recreatedOld && service === state.goUpgradeOldRestoreFailureService &&
      state.goUpgradeOldRestoreFailuresRemaining > 0) {
    state.goUpgradeOldRestoreFailuresRemaining -= 1;
    if (state.goUpgradeOldRestoreFailureMode === "start") {
      record(["go-up-old-start-failed", service, args[1]]); save(); process.exit(1);
    }
    value.running = true;
    value.status = "running";
    value.health = "unhealthy";
    record(["go-up-old-health-failed", service, args[1]]); save(); process.exit(0);
  }
  value.running = true;
  value.status = "running";
  if (value.health === "unknown" || (value.recreatedOld && value.health === "unhealthy")) value.health = "healthy";
  if (value.migration) state.databaseMutated = true;
  record(["start", args[1]]); save(); process.stdout.write(args[1] + "\n"); process.exit(0);
}
if (args[0] === "wait") {
  const value = container(args[1]);
  if (!value) process.exit(1);
  value.running = false;
  value.status = "exited";
  if (value.migration && state.migrationDriftAfterWait) value.image = "sha256:" + "c".repeat(64);
  record(["wait", args[1]]); save();
  process.stdout.write(String(state.migrationExitCode ?? 0));
  process.exit(0);
}
if (args[0] === "image" && args[1] === "tag") {
  state.tags.push({ image: args[2], ref: args[3] }); record(["tag", args[2], args[3]]); save(); process.exit(0);
}
if (args[0] === "image" && args[1] === "inspect") {
  if (state.imageInspectFailure) process.exit(1);
  const index = args.indexOf("--format");
  const format = index >= 0 ? args[index + 1] : "";
  state.imageInspects.push({ target: args[2], format });
  if (format.includes(".Id")) process.stdout.write(state.imageId);
  else if (format.includes("org.opencontainers.image.revision")) {
    process.stdout.write(args[2] === state.imageId ? state.imageRevisionById : state.imageRevision);
  } else if (format.includes("org.opencontainers.image.version")) {
    process.stdout.write(args[2] === state.imageId ? state.imageVersionById : state.imageVersion);
  }
  else process.exit(1);
  save();
  process.exit(0);
}
if (args[0] === "inspect") {
  const id = args[1];
  const value = container(id);
  if (!value) process.exit(1);
  const index = args.indexOf("--format");
  const format = index >= 0 ? args[index + 1] : "";
  let output = formatValue(value, format);
  if (format.includes(".Id") && state.fenceIdentityDrift && value.ref === "duallane-api:old") {
    value.identityInspects = (value.identityInspects ?? 0) + 1;
    if (value.identityInspects >= 2) output = "b".repeat(64);
  }
  process.stdout.write(output);
  save();
  process.exit(0);
}
if (args[0] === "exec") {
  if (!container(args[1])) process.exit(1);
  if (state.candidateModeFailure && args.some((value) => value === "--expect-mode=candidate-health-only" || value === "--expect-mode=validate-only")) process.exit(1);
  process.exit(0);
}
if (args[0] === "compose") {
  const commandIndex = args.findIndex((value) => ["config", "ps", "stop", "rm", "up", "run", "create"].includes(value));
  const command = args[commandIndex];
  const service = args.at(-1);
  if (command === "config" && args.includes("--services")) {
    if (state.serviceInventoryFailure) process.exit(1);
    process.stdout.write("postgres\nmigrate\napi\np2p\nworkspace\nworker\nweb\nv2ray\n");
    process.exit(0);
  }
  if (command === "config" && args.includes("--format") && args.includes("json")) {
    process.stdout.write(JSON.stringify(state.composeConfig));
    process.exit(0);
  }
  if (command === "ps") {
    if (state.servicePsFailure) process.exit(1);
    process.stdout.write(serviceId(service));
    process.exit(0);
  }
  if (command === "stop") {
    for (const id of state.current[service] ?? []) {
      if (container(id)) { container(id).running = false; container(id).status = "exited"; }
    }
    record(["stop", service]); save(); process.exit(0);
  }
  if (command === "rm") {
    for (const id of state.current[service] ?? []) delete state.containers[id];
    delete state.current[service]; record(["rm", service]); save(); process.exit(0);
  }
  if (command === "run") {
    const nameIndex = args.indexOf("--name");
    const candidateName = nameIndex >= 0 ? args[nameIndex + 1] : "";
    if (!candidateName || !service) process.exit(1);
    const env = [];
    for (let index = 0; index < args.length - 1; index += 1) {
      if (args[index] === "-e" || args[index] === "--env") env.push(args[index + 1]);
    }
    if (service === "api" && state.candidateEnvInvalid) {
      const index = env.indexOf("DATABASE_AUTO_MIGRATE=false");
      if (index >= 0) env[index] = "DATABASE_AUTO_MIGRATE=true";
    }
    if (service === "api" && state.candidateEnvDuplicate) env.push("WORKSPACE_ENABLED=true");
    const tmpfs = [];
    for (let index = 0; index < args.length - 1; index += 1) {
      if (args[index] === "--tmpfs") tmpfs.push(args[index + 1]);
    }
    const labels = {
      version: "0.15.5",
      revision: "new-commit",
      "com.docker.compose.project": process.env.COMPOSE_PROJECT_NAME ?? "duallane",
      "com.docker.compose.service": service,
    };
    for (let index = 0; index < args.length - 1; index += 1) {
      if (args[index] !== "--label") continue;
      const separator = args[index + 1].indexOf("=");
      if (separator <= 0) process.exit(1);
      labels[args[index + 1].slice(0, separator)] = args[index + 1].slice(separator + 1);
    }
    state.containers[candidateName] = {
      image: "sha256:" + service + "-candidate",
      ref: "duallane-" + service + ":new",
      identity: candidateName,
      running: true,
      status: "running",
      health: "healthy",
      env,
      user: service === "workspace" || service === "worker" ? "65532:65532" : "",
      mounts: service === "workspace" || service === "worker"
        ? [{ Destination: "/app/data", RW: state.candidateMountWritable }]
        : service === "api" && state.candidatePathMounted
          ? [{ Destination: "/tmp", RW: true }]
        : [],
      readOnlyRootfs: !state.candidateRootfsWritable,
      restartName: "always",
      restartMax: 0,
      networks: service === "workspace" || service === "worker"
        ? { duallane_default: { Aliases: args.includes("--use-aliases") ? [service] : [] } }
        : {},
      tmpfs,
      labels,
    };
    state.candidateRuns.push({
      service,
      candidateName,
      env: [...env],
      mounts: [...state.containers[candidateName].mounts],
      tmpfs: [...tmpfs],
    });
    const candidateNetwork = process.env.DUALLANE_GO_CANDIDATE_NETWORK;
    if (candidateNetwork) {
      state.containers[candidateName].networks[candidateNetwork] = {
        Aliases: args.includes("--use-aliases") ? [service] : [],
      };
      state.networks[candidateNetwork] ??= { labels: { owned: "true", profile: "go-full", commit: "new-commit" }, containers: {} };
      state.networks[candidateNetwork].containers[candidateName] = {
        Name: candidateName,
        Aliases: args.includes("--use-aliases") ? [service] : [],
      };
    }
    state.current[service] = [candidateName];
    record(["run", service, candidateName,
      Boolean(state.containers["duallane-go-full-candidate-p2p-new-commit"]),
      Boolean(state.containers["duallane-go-full-candidate-workspace-new-commit"]),
      tmpfs.includes("/tmp") ]);
    save(); process.stdout.write(candidateName + "\n"); process.exit(0);
  }
  if ((command === "create" || command === "up") && service === "migrate") {
    if ((state.current.migrate ?? []).length > 0) process.exit(1);
    const overrideIndex = args.findIndex((value) => value.endsWith(".go-image.override.yml"));
    let migrationImage = state.migrationImage;
    let migrationRunLabel = "";
    let overrideUsed = false;
    if (overrideIndex >= 0) {
      const override = readFileSync(args[overrideIndex], "utf8");
      const match = override.match(/migrate:\s*\n\s+image:\s+(sha256:[0-9a-f]{64})/);
      const runMatch = override.match(/migrate:[\s\S]*?com\.duallane\.release-run:\s+([0-9a-f]{64})/);
      if (!match || !runMatch) process.exit(1);
      migrationImage = match[1];
      migrationRunLabel = runMatch[1];
      overrideUsed = true;
    }
    if (state.migrationOverrideImage) migrationImage = state.migrationOverrideImage;
    const id = state.migrationContainerId;
    state.containers[id] = {
      name: "duallane-go-migrate",
      migration: true,
      image: migrationImage,
      ref: "duallane-go-workspace:new",
      running: false,
      status: "created",
      health: "none",
      env: [],
      labels: {
        revision: state.imageRevision,
        version: state.imageVersion,
        "com.docker.compose.project": state.migrationOwnerProject,
        "com.docker.compose.service": "migrate",
        "com.duallane.release-run": state.migrationOwnerRun || migrationRunLabel,
      },
    };
    state.current.migrate = [id];
    record(["migration-create", id, overrideUsed, command === "up" ? "up-no-start" : "create"]);
    save(); process.exit(0);
  }
  if (command === "up" || (command === "create" && process.env.GO_UPGRADE_RESTORE_OLD === "true")) {
    if (process.env.GO_UPGRADE_RESTORE_OLD === "true" && state.goUpgradeOldIds?.[service]) {
      if (state.goUpgradeRecreateOld) {
        const oldId = state.goUpgradeOldIds[service];
        const previousId = (state.current[service] ?? [])[0] ?? oldId;
        const previous = container(previousId);
        const source = previous?.recreatedOld ? previous : container(oldId);
        if (!source) process.exit(1);
        const prefixes = { p2p: "c", workspace: "d", worker: "e", web: "f" };
        state.goUpgradeOldCreateCounts[service] = (state.goUpgradeOldCreateCounts[service] ?? 0) + 1;
        const count = state.goUpgradeOldCreateCounts[service];
        const id = prefixes[service].repeat(62) + count.toString(16).padStart(2, "0");
        state.containers[id] = {
          ...source,
          identity: id,
          running: false,
          status: "created",
          health: "healthy",
          restartName: "always",
          restartMax: 0,
          recreatedOld: true,
          networks: {},
          env: [...(source.env ?? [])],
          labels: { ...(source.labels ?? {}) },
        };
        if (previous?.recreatedOld && previousId !== oldId) delete state.containers[previousId];
        state.goUpgradeOldCreatedIds[service] = id;
        state.goUpgradeOldCreatedHistory[service] ??= [];
        state.goUpgradeOldCreatedHistory[service].push(id);
        state.current[service] = [id];
        record(["go-up-old-create", service, id, count, previousId, args.includes("--no-start") ? "up-no-start" : "up-started"]);
        save(); process.exit(0);
      }
      const id = state.goUpgradeOldIds[service];
      const value = container(id);
      if (!value) process.exit(1);
      const noStart = args.includes("--no-start");
      value.running = !noStart;
      value.status = noStart ? "created" : "running";
      value.health = "healthy";
      value.restartName = "always";
      value.restartMax = 0;
      state.current[service] = [id];
      record([
        "go-up-old",
        service,
        id,
        args.includes(process.env.GO_UPGRADE_COMPOSE_FILE ?? "") ? "canonical" : "wrong-compose",
        noStart ? "up-no-start" : "up-started",
      ]); save(); process.exit(0);
    }
    const id = state.restoreIds[service];
    if (!id || !container(id)) process.exit(1);
    let restoredId = id;
    const noStart = args.includes("--no-start");
    if (state.replacementOnUp) {
      restoredId = id + "-restored";
      state.containers[restoredId] = {
        ...container(id),
        identity: restoredId === "api-old-restored" ? "4".repeat(64) : "5".repeat(64),
        running: !noStart,
        status: noStart ? "created" : "running",
        networks: {},
      };
      delete state.containers[id];
    } else {
      container(id).running = !noStart;
      container(id).status = noStart ? "created" : "running";
      if (!noStart && container(id).health === "none") container(id).health = "healthy";
    }
    state.current[service] = [restoredId];
    record(["up", service, noStart ? "up-no-start" : "up-started"]); save(); process.exit(0);
  }
}
process.exit(1);
`;

async function runFakeHarness(mode) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "duallane-production-deploy-"));
  const statePath = path.join(directory, "state.json");
  const fakeDocker = path.join(directory, "fake-docker.mjs");
  const docker = path.join(directory, "docker");
  const systemctl = path.join(directory, "systemctl");
  const sleep = path.join(directory, "sleep");
  const state = initialState(mode);
  const goUpgradeModes = [
    "go-upgrade-valid",
    "go-upgrade-interleaved",
    "go-upgrade-fence-failure",
    ...goUpgradeRetryModes,
  ];
  const goUpgradeArtifacts = goUpgradeModes.includes(mode)
    ? await writeGoUpgradeSnapshotArtifacts(directory)
    : null;
  await writeFile(statePath, JSON.stringify(state));
  await writeFile(fakeDocker, fakeDockerSource, { mode: 0o700 });
  await writeFile(docker, `#!/usr/bin/env bash\nexec node "${fakeDocker}" "$@"\n`, { mode: 0o700 });
  await writeFile(systemctl, `#!/usr/bin/env bash\nif [[ "$1" == show ]]; then exec node "${fakeDocker}" systemctl "$@"; fi\nexit 1\n`, { mode: 0o700 });
  await writeFile(sleep, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o700 });

  const driver = String.raw`
set -Eeuo pipefail
source "$RELEASE_HELPER"
# These lifecycle tests model a successful read-only gateway probe. Its
# actual HTTP/WebSocket contract has dedicated unit and container gates.
gateway_smoke_attempt=0
release_run_previous_gateway_smoke() {
  if [[ "$MODE" == go-upgrade-old-smoke-retry && "$gateway_smoke_attempt" == 0 ]]; then
    gateway_smoke_attempt=1
    release_append_recovery_record 'gateway_smoke_model=failed'
    return 1
  fi
  release_append_recovery_record 'gateway_smoke_model=passed'
}
# Models only lifecycle ordering, not a real database/provider drain.
release_require_drained_runtime() {
  release_append_recovery_record "drain_model_$1=ready"
}
release_capture_go_volume_authority() {
  [[ -f "$1" ]] || return 1
  (umask 077; printf '{}\n' > "$2")
}
compose() {
  if [[ -n "$RELEASE_GO_IMAGE_OVERRIDE_FILE" ]]; then
    docker compose -f "$RELEASE_GO_IMAGE_OVERRIDE_FILE" "$@"
  else
    docker compose "$@"
  fi
}
wait_for_docker() { docker info >/dev/null; }
candidate_compose() { docker compose "$@"; }
rollback_compose() { docker compose "$@"; }
go_upgrade_rollback_compose() {
  GO_UPGRADE_RESTORE_OLD=true docker compose \
    --project-name "$RELEASE_GO_UPGRADE_OLD_PROJECT" \
    -f "$RELEASE_GO_UPGRADE_OLD_COMPOSE_FILE" "$@"
}
current_commit="new-commit"
expected_app_version="0.15.5"
docker_started_before="1"
if [[ "$MODE" == image-* || "$MODE" == migration-* ]]; then
  current_commit="$(printf 'a%.0s' {1..40})"
fi
if [[ "$MODE" == go-upgrade || "$MODE" == go-upgrade-valid || "$MODE" == go-upgrade-interleaved || "$MODE" == go-upgrade-fence-failure || "$MODE" == go-upgrade-old-start-retry || "$MODE" == go-upgrade-old-health-retry || "$MODE" == go-upgrade-old-smoke-retry ]]; then
  RELEASE_GO_UPGRADE=true
  current_commit="$(printf 'b%.0s' {1..40})"
  expected_app_version="0.16.0"
fi
if [[ "$MODE" == go-success-snapshot ]]; then
  current_commit="$(printf 'b%.0s' {1..40})"
fi
if [[ "$MODE" == node-active || "$MODE" == node-candidate || "$MODE" == node-candidate-env-invalid || "$MODE" == node-candidate-env-duplicate || "$MODE" == node-candidate-path-mounted || "$MODE" == node-fence-* ]]; then
  release_load_profile node-default
else
  release_load_profile go-full
fi
if [[ "$MODE" == rollback || "$MODE" == rollback-daemon || "$MODE" == rollback-fence-mid-failure ]]; then
  RELEASE_GO_RUN_ID="$(printf 'd%.0s' {1..64})"
  RELEASE_GO_IMAGE_ID="sha256:$(printf '9%.0s' {1..64})"
  RELEASE_GO_P2P_IMAGE_ID="$RELEASE_GO_IMAGE_ID"
  RELEASE_GO_WEB_IMAGE_ID="$RELEASE_GO_IMAGE_ID"
  # These fake-Docker cases model fencing/restart order, not real Compose,
  # file or volume authority. Those checks have dedicated authority tests and
  # the opt-in real coordinator gate; never claim this model proves them.
  release_verify_activation_authority() {
    release_append_recovery_record 'authority_model=ready'
  }
fi
RELEASE_SNAPSHOT_FILE="$STATE_PATH.snapshot"
RELEASE_RECOVERY_FILE="$STATE_PATH.recovery"
export RELEASE_SNAPSHOT_FILE RELEASE_RECOVERY_FILE
if [[ "$MODE" == go-upgrade-valid || "$MODE" == go-upgrade-interleaved || "$MODE" == go-upgrade-fence-failure || "$MODE" == go-upgrade-old-start-retry || "$MODE" == go-upgrade-old-health-retry || "$MODE" == go-upgrade-old-smoke-retry ]]; then
  RELEASE_PREVIOUS_RELEASE_SNAPSHOT="$GO_UPGRADE_SNAPSHOT"
  RELEASE_GO_IMAGE_ID="sha256:$(printf '9%.0s' {1..64})"
  RELEASE_GO_P2P_IMAGE_ID="$RELEASE_GO_IMAGE_ID"
  RELEASE_GO_WEB_IMAGE_ID="$RELEASE_GO_IMAGE_ID"
fi
if [[ "$MODE" == snapshot ]]; then
  release_snapshot_app_state "$RELEASE_SNAPSHOT_FILE"
  for id in pg-old api-old web-old v2ray-old; do docker set-running "$id" false; done
  release_restore_daemon_snapshot
elif [[ "$MODE" == image-* ]]; then
  release_load_profile go-full
  if [[ "$MODE" == image-service-id || "$MODE" == image-service-id-mismatch ]]; then
    release_verify_go_image_identity
    if release_verify_go_service_image_id workspace; then
      [[ "$MODE" == image-service-id ]] || {
        echo "image-service-id-mismatch unexpectedly passed" >&2
        exit 1
      }
    else
      [[ "$MODE" == image-service-id-mismatch ]] || {
        echo "image-service-id unexpectedly failed" >&2
        exit 1
      }
    fi
 elif release_verify_go_image_identity; then
    [[ "$MODE" == image-identity || "$MODE" == image-tag-metadata-drift ]] || {
     echo "image identity failure mode unexpectedly passed" >&2
      exit 1
    }
    grep -Fxq "go_image_ref=duallane-go-workspace:new" "$STATE_PATH.recovery"
    grep -Fxq "go_image_id=sha256:$(printf 'a%.0s' {1..64})" "$STATE_PATH.recovery"
    grep -Fxq "go_image_revision=$(printf 'a%.0s' {1..40})" "$STATE_PATH.recovery"
    grep -Fxq "go_image_version=0.15.5" "$STATE_PATH.recovery"
  else
    [[ "$MODE" != image-identity ]] || {
      echo "valid image identity unexpectedly failed" >&2
      exit 1
    }
  fi
elif [[ "$MODE" == migration-* ]]; then
  release_load_profile go-full
  release_verify_go_image_identity
  if release_run_go_migration_and_verify; then
    [[ "$MODE" == migration-image || "$MODE" == migration-tag-drift ]] || {
      echo "migration verification failure mode unexpectedly passed" >&2
      exit 1
    }
  else
    [[ "$MODE" == migration-wrong-id || "$MODE" == migration-exit-failure || "$MODE" == migration-invalid-id || "$MODE" == migration-owner-mismatch || "$MODE" == migration-run-mismatch || "$MODE" == migration-post-wait-drift ]] || {
      echo "valid migration image unexpectedly failed" >&2
      exit 1
    }
  fi
elif [[ "$MODE" == go-upgrade ]]; then
  release_snapshot_app_state "$RELEASE_SNAPSHOT_FILE"
  if release_snapshot_validate_for_go_cutover; then
    echo "Go-to-Go upgrade unexpectedly passed without a frozen resolved Compose snapshot" >&2
    exit 1
  fi
elif [[ "$MODE" == go-success-snapshot ]]; then
  RELEASE_GO_IMAGE_ID="sha256:$(printf '9%.0s' {1..64})"
  # The fake lifecycle models an already completed migration. Runtime tests
  # separately execute the real migration/check binaries against PostgreSQL.
  RELEASE_GO_MIGRATION_VERIFIED=true
  PROJECT_DIR="$(dirname "$(dirname "$(dirname "$RELEASE_HELPER")")")"
  for service in p2p workspace worker web; do
    case "$service" in
      p2p) new_id="$(printf '5%.0s' {1..64})" ;;
      workspace) new_id="$(printf '6%.0s' {1..64})" ;;
      worker) new_id="$(printf '7%.0s' {1..64})" ;;
      web) new_id="$(printf '8%.0s' {1..64})" ;;
    esac
    docker set-current "$service" "$new_id"
  done
  release_capture_successful_go_snapshot
  success_snapshot="$(sed -n 's/^go_upgrade_success_snapshot=//p' "$RELEASE_RECOVERY_FILE")"
  [[ -n "$success_snapshot" && -f "$success_snapshot" ]]
  [[ -f "$success_snapshot.compose.json" && -f "$success_snapshot.external.json" && -f "$success_snapshot.volumes.json" ]]
  [[ "$(stat -c '%a' "$success_snapshot")" == 600 ]]
  [[ "$(stat -c '%a' "$success_snapshot.compose.json")" == 600 ]]
  [[ "$(stat -c '%a' "$success_snapshot.external.json")" == 600 ]]
  [[ "$(stat -c '%a' "$success_snapshot.volumes.json")" == 600 ]]
  release_append_recovery_record "go_success_snapshot_modes=600,600,600,600"
elif [[ "$MODE" == go-upgrade-valid || "$MODE" == go-upgrade-interleaved || "$MODE" == go-upgrade-fence-failure || "$MODE" == go-upgrade-old-start-retry || "$MODE" == go-upgrade-old-health-retry || "$MODE" == go-upgrade-old-smoke-retry ]]; then
  release_verify_pinned_volume_authority() {
    [[ -f "$1" && -f "$2" ]] || return 1
    release_append_recovery_record "volume_authority_verified=true"
  }
  release_snapshot_validate_for_go_cutover
  [[ "$RELEASE_GO_UPGRADE_VALIDATED" == true ]]
  release_go_upgrade_fence_old_services
  for service in p2p workspace worker web; do
    if [[ "$MODE" == go-upgrade-interleaved && "$service" == web ]]; then
      continue
    fi
    case "$service" in
      p2p) new_id="$(printf '5%.0s' {1..64})" ;;
      workspace) new_id="$(printf '6%.0s' {1..64})" ;;
      worker) new_id="$(printf '7%.0s' {1..64})" ;;
      web) new_id="$(printf '8%.0s' {1..64})" ;;
    esac
    release_go_upgrade_note_new_service_attempt "$service"
    docker set-current "$service" "$new_id"
    release_go_upgrade_record_new_owner "$service" "$new_id"
  done
  if [[ "$MODE" == go-upgrade-fence-failure ]]; then
    if release_go_upgrade_recover_all_services; then
      echo "Go-to-Go recovery unexpectedly passed after a new-owner fence failure" >&2
      exit 1
    fi
  elif [[ "$MODE" == go-upgrade-old-start-retry || "$MODE" == go-upgrade-old-health-retry || "$MODE" == go-upgrade-old-smoke-retry ]]; then
    if [[ "$MODE" == go-upgrade-old-smoke-retry ]]; then
      if release_go_upgrade_rollback_application; then
        echo "Go-to-Go rollback unexpectedly passed on its injected first attempt" >&2
        exit 1
      fi
      release_go_upgrade_rollback_application
    else
      if release_go_upgrade_recover_all_services; then
        echo "Go-to-Go recovery unexpectedly passed on its injected first attempt" >&2
        exit 1
      fi
      release_go_upgrade_recover_all_services
    fi
  else
    release_go_upgrade_recover_all_services
  fi
elif [[ "$MODE" == permission-failure ]]; then
  release_snapshot_app_state "$RELEASE_SNAPSHOT_FILE"
  release_prepare_candidate_network
  if release_start_candidate workspace; then
    echo "permission-failure candidate unexpectedly passed" >&2
    exit 1
  fi
  [[ "$(docker inspect api-old --format '{{.State.Running}}')" == true ]]
  release_cleanup_candidates
  release_cleanup_candidate_network
elif [[ "$MODE" == node-active ]]; then
  if release_snapshot_validate_for_go_cutover; then
    echo "node-default unexpectedly allowed an active Go service" >&2
    exit 1
  fi
elif [[ "$MODE" == node-fence-* ]]; then
  release_snapshot_app_state "$RELEASE_SNAPSHOT_FILE"
  if release_stop_service_and_confirm api; then
    [[ "$MODE" == node-fence-success || "$MODE" == node-fence-daemon-restart ]] || {
      echo "fencing failure mode unexpectedly passed" >&2
      exit 1
    }
    if [[ "$MODE" == node-fence-daemon-restart ]]; then
      release_restore_daemon_snapshot
    fi
  else
    [[ "$MODE" == node-fence-update-failure || "$MODE" == node-fence-stop-failure || "$MODE" == node-fence-identity-drift || "$MODE" == node-fence-multiple || "$MODE" == node-fence-project-mismatch || "$MODE" == node-fence-service-mismatch || "$MODE" == node-fence-invalid-identity ]] || {
      echo "valid restart-policy fencing unexpectedly failed" >&2
      exit 1
    }
  fi
elif [[ "$MODE" == node-candidate || "$MODE" == node-candidate-env-invalid || "$MODE" == node-candidate-env-duplicate || "$MODE" == node-candidate-path-mounted ]]; then
  if release_start_candidate api; then
    [[ "$MODE" == node-candidate ]] || {
      echo "unsafe Node candidate environment unexpectedly passed" >&2
      exit 1
    }
  else
    [[ "$MODE" != node-candidate ]] || {
      echo "valid Node candidate environment unexpectedly failed" >&2
      exit 1
    }
  fi
  release_cleanup_candidates
elif [[ "$MODE" == candidate-lifecycle ]]; then
  release_start_candidates
elif [[ "$MODE" == candidate-filesystem ]]; then
  release_prepare_candidate_network
  release_start_candidate workspace
  candidate_name="duallane-go-full-candidate-workspace-new-commit"
  [[ "$(docker inspect "$candidate_name" --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.RW}}{{end}}{{end}}')" == false ]]
  [[ "$(docker inspect "$candidate_name" --format '{{.HostConfig.ReadonlyRootfs}}')" == true ]]
  release_cleanup_candidates
  release_cleanup_candidate_network
elif [[ "$MODE" == candidate-rw || "$MODE" == candidate-rootfs-rw ]]; then
  release_prepare_candidate_network
  if release_start_candidate workspace; then
    echo "writable candidate filesystem unexpectedly passed" >&2
    exit 1
  fi
  release_cleanup_candidates
  release_cleanup_candidate_network
elif [[ "$MODE" == candidate-collision ]]; then
  release_prepare_candidate_network
  if release_start_candidate workspace; then
    echo "candidate-collision unexpectedly reused a foreign container" >&2
    exit 1
  fi
  release_cleanup_candidates
  release_cleanup_candidate_network
elif [[ "$MODE" == success-daemon ]]; then
  release_snapshot_app_state "$RELEASE_SNAPSHOT_FILE"
  docker set-running api-old false
  docker set-running v2ray-old false
  docker set-current web web-new
  docker set-current p2p p2p-new
  docker set-current workspace workspace-new
  docker set-current worker worker-new
  release_restore_daemon_after_success
elif [[ "$MODE" == inventory-failure || "$MODE" == ps-failure ]]; then
  if release_snapshot_app_state "$RELEASE_SNAPSHOT_FILE"; then
    echo "inventory-failure unexpectedly produced a snapshot" >&2
    exit 1
  fi
elif [[ "$MODE" == rollback-fence-mid-failure ]]; then
  release_snapshot_app_state "$RELEASE_SNAPSHOT_FILE"
  release_stop_service_and_confirm api
  # First Go cutover retains the stopped Node API; only Web is replaced.
  docker set-current web "$(printf '3%.0s' {1..64})"
  docker set-current p2p "$(printf 'b%.0s' {1..64})"
  docker set-current workspace "$(printf 'c%.0s' {1..64})"
  docker set-current worker "$(printf 'd%.0s' {1..64})"
  if release_rollback_application; then
    echo "mid-failure rollback unexpectedly completed" >&2
    exit 1
  fi
else
  release_snapshot_app_state "$RELEASE_SNAPSHOT_FILE"
  if [[ "$MODE" == rollback || "$MODE" == rollback-daemon ]]; then
    release_stop_service_and_confirm api
  fi
  if [[ "$MODE" == rollback || "$MODE" == rollback-daemon ]]; then
    docker set-current web "$(printf '3%.0s' {1..64})"
    docker set-current p2p "$(printf 'b%.0s' {1..64})"
    docker set-current workspace "$(printf 'c%.0s' {1..64})"
    docker set-current worker "$(printf 'd%.0s' {1..64})"
  else
    docker set-current web web-new
    docker set-current p2p p2p-new
    docker set-current workspace workspace-new
    docker set-current worker worker-new
  fi
  release_rollback_application
  if [[ "$MODE" == rollback-daemon ]]; then
    docker set-daemon 3
    release_restore_daemon_snapshot
  fi
fi
`;
  const result = spawnSync("bash", ["--noprofile", "--norc", "-euo", "pipefail", "-c", driver], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${directory}${path.delimiter}${process.env.PATH ?? ""}`,
      FAKE_DOCKER_STATE: statePath,
      FAKE_DOCKER_SCRIPT: fakeDocker,
      RELEASE_HELPER: helper,
      STATE_PATH: statePath,
      MODE: mode,
      GO_UPGRADE_SNAPSHOT: goUpgradeArtifacts?.snapshotPath ?? "",
      GO_UPGRADE_COMPOSE_FILE: goUpgradeArtifacts?.composePath ?? "",
      COMPOSE_PROJECT_NAME: "duallane",
      DUALLANE_DEPLOY_STOP_ATTEMPTS: "2",
      DUALLANE_DEPLOY_HEALTH_ATTEMPTS: "2",
    },
  });
  const finalState = JSON.parse(await readFile(statePath, "utf8"));
  const snapshot = await readFile(`${statePath}.snapshot`, "utf8").catch(() => "");
  const recovery = await readFile(`${statePath}.recovery`, "utf8").catch(() => "");
  const imageOverridePath = `${statePath}.recovery.go-image.override.yml`;
  const imageOverride = await readFile(imageOverridePath, "utf8").catch(() => "");
  const imageOverrideMode = await stat(imageOverridePath)
    .then(({ mode: fileMode }) => fileMode & 0o777)
    .catch(() => null);
  await rm(directory, { recursive: true, force: true });
  return { result, finalState, snapshot, recovery, imageOverride, imageOverrideMode };
}

test("fake Docker daemon recovery restores every captured running application container", async () => {
  const { result, finalState, snapshot, recovery } = await runFakeHarness("snapshot");
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(snapshot, /^postgres\tpg-old\t/m);
  assert.match(snapshot, /^api\tapi-old\t/m);
  assert.match(snapshot, /^web\tweb-old\t/m);
  assert.match(snapshot, /^v2ray\tv2ray-old\t/m);
  for (const id of ["pg-old", "api-old", "web-old", "v2ray-old"]) {
    assert.equal(finalState.containers[id].running, true, `${id} was not restored`);
  }
  assert.match(recovery, /daemon_restart_restored=true/);
  assert.deepEqual(finalState.calls.map(([operation, service]) => [operation, service]), [
    ["start", "pg-old"],
    ["start", "v2ray-old"],
    ["start", "api-old"],
    ["start", "web-old"],
  ]);
});

test("fake Docker rollback fences Go services before restoring Node", async () => {
  const { result, finalState, recovery } = await runFakeHarness("rollback");
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  for (const id of ["p2p-new", "workspace-new", "worker-new"]) {
    assert.equal(finalState.containers[id], undefined, `${id} was not removed`);
  }
  assert.equal(finalState.containers["api-old"].running, true);
  assert.equal(finalState.containers["web-old"].running, true);
  assert.equal(finalState.containers["api-old"].restartName, "always");
  assert.equal(finalState.containers["web-old"].restartName, "always");
  for (const service of ["api", "p2p", "workspace", "worker"]) {
    const id = {
      api: fakeIdentity("a"),
      p2p: fakeIdentity("b"),
      workspace: fakeIdentity("c"),
      worker: fakeIdentity("d"),
    }[service];
    assert.match(recovery, new RegExp(`^fence_target\\t${service}\\t${id}\\talways\\t0\\ttrue$`, "m"));
    assert.match(recovery, new RegExp(`^fence_complete\\t${service}$`, "m"));
  }
  for (const id of ["p2p-new", "workspace-new", "worker-new"]) {
    assert.equal(finalState.containers[id], undefined, `${id} was not removed after fencing`);
  }
  const stopIndex = finalState.calls.findIndex(([operation, id]) => operation === "stop" && id === fakeIdentity("d"));
  const apiUpIndex = finalState.calls.findIndex(([operation, service]) => operation === "up" && service === "api");
  assert.ok(stopIndex >= 0 && apiUpIndex > stopIndex, "Node was restored before Go services were fenced");
  assert.equal(finalState.tags.length, 0, "Go rollback must not repoint mutable image tags");
  assert.match(recovery, /drain_model_recovery=ready/);
});

test("Node-to-Go fencing records the old API identity and leaves it stopped", async () => {
  const { result, finalState, recovery } = await runFakeHarness("node-fence-success");
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(finalState.containers["api-old"].running, false);
  assert.equal(finalState.containers["api-old"].restartName, "no");
  assert.match(recovery, new RegExp(`^fence_target\\tapi\\t${fakeIdentity("a")}\\talways\\t0\\ttrue$`, "m"));
  assert.match(recovery, new RegExp(`^fence_updated\\tapi\\t${fakeIdentity("a")}$`, "m"));
  assert.match(recovery, new RegExp(`^fence_stopped\\tapi\\t${fakeIdentity("a")}$`, "m"));
  assert.match(recovery, /^fence_complete\tapi$/m);
  const updateIndex = finalState.calls.findIndex(([operation, id]) => operation === "update" && id === fakeIdentity("a"));
  const stopIndex = finalState.calls.findIndex(([operation, id]) => operation === "stop" && id === fakeIdentity("a"));
  assert.ok(updateIndex >= 0 && stopIndex > updateIndex, "API stop preceded restart-policy fencing");
  assert.ok(!finalState.calls.some(([operation]) => ["start", "up"].includes(operation)));
});

test("restart-policy update failure stops no old owner", async () => {
  const { result, finalState, recovery } = await runFakeHarness("node-fence-update-failure");
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(finalState.containers["api-old"].running, true);
  assert.equal(finalState.containers["api-old"].restartName, "always");
  assert.match(recovery, new RegExp(`^fence_target\\tapi\\t${fakeIdentity("a")}\\talways\\t0\\ttrue$`, "m"));
  assert.doesNotMatch(recovery, new RegExp(`^fence_updated\\tapi\\t${fakeIdentity("a")}$`, "m"));
  assert.ok(!finalState.calls.some(([operation]) => operation === "stop"));
});

test("container identity drift aborts before restart-policy update or stop", async () => {
  const { result, finalState, recovery } = await runFakeHarness("node-fence-identity-drift");
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(finalState.containers["api-old"].running, true);
  assert.equal(finalState.containers["api-old"].restartName, "always");
  assert.match(recovery, new RegExp(`^fence_target\\tapi\\t${fakeIdentity("a")}\\talways\\t0\\ttrue$`, "m"));
  assert.doesNotMatch(recovery, new RegExp(`^fence_updated\\tapi\\t${fakeIdentity("a")}$`, "m"));
  assert.ok(!finalState.calls.some(([operation]) => ["update", "stop"].includes(operation)));
});

test("stop failure leaves the owner fenced but not recoverable", async () => {
  const { result, finalState, recovery } = await runFakeHarness("node-fence-stop-failure");
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(finalState.containers["api-old"].running, true);
  assert.equal(finalState.containers["api-old"].restartName, "no");
  assert.match(recovery, new RegExp(`^fence_target\\tapi\\t${fakeIdentity("a")}\\talways\\t0\\ttrue$`, "m"));
  assert.match(recovery, new RegExp(`^fence_updated\\tapi\\t${fakeIdentity("a")}$`, "m"));
  assert.doesNotMatch(recovery, /^fence_complete\tapi$/m);
  assert.ok(finalState.calls.some(([operation, id]) => operation === "stop-failed" && id === fakeIdentity("a")));
  assert.ok(!finalState.calls.some(([operation, id]) => operation === "start" && id === fakeIdentity("a")));
});

test("daemon restart during fencing restores only the completed known-good API", async () => {
  const { result, finalState, recovery } = await runFakeHarness("node-fence-daemon-restart");
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(finalState.containers["api-old"].running, true);
  assert.equal(finalState.containers["api-old"].restartName, "always");
  assert.match(recovery, /^fence_complete\tapi$/m);
  assert.match(recovery, new RegExp(`^fence_restored\\tapi\\t${fakeIdentity("a")}$`, "m"));
  const stopIndex = finalState.calls.findIndex(([operation, id]) => operation === "stop" && id === fakeIdentity("a"));
  const startIndex = finalState.calls.findIndex(([operation, id]) => operation === "start" && id === fakeIdentity("a"));
  assert.ok(stopIndex >= 0 && startIndex > stopIndex, "API was restored before the fenced stop completed");
});

test("mid-rollback fencing failure does not restore Node or revive later Go owners", async () => {
  const { result, finalState, recovery } = await runFakeHarness("rollback-fence-mid-failure");
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(finalState.containers["api-old"].running, false);
  assert.equal(finalState.containers["api-old"].restartName, "no");
  assert.equal(finalState.containers["p2p-new"].running, false);
  assert.equal(finalState.containers["p2p-new"].restartName, "no");
  assert.equal(finalState.containers["workspace-new"].running, true);
  assert.equal(finalState.containers["workspace-new"].restartName, "always");
  assert.equal(finalState.containers["worker-new"].running, true);
  assert.equal(finalState.containers["worker-new"].restartName, "always");
  assert.match(recovery, /^fence_complete\tapi$/m);
  assert.match(recovery, /^fence_complete\tp2p$/m);
  assert.doesNotMatch(recovery, /^fence_complete\tworkspace$/m);
  assert.ok(!finalState.calls.some(([operation, id]) =>
    operation === "start" && [fakeIdentity("b"), fakeIdentity("c"), fakeIdentity("d")].includes(id)));
  assert.ok(!finalState.calls.some(([operation]) => ["start", "up"].includes(operation)));
});

test("multiple owner containers fail closed before any restart-policy mutation", async () => {
  const { result, finalState, recovery } = await runFakeHarness("node-fence-multiple");
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(finalState.containers["api-old"].running, true);
  assert.equal(finalState.containers["api-old-2"].running, true);
  assert.equal(finalState.containers["api-old"].restartName, "always");
  assert.equal(finalState.containers["api-old-2"].restartName, "always");
  assert.equal(recovery, "");
  assert.ok(!finalState.calls.some(([operation]) => ["update", "stop"].includes(operation)));
});

for (const mode of ["node-fence-project-mismatch", "node-fence-service-mismatch", "node-fence-invalid-identity"]) {
  test(`${mode} fails closed before restart-policy mutation`, async () => {
    const { result, finalState, recovery } = await runFakeHarness(mode);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(finalState.containers["api-old"].running, true);
    assert.equal(finalState.containers["api-old"].restartName, "always");
    assert.equal(recovery, "");
    assert.ok(!finalState.calls.some(([operation]) => ["update", "stop"].includes(operation)));
  });
}

test("legacy data permission failure aborts before Node owner handoff", async () => {
  const { result, finalState } = await runFakeHarness("permission-failure");
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(finalState.containers["api-old"].running, true);
  assert.ok(finalState.calls.some(([operation, service]) => operation === "run" && service === "workspace"));
  assert.ok(!finalState.calls.some(([operation, service]) => operation === "stop" && service === "api"));
  assert.equal(finalState.containers["duallane-go-full-candidate-workspace-new-commit"], undefined);
  assert.deepEqual(finalState.networks, {});
});

test("node-default refuses an active Go owner", async () => {
  const { result, finalState } = await runFakeHarness("node-active");
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(finalState.containers["workspace-live"].running, true);
  assert.ok(!finalState.calls.some(([operation]) => ["stop", "up", "run"].includes(operation)));
});

test("node-default uses the base Compose candidate path", async () => {
  const { result, finalState } = await runFakeHarness("node-candidate");
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.ok(finalState.calls.some(([operation, service]) => operation === "run" && service === "api"));
  assert.ok(finalState.calls.some(([operation]) => operation === "rm"));
  const apiRun = finalState.candidateRuns.find(({ service }) => service === "api");
  assert.ok(apiRun, "Node API candidate run was not recorded");
  assert.deepEqual([...apiRun.env].sort(), [
    "DATABASE_AUTO_MIGRATE=false",
    "DUALLANE_DATA_DIR=/tmp/duallane-candidate-api",
    "WORKSPACE_ECHO_DELIVERY_WORKER_ENABLED=false",
    "WORKSPACE_EMAIL_WORKER_ENABLED=false",
    "WORKSPACE_ENABLED=false",
    "WORKSPACE_NTFY_WORKER_ENABLED=false",
  ]);
  assert.deepEqual(apiRun.tmpfs, []);
  const apiRunCall = finalState.calls.find(([operation, service]) => operation === "run" && service === "api");
  assert.equal(apiRunCall[5], false, "Node API candidate unexpectedly requested an unsupported tmpfs option");
  assert.equal(finalState.containers["duallane-node-default-candidate-api-new-commit"], undefined);
});

test("Node candidate rejects an unsafe effective environment", async () => {
  const { result, finalState } = await runFakeHarness("node-candidate-env-invalid");
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const apiRun = finalState.candidateRuns.find(({ service }) => service === "api");
  assert.ok(apiRun, "Node API candidate run was not recorded");
  assert.ok(apiRun.env.includes("DATABASE_AUTO_MIGRATE=true"));
  assert.ok(finalState.calls.some(([operation, ...ids]) => operation === "rm" && ids.includes("duallane-node-default-candidate-api-new-commit")));
  assert.equal(finalState.containers["duallane-node-default-candidate-api-new-commit"], undefined);
});

test("Node candidate rejects duplicate effective safety keys", async () => {
  const { result, finalState } = await runFakeHarness("node-candidate-env-duplicate");
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const apiRun = finalState.candidateRuns.find(({ service }) => service === "api");
  assert.ok(apiRun, "Node API candidate run was not recorded");
  assert.equal(apiRun.env.filter((value) => value.startsWith("WORKSPACE_ENABLED=")).length, 2);
  assert.ok(finalState.calls.some(([operation, ...ids]) => operation === "rm" && ids.includes("duallane-node-default-candidate-api-new-commit")));
  assert.equal(finalState.containers["duallane-node-default-candidate-api-new-commit"], undefined);
});

test("Node candidate rejects a mount covering its private data path", async () => {
  const { result, finalState } = await runFakeHarness("node-candidate-path-mounted");
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const apiRun = finalState.candidateRuns.find(({ service }) => service === "api");
  assert.ok(apiRun, "Node API candidate run was not recorded");
  assert.deepEqual(apiRun.mounts, [{ Destination: "/tmp", RW: true }]);
  assert.ok(finalState.calls.some(([operation, ...ids]) => operation === "rm" && ids.includes("duallane-node-default-candidate-api-new-commit")));
  assert.equal(finalState.containers["duallane-node-default-candidate-api-new-commit"], undefined);
});

test("Go candidates stay together on the isolated network until Web health", async () => {
  const { result, finalState } = await runFakeHarness("candidate-lifecycle");
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const webRun = finalState.calls.find(([operation, service]) => operation === "run" && service === "web");
  assert.ok(webRun, "Web candidate was not started");
  assert.equal(webRun[3], true, "P2P candidate was removed before Web start");
  assert.equal(webRun[4], true, "Workspace candidate was removed before Web start");
  assert.deepEqual(finalState.networks, {});
  for (const service of ["p2p", "workspace", "worker", "web"]) {
    assert.equal(finalState.containers[`duallane-go-full-candidate-${service}-new-commit`], undefined);
  }
});

test("Go candidate Workspace mounts legacy data read-only with a read-only rootfs", async () => {
  const { result, finalState } = await runFakeHarness("candidate-filesystem");
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.ok(finalState.calls.some(([operation, service]) => operation === "run" && service === "workspace"));
  assert.deepEqual(finalState.networks, {});
  assert.equal(finalState.containers["duallane-go-full-candidate-workspace-new-commit"], undefined);
});

test("writable Go candidate data mount fails closed before candidate handoff", async () => {
  const { result, finalState } = await runFakeHarness("candidate-rw");
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.ok(finalState.calls.some(([operation, service]) => operation === "run" && service === "workspace"));
  assert.equal(finalState.containers["duallane-go-full-candidate-workspace-new-commit"], undefined);
  assert.deepEqual(finalState.networks, {});
});

test("writable Go candidate rootfs fails closed", async () => {
  const { result, finalState } = await runFakeHarness("candidate-rootfs-rw");
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.ok(finalState.calls.some(([operation, service]) => operation === "run" && service === "workspace"));
  assert.equal(finalState.containers["duallane-go-full-candidate-workspace-new-commit"], undefined);
  assert.deepEqual(finalState.networks, {});
});

test("candidate name collision with another project fails closed", async () => {
  const { result, finalState } = await runFakeHarness("candidate-collision");
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const collision = finalState.containers["duallane-go-full-candidate-workspace-new-commit"];
  assert.ok(collision, "foreign candidate container was removed");
  assert.equal(collision.labels["com.docker.compose.project"], "another-project");
  assert.ok(!finalState.calls.some(([operation]) => operation === "run"), "foreign candidate was overwritten");
  assert.deepEqual(finalState.networks, {});
});

test("Compose inventory failure is not treated as an absent service", async () => {
  const { result, snapshot } = await runFakeHarness("inventory-failure");
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(snapshot, "");
});

test("Compose ps failure is not treated as an absent service", async () => {
  const { result, snapshot } = await runFakeHarness("ps-failure");
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(snapshot, "");
});

test("daemon recovery with a Node-only snapshot never revives fenced Go owners", async () => {
  const { result, finalState, recovery } = await runFakeHarness("rollback-daemon");
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(finalState.containers["api-old"], undefined);
  assert.equal(finalState.containers["web-old"], undefined);
  assert.equal(finalState.containers["api-old-restored"].running, true);
  assert.equal(finalState.containers["web-old-restored"].running, true);
  assert.ok(!finalState.calls.some(([operation, id]) =>
    operation === "start" && [fakeIdentity("b"), fakeIdentity("c"), fakeIdentity("d")].includes(id)));
  assert.match(recovery, /replacement_api=api-old-restored/);
  assert.match(recovery, /replacement_web=web-old-restored/);
  assert.match(recovery, /daemon_restart_restored=true/);
});

test("successful daemon restart restores only non-participants and verifies the new profile", async () => {
  const { result, finalState, recovery } = await runFakeHarness("success-daemon");
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(finalState.containers["v2ray-old"].running, true);
  assert.equal(finalState.containers["api-old"].running, false);
  assert.ok(finalState.calls.some(([operation, id]) => operation === "start" && id === "v2ray-old"));
  assert.ok(!finalState.calls.some(([operation, id]) => operation === "start" && id === "api-old"));
  assert.ok(finalState.calls.some(([operation, id]) => operation === "stop" && id === fakeIdentity("a")));
  for (const service of ["p2p", "workspace", "worker", "web"]) {
    assert.equal(finalState.containers[service + "-new"].running, true, `${service} profile is not healthy`);
  }
  assert.match(recovery, /daemon_restart_success_restored=true/);
});

test("Go migration gate records the actual image ID and release metadata", async () => {
  const { result, recovery } = await runFakeHarness("image-identity");
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(recovery, /^go_image_ref=duallane-go-workspace:new$/m);
  assert.match(recovery, new RegExp(`^go_image_id=sha256:${"a".repeat(64)}$`, "m"));
  assert.match(recovery, new RegExp(`^go_image_revision=${"a".repeat(40)}$`, "m"));
  assert.match(recovery, /^go_image_version=0\.15\.5$/m);
  assert.match(recovery, /^go_image_run_id=[0-9a-f]{64}$/m);
});

for (const mode of [
  "image-ref-mismatch",
  "image-id-invalid",
  "image-revision-mismatch",
  "image-version-mismatch",
  "image-inspect-failure",
]) {
  test(`Go migration gate rejects ${mode}`, async () => {
    const { result, recovery } = await runFakeHarness(mode);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(recovery, "");
  });
}

test("active Go services must use the image ID verified before migration", async () => {
  const { result } = await runFakeHarness("image-service-id");
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
});

test("active Go image ID drift fails closed", async () => {
  const { result } = await runFakeHarness("image-service-id-mismatch");
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
});

test("Go image verification creates a private ID-pinned override for all Go services", async () => {
  const { result, imageOverride, imageOverrideMode } = await runFakeHarness("image-identity");
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(imageOverrideMode, 0o600);
  for (const service of ["workspace", "worker", "migrate"]) {
    assert.match(
      imageOverride,
      new RegExp(`\\n  ${service}:\\n    image: sha256:${"a".repeat(64)}\\n`),
    );
  }
  assert.match(imageOverride, /com\.duallane\.release-run: [0-9a-f]{64}/);
});

test("Go image release metadata is read from the verified canonical image ID", async () => {
  const { result, finalState } = await runFakeHarness("image-tag-metadata-drift");
  assert.equal(result.status, 0, result.stderr + "\n" + result.stdout);
  const metadataInspects = finalState.imageInspects.filter(({ format }) =>
    format.includes("org.opencontainers.image.revision") ||
    format.includes("org.opencontainers.image.version"));
  assert.equal(metadataInspects.length, 2);
  assert.deepEqual(
    [...new Set(metadataInspects.map(({ target }) => target))],
    ["sha256:" + "a".repeat(64)],
  );
  assert.equal(
    finalState.imageInspects.filter(({ format }) => format.includes(".Id")).length,
    3,
  );
});

test("Go migration pins the created container to the verified image before start and after wait", async () => {
  const { result, finalState, imageOverride, imageOverrideMode } = await runFakeHarness("migration-image");
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(imageOverrideMode, 0o600);
  assert.match(imageOverride, new RegExp(`migrate:\\n    image: sha256:${"a".repeat(64)}`));
  assert.ok(finalState.calls.some(([operation, id, overrideUsed]) =>
    operation === "migration-create" && /^f{64}$/.test(id) && overrideUsed === true));
  assert.ok(finalState.calls.some(([operation, id]) => operation === "start" && /^f{64}$/.test(id)));
  assert.ok(finalState.calls.some(([operation, id]) => operation === "wait" && /^f{64}$/.test(id)));
  assert.ok(finalState.calls.some(([operation, id]) => operation === "rm" && /^f{64}$/.test(id)));
  assert.ok(!finalState.calls.some(([operation]) => operation === "migration-run"));
  assert.equal(finalState.databaseMutated, true);
  assert.equal(
    Object.keys(finalState.containers).some((id) => /^f{64}$/.test(id)),
    false,
    "verified migration container was not removed",
  );
});

test("Go migration ignores a mutable tag drift because the override is ID-pinned", async () => {
  const { result, finalState } = await runFakeHarness("migration-tag-drift");
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.ok(finalState.calls.some(([operation, id, overrideUsed]) =>
    operation === "migration-create" && /^f{64}$/.test(id) && overrideUsed === true));
  assert.ok(finalState.calls.some(([operation]) => operation === "start"));
  assert.ok(finalState.calls.some(([operation]) => operation === "wait"));
  assert.equal(finalState.databaseMutated, true);
});

test("wrong migration image ID is rejected before start and cannot mutate the database", async () => {
  const { result, finalState } = await runFakeHarness("migration-wrong-id");
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.ok(finalState.calls.some(([operation, id, overrideUsed]) =>
    operation === "migration-create" && /^f{64}$/.test(id) && overrideUsed === true));
  assert.ok(!finalState.calls.some(([operation]) => operation === "start" || operation === "wait"));
  assert.equal(finalState.databaseMutated, false);
  assert.deepEqual(
    finalState.calls.find(([operation]) => operation === "rm"),
    ["rm", "f".repeat(64)],
  );
});

test("failed migration is waited and cleaned only through its owned container ID", async () => {
  const { result, finalState } = await runFakeHarness("migration-exit-failure");
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.ok(finalState.calls.some(([operation]) => operation === "start"));
  assert.ok(finalState.calls.some(([operation]) => operation === "wait"));
  assert.deepEqual(
    finalState.calls.find(([operation]) => operation === "rm"),
    ["rm", "f".repeat(64)],
  );
  assert.equal(finalState.databaseMutated, true);
});

test("post-wait migration image drift fails after execution and owned cleanup", async () => {
  const { result, finalState } = await runFakeHarness("migration-post-wait-drift");
  assert.equal(result.status, 0, result.stderr + "\n" + result.stdout);
  assert.ok(finalState.calls.some(([operation]) => operation === "start"));
  assert.ok(finalState.calls.some(([operation]) => operation === "wait"));
  assert.deepEqual(
    finalState.calls.find(([operation]) => operation === "rm"),
    ["rm", "f".repeat(64)],
  );
  assert.equal(finalState.databaseMutated, true);
});

test("invalid migration container IDs fail closed without guessed cleanup", async () => {
  const { result, finalState } = await runFakeHarness("migration-invalid-id");
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.ok(!finalState.calls.some(([operation]) => ["start", "wait", "rm"].includes(operation)));
  assert.equal(finalState.databaseMutated, false);
  assert.ok(finalState.containers["not-a-container-id"]);
});

test("migration cleanup refuses a container with foreign Compose ownership", async () => {
  const { result, finalState } = await runFakeHarness("migration-owner-mismatch");
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.ok(!finalState.calls.some(([operation]) => ["start", "wait", "rm"].includes(operation)));
  assert.equal(finalState.databaseMutated, false);
  assert.ok(finalState.containers["f".repeat(64)]);
});

test("migration cleanup requires the unique run label as well as Compose ownership", async () => {
  const { result, finalState } = await runFakeHarness("migration-run-mismatch");
  assert.equal(result.status, 0, result.stderr + "\n" + result.stdout);
  assert.ok(!finalState.calls.some(([operation]) => ["start", "wait", "rm"].includes(operation)));
  assert.equal(finalState.databaseMutated, false);
  assert.ok(finalState.containers["f".repeat(64)]);
});

test("Go-to-Go upgrade remains fail-closed without a frozen resolved Compose snapshot", async () => {
  const { result, finalState } = await runFakeHarness("go-upgrade");
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.ok(
    !finalState.calls.some(([operation]) => ["stop", "start", "up", "run"].includes(operation)),
    "unsupported Go-to-Go upgrade mutated the lifecycle",
  );
});

test("the Go-to-Go CLI flag fails before any production Docker checks", () => {
  const result = spawnSync(
    "bash",
    [path.join(root, "deploy/production/deploy.sh"), "--release-profile", "go-full", "--go-upgrade"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 2, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stderr, /--go-upgrade requires --previous-release-snapshot/);
});

test("successful Go releases publish a private pinned recovery snapshot", async () => {
  const { result, recovery, finalState } = await runFakeHarness("go-success-snapshot");
  assert.equal(result.status, 0, result.stderr + "\n" + result.stdout);
  assert.match(recovery, /^go_upgrade_success_snapshot=\/.+\.go-compose\.snapshot\.json$/m);
  assert.match(recovery, /^go_success_snapshot_modes=600,600,600,600$/m);
  assert.ok(
    !finalState.calls.some(([operation]) => operation === "go-up-old"),
    "successful snapshot capture unexpectedly restored an old owner",
  );
});

test("Go-to-Go recovery validates real owner records and fences every new owner before restore", async () => {
  const { result, finalState, recovery } = await runFakeHarness("go-upgrade-valid");
  assert.equal(result.status, 0, result.stderr + "\n" + result.stdout);
  const oldIds = {
    p2p: "1".repeat(64),
    workspace: "2".repeat(64),
    worker: "3".repeat(64),
    web: "4".repeat(64),
  };
  const newIds = {
    p2p: "5".repeat(64),
    workspace: "6".repeat(64),
    worker: "7".repeat(64),
    web: "8".repeat(64),
  };
  const oldImages = {
    p2p: goUpgradeImage("1"),
    workspace: goUpgradeImage("2"),
    worker: goUpgradeImage("2"),
    web: goUpgradeImage("3"),
  };
  for (const service of Object.keys(oldIds)) {
    assert.match(
      recovery,
      new RegExp(
        "^go_upgrade_old_owner\\t" + service + "\\t" + oldIds[service] +
          "\\t" + oldImages[service] + "\\t" + goUpgradeOldCommit + "$",
        "m",
      ),
    );
    assert.equal(finalState.containers[oldIds[service]].running, true);
    assert.equal(finalState.containers[oldIds[service]].restartName, "always");
    assert.equal(finalState.current[service][0], oldIds[service]);
  }
  assert.match(recovery, /^volume_authority_verified=true$/m);
  assert.match(recovery, /^go_upgrade_daemon_new_owners_fenced=true$/m);
  assert.match(recovery, /^go_upgrade_daemon_old_owners_restored=true$/m);
  const newFenceMarker = recovery.indexOf("go_upgrade_daemon_new_owners_fenced=true");
  const firstRestoreMarker = recovery.indexOf("go_upgrade_old_restored\t");
  assert.ok(newFenceMarker >= 0 && firstRestoreMarker > newFenceMarker);

  const firstRestore = finalState.calls.findIndex(([operation]) => operation === "go-up-old");
  assert.ok(firstRestore >= 0, "old Go owners were not restored");
  for (const service of Object.keys(newIds)) {
    const stopIndex = finalState.calls.findIndex(
      ([operation, id]) => operation === "stop" && id === newIds[service],
    );
    assert.ok(
      stopIndex >= 0 && stopIndex < firstRestore,
      service + " was restored before its new owner was fenced",
    );
    assert.equal(finalState.containers[newIds[service]].running, false);
    assert.equal(finalState.containers[newIds[service]].restartName, "no");
  }
  for (const call of finalState.calls.filter(([operation]) => operation === "go-up-old")) {
    assert.equal(call[3], "canonical");
  }
  assert.ok(!finalState.calls.some(([operation, service]) => operation === "go-up-old" && service === "api"));
});

test("Go-to-Go daemon recovery keeps a failed new owner fenced during interleaved owner recovery", async () => {
  const { result, finalState, recovery } = await runFakeHarness("go-upgrade-fence-failure");
  assert.equal(result.status, 0, result.stderr + "\n" + result.stdout);
  const oldIds = ["1".repeat(64), "2".repeat(64), "3".repeat(64), "4".repeat(64)];
  const newIds = ["5".repeat(64), "6".repeat(64), "7".repeat(64), "8".repeat(64)];
  for (const id of oldIds) {
    assert.equal(finalState.containers[id].running, false);
    assert.equal(finalState.containers[id].restartName, "no");
  }
  for (const id of newIds.slice(0, 2)) {
    assert.equal(finalState.containers[id].running, false);
    assert.equal(finalState.containers[id].restartName, "no");
  }
  assert.equal(finalState.containers[newIds[2]].running, true);
  assert.equal(finalState.containers[newIds[2]].restartName, "no");
  assert.doesNotMatch(recovery, /^go_upgrade_daemon_new_owners_fenced=true$/m);
  assert.doesNotMatch(recovery, /^go_upgrade_old_restored=/m);
  assert.ok(!finalState.calls.some(([operation]) => operation === "go-up-old"));
  assert.ok(finalState.calls.some(([operation, service]) =>
    operation === "go-upgrade-stop-failed" && service === "worker"));
});

test("Go-to-Go recovery keeps canonical owner records through an interleaved partial cutover", async () => {
  const { result, finalState, recovery } = await runFakeHarness("go-upgrade-interleaved");
  assert.equal(result.status, 0, result.stderr + "\n" + result.stdout);
  assert.match(recovery, /^go_upgrade_old_owner\tweb\t4{64}\tsha256:3{64}\ta{40}$/m);
  assert.match(recovery, /^go_upgrade_new_owner\tworker\t7{64}\tsha256:9{64}\tb{40}$/m);
  const firstRestore = finalState.calls.findIndex(([operation]) => operation === "go-up-old");
  const newStopIndexes = finalState.calls
    .map(([operation, id], index) =>
      operation === "stop" && ["5", "6", "7"].some((digit) => id === digit.repeat(64)) ? index : -1)
    .filter((index) => index >= 0);
  assert.ok(firstRestore >= 0 && newStopIndexes.every((index) => index < firstRestore));
  assert.equal(finalState.current.web[0], "4".repeat(64));
});

const goUpgradeRetryServices = Object.freeze(["p2p", "workspace", "worker", "web"]);
const goUpgradeRetryNewIds = Object.freeze({
  p2p: "5".repeat(64),
  workspace: "6".repeat(64),
  worker: "7".repeat(64),
  web: "8".repeat(64),
});
const goUpgradeRetryOldImages = Object.freeze({
  p2p: goUpgradeImage("1"),
  workspace: goUpgradeImage("2"),
  worker: goUpgradeImage("2"),
  web: goUpgradeImage("3"),
});
const goUpgradeRetryOldRestartPolicies = Object.freeze({
  p2p: { name: "always", max: 0 },
  workspace: { name: "on-failure", max: 3 },
  worker: { name: "always", max: 0 },
  web: { name: "always", max: 0 },
});

function assertGoUpgradeRetryState({ result, finalState, recovery }) {
  assert.equal(result.status, 0, result.stderr + "\n" + result.stdout);
  assert.match(recovery, /^go_upgrade_daemon_new_owners_fenced=true$/m);
  assert.match(recovery, /^go_upgrade_daemon_old_owners_restored=true$/m);
  assert.match(recovery, /^go_upgrade_fence_target\told\tworkspace\t2{64}\ton-failure\t3\ttrue\tsha256:2{64}\ta{40}$/m);

  const history = finalState.goUpgradeOldCreatedHistory;
  assert.deepEqual(Object.keys(history).sort(), [...goUpgradeRetryServices].sort());
  const createdIDs = new Set();
  const createdRecords = recovery
    .split("\n")
    .filter((line) => line.startsWith("go_upgrade_old_created\t"));
  const newFenceMarker = recovery.indexOf("go_upgrade_daemon_new_owners_fenced=true");
  const firstCreatedMarker = recovery.indexOf("go_upgrade_old_created\t");
  assert.ok(newFenceMarker >= 0 && firstCreatedMarker > newFenceMarker);
  assert.equal(
    createdRecords.length,
    goUpgradeRetryServices.reduce((total, service) => total + history[service].length, 0),
    "every recreated old container must have one durable creation record",
  );
  for (const line of createdRecords) {
    const [kind, service, id, image, commit] = line.split("\t");
    assert.equal(kind, "go_upgrade_old_created");
    assert.ok(goUpgradeRetryServices.includes(service));
    assert.match(id, /^[0-9a-f]{64}$/);
    assert.equal(image, goUpgradeRetryOldImages[service]);
    assert.equal(commit, goUpgradeOldCommit);
    assert.ok(!createdIDs.has(id), "Docker recreation must produce a fresh owner ID");
    createdIDs.add(id);
    assert.ok(history[service].includes(id));
  }

  const oldStartIndexes = finalState.calls
    .map(([operation, id], index) => operation === "start" && createdIDs.has(id) ? index : -1)
    .filter((index) => index >= 0);
  const newStopIndexes = finalState.calls
    .map(([operation, id], index) => operation === "stop" && Object.values(goUpgradeRetryNewIds).includes(id) ? index : -1)
    .filter((index) => index >= 0);
  assert.ok(oldStartIndexes.length > 0, "a retry scenario must start a known old owner");
  assert.equal(newStopIndexes.length, goUpgradeRetryServices.length);
  assert.ok(
    Math.max(...newStopIndexes) < Math.min(...oldStartIndexes),
    "all candidate owners must be fenced before any recreated old owner starts",
  );
  assert.equal(
    finalState.calls.filter(([operation]) => operation === "old-start-before-record").length,
    0,
    "the fake Docker start gate observed no start before its creation record",
  );

  for (const service of goUpgradeRetryServices) {
    const currentID = finalState.current[service]?.[0];
    assert.ok(currentID && history[service].includes(currentID), `${service} did not finish on a recorded owner`);
    const current = finalState.containers[currentID];
    assert.ok(current, `${service} current owner disappeared`);
    assert.equal(current.running, true, `${service} old owner is not running after retry`);
    assert.equal(current.status, "running");
    assert.equal(current.health, "healthy", `${service} old owner is not healthy after retry`);
    assert.equal(current.image, goUpgradeRetryOldImages[service]);
    assert.equal(current.labels.revision, goUpgradeOldCommit);
    assert.equal(current.restartName, goUpgradeRetryOldRestartPolicies[service].name);
    assert.equal(current.restartMax, goUpgradeRetryOldRestartPolicies[service].max);
    for (const id of history[service]) {
      const createCall = finalState.calls.findIndex(
        ([operation, callService, callID]) => operation === "go-up-old-create" && callService === service && callID === id,
      );
      assert.ok(createCall >= 0, `${service} ${id} was not created by the canonical rollback Compose`);
      assert.equal(finalState.calls[createCall][5], "up-no-start");
      const startCall = finalState.calls.findIndex(
        ([operation, callID]) => operation === "start" && callID === id,
      );
      if (startCall >= 0) assert.ok(createCall < startCall, `${service} ${id} started before create returned`);
    }
  }

  for (const id of Object.values(goUpgradeRetryNewIds)) {
    assert.equal(finalState.containers[id].running, false, `${id} candidate owner is still running`);
    assert.equal(finalState.containers[id].restartName, "no");
  }
  assert.ok(!finalState.calls.some(([operation]) => operation === "go-up-old"));
  assert.ok(!finalState.calls.some((call) => call.includes("foreign-workspace")));
  assert.deepEqual(
    {
      image: finalState.containers["foreign-workspace"].image,
      ref: finalState.containers["foreign-workspace"].ref,
      running: finalState.containers["foreign-workspace"].running,
      status: finalState.containers["foreign-workspace"].status,
      health: finalState.containers["foreign-workspace"].health,
      project: finalState.containers["foreign-workspace"].labels["com.docker.compose.project"],
      revision: finalState.containers["foreign-workspace"].labels.revision,
    },
    {
      image: "sha256:foreign",
      ref: "duallane-workspace:foreign",
      running: true,
      status: "running",
      health: "healthy",
      project: "foreign-project",
      revision: "foreign-commit",
    },
  );
}

test("Go-to-Go recovery retries a recorded old owner after a start failure", async () => {
  const result = await runFakeHarness("go-upgrade-old-start-retry");
  assertGoUpgradeRetryState(result);
  const failureIndex = result.finalState.calls.findIndex(
    ([operation, service]) => operation === "go-up-old-start-failed" && service === "workspace",
  );
  const laterCreate = result.finalState.calls.findIndex(
    ([operation, service]) => operation === "go-up-old-create" && service === "worker",
  );
  assert.ok(failureIndex >= 0 && (laterCreate < 0 || failureIndex < laterCreate));
});

test("Go-to-Go recovery retries a recorded old owner after a health failure", async () => {
  const result = await runFakeHarness("go-upgrade-old-health-retry");
  assertGoUpgradeRetryState(result);
  const failureIndex = result.finalState.calls.findIndex(
    ([operation, service]) => operation === "go-up-old-health-failed" && service === "workspace",
  );
  const laterCreate = result.finalState.calls.findIndex(
    ([operation, service]) => operation === "go-up-old-create" && service === "worker",
  );
  assert.ok(failureIndex >= 0 && (laterCreate < 0 || failureIndex < laterCreate));
});

test("Go-to-Go recovery retries the same old restore intent after final smoke failure", async () => {
  const result = await runFakeHarness("go-upgrade-old-smoke-retry");
  assertGoUpgradeRetryState(result);
  assert.match(result.recovery, /^go_upgrade_rollback_started=true$/m);
  assert.match(result.recovery, /^go_upgrade_rollback_complete=true$/m);
  assert.deepEqual(
    result.recovery
      .split("\n")
      .filter((line) => line.startsWith("gateway_smoke_model=")),
    ["gateway_smoke_model=failed", "gateway_smoke_model=passed"],
  );
});
