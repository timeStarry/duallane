#!/usr/bin/env node

// Recovery for lost operator files, not a first install or a deployment. Every
// Docker operation below is inspection, Compose parsing, or a fixed read probe.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { captureComposeSnapshot, readSnapshot, writeSnapshot, writeRecoverableCompose } from "./release-compose-snapshot.mjs";
import { captureExternalFiles, verifyExternalFiles, GO_RECOVERY_SERVICES } from "./release-external-files.mjs";
import { captureVolumeAuthority, verifyVolumeAuthority } from "./release-volume-authority.mjs";
import { validateResolvedCompose, profiles } from "./release-manifest.mjs";
import { run as gatewaySmoke } from "../../scripts/backend/gateway-readonly-smoke.mjs";
import { resolveLocalGatewayURL } from "../../scripts/backend/local-gateway-binding.mjs";

const OWNERS = ["p2p", "workspace", "worker", "web"];
const REQUIRED = [...OWNERS, "postgres"];
const SOURCE_FILES = ["docker-compose.yml", "docker-compose.production.yml", "docker-compose.go-production.yml"];
const SHA = /^[0-9a-f]{40}$/;
const ID = /^[0-9a-f]{64}$/;
const IMAGE = /^sha256:[0-9a-f]{64}$/;
const FORMAT = "duallane.adopted-running-go";
const MAX_BYTES = 8 * 1024 * 1024;
const MIGRATIONS = "apps/web/server/migrations";
const SQL_PROBE = 'exec psql -X -qAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "BEGIN READ ONLY; SELECT name FROM schema_migrations ORDER BY name; COMMIT;"';
const IMAGE_PROBE = "set -eu; test -x /usr/local/bin/duallane-migrate; test ! -L /app/migrations; cd /app/migrations; sha256sum -- *.sql";
const MASKED_PATHS = ["/proc/acpi", "/proc/asound", "/proc/interrupts", "/proc/kcore", "/proc/keys", "/proc/latency_stats", "/proc/sched_debug", "/proc/scsi", "/proc/timer_list", "/proc/timer_stats", "/sys/devices/virtual/powercap", "/sys/firmware"];
const READONLY_PATHS = ["/proc/bus", "/proc/fs", "/proc/irq", "/proc/sys", "/proc/sysrq-trigger"];

export class AdoptionError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function reject(code) { throw new AdoptionError(code); }
function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
function equal(a, b) { return JSON.stringify(stable(a)) === JSON.stringify(stable(b)); }
function parseJSON(value) { try { return JSON.parse(value); } catch { reject("invalid_command_json"); } }
function literal(value) { return typeof value === "string" ? value.replaceAll("$$", "$") : value; }
function literals(value) {
  if (Array.isArray(value)) return value.map(literals);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, literals(v)]));
  return literal(value);
}
export function containerEnvironment(container) {
  const result = {};
  if (!Array.isArray(container?.Config?.Env)) reject("container_environment_missing");
  for (const item of container.Config.Env) {
    const index = item.indexOf("=");
    const key = item.slice(0, index);
    if (index < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || Object.hasOwn(result, key)) reject("container_environment_invalid");
    result[key] = item.slice(index + 1);
  }
  return result;
}

export function validateObservedContainers(containers, { project, expectedPreviousCommit }) {
  if (!SHA.test(expectedPreviousCommit) || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project)) reject("invalid_identity_input");
  const result = {};
  for (const container of containers) {
    const labels = container?.Config?.Labels ?? {};
    if (labels["com.docker.compose.project"] !== project || !ID.test(container.Id ?? "") || !IMAGE.test(container.Image ?? "")) reject("container_identity_invalid");
    const service = labels["com.docker.compose.service"];
    if (service === "api" && container.State?.Running) reject("mixed_node_owner");
    if (service === "migrate" && container.State?.Running) reject("active_migration");
    if (![...REQUIRED, "v2ray"].includes(service)) {
      if (container.State?.Running) reject("unsupported_running_service");
      continue;
    }
    if (result[service]) reject("duplicate_service_owner");
    if (!container.State?.Running || container.State?.Paused || container.State?.Restarting) reject("owner_not_running");
    if (service !== "v2ray" && container.State?.Health?.Status !== "healthy") reject("owner_not_healthy");
    if (OWNERS.includes(service)) {
      if (labels["org.opencontainers.image.revision"] !== expectedPreviousCommit || !/^\d+\.\d+\.\d+$/.test(labels["org.opencontainers.image.version"] ?? "")) reject("owner_release_mismatch");
    }
    result[service] = container;
  }
  if (REQUIRED.some(name => !result[name])) reject("missing_service_owner");
  const versions = new Set(OWNERS.map(name => result[name].Config.Labels["org.opencontainers.image.version"]));
  if (versions.size !== 1 || result.workspace.Image !== result.worker.Image) reject("owner_release_mismatch");
  return result;
}

function oneMount(container, target, type) {
  const matches = container.Mounts?.filter(m => m.Destination === target && m.Type === type) ?? [];
  if (matches.length !== 1) reject("required_mount_missing");
  return matches[0];
}
export function recoverEnvironment(observed, projectDir, templateText) {
  const p2p = containerEnvironment(observed.p2p);
  const workspace = containerEnvironment(observed.workspace);
  const worker = containerEnvironment(observed.worker);
  const postgres = containerEnvironment(observed.postgres);
  // Only variables actually referenced by the known Git templates can enter
  // the reconstructed env file. Service-specific aliases are explicit below.
  const variableNames = new Set([...templateText.matchAll(/\$\{([A-Z][A-Z0-9_]*)[}:?-]/g)].map(m => m[1]));
  const values = {};
  for (const key of variableNames) {
    if (Object.hasOwn(workspace, key)) values[key] = workspace[key];
    else if (Object.hasOwn(p2p, key)) values[key] = p2p[key];
    else if (Object.hasOwn(postgres, key)) values[key] = postgres[key];
  }
  for (const key of ["WORKSPACE_EMAIL_WORKER_ENABLED", "WORKSPACE_NTFY_WORKER_ENABLED", "WORKSPACE_MAINTENANCE_WORKER_ENABLED", "WORKSPACE_ECHO_WORKER_ENABLED"]) values[key] = worker[key];
  values.WORKSPACE_WORKER_DATABASE_POOL_MAX = worker.DATABASE_POOL_MAX;
  values.DATABASE_POOL_MAX = workspace.DATABASE_POOL_MAX;
  values.POSTGRES_DB = postgres.POSTGRES_DB;
  values.POSTGRES_USER = postgres.POSTGRES_USER;
  values.POSTGRES_PASSWORD = postgres.POSTGRES_PASSWORD;
  values.POSTGRES_VOLUME_NAME = oneMount(observed.postgres, "/var/lib/postgresql/data", "volume").Name;
  values.POSTGRES_IMAGE = observed.postgres.Image;
  const secret = oneMount(observed.workspace, "/run/secrets/workspace-s3", "bind");
  if (secret.RW || !path.posix.isAbsolute(secret.Source)) reject("secret_mount_invalid");
  values.WORKSPACE_S3_CREDENTIALS_FILE = secret.Source;
  const ports = observed.web.HostConfig?.PortBindings;
  if (!ports || Object.keys(ports).length !== 1 || ports["8080/tcp"]?.length !== 1) reject("web_binding_unsupported");
  values.DUALLANE_WEB_BIND = ports["8080/tcp"][0].HostIp;
  values.DUALLANE_WEB_PORT = ports["8080/tcp"][0].HostPort;
  values.DUALLANE_PRODUCTION_DIR = projectDir;
  values.COMPOSE_PROFILES = observed.v2ray ? "github-proxy" : "";
  if (observed.v2ray) values.V2RAY_IMAGE = observed.v2ray.Image;
  const logging = observed.web.HostConfig?.LogConfig;
  if (logging?.Type !== "json-file") reject("logging_unsupported");
  values.DUALLANE_LOG_MAX_SIZE = logging.Config?.["max-size"];
  values.DUALLANE_LOG_MAX_FILE = logging.Config?.["max-file"];
  if (Object.values(values).some(v => typeof v !== "string")) reject("required_environment_unobserved");
  return values;
}

export function serializeEnvironment(values) {
  return Object.keys(values).sort().map(key => {
    const value = values[key];
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== "string" || value.includes("\0") || value.includes("\r")) reject("environment_not_serializable");
    // Unquoted operational values remain compatible with deploy.sh's bounded
    // read_env_value. Single quotes suppress Compose's dollar interpolation.
    const encoded = /^[A-Za-z0-9_./:@,+-]*$/.test(value) ? value : `'${value.replaceAll("'", "\\'")}'`;
    return `${key}=${encoded}`;
  }).join("\n") + "\n";
}

function ns(value) {
  if (value === undefined) return undefined;
  if (typeof value === "number") return value;
  const match = /^(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)$/.exec(value);
  if (!match) reject("health_duration_unsupported");
  return Number(match[1]) * ({ ns: 1, us: 1e3, "µs": 1e3, ms: 1e6, s: 1e9, m: 6e10, h: 36e11 })[match[2]];
}

function rejectUnsupportedHostConfig(container) {
  const host = container.HostConfig ?? {};
  for (const key of ["Privileged", "PublishAllPorts", "AutoRemove", "ReadonlyPathsDisabled", "Init", "OomKillDisable"]) if (host[key]) reject("unsupported_host_config");
  for (const key of ["CapAdd", "CapDrop", "Devices", "DeviceRequests", "DeviceCgroupRules", "SecurityOpt", "GroupAdd", "ExtraHosts", "Dns", "DnsOptions", "DnsSearch", "Links", "VolumesFrom", "Ulimits", "BlkioWeightDevice", "BlkioDeviceReadBps", "BlkioDeviceWriteBps", "BlkioDeviceReadIOps", "BlkioDeviceWriteIOps", "StorageOpt", "Sysctls"]) {
    if (host[key] && Object.keys(host[key]).length) reject("unsupported_host_config");
  }
  for (const key of ["Memory", "MemoryReservation", "MemorySwap", "MemorySwappiness", "NanoCpus", "CpuShares", "CpuPeriod", "CpuQuota", "CpuRealtimePeriod", "CpuRealtimeRuntime", "BlkioWeight", "PidsLimit", "OomScoreAdj", "CpuCount", "CpuPercent", "IOMaximumIOps", "IOMaximumBandwidth"]) {
    if (host[key] !== undefined && host[key] !== null && host[key] !== 0) reject("unsupported_host_config");
  }
  for (const key of ["CpusetCpus", "CpusetMems", "PidMode", "UTSMode", "UsernsMode", "CgroupParent", "Runtime"]) {
    if (host[key] && !(key === "Runtime" && host[key] === "runc")) reject("unsupported_host_config");
  }
  if (host.IpcMode && host.IpcMode !== "private" || host.Isolation && host.Isolation !== "default") reject("unsupported_host_config");
  if (!equal([...(host.MaskedPaths ?? [])].sort(), MASKED_PATHS) || !equal([...(host.ReadonlyPaths ?? [])].sort(), READONLY_PATHS)) reject("unsupported_system_paths");
  if (container.Config?.Tty || container.Config?.OpenStdin || container.Config?.StdinOnce || container.Config?.Domainname) reject("unsupported_container_config");
}

function expectedMounts(compose, service) {
  const mounts = (service.volumes ?? []).map(m => {
    if (m.type !== "volume") reject("unsupported_template_mount");
    return { type: "volume", source: compose.volumes?.[m.source]?.name, target: m.target, rw: !m.read_only, propagation: "" };
  });
  for (const secret of service.secrets ?? []) {
    const source = typeof secret === "string" ? secret : secret.source;
    const target = typeof secret === "string" ? source : secret.target ?? source;
    mounts.push({ type: "bind", source: compose.secrets?.[source]?.file, target: target.startsWith("/") ? target : `/run/secrets/${target}`, rw: false, propagation: "rprivate" });
  }
  return mounts.sort((a, b) => a.target.localeCompare(b.target));
}

export function verifyRuntimeAgainstCompose(compose, observed, images) {
  for (const [name, container] of Object.entries(observed)) {
    rejectUnsupportedHostConfig(container);
    const service = literals(compose.services?.[name]);
    const image = images[container.Image];
    if (!service || !image || image.Id !== container.Image || service.image !== container.Image) reject("runtime_image_mismatch");
    const base = image.Config ?? {};
    const actual = container.Config;
    const expectedEnv = { ...containerEnvironment({ Config: { Env: base.Env ?? [] } }), ...(service.environment ?? {}) };
    for (const key of Object.keys(expectedEnv)) expectedEnv[key] = String(expectedEnv[key]);
    if (!equal(expectedEnv, containerEnvironment(container))) reject(`runtime_environment_mismatch_${name}`);
    const entrypoint = service.entrypoint ?? base.Entrypoint ?? null;
    const command = service.command ?? (service.entrypoint === undefined ? base.Cmd ?? null : null);
    if (!equal(entrypoint, actual.Entrypoint ?? null) || !equal(command?.length ? command : null, actual.Cmd?.length ? actual.Cmd : null)) reject("runtime_command_mismatch");
    if ((service.user ?? base.User ?? "") !== (actual.User ?? "") || (service.working_dir ?? base.WorkingDir ?? "") !== (actual.WorkingDir ?? "")) reject("runtime_identity_mismatch");
    if ((service.hostname ?? container.Id.slice(0, 12)) !== actual.Hostname) reject("runtime_hostname_mismatch");
    if ((service.stop_signal ?? base.StopSignal ?? "") !== (actual.StopSignal ?? "")) reject("runtime_stop_signal_mismatch");
    const stopTimeout = service.stop_grace_period === undefined ? base.StopTimeout ?? 10 : ns(service.stop_grace_period) / 1e9;
    if (stopTimeout !== (actual.StopTimeout ?? 10)) reject("runtime_stop_timeout_mismatch");
    if ((service.shm_size ?? 67108864) !== container.HostConfig.ShmSize) reject("runtime_shm_size_mismatch");
    if ((service.read_only ?? false) !== container.HostConfig.ReadonlyRootfs) reject("runtime_readonly_mismatch");
    const tmpfs = Object.fromEntries((service.tmpfs ?? []).map(entry => { const i = entry.indexOf(":"); return i < 0 ? [entry, ""] : [entry.slice(0, i), entry.slice(i + 1)]; }));
    if (!equal(tmpfs, container.HostConfig.Tmpfs ?? {})) reject("runtime_tmpfs_mismatch");
    const restart = { Name: service.restart ?? "no", MaximumRetryCount: 0 };
    if (!equal(restart, container.HostConfig.RestartPolicy)) reject("runtime_restart_mismatch");
    if (!equal({ Type: service.logging?.driver ?? "json-file", Config: service.logging?.options ?? {} }, container.HostConfig.LogConfig)) reject("runtime_logging_mismatch");
    const expectedHealth = { ...(base.Healthcheck ?? {}) };
    for (const [key, target] of Object.entries({ test: "Test", interval: "Interval", timeout: "Timeout", retries: "Retries", start_period: "StartPeriod", start_interval: "StartInterval" })) {
      if (service.healthcheck?.[key] !== undefined) expectedHealth[target] = key === "test" || key === "retries" ? service.healthcheck[key] : ns(service.healthcheck[key]);
    }
    const actualHealth = { ...(actual.Healthcheck ?? {}) };
    for (const value of [expectedHealth, actualHealth]) for (const key of Object.keys(value)) if (value[key] === 0) delete value[key];
    if (!equal(expectedHealth, actualHealth)) reject("runtime_healthcheck_mismatch");
    const expectedLabels = { ...(base.Labels ?? {}), ...(service.labels ?? {}) };
    const actualLabels = Object.fromEntries(Object.entries(actual.Labels ?? {}).filter(([key]) => !key.startsWith("com.docker.compose.")));
    if (!equal(expectedLabels, actualLabels)) reject("runtime_labels_mismatch");
    const mounts = container.Mounts.map(m => ({ type: m.Type, source: m.Type === "volume" ? m.Name : m.Source, target: m.Destination, rw: m.RW, propagation: m.Propagation ?? "" })).sort((a, b) => a.target.localeCompare(b.target));
    if (!equal(expectedMounts(compose, service), mounts)) reject("runtime_mounts_mismatch");
    const bindings = {};
    for (const port of service.ports ?? []) {
      const key = `${port.target}/${port.protocol ?? "tcp"}`;
      (bindings[key] ??= []).push({ HostIp: port.host_ip ?? "", HostPort: String(port.published) });
    }
    if (!equal(bindings, container.HostConfig.PortBindings ?? {})) reject("runtime_ports_mismatch");
    const networks = service.networks ?? { default: null };
    const expectedNames = Object.keys(networks).map(key => compose.networks?.[key]?.name ?? `${compose.name}_${key}`).sort();
    if (!equal(expectedNames, Object.keys(container.NetworkSettings?.Networks ?? {}).sort())) reject("runtime_networks_mismatch");
    for (const [key, config] of Object.entries(networks)) {
      const network = container.NetworkSettings.Networks[compose.networks?.[key]?.name ?? `${compose.name}_${key}`];
      const expectedAliases = [...new Set([container.Name.replace(/^\//, ""), name, ...(config?.aliases ?? [])])].sort();
      if (!equal(expectedAliases, [...new Set(network.Aliases ?? [])].sort()) || network.IPAMConfig) reject("runtime_network_aliases_mismatch");
    }
  }
  return true;
}

export function observationFingerprint(observed, images) {
  return digest(JSON.stringify(stable({ images, containers: Object.fromEntries(Object.entries(observed).map(([name, c]) => [name, {
    Id: c.Id, Image: c.Image, Config: c.Config, HostConfig: c.HostConfig, Mounts: c.Mounts,
    networks: c.NetworkSettings?.Networks, StartedAt: c.State.StartedAt, RestartCount: c.RestartCount,
    status: c.State.Status, running: c.State.Running, health: c.State.Health?.Status,
  }])) })));
}

function commandRunner(executable, args, options = {}) {
  const result = spawnSync(executable, args, { encoding: "utf8", timeout: 30_000, maxBuffer: MAX_BYTES, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, ...options });
  if (result.status !== 0 || result.error) reject("readonly_command_failed");
  return result.stdout;
}
async function canonicalPath(value, { existing = true } = {}) {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.resolve(value) !== value || /[\x00-\x1f]/.test(value)) reject("path_invalid");
  const target = existing ? value : path.dirname(value);
  if (await realpath(target) !== target) reject("symlinked_path");
  return value;
}
async function ensurePrivateDirectory(value, root) {
  if (value !== root && !value.startsWith(root + path.sep)) reject("output_outside_production_backups");
  try {
    const info = await lstat(value);
    if (!info.isDirectory() || info.isSymbolicLink()) reject("unsafe_backup_directory");
    if (await realpath(value) !== value) reject("symlinked_path");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await ensurePrivateDirectory(path.dirname(value), root);
    await mkdir(value, { mode: 0o700 });
  }
}
async function privateWrite(file, value) { await writeFile(file, value, { flag: "wx", mode: 0o600 }); }
async function privateRead(file) {
  await canonicalPath(file);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600 || info.size > MAX_BYTES) reject("private_file_invalid");
  return readFile(file);
}

export async function verifyAdoptionEvidence(snapshotPath) {
  const snapshot = await readSnapshot(snapshotPath);
  if (snapshot.compose["x-duallane-recovery-source"] !== "observed-running-go") reject("adoption_marker_missing");
  const evidence = parseJSON(await privateRead(`${snapshotPath}.adoption.json`));
  if (evidence.format !== FORMAT || evidence.version !== 1 || evidence.source !== "observed-running-go" || evidence.historicalReleaseEvidence !== "unavailable" || evidence.commit !== snapshot.commit || evidence.semver !== snapshot.semver || evidence.project !== snapshot.project || !equal(evidence.imageIDs, snapshot.imageIDs)) reject("adoption_evidence_invalid");
  const suffixes = ["", ".compose.json", ".external.json", ".volumes.json"];
  if (!equal(Object.keys(evidence.artifactSHA256 ?? {}).sort(), suffixes.sort())) reject("adoption_evidence_invalid");
  for (const suffix of suffixes) if (digest(await privateRead(snapshotPath + suffix)) !== evidence.artifactSHA256[suffix]) reject("adoption_artifact_changed");
  return { format: FORMAT, status: "PASS", commit: snapshot.commit, semver: snapshot.semver };
}

export async function adoptRunning({ projectDir, expectedPreviousCommit, outputDir, project = "duallane" }, dependencies = {}) {
  if (process.platform !== "linux") reject("linux_required");
  await canonicalPath(projectDir);
  if (typeof outputDir !== "string" || path.resolve(outputDir) !== outputDir || !outputDir.startsWith(path.join(projectDir, "backups", "production") + path.sep)) reject("output_outside_production_backups");
  if (!SHA.test(expectedPreviousCommit) || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project)) reject("invalid_identity_input");
  const envDestination = path.join(projectDir, ".env");
  try { await lstat(envDestination); reject("environment_already_exists"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const run = dependencies.commandRunner ?? commandRunner;
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|HOME|LANG|LC_.*|TZ|DOCKER_CONFIG)$/.test(key)));
  cleanEnv.COMPOSE_DISABLE_ENV_FILE = "1";
  const endpoint = run("docker", ["context", "inspect", "default", "--format", '{{(index .Endpoints "docker").Host}}'], { cwd: projectDir, env: cleanEnv }).trim();
  if (!/^unix:\/\/\//.test(endpoint) || /[\x00-\x20]/.test(endpoint)) reject("local_docker_required");
  if (dependencies.verifyLocalSocket) await dependencies.verifyLocalSocket(endpoint.slice(7));
  else if (!(await lstat(await realpath(endpoint.slice(7)))).isSocket()) reject("local_docker_required");
  const docker = args => run("docker", ["--host", endpoint, ...args], { cwd: projectDir, env: cleanEnv });
  const git = args => run("git", ["-C", projectDir, ...args], { cwd: projectDir });
  const inspect = () => {
    const ids = docker(["ps", "-aq", "--no-trunc", "--filter", `label=com.docker.compose.project=${project}`]).trim().split(/\s+/).filter(Boolean);
    if (!ids.length || ids.some(id => !ID.test(id)) || ids.length > 20) reject("project_container_set_invalid");
    return validateObservedContainers(parseJSON(docker(["inspect", ...ids])), { project, expectedPreviousCommit });
  };
  const observed = inspect();
  const images = {};
  for (const imageID of new Set(Object.values(observed).map(c => c.Image))) {
    const entries = parseJSON(docker(["image", "inspect", imageID]));
    if (entries.length !== 1 || entries[0].Id !== imageID) reject("image_identity_invalid");
    images[imageID] = entries[0];
  }
  for (const name of OWNERS) {
    const labels = images[observed[name].Image].Config?.Labels ?? {};
    if (labels["org.opencontainers.image.revision"] !== expectedPreviousCommit || labels["org.opencontainers.image.version"] !== observed[name].Config.Labels["org.opencontainers.image.version"]) reject("image_release_mismatch");
  }
  const firstFingerprint = observationFingerprint(observed, images);
  const sources = Object.fromEntries(SOURCE_FILES.map(file => [file, git(["show", `${expectedPreviousCommit}:${file}`])]));
  const values = recoverEnvironment(observed, projectDir, Object.values(sources).join("\n"));
  const envText = serializeEnvironment(values);
  const semver = observed.workspace.Config.Labels["org.opencontainers.image.version"];
  const sourceVersion = parseJSON(git(["show", `${expectedPreviousCommit}:package.json`])).version;
  if (sourceVersion !== semver) reject("source_version_mismatch");
  await ensurePrivateDirectory(path.dirname(outputDir), projectDir);
  await canonicalPath(outputDir, { existing: false });
  await mkdir(outputDir, { mode: 0o700 });
  const sourceDir = path.join(outputDir, "source");
  await mkdir(sourceDir, { mode: 0o700 });
  for (const [name, text] of Object.entries(sources)) await privateWrite(path.join(sourceDir, name), text);
  const envInput = path.join(outputDir, "reconstructed.env");
  await privateWrite(envInput, envText);
  // Compose resolves extends relative to project-directory. Use the extracted
  // source directory so a newer checkout cannot silently replace the old
  // template; all supported runtime binds are verified absolute secret paths.
  const composeArgs = ["compose", "--project-name", project, "--project-directory", sourceDir, "--env-file", envInput, ...SOURCE_FILES.flatMap(name => ["-f", path.join(sourceDir, name)])];
  const resolved = parseJSON(docker([...composeArgs, "config", "--format", "json"]));
  validateResolvedCompose(profiles["go-full"], resolved);
  for (const [name, c] of Object.entries(observed)) {
    const service = resolved.services[name];
    if (!service) reject("template_service_missing");
    service.image = c.Image;
    // The original coordinator supplied this run identity in a generated
    // override, not the Git template. Preserve the exact observed label.
    const runLabel = c.Config.Labels["com.duallane.release-run"];
    if (runLabel !== undefined) {
      if (!ID.test(runLabel)) reject("release_run_label_invalid");
      service.labels = { ...service.labels, "com.duallane.release-run": runLabel };
    }
    delete service.build;
  }
  resolved.services.migrate.image = observed.workspace.Image;
  delete resolved.services.migrate.build;
  resolved["x-duallane-recovery-source"] = "observed-running-go";
  const composeInput = path.join(outputDir, "observed.compose.json");
  await privateWrite(composeInput, JSON.stringify(resolved));
  const profileArgs = observed.v2ray ? ["--profile", "github-proxy"] : [];
  const roundtrip = parseJSON(docker(["compose", "--project-name", project, "--env-file", "/dev/null", ...profileArgs, "-f", composeInput, "config", "--format", "json"]));
  if (!equal(roundtrip, resolved)) reject("compose_roundtrip_changed");
  verifyRuntimeAgainstCompose(roundtrip, observed, images);
  const databaseNames = docker(["exec", observed.postgres.Id, "sh", "-c", SQL_PROBE]).trim().split("\n").filter(Boolean);
  const imageLines = docker(["exec", observed.workspace.Id, "sh", "-c", IMAGE_PROBE]).trim().split("\n");
  const imageMigrations = Object.fromEntries(imageLines.map(line => {
    const m = /^([0-9a-f]{64})  (\d{3}_[a-z0-9_]+\.sql)$/.exec(line);
    if (!m) reject("image_migrations_invalid");
    return [m[2], m[1]];
  }));
  const sourceNames = git(["ls-tree", "--name-only", `${expectedPreviousCommit}:${MIGRATIONS}`]).trim().split("\n").filter(Boolean);
  if (sourceNames.some(name => !/^\d{3}_[a-z0-9_]+\.sql$/.test(name)) || !equal([...databaseNames].sort(), [...sourceNames].sort()) || !equal(Object.keys(imageMigrations).sort(), [...sourceNames].sort())) reject("schema_inventory_mismatch");
  for (const name of sourceNames) if (digest(git(["show", `${expectedPreviousCommit}:${MIGRATIONS}/${name}`])) !== imageMigrations[name]) reject("schema_bytes_mismatch");
  const schemaVersion = Number(sourceNames.map(name => name.slice(0, 3)).sort().at(-1));
  const smoke = await (dependencies.gatewaySmoke ?? gatewaySmoke)({ baseURL: resolveLocalGatewayURL(observed.web.HostConfig.PortBindings), expectedVersion: semver, fullCommit: expectedPreviousCommit, profile: "go-full", workspaceEnabled: true });
  if (smoke.status !== "PASS") reject("observed_gateway_smoke_failed");
  const imageIDs = Object.fromEntries(GO_RECOVERY_SERVICES.map(name => [name, name === "migrate" ? observed.workspace.Image : observed[name].Image]));
  const snapshot = captureComposeSnapshot({ profile: "go-full", project, commit: expectedPreviousCommit, semver, schemaVersion, imageIDs, compose: roundtrip });
  const snapshotPath = path.join(outputDir, "observed-go-baseline.snapshot.json");
  await writeSnapshot(snapshotPath, snapshot);
  await writeRecoverableCompose(`${snapshotPath}.compose.json`, snapshot);
  const volumeRunner = async args => ({ status: 0, stdout: docker(args), stderr: "" });
  await captureExternalFiles({ composePath: `${snapshotPath}.compose.json`, services: GO_RECOVERY_SERVICES, outputPath: `${snapshotPath}.external.json` });
  await captureVolumeAuthority({ composePath: `${snapshotPath}.compose.json`, outputPath: `${snapshotPath}.volumes.json`, dockerRunner: volumeRunner });
  await verifyExternalFiles({ composePath: `${snapshotPath}.compose.json`, inputPath: `${snapshotPath}.external.json` });
  await verifyVolumeAuthority({ previousComposePath: `${snapshotPath}.compose.json`, currentComposePath: `${snapshotPath}.compose.json`, inputPath: `${snapshotPath}.volumes.json`, dockerRunner: volumeRunner });
  if (observationFingerprint(inspect(), images) !== firstFingerprint) reject("observed_runtime_changed");
  const artifactSHA256 = {};
  for (const suffix of ["", ".compose.json", ".external.json", ".volumes.json"]) artifactSHA256[suffix] = digest(await privateRead(snapshotPath + suffix));
  const evidence = { format: FORMAT, version: 1, source: "observed-running-go", historicalReleaseEvidence: "unavailable", capturedAt: new Date().toISOString(), project, commit: expectedPreviousCommit, semver, imageIDs, schemaVersion, migrations: imageMigrations, runtimeSHA256: firstFingerprint, sourceSHA256: Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, digest(v)])), artifactSHA256, checks: ["runtime-compose-equivalence", "literal-compose-roundtrip", "schema-git-image-database", "gateway-readonly-smoke", "external-files", "volume-authority", "runtime-unchanged"], migrationSource: "same-workspace-image-and-known-git-template-not-an-observed-container" };
  await privateWrite(`${snapshotPath}.adoption.json`, JSON.stringify(evidence) + "\n");
  await verifyAdoptionEvidence(snapshotPath);
  await privateWrite(envDestination, envText);
  return { status: "PASS", source: "observed-running-go", commit: expectedPreviousCommit, semver, snapshotPath, environmentRestored: true };
}

export function parseCLI(argv) {
  if (argv[0] === "verify") {
    if (argv.length !== 3 || argv[1] !== "--snapshot") reject("invalid_arguments");
    return { verify: argv[2] };
  }
  const mapping = { "--project-dir": "projectDir", "--expected-previous-commit": "expectedPreviousCommit", "--output-dir": "outputDir", "--project": "project" };
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = mapping[argv[i]];
    if (!key || !argv[i + 1] || options[key] !== undefined) reject("invalid_arguments");
    options[key] = argv[i + 1];
  }
  if (!options.projectDir || !options.expectedPreviousCommit || !options.outputDir) reject("invalid_arguments");
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = parseCLI(process.argv.slice(2));
    const result = options.verify ? await verifyAdoptionEvidence(options.verify) : await adoptRunning(options);
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) {
    process.stderr.write(`release adoption rejected: ${error instanceof AdoptionError ? error.code : "operation_failed"}\n`);
    process.exitCode = 1;
  }
}
