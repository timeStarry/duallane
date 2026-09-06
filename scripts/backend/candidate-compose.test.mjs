import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const composeFile = path.join(root, "deploy/candidate/compose.yaml");
const envFile = path.join(root, "deploy/candidate/.env.example");
const nginxFile = path.join(root, "deploy/candidate/nginx.conf");

const failures = [];

function fail(message) {
  failures.push(message);
}

function requireValue(condition, message) {
  if (!condition) fail(message);
}

function service(config, name) {
  const value = config.services?.[name];
  requireValue(value, `missing service ${name}`);
  return value ?? {};
}

function envMap(configured) {
  if (configured && !Array.isArray(configured)) return configured;
  return Object.fromEntries((configured ?? []).map((entry) => {
    const index = entry.indexOf("=");
    return index < 0 ? [entry, ""] : [entry.slice(0, index), entry.slice(index + 1)];
  }));
}

function healthCommand(value) {
  return Array.isArray(value?.test) ? value.test.join(" ") : "";
}

function dependencyCondition(configured, name, condition) {
  return configured?.[name]?.condition === condition;
}

function hasNamedVolume(value, source) {
  return (value ?? []).some((item) => {
    if (typeof item === "string") return item.split(":")[0] === source;
    return item.source === source && item.type === "volume";
  });
}

function checkNoSensitiveProbe(command, serviceName) {
  const lower = command.toLowerCase();
  for (const forbidden of ["post ", "curl -x", "psql ", "migrate", "seed", "touch ", "mkdir ", "rm "]) {
    requireValue(!lower.includes(forbidden), `${serviceName} healthcheck contains mutating/secret-bearing token ${forbidden}`);
  }
}

function checkRoutes(nginx) {
  const expectedRoutes = [
    ["/api/p2p/", "http://p2p:8787"],
    ["/api/auth/", "http://workspace:8787"],
    ["/api/workspace/", "http://workspace:8787"],
    ["/api/bot-gateway/", "http://workspace:8787"],
    ["/ws/p2p/", "http://p2p:8787"],
    ["/ws/workspace", "http://workspace:8787"],
    ["/ws/bot-gateway", "http://workspace:8787"],
  ];
  for (const [route, upstream] of expectedRoutes) {
    requireValue(nginx.includes(`location ${route}`) || nginx.includes(`location ^~ ${route}`) || nginx.includes(`location = ${route}`), `missing Nginx route ${route}`);
    requireValue(nginx.includes(`proxy_pass ${upstream}`), `missing Nginx upstream ${upstream} for ${route}`);
  }
  requireValue(nginx.includes("location = /api/health") && nginx.includes("proxy_pass http://workspace:8787"), "public health must use Workspace projection");
  requireValue(!nginx.includes("proxy_pass http://api:"), "candidate Nginx still references legacy api upstream");
  const p2pRoute = nginx.match(/location \^~ \/api\/p2p\/ \{([\s\S]*?)\n    \}/)?.[1] ?? "";
  requireValue(p2pRoute.includes("client_max_body_size 11m"), "P2P gateway transport limit must remain 11 MiB");
  requireValue(!p2pRoute.includes("client_max_body_size 1m"), "P2P gateway must not replace the application JSON 1 MiB limit with an Nginx limit");
  requireValue(nginx.includes("client_max_body_size 11m"), "Workspace body limit is not preserved at 11 MiB");
  requireValue(nginx.includes("proxy_set_header Upgrade $http_upgrade"), "WebSocket Upgrade header is missing");
  requireValue(nginx.includes("proxy_set_header Connection $connection_upgrade"), "WebSocket Connection header is missing");
  requireValue(nginx.includes("proxy_read_timeout 3600s") && nginx.includes("proxy_send_timeout 3600s"), "WebSocket timeout policy is missing");
  requireValue(nginx.includes("error_log /dev/null crit") && nginx.includes("location = /api/auth/github/callback"), "OAuth callback error-log isolation is missing");
  for (const header of ["Referrer-Policy", "X-Content-Type-Options", "Content-Security-Policy"]) {
    requireValue(nginx.includes(header), `security header ${header} is missing`);
  }
  requireValue(!nginx.includes("#k="), "candidate gateway contains a browser-only invite fragment");
  for (const privatePath of ["/readyz", "/healthz", "/metrics"]) {
    const escapedPath = privatePath.replaceAll("/", "\\/");
    requireValue(new RegExp(`location = ${escapedPath} \\{\\s*return 404;\\s*\\}`).test(nginx), `private endpoint ${privatePath} must be denied before SPA fallback`);
  }
}

async function main() {
  const compose = spawnSync("docker", [
    "compose", "--project-name", "duallane-candidate", "--env-file", envFile,
    "-f", composeFile, "config", "--format", "json",
  ], { cwd: root, encoding: "utf8" });
  if (compose.error) {
    fail(`docker compose is unavailable: ${compose.error.message}`);
  } else if (compose.status !== 0) {
    fail(`docker compose config failed (${compose.status}): ${compose.stderr.trim()}`);
  }

  if (failures.length === 0) {
    let config;
    try {
      config = JSON.parse(compose.stdout);
    } catch (error) {
      fail(`docker compose config was not JSON: ${error.message}`);
    }
    if (config) {
      requireValue(config.name === "duallane-candidate", `Compose project name is ${config.name ?? "missing"}, expected duallane-candidate`);
      const web = service(config, "web");
      const p2p = service(config, "p2p");
      const workspace = service(config, "workspace");
      const worker = service(config, "worker");
      const migrate = service(config, "migrate");
      const postgres = service(config, "postgres");
      const workspaceEnv = envMap(workspace.environment);
      const workerEnv = envMap(worker.environment);
      const p2pEnv = envMap(p2p.environment);
      const defaultNetwork = config.networks?.default;

      requireValue(defaultNetwork && defaultNetwork.external !== true, "candidate default network must be local and non-external");
      requireValue(String(defaultNetwork?.name ?? "").startsWith("duallane-candidate"), "candidate default network must have an isolated candidate name");
      for (const name of ["web", "p2p", "workspace", "worker", "migrate", "postgres"]) {
        requireValue(service(config, name).network_mode !== "host", `${name} must not use host networking`);
      }

      const published = web.ports ?? [];
      requireValue(published.length === 1, `Web must have exactly one published port, got ${published.length}`);
      if (published.length === 1) {
        requireValue(published[0].host_ip === "127.0.0.1", `Web host binding is ${published[0].host_ip ?? "missing"}, expected 127.0.0.1`);
        requireValue(Number(published[0].target) === 8080, "Web published target must be 8080");
      }
      for (const name of ["p2p", "workspace", "worker", "migrate", "postgres"]) {
        requireValue(!(service(config, name).ports?.length), `${name} must not publish a host port`);
      }

      requireValue(workspaceEnv.WORKSPACE_ENABLED === "true", "Workspace gate must be exactly true");
      requireValue(workerEnv.WORKSPACE_ENABLED === "true", "worker Workspace gate must be exactly true");
      requireValue(workerEnv.WORKSPACE_NTFY_WORKER_ENABLED === "false", "worker Ntfy delivery must default off");
      requireValue(workerEnv.WORKSPACE_EMAIL_WORKER_ENABLED === "false", "worker email delivery must default off");
      requireValue(workerEnv.WORKSPACE_MAINTENANCE_WORKER_ENABLED === "false", "worker maintenance must default off");
      requireValue(workerEnv.WORKSPACE_ECHO_WORKER_ENABLED === "false", "worker Echo reconciliation must default off");
      requireValue(workspaceEnv.WORKSPACE_ECHO_WORKER_ENABLED === "false", "Workspace HTTP process must not claim Echo background work");

      requireValue(workspace.image === worker.image && worker.image === migrate.image, "workspace/worker/migrate must use the same candidate image reference; runtime validation also checks image IDs");
      requireValue(dependencyCondition(web.depends_on, "p2p", "service_healthy") && dependencyCondition(web.depends_on, "workspace", "service_healthy"), "Web must fail closed until both backend healthchecks pass");
      requireValue(dependencyCondition(workspace.depends_on, "postgres", "service_healthy") && dependencyCondition(workspace.depends_on, "migrate", "service_completed_successfully"), "Workspace dependency order is not fail-closed");
      requireValue(dependencyCondition(worker.depends_on, "postgres", "service_healthy") && dependencyCondition(worker.depends_on, "migrate", "service_completed_successfully"), "worker dependency order is not fail-closed");
      requireValue(dependencyCondition(migrate.depends_on, "postgres", "service_healthy"), "migrate must wait for PostgreSQL health");
      requireValue(migrate.restart === "no", "migrate must be one-shot with restart no");
      requireValue(!p2p.depends_on, "P2P must not depend on Workspace or PostgreSQL");

      requireValue(p2p.user === "65532:65532" && workspace.user === "65532:65532" && worker.user === "65532:65532" && migrate.user === "65532:65532", "Go services must run as the non-root image owner");
      requireValue(web.user === "101:101", "Web must run as the non-root nginx owner");
      requireValue(web.tmpfs?.includes("/var/cache/nginx:uid=101,gid=101,mode=0700"), "Nginx cache tmpfs must be writable only by its non-root owner");
      for (const name of ["web", "p2p", "workspace", "worker", "migrate"]) {
        requireValue(service(config, name).read_only === true, `${name} must be read-only apart from declared candidate volumes/tmpfs`);
      }
      requireValue(p2p.volumes == null || p2p.volumes.length === 0, "P2P must have no runtime mounts");
      requireValue(p2p.secrets == null || p2p.secrets.length === 0, "P2P must have no runtime secrets");

      const forbiddenP2PKeys = /(DATABASE|^PG|S3|OAUTH|SMTP|WORKSPACE|SESSION|BOT_TOKEN|ENCRYPTION|STORAGE)/i;
      for (const key of Object.keys(p2pEnv)) {
        requireValue(!forbiddenP2PKeys.test(key), `P2P receives forbidden configuration ${key}`);
      }
      const serialized = JSON.stringify(config).toLowerCase();
      for (const forbidden of ["production-postgres", "duallane-postgres", "/home/timestarry/duallane", "docker-compose.production", "external: true"]) {
        requireValue(!serialized.includes(forbidden), `candidate config references forbidden production state ${forbidden}`);
      }
      for (const [name, value] of Object.entries(config.volumes ?? {})) {
        requireValue(value.external !== true, `candidate volume ${name} must not be external`);
        requireValue(String(value.name ?? "").startsWith(`${config.name}_`), `candidate volume ${name} must have a project-scoped name`);
      }
      requireValue(hasNamedVolume(workspace.volumes, "candidate-workspace-data"), "Workspace must use a candidate named data volume");
      requireValue(hasNamedVolume(worker.volumes, "candidate-workspace-data"), "worker must use a candidate named data volume");
      requireValue(hasNamedVolume(postgres.volumes, "candidate-postgres-data"), "PostgreSQL must use a candidate named data volume");

      const healthServices = {
        web: { endpoint: "/api/health", marker: '"ok":true', privateProbe: false },
        p2p: { endpoint: "/api/health", marker: '"ok":true', privateProbe: true },
        workspace: { endpoint: "/readyz", marker: '"state":"ready"', privateProbe: true },
        worker: { endpoint: "/readyz", marker: '"state":"ready"', privateProbe: true },
      };
      for (const [name, health] of Object.entries(healthServices)) {
        const command = healthCommand(service(config, name).healthcheck);
        requireValue(command.includes(health.endpoint), `${name} healthcheck must probe ${health.endpoint}`);
        requireValue(service(config, name).healthcheck?.timeout, `${name} healthcheck needs a timeout`);
        requireValue(Number(service(config, name).healthcheck?.retries) > 0, `${name} healthcheck needs bounded retries`);
        checkNoSensitiveProbe(command, name);
        if (health.privateProbe) {
          requireValue(service(config, name).healthcheck?.test?.[0] === "CMD", `${name} healthcheck must use the read-only image probe directly`);
          requireValue(command.includes("/usr/local/bin/duallane-healthcheck"), `${name} healthcheck requires the parent-provided health binary`);
          requireValue(!command.includes("wget") && !command.includes("CMD-SHELL"), `${name} healthcheck must not depend on an absent shell HTTP client`);
        } else {
          requireValue(command.includes(health.marker), `${name} healthcheck must require ${health.marker}`);
        }
      }
      requireValue(!healthCommand(workspace.healthcheck).includes("/api/health"), "Workspace readiness must not use the public liveness projection");
      const postgresHealth = healthCommand(postgres.healthcheck);
      requireValue(postgresHealth.includes("pg_isready"), "PostgreSQL healthcheck must be read-only pg_isready");
      checkNoSensitiveProbe(postgresHealth, "postgres");
      requireValue(!healthCommand(migrate.healthcheck), "migrate must not claim readiness as a long-running service");
      requireValue(!healthCommand(p2p.healthcheck).includes("PGPASSWORD"), "P2P healthcheck must not expose DB credentials");

    }
  }

  let composeSource;
  let nginx;
  try {
    composeSource = await readFile(composeFile, "utf8");
    nginx = await readFile(nginxFile, "utf8");
  } catch (error) {
    fail(`cannot read candidate configuration: ${error.message}`);
  }
  if (composeSource) {
    requireValue(composeSource.includes('127.0.0.1:${CANDIDATE_WEB_PORT:-8788}:8080'), "candidate Web must hard-code its loopback bind");
    requireValue(!composeSource.includes("CANDIDATE_WEB_BIND"), "candidate Web must not expose a bind-address override");
    requireValue(!composeSource.includes("CANDIDATE_POSTGRES_VOLUME_NAME") && !composeSource.includes("CANDIDATE_WORKSPACE_VOLUME_NAME"), "candidate volume names must not be user-overridable");
    requireValue(!composeSource.includes("DUALLANE_ECHO_RELEASE_CATALOG_PATH"), "release catalog path must come from the image default");
  }
  if (nginx) checkRoutes(nginx);

  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`FAIL ${failure}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`candidate-compose guard PASS (${Object.keys(JSON.parse(compose.stdout).services).length} services)\n`);
}

await main();
