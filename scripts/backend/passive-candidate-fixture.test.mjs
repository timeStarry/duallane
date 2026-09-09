import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  GO_CANDIDATE_COMPOSE_OVERLAY_RELATIVE_PATH,
  PASSIVE_CANDIDATE_PROFILE,
  PASSIVE_CANDIDATE_SERVICES,
  PASSIVE_PROVIDER_DISABLED_ENV,
  buildPassiveCandidateComposeAdapter,
  buildPassiveCandidateFixture,
} from "./testdata/passive-candidate-fixture.mjs";
import { buildReleaseFixtures } from "./testdata/release-fixture.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const options = {
  project: "dl-passive-fixture",
  root,
  port: 28789,
  secretPath: path.join(root, "synthetic-passive-secret.json"),
  images: {
    node: `sha256:${"a".repeat(64)}`,
    nodeWeb: `sha256:${"b".repeat(64)}`,
    goWorkspace: `sha256:${"c".repeat(64)}`,
    goP2P: `sha256:${"d".repeat(64)}`,
    goWeb: `sha256:${"e".repeat(64)}`,
    postgres: `sha256:${"f".repeat(64)}`,
  },
  versions: { node: "0.15.5", go: "0.16.0" },
  commits: { node: "1".repeat(40), go: "2".repeat(40) },
  names: {
    network: "dl-passive-network",
    gatewayNetwork: "dl-passive-gateway",
    postgresVolume: "dl-passive-postgres",
    dataVolume: "dl-passive-data",
  },
};

test("passive candidate fixture keeps the real release shape and disables providers", () => {
  const fixture = buildPassiveCandidateFixture(options);
  const release = buildReleaseFixtures(options);
  const candidateCompose = fixture.candidateCompose;
  assert.equal(candidateCompose.services.worker.environment.WORKSPACE_MAINTENANCE_WORKER_ENABLED, "false");
  assert.notStrictEqual(
    release.goCompose.services.worker.environment,
    candidateCompose.services.worker.environment,
    "private candidate merge must not mutate the release fixture",
  );
  assert.deepEqual(candidateCompose.services.p2p.networks, { candidate: {} });
  assert.deepEqual(candidateCompose.services.web.networks, { candidate: {} });
  assert.deepEqual(candidateCompose.services.workspace.networks, { default: {} });
  assert.deepEqual(candidateCompose.services.worker.networks, { default: {} });
  assert.deepEqual(PASSIVE_CANDIDATE_SERVICES, ["p2p", "workspace", "worker", "web"]);
  assert.equal(fixture.candidateNetworkName, "dl-passive-fixture-go-full-candidate-network-222222222222");
  assert.equal(fixture.candidateContainerNames.workspace, "duallane-go-full-candidate-workspace-222222222222");

  for (const serviceName of PASSIVE_CANDIDATE_SERVICES) {
    const service = candidateCompose.services[serviceName];
    assert.equal(service.read_only, true, `${serviceName} rootfs must be read-only`);
    assert.match(service.image, /^sha256:[0-9a-f]{64}$/u);
    if (serviceName === "web") {
      assert.equal(Array.isArray(service.ports), true, "the base Web declaration keeps its port for normal compose");
    } else {
      assert.equal(service.ports, undefined, `${serviceName} must not add a published port`);
    }
  }
  assert.equal(candidateCompose.services.workspace.image, candidateCompose.services.worker.image);
  assert.equal(candidateCompose.services.worker.image, candidateCompose.services.migrate.image);
  for (const [serviceName, service] of Object.entries(candidateCompose.services)) {
    if (service.image !== undefined) {
      assert.match(service.image, /^sha256:[0-9a-f]{64}$/u, `${serviceName} image must remain pinned`);
    }
  }
  for (const serviceName of ["workspace", "worker"]) {
    const environment = candidateCompose.services[serviceName].environment;
    for (const [key, expected] of Object.entries(PASSIVE_PROVIDER_DISABLED_ENV)) {
      assert.equal(environment[key], expected, `${serviceName} ${key}`);
    }
    assert.equal(environment.WORKSPACE_STORAGE_DRIVER, "local");
    assert.equal(environment.WORKSPACE_NTFY_BASE_URL, "https://127.0.0.1:9");
  }
});

test("candidate adapter binds only the existing overlay and rejects unsafe runtime options", () => {
  const adapter = buildPassiveCandidateComposeAdapter({
    project: options.project,
    commit: options.commits.go,
    candidateComposePath: "/private/duallane/candidate-compose.json",
    candidateOverlayPath: "/private/duallane/deploy/production/go-candidate.compose.yml",
  });
  assert.equal(adapter.candidateNetworkName, "dl-passive-fixture-go-full-candidate-network-222222222222");
  assert.equal(adapter.profile, PASSIVE_CANDIDATE_PROFILE);
  assert.match(adapter.script, /candidate_compose\(\) \{/u);
  assert.match(adapter.script, /COMPOSE_DISABLE_ENV_FILE=1 docker compose/u);
  assert.match(adapter.script, /--profile rollback/u);
  assert.match(adapter.script, /passive_candidate_published_ports_forbidden/u);
  assert.match(adapter.script, /--service-ports\|--service-ports=\*\|-P\|--publish-all\|--publish-all=\*\|--publish\|--publish=\*\|-p\|-p\*/u);
  assert.doesNotMatch(adapter.script, /^\s*return\s*;?\s*$/mu);
  assert.doesNotMatch(adapter.script, /docker\s+(?:rm|network\s+rm)\b/u);
  assert.equal(adapter.cleanup.adapterDeletesNothing, true);

  const actualProject = `dl-release-${"a".repeat(20)}`;
  const actualNetwork = buildPassiveCandidateComposeAdapter({
    project: actualProject,
    commit: options.commits.go,
    candidateComposePath: "/private/duallane/candidate-compose.json",
    candidateOverlayPath: "/private/duallane/deploy/production/go-candidate.compose.yml",
  });
  assert.equal(
    actualNetwork.candidateNetworkName,
    `${actualProject}-go-full-candidate-network-${options.commits.go.slice(0, 12)}`,
  );
  assert.equal(
    buildPassiveCandidateFixture({ ...options, project: actualProject }).candidateNetworkName,
    actualNetwork.candidateNetworkName,
  );

  assert.throws(
    () => buildPassiveCandidateComposeAdapter({
      project: options.project,
      commit: options.commits.go,
      candidateComposePath: "relative.json",
      candidateOverlayPath: "/private/duallane/go-candidate.compose.yml",
    }),
    /candidate_compose_path_invalid/u,
  );
  assert.throws(
    () => buildPassiveCandidateComposeAdapter({
      project: options.project,
      commit: options.commits.go,
      candidateComposePath: "/private/duallane/deploy/production/go-candidate.compose.yml",
      candidateOverlayPath: "/private/duallane/deploy/production/go-candidate.compose.yml",
    }),
    /candidate_compose_paths_must_differ/u,
  );
  assert.throws(
    () => buildPassiveCandidateComposeAdapter({
      project: options.project,
      commit: options.commits.go,
      candidateComposePath: "/private/duallane/candidate.json",
      candidateOverlayPath: "/private/duallane/custom-overlay.yml",
    }),
    /candidate_overlay_path_not_canonical/u,
  );
});

test("fixture remains aligned with the real candidate overlay and ownership checks", async () => {
  const overlay = await readFile(path.join(root, GO_CANDIDATE_COMPOSE_OVERLAY_RELATIVE_PATH), "utf8");
  const helper = await readFile(path.join(root, "deploy/production/release-helper.sh"), "utf8");
  assert.match(overlay, /external:\s*true/u);
  assert.match(overlay, /DUALLANE_GO_CANDIDATE_NETWORK:\?candidate network is required/u);
  for (const [service, alias] of [["p2p", "p2p"], ["workspace", "workspace"], ["worker", "worker"], ["web", "web"]]) {
    assert.match(overlay, new RegExp(`${service}:[\\s\\S]*?aliases:[\\s\\S]*?- ${alias}`, "u"));
  }
  assert.match(overlay, /duallane-data:\/app\/data:ro/u);
  assert.match(helper, /release_candidate_compose\(\) \{/u);
  assert.match(helper, /candidate_run_options=\(-d --no-deps\)/u);
  assert.match(helper, /release_remove_owned_candidate_if_present "\$\{candidate_name\}" "\$\{service\}"/u);
  assert.match(helper, /refusing to use an unowned release candidate/u);
  assert.match(helper, /release_verify_candidate_has_no_published_ports/u);
  assert.match(helper, /candidate_name="duallane-\$\{RELEASE_PROFILE_NAME\}-candidate-\$\{service\}-\$\{current_commit:0:12\}"/u);
});

test("real Compose resolution keeps candidate aliases off active networks", {
  skip: process.platform !== "linux" ? "Linux Compose configuration gate" : false,
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "duallane-passive-config-"));
  try {
    const fixture = buildPassiveCandidateFixture(options);
    const filename = path.join(directory, "candidate.json");
    await writeFile(filename, JSON.stringify(fixture.candidateCompose), { mode: 0o600, flag: "wx" });
    const result = spawnSync("docker", ["compose", "--project-name", options.project, "--profile", "rollback",
      "-f", filename, "-f", fixture.candidateOverlayPath, "config", "--format", "json"], {
      cwd: root, encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, COMPOSE_DISABLE_ENV_FILE: "1",
        DOCKER_HOST: "unix:///var/run/docker.sock", DUALLANE_GO_CANDIDATE_NETWORK: fixture.candidateNetworkName },
    });
    assert.equal(result.error, undefined, "Compose resolution did not execute");
    assert.equal(result.status, 0, "Compose resolution rejected the private fixture");
    const resolved = JSON.parse(result.stdout);
    assert.equal(resolved.networks.candidate.name, fixture.candidateNetworkName);
    for (const serviceName of PASSIVE_CANDIDATE_SERVICES) {
      const service = resolved.services[serviceName];
      assert.deepEqual(Object.keys(service.networks).sort(),
        ["workspace", "worker"].includes(serviceName) ? ["candidate", "default"] : ["candidate"]);
      assert.deepEqual(service.networks.candidate.aliases, [serviceName]);
      assert.equal(service.read_only, true);
      if (["workspace", "worker"].includes(serviceName)) {
        assert.equal(service.networks.default.aliases, undefined);
        assert.equal(service.volumes.find((volume) => volume.target === "/app/data").read_only, true);
        for (const [key, expected] of Object.entries(PASSIVE_PROVIDER_DISABLED_ENV)) {
          assert.equal(service.environment[key], expected);
        }
      }
    }
  } finally {
    // Only this test's private, synthetic Compose input is removed; this gate
    // never creates containers, networks or volumes.
    await rm(directory, { recursive: true, force: true });
  }
});
