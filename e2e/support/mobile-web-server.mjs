import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { spawnOwnedProcess, stopOwnedProcess, waitForExit } from "./owned-process.mjs";

// An explicitly selected sibling checkout is optional; ordinary Go CI does not
// install or start a second application's dependencies.
const configuredRoot = process.env.DUALLANE_MOBILE_E2E_ROOT;
if (!configuredRoot || !path.isAbsolute(configuredRoot)) {
  throw new Error("DUALLANE_MOBILE_E2E_ROOT must name an absolute mobile checkout");
}
const root = await realpath(configuredRoot);
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
if (!String(manifest.name).includes("duallane")) throw new Error("Unexpected mobile checkout");
const vite = path.join(root, "node_modules/vite/bin/vite.js");
const child = spawnOwnedProcess(process.execPath, [vite, "--host", "127.0.0.1", "--port", "5196", "--strictPort"], {
  cwd: root, env: process.env, stdio: "inherit",
});
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  void stopOwnedProcess(child, 5_000);
});
const result = await waitForExit(child);
process.exitCode = stopping ? 0 : result.code ?? 1;
