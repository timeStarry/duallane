import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { verifySchemaCompatibility } from "../../deploy/production/release-schema-compatibility.mjs";
import { buildReleaseFixtures } from "./testdata/release-fixture.mjs";
import { buildGoUpgradeCycle } from "./testdata/go-upgrade-coordinator.mjs";

// Opt in on the Linux validation host. Every image must already exist locally;
// this test neither builds/pulls images nor reads production environment/data.
// DUALLANE_AGENT_SCHEMA_UPGRADE_DOCKER_TEST=true node --test <this file>
// Required DUALLANE_AGENT_SCHEMA_{OLD,TARGET}_{WORKSPACE,P2P,WEB}_IMAGE and
// DUALLANE_AGENT_SCHEMA_POSTGRES_IMAGE are immutable sha256:<64 hex> image IDs.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ownerLabel = "com.duallane.agent-schema-upgrade-test";
const imagePattern = /^sha256:[0-9a-f]{64}$/u;
const containerPattern = /^[0-9a-f]{64}$/u;
const selected = process.env.DUALLANE_AGENT_SCHEMA_UPGRADE_DOCKER_TEST === "true";
const services = ["p2p", "workspace", "worker", "web"];
const childEnvironment = () => ({ PATH: process.env.PATH, HOME: process.env.HOME,
  DOCKER_HOST: "unix:///var/run/docker.sock", COMPOSE_DISABLE_ENV_FILE: "1" });
const fail = (code) => { throw new Error(code); };

function imagesFrom(environment) {
  const images = {};
  for (const stage of ["OLD", "TARGET"]) {
    images[stage.toLowerCase()] = Object.fromEntries(["WORKSPACE", "P2P", "WEB"].map((name) => {
      const image = environment[`DUALLANE_AGENT_SCHEMA_${stage}_${name}_IMAGE`];
      if (!imagePattern.test(image ?? "")) fail(`invalid_${stage.toLowerCase()}_${name.toLowerCase()}_image`);
      return [`go${name === "WORKSPACE" ? "Workspace" : name === "P2P" ? "P2P" : "Web"}`, image];
    }));
  }
  images.postgres = environment.DUALLANE_AGENT_SCHEMA_POSTGRES_IMAGE;
  if (!imagePattern.test(images.postgres ?? "")) fail("invalid_postgres_image");
  return images;
}

function docker(args, { timeout = 30_000, allowFailure = false } = {}) {
  const result = spawnSync("docker", args, { cwd: root, env: childEnvironment(), encoding: "utf8", timeout, maxBuffer: 1024 * 1024 });
  if (result.error || result.signal) fail("docker_execution_failed");
  if (!allowFailure && result.status !== 0) fail(`docker_${args[0]}_failed`);
  return result;
}

function inspect(kind, id) {
  let rows;
  try { rows = JSON.parse(docker([kind, "inspect", id]).stdout); } catch { fail("docker_inspect_failed"); }
  if (!Array.isArray(rows) || rows.length !== 1) fail("docker_inspect_count_invalid");
  return rows[0];
}

function releaseIdentity(image) {
  const record = inspect("image", image), labels = record.Config?.Labels ?? {};
  if (record.Id !== image) fail("immutable_image_changed");
  const commit = labels["org.opencontainers.image.revision"], version = labels["org.opencontainers.image.version"];
  if (!/^[a-f0-9]{40}$/u.test(commit ?? "") || !/^\d+\.\d+\.\d+$/u.test(version ?? "")) fail("release_identity_invalid");
  return { commit, version };
}

function extractFunction(source, name) {
  const start = source.indexOf(`\n${name}() {`), end = source.indexOf("\n}\n", start);
  if (start < 0 || end < start) fail("production_function_missing");
  return source.slice(start + 1, end + 2);
}

function goOnlyCompose(options) {
  // The pure shared fixture accepts legacy identities, but this document drops
  // that service entirely. No retired Node image or runtime is required.
  const compose = buildReleaseFixtures({ ...options,
    images: { ...options.images, node: options.images.goWorkspace, nodeWeb: options.images.goWeb },
    versions: { node: options.version, go: options.version }, commits: { node: options.commit, go: options.commit } }).goCompose;
  delete compose.services.api;
  return compose;
}

function bootstrapScript(source) {
  return ["set -Eeuo pipefail", "umask 077", 'source "$ROOT/deploy/production/release-helper.sh"',
    ...["verify_container_release", "start_release_service", "start_release_edge"].map((name) => extractFunction(source, name)),
    'compose() { local files=(-f "${RELEASE_GO_ACTIVATION_COMPOSE_FILE:-$GO_COMPOSE}"); if [[ -z "$RELEASE_GO_ACTIVATION_COMPOSE_FILE" && -n "$RELEASE_GO_IMAGE_OVERRIDE_FILE" ]]; then files+=(-f "$RELEASE_GO_IMAGE_OVERRIDE_FILE"); fi; docker compose --project-name "$PROJECT" "${files[@]}" "$@"; }',
    'PROJECT_DIR=$ROOT; COMPOSE_PROJECT_NAME=$PROJECT; export COMPOSE_PROJECT_NAME; current_commit=$GO_COMMIT; expected_app_version=$GO_VERSION',
    'release_load_profile go-full; RELEASE_GO_UPGRADE=false; RELEASE_RECOVERY_FILE=$RECOVERY',
    'RELEASE_STOP_TIMEOUT=10; RELEASE_STOP_ATTEMPTS=15; RELEASE_HEALTH_ATTEMPTS=30',
    ': >"$RECOVERY"',
    'release_validate_resolved_compose; release_pin_compose_project',
    'release_verify_go_edge_images; release_verify_go_image_identity',
    // This initializes an empty fixture, not a Node cutover. The subsequent
    // GoUpgrade child executes the unchanged full activation authority gate.
    'release_freeze_go_activation_compose',
    'release_run_go_migration_and_verify',
    'for service in p2p workspace worker; do start_release_service "$service"; done',
    'start_release_edge',
    'release_run_gateway_smoke go-full "$GO_VERSION" "$GO_COMMIT"',
    // Only the old fixture capture needs an image-derived version: this working
    // tree contains 037. The upgrade child sources the unmodified helper again.
    'release_current_schema_version() {',
    '  [[ "$RELEASE_GO_MIGRATION_VERIFIED" == true ]] || return 1',
    '  node "$ROOT/deploy/production/release-schema-compatibility.mjs" verify --previous-image "$RELEASE_GO_IMAGE_ID" --target-image "$RELEASE_GO_IMAGE_ID" | node -e \'let data="";process.stdin.on("data",c=>data+=c);process.stdin.on("end",()=>{const r=JSON.parse(data);if(r.status!=="compatible"||r.previousMigrationCount!==36||r.targetMigrationCount!==36||r.commonMigrationCount!==36||r.addedMigrationCount!==0||r.removedMigrationCount!==0)process.exit(1);console.log(36)});\'',
    '}',
    'release_capture_successful_go_snapshot',
  ].join("\n");
}

function upgradeScript(source) {
  return ["set -Eeuo pipefail", "umask 077",
    ...["verify_container_release", "start_release_service", "start_release_backend", "start_release_edge", "go_upgrade_rollback_compose"]
      .map((name) => extractFunction(source, name)), buildGoUpgradeCycle()].join("\n");
}

async function runCoordinator(script, environment) {
  const catalog = [];
  for (const filename of ["deploy.sh", "release-helper.sh"]) {
    const source = await readFile(path.join(root, "deploy/production", filename), "utf8");
    source.split("\n").forEach((line, index) => {
      const message = line.match(/^\s*echo "([^"]+)" >&2\s*$/u)?.[1];
      if (!message) return;
      const pattern = message.split(/\$\{[^}]+\}/u).map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("[^\\n]*");
      catalog.push({ pattern: new RegExp(`^${pattern}$`, "mu"), code: `${filename === "deploy.sh" ? "deploy" : "helper"}_line_${index + 1}` });
    });
  }
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["--noprofile", "--norc", script], { cwd: root, env: { ...childEnvironment(), ...environment },
      detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let bytes = 0, failure, killTimer, errors = "";
    const codes = new Set();
    const terminate = (code) => {
      if (failure) return; failure = code;
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* already exited */ }
      killTimer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ } }, 3000);
    };
    const timer = setTimeout(() => terminate("coordinator_timeout"), 600_000);
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) terminate("coordinator_output_limit");
      if (stream === child.stderr && bytes <= 1024 * 1024) errors += chunk.toString("utf8");
      for (const match of chunk.toString("utf8").matchAll(/\b([A-Za-z_][A-Za-z0-9_]*): unbound variable\b/gu)) codes.add(`unbound_${match[1]}`);
      // Keep fixed diagnostic codes, never application bodies/configuration.
      for (const match of chunk.toString("utf8").matchAll(/^release [a-z ]+ rejected: ([a-z_]+)$/gmu)) codes.add(match[1]);
    });
    child.once("error", () => { clearTimeout(timer); clearTimeout(killTimer); reject(new Error("coordinator_spawn_failed")); });
    child.once("close", (status) => {
      clearTimeout(timer); clearTimeout(killTimer);
      for (const entry of catalog) if (entry.pattern.test(errors)) codes.add(entry.code);
      resolve({ status, failure, codes: [...codes] });
    });
  });
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function ownedContainers(project, runID, allowedImages) {
  return docker(["ps", "-a", "--no-trunc", "-q", "--filter", `label=com.docker.compose.project=${project}`]).stdout.trim().split(/\s+/u).filter(Boolean).map((id) => {
    if (!containerPattern.test(id)) fail("container_identity_invalid");
    const record = inspect("container", id);
    if (record.Id !== id || record.Config?.Labels?.[ownerLabel] !== runID || record.Config?.Labels?.["com.docker.compose.project"] !== project || !allowedImages.has(record.Image)) fail("fixture_owner_changed");
    return record;
  });
}

function baselineContainers() {
  return docker(["ps", "--no-trunc", "-q"]).stdout.trim().split(/\s+/u).filter(Boolean).map((id) => {
    const record = inspect("container", id);
    return { id: record.Id, image: record.Image, status: record.State.Status, running: record.State.Running,
      startedAt: record.State.StartedAt, restarts: record.RestartCount, health: record.State.Health?.Status };
  });
}

function verifyBaseline(records) {
  for (const before of records) {
    const current = inspect("container", before.id);
    assert.deepEqual({ id: current.Id, image: current.Image, status: current.State.Status, running: current.State.Running,
      startedAt: current.State.StartedAt, restarts: current.RestartCount, health: current.State.Health?.Status }, before, "pre-existing running container changed");
  }
}

function schemaState(pgID, expectedCount) {
  const sql = "SELECT COUNT(*)::text || ':' || COUNT(*) FILTER (WHERE name='037_agent_task_authorization.sql')::text FROM schema_migrations";
  const result = docker(["exec", pgID, "psql", "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-U", "duallane", "-d", "duallane", "-c", sql]);
  assert.equal(result.stdout.trim(), `${expectedCount}:${expectedCount === 37 ? 1 : 0}`, "actual database migration history differs");
}

function assertHealthy(records, expected, postgresID, volumeNames) {
  for (const service of [...services, "postgres"]) {
    const rows = records.filter((c) => c.Config.Labels["com.docker.compose.service"] === service);
    assert.equal(rows.length, 1, `one ${service} owner required`);
    assert.equal(rows[0].State.Running, true); assert.equal(rows[0].State.Health?.Status, "healthy");
    assert.equal(rows[0].Image, expected[service]);
    if (service === "postgres") {
      if (postgresID) assert.equal(rows[0].Id, postgresID, "database container authority changed");
      assert.equal(rows[0].Mounts.find((m) => m.Destination === "/var/lib/postgresql/data")?.Name, volumeNames.postgresVolume);
    }
    if (["workspace", "worker"].includes(service)) assert.equal(rows[0].Mounts.find((m) => m.Destination === "/app/data")?.Name, volumeNames.dataVolume);
  }
  assert.equal(records.some((c) => c.Config.Labels["com.docker.compose.service"] === "api"), false, "retired Node API must never exist");
}

async function snapshotEvidence(filename, schemaVersion, imageIDs) {
  for (const suffix of ["", ".compose.json", ".external.json", ".volumes.json"]) {
    const metadata = await lstat(filename + suffix);
    assert.equal(metadata.isFile() && !metadata.isSymbolicLink(), true); assert.equal(metadata.mode & 0o777, 0o600);
  }
  const snapshot = JSON.parse(await readFile(filename, "utf8"));
  assert.equal(snapshot.schemaVersion, schemaVersion); assert.deepEqual(snapshot.imageIDs, imageIDs);
  const compose = JSON.parse(await readFile(filename + ".compose.json", "utf8"));
  assert.equal(compose.services.api, undefined);
}

test("Go-only agent upgrade rejects mutable image inputs and drops the retired service", () => {
  assert.throws(() => imagesFrom({}), /invalid_old_workspace_image/u);
  assert.throws(() => imagesFrom({ DUALLANE_AGENT_SCHEMA_OLD_WORKSPACE_IMAGE: "duallane:latest" }), /invalid_old_workspace_image/u);
  const image = "sha256:" + "a".repeat(64);
  const compose = goOnlyCompose({ project: "dl-agent-schema-test", images: { goWorkspace: image, goP2P: image, goWeb: image, postgres: image },
    version: "1.1.2", commit: "b".repeat(40), names: { network: "test-private", gatewayNetwork: "test-gateway", postgresVolume: "test-pg", dataVolume: "test-data" },
    root, secretPath: path.join(os.tmpdir(), "synthetic-secret.json"), port: 23456 });
  assert.deepEqual(Object.keys(compose.services).sort(), ["migrate", "p2p", "postgres", "web", "worker", "workspace"]);
  assert.ok(Object.values(compose.services).every((service) => service.image === image));
});

test("Go-only rehearsal keeps actual production lifecycle and fresh upgrade-helper initialization", async () => {
  const source = (await readFile(path.join(root, "deploy/production/deploy.sh"), "utf8")).replaceAll("\r\n", "\n");
  const bootstrap = bootstrapScript(source), upgrade = upgradeScript(source);
  assert.match(bootstrap, /release_run_go_migration_and_verify/u); assert.match(bootstrap, /release_capture_successful_go_snapshot/u);
  assert.match(bootstrap, /r.previousMigrationCount!==36/u);
  assert.match(bootstrap, /for service in p2p workspace worker/u);
  assert.doesNotMatch(bootstrap, /release_verify_activation_authority/u);
  assert.ok(upgrade.includes(buildGoUpgradeCycle()));
  assert.doesNotMatch(upgrade, /release_current_schema_version\(\)/u);
  assert.doesNotMatch(bootstrap + upgrade, /node-default|nodeCompose|NODE_COMPOSE|stop_legacy_services_for_go\(\)/u);
});

test("immutable Go images upgrade schema 036 to 037 and restore old Go on the same schema 037 database", {
  skip: !selected || process.platform !== "linux" ? "opt in on Linux with seven immutable local image IDs" : false,
  timeout: 1_400_000,
}, async (t) => {
  const images = imagesFrom(process.env);
  const old = releaseIdentity(images.old.goWorkspace), target = releaseIdentity(images.target.goWorkspace);
  for (const stage of ["old", "target"]) for (const image of [images[stage].goP2P, images[stage].goWeb]) assert.deepEqual(releaseIdentity(image), stage === "old" ? old : target);
  assert.notEqual(old.commit, target.commit);
  const before = old.version.split(".").map(BigInt), after = target.version.split(".").map(BigInt);
  const different = after.findIndex((part, index) => part !== before[index]);
  assert.ok(different >= 0 && after[different] > before[different], "target version must be newer");
  assert.equal(inspect("image", images.postgres).Id, images.postgres);
  const proof = await verifySchemaCompatibility({ previousImage: images.old.goWorkspace, targetImage: images.target.goWorkspace });
  assert.equal(proof.status, "compatible"); assert.equal(proof.previousMigrationCount, 36); assert.equal(proof.targetMigrationCount, 37);
  assert.equal(proof.commonMigrationCount, 36); assert.equal(proof.addedMigrationCount, 1); assert.equal(proof.removedMigrationCount, 0);
  const baseline = baselineContainers();
  const runID = randomBytes(24).toString("hex"), project = `dl-agent-schema-${runID.slice(0, 18)}`;
  const names = { network: `${project}-private`, gatewayNetwork: `${project}-gateway`, postgresVolume: `${project}-pg`, dataVolume: `${project}-data` };
  const allowed = new Set([images.postgres, ...Object.values(images.old), ...Object.values(images.target)]);
  const directory = await mkdtemp(path.join(os.tmpdir(), "duallane-agent-schema-"));
  const paths = Object.fromEntries(["old", "target", "secret", "bootstrap", "upgrade", "oldRecovery", "upgradeRecovery", "upgradeSnapshot", "phases"].map((name) => [name, path.join(directory, name + ".json")]));
  const resources = { volumes: [], networks: [] };
  let primary, phase = "fixture";
  try {
    const options = { project, names, root, port: await freePort(), secretPath: paths.secret };
    await writeFile(paths.secret, JSON.stringify({ accessKey: "synthetic", secretKey: "synthetic-only" }), { flag: "wx", mode: 0o600 });
    for (const stage of ["old", "target"]) {
      const metadata = stage === "old" ? old : target;
      const compose = goOnlyCompose({ ...options, images: { ...images[stage], postgres: images.postgres }, ...metadata });
      for (const service of Object.values(compose.services)) service.labels = { ...service.labels, [ownerLabel]: runID };
      await writeFile(paths[stage], JSON.stringify(compose), { flag: "wx", mode: 0o600 });
      docker(["compose", "--project-name", project, "-f", paths[stage], "config", "--quiet"]);
    }
    if (docker(["ps", "-a", "-q", "--filter", `label=com.docker.compose.project=${project}`]).stdout.trim()) fail("project_already_exists");
    for (const [name, logical, internal] of [[names.network, "default", true], [names.gatewayNetwork, "gateway", false]]) {
      if (docker(["network", "inspect", name], { allowFailure: true }).status === 0) fail("network_already_exists");
      const resource = { name, internal, id: null }; resources.networks.push(resource);
      resource.id = docker(["network", "create", ...(internal ? ["--internal"] : []), "--driver", "bridge", "--opt", "com.docker.network.bridge.host_binding_ipv4=127.0.0.1",
        "--label", `${ownerLabel}=${runID}`, "--label", `com.docker.compose.project=${project}`, "--label", `com.docker.compose.network=${logical}`, name]).stdout.trim();
      if (!containerPattern.test(resource.id)) fail("network_identity_invalid");
    }
    for (const [name, logical] of [[names.postgresVolume, "duallane-postgres"], [names.dataVolume, "duallane-data"]]) {
      if (docker(["volume", "inspect", name], { allowFailure: true }).status === 0) fail("volume_already_exists");
      resources.volumes.push(name);
      assert.equal(docker(["volume", "create", "--label", `${ownerLabel}=${runID}`, "--label", `com.docker.compose.project=${project}`, "--label", `com.docker.compose.volume=${logical}`, name]).stdout.trim(), name);
    }
    phase = "permissions";
    const initID = docker(["create", "--pull=never", "--network", "none", "--user", "0:0", "--label", `${ownerLabel}=${runID}`, "--label", `com.docker.compose.project=${project}`,
      "--mount", `type=volume,source=${names.dataVolume},target=/app/data`, "--entrypoint", "/bin/sh", images.old.goWorkspace, "-c",
      "mkdir -p /app/data/workspace-files && chown 65532:65532 /app/data /app/data/workspace-files && chmod 0770 /app/data /app/data/workspace-files"]).stdout.trim();
    if (!containerPattern.test(initID)) fail("permission_container_identity_invalid");
    docker(["start", "--attach", initID]); assert.equal(inspect("container", initID).State.ExitCode, 0);
    const base = ["compose", "--project-name", project, "-f", paths.old];
    phase = "postgres";
    docker([...base, "up", "-d", "--no-deps", "--pull", "never", "--no-build", "--wait", "--wait-timeout", "60", "postgres"], { timeout: 75_000 });
    const pgID = docker([...base, "ps", "-a", "-q", "postgres"]).stdout.trim();
    const source = (await readFile(path.join(root, "deploy/production/deploy.sh"), "utf8")).replaceAll("\r\n", "\n");
    await writeFile(paths.bootstrap, bootstrapScript(source), { flag: "wx", mode: 0o600 });
    await writeFile(paths.upgrade, upgradeScript(source), { flag: "wx", mode: 0o600 });
    phase = "old_go_bootstrap";
    const bootstrap = await runCoordinator(paths.bootstrap, { ROOT: root, PROJECT: project, GO_COMPOSE: paths.old, GO_COMMIT: old.commit, GO_VERSION: old.version, RECOVERY: paths.oldRecovery });
    if (bootstrap.status !== 0 || bootstrap.failure) fail(`bootstrap_failed_${bootstrap.status}_${bootstrap.failure ?? "none"}_${bootstrap.codes.join("_")}`);
    const expectedOld = { p2p: images.old.goP2P, workspace: images.old.goWorkspace, worker: images.old.goWorkspace, web: images.old.goWeb, postgres: images.postgres };
    assertHealthy(ownedContainers(project, runID, allowed), expectedOld, pgID, names); schemaState(pgID, 36);
    const previousSnapshot = `${paths.oldRecovery}.go-compose.snapshot.json`;
    const snapshotImages = (stage) => ({ p2p: images[stage].goP2P, workspace: images[stage].goWorkspace, worker: images[stage].goWorkspace, web: images[stage].goWeb, migrate: images[stage].goWorkspace });
    await snapshotEvidence(previousSnapshot, 36, snapshotImages("old"));
    phase = "upgrade_and_rollback";
    const upgrade = await runCoordinator(paths.upgrade, { ROOT: root, PROJECT: project, UPGRADE_GO_COMPOSE: paths.target, UPGRADE_COMMIT: target.commit, UPGRADE_VERSION: target.version,
      UPGRADE_SNAPSHOT: paths.upgradeSnapshot, UPGRADE_RECOVERY: paths.upgradeRecovery, PREVIOUS_GO_SNAPSHOT: previousSnapshot, PHASE_FILE: paths.phases });
    if (upgrade.status !== 0 || upgrade.failure) fail(`upgrade_failed_${upgrade.status}_${upgrade.failure ?? "none"}_${upgrade.codes.join("_")}`);
    assert.deepEqual((await readFile(paths.phases, "utf8")).trim().split("\n"), ["validate", "snapshot", "pin", "freeze", "schema_compatibility", "migrate", "fence_drain_activate", "edge", "smoke", "capture", "rollback", "complete"].map((name) => `upgrade_${name}`));
    await snapshotEvidence(`${paths.upgradeRecovery}.go-compose.snapshot.json`, 37, snapshotImages("target"));
    phase = "restored_go_verification";
    assertHealthy(ownedContainers(project, runID, allowed), expectedOld, pgID, names);
    schemaState(pgID, 37);
    t.diagnostic("real Go-only 036→037 activation, private exact-image snapshots and old-Go recovery on unchanged PostgreSQL authority passed");
  } catch (error) { primary = new Error(`agent_schema_${phase}: ${/^[a-zA-Z0-9_ :.-]+$/u.test(error.message) ? error.message : "check_failed"}`); }
  finally {
    let cleanupError;
    try {
      for (const record of ownedContainers(project, runID, allowed)) {
        const current = inspect("container", record.Id);
        if (current.Image !== record.Image || current.Config?.Labels?.[ownerLabel] !== runID || current.Config?.Labels?.["com.docker.compose.project"] !== project) fail("cleanup_container_owner_changed");
        if (current.State.Running) docker(["stop", "--time", "10", current.Id]);
        if (inspect("container", current.Id).State.Running) fail("cleanup_container_not_stopped");
        docker(["rm", current.Id]);
      }
      for (const name of resources.volumes) {
        if (docker(["volume", "inspect", name], { allowFailure: true }).status !== 0) continue;
        const volume = inspect("volume", name);
        if (volume.Name !== name || volume.Driver !== "local" || volume.Labels?.[ownerLabel] !== runID || volume.Labels?.["com.docker.compose.project"] !== project) fail("cleanup_volume_owner_changed");
        docker(["volume", "rm", name]);
      }
      for (const resource of resources.networks) {
        if (docker(["network", "inspect", resource.name], { allowFailure: true }).status !== 0) continue;
        const network = inspect("network", resource.name);
        if ((resource.id && network.Id !== resource.id) || network.Name !== resource.name || network.Internal !== resource.internal || network.Labels?.[ownerLabel] !== runID || Object.keys(network.Containers ?? {}).length) fail("cleanup_network_owner_changed");
        docker(["network", "rm", network.Id]);
      }
      verifyBaseline(baseline);
    } catch { cleanupError = new Error("agent_schema_owned_cleanup_or_baseline_failed"); }
    if (!cleanupError) await rm(directory, { recursive: true, force: true });
    if (cleanupError) throw new AggregateError(primary ? [primary, cleanupError] : [cleanupError], "agent_schema_rehearsal_failed");
  }
  if (primary) throw primary;
});
