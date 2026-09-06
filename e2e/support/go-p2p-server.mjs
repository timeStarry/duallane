import { mkdtemp, rm } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signalOwnedProcess, spawnOwnedProcess, stopOwnedProcess, waitForExit } from "./owned-process.mjs";

const host = "127.0.0.1";
const apiPort = parsePort(process.env.E2E_GO_P2P_API_PORT, 8897);
const webOrigin = process.env.E2E_GO_P2P_WEB_ORIGIN || "http://127.0.0.1:5197";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const backendRoot = path.join(repoRoot, "apps", "backend");
const goCommand = process.env.GO_BIN || "go";
const buildTimeoutMs = 120_000;

let activeProcess = null;
let shutdownRequested = false;

const minimalEnvironment = () => {
  const environment = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "TEMP", "SystemRoot", "LANG", "LC_ALL"]) {
    if (process.env[key]) {
      environment[key] = process.env[key];
    }
  }
  return environment;
};

function parsePort(rawValue, fallback) {
  const value = Number(rawValue || fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error("invalid fixed P2P browser test port");
  }
  return value;
}

function spawnManaged(command, args, options) {
  const child = spawnOwnedProcess(command, args, options);
  activeProcess = child;
  return child;
}

async function runBounded(command, args, options, timeoutMs) {
  const child = spawnManaged(command, args, options);
  const exit = waitForExit(child);
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    void stopOwnedProcess(child);
  }, timeoutMs);
  const result = await exit;
  clearTimeout(timeout);
  await stopOwnedProcess(child);
  if (activeProcess === child) activeProcess = null;
  if (timedOut || result.code !== 0) {
    throw new Error("bounded Go P2P browser process failed");
  }
  return result;
}

function requestShutdown() {
  shutdownRequested = true;
  if (activeProcess && activeProcess.exitCode === null) {
    void stopOwnedProcess(activeProcess);
  }
}

process.once("SIGINT", requestShutdown);
process.once("SIGTERM", requestShutdown);

const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "duallane-p2p-go-browser-"));
const binaryPath = path.join(temporaryDirectory, process.platform === "win32" ? "p2p.exe" : "p2p");
function cleanupTemporaryDirectory() {
  if (activeProcess) {
    signalOwnedProcess(activeProcess, "SIGKILL");
  }
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

process.once("exit", cleanupTemporaryDirectory);

try {
  await runBounded(
    goCommand,
    ["build", "-trimpath", "-buildvcs=false", "-o", binaryPath, "./cmd/p2p"],
    {
      cwd: backendRoot,
      env: {
        ...minimalEnvironment(),
        CGO_ENABLED: "0",
        GOWORK: "off",
        GOPROXY: process.env.GOPROXY || "https://proxy.golang.org,direct"
      },
      stdio: "ignore"
    },
    buildTimeoutMs
  );

  if (!shutdownRequested) {
    const server = spawnManaged(binaryPath, [], {
      cwd: backendRoot,
      env: {
        ...minimalEnvironment(),
        HOST: host,
        PORT: String(apiPort),
        PUBLIC_BASE_URL: webOrigin,
        DUALLANE_APP_VERSION: "p2p-go-browser-test",
        DUALLANE_GIT_COMMIT: "working-tree",
        DUALLANE_STUN_URLS: "stun:synthetic-one.example,stun:synthetic-two.example",
        DUALLANE_TURN_URLS: "turn:synthetic-one.example",
        DUALLANE_TURN_USERNAME: "synthetic-turn-user",
        DUALLANE_TURN_CREDENTIAL: "synthetic-turn-credential",
        DUALLANE_EMPTY_ROOM_GRACE_MS: "0"
      },
      stdio: "ignore"
    });
    const result = await waitForExit(server);
    if (!shutdownRequested && result.code !== 0) {
      throw new Error("Go P2P browser server exited unexpectedly");
    }
  }
} catch {
  if (!shutdownRequested) {
    console.error("Go P2P browser server did not start safely");
    process.exitCode = 1;
  }
} finally {
  await stopOwnedProcess(activeProcess);
  await rm(temporaryDirectory, { recursive: true, force: true });
  process.removeListener("exit", cleanupTemporaryDirectory);
  process.removeListener("SIGINT", requestShutdown);
  process.removeListener("SIGTERM", requestShutdown);
}
