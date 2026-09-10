#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const profiles = Object.freeze({
  "node-default": Object.freeze({
    name: "node-default",
    services: Object.freeze(["postgres", "migrate", "api", "web"]),
    build: Object.freeze(["api", "web", "migrate"]),
    candidates: Object.freeze(["api", "web"]),
    backend: Object.freeze(["api"]),
    workers: Object.freeze([]),
    edge: Object.freeze(["web"]),
    goServices: Object.freeze([]),
    goWriters: Object.freeze([]),
    stopBeforeBackend: Object.freeze([]),
    snapshot: Object.freeze(["postgres", "api", "web", "p2p", "workspace", "worker", "v2ray"]),
    restoreOrder: Object.freeze(["postgres", "v2ray", "api", "p2p", "workspace", "worker", "web"]),
    rollbackOrder: Object.freeze(["api", "web"]),
    healthRequired: Object.freeze(["postgres", "api", "web"]),
    requiredServices: Object.freeze(["postgres", "migrate", "api", "web"]),
  }),
  "go-full": Object.freeze({
    name: "go-full",
    services: Object.freeze(["postgres", "migrate", "p2p", "workspace", "worker", "web"]),
    build: Object.freeze(["p2p", "workspace", "worker", "web", "migrate"]),
    candidates: Object.freeze(["p2p", "workspace", "worker", "web"]),
    backend: Object.freeze(["p2p", "workspace"]),
    workers: Object.freeze(["worker"]),
    edge: Object.freeze(["web"]),
    goServices: Object.freeze(["p2p", "workspace", "worker"]),
    goWriters: Object.freeze(["workspace", "worker"]),
    stopBeforeBackend: Object.freeze(["api"]),
    snapshot: Object.freeze(["postgres", "api", "web", "p2p", "workspace", "worker", "v2ray"]),
    restoreOrder: Object.freeze(["postgres", "v2ray", "api", "p2p", "workspace", "worker", "web"]),
    rollbackOrder: Object.freeze(["api", "web"]),
    // Historical recovery still checks a retained API if one exists; it is no
    // longer a required/current Compose service after runtime retirement.
    healthRequired: Object.freeze(["postgres", "api", "p2p", "workspace", "worker", "web"]),
    requiredServices: Object.freeze(["postgres", "migrate", "p2p", "workspace", "worker", "web"]),
  }),
});

const profileNames = Object.freeze(Object.keys(profiles));

function fail(message) {
  throw new Error(message);
}

function assertUnique(values, label) {
  if (new Set(values).size !== values.length) fail(`${label} contains duplicate service names`);
}

function assertSubset(values, allowed, label) {
  for (const value of values) {
    if (!allowed.includes(value)) fail(`${label} references service ${value} outside the profile`);
  }
}

function validateProfile(profile) {
  if (!profile || typeof profile !== "object") fail("release profile is missing");
  if (!profileNames.includes(profile.name)) fail(`unsupported release profile ${String(profile.name)}`);
  for (const field of [
    "services",
    "build",
    "candidates",
    "backend",
    "workers",
    "edge",
    "goServices",
    "goWriters",
    "stopBeforeBackend",
    "snapshot",
    "restoreOrder",
    "rollbackOrder",
    "healthRequired",
    "requiredServices",
  ]) {
    if (!Array.isArray(profile[field]) || profile[field].some((value) => typeof value !== "string" || value.length === 0)) {
      fail(`${profile.name}.${field} must be a non-empty-string array`);
    }
    assertUnique(profile[field], `${profile.name}.${field}`);
  }
  assertSubset(profile.build, profile.services, `${profile.name}.build`);
  assertSubset(profile.candidates, profile.services, `${profile.name}.candidates`);
  assertSubset(profile.backend, profile.services, `${profile.name}.backend`);
  assertSubset(profile.workers, profile.services, `${profile.name}.workers`);
  assertSubset(profile.edge, profile.services, `${profile.name}.edge`);
  assertSubset(profile.goServices, profile.services, `${profile.name}.goServices`);
  assertSubset(profile.goWriters, profile.goServices, `${profile.name}.goWriters`);
  assertSubset(profile.stopBeforeBackend, ["api", ...profile.services], `${profile.name}.stopBeforeBackend`);
  assertSubset(profile.healthRequired, ["api", ...profile.services], `${profile.name}.healthRequired`);
  assertSubset(profile.requiredServices, ["api", ...profile.services], `${profile.name}.requiredServices`);
  assertSubset(profile.rollbackOrder, ["api", ...profile.services], `${profile.name}.rollbackOrder`);
  for (const service of profile.healthRequired) {
    if (!profile.restoreOrder.includes(service)) fail(`${profile.name}.restoreOrder omits health-required service ${service}`);
  }
  if (profile.name === "node-default") {
    for (const field of ["services", "build", "candidates", "backend", "workers", "edge", "goServices", "goWriters", "stopBeforeBackend"]) {
      const expected = profiles["node-default"][field];
      if (JSON.stringify(profile[field]) !== JSON.stringify(expected)) fail(`node-default.${field} is not the immutable Node plan`);
    }
  }
  if (profile.name === "go-full") {
    if (JSON.stringify(profile.goWriters) !== JSON.stringify(["workspace", "worker"])) {
      fail("go-full must fence Workspace and worker before Node rollback");
    }
    if (JSON.stringify(profile.stopBeforeBackend) !== JSON.stringify(["api"])) {
      fail("go-full must stop the Node API before starting Go backend writers");
    }
  }
  return profile;
}

function profileOrFail(name) {
  if (!profileNames.includes(name)) fail(`--profile must be one of ${profileNames.join(", ")}`);
  return validateProfile(profiles[name]);
}

function dependencyCondition(service, dependency, expected) {
  const configured = service?.depends_on;
  if (Array.isArray(configured)) return expected === "service_started" && configured.includes(dependency);
  return configured?.[dependency]?.condition === expected;
}

function healthCommand(service) {
  const test = service?.healthcheck?.test;
  return Array.isArray(test) ? test.join(" ") : "";
}

function environmentValue(service, key) {
  const configured = service?.environment;
  if (Array.isArray(configured)) {
    const entry = configured.find((value) => typeof value === "string" && value.startsWith(`${key}=`));
    return entry?.slice(key.length + 1);
  }
  return configured?.[key];
}

function hasMount(service, destination) {
  return (service?.volumes ?? []).some((mount) => {
    if (typeof mount === "string") {
      const parts = mount.split(":");
      return parts.length >= 2 && parts[1] === destination;
    }
    return mount?.target === destination || mount?.destination === destination;
  });
}

function validateResolvedCompose(profile, compose) {
  validateProfile(profile);
  if (!compose || typeof compose !== "object" || !compose.services || typeof compose.services !== "object") {
    fail("resolved Compose configuration has no services object");
  }
  for (const serviceName of profile.requiredServices) {
    if (!compose.services[serviceName]) fail(`${profile.name} requires Compose service ${serviceName}`);
  }
  for (const serviceName of profile.healthRequired) {
    const service = compose.services[serviceName];
    if (profile.name === "go-full" && serviceName === "api" && !service) continue;
    if (!service.healthcheck || !Array.isArray(service.healthcheck.test)) {
      fail(`${profile.name} requires a healthcheck for ${serviceName}`);
    }
  }
  if (profile.name === "node-default") return;

  const p2p = compose.services.p2p;
  const workspace = compose.services.workspace;
  const worker = compose.services.worker;
  const web = compose.services.web;
  const migrate = compose.services.migrate;
  const postgres = compose.services.postgres;
  for (const [serviceName, service] of [["p2p", p2p], ["workspace", workspace], ["worker", worker]]) {
    const command = healthCommand(service);
    if (!command.includes("/usr/local/bin/duallane-healthcheck")) {
      fail(`go-full ${serviceName} healthcheck must use the parent-provided read-only health binary`);
    }
  }
  for (const serviceName of ["workspace", "worker"]) {
    if (environmentValue(compose.services[serviceName], "WORKSPACE_ENABLED") !== "true") {
      fail(`go-full ${serviceName} must set WORKSPACE_ENABLED=true in resolved Compose`);
    }
    if (compose.services[serviceName].user !== "65532:65532") {
      fail(`go-full ${serviceName} must run as the non-root 65532:65532 user`);
    }
    if (!hasMount(compose.services[serviceName], "/app/data")) {
      fail(`go-full ${serviceName} must expose the legacy local data mount at /app/data`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(p2p.depends_on ?? {}, "postgres") ||
      Object.prototype.hasOwnProperty.call(p2p.depends_on ?? {}, "workspace")) {
    fail("go-full P2P must not depend on PostgreSQL or Workspace");
  }
  for (const serviceName of ["workspace", "worker"]) {
    const service = compose.services[serviceName];
    if (!dependencyCondition(service, "postgres", "service_healthy") ||
        !dependencyCondition(service, "migrate", "service_completed_successfully")) {
      fail(`go-full ${serviceName} must wait for healthy PostgreSQL and completed migrate`);
    }
  }
  if (!dependencyCondition(web, "p2p", "service_healthy") ||
      !dependencyCondition(web, "workspace", "service_healthy")) {
    fail("go-full Web must wait for healthy P2P and Workspace");
  }
  if (!dependencyCondition(migrate, "postgres", "service_healthy")) {
    fail("go-full migrate must wait for healthy PostgreSQL");
  }
  if (migrate.restart !== "no") fail("go-full migrate must remain one-shot with restart no");
  const workspaceImage = workspace.image;
  const workerImage = worker.image;
  const migrateImage = migrate.image;
  if (!workspaceImage || workspaceImage !== workerImage || workspaceImage !== migrateImage) {
    fail("go-full Workspace, worker, and migrate must use one resolved image reference");
  }
  return true;
}

function shellArray(values) {
  return values.join(",");
}

function shellPlan(profile) {
  const fields = {
    PROFILE: [profile.name],
    SERVICES: profile.services,
    BUILD_SERVICES: profile.build,
    CANDIDATE_SERVICES: profile.candidates,
    BACKEND_SERVICES: profile.backend,
    WORKER_SERVICES: profile.workers,
    EDGE_SERVICES: profile.edge,
    GO_SERVICES: profile.goServices,
    GO_WRITERS: profile.goWriters,
    STOP_BEFORE_BACKEND: profile.stopBeforeBackend,
    SNAPSHOT_SERVICES: profile.snapshot,
    RESTORE_ORDER: profile.restoreOrder,
    ROLLBACK_ORDER: profile.rollbackOrder,
    HEALTH_REQUIRED: profile.healthRequired,
    REQUIRED_SERVICES: profile.requiredServices,
  };
  for (const [key, values] of Object.entries(fields)) process.stdout.write(`${key}=${shellArray(values)}\n`);
}

async function main(argv) {
  let profileName = "";
  let format = "json";
  let checkCompose = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--profile") {
      profileName = argv[++index] ?? "";
    } else if (arg === "--format") {
      format = argv[++index] ?? "";
    } else if (arg === "--check-compose") {
      checkCompose = true;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write("Usage: release-manifest.mjs --profile node-default|go-full [--format json|shell] [--check-compose]\n");
      return;
    } else {
      fail(`unknown argument ${arg}`);
    }
  }
  const profile = profileOrFail(profileName);
  if (checkCompose) {
    let input = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) input += chunk;
    let compose;
    try {
      compose = JSON.parse(input);
    } catch {
      fail("resolved Compose configuration is not valid JSON");
    }
    validateResolvedCompose(profile, compose);
    return;
  }
  if (format === "shell") {
    shellPlan(profile);
    return;
  }
  if (format !== "json") fail(`unsupported output format ${format}`);
  process.stdout.write(`${JSON.stringify(profile)}\n`);
}

export { profiles, profileNames, profileOrFail, validateProfile, validateResolvedCompose };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`release manifest rejected: ${error instanceof Error ? error.message : "invalid input"}\n`);
    process.exitCode = 1;
  }
}
