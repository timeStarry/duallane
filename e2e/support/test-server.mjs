import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// The default browser gate is P2P-only. Keep this entry point as a small
// process supervisor so Playwright never starts the retired Node business
// server or a SQLite Workspace double.
const apiPort = Number(process.env.E2E_API_PORT || 8787);
const webPort = Number(process.env.E2E_WEB_PORT || 5173);
const goServer = fileURLToPath(new URL("./go-p2p-server.mjs", import.meta.url));

const child = spawn(process.execPath, [goServer], {
  env: {
    ...process.env,
    E2E_GO_P2P_API_PORT: String(apiPort),
    E2E_GO_P2P_WEB_ORIGIN: `http://127.0.0.1:${webPort}`
  },
  stdio: "ignore"
});

let stopping = false;
function stop(signal) {
  if (stopping) {
    return;
  }
  stopping = true;
  if (child.exitCode === null) {
    child.kill(signal);
  }
}

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

const result = await new Promise((resolve) => {
  child.once("exit", (code, signal) => resolve({ code, signal }));
  child.once("error", () => resolve({ code: 1, signal: null }));
});

process.removeAllListeners("SIGINT");
process.removeAllListeners("SIGTERM");
if (!stopping && result.code !== 0) {
  console.error("Go P2P browser server did not start safely");
  process.exitCode = result.code ?? 1;
}
