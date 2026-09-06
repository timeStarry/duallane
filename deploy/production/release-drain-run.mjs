#!/usr/bin/env node

import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  DrainConfigError,
  RELEASE_CHECK_COMMAND,
  RELEASE_CHECK_ENTRYPOINT,
  RELEASE_CHECK_SERVICE,
  RELEASE_CHECK_USER,
  assertSupportedPlatform,
  buildDrainCompose,
  readPrivateJSON,
  validateReport,
  writePrivateJSON,
} from "./release-drain-config.mjs";

// This is an observer runner, not an admission or writer-fencing mechanism.
// The caller must stop/fence the active owners before treating a ready report
// as a release input.
const RELEASE_RUN_LABEL = "com.duallane.release-run";
const IMAGE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const CONTAINER_ID_PATTERN = /^[0-9a-f]{64}$/u;
const CONTAINER_REFERENCE_PATTERN = /^[0-9a-f]{12,64}$/u;
const RUN_ID_PATTERN = /^[0-9a-f]{64}$/u;
const ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const SAFE_TEXT_PATTERN = /^[^\u0000-\u001f\u007f]*$/u;
const MAX_DOCKER_OUTPUT_BYTES = 64 * 1024;
const DOCKER_COMMAND_TIMEOUT_MS = 10_000;
const DOCKER_WAIT_TIMEOUT_MS = 20_000;
// These are fixed asset paths baked into Dockerfile.workspace, not database,
// provider or writer overrides. Any changed value still fails closed.
const FIXED_IMAGE_ASSET_ENVIRONMENT = Object.freeze({
  DUALLANE_MIGRATIONS_DIR: "/app/migrations",
  DUALLANE_EMOTE_CATALOG_PATH: "/app/assets/emote-packs.json",
  DUALLANE_ECHO_RELEASE_CATALOG_PATH: "/app/assets/echo-release-guides.json",
});

const REPORT_COUNT_FIELDS = Object.freeze({
  schema: ["missingItems"],
  uploads: [
    "reserved",
    "staleReserved",
    "missingAttachment",
    "nonPendingAttachment",
    "partRows",
    "partUploadCount",
    "reservedPartRows",
    "unknownStatus",
  ],
  emailJobs: [
    "pending",
    "sending",
    "sent",
    "cancelled",
    "failed",
    "unknownStatus",
    "activeLeases",
    "expiredLeases",
    "sendingMissingLease",
    "sendingExpiredLease",
    "leaseAnomalies",
  ],
  ntfyJobs: [
    "pending",
    "sending",
    "sent",
    "cancelled",
    "failed",
    "unknownStatus",
    "activeLeases",
    "expiredLeases",
    "sendingMissingLease",
    "sendingExpiredLease",
    "leaseAnomalies",
  ],
  emailDigest: [
    "rows",
    "unnotified",
    "notified",
    "activeLeases",
    "expiredLeases",
    "unnotifiedActiveLeases",
    "unnotifiedExpiredLeases",
    "unnotifiedWithoutLease",
    "notifiedWithLease",
  ],
  echoSolicitation: [
    "pending",
    "sent",
    "failed",
    "skipped",
    "unknownStatus",
    "reconcile",
  ],
  echoRelease: [
    "pending",
    "sent",
    "failed",
    "skipped",
    "unknownStatus",
    "reconcile",
  ],
});

const BLOCKER_CODES = new Set([
  "schema_unavailable",
  "schema_incompatible",
  "upload_reserved",
  "upload_missing_attachment",
  "upload_nonpending_attachment",
  "upload_unknown_status",
  "email_sending",
  "email_lease_anomaly",
  "email_unknown_status",
  "ntfy_sending",
  "ntfy_lease_anomaly",
  "ntfy_unknown_status",
  "email_digest_active_lease",
  "email_digest_lease_anomaly",
  "echo_solicitation_unknown_status",
  "echo_release_unknown_status",
  "snapshot_failed",
]);

const REPORT_BLOCKER_RULES = Object.freeze([
  ["uploads", "unknownStatus", "upload_unknown_status"],
  ["uploads", "reserved", "upload_reserved"],
  ["uploads", "missingAttachment", "upload_missing_attachment"],
  ["uploads", "nonPendingAttachment", "upload_nonpending_attachment"],
  ["emailJobs", "unknownStatus", "email_unknown_status"],
  ["emailJobs", "sending", "email_sending"],
  ["emailJobs", "leaseAnomalies", "email_lease_anomaly"],
  ["ntfyJobs", "unknownStatus", "ntfy_unknown_status"],
  ["ntfyJobs", "sending", "ntfy_sending"],
  ["ntfyJobs", "leaseAnomalies", "ntfy_lease_anomaly"],
  ["emailDigest", "unnotifiedActiveLeases", "email_digest_active_lease"],
  ["emailDigest", "notifiedWithLease", "email_digest_lease_anomaly"],
  ["echoSolicitation", "unknownStatus", "echo_solicitation_unknown_status"],
  ["echoRelease", "unknownStatus", "echo_release_unknown_status"],
]);

class DrainRunError extends Error {
  constructor(code) {
    super(code);
    this.name = "DrainRunError";
    this.code = code;
  }
}

function reject(code) {
  throw new DrainRunError(code);
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

function assertSafeText(value, code, maxLength = 512) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    !SAFE_TEXT_PATTERN.test(value)
  ) {
    reject(code);
  }
  return value;
}

function assertCanonicalPath(value, code) {
  assertSafeText(value, code, 4096);
  if (!path.isAbsolute(value) || path.normalize(value) !== value) {
    reject(`${code}_not_canonical`);
  }
  return value;
}

function assertImageID(value) {
  if (typeof value !== "string" || !IMAGE_ID_PATTERN.test(value)) {
    reject("invalid_workspace_image");
  }
  return value;
}

function assertRunID(value) {
  if (typeof value !== "string" || !RUN_ID_PATTERN.test(value)) {
    reject("invalid_run_id");
  }
  return value;
}

function decodeComposeDollars(value) {
  // The canonical Compose JSON may contain $$ to carry one literal dollar
  // through the generated Compose parse. Decode exactly one Compose escape
  // layer before comparing Docker's effective Config.Env.
  return value.replaceAll("$$", "$");
}

function isDrainAuthorityEnvironmentKey(key) {
  return (
    key.startsWith("PG") ||
    key.startsWith("DATABASE_") ||
    key.startsWith("WORKSPACE_") ||
    key.startsWith("DUALLANE_") ||
    key.startsWith("AWS_") ||
    key.startsWith("S3_") ||
    key.startsWith("MINIO_")
  );
}

function normalizeFailure(error) {
  if (error instanceof DrainRunError) return error;
  if (error instanceof DrainConfigError && typeof error.code === "string") {
    return new DrainRunError(error.code);
  }
  return new DrainRunError("operation_failed");
}

async function assertPrivateDestination(filePath, prefix) {
  assertSupportedPlatform();
  const destination = assertCanonicalPath(filePath, `${prefix}_path`);
  const parsed = path.parse(destination);
  let current = parsed.root;
  const relative = destination.slice(parsed.root.length);
  const parts = relative.split(path.sep).filter((part) => part.length > 0);

  for (let index = 0; index < Math.max(0, parts.length - 1); index += 1) {
    current = path.join(current, parts[index]);
    let info;
    try {
      info = await lstat(current, { bigint: true });
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
        reject(`${prefix}_parent_missing`);
      }
      reject(`${prefix}_parent_unavailable`);
    }
    if (info.isSymbolicLink()) reject(`${prefix}_parent_symlink`);
    if (!info.isDirectory()) reject(`${prefix}_parent_not_directory`);
  }

  try {
    const existing = await lstat(destination, { bigint: true });
    if (existing.isSymbolicLink()) reject(`${prefix}_symlink`);
    reject(`${prefix}_exists`);
  } catch (error) {
    if (error instanceof DrainRunError) throw error;
    if (error?.code !== "ENOENT") reject(`${prefix}_unavailable`);
  }
}

function assertOutputString(value, code) {
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > MAX_DOCKER_OUTPUT_BYTES) {
      reject("docker_output_too_large");
    }
    return value;
  }
  if (value instanceof Uint8Array) {
    if (value.byteLength > MAX_DOCKER_OUTPUT_BYTES) {
      reject("docker_output_too_large");
    }
    return Buffer.from(value).toString("utf8");
  }
  reject(code);
}

function createDockerRunner({ binary = "docker" } = {}) {
  assertSafeText(binary, "docker_binary_invalid", 256);
  return {
    run(args, options = {}) {
      if (
        !Array.isArray(args) ||
        args.some((argument) => typeof argument !== "string")
      ) {
        return Promise.reject(new DrainRunError("docker_input_invalid"));
      }
      const timeoutMs = options.timeoutMs ?? DOCKER_COMMAND_TIMEOUT_MS;
      const maxOutputBytes = options.maxOutputBytes ?? MAX_DOCKER_OUTPUT_BYTES;
      if (
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs <= 0 ||
        !Number.isSafeInteger(maxOutputBytes) ||
        maxOutputBytes <= 0 ||
        maxOutputBytes > MAX_DOCKER_OUTPUT_BYTES
      ) {
        return Promise.reject(new DrainRunError("docker_limits_invalid"));
      }

      return new Promise((resolve, rejectPromise) => {
        let child;
        try {
          child = spawn(binary, args, {
            stdio: ["ignore", "pipe", "ignore"],
            env: { ...process.env, COMPOSE_DISABLE_ENV_FILE: "1" },
            windowsHide: true,
          });
        } catch {
          rejectPromise(new DrainRunError("docker_unavailable"));
          return;
        }

        let settled = false;
        let timedOut = false;
        let tooLarge = false;
        let bytes = 0;
        const chunks = [];
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs);

        const settle = (callback, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          callback(value);
        };

        child.on("error", () => {
          settle(rejectPromise, new DrainRunError("docker_unavailable"));
        });
        if (!child.stdout) {
          child.kill("SIGKILL");
          settle(rejectPromise, new DrainRunError("docker_unavailable"));
          return;
        }
        child.stdout.on("data", (chunk) => {
          if (tooLarge) return;
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += data.byteLength;
          if (bytes > maxOutputBytes) {
            tooLarge = true;
            child.kill("SIGKILL");
            return;
          }
          chunks.push(data);
        });
        child.on("close", (status) => {
          if (timedOut) {
            settle(rejectPromise, new DrainRunError("docker_timeout"));
            return;
          }
          if (tooLarge) {
            settle(rejectPromise, new DrainRunError("docker_output_too_large"));
            return;
          }
          settle(resolve, {
            status: Number.isInteger(status) ? status : null,
            stdout: Buffer.concat(chunks).toString("utf8"),
          });
        });
      });
    },
  };
}

function getRunner(candidate) {
  if (typeof candidate === "function") return candidate;
  if (candidate && typeof candidate.run === "function") {
    return candidate.run.bind(candidate);
  }
  return createDockerRunner().run;
}

async function dockerSuccess(runner, args, options = {}) {
  const {
    failureCode = "docker_command_failed",
    timeoutCode = "docker_timeout",
  } = options;
  let result;
  try {
    result = await runner(args, {
      timeoutMs: options.timeoutMs ?? DOCKER_COMMAND_TIMEOUT_MS,
      maxOutputBytes: MAX_DOCKER_OUTPUT_BYTES,
    });
  } catch (error) {
    if (error instanceof DrainRunError) {
      if (error.code === "docker_timeout") reject(timeoutCode);
      if (error.code === "docker_output_too_large") {
        reject("docker_output_too_large");
      }
    }
    reject(failureCode);
  }
  if (!isRecord(result)) reject(failureCode);
  const status = result.status ?? result.exitCode;
  if (result.timedOut === true) reject(timeoutCode);
  if (!Number.isInteger(status)) reject(failureCode);
  const stdout = assertOutputString(result.stdout ?? "", failureCode);
  if (status !== 0) reject(failureCode);
  return stdout;
}

function parseJSONOutput(stdout, code) {
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    reject(code);
  }
  return value;
}

function parseInspect(stdout, code) {
  const value = parseJSONOutput(stdout, code);
  if (!Array.isArray(value) || value.length !== 1) reject(code);
  return requireRecord(value[0], code);
}

function parseContainerIDs(stdout, code) {
  const values = stdout.trim() === "" ? [] : stdout.trim().split(/\s+/u);
  for (const value of values) {
    if (!CONTAINER_REFERENCE_PATTERN.test(value)) reject(code);
  }
  return values;
}

function composeArgs(project, composePath, ...rest) {
  return [
    "compose",
    "--project-name",
    project,
    "--file",
    composePath,
    ...rest,
  ];
}

async function inspectImage(runner, workspaceImage) {
  const stdout = await dockerSuccess(
    runner,
    ["image", "inspect", "--format", "{{.Id}}", workspaceImage],
    { failureCode: "image_unavailable", timeoutCode: "image_check_timeout" },
  );
  if (stdout.trim() !== workspaceImage) reject("image_mismatch");
}

function assertComposeLabels(labels, project, service, runID = undefined) {
  const input = requireRecord(labels, "container_labels_invalid");
  if (input["com.docker.compose.project"] !== project) {
    reject("container_project_mismatch");
  }
  if (input["com.docker.compose.service"] !== service) {
    reject("container_service_mismatch");
  }
  if (runID !== undefined && input[RELEASE_RUN_LABEL] !== runID) {
    reject("container_run_label_mismatch");
  }
  return input;
}

function assertContainerEnvironment(container, expected) {
  const config = requireRecord(container.Config, "container_environment_invalid");
  if (!Array.isArray(config.Env)) reject("container_environment_invalid");
  const effective = new Map();
  for (const entry of config.Env) {
    if (typeof entry !== "string") reject("container_environment_invalid");
    const separator = entry.indexOf("=");
    if (separator <= 0) reject("container_environment_invalid");
    const key = entry.slice(0, separator);
    const value = entry.slice(separator + 1);
    if (!ENVIRONMENT_KEY_PATTERN.test(key) || effective.has(key)) {
      reject("container_environment_duplicate");
    }
    effective.set(key, value);
  }

  const generated = requireRecord(expected.environment, "generated_environment_invalid");
  for (const [key, value] of Object.entries(generated)) {
    if (typeof value !== "string") reject("generated_environment_invalid");
    if (!effective.has(key)) reject("container_environment_missing");
    if (effective.get(key) !== decodeComposeDollars(value)) {
      reject("container_environment_mismatch");
    }
  }
  for (const key of effective.keys()) {
    if (Object.prototype.hasOwnProperty.call(FIXED_IMAGE_ASSET_ENVIRONMENT, key) &&
        effective.get(key) === FIXED_IMAGE_ASSET_ENVIRONMENT[key]) continue;
    if (isDrainAuthorityEnvironmentKey(key) && !Object.prototype.hasOwnProperty.call(generated, key)) {
      reject("container_environment_unsupported");
    }
  }
}

function assertContainerIdentity(
  container,
  expected,
  {
    allowCreatedEmptyNetworkIDs = false,
    allowStoppedEmptyNetworkIDs = false,
  } = {},
) {
  if (container.Id !== expected.id) reject(expected.identityCode);
  const config = requireRecord(container.Config, expected.identityCode);
  const labels = assertComposeLabels(
    config.Labels,
    expected.project,
    expected.service,
    expected.runID,
  );
  if (config.Image !== expected.image || container.Image !== expected.image) {
    reject("container_image_mismatch");
  }
  if (config.User !== RELEASE_CHECK_USER) reject("container_user_mismatch");
  assertContainerEnvironment(container, expected);
  if (!Array.isArray(config.Entrypoint) ||
      JSON.stringify(config.Entrypoint) !== JSON.stringify([RELEASE_CHECK_ENTRYPOINT])) {
    reject("container_entrypoint_mismatch");
  }
  if (!Array.isArray(config.Cmd) ||
      JSON.stringify(config.Cmd) !== JSON.stringify([...RELEASE_CHECK_COMMAND])) {
    reject("container_command_mismatch");
  }

  const hostConfig = requireRecord(container.HostConfig, expected.identityCode);
  if (hostConfig.ReadonlyRootfs !== true) reject("container_rootfs_not_read_only");
  if (
    !Array.isArray(hostConfig.CapDrop) ||
    hostConfig.CapDrop.length !== 1 ||
    hostConfig.CapDrop[0] !== "ALL"
  ) {
    reject("container_capabilities_invalid");
  }
  if (
    !Array.isArray(hostConfig.SecurityOpt) ||
    hostConfig.SecurityOpt.length !== 1 ||
    hostConfig.SecurityOpt[0] !== "no-new-privileges:true"
  ) {
    reject("container_privilege_boundary_invalid");
  }
  const restartPolicy = requireRecord(hostConfig.RestartPolicy, expected.identityCode);
  if (restartPolicy.Name !== "no") reject("container_restart_policy_invalid");
  if (hostConfig.PortBindings !== undefined &&
      hostConfig.PortBindings !== null &&
      (!isRecord(hostConfig.PortBindings) || Object.keys(hostConfig.PortBindings).length !== 0)) {
    reject("container_ports_present");
  }
  const networkPorts = container.NetworkSettings?.Ports;
  if (networkPorts !== undefined && networkPorts !== null) {
    if (!isRecord(networkPorts)) reject("container_ports_invalid");
    for (const published of Object.values(networkPorts)) {
      // Docker may echo image EXPOSE declarations as null entries. Only a
      // non-null binding is a published host port, which the generated
      // Compose service must never have.
      if (published !== null && !(Array.isArray(published) && published.length === 0)) {
        reject("container_ports_present");
      }
    }
  }

  const mounts = container.Mounts;
  if (!Array.isArray(mounts)) reject("container_mounts_invalid");
  const expectedMounts = expected.secretMounts;
  if (!Array.isArray(expectedMounts) || mounts.length !== expectedMounts.length) {
    reject("container_mounts_invalid");
  }
  const expectedByDestination = new Map(
    expectedMounts.map((mount) => [mount.destination, mount]),
  );
  const seenTargets = new Set();
  for (const mount of mounts) {
    const input = requireRecord(mount, "container_mounts_invalid");
    if (typeof input.Destination !== "string" || seenTargets.has(input.Destination)) {
      reject("container_mounts_invalid");
    }
    const expectedMount = expectedByDestination.get(input.Destination);
    if (!expectedMount) reject("container_mounts_invalid");
    seenTargets.add(input.Destination);
    if (input.RW !== false) {
      reject("container_mount_not_read_only_secret");
    }
    if (input.Type !== "bind" && input.Type !== "secret") {
      reject("container_mount_invalid");
    }
    if (input.Source !== expectedMount.sourcePath) {
      reject("container_mount_source_mismatch");
    }
    // Docker --mount/Compose may leave Mode empty; RW is the authoritative
    // read-only flag. Still reject a contradictory nonempty mode.
    if (input.Mode !== undefined && input.Mode !== "" && input.Mode !== "ro") {
      reject("container_mount_not_read_only_secret");
    }
  }

  const networkSettings = requireRecord(
    container.NetworkSettings,
    "container_networks_invalid",
  );
  const connected = requireRecord(networkSettings.Networks, "container_networks_invalid");
  const expectedNames = expected.networks.map((network) => network.name);
  const connectedNames = Object.keys(connected);
  if (
    connectedNames.length !== expectedNames.length ||
    connectedNames.some((name) => !expectedNames.includes(name)) ||
    new Set(connectedNames).size !== connectedNames.length
  ) {
    reject("container_networks_mismatch");
  }
  const connectedIDs = [];
  let emptyNetworkIDs = 0;
  for (const binding of Object.values(connected)) {
    const item = requireRecord(binding, "container_networks_invalid");
    if (typeof item.NetworkID !== "string") {
      reject("container_networks_invalid");
    }
    if (item.NetworkID === "") {
      emptyNetworkIDs += 1;
    } else {
      if (!CONTAINER_ID_PATTERN.test(item.NetworkID)) {
        reject("container_networks_invalid");
      }
      connectedIDs.push(item.NetworkID);
    }
  }
  const expectedIDs = expected.networks.map((network) => network.id);
  if (emptyNetworkIDs > 0) {
    const mode = hostConfig.NetworkMode;
    const status = container.State?.Status;
    const canHaveEmptyIDs =
      (allowCreatedEmptyNetworkIDs && status === "created") ||
      (allowStoppedEmptyNetworkIDs && (status === "exited" || status === "dead"));
    if (
      !canHaveEmptyIDs ||
      emptyNetworkIDs !== Object.keys(connected).length ||
      typeof mode !== "string" ||
      !expectedNames.includes(mode)
    ) {
      reject("container_networks_mismatch");
    }
  } else if (
    connectedIDs.length !== expectedIDs.length ||
    connectedIDs.some((id) => !expectedIDs.includes(id)) ||
    new Set(connectedIDs).size !== connectedIDs.length
  ) {
    reject("container_networks_mismatch");
  }
  return labels;
}

function inspectCanonicalPostgres(container, id, project) {
  if (container.Id !== id) reject("canonical_postgres_identity_invalid");
  assertComposeLabels(container.Config?.Labels, project, "postgres");
  const settings = requireRecord(
    container.NetworkSettings,
    "canonical_postgres_networks_invalid",
  );
  const networks = requireRecord(settings.Networks, "canonical_postgres_networks_invalid");
  return networks;
}

async function resolveCanonicalPostgres(runner, project, composePath) {
  const stdout = await dockerSuccess(
    runner,
    composeArgs(project, composePath, "ps", "--all", "--quiet", "postgres"),
    {
      failureCode: "canonical_postgres_lookup_failed",
      timeoutCode: "canonical_postgres_lookup_timeout",
    },
  );
  const ids = parseContainerIDs(stdout, "canonical_postgres_lookup_invalid");
  if (ids.length === 0) reject("canonical_postgres_missing");
  if (ids.length !== 1) reject("canonical_postgres_ambiguous");
  const id = ids[0];
  const inspected = await dockerSuccess(
    runner,
    ["inspect", "--type", "container", id],
    {
      failureCode: "canonical_postgres_inspect_failed",
      timeoutCode: "canonical_postgres_inspect_timeout",
    },
  );
  const container = parseInspect(inspected, "canonical_postgres_inspect_invalid");
  if (!CONTAINER_ID_PATTERN.test(container.Id) || !container.Id.startsWith(id)) {
    reject("canonical_postgres_identity_invalid");
  }
  const networks = inspectCanonicalPostgres(container, container.Id, project);
  return { id: container.Id, networks };
}

async function resolveNetworks(runner, compose, generated, postgres) {
  const resolved = [];
  for (const [logicalName, definition] of Object.entries(generated.networks ?? {})) {
    if (
      !isRecord(definition) ||
      definition.external !== true ||
      typeof definition.name !== "string" ||
      definition.name.length === 0
    ) {
      reject("generated_network_invalid");
    }
    const stdout = await dockerSuccess(
      runner,
      ["network", "inspect", definition.name],
      {
        failureCode: "network_inspect_failed",
        timeoutCode: "network_inspect_timeout",
      },
    );
    const network = parseInspect(stdout, "network_inspect_invalid");
    if (
      typeof network.Id !== "string" ||
      !CONTAINER_ID_PATTERN.test(network.Id) ||
      network.Name !== definition.name ||
      network.Driver !== "bridge"
    ) {
      reject("network_identity_invalid");
    }
    const labels = requireRecord(network.Labels, "network_labels_invalid");
    if (
      labels["com.docker.compose.project"] !== compose.name ||
      labels["com.docker.compose.network"] !== logicalName
    ) {
      reject("network_labels_mismatch");
    }
    const postgresBinding = Object.values(postgres.networks).filter(
      (binding) => isRecord(binding) && binding.NetworkID === network.Id,
    );
    if (postgresBinding.length !== 1) reject("network_postgres_unbound");
    const members = requireRecord(network.Containers, "network_members_invalid");
    if (!Object.prototype.hasOwnProperty.call(members, postgres.id)) {
      reject("network_postgres_member_missing");
    }
    resolved.push({ logicalName, name: network.Name, id: network.Id });
  }
  if (resolved.length === 0) reject("network_missing");
  return resolved;
}

function secretMounts(generated) {
  const service = generated.services?.[RELEASE_CHECK_SERVICE];
  if (!isRecord(service)) reject("generated_service_missing");
  const configured = service.secrets ?? [];
  if (!Array.isArray(configured)) reject("generated_secrets_invalid");
  if (configured.length === 0) return [];
  const definitions = requireRecord(generated.secrets, "generated_secrets_invalid");
  const mounts = [];
  for (const entry of configured) {
    const source = typeof entry === "string" ? entry : entry?.source;
    const target = typeof entry === "string" ? entry : entry?.target;
    if (
      typeof source !== "string" ||
      typeof target !== "string" ||
      source.length === 0 ||
      target.length === 0
    ) {
      reject("generated_secrets_invalid");
    }
    const destination = `/run/secrets/${target}`;
    if (mounts.some((mount) => mount.destination === destination)) {
      reject("generated_secrets_invalid");
    }
    const definition = requireRecord(definitions[source], "generated_secrets_invalid");
    if (typeof definition.file !== "string") reject("generated_secrets_invalid");
    const sourcePath = assertCanonicalPath(definition.file, "generated_secret_file");
    mounts.push({ destination, sourcePath });
  }
  return mounts;
}

async function ensureNoOwnedReleaseCheck(runner, project, composePath) {
  const stdout = await dockerSuccess(
    runner,
    composeArgs(project, composePath, "ps", "--all", "--quiet", RELEASE_CHECK_SERVICE),
    {
      failureCode: "owned_compose_lookup_failed",
      timeoutCode: "owned_compose_lookup_timeout",
    },
  );
  const ids = parseContainerIDs(stdout, "owned_compose_lookup_invalid");
  if (ids.length > 1) reject("owned_compose_ambiguous");
  if (ids.length === 1) reject("owned_compose_exists");
}

async function createOwnedContainer(runner, generatedPath, project) {
  await dockerSuccess(
    runner,
    composeArgs(
      project,
      generatedPath,
      "create",
      "--pull",
      "never",
      "--no-build",
      "--no-deps",
      RELEASE_CHECK_SERVICE,
    ),
    { failureCode: "container_create_failed", timeoutCode: "container_create_timeout" },
  );
}

async function resolveCreatedID(runner, project, generatedPath) {
  const stdout = await dockerSuccess(
    runner,
    composeArgs(project, generatedPath, "ps", "--all", "--quiet", RELEASE_CHECK_SERVICE),
    {
      failureCode: "created_container_lookup_failed",
      timeoutCode: "created_container_lookup_timeout",
    },
  );
  const ids = parseContainerIDs(stdout, "created_container_lookup_invalid");
  if (ids.length === 0) reject("created_container_missing");
  if (ids.length !== 1) reject("created_container_ambiguous");
  const inspected = await dockerSuccess(
    runner,
    ["inspect", "--type", "container", ids[0]],
    {
      failureCode: "created_container_inspect_failed",
      timeoutCode: "created_container_inspect_timeout",
    },
  );
  const container = parseInspect(inspected, "created_container_inspect_invalid");
  if (!CONTAINER_ID_PATTERN.test(container.Id) || !container.Id.startsWith(ids[0])) {
    reject("created_container_identity_invalid");
  }
  return container.Id;
}

async function inspectContainer(runner, id, failureCode, timeoutCode) {
  const stdout = await dockerSuccess(
    runner,
    ["inspect", "--type", "container", id],
    { failureCode, timeoutCode },
  );
  return parseInspect(stdout, `${failureCode}_invalid`);
}

function assertCleanupIdentity(container, id, expected) {
  if (container.Id !== id) reject("cleanup_identity_unverified");
  const config = requireRecord(container.Config, "cleanup_identity_unverified");
  const labels = requireRecord(config.Labels, "cleanup_identity_unverified");
  if (
    labels[RELEASE_RUN_LABEL] !== expected.runID ||
    labels["com.docker.compose.project"] !== expected.project ||
    labels["com.docker.compose.service"] !== RELEASE_CHECK_SERVICE ||
    config.Image !== expected.image ||
    container.Image !== expected.image
  ) {
    reject("cleanup_identity_unverified");
  }
}

async function cleanupOwnedContainer(runner, id, expected) {
  if (!id) return null;
  try {
    const container = await inspectContainer(
      runner,
      id,
      "cleanup_inspect_failed",
      "cleanup_inspect_timeout",
    );
    assertCleanupIdentity(container, id, expected);
  } catch {
    return new DrainRunError("cleanup_identity_unverified");
  }
  try {
    await dockerSuccess(
      runner,
      ["rm", "--force", id],
      { failureCode: "cleanup_failed", timeoutCode: "cleanup_timeout" },
    );
  } catch {
    return new DrainRunError("cleanup_failed");
  }
  return null;
}

function assertNonNegativeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) reject(code);
}

function expectedReportBlockers(counts) {
  if (counts.schema.missingItems > 0) {
    return [{ code: "schema_incompatible", count: counts.schema.missingItems }];
  }
  return REPORT_BLOCKER_RULES.flatMap(([group, field, code]) => {
    const count = counts[group][field];
    return count > 0 ? [{ code, count }] : [];
  });
}

function validateBlockedSnapshot(snapshot) {
  const input = requireRecord(snapshot, "blocked_report_snapshot_invalid");
  requireExactKeys(
    input,
    ["ready", "readOnly", "snapshotAt", "counts", "blockers", "writers", "provider"],
    "blocked_report_snapshot_fields",
  );
  if (typeof input.ready !== "boolean" || input.readOnly !== true) {
    reject("blocked_report_snapshot_not_read_only");
  }
  if (
    typeof input.snapshotAt !== "string" ||
    input.snapshotAt.length > 128 ||
    !/^\d{4}-\d{2}-\d{2}T[^\u0000-\u001f\u007f]+$/u.test(input.snapshotAt) ||
    !Number.isFinite(Date.parse(input.snapshotAt))
  ) {
    reject("blocked_report_snapshot_time_invalid");
  }
  const counts = requireRecord(input.counts, "blocked_report_counts_invalid");
  requireExactKeys(counts, Object.keys(REPORT_COUNT_FIELDS), "blocked_report_count_fields");
  for (const [group, fields] of Object.entries(REPORT_COUNT_FIELDS)) {
    const section = requireRecord(counts[group], "blocked_report_count_group_invalid");
    requireExactKeys(section, fields, "blocked_report_count_fields");
    for (const field of fields) {
      assertNonNegativeInteger(section[field], "blocked_report_count_value_invalid");
    }
  }
  if (!Array.isArray(input.blockers)) reject("blocked_report_blockers_invalid");
  for (const blocker of input.blockers) {
    const item = requireRecord(blocker, "blocked_report_blockers_invalid");
    requireExactKeys(item, ["code", "count"], "blocked_report_blocker_fields");
    if (!BLOCKER_CODES.has(item.code)) reject("blocked_report_blocker_code_invalid");
    if (!Number.isSafeInteger(item.count) || item.count <= 0) {
      reject("blocked_report_blocker_count_invalid");
    }
  }
  const expected = expectedReportBlockers(counts);
  if (
    input.blockers.length !== expected.length ||
    input.blockers.some(
      (blocker, index) =>
        blocker.code !== expected[index].code || blocker.count !== expected[index].count,
    )
  ) {
    reject("blocked_report_blockers_mismatch");
  }
  if (input.ready !== (expected.length === 0)) {
    reject("blocked_report_ready_blocker_mismatch");
  }
  const writers = requireRecord(input.writers, "blocked_report_writers_invalid");
  requireExactKeys(writers, ["status", "reasonCode"], "blocked_report_writers_fields");
  if (writers.status !== "not_proven") reject("blocked_report_writers_invalid");
  assertSafeText(writers.reasonCode, "blocked_report_writer_reason_invalid");
  const provider = requireRecord(input.provider, "blocked_report_provider_invalid");
  requireExactKeys(provider, ["status", "reasonCode"], "blocked_report_provider_fields");
  if (provider.status !== "not_checked") reject("blocked_report_provider_invalid");
  assertSafeText(provider.reasonCode, "blocked_report_provider_reason_invalid");
  return input;
}

function validateBlockedReport(value, expectedStorageDriver) {
  const report = requireRecord(value, "blocked_report_invalid");
  const hasErrorCode = Object.prototype.hasOwnProperty.call(report, "errorCode");
  requireExactKeys(
    report,
    hasErrorCode
      ? ["schema", "status", "scope", "errorCode", "snapshot", "provider"]
      : ["schema", "status", "scope", "snapshot", "provider"],
    "blocked_report_fields",
  );
  if (
    report.schema !== "duallane.release-check/v1" ||
    report.status !== "blocked" ||
    report.scope !== "database_and_provider_snapshot"
  ) {
    reject("blocked_report_invalid");
  }
  if (hasErrorCode && report.errorCode !== "provider_not_quiescent") {
    reject("blocked_report_error_invalid");
  }
  const snapshot = validateBlockedSnapshot(report.snapshot);
  const provider = requireRecord(report.provider, "blocked_report_provider_invalid");
  requireExactKeys(provider, ["driver", "status", "code", "readOnly"], "blocked_report_provider_fields");
  if (provider.readOnly !== true) reject("blocked_report_provider_invalid");

  if (hasErrorCode) {
    if (
      expectedStorageDriver !== "s3" ||
      snapshot.ready !== true ||
      snapshot.blockers.length !== 0 ||
      provider.driver !== "s3" ||
      provider.status !== "blocked" ||
      provider.code !== "storage.multipart_not_quiescent"
    ) {
      reject("blocked_report_provider_invalid");
    }
  } else if (
    snapshot.ready !== false ||
    snapshot.blockers.length === 0 ||
    provider.driver !== "unknown" ||
    provider.status !== "not_checked" ||
    provider.code !== "database_not_ready"
  ) {
    reject("blocked_report_database_invalid");
  }
  return value;
}

async function readCheckerReport(runner, id) {
  const stdout = await dockerSuccess(
    runner,
    ["logs", id],
    { failureCode: "checker_logs_failed", timeoutCode: "checker_logs_timeout" },
  );
  if (stdout.trim() === "") reject("checker_report_missing");
  return parseJSONOutput(stdout.trim(), "checker_report_invalid");
}

function parseExitStatus(stdout) {
  const value = stdout.trim();
  if (!/^(?:0|[1-9][0-9]{0,2})$/u.test(value)) reject("checker_exit_invalid");
  const status = Number(value);
  if (!Number.isSafeInteger(status) || status > 255) reject("checker_exit_invalid");
  return status;
}

async function executeDrainCheck({
  runner,
  compose,
  composePath,
  generated,
  generatedPath,
  reportPath,
  workspaceImage,
  runID,
}) {
  const project = compose.name;
  const service = generated.services[RELEASE_CHECK_SERVICE];
  const expectedStorageDriver = service.environment?.WORKSPACE_STORAGE_DRIVER;
  if (expectedStorageDriver !== "local" && expectedStorageDriver !== "s3") {
    reject("storage_driver_invalid");
  }
  const expected = {
    project,
    service: RELEASE_CHECK_SERVICE,
    runID,
    image: workspaceImage,
    identityCode: "container_identity_invalid",
    environment: service.environment,
    secretMounts: secretMounts(generated),
    networks: [],
  };
  let ownedID;
  let result;
  let failure;
  try {
    await inspectImage(runner, workspaceImage);
    await writePrivateJSON(generatedPath, generated);

    const postgres = await resolveCanonicalPostgres(runner, project, composePath);
    expected.networks = await resolveNetworks(runner, compose, generated, postgres);
    await ensureNoOwnedReleaseCheck(runner, project, generatedPath);
    await createOwnedContainer(runner, generatedPath, project);
    ownedID = await resolveCreatedID(runner, project, generatedPath);
    expected.id = ownedID;
    const created = await inspectContainer(
      runner,
      ownedID,
      "container_inspect_failed",
      "container_inspect_timeout",
    );
    if (created.State?.Running !== false || created.State?.Status !== "created") {
      reject("container_already_started");
    }
    assertContainerIdentity(created, expected, { allowCreatedEmptyNetworkIDs: true });

    await dockerSuccess(runner, ["start", ownedID], {
      failureCode: "container_start_failed",
      timeoutCode: "container_start_timeout",
    });
    const started = await inspectContainer(
      runner,
      ownedID,
      "container_post_start_inspect_failed",
      "container_post_start_inspect_timeout",
    );
    assertContainerIdentity(started, expected, { allowStoppedEmptyNetworkIDs: true });
    const waitOutput = await dockerSuccess(runner, ["wait", ownedID], {
      timeoutMs: DOCKER_WAIT_TIMEOUT_MS,
      failureCode: "checker_wait_failed",
      timeoutCode: "checker_wait_timeout",
    });
    const exitStatus = parseExitStatus(waitOutput);
    if (exitStatus === 0) {
      const report = await readCheckerReport(runner, ownedID);
      try {
        validateReport(report, expectedStorageDriver);
      } catch {
        reject("checker_report_invalid");
      }
      await writePrivateJSON(reportPath, report);
      result = { status: "ready", exitCode: 0, reportWritten: true };
    } else if (exitStatus === 2) {
      const report = await readCheckerReport(runner, ownedID);
      try {
        validateBlockedReport(report, expectedStorageDriver);
      } catch {
        reject("checker_blocked_report_invalid");
      }
      await writePrivateJSON(reportPath, report);
      result = { status: "blocked", exitCode: 2, reportWritten: true };
    } else {
      reject("checker_failed");
    }
  } catch (error) {
    failure = normalizeFailure(error);
  }

  const cleanupFailure = await cleanupOwnedContainer(runner, ownedID, expected);
  if (cleanupFailure) throw cleanupFailure;
  if (failure) throw failure;
  return result;
}

async function runDrainCheck(options = {}) {
  let runner;
  try {
    assertSupportedPlatform();
    const composePath = options.composePath ?? options.compose;
    const generatedPath = options.outputPath ?? options.output;
    const reportPath = options.reportPath ?? options.report;
    const workspaceImage = options.workspaceImage ?? options["workspace-image"];
    const runID = options.runID ?? options.runId ?? options["run-id"];
    if (!composePath || !generatedPath || !reportPath) reject("missing_path");
    assertCanonicalPath(composePath, "compose_path");
    assertCanonicalPath(generatedPath, "output_path");
    assertCanonicalPath(reportPath, "report_path");
    if (generatedPath === reportPath || generatedPath === composePath || reportPath === composePath) {
      reject("private_path_collision");
    }
    assertImageID(workspaceImage);
    assertRunID(runID);
    await assertPrivateDestination(generatedPath, "output");
    await assertPrivateDestination(reportPath, "report");
    const compose = await readPrivateJSON(composePath, "compose");
    const generated = buildDrainCompose({ compose, workspaceImage });
    generated.services[RELEASE_CHECK_SERVICE].labels = {
      [RELEASE_RUN_LABEL]: runID,
    };
    runner = getRunner(options.dockerRunner);
    return await executeDrainCheck({
      runner,
      compose,
      composePath,
      generated,
      generatedPath,
      reportPath,
      workspaceImage,
      runID,
    });
  } catch (error) {
    throw normalizeFailure(error);
  }
}

function parseCLI(argv) {
  const command = argv[0] ?? "help";
  if (command === "help" || command === "--help" || command === "-h") {
    return { command: "help" };
  }
  if (command !== "run") reject("invalid_command");
  const options = { command };
  const allowed = new Set([
    "--compose",
    "--workspace-image",
    "--output",
    "--report",
    "--run-id",
  ]);
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!allowed.has(argument)) reject("invalid_argument");
    const key = argument.slice(2).replaceAll("-", "_");
    if (options[key] !== undefined) reject("duplicate_argument");
    const value = argv[++index];
    if (!value) reject("missing_argument_value");
    options[key] = value;
  }
  if (
    !options.compose ||
    !options.workspace_image ||
    !options.output ||
    !options.report ||
    !options.run_id
  ) {
    reject("missing_argument");
  }
  assertCanonicalPath(options.compose, "compose_path");
  assertCanonicalPath(options.output, "output_path");
  assertCanonicalPath(options.report, "report_path");
  assertImageID(options.workspace_image);
  assertRunID(options.run_id);
  return options;
}

function helpText() {
  return [
    "Usage:",
    "  release-drain-run.mjs run --compose <private-canonical-go-compose.json> --workspace-image <sha256:64-lowercase-hex> --output <private-generated-compose.json> --report <private-report.json> --run-id <64-lowercase-hex>",
    "",
    "Creates, runs, observes, and removes one read-only release-check container.",
    "It never starts business services, creates networks, changes PostgreSQL, or mutates object storage.",
  ].join("\n");
}

async function runCLI(argv) {
  const options = parseCLI(argv);
  if (options.command === "help") {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  const result = await runDrainCheck({
    compose: options.compose,
    workspaceImage: options.workspace_image,
    output: options.output,
    report: options.report,
    runId: options.run_id,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.exitCode !== 0) process.exitCode = result.exitCode;
}

export {
  DrainRunError,
  DOCKER_COMMAND_TIMEOUT_MS,
  DOCKER_WAIT_TIMEOUT_MS,
  MAX_DOCKER_OUTPUT_BYTES,
  RELEASE_RUN_LABEL,
  createDockerRunner,
  runDrainCheck,
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    await runCLI(process.argv.slice(2));
  } catch (error) {
    const code = error instanceof DrainRunError ? error.code : "operation_failed";
    process.stderr.write(`release drain run rejected: ${code}\n`);
    process.exitCode = 1;
  }
}
