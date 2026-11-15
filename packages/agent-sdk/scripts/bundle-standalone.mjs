import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sdkRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(sdkRoot, "..", "..");

const sourceFiles = [
  "src/ws-lite.js",
  "src/index.js",
  "src/v2.js",
  "src/profile-store.js",
  "src/mcp.js",
  "bin/duallane-agent.mjs",
];

function stripImportsAndReexports(code, relPath) {
  let out = code.replace(/^#!\/usr\/bin\/env node\s*\n/u, "");
  // Strip multi-line and single-line ES imports (node:* builtins are emitted once in header)
  out = out.replace(/^import\s+[\s\S]*?from\s+["'][^"']+["'];?\s*$/gmu, "");
  if (relPath === "bin/duallane-agent.mjs") {
    // Symbols from src/*.js are already exported at declaration
    out = out.replace(/^export\s*\{[\s\S]*?\};\s*$/gmu, "");
  }
  return out.trim();
}

const header = `#!/usr/bin/env node
/**
 * DualLane Universal Agent Runtime (Standalone Single-File CLI + Stdio MCP + JS SDK)
 * Zero external npm dependencies · Requires Node.js >= 20
 *
 * Install anywhere directly from your DualLane host:
 *   mkdir -p ~/.duallane/bin
 *   curl -fsSL https://<duallane-host>/integrations/duallane-agent.mjs -o ~/.duallane/bin/duallane-agent.mjs
 *   chmod +x ~/.duallane/bin/duallane-agent.mjs
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
`;

const sections = sourceFiles.map((relPath) => {
  const fullPath = path.join(sdkRoot, relPath);
  const raw = fs.readFileSync(fullPath, "utf8");
  return `// --- ${relPath} ---\n${stripImportsAndReexports(raw, relPath)}`;
});

const bundle = `${header}\n${sections.join("\n\n")}\n`;

const targets = [
  path.join(repoRoot, "apps/web/public/integrations/duallane-agent.mjs"),
  path.join(repoRoot, "apps/web/public/integrations/v2/duallane-agent.mjs"),
];

for (const target of targets) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bundle, { mode: 0o755 });
  fs.chmodSync(target, 0o755);
}

process.stdout.write(`[bundle-standalone] Wrote ${Buffer.byteLength(bundle, "utf8")} bytes to ${targets.length} public integration paths.\n`);
