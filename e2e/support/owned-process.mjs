import { spawn } from "node:child_process";

const ownedChildren = new WeakSet();

export function spawnOwnedProcess(command, args, options = {}) {
  const child = spawn(command, args, { ...options, detached: process.platform !== "win32", windowsHide: true });
  ownedChildren.add(child);
  return child;
}

export function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    const onError = () => finish({ code: 1, signal: null });
    const onExit = (code, signal) => finish({ code, signal });
    function finish(result) {
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      resolve(result);
    }
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

export function signalOwnedProcess(child, signal) {
  if (!ownedChildren.has(child)) throw new Error("process is not owned by this helper");
  if (!child.pid) return;
  try {
    // POSIX descendants may outlive the group leader. Signal only the group
    // created above, never discover or terminate another Go/browser process.
    if (process.platform === "win32") {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    } else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw new Error("owned process could not be stopped");
  }
}

export async function stopOwnedProcess(child, graceMs = 5_000) {
  if (!child) return;
  if (!ownedChildren.has(child)) throw new Error("process is not owned by this helper");
  if (child.exitCode !== null || child.signalCode !== null) {
    signalOwnedProcess(child, "SIGKILL");
    return;
  }
  const exited = waitForExit(child);
  signalOwnedProcess(child, "SIGTERM");
  const forceStop = setTimeout(() => signalOwnedProcess(child, "SIGKILL"), graceMs);
  try {
    await exited;
  } finally {
    clearTimeout(forceStop);
    signalOwnedProcess(child, "SIGKILL");
  }
}
