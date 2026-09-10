import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function read(relativePath) {
  return (await readFile(path.join(root, relativePath), "utf8")).replace(/\r\n?/g, "\n");
}

function serviceBlock(source, serviceName, nextServiceName) {
  const startMarker = `  ${serviceName}:\n`;
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing Compose service ${serviceName}`);
  const end = source.indexOf(`\n  ${nextServiceName}:\n`, start + startMarker.length);
  assert.notEqual(end, -1, `missing Compose service boundary after ${serviceName}`);
  return source.slice(start, end);
}

function resolveDefault(source, serviceName, nextServiceName, name) {
  const block = serviceBlock(source, serviceName, nextServiceName);
  const line = block.match(new RegExp(`^\\s+${name}:\\s+(.+)$`, "m"))?.[1];
  assert.ok(line, `missing ${name} in ${serviceName}`);
  const expression = line.match(/^\$\{([A-Z0-9_]+):-([^}]+)\}$/);
  assert.ok(expression, `${serviceName}.${name} must use an explicit Compose default`);
  return {
    name: expression[1],
    defaultValue: expression[2],
    resolve(environment = {}) {
      return environment[expression[1]] || expression[2];
    }
  };
}

test("go-full resolves Echo and maintenance ownership on by default", async () => {
  const compose = await read("docker-compose.go-production.yml");
  const maintenance = resolveDefault(
    compose,
    "worker",
    "migrate",
    "WORKSPACE_MAINTENANCE_WORKER_ENABLED"
  );
  const echo = resolveDefault(
    compose,
    "worker",
    "migrate",
    "WORKSPACE_ECHO_WORKER_ENABLED"
  );

  assert.equal(maintenance.name, "WORKSPACE_MAINTENANCE_WORKER_ENABLED");
  assert.equal(maintenance.defaultValue, "true");
  assert.equal(maintenance.resolve(), "true");
  assert.equal(maintenance.resolve({ WORKSPACE_MAINTENANCE_WORKER_ENABLED: "false" }), "false");
  assert.equal(maintenance.resolve({ WORKSPACE_MAINTENANCE_WORKER_ENABLED: "true" }), "true");

  assert.equal(echo.name, "WORKSPACE_ECHO_WORKER_ENABLED");
  assert.equal(echo.defaultValue, "true");
  assert.equal(echo.resolve(), "true");
  assert.equal(echo.resolve({ WORKSPACE_ECHO_WORKER_ENABLED: "false" }), "false");
  assert.equal(echo.resolve({ WORKSPACE_ECHO_WORKER_ENABLED: "true" }), "true");
});

test("go-full keeps background ownership out of the HTTP process", async () => {
  const compose = await read("docker-compose.go-production.yml");
  const workspace = serviceBlock(compose, "workspace", "worker");
  const worker = serviceBlock(compose, "worker", "migrate");

  assert.match(workspace, /WORKSPACE_MAINTENANCE_WORKER_ENABLED:\s+"false"/);
  assert.match(workspace, /WORKSPACE_ECHO_WORKER_ENABLED:\s+"false"/);
  assert.match(worker, /entrypoint:\s+\["\/usr\/local\/bin\/duallane-worker"\]/);
  assert.match(worker, /WORKER_VALIDATE_ONLY:\s+"false"/);
});

test("Go passive guard and dedicated background owners are preserved", async () => {
  const [goConfig, goWorker] = await Promise.all([
    read("apps/backend/internal/platform/config/workspace.go"),
    read("apps/backend/cmd/worker/main.go")
  ]);

  assert.match(goConfig, /WorkspaceMaintenanceWorkerEnv\s*=\s*"WORKSPACE_MAINTENANCE_WORKER_ENABLED"/);
  assert.match(goConfig, /WorkspaceEchoWorkerEnv\s*=\s*"WORKSPACE_ECHO_WORKER_ENABLED"/);
  assert.match(goWorker, /if app\.validateOnly \{\s*processors = nil\s*\}/s);
  assert.match(goWorker, /if runtimeConfig\.MaintenanceEnabled \{/);
  assert.match(goWorker, /if runtimeConfig\.EchoWorkerEnabled \{/);
});
