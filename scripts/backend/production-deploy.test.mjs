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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const helper = path.join(root, "deploy/production/release-helper.sh");

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
  };
  if (mode === "rollback" || mode === "rollback-daemon") {
    state.containers["api-new"] = { image: "sha256:api-new", ref: "duallane-api:new", running: true, status: "running", health: "healthy", env: [], labels: { version: "0.15.5", revision: "new-commit" } };
    state.containers["web-new"] = { image: "sha256:web-new", ref: "duallane-web:new", running: true, status: "running", health: "healthy", env: [], labels: { version: "0.15.5", revision: "new-commit" } };
    state.containers["p2p-new"] = { image: "sha256:p2p-new", ref: "duallane-p2p:new", running: true, status: "running", health: "healthy", env: [], labels: { version: "0.15.5", revision: "new-commit" } };
    state.containers["workspace-new"] = { image: "sha256:workspace-new", ref: "duallane-workspace:new", running: true, status: "running", health: "healthy", env: [], labels: { version: "0.15.5", revision: "new-commit" } };
    state.containers["worker-new"] = { image: "sha256:worker-new", ref: "duallane-worker:new", running: true, status: "running", health: "healthy", env: [], labels: { version: "0.15.5", revision: "new-commit" } };
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
  return state;
}

const fakeDockerSource = String.raw`#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const statePath = process.env.FAKE_DOCKER_STATE;
const state = JSON.parse(readFileSync(statePath, "utf8"));
const args = process.argv.slice(2);
const save = () => writeFileSync(statePath, JSON.stringify(state));
const record = (value) => { state.calls.push(value); };
const container = (id) => state.containers[id];
const serviceId = (service) => (state.current[service] ?? []).join("\n");
const formatValue = (value, format) => {
  if (format.includes(".Mounts")) {
    return (value.mounts ?? [])
      .filter((mount) => mount.Destination === "/app/data")
      .map((mount) => String(mount.RW))
      .join("");
  }
  if (format.includes(".HostConfig.ReadonlyRootfs")) return value.readOnlyRootfs ? "true" : "false";
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
    for (const network of Object.values(state.networks)) delete network.containers[id];
    delete state.containers[id];
    for (const [service, currentIds] of Object.entries(state.current)) {
      state.current[service] = currentIds.filter((currentId) => currentId !== id);
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
if (args[0] === "start") {
  const value = container(args[1]);
  if (!value) process.exit(1);
  value.running = true; value.status = "running"; if (value.health === "unknown") value.health = "healthy";
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
  process.stdout.write(formatValue(value, format));
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
      running: true,
      status: "running",
      health: "healthy",
      env,
      user: service === "workspace" || service === "worker" ? "65532:65532" : "",
      mounts: service === "workspace" || service === "worker"
        ? [{ Destination: "/app/data", RW: state.candidateMountWritable }]
        : [],
      readOnlyRootfs: !state.candidateRootfsWritable,
      networks: service === "workspace" || service === "worker"
        ? { duallane_default: { Aliases: args.includes("--use-aliases") ? [service] : [] } }
        : {},
      labels,
    };
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
      Boolean(state.containers["duallane-go-full-candidate-workspace-new-commit"]) ]);
    save(); process.stdout.write(candidateName + "\n"); process.exit(0);
  }
  if (command === "create" && service === "migrate") {
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
    record(["migration-create", id, overrideUsed]);
    save(); process.exit(0);
  }
  if (command === "up") {
    const id = state.restoreIds[service];
    if (!id || !container(id)) process.exit(1);
    let restoredId = id;
    if (state.replacementOnUp) {
      restoredId = id + "-restored";
      state.containers[restoredId] = {
        ...container(id),
        running: true,
        status: "running",
        networks: {},
      };
      delete state.containers[id];
    } else {
      container(id).running = true; container(id).status = "running";
      if (container(id).health === "none") container(id).health = "healthy";
    }
    state.current[service] = [restoredId];
    record(["up", service]); save(); process.exit(0);
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
  await writeFile(statePath, JSON.stringify(state));
  await writeFile(fakeDocker, fakeDockerSource, { mode: 0o700 });
  await writeFile(docker, `#!/usr/bin/env bash\nexec node "${fakeDocker}" "$@"\n`, { mode: 0o700 });
  await writeFile(systemctl, `#!/usr/bin/env bash\nif [[ "$1" == show ]]; then exec node "${fakeDocker}" systemctl "$@"; fi\nexit 1\n`, { mode: 0o700 });
  await writeFile(sleep, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o700 });

  const driver = String.raw`
set -Eeuo pipefail
source "$RELEASE_HELPER"
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
current_commit="new-commit"
expected_app_version="0.15.5"
docker_started_before="1"
if [[ "$MODE" == image-* || "$MODE" == migration-* ]]; then
  current_commit="$(printf 'a%.0s' {1..40})"
fi
if [[ "$MODE" == go-upgrade ]]; then
  RELEASE_GO_UPGRADE=true
fi
if [[ "$MODE" == node-active || "$MODE" == node-candidate ]]; then
  release_load_profile node-default
else
  release_load_profile go-full
fi
RELEASE_SNAPSHOT_FILE="$STATE_PATH.snapshot"
RELEASE_RECOVERY_FILE="$STATE_PATH.recovery"
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
elif [[ "$MODE" == node-candidate ]]; then
  release_start_candidate api
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
else
  release_snapshot_app_state "$RELEASE_SNAPSHOT_FILE"
  docker set-current api api-new
  docker set-current web web-new
  docker set-current p2p p2p-new
  docker set-current workspace workspace-new
  docker set-current worker worker-new
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
  const { result, finalState } = await runFakeHarness("rollback");
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  for (const id of ["p2p-new", "workspace-new", "worker-new"]) {
    assert.equal(finalState.containers[id], undefined, `${id} was not removed`);
  }
  assert.equal(finalState.containers["api-old"].running, true);
  assert.equal(finalState.containers["web-old"].running, true);
  const stopIndex = finalState.calls.findIndex(([operation, service]) => operation === "stop" && service === "worker");
  const apiUpIndex = finalState.calls.findIndex(([operation, service]) => operation === "up" && service === "api");
  assert.ok(stopIndex >= 0 && apiUpIndex > stopIndex, "Node was restored before Go services were fenced");
  assert.ok(finalState.tags.some(({ ref }) => ref === "duallane-api:old"));
  assert.ok(finalState.tags.some(({ ref }) => ref === "duallane-web:old"));
});

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

test("daemon recovery uses replacement Node IDs after rollback recreation", async () => {
  const { result, finalState, recovery } = await runFakeHarness("rollback-daemon");
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(finalState.containers["api-old"], undefined);
  assert.equal(finalState.containers["web-old"], undefined);
  assert.equal(finalState.containers["api-old-restored"].running, true);
  assert.equal(finalState.containers["web-old-restored"].running, true);
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
  assert.ok(finalState.calls.some(([operation, service]) => operation === "stop" && service === "api"));
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
  assert.match(result.stderr, /--go-upgrade is unavailable/);
});
