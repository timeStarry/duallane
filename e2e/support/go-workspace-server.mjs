import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnOwnedProcess, stopOwnedProcess, waitForExit } from "./owned-process.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const backendRoot = path.join(repoRoot, "apps/backend");

export function disposableDatabaseURL(env) {
  if (env.DUALLANE_GO_E2E_ALLOW_SCHEMA_CREATION !== "true") {
    throw new Error("Go browser tests require explicit disposable schema creation opt-in");
  }
  let url;
  try { url = new URL(env.TEST_DATABASE_URL); } catch {
    throw new Error("Go browser tests require a disposable PostgreSQL URL");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)
    || !["127.0.0.1", "[::1]"].includes(url.hostname)
    || !url.pathname || ["/", "/postgres", "/template0", "/template1"].includes(url.pathname)
    || [...url.searchParams.keys()].some((key) => key !== "sslmode")
    || url.hash) {
    throw new Error("Go browser database must be explicit loopback disposable state without runtime overrides");
  }
  return url;
}

function minimalEnvironment() {
  const env = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "TEMP", "SystemRoot", "LANG", "LC_ALL"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

async function main() {
  const databaseURL = disposableDatabaseURL(process.env);
  const webOrigin = "http://127.0.0.1:5198";
  const schema = `duallane_go_browser_${randomUUID().replaceAll("-", "")}`;
  const qualifiedSchema = `"${schema}"`;
  const require = createRequire(path.join(repoRoot, "apps/web/package.json"));
  const { Client } = require("pg");
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "duallane-workspace-go-browser-"));
  let schemaCreated = false;
  let child = null;
  let stopping = false;
  let stopPromise;
  const baseEnvironment = minimalEnvironment();
  function shutdown() {
    stopping = true;
    stopPromise ??= stopOwnedProcess(child);
  }
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  async function executeSQL(statement) {
    const client = new Client({ connectionString: databaseURL.toString(),
      connectionTimeoutMillis: 5_000, statement_timeout: 10_000, query_timeout: 12_000 });
    // Provider error events must not dump a credential-bearing connection object.
    client.on("error", () => {});
    try {
      await client.connect();
      await client.query(statement);
    } finally { await client.end(); }
  }

  async function run(command, args, env, timeoutMs) {
    if (stopping) return;
    child = spawnOwnedProcess(command, args, { cwd: backendRoot, env, stdio: "ignore" });
    const owned = child;
    let timedOut = false;
    const timer = timeoutMs ? setTimeout(() => {
      timedOut = true;
      void stopOwnedProcess(owned);
    }, timeoutMs) : null;
    try {
      const result = await waitForExit(owned);
      if (!stopping && (timedOut || result.code !== 0)) throw new Error("Go browser child failed");
    } finally {
      clearTimeout(timer);
      await stopOwnedProcess(owned);
      if (child === owned) child = null;
    }
  }

  try {
    const buildEnvironment = { ...baseEnvironment, CGO_ENABLED: "1", GOWORK: "off", GOMAXPROCS: "2",
      GOPROXY: process.env.GOPROXY || "https://proxy.golang.org,direct" };
    const binaries = {};
    for (const command of ["migrate", "workspace"]) {
      binaries[command] = path.join(temporaryDirectory, `${command}${process.platform === "win32" ? ".exe" : ""}`);
      await run(process.env.GO_BIN || "go", ["build", "-trimpath", "-buildvcs=false", "-o", binaries[command], `./cmd/${command}`], buildEnvironment, 120_000);
    }
    if (stopping) return;
    await executeSQL(`CREATE SCHEMA ${qualifiedSchema}`);
    schemaCreated = true;
    const scopedDatabaseURL = new URL(databaseURL);
    scopedDatabaseURL.searchParams.set("search_path", schema);
    const runtimeEnvironment = {
      ...baseEnvironment,
      DATABASE_URL: scopedDatabaseURL.toString(),
      DATABASE_POOL_MAX: "5",
      DUALLANE_MIGRATIONS_DIR: path.join(repoRoot, "apps/web/server/migrations"),
      DUALLANE_EMOTE_CATALOG_PATH: path.join(repoRoot, "apps/web/shared/emote-packs.json"),
      DUALLANE_DATA_DIR: path.join(temporaryDirectory, "data"),
      DUALLANE_APP_VERSION: "workspace-go-browser-test", DUALLANE_GIT_COMMIT: "working-tree",
      HOST: "127.0.0.1", PORT: "8898", NODE_ENV: "test", WORKSPACE_ENABLED: "true",
      PUBLIC_BASE_URL: webOrigin, WORKSPACE_FRONTEND_URL: webOrigin,
      WORKSPACE_STORAGE_DRIVER: "local", WORKSPACE_EMAIL_WORKER_ENABLED: "false",
      WORKSPACE_NTFY_WORKER_ENABLED: "false", WORKSPACE_MAINTENANCE_WORKER_ENABLED: "false"
    };
    await run(binaries.migrate, [], runtimeEnvironment, 60_000);
    if (!stopping) await run(binaries.workspace, [], runtimeEnvironment);
  } finally {
    await stopPromise;
    await stopOwnedProcess(child);
    try {
      // The identifier is generated locally, never selected from user data.
      if (schemaCreated) await executeSQL(`DROP SCHEMA ${qualifiedSchema} CASCADE`);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
      process.removeListener("SIGINT", shutdown);
      process.removeListener("SIGTERM", shutdown);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch {
    console.error("Go Workspace browser server or synthetic cleanup failed; no raw provider details emitted");
    process.exitCode = 1;
  }
}
