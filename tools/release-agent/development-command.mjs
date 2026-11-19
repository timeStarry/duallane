import { spawn, spawnSync } from "node:child_process";
import { isAbsolute, join } from "node:path";

const BASE_ENVIRONMENT = new Set([
  "PATH", "SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "COMSPEC", "PATHEXT", "LANG", "LC_ALL",
  "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER",
]);
const MODEL_ENVIRONMENT = new Set(["CODEX_HOME", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]);
const MAX_JSON_BYTES = 64 * 1024;

export function developmentError(code) {
  return Object.assign(new Error(code), { code });
}

export function isolatedEnvironment(directory, source = process.env) {
  const base = Object.fromEntries(Object.entries(source).filter(([name]) => BASE_ENVIRONMENT.has(name.toUpperCase())));
  return {
    ...base,
    HOME: directory,
    USERPROFILE: directory,
    APPDATA: directory,
    LOCALAPPDATA: directory,
    XDG_CONFIG_HOME: directory,
    TMP: directory,
    TEMP: directory,
    TMPDIR: directory,
    CI: "true",
  };
}

function terminate(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const binary = join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
    spawnSync(binary, ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true, stdio: "ignore", timeout: 4000,
    });
    child.kill();
    return;
  }
  try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
}

export async function runDevelopmentProcess(file, args, options) {
  const { cwd, env, signal, input, timeoutMs = 120_000, maxOutput = 512 * 1024, label } = options;
  if (signal?.aborted) throw developmentError(`development.${label}_cancelled`);
  return await new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd, env, shell: false, windowsHide: true, detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const output = [];
    let stdoutLength = 0;
    let stderrLength = 0;
    let finished = false;
    const abort = () => stop("cancelled");
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    function finish(error, value) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(value);
    }
    function stop(reason) {
      if (finished) return;
      terminate(child);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      finish(developmentError(`development.${label}_${reason}`));
    }
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", (chunk) => {
      stdoutLength += chunk.length;
      if (stdoutLength > maxOutput) stop("output_limit");
      else output.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrLength += chunk.length;
      if (stderrLength > maxOutput) stop("output_limit");
    });
    child.stdin.on("error", () => {});
    child.on("error", () => finish(developmentError(`development.${label}_could_not_start`)));
    child.on("close", (code) => {
      if (code !== 0) finish(developmentError(`development.${label}_failed`));
      else finish(null, Buffer.concat(output).toString("utf8"));
    });
    child.stdin.end(input);
  });
}

export function validateDevelopmentCommand(command, label) {
  if (!command || typeof command.file !== "string" || !isAbsolute(command.file) ||
      (command.args !== undefined && (!Array.isArray(command.args) ||
        command.args.length > 32 || !command.args.every((arg) => typeof arg === "string" && arg.length <= 2048 && !arg.includes("\0")))) ||
      (command.timeoutMs !== undefined && (!Number.isSafeInteger(command.timeoutMs) || command.timeoutMs < 100 || command.timeoutMs > 3_600_000))) {
    throw developmentError(`development.invalid_${label}_command`);
  }
  const environment = Object.entries(command.environment ?? {});
  if (environment.some(([name, source]) => !MODEL_ENVIRONMENT.has(name) || source !== `DUALLANE_DEV_MODEL_${name}`)) {
    throw developmentError(`development.invalid_${label}_environment`);
  }
  return { file: command.file, args: command.args || [], timeoutMs: command.timeoutMs || 300_000, environment };
}

export async function runDevelopmentStage(command, { label, cwd, home, env, payload, signal }) {
  const childEnv = isolatedEnvironment(home, env);
  for (const [name, source] of command.environment) {
    if (!env[source]) throw developmentError(`development.${label}_credential_missing`);
    childEnv[name] = env[source];
  }
  const output = await runDevelopmentProcess(command.file, command.args, {
    cwd, env: childEnv, signal, input: JSON.stringify(payload), timeoutMs: command.timeoutMs,
    maxOutput: MAX_JSON_BYTES, label,
  });
  try {
    const parsed = JSON.parse(output);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch { /* Keep model output out of errors and logs. */ }
  throw developmentError(`development.${label}_invalid_result`);
}
