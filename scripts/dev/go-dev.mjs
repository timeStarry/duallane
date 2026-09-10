/*
 * Usage: node scripts/dev/go-dev.mjs [options]
 *
 * Starts the local Go P2P process, Go Workspace process, and Vite only. The
 * runner never starts the retired Node API, worker, migration command, Docker,
 * or a database. It owns only the child processes it spawned and never scans
 * or kills processes merely because they use one of these ports.
 *
 * Workspace is enabled only when WORKSPACE_ENABLED=true exactly. If it is
 * enabled, supply an explicit loopback development DATABASE_URL or PG*
 * configuration. Default postgres/template databases, ambient service/host
 * overrides, and URL-conflicting PG* values are rejected before any Go child
 * is built or started. Run the Go migration command separately before using
 * persisted features:
 *
 *   cd apps/backend
 *   go run ./cmd/migrate
 *
 * The runner does not create or migrate a database. The worker is also a
 * separate process and is not started here. To run it intentionally:
 *
 *   cd apps/backend
 *   go run ./cmd/worker
 *
 * Use it only against a synthetic/disposable database with provider switches
 * deliberately set. This runner does not perform real provider verification.
 *
 * Dotenv files are loaded for development convenience in this order:
 * root .env/.env.local, then apps/web .env/.env.local/.env.development/
 * .env.development.local. Explicit shell variables win, and no environment
 * values are printed.
 */

import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { parseEnv } from "node:util";
import path from "node:path";
import {
  spawnOwnedProcess,
  stopOwnedProcess,
  waitForExit
} from "../../e2e/support/owned-process.mjs";
import {
  DEFAULT_DEV_PORTS,
  createGoDevOrigins
} from "./go-dev-config.mjs";

export const LEGACY_NODE_API_PORT = 8787;
export const DEV_HOST = "127.0.0.1";

const runnerDirectory = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = path.resolve(runnerDirectory, "../..");
export const DEFAULT_PATHS = Object.freeze({
  repositoryRoot: REPOSITORY_ROOT,
  backendRoot: path.join(REPOSITORY_ROOT, "apps", "backend"),
  webRoot: path.join(REPOSITORY_ROOT, "apps", "web"),
  viteCli: path.join(REPOSITORY_ROOT, "apps", "web", "node_modules", "vite", "bin", "vite.js")
});

const GO_TOOL_ENVIRONMENT_KEYS = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "GOPATH",
  "GOMODCACHE",
  "GOCACHE",
  "GOENV",
  "GOFLAGS",
  "GOPROXY",
  "GOSUMDB",
  "GOPRIVATE",
  "GONOSUMDB",
  "GONOPROXY",
  "GOTOOLCHAIN",
  "GOWORK",
  "GOOS",
  "GOARCH",
  "CGO_ENABLED",
  "CC",
  "CXX",
  "LANG",
  "LC_ALL",
  "NO_PROXY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY"
];

const P2P_CONFIGURATION_KEYS = [
  "DUALLANE_STUN_URLS",
  "DUALLANE_TURN_URLS",
  "DUALLANE_TURN_SHARED_SECRET",
  "DUALLANE_TURN_USERNAME",
  "DUALLANE_TURN_CREDENTIAL",
  "DUALLANE_TURN_TTL_SECONDS",
  "DUALLANE_P2P_ROOM_TTL_MS",
  "DUALLANE_EMPTY_ROOM_GRACE_MS",
  "DUALLANE_P2P_MAX_FRAME_BYTES"
];

const VITE_ENVIRONMENT_KEYS = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "LANG",
  "LC_ALL",
  "NODE_OPTIONS",
  "BROWSER",
  "CI"
];

const DOTENV_RELATIVE_PATHS = [
  ".env",
  ".env.local",
  path.join("apps", "web", ".env"),
  path.join("apps", "web", ".env.local"),
  path.join("apps", "web", ".env.development"),
  path.join("apps", "web", ".env.development.local")
];

const LOOPBACK_DATABASE_HOSTNAMES = new Set(["127.0.0.1", "[::1]"]);
const DEFAULT_DATABASE_NAMES = new Set(["postgres", "template0", "template1"]);
const ALLOWED_DATABASE_QUERY_KEYS = new Set(["sslmode"]);
const AMBIENT_DATABASE_OVERRIDE_KEYS = ["PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE", "PGPASSFILE"];

function workspaceDatabaseError() {
  return new Error("WORKSPACE_ENABLED=true requires an explicit loopback PostgreSQL development database; default databases and connection overrides are rejected");
}

function requireDevelopmentDatabaseName(rawName) {
  const name = String(rawName ?? "").trim();
  if (!name || name.includes("/") || name.includes("\\") || /[\r\n]/.test(name) || DEFAULT_DATABASE_NAMES.has(name.toLowerCase())) {
    throw workspaceDatabaseError();
  }
}

function requireLoopbackDatabaseURL(rawValue) {
  let url;
  try {
    url = new URL(rawValue);
  } catch {
    throw workspaceDatabaseError();
  }
  if (![
    "postgres:",
    "postgresql:"
  ].includes(url.protocol) || !LOOPBACK_DATABASE_HOSTNAMES.has(url.hostname.toLowerCase()) || !url.pathname || url.pathname === "/" || url.hash) {
    throw workspaceDatabaseError();
  }
  let databaseName;
  try {
    databaseName = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw workspaceDatabaseError();
  }
  requireDevelopmentDatabaseName(databaseName);
  if ([...url.searchParams.keys()].some((key) => !ALLOWED_DATABASE_QUERY_KEYS.has(key))) {
    throw workspaceDatabaseError();
  }
}

function requireDevelopmentDatabasePort(rawPort) {
  const port = String(rawPort ?? "").trim();
  if (!port) return;
  const value = Number(port);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw workspaceDatabaseError();
}

function normalizeDatabaseHost(rawHost) {
  const host = String(rawHost ?? "").trim();
  if (host === "::1") return "[::1]";
  return host.toLowerCase();
}

export function validateWorkspaceDatabaseTarget(environment = process.env) {
  if (lookupCaseInsensitive(environment, "WORKSPACE_ENABLED") !== "true") return;

  // pgx consults libpq-compatible environment settings even when a URL is
  // present. Reject service, passfile, and alternate-host inputs so a local
  // development URL cannot inherit a hidden routing or filesystem override.
  const hasValue = (key) => {
    const value = lookupCaseInsensitive(environment, key);
    return typeof value === "string" && value !== "";
  };
  if (AMBIENT_DATABASE_OVERRIDE_KEYS.some(hasValue) || hasValue("PGOPTIONS")) throw workspaceDatabaseError();

  const rawDatabaseURL = lookupCaseInsensitive(environment, "DATABASE_URL");
  const databaseURL = typeof rawDatabaseURL === "string" && rawDatabaseURL.trim() ? rawDatabaseURL.trim() : "";
  if (databaseURL) {
    // DATABASE_URL wins over these fields in the current resolver, but
    // rejecting them keeps the reviewed target explicit and stable if pgx's
    // environment merge behavior changes.
    if (["PGHOST", "PGPORT", "PGDATABASE"].some(hasValue)) throw workspaceDatabaseError();
    requireLoopbackDatabaseURL(databaseURL);
    return;
  }

  const host = normalizeDatabaseHost(lookupCaseInsensitive(environment, "PGHOST"));
  if (!LOOPBACK_DATABASE_HOSTNAMES.has(host)) throw workspaceDatabaseError();
  requireDevelopmentDatabasePort(lookupCaseInsensitive(environment, "PGPORT"));
  requireDevelopmentDatabaseName(lookupCaseInsensitive(environment, "PGDATABASE"));
}

function optionValue(argv, index, option, inlineValue) {
  if (inlineValue !== undefined) {
    if (!inlineValue) throw new Error(`${option} requires a value`);
    return { value: inlineValue, nextIndex: index };
  }
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return { value, nextIndex: index + 1 };
}

function parsePort(rawValue, name, fallback) {
  const raw = rawValue === undefined || rawValue === "" ? String(fallback) : String(rawValue).trim();
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return value;
}

function nonEmptyEnvironmentValue(environment, key, fallback) {
  const value = environment?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function isLoopbackHost(host) {
  return host === DEV_HOST;
}

function lookupCaseInsensitive(environment, key) {
  const actualKey = Object.keys(environment).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
  return actualKey === undefined ? undefined : environment[actualKey];
}

function copyEnvironmentKeys(source, keys) {
  const result = {};
  for (const key of keys) {
    const actualKey = Object.keys(source).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
    if (actualKey !== undefined) result[actualKey] = source[actualKey];
  }
  return result;
}

export function parseArguments(argv = [], environment = process.env, paths = DEFAULT_PATHS) {
  const options = {
    help: false,
    host: nonEmptyEnvironmentValue(environment, "DUALLANE_DEV_HOST", DEV_HOST),
    p2pPort: parsePort(environment.DUALLANE_DEV_P2P_PORT, "DUALLANE_DEV_P2P_PORT", DEFAULT_DEV_PORTS.p2p),
    workspacePort: parsePort(environment.DUALLANE_DEV_WORKSPACE_PORT, "DUALLANE_DEV_WORKSPACE_PORT", DEFAULT_DEV_PORTS.workspace),
    webPort: parsePort(environment.DUALLANE_DEV_WEB_PORT, "DUALLANE_DEV_WEB_PORT", DEFAULT_DEV_PORTS.web),
    goBin: nonEmptyEnvironmentValue(environment, "GO_BIN", "go"),
    viteCli: nonEmptyEnvironmentValue(environment, "DUALLANE_VITE_CLI", paths.viteCli)
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    const separator = argument.indexOf("=");
    const name = separator === -1 ? argument : argument.slice(0, separator);
    const inlineValue = separator === -1 ? undefined : argument.slice(separator + 1);
    const option = {
      "--host": "host",
      "--p2p-port": "p2pPort",
      "--workspace-port": "workspacePort",
      "--web-port": "webPort",
      "--go-bin": "goBin",
      "--vite-cli": "viteCli"
    }[name];
    if (!option) throw new Error(`unknown option: ${argument}`);
    const parsed = optionValue(argv, index, name, inlineValue);
    index = parsed.nextIndex;
    if (option === "host" || option === "goBin" || option === "viteCli") {
      options[option] = parsed.value.trim();
    } else {
      options[option] = parsePort(parsed.value, name, DEFAULT_DEV_PORTS[option === "p2pPort" ? "p2p" : option === "workspacePort" ? "workspace" : "web"]);
    }
  }

  if (options.help) return options;
  if (!isLoopbackHost(options.host)) {
    throw new Error("development services must bind to 127.0.0.1; public hosts are rejected");
  }
  if (!options.goBin) throw new Error("--go-bin must not be empty");
  if (!options.viteCli) throw new Error("--vite-cli must not be empty");
  const ports = [options.p2pPort, options.workspacePort, options.webPort];
  if (new Set(ports).size !== ports.length) {
    throw new Error("P2P, Workspace, and Vite development ports must be distinct");
  }
  if (ports.includes(LEGACY_NODE_API_PORT)) {
    throw new Error("Go development ports must not use the retired Node API port 8787");
  }
  return options;
}

export function loadDevelopmentEnvironment({
  baseEnvironment = process.env,
  repositoryRoot = REPOSITORY_ROOT
} = {}) {
  const result = { ...baseEnvironment };
  const explicitKeys = new Set(Object.keys(baseEnvironment).map((key) => key.toLowerCase()));
  for (const relativePath of DOTENV_RELATIVE_PATHS) {
    const absolutePath = path.join(repositoryRoot, relativePath);
    let source;
    try {
      source = readFileSync(absolutePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw new Error(`could not read development dotenv file ${relativePath}`);
    }
    let parsed;
    try {
      parsed = parseEnv(source);
    } catch {
      throw new Error(`invalid development dotenv file ${relativePath}`);
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (!explicitKeys.has(key.toLowerCase()) && typeof value === "string") result[key] = value;
    }
  }
  return result;
}

export function buildServiceEnvironments(baseEnvironment, options) {
  validateWorkspaceDatabaseTarget(baseEnvironment);
  const origins = createGoDevOrigins({
    host: options.host,
    p2pPort: options.p2pPort,
    workspacePort: options.workspacePort
  });
  const p2p = copyEnvironmentKeys(baseEnvironment, [...GO_TOOL_ENVIRONMENT_KEYS, ...P2P_CONFIGURATION_KEYS]);
  Object.assign(p2p, {
    HOST: options.host,
    PORT: String(options.p2pPort),
    PUBLIC_BASE_URL: `http://${options.host}:${options.webPort}`,
    TRUST_PROXY: "false",
    DUALLANE_APP_VERSION: nonEmptyEnvironmentValue(baseEnvironment, "DUALLANE_APP_VERSION", "dev"),
    DUALLANE_GIT_COMMIT: nonEmptyEnvironmentValue(baseEnvironment, "DUALLANE_GIT_COMMIT", "working-tree")
  });

  const workspace = { ...baseEnvironment };
  Object.assign(workspace, {
    HOST: options.host,
    PORT: String(options.workspacePort),
    NODE_ENV: "development",
    PUBLIC_BASE_URL: `http://${options.host}:${options.webPort}`,
    WORKSPACE_FRONTEND_URL: `http://${options.host}:${options.webPort}`,
    TRUST_PROXY: "false",
    DATABASE_AUTO_MIGRATE: "false",
    WORKSPACE_ENABLED: lookupCaseInsensitive(baseEnvironment, "WORKSPACE_ENABLED") ?? "false",
    WORKSPACE_NTFY_WORKER_ENABLED: "false",
    WORKSPACE_EMAIL_WORKER_ENABLED: "false",
    WORKSPACE_MAINTENANCE_WORKER_ENABLED: "false",
    WORKSPACE_ECHO_WORKER_ENABLED: "false",
    DUALLANE_APP_VERSION: nonEmptyEnvironmentValue(baseEnvironment, "DUALLANE_APP_VERSION", "dev"),
    DUALLANE_GIT_COMMIT: nonEmptyEnvironmentValue(baseEnvironment, "DUALLANE_GIT_COMMIT", "working-tree")
  });

  const vite = copyEnvironmentKeys(baseEnvironment, VITE_ENVIRONMENT_KEYS);
  const legacyOrigin = nonEmptyEnvironmentValue(baseEnvironment, "DUALLANE_API_ORIGIN", "");
  if (legacyOrigin) vite.DUALLANE_API_ORIGIN = legacyOrigin;
  vite.DUALLANE_P2P_API_ORIGIN = origins.p2p;
  vite.DUALLANE_WORKSPACE_API_ORIGIN = origins.workspace;
  vite.NODE_ENV = "development";

  return { p2p, workspace, vite, origins };
}

function buildGoEnvironment(baseEnvironment) {
  return copyEnvironmentKeys(baseEnvironment, GO_TOOL_ENVIRONMENT_KEYS);
}

export function createGoBuildPlan(options, outputDirectory, paths = DEFAULT_PATHS) {
  const extension = process.platform === "win32" ? ".exe" : "";
  return ["p2p", "workspace"].map((service) => {
    const outputPath = path.join(outputDirectory, `${service}${extension}`);
    return {
      service,
      name: `build Go ${service}`,
      command: options.goBin,
      outputPath,
      args: ["build", "-trimpath", "-buildvcs=false", "-o", outputPath, `./cmd/${service}`],
      cwd: paths.backendRoot
    };
  });
}

export function createProcessPlan(options, baseEnvironment, paths = DEFAULT_PATHS, binaryPaths = {}) {
  const environments = buildServiceEnvironments(baseEnvironment, options);
  if (!binaryPaths.p2p || !binaryPaths.workspace) {
    throw new Error("built Go binaries are required before starting development services");
  }
  return [
    {
      name: "Go P2P",
      command: binaryPaths.p2p,
      args: [],
      cwd: paths.backendRoot,
      env: environments.p2p
    },
    {
      name: "Go Workspace",
      command: binaryPaths.workspace,
      args: [],
      cwd: paths.backendRoot,
      env: environments.workspace
    },
    {
      name: "Vite",
      command: process.execPath,
      args: [options.viteCli, ".", "--host", options.host, "--port", String(options.webPort), "--strictPort"],
      cwd: paths.webRoot,
      env: environments.vite
    }
  ];
}

export async function buildGoBinaries(options, baseEnvironment, outputDirectory, paths = DEFAULT_PATHS) {
  const buildEnvironment = buildGoEnvironment(baseEnvironment);
  const buildPlan = createGoBuildPlan(options, outputDirectory, paths);
  const binaries = {};
  let activeChild;
  let stopping = false;
  let stopPromise;
  let cleanupFailure;
  const stopActiveBuild = () => {
    if (!activeChild) return Promise.resolve();
    stopPromise ??= stopOwnedProcess(activeChild);
    return stopPromise;
  };
  const recordCleanupFailure = () => {
    cleanupFailure ??= new Error("one or more owned development processes could not be stopped");
  };
  const requestShutdown = () => {
    stopping = true;
    void stopActiveBuild().catch(recordCleanupFailure);
  };
  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);
  let operationFailure;
  let result = null;
  try {
    for (const processSpec of buildPlan) {
      if (stopping) break;
      activeChild = spawnOwnedProcess(processSpec.command, processSpec.args, {
        cwd: processSpec.cwd,
        env: buildEnvironment,
        stdio: "inherit"
      });
      const exitResult = await waitForExit(activeChild);
      await stopActiveBuild();
      activeChild = undefined;
      stopPromise = undefined;
      if (stopping) break;
      if (exitResult.code !== 0 || exitResult.signal) {
        throw new Error(`${processSpec.name} failed (${exitDescription(exitResult)})`);
      }
      binaries[processSpec.service] = processSpec.outputPath;
    }
    if (!stopping) result = binaries;
  } catch (error) {
    operationFailure = error;
  } finally {
    try {
      await stopActiveBuild();
    } catch {
      recordCleanupFailure();
    }
    process.removeListener("SIGINT", requestShutdown);
    process.removeListener("SIGTERM", requestShutdown);
  }
  if (operationFailure) throw operationFailure;
  if (cleanupFailure) throw cleanupFailure;
  return result;
}

export async function stopManagedProcesses(children, graceMs = 5_000) {
  const uniqueChildren = [...new Set(children.filter(Boolean))].reverse();
  const results = await Promise.allSettled(uniqueChildren.map((child) => stopOwnedProcess(child, graceMs)));
  if (results.some((result) => result.status === "rejected")) {
    throw new Error("one or more owned development processes could not be stopped");
  }
}

function exitDescription(result) {
  if (result.signal) return `signal ${result.signal}`;
  return `exit code ${result.code ?? 1}`;
}

async function runProcessPlan(plan) {
  const children = [];
  let stopping = false;
  let stopPromise;
  let cleanupFailure;
  const stopAll = () => {
    stopPromise ??= stopManagedProcesses(children);
    return stopPromise;
  };
  const recordCleanupFailure = () => {
    cleanupFailure ??= new Error("one or more owned development processes could not be stopped");
  };
  const requestShutdown = () => {
    stopping = true;
    void stopAll().catch(recordCleanupFailure);
  };
  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);
  let operationFailure;
  let result = 0;
  try {
    for (const processSpec of plan) {
      if (stopping) break;
      const child = spawnOwnedProcess(processSpec.command, processSpec.args, {
        cwd: processSpec.cwd,
        env: processSpec.env,
        stdio: "inherit"
      });
      children.push(child);
    }
    if (!stopping && children.length > 0) {
      const firstExit = await Promise.race(children.map(async (child, index) => ({
        index,
        result: await waitForExit(child)
      })));
      if (!stopping) {
        console.error(`${plan[firstExit.index].name} stopped unexpectedly (${exitDescription(firstExit.result)}).`);
        result = 1;
      }
    }
  } catch (error) {
    operationFailure = error;
  } finally {
    try {
      await stopAll();
    } catch {
      recordCleanupFailure();
    }
    process.removeListener("SIGINT", requestShutdown);
    process.removeListener("SIGTERM", requestShutdown);
  }
  if (operationFailure) throw operationFailure;
  if (cleanupFailure) throw cleanupFailure;
  return result;
}

export function printUsage() {
  console.log(`Usage: node scripts/dev/go-dev.mjs [options]

Starts Go P2P, Go Workspace, and Vite on loopback only.

Options:
  --host <127.0.0.1>       Loopback bind address (public hosts are rejected)
  --p2p-port <port>        Go P2P port (default: ${DEFAULT_DEV_PORTS.p2p})
  --workspace-port <port>  Go Workspace port (default: ${DEFAULT_DEV_PORTS.workspace})
  --web-port <port>        Vite port (default: ${DEFAULT_DEV_PORTS.web})
  --go-bin <path>           Go executable (default: GO_BIN or go)
  --vite-cli <path>         Vite CLI entry (default: apps/web/node_modules/vite/bin/vite.js)
  -h, --help                Show this help

Workspace remains disabled unless WORKSPACE_ENABLED=true exactly. Enabled
Workspace requires an explicit loopback development database; postgres,
template0/template1, ambient service/host overrides, and URL-conflicting PG*
values are rejected. Run the migration separately with "cd apps/backend &&
go run ./cmd/migrate"; this runner never creates or migrates a database.
Worker is not started here;
run "cd apps/backend && go run ./cmd/worker" separately only with synthetic or
disposable data and deliberate provider switches.

Without DUALLANE_API_ORIGIN, Vite follows the production path ownership:
P2P /api/p2p and /ws/p2p to the P2P process, and auth, Workspace, Bot Gateway,
health, and their WebSockets to the Workspace process. An explicit
DUALLANE_API_ORIGIN keeps the explicit single-origin Go/external test harness
override for all /api, /auth, and /ws paths.`);
}

export async function runDevelopment(argv = process.argv.slice(2), baseEnvironment = process.env, paths = DEFAULT_PATHS) {
  const options = parseArguments(argv, baseEnvironment, paths);
  if (options.help) {
    printUsage();
    return 0;
  }
  const environment = loadDevelopmentEnvironment({
    baseEnvironment,
    repositoryRoot: paths.repositoryRoot
  });
  const resolvedOptions = parseArguments(argv, environment, paths);
  validateWorkspaceDatabaseTarget(environment);
  const goOrigins = createGoDevOrigins(resolvedOptions);
  console.log(`Go development services: P2P ${goOrigins.p2p}, Workspace ${goOrigins.workspace}, Vite http://${resolvedOptions.host}:${resolvedOptions.webPort}.`);
  console.log(`Workspace exact gate: ${environment.WORKSPACE_ENABLED === "true" ? "enabled" : "disabled"}.`);
  if (environment.DUALLANE_API_ORIGIN?.trim()) console.log("Vite is using the explicit DUALLANE_API_ORIGIN override.");
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "duallane-go-dev-"));
  try {
    const binaries = await buildGoBinaries(resolvedOptions, environment, temporaryDirectory, paths);
    if (!binaries) return 0;
    return await runProcessPlan(createProcessPlan(resolvedOptions, environment, paths, binaries));
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    process.exitCode = await runDevelopment();
  } catch (error) {
    console.error(`Go development runner failed: ${error instanceof Error ? error.message : "configuration error"}`);
    process.exitCode = 2;
  }
}
