// Characterize declared public routes against the actual, disabled Node app.
// This is a registration/feature-gate inventory, not a business-parity claim.
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const outputPath = path.join(root, "apps/backend/api/node-routes.json");

export function extractRoutes(source, sourcePath) {
  const routes = [];
  // The owning sources use literal app.<method>(path, ...) registrations.
  // Refuse an unfamiliar registration rather than silently omit it. Plugins
  // such as static-file serving are deliberately outside this public API list.
  for (const match of source.matchAll(/\bapp\.(get|post|put|patch|delete|head|options|all|route)\s*\(/g)) {
    assert(!["all", "route"].includes(match[1]), `unsupported route declaration in ${sourcePath}`);
    const remainder = source.slice(match.index + match[0].length);
    const literal = remainder.match(/^\s*(["'])(\/[^"'\\\r\n]*)\1\s*,/);
    assert(literal, `non-literal route declaration in ${sourcePath}`);
    const nodePath = literal[2];
    routes.push({
      method: match[1].toUpperCase(),
      path: nodePath.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, "{$1}"),
      nodePath,
      transport: nodePath.startsWith("/ws/") ? "websocket" : "http",
      lane: nodePath.includes("/p2p/") || nodePath === "/api/p2p/ice-servers" ? "p2p"
        : nodePath.startsWith("/api/workspace/") || nodePath.startsWith("/api/auth/")
          || nodePath.startsWith("/api/bot-gateway/") || nodePath.startsWith("/ws/") ? "workspace" : "edge",
      source: sourcePath
    });
  }
  return routes;
}

export async function collectInventory() {
  const sourcePaths = ["apps/web/server/index.mjs"];
  const routeDir = "apps/web/server/routes";
  for (const name of (await readdir(path.join(root, routeDir))).sort()) {
    if (name.endsWith(".mjs")) sourcePaths.push(`${routeDir}/${name}`);
  }
  const routes = (await Promise.all(sourcePaths.map(async (sourcePath) => (
    extractRoutes(await readFile(path.join(root, sourcePath), "utf8"), sourcePath)
  )))).flat().sort((a, b) => {
    const left = `${a.path} ${a.method}`;
    const right = `${b.path} ${b.method}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const keys = routes.map(({ method, path: routePath }) => `${method} ${routePath}`);
  assert.equal(new Set(keys).size, keys.length, "duplicate public route declaration");
  const { createApp } = await import("../../apps/web/server/index.mjs");
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "duallane-route-inventory-"));
  let app;
  try {
    app = await createApp({ dataDir, logger: false, env: {
      WORKSPACE_ENABLED: "false", NODE_ENV: "test", SERVE_STATIC: "false"
    } });
    await app.ready();
    for (const route of routes) {
      assert(app.hasRoute({ method: route.method, url: route.nodePath }),
        `declared route is not registered: ${route.method} ${route.path}`);
      // Authentication and WS handshake behavior need their separate gates.
      // This inventory records ordinary Workspace/Bot feature-gate responses.
      if (route.transport !== "http" || !(route.nodePath.startsWith("/api/workspace/")
        || route.nodePath.startsWith("/api/bot-gateway/"))) continue;
      const response = await app.inject({
        method: route.method,
        url: route.nodePath.replace(/:[A-Za-z][A-Za-z0-9_]*/g, "contract-id"),
        ...(["GET", "HEAD"].includes(route.method) ? {} : {
          headers: { "content-type": "application/json" }, payload: {}
        })
      });
      assert(response.statusCode >= 400, `disabled route succeeded: ${route.path}`);
      route.disabled = { status: response.statusCode, body: response.json() };
    }
  } finally {
    await app?.close();
    // The sole recursive cleanup target is this call's unique synthetic dir.
    await rm(dataDir, { recursive: true, force: true });
  }
  return { schemaVersion: 1, scope: "declared routes and disabled HTTP responses", routes };
}

async function main() {
  const args = process.argv.slice(2);
  assert(args.length === 1 && ["--check", "--write"].includes(args[0]),
    "usage: node scripts/backend/route-inventory.mjs --check|--write");
  const inventory = await collectInventory();
  const serialized = `${JSON.stringify(inventory, null, 2)}\n`;
  if (args[0] === "--write") await writeFile(outputPath, serialized);
  else assert.equal(await readFile(outputPath, "utf8"), serialized, "Node route inventory is stale; inspect and regenerate");
  const disabledCount = inventory.routes.filter((route) => route.disabled).length;
  process.stdout.write(`Node route inventory: ${inventory.routes.length} registered declarations, ${disabledCount} disabled HTTP observations\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
