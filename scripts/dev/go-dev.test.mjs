import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import {
  buildServiceEnvironments,
  createProcessPlan,
  loadDevelopmentEnvironment,
  parseArguments,
  stopManagedProcesses,
  validateWorkspaceDatabaseTarget
} from "./go-dev.mjs";
import { DEFAULT_DEV_PORTS, createDevProxy, toWebSocketOrigin } from "./go-dev-config.mjs";
import { spawnOwnedProcess, stopOwnedProcess } from "../../e2e/support/owned-process.mjs";

const syntheticOptions = parseArguments([], {});

test("default Go development plan uses separate loopback owners", () => {
  const plan = createProcessPlan(syntheticOptions, {
    WORKSPACE_ENABLED: "false",
    DATABASE_URL: "postgresql://synthetic:secret@127.0.0.1:5432/synthetic",
    SESSION_SECRET: "synthetic-session-secret"
  }, undefined, { p2p: "synthetic-p2p", workspace: "synthetic-workspace" });
  assert.deepEqual(plan.map((processSpec) => processSpec.name), ["Go P2P", "Go Workspace", "Vite"]);
  assert.equal(plan[0].command, "synthetic-p2p");
  assert.deepEqual(plan[0].args, []);
  assert.equal(plan[1].command, "synthetic-workspace");
  assert.deepEqual(plan[1].args, []);
  assert.equal(plan[0].env.HOST, "127.0.0.1");
  assert.equal(plan[0].env.PORT, String(DEFAULT_DEV_PORTS.p2p));
  assert.equal(plan[1].env.HOST, "127.0.0.1");
  assert.equal(plan[1].env.PORT, String(DEFAULT_DEV_PORTS.workspace));
  assert.equal(plan[2].args.at(-2), String(DEFAULT_DEV_PORTS.web));
  assert.equal(plan[0].env.SESSION_SECRET, undefined);
  assert.equal(plan[0].env.DATABASE_URL, undefined);
  assert.equal(plan[2].env.SESSION_SECRET, undefined);
  assert.equal(plan[2].env.DATABASE_URL, undefined);
  assert.equal(plan[1].env.SESSION_SECRET, "synthetic-session-secret");
  assert.equal(plan[1].env.DATABASE_URL, "postgresql://synthetic:secret@127.0.0.1:5432/synthetic");
});

test("Workspace is enabled only for the exact true value", () => {
  for (const value of [undefined, "false", "TRUE", " true ", "1"]) {
    const environment = value === undefined ? {} : { WORKSPACE_ENABLED: value };
    const services = buildServiceEnvironments(environment, syntheticOptions);
    assert.notEqual(services.workspace.WORKSPACE_ENABLED, "true");
  }
  const enabled = buildServiceEnvironments({
    WORKSPACE_ENABLED: "true",
    DATABASE_URL: "postgres://dev-user:synthetic-password@127.0.0.1:5432/duallane_dev"
  }, syntheticOptions);
  assert.equal(enabled.workspace.WORKSPACE_ENABLED, "true");
});

test("enabled Workspace accepts only explicit loopback development database targets", () => {
  assert.doesNotThrow(() => validateWorkspaceDatabaseTarget({
    WORKSPACE_ENABLED: "false",
    DATABASE_URL: "postgres://prod-user:synthetic-password@db.example.invalid:5432/postgres"
  }));
  for (const environment of [
    {
      WORKSPACE_ENABLED: "true",
      DATABASE_URL: "postgresql://dev-user:synthetic-password@127.0.0.1:5432/duallane_dev?sslmode=disable"
    },
    {
      WORKSPACE_ENABLED: "true",
      PGHOST: "127.0.0.1",
      PGPORT: "55432",
      PGDATABASE: "duallane_dev",
      PGUSER: "dev-user",
      PGPASSWORD: "synthetic-password"
    },
    { WORKSPACE_ENABLED: "true", PGHOST: "::1", PGDATABASE: "duallane_dev" }
  ]) {
    assert.doesNotThrow(() => validateWorkspaceDatabaseTarget(environment));
  }

  const rejected = [
    {
      WORKSPACE_ENABLED: "true",
      DATABASE_URL: "postgres://prod-user:synthetic-password@db.example.invalid:5432/duallane_dev"
    },
    {
      WORKSPACE_ENABLED: "true",
      DATABASE_URL: "postgres://dev-user:synthetic-password@127.0.0.1:5432/postgres"
    },
    {
      WORKSPACE_ENABLED: "true",
      DATABASE_URL: "postgres://dev-user:synthetic-password@127.0.0.1:5432/duallane_dev?search_path=public"
    },
    {
      WORKSPACE_ENABLED: "true",
      DATABASE_URL: "postgres://dev-user:synthetic-password@127.0.0.1:5432/duallane_dev",
      PGDATABASE: "postgres"
    },
    {
      WORKSPACE_ENABLED: "true",
      DATABASE_URL: "postgres://dev-user:synthetic-password@127.0.0.1:5432/duallane_dev",
      PGHOST: "127.0.0.1"
    },
    {
      WORKSPACE_ENABLED: "true",
      DATABASE_URL: "postgres://dev-user:synthetic-password@127.0.0.1:5432/duallane_dev",
      PGHOSTADDR: "127.0.0.1"
    },
    {
      WORKSPACE_ENABLED: "true",
      DATABASE_URL: "postgres://dev-user:synthetic-password@127.0.0.1:5432/duallane_dev",
      PGSERVICE: "production"
    },
    {
      WORKSPACE_ENABLED: "true",
      DATABASE_URL: "postgres://dev-user:synthetic-password@127.0.0.1:5432/duallane_dev",
      PGSERVICEFILE: "C:\\synthetic\\production.pg_service.conf"
    },
    { WORKSPACE_ENABLED: "true", PGHOST: "db.example.invalid", PGDATABASE: "duallane_dev" },
    { WORKSPACE_ENABLED: "true", PGHOST: "127.0.0.1" },
    { WORKSPACE_ENABLED: "true", PGHOST: "127.0.0.1", PGDATABASE: "template1" },
    { WORKSPACE_ENABLED: "true", PGHOST: "127.0.0.1", PGDATABASE: "duallane_dev", PGHOSTADDR: "127.0.0.1" },
    { WORKSPACE_ENABLED: "true", PGHOST: "127.0.0.1", PGDATABASE: "duallane_dev", PGSERVICE: "development" },
    { WORKSPACE_ENABLED: "true", PGHOST: "127.0.0.1", PGDATABASE: "duallane_dev", PGSERVICEFILE: "C:\\synthetic\\dev.pg_service.conf" },
    {
      WORKSPACE_ENABLED: "true",
      PGHOST: "127.0.0.1",
      PGDATABASE: "duallane_dev",
      PGPASSFILE: "C:\\synthetic\\dev.pgpass"
    },
    {
      WORKSPACE_ENABLED: "true",
      PGHOST: "127.0.0.1",
      PGDATABASE: "duallane_dev",
      PGOPTIONS: "-c search_path=public"
    }
  ];
  for (const environment of rejected) {
    let error;
    try {
      validateWorkspaceDatabaseTarget(environment);
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof Error);
    assert.match(error.message, /loopback PostgreSQL development database/);
    assert.doesNotMatch(error.message, /synthetic-password|db\.example\.invalid|search_path/);
  }
});

test("development configuration rejects public, colliding, and legacy Node ports", () => {
  assert.throws(() => parseArguments(["--host", "0.0.0.0"], {}), /public hosts are rejected/);
  assert.throws(() => parseArguments(["--p2p-port", String(DEFAULT_DEV_PORTS.workspace)], {}), /must be distinct/);
  assert.throws(() => parseArguments(["--workspace-port", "8787"], {}), /retired Node API port/);
  assert.throws(() => parseArguments(["--web-port", "not-a-port"], {}), /between 1 and 65535/);
});

test("Vite proxy follows candidate gateway ownership", () => {
  const proxy = createDevProxy({
    DUALLANE_P2P_API_ORIGIN: "http://127.0.0.1:8897",
    DUALLANE_WORKSPACE_API_ORIGIN: "http://127.0.0.1:8898"
  });
  assert.equal(proxy["/api"], undefined);
  assert.equal(proxy["/auth"], undefined);
  assert.equal(proxy["^/api/p2p(?:/|\\?|$)"], "http://127.0.0.1:8897");
  assert.equal(proxy["^/api/auth(?:/|\\?|$)"], "http://127.0.0.1:8898");
  assert.equal(proxy["^/api/workspace(?:/|\\?|$)"], "http://127.0.0.1:8898");
  assert.equal(proxy["^/api/bot-gateway(?:/|\\?|$)"], "http://127.0.0.1:8898");
  assert.equal(proxy["^/api/health(?:\\?.*)?$"], "http://127.0.0.1:8898");
  assert.deepEqual(proxy["^/ws/p2p(?:/|\\?|$)"], { target: "ws://127.0.0.1:8897", ws: true });
  assert.deepEqual(proxy["^/ws/workspace(?:\\?.*)?$"], { target: "ws://127.0.0.1:8898", ws: true });
  assert.deepEqual(proxy["^/ws/bot-gateway(?:\\?.*)?$"], { target: "ws://127.0.0.1:8898", ws: true });
  assert.equal(toWebSocketOrigin("https://127.0.0.1:8898"), "wss://127.0.0.1:8898");
});

test("explicit DUALLANE_API_ORIGIN keeps the single-origin harness override", () => {
  const proxy = createDevProxy({ DUALLANE_API_ORIGIN: "http://127.0.0.1:8787" });
  assert.equal(proxy["/api"], "http://127.0.0.1:8787");
  assert.equal(proxy["/auth"], "http://127.0.0.1:8787");
  assert.deepEqual(proxy["/ws"], { target: "ws://127.0.0.1:8787", ws: true });
});

test("dotenv is optional, shell values win, and secrets are not copied to Vite/P2P", () => {
  const baseEnvironment = {
    WORKSPACE_ENABLED: "false",
    SESSION_SECRET: "shell-secret",
    DUALLANE_DEV_P2P_PORT: "8997"
  };
  const loaded = loadDevelopmentEnvironment({
    baseEnvironment,
    repositoryRoot: "D:/path/that/does/not/exist"
  });
  assert.equal(loaded.WORKSPACE_ENABLED, "false");
  const options = parseArguments([], loaded);
  const services = buildServiceEnvironments(loaded, options);
  assert.equal(services.workspace.SESSION_SECRET, "shell-secret");
  assert.equal(services.p2p.SESSION_SECRET, undefined);
  assert.equal(services.vite.SESSION_SECRET, undefined);
});

test("owned cleanup stops only the child handles it receives", { timeout: 5_000 }, async () => {
  const owned = spawnOwnedProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  const unrelated = spawnOwnedProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  try {
    await Promise.all([once(owned, "spawn"), once(unrelated, "spawn")]);
    await stopManagedProcesses([owned], 50);
    assert.ok(owned.exitCode !== null || owned.signalCode !== null);
    assert.equal(unrelated.exitCode, null);
  } finally {
    await stopOwnedProcess(unrelated, 50);
  }
});
