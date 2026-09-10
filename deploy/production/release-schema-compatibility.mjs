#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const IMAGE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const CONTAINER_ID_PATTERN = /^[0-9a-f]{64}$/u;
const RUN_ID_PATTERN = /^[0-9a-f]{64}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MIGRATION_NAME_PATTERN = /^[0-9]{3}_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/u;
const ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const SAFE_ENVIRONMENT_KEY_PATTERN = /^(?:PATH|HOME|HOSTNAME|TERM|LANG|LC_[A-Za-z0-9_]+|TZ)$/u;
const CREDENTIAL_KEY_PATTERN = /(?:PASSWORD|SECRET|TOKEN|CREDENTIAL|DATABASE|^PG|^AWS|^S3|^MINIO|GITHUB|SMTP|OAUTH|PRIVATE_KEY|ACCESS_KEY)/iu;
const CREDENTIAL_VALUE_PATTERN = /(?:postgres(?:ql)?:\/\/|bearer\s+|-----BEGIN|AKIA[0-9A-Z]{16})/iu;
const FIXED_IMAGE_ENVIRONMENT = Object.freeze({
  DUALLANE_MIGRATIONS_DIR: "/app/migrations",
  DUALLANE_EMOTE_CATALOG_PATH: "/app/assets/emote-packs.json",
  DUALLANE_ECHO_RELEASE_CATALOG_PATH: "/app/assets/echo-release-guides.json",
});

export const SCHEMA_COMPATIBILITY_LABEL = "com.duallane.schema-compatibility";
export const SCHEMA_COMPATIBILITY_USER = "65532:65532";
export const SCHEMA_COMPATIBILITY_POLICY_PATH = "/app/schema-compatibility.json";
export const SCHEMA_COMPATIBILITY_MIGRATIONS_PATH = "/app/migrations";
export const SCHEMA_COMPATIBILITY_POLICY_VERSION = 1;
export const MAX_DOCKER_OUTPUT_BYTES = 128 * 1024;
export const MAX_POLICY_BYTES = 16 * 1024;
export const DOCKER_COMMAND_TIMEOUT_MS = 10_000;
export const CONTAINER_TIMEOUT_MS = 10_000;
export const CONTAINER_MEMORY_BYTES = 64 * 1024 * 1024;
export const CONTAINER_PIDS_LIMIT = 32;
export const REVIEWED_BASE_MIGRATION = "033_workspace_command_result_finalization.sql";
export const REVIEWED_COMPATIBLE_MIGRATION = "034_workspace_chat_auto_hide.sql";
export const REVIEWED_COMPATIBLE_MIGRATION_SHA256 = "b5c6ed855f9ca76a06f14ac590a8dd96fdec9cd2ec88c75dc5814990669658cb";

const INSPECTION_REPORT_HEADER = "DLSCHEMA\t1";
const INSPECTION_REPORT_END = "P_END";
const MAX_MIGRATIONS = 999;

// This script is deliberately the complete command passed to /bin/sh. It has
// no application hooks, database access, provider access, or write path. The
// host treats every byte after the fixed report framing as untrusted.
export const SCHEMA_INSPECTION_SCRIPT = [
  "set -eu",
  `printf 'DLSCHEMA\\t1\\n'`,
  `migration_dir=${SCHEMA_COMPATIBILITY_MIGRATIONS_PATH}`,
  'test -d "$migration_dir"',
  'test ! -L "$migration_dir"',
  "count=0",
  'for entry in "$migration_dir"/* "$migration_dir"/.[!.]* "$migration_dir"/..?*; do',
  '  if [ ! -e "$entry" ] && [ ! -L "$entry" ]; then continue; fi',
  '  if [ -L "$entry" ] || [ ! -f "$entry" ]; then exit 20; fi',
  '  name=${entry##*/}',
  '  case "$name" in',
  '    [0-9][0-9][0-9]_*.sql) ;;',
  '    *) exit 21 ;;',
  "  esac",
  '  digest=$(sha256sum -- "$entry")',
  '  digest=${digest%% *}',
  '  printf \'M\\t%s\\t%s\\n\' "$name" "$digest"',
  "  count=$((count + 1))",
  "done",
  'printf \'C\\t%s\\n\' "$count"',
  `policy=${SCHEMA_COMPATIBILITY_POLICY_PATH}`,
  'if [ -e "$policy" ] || [ -L "$policy" ]; then',
  '  if [ -L "$policy" ] || [ ! -f "$policy" ]; then exit 22; fi',
  '  bytes=$(wc -c < "$policy")',
  '  bytes=${bytes##* }',
  '  case "$bytes" in \'\'|*[!0-9]*) exit 23 ;; esac',
  `  test "$bytes" -le ${MAX_POLICY_BYTES}`,
  '  printf \'P\\t%s\\n\' "$bytes"',
  '  cat -- "$policy"',
  "  printf '\\nP_END\\n'",
  "else",
  "  printf 'N\\n'",
  "fi",
].join("\n");

const DOCKER_OPERATIONAL_ENVIRONMENT_KEYS = Object.freeze([
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
]);

class SchemaCompatibilityError extends Error {
  constructor(code) {
    super(code);
    this.name = "SchemaCompatibilityError";
    this.code = code;
  }
}

export { SchemaCompatibilityError };

function reject(code) {
  throw new SchemaCompatibilityError(code);
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireRecord(value, code) {
  if (!isRecord(value)) reject(code);
  return value;
}

function requireExactKeys(value, expected, code) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    reject(code);
  }
}

function assertImageID(value, code = "invalid_image_id") {
  if (typeof value !== "string" || !IMAGE_ID_PATTERN.test(value)) {
    reject(code);
  }
  return value;
}

function assertRunID(value) {
  if (typeof value !== "string" || !RUN_ID_PATTERN.test(value)) {
    reject("invalid_run_id");
  }
  return value;
}

function migrationNumber(name, code = "migration_name_invalid") {
  if (typeof name !== "string" || !MIGRATION_NAME_PATTERN.test(name)) {
    reject(code);
  }
  const number = Number(name.slice(0, 3));
  if (!Number.isSafeInteger(number) || number < 1 || number > MAX_MIGRATIONS) {
    reject("migration_number_invalid");
  }
  return number;
}

function assertSHA256(value, code = "migration_hash_invalid") {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    reject(code);
  }
  return value;
}

function decodeDockerOutput(value, code = "docker_output_invalid") {
  let output;
  if (Buffer.isBuffer(value)) {
    output = value;
  } else if (value instanceof Uint8Array) {
    output = Buffer.from(value);
  } else if (typeof value === "string") {
    output = Buffer.from(value, "utf8");
  } else {
    reject(code);
  }
  if (output.byteLength > MAX_DOCKER_OUTPUT_BYTES) {
    reject("docker_output_too_large");
  }
  return output;
}

function decodeUTF8(value, code) {
  const output = decodeDockerOutput(value, code);
  const text = output.toString("utf8");
  if (Buffer.byteLength(text, "utf8") !== output.byteLength) reject(code);
  return text;
}

function parseJSONOutput(value, code) {
  let parsed;
  try {
    parsed = JSON.parse(decodeUTF8(value, code));
  } catch (error) {
    if (error instanceof SchemaCompatibilityError) throw error;
    reject(code);
  }
  return parsed;
}

function parseStrictJSON(text) {
  let offset = 0;

  function fail() {
    reject("policy_invalid");
  }

  function skipWhitespace() {
    while (offset < text.length && /[\u0009\u000a\u000d\u0020]/u.test(text[offset])) {
      offset += 1;
    }
  }

  function parseString() {
    if (text[offset] !== '"') fail();
    offset += 1;
    let result = "";
    while (offset < text.length) {
      const character = text[offset++];
      if (character === '"') return result;
      if (character === "\\") {
        if (offset >= text.length) fail();
        const escaped = text[offset++];
        const simple = {
          '"': '"',
          "\\": "\\",
          "/": "/",
          b: "\b",
          f: "\f",
          n: "\n",
          r: "\r",
          t: "\t",
        };
        if (Object.prototype.hasOwnProperty.call(simple, escaped)) {
          result += simple[escaped];
          continue;
        }
        if (escaped !== "u" || offset + 4 > text.length) fail();
        const hexadecimal = text.slice(offset, offset + 4);
        if (!/^[0-9a-f]{4}$/iu.test(hexadecimal)) fail();
        result += String.fromCharCode(Number.parseInt(hexadecimal, 16));
        offset += 4;
        continue;
      }
      if (character.charCodeAt(0) < 0x20) fail();
      result += character;
    }
    fail();
  }

  function parseNumber() {
    const match = text.slice(offset).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u);
    if (!match) fail();
    offset += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) fail();
    return value;
  }

  function parseValue() {
    skipWhitespace();
    if (offset >= text.length) fail();
    const character = text[offset];
    if (character === "{") return parseObject();
    if (character === "[") return parseArray();
    if (character === '"') return parseString();
    if (text.startsWith("true", offset)) {
      offset += 4;
      return true;
    }
    if (text.startsWith("false", offset)) {
      offset += 5;
      return false;
    }
    if (text.startsWith("null", offset)) {
      offset += 4;
      return null;
    }
    if (character === "-" || /[0-9]/u.test(character)) return parseNumber();
    fail();
  }

  function parseArray() {
    offset += 1;
    const result = [];
    skipWhitespace();
    if (text[offset] === "]") {
      offset += 1;
      return result;
    }
    while (true) {
      result.push(parseValue());
      skipWhitespace();
      if (text[offset] === "]") {
        offset += 1;
        return result;
      }
      if (text[offset] !== ",") fail();
      offset += 1;
      skipWhitespace();
      if (text[offset] === "]") fail();
    }
  }

  function parseObject() {
    offset += 1;
    const result = Object.create(null);
    const keys = new Set();
    skipWhitespace();
    if (text[offset] === "}") {
      offset += 1;
      return result;
    }
    while (true) {
      skipWhitespace();
      if (text[offset] !== '"') fail();
      const key = parseString();
      if (keys.has(key)) reject("policy_duplicate_key");
      keys.add(key);
      skipWhitespace();
      if (text[offset] !== ":") fail();
      offset += 1;
      result[key] = parseValue();
      skipWhitespace();
      if (text[offset] === "}") {
        offset += 1;
        return result;
      }
      if (text[offset] !== ",") fail();
      offset += 1;
      skipWhitespace();
      if (text[offset] === "}") fail();
    }
  }

  const result = parseValue();
  skipWhitespace();
  if (offset !== text.length) fail();
  return result;
}

function parseInspectOutput(value, code) {
  const parsed = parseJSONOutput(value, code);
  if (!Array.isArray(parsed) || parsed.length !== 1) reject(code);
  return requireRecord(parsed[0], code);
}

function normalizeDockerStatus(result, code) {
  if (!isRecord(result)) reject(code);
  const status = result.status ?? result.exitCode;
  if (!Number.isInteger(status) || status < 0 || status > 255) reject(code);
  return status;
}

function normalizeFailure(error) {
  if (error instanceof SchemaCompatibilityError) return error;
  return new SchemaCompatibilityError("operation_failed");
}

function buildDockerEnvironment() {
  const environment = {};
  for (const key of DOCKER_OPERATIONAL_ENVIRONMENT_KEYS) {
    if (typeof process.env[key] === "string") environment[key] = process.env[key];
  }
  return environment;
}

export function createDockerRunner({ binary = "docker", spawn: spawnProcess = spawn } = {}) {
  if (typeof binary !== "string" || binary.length === 0 || binary.length > 256) {
    reject("docker_binary_invalid");
  }
  if (typeof spawnProcess !== "function") reject("docker_runner_invalid");

  return {
    run(args, options = {}) {
      if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string")) {
        return Promise.reject(new SchemaCompatibilityError("docker_input_invalid"));
      }
      const timeoutMs = options.timeoutMs ?? DOCKER_COMMAND_TIMEOUT_MS;
      const maxOutputBytes = options.maxOutputBytes ?? MAX_DOCKER_OUTPUT_BYTES;
      if (
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs <= 0 ||
        timeoutMs > 60_000 ||
        !Number.isSafeInteger(maxOutputBytes) ||
        maxOutputBytes <= 0 ||
        maxOutputBytes > MAX_DOCKER_OUTPUT_BYTES
      ) {
        return Promise.reject(new SchemaCompatibilityError("docker_limits_invalid"));
      }

      return new Promise((resolve, rejectPromise) => {
        let child;
        try {
          child = spawnProcess(binary, args, {
            stdio: ["ignore", "pipe", "ignore"],
            env: buildDockerEnvironment(),
            windowsHide: true,
          });
        } catch {
          rejectPromise(new SchemaCompatibilityError("docker_unavailable"));
          return;
        }

        let settled = false;
        let timedOut = false;
        let tooLarge = false;
        let byteCount = 0;
        const chunks = [];
        const timer = setTimeout(() => {
          timedOut = true;
          try {
            child.kill("SIGKILL");
          } catch {
            // The close/error event still determines the stable failure code.
          }
        }, timeoutMs);

        const settle = (callback, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          callback(value);
        };

        child.on("error", () => {
          settle(rejectPromise, new SchemaCompatibilityError("docker_unavailable"));
        });
        if (!child.stdout) {
          try {
            child.kill("SIGKILL");
          } catch {
            // Ignore a failed kill; the stable runner error is sufficient.
          }
          settle(rejectPromise, new SchemaCompatibilityError("docker_unavailable"));
          return;
        }
        child.stdout.on("data", (chunk) => {
          if (tooLarge) return;
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          byteCount += data.byteLength;
          if (byteCount > maxOutputBytes) {
            tooLarge = true;
            try {
              child.kill("SIGKILL");
            } catch {
              // The close event will report the bounded-output failure.
            }
            return;
          }
          chunks.push(data);
        });
        child.on("close", (status) => {
          if (timedOut) {
            settle(rejectPromise, new SchemaCompatibilityError("docker_timeout"));
            return;
          }
          if (tooLarge) {
            settle(rejectPromise, new SchemaCompatibilityError("docker_output_too_large"));
            return;
          }
          settle(resolve, {
            status: Number.isInteger(status) ? status : null,
            stdout: Buffer.concat(chunks),
          });
        });
      });
    },
  };
}

function getRunner(candidate) {
  if (typeof candidate === "function") return candidate;
  if (candidate && typeof candidate.run === "function") return candidate.run.bind(candidate);
  return createDockerRunner().run;
}

async function dockerSuccess(runner, args, {
  failureCode = "docker_command_failed",
  timeoutCode = "docker_timeout",
  timeoutMs = DOCKER_COMMAND_TIMEOUT_MS,
  maxOutputBytes = MAX_DOCKER_OUTPUT_BYTES,
} = {}) {
  let result;
  try {
    result = await runner(args, { timeoutMs, maxOutputBytes });
  } catch (error) {
    if (error instanceof SchemaCompatibilityError && error.code === "docker_timeout") {
      reject(timeoutCode);
    }
    if (error instanceof SchemaCompatibilityError && error.code === "docker_output_too_large") {
      reject("docker_output_too_large");
    }
    reject(failureCode);
  }
  normalizeDockerStatus(result, failureCode);
  const stdout = decodeDockerOutput(result.stdout ?? "", failureCode);
  if ((result.status ?? result.exitCode) !== 0) reject(failureCode);
  return stdout;
}

async function inspectImage(runner, image) {
  const output = await dockerSuccess(
    runner,
    ["image", "inspect", "--format", "{{.Id}}", image],
    { failureCode: "image_inspect_failed", timeoutCode: "image_inspect_timeout" },
  );
  const actual = decodeUTF8(output, "image_identity_invalid").trim();
  if (actual !== image) reject("image_identity_mismatch");
}

async function inspectContainer(runner, id, failureCode, timeoutCode) {
  const output = await dockerSuccess(
    runner,
    ["inspect", "--type", "container", id],
    { failureCode, timeoutCode },
  );
  return parseInspectOutput(output, "container_inspect_invalid");
}

function assertContainerEnvironment(config) {
  if (!Array.isArray(config.Env)) reject("container_environment_invalid");
  const seen = new Set();
  for (const entry of config.Env) {
    if (typeof entry !== "string") reject("container_environment_invalid");
    const separator = entry.indexOf("=");
    if (separator <= 0) reject("container_environment_invalid");
    const key = entry.slice(0, separator);
    const value = entry.slice(separator + 1);
    if (!ENVIRONMENT_KEY_PATTERN.test(key) || seen.has(key)) {
      reject("container_environment_invalid");
    }
    seen.add(key);
    if (CREDENTIAL_KEY_PATTERN.test(key) || CREDENTIAL_VALUE_PATTERN.test(value)) {
      reject("container_environment_credentials");
    }
    if (Object.prototype.hasOwnProperty.call(FIXED_IMAGE_ENVIRONMENT, key)) {
      if (value !== FIXED_IMAGE_ENVIRONMENT[key]) reject("container_environment_invalid");
      continue;
    }
    if (!SAFE_ENVIRONMENT_KEY_PATTERN.test(key)) {
      reject("container_environment_unsupported");
    }
  }
}

function emptyObjectOrNull(value, code) {
  if (value === undefined || value === null) return;
  if (!isRecord(value) || Object.keys(value).length !== 0) reject(code);
}

function emptyArrayOrNull(value, code) {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value) || value.length !== 0) reject(code);
}

function assertContainerSecurity(container, expected, { requireStopped = false, requireCreated = false } = {}) {
  if (container.Id !== expected.id) reject("container_identity_invalid");
  if (container.Image !== expected.image) reject("container_image_mismatch");

  const config = requireRecord(container.Config, "container_config_invalid");
  if (config.Image !== expected.image) reject("container_image_mismatch");
  if (config.User !== SCHEMA_COMPATIBILITY_USER) reject("container_user_invalid");
  const labels = requireRecord(config.Labels, "container_labels_invalid");
  if (labels[SCHEMA_COMPATIBILITY_LABEL] !== expected.runID) {
    reject("container_label_invalid");
  }
  if (
    !Array.isArray(config.Entrypoint) ||
    config.Entrypoint.length !== 1 ||
    config.Entrypoint[0] !== "/bin/sh"
  ) {
    reject("container_entrypoint_invalid");
  }
  if (
    !Array.isArray(config.Cmd) ||
    config.Cmd.length !== 2 ||
    config.Cmd[0] !== "-c" ||
    config.Cmd[1] !== SCHEMA_INSPECTION_SCRIPT
  ) {
    reject("container_command_invalid");
  }
  if (container.Path !== "/bin/sh" || !Array.isArray(container.Args) ||
      container.Args.length !== 2 || container.Args[0] !== "-c" ||
      container.Args[1] !== SCHEMA_INSPECTION_SCRIPT) {
    reject("container_command_invalid");
  }
  assertContainerEnvironment(config);

  const hostConfig = requireRecord(container.HostConfig, "container_host_config_invalid");
  if (hostConfig.ReadonlyRootfs !== true) reject("container_rootfs_not_read_only");
  if (hostConfig.Privileged !== false) reject("container_privilege_boundary_invalid");
  if (
    !Array.isArray(hostConfig.CapDrop) ||
    hostConfig.CapDrop.length !== 1 ||
    hostConfig.CapDrop[0] !== "ALL"
  ) {
    reject("container_capabilities_invalid");
  }
  emptyArrayOrNull(hostConfig.CapAdd, "container_capabilities_invalid");
  if (
    !Array.isArray(hostConfig.SecurityOpt) ||
    hostConfig.SecurityOpt.length !== 1 ||
    hostConfig.SecurityOpt[0] !== "no-new-privileges:true"
  ) {
    reject("container_privilege_boundary_invalid");
  }
  if (hostConfig.NetworkMode !== "none") reject("container_network_invalid");
  if (hostConfig.RestartPolicy?.Name !== "no") reject("container_restart_policy_invalid");
  if (hostConfig.AutoRemove !== false) reject("container_cleanup_policy_invalid");
  if (hostConfig.Memory !== CONTAINER_MEMORY_BYTES ||
      hostConfig.MemorySwap !== CONTAINER_MEMORY_BYTES) {
    reject("container_memory_limit_invalid");
  }
  if (hostConfig.PidsLimit !== CONTAINER_PIDS_LIMIT) reject("container_pids_limit_invalid");
  emptyArrayOrNull(hostConfig.Binds, "container_mounts_invalid");
  emptyObjectOrNull(hostConfig.Tmpfs, "container_mounts_invalid");
  emptyObjectOrNull(hostConfig.PortBindings, "container_ports_invalid");

  if (!Array.isArray(container.Mounts) || container.Mounts.length !== 0) {
    reject("container_mounts_invalid");
  }
  if (container.Config.Volumes !== undefined && container.Config.Volumes !== null) {
    emptyObjectOrNull(container.Config.Volumes, "container_mounts_invalid");
  }
  const networkSettings = requireRecord(container.NetworkSettings, "container_network_invalid");
  const networks = requireRecord(networkSettings.Networks, "container_network_invalid");
  const networkNames = Object.keys(networks);
  if (networkNames.length === 0 && !requireStopped) {
    // Docker may report no endpoint between create and start. Once the
    // process has started, --network none is represented by a `none` object.
  } else {
    if (networkNames.length !== 1 || networkNames[0] !== "none") {
      reject("container_network_invalid");
    }
    const isolated = requireRecord(networks.none, "container_network_invalid");
    for (const key of ["IPAddress", "GlobalIPv6Address", "Gateway", "IPv6Gateway", "MacAddress"]) {
      if (isolated[key] !== undefined && isolated[key] !== "") {
        reject("container_network_invalid");
      }
    }
  }
  emptyObjectOrNull(networkSettings.Ports, "container_ports_invalid");

  const state = requireRecord(container.State, "container_state_invalid");
  if (requireCreated && (state.Running !== false || state.Status !== "created")) {
    reject("container_already_started");
  }
  if (requireStopped && (state.Running !== false || state.ExitCode !== 0)) {
    reject("container_inspection_failed");
  }
}

function assertOwnedForCleanup(container, id, runID) {
  if (container.Id !== id) reject("cleanup_ownership_unverified");
  const config = requireRecord(container.Config, "cleanup_ownership_unverified");
  const labels = requireRecord(config.Labels, "cleanup_ownership_unverified");
  if (labels[SCHEMA_COMPATIBILITY_LABEL] !== runID) {
    reject("cleanup_ownership_unverified");
  }
}

async function cleanupOwnedContainer(runner, id, runID) {
  if (!id) return;
  let inspected;
  try {
    inspected = await inspectContainer(
      runner,
      id,
      "cleanup_inspect_failed",
      "cleanup_inspect_timeout",
    );
    assertOwnedForCleanup(inspected, id, runID);
    await dockerSuccess(
      runner,
      ["rm", "--force", id],
      { failureCode: "cleanup_failed", timeoutCode: "cleanup_timeout" },
    );
  } catch (error) {
    if (error instanceof SchemaCompatibilityError && error.code === "cleanup_ownership_unverified") {
      throw error;
    }
    throw new SchemaCompatibilityError("cleanup_failed");
  }
}

function parseContainerID(output) {
  const value = decodeUTF8(output, "created_container_invalid").trim();
  if (!CONTAINER_ID_PATTERN.test(value)) reject("created_container_invalid");
  return value;
}

function parseContainerIDs(output) {
  const value = decodeUTF8(output, "create_cleanup_lookup_invalid").trim();
  if (value === "") return [];
  const ids = value.split(/\s+/u);
  if (ids.some((id) => !CONTAINER_ID_PATTERN.test(id))) {
    reject("create_cleanup_lookup_invalid");
  }
  if (new Set(ids).size !== ids.length) reject("create_cleanup_ambiguous");
  return ids;
}

async function recoverCreatedContainerByLabel(runner, runID) {
  // A create response can be lost after the daemon persists the container. Only
  // a unique exact label result plus an exact ID/label inspection proves the
  // cleanup target; otherwise report the uncertainty and never guess a name.
  let ids;
  try {
    const output = await dockerSuccess(
      runner,
      [
        "ps",
        "--all",
        "--no-trunc",
        "--quiet",
        "--filter",
        `label=${SCHEMA_COMPATIBILITY_LABEL}=${runID}`,
      ],
      {
        failureCode: "create_cleanup_lookup_failed",
        timeoutCode: "create_cleanup_lookup_timeout",
      },
    );
    ids = parseContainerIDs(output);
  } catch (error) {
    if (error instanceof SchemaCompatibilityError && error.code === "create_cleanup_ambiguous") {
      throw error;
    }
    throw new SchemaCompatibilityError("create_cleanup_unconfirmed");
  }
  if (ids.length === 0) reject("create_cleanup_unconfirmed");
  if (ids.length !== 1) reject("create_cleanup_ambiguous");
  let inspected;
  try {
    inspected = await inspectContainer(
      runner,
      ids[0],
      "create_cleanup_inspect_failed",
      "create_cleanup_inspect_timeout",
    );
    assertOwnedForCleanup(inspected, ids[0], runID);
  } catch (error) {
    if (error instanceof SchemaCompatibilityError && error.code === "cleanup_ownership_unverified") {
      throw new SchemaCompatibilityError("create_cleanup_ownership_unverified");
    }
    throw new SchemaCompatibilityError("create_cleanup_unconfirmed");
  }
  return ids[0];
}

function createRunID() {
  return randomBytes(32).toString("hex");
}

function createContainerArguments(image, runID) {
  assertImageID(image);
  assertRunID(runID);
  return [
    "create",
    "--pull",
    "never",
    "--label",
    `${SCHEMA_COMPATIBILITY_LABEL}=${runID}`,
    "--network",
    "none",
    "--read-only",
    "--user",
    SCHEMA_COMPATIBILITY_USER,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--pids-limit",
    String(CONTAINER_PIDS_LIMIT),
    "--memory",
    `${CONTAINER_MEMORY_BYTES}b`,
    "--memory-swap",
    `${CONTAINER_MEMORY_BYTES}b`,
    "--stop-timeout",
    "1",
    "--restart",
    "no",
    "--entrypoint",
    "/bin/sh",
    image,
    "-c",
    SCHEMA_INSPECTION_SCRIPT,
  ];
}

function readReportLine(buffer, offset) {
  const end = buffer.indexOf(0x0a, offset);
  if (end < 0) reject("container_report_invalid");
  return {
    line: buffer.subarray(offset, end).toString("utf8"),
    offset: end + 1,
  };
}

function parseInspectionReport(output) {
  const buffer = decodeDockerOutput(output, "container_report_invalid");
  let offset = 0;
  let line = readReportLine(buffer, offset);
  offset = line.offset;
  if (line.line !== INSPECTION_REPORT_HEADER) reject("container_report_invalid");

  const migrations = [];
  let declaredCount;
  while (true) {
    line = readReportLine(buffer, offset);
    offset = line.offset;
    if (line.line.startsWith("M\t")) {
      const fields = line.line.split("\t");
      if (fields.length !== 3) reject("container_report_invalid");
      migrations.push({ name: fields[1], sha256: fields[2] });
      if (migrations.length > MAX_MIGRATIONS) reject("container_report_invalid");
      continue;
    }
    if (line.line.startsWith("C\t")) {
      const value = line.line.slice(2);
      if (!/^(?:0|[1-9][0-9]{0,2})$/u.test(value)) reject("container_report_invalid");
      declaredCount = Number(value);
      break;
    }
    reject("container_report_invalid");
  }
  if (declaredCount !== migrations.length) reject("container_report_invalid");

  line = readReportLine(buffer, offset);
  offset = line.offset;
  if (line.line === "N") {
    if (offset !== buffer.byteLength) reject("container_report_invalid");
    return { migrations, policy: null };
  }
  if (!line.line.startsWith("P\t")) reject("container_report_invalid");
  const byteCountText = line.line.slice(2);
  if (!/^(?:0|[1-9][0-9]{0,5})$/u.test(byteCountText)) {
    reject("container_report_invalid");
  }
  const byteCount = Number(byteCountText);
  if (byteCount > MAX_POLICY_BYTES || offset + byteCount > buffer.byteLength) {
    reject("container_report_invalid");
  }
  const policyBytes = buffer.subarray(offset, offset + byteCount);
  offset += byteCount;
  if (offset >= buffer.byteLength || buffer[offset] !== 0x0a) reject("container_report_invalid");
  offset += 1;
  line = readReportLine(buffer, offset);
  offset = line.offset;
  if (line.line !== INSPECTION_REPORT_END || offset !== buffer.byteLength) {
    reject("container_report_invalid");
  }
  const policyText = decodeUTF8(policyBytes, "policy_invalid");
  let policy;
  try {
    policy = parseStrictJSON(policyText);
  } catch (error) {
    if (error instanceof SchemaCompatibilityError) throw error;
    reject("policy_invalid");
  }
  return { migrations, policy };
}

function validateMigrationInventory(input, scope) {
  const inventory = requireRecord(input, `${scope}_inventory_invalid`);
  const migrations = inventory.migrations;
  if (!Array.isArray(migrations) || migrations.length === 0 || migrations.length > MAX_MIGRATIONS) {
    reject(`${scope}_inventory_invalid`);
  }
  const seenNames = new Set();
  const seenNumbers = new Set();
  const normalized = [];
  for (let index = 0; index < migrations.length; index += 1) {
    const migration = requireRecord(migrations[index], `${scope}_migration_invalid`);
    requireExactKeys(migration, ["name", "sha256"], `${scope}_migration_fields_invalid`);
    const number = migrationNumber(migration.name, `${scope}_migration_name_invalid`);
    assertSHA256(migration.sha256, `${scope}_migration_hash_invalid`);
    if (seenNames.has(migration.name)) reject(`${scope}_migration_duplicate`);
    if (seenNumbers.has(number)) reject(`${scope}_migration_duplicate`);
    if (number !== index + 1) reject(`${scope}_migration_sequence_invalid`);
    if (index > 0 && normalized[index - 1].name >= migration.name) {
      reject(`${scope}_migration_order_invalid`);
    }
    seenNames.add(migration.name);
    seenNumbers.add(number);
    normalized.push(Object.freeze({ name: migration.name, sha256: migration.sha256, number }));
  }
  return normalized;
}

function validatePolicy(input, migrations, scope) {
  if (input === null || input === undefined) return null;
  const policy = requireRecord(input, `${scope}_policy_invalid`);
  requireExactKeys(
    policy,
    ["version", "baseMigration", "compatibleMigrations"],
    `${scope}_policy_fields_invalid`,
  );
  if (policy.version !== SCHEMA_COMPATIBILITY_POLICY_VERSION) {
    reject(`${scope}_policy_version_invalid`);
  }
  if (policy.baseMigration !== REVIEWED_BASE_MIGRATION) {
    reject(`${scope}_policy_base_unreviewed`);
  }
  const baseNumber = migrationNumber(policy.baseMigration, `${scope}_policy_base_invalid`);
  const migrationByName = new Map(migrations.map((migration) => [migration.name, migration]));
  if (!migrationByName.has(policy.baseMigration)) reject(`${scope}_policy_base_missing`);
  if (!Array.isArray(policy.compatibleMigrations) || policy.compatibleMigrations.length !== 1) {
    reject(`${scope}_policy_compatible_invalid`);
  }

  const compatible = [];
  const compatibleByName = new Map();
  const compatibleByNumber = new Map();
  for (let index = 0; index < policy.compatibleMigrations.length; index += 1) {
    const item = requireRecord(
      policy.compatibleMigrations[index],
      `${scope}_policy_compatible_invalid`,
    );
    requireExactKeys(item, ["name", "sha256"], `${scope}_policy_compatible_fields_invalid`);
    const number = migrationNumber(item.name, `${scope}_policy_compatible_name_invalid`);
    assertSHA256(item.sha256, `${scope}_policy_compatible_hash_invalid`);
    if (
      item.name !== REVIEWED_COMPATIBLE_MIGRATION ||
      item.sha256 !== REVIEWED_COMPATIBLE_MIGRATION_SHA256 ||
      number !== baseNumber + index + 1
    ) {
      reject(`${scope}_policy_sequence_invalid`);
    }
    if (compatibleByName.has(item.name) || compatibleByNumber.has(number)) {
      reject(`${scope}_policy_duplicate`);
    }
    const existing = migrationByName.get(item.name);
    if (existing && existing.sha256 !== item.sha256) {
      reject(`${scope}_policy_hash_mismatch`);
    }
    const normalized = Object.freeze({ name: item.name, sha256: item.sha256, number });
    compatible.push(normalized);
    compatibleByName.set(item.name, normalized);
    compatibleByNumber.set(number, normalized);
  }

  for (const migration of migrations) {
    if (migration.number <= baseNumber) continue;
    const authorized = compatibleByName.get(migration.name);
    if (!authorized || authorized.sha256 !== migration.sha256) {
      reject(`${scope}_policy_inventory_mismatch`);
    }
  }

  return Object.freeze({
    version: policy.version,
    baseMigration: policy.baseMigration,
    compatibleMigrations: Object.freeze(compatible),
  });
}

function normalizeInventory(input, scope) {
  const inventory = requireRecord(input, `${scope}_inventory_invalid`);
  const migrations = validateMigrationInventory(inventory, scope);
  const policy = validatePolicy(inventory.policy ?? null, migrations, scope);
  return Object.freeze({ migrations: Object.freeze(migrations), policy });
}

function comparisonSummary(previous, target, commonMigrationCount, addedMigrationCount) {
  return Object.freeze({
    status: "compatible",
    previousMigrationCount: previous.migrations.length,
    targetMigrationCount: target.migrations.length,
    commonMigrationCount,
    addedMigrationCount,
    removedMigrationCount: 0,
    policyUsed: addedMigrationCount > 0,
  });
}

// This function intentionally accepts only bounded, already-collected
// metadata. It never receives SQL bytes and is independent of Docker so it can
// be unit-tested without a daemon.
export function compareSchemaInventories(previousInput, targetInput) {
  const previous = normalizeInventory(previousInput, "previous");
  const target = normalizeInventory(targetInput, "target");
  const previousByName = new Map(previous.migrations.map((migration) => [migration.name, migration]));
  const targetByName = new Map(target.migrations.map((migration) => [migration.name, migration]));

  let commonMigrationCount = 0;
  for (const migration of previous.migrations) {
    const targetMigration = targetByName.get(migration.name);
    if (!targetMigration) reject("target_missing_previous_migration");
    commonMigrationCount += 1;
    if (targetMigration.sha256 !== migration.sha256) {
      reject("common_migration_hash_mismatch");
    }
  }

  const added = target.migrations.filter((migration) => !previousByName.has(migration.name));
  if (previous.policy && target.policy && previous.policy.baseMigration !== target.policy.baseMigration) {
    reject("policy_baseline_mismatch");
  }
  if (added.length > 0) {
    if (!previous.policy) reject("previous_policy_missing");
    const authorizedByName = new Map(
      previous.policy.compatibleMigrations.map((migration) => [migration.name, migration]),
    );
    for (const migration of added) {
      const authorized = authorizedByName.get(migration.name);
      if (!authorized || authorized.sha256 !== migration.sha256) {
        reject("migration_not_authorized");
      }
    }
  }

  return comparisonSummary(previous, target, commonMigrationCount, added.length);
}

export function compareSchemaCompatibility(previousOrInput, maybeTarget) {
  if (maybeTarget !== undefined) {
    return compareSchemaInventories(previousOrInput, maybeTarget);
  }
  const input = requireRecord(previousOrInput, "comparison_input_invalid");
  requireExactKeys(input, ["previous", "target"], "comparison_input_invalid");
  return compareSchemaInventories(input.previous, input.target);
}

async function runImageInspection(runner, image, runID) {
  let ownedID;
  let failure;
  let cleanupFailure;
  let createAttempted = false;
  let inventory;
  try {
    await inspectImage(runner, image);
    createAttempted = true;
    const created = await dockerSuccess(
      runner,
      createContainerArguments(image, runID),
      { failureCode: "container_create_failed", timeoutCode: "container_create_timeout" },
    );
    ownedID = parseContainerID(created);
    const createdInspection = await inspectContainer(
      runner,
      ownedID,
      "container_inspect_failed",
      "container_inspect_timeout",
    );
    assertContainerSecurity(createdInspection, { id: ownedID, image, runID }, { requireCreated: true });

    const started = await dockerSuccess(
      runner,
      ["start", "--attach", ownedID],
      {
        failureCode: "container_run_failed",
        timeoutCode: "container_run_timeout",
        timeoutMs: CONTAINER_TIMEOUT_MS,
      },
    );
    const completedInspection = await inspectContainer(
      runner,
      ownedID,
      "container_post_run_inspect_failed",
      "container_post_run_inspect_timeout",
    );
    assertContainerSecurity(completedInspection, { id: ownedID, image, runID }, { requireStopped: true });
    inventory = parseInspectionReport(started);
    normalizeInventory(inventory, "container");
  } catch (error) {
    failure = normalizeFailure(error);
    if (createAttempted && !ownedID) {
      try {
        ownedID = await recoverCreatedContainerByLabel(runner, runID);
      } catch (recoveryError) {
        cleanupFailure = normalizeFailure(recoveryError);
      }
    }
  }

  if (ownedID && !cleanupFailure) {
    try {
      await cleanupOwnedContainer(runner, ownedID, runID);
    } catch (error) {
      cleanupFailure = normalizeFailure(error);
    }
  }
  if (cleanupFailure) throw cleanupFailure;
  if (failure) throw failure;
  return inventory;
}

export async function verifySchemaCompatibility(options = {}) {
  try {
    const previousImage = options.previousImage ?? options["previous-image"];
    const targetImage = options.targetImage ?? options["target-image"];
    assertImageID(previousImage, "invalid_previous_image");
    assertImageID(targetImage, "invalid_target_image");
    const runner = getRunner(options.dockerRunner);
    const runIDFactory = options.runIDFactory ?? createRunID;
    if (typeof runIDFactory !== "function") reject("run_id_factory_invalid");

    const previousRunID = runIDFactory("previous");
    const targetRunID = runIDFactory("target");
    assertRunID(previousRunID);
    assertRunID(targetRunID);
    const previous = await runImageInspection(runner, previousImage, previousRunID);
    const target = await runImageInspection(runner, targetImage, targetRunID);
    return compareSchemaInventories(previous, target);
  } catch (error) {
    throw normalizeFailure(error);
  }
}

export const runSchemaCompatibility = verifySchemaCompatibility;

export function parseCLI(argv) {
  const command = argv[0] ?? "help";
  if (command === "help" || command === "--help" || command === "-h") {
    return { command: "help" };
  }
  if (command !== "verify") reject("invalid_command");
  const values = { command };
  const allowed = new Set(["--previous-image", "--target-image"]);
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!allowed.has(argument)) reject("invalid_argument");
    const key = argument.slice(2).replaceAll("-", "_");
    if (values[key] !== undefined) reject("duplicate_argument");
    const value = argv[++index];
    if (!value) reject("missing_argument_value");
    values[key] = value;
  }
  if (!values.previous_image || !values.target_image) reject("missing_argument");
  assertImageID(values.previous_image, "invalid_previous_image");
  assertImageID(values.target_image, "invalid_target_image");
  return values;
}

function helpText() {
  return [
    "Usage:",
    "  release-schema-compatibility.mjs verify --previous-image sha256:<64hex> --target-image sha256:<64hex>",
    "",
    "Inspect two immutable Workspace images in bounded, network-isolated read-only containers.",
  ].join("\n");
}

export async function runCLI(argv) {
  const options = parseCLI(argv);
  if (options.command === "help") {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  const result = await verifySchemaCompatibility({
    previousImage: options.previous_image,
    targetImage: options.target_image,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    await runCLI(process.argv.slice(2));
  } catch (error) {
    const code = error instanceof SchemaCompatibilityError ? error.code : "operation_failed";
    process.stderr.write(`release schema compatibility rejected: ${code}\n`);
    process.exitCode = 1;
  }
}
