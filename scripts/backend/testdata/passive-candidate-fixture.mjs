// Pure private fixture data and Compose adapter for the Go passive-candidate
// rehearsal.  The production candidate network/rootfs rules remain owned by
// deploy/production/go-candidate.compose.yml and release-helper.sh; this
// module only supplies disposable resolved Compose data and a safe hook for a
// caller that writes that data to a private file.

import path from "node:path";

import { buildReleaseFixtures } from "./release-fixture.mjs";

const PASSIVE_CANDIDATE_PROFILE = "go-full";
const PASSIVE_CANDIDATE_SERVICES = Object.freeze(["p2p", "workspace", "worker", "web"]);
const GO_CANDIDATE_COMPOSE_OVERLAY_RELATIVE_PATH = "deploy/production/go-candidate.compose.yml";
const IMAGE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/u;
const POSIX_ABSOLUTE_PATH_PATTERN = /^\/(?:[^\u0000-\u001f\u007f/]+\/)*[^\u0000-\u001f\u007f/]*$/u;

// Keep every external/background provider disabled in the disposable
// candidate.  The loopback Ntfy endpoint and local storage driver are already
// synthetic values supplied by release-fixture.mjs.
const PASSIVE_PROVIDER_DISABLED_ENV = Object.freeze({
  WORKSPACE_EMAIL_WORKER_ENABLED: "false",
  WORKSPACE_NTFY_WORKER_ENABLED: "false",
  WORKSPACE_MAINTENANCE_WORKER_ENABLED: "false",
  WORKSPACE_ECHO_WORKER_ENABLED: "false",
});

function invalid(code) {
  throw new TypeError(code);
}

function requireProject(value, code = "candidate_project_invalid") {
  if (typeof value !== "string" || !PROJECT_NAME_PATTERN.test(value)) invalid(code);
  return value;
}

function requireCommit(value, code = "candidate_commit_invalid") {
  if (typeof value !== "string" || !COMMIT_PATTERN.test(value)) invalid(code);
  return value;
}

function requirePosixAbsolutePath(value, code) {
  if (
    typeof value !== "string" ||
    !POSIX_ABSOLUTE_PATH_PATTERN.test(value) ||
    value.endsWith("/") ||
    value.split("/").includes("..")
  ) {
    invalid(code);
  }
  return value;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function candidateNetworkName(project, commit) {
  return `${project}-${PASSIVE_CANDIDATE_PROFILE}-candidate-network-${commit.slice(0, 12)}`;
}

function candidateContainerNames(commit) {
  const shortCommit = commit.slice(0, 12);
  return Object.fromEntries(
    PASSIVE_CANDIDATE_SERVICES.map((service) => [
      service,
      `duallane-${PASSIVE_CANDIDATE_PROFILE}-candidate-${service}-${shortCommit}`,
    ]),
  );
}

function dataVolumeFor(service) {
  return (service.volumes ?? []).some(
    (volume) => volume?.type === "volume" && volume.source === "duallane-data" && volume.target === "/app/data",
  );
}

function validateCandidateDocuments({ goCompose, candidateCompose, candidateComposeOverride }) {
  const services = candidateCompose?.services;
  if (!services || typeof services !== "object" || Array.isArray(services)) {
    invalid("candidate_services_invalid");
  }
  for (const serviceName of [...PASSIVE_CANDIDATE_SERVICES, "migrate", "postgres"]) {
    if (!services[serviceName] || typeof services[serviceName] !== "object") {
      invalid(`candidate_service_${serviceName}_missing`);
    }
  }

  for (const serviceName of ["p2p", "workspace", "worker"]) {
    if (services[serviceName].read_only !== true) invalid(`candidate_${serviceName}_rootfs_not_readonly`);
    if (services[serviceName].ports !== undefined) invalid(`candidate_${serviceName}_ports_present`);
  }
  if (services.web.read_only !== true) invalid("candidate_web_rootfs_not_readonly");
  if (JSON.stringify(services.p2p.networks) !== JSON.stringify({ candidate: {} })) {
    invalid("candidate_p2p_network_scope_invalid");
  }
  if (JSON.stringify(services.web.networks) !== JSON.stringify({ candidate: {} })) {
    invalid("candidate_web_network_scope_invalid");
  }
  for (const serviceName of ["workspace", "worker"]) {
    if (JSON.stringify(services[serviceName].networks) !== JSON.stringify({ default: {} })) {
      invalid(`candidate_${serviceName}_default_network_missing`);
    }
  }
  for (const serviceName of ["workspace", "worker"]) {
    if (!dataVolumeFor(services[serviceName])) invalid(`candidate_${serviceName}_data_volume_missing`);
    const environment = services[serviceName].environment;
    if (environment?.WORKSPACE_ENABLED !== "true") invalid(`candidate_${serviceName}_workspace_gate_invalid`);
    for (const [key, expected] of Object.entries(PASSIVE_PROVIDER_DISABLED_ENV)) {
      if (environment?.[key] !== expected) invalid(`candidate_${serviceName}_${key.toLowerCase()}_enabled`);
    }
    if (environment?.WORKSPACE_STORAGE_DRIVER !== "local") invalid(`candidate_${serviceName}_storage_provider_enabled`);
    if (environment?.WORKSPACE_NTFY_BASE_URL !== "https://127.0.0.1:9") {
      invalid(`candidate_${serviceName}_ntfy_endpoint_not_synthetic`);
    }
  }
  if (services.workspace.image !== services.worker.image || services.worker.image !== services.migrate.image) {
    invalid("candidate_workspace_worker_migrate_image_mismatch");
  }
  for (const [serviceName, service] of Object.entries(services)) {
    if (service?.image !== undefined && !IMAGE_ID_PATTERN.test(service.image)) {
      invalid(`candidate_${serviceName}_image_not_pinned`);
    }
  }

  const overrideServices = candidateComposeOverride?.services;
  if (!overrideServices || typeof overrideServices !== "object" || Array.isArray(overrideServices)) {
    invalid("candidate_override_invalid");
  }
  if (JSON.stringify(Object.keys(overrideServices)) !== JSON.stringify(["p2p", "workspace", "worker", "web"])) {
    invalid("candidate_override_services_invalid");
  }
  for (const serviceName of PASSIVE_CANDIDATE_SERVICES) {
    const override = overrideServices[serviceName];
    const expectedNetworks = ["p2p", "web"].includes(serviceName) ? { candidate: {} } : { default: {} };
    const expectedKeys = ["p2p", "web"].includes(serviceName) ? ["networks"] : ["networks", "environment"];
    if (!override || JSON.stringify(Object.keys(override)) !== JSON.stringify(expectedKeys) ||
        JSON.stringify(override.networks) !== JSON.stringify(expectedNetworks)) {
      invalid(`candidate_${serviceName}_override_shape_invalid`);
    }
    if (["workspace", "worker"].includes(serviceName)) {
      for (const [key, expected] of Object.entries(PASSIVE_PROVIDER_DISABLED_ENV)) {
        if (override.environment?.[key] !== expected) invalid(`candidate_override_${key.toLowerCase()}_invalid`);
      }
    }
  }

  // The base fixture is intentionally not changed in place.  The builder
  // clones it before applying the private candidate environment merge.
  if (goCompose?.services?.worker?.environment === candidateCompose.services.worker.environment) {
    invalid("release_fixture_worker_environment_was_mutated");
  }
  return true;
}

/**
 * Build disposable Go candidate documents from the canonical release fixture.
 *
 * Write the returned full private base, not an override over the active
 * fixture: Compose merges network maps and would retain active upstreams.
 * The production candidate overlay remains the canonical alias/mount policy.
 */
function buildPassiveCandidateFixture(options) {
  const releaseFixtures = buildReleaseFixtures(options);
  const project = requireProject(options.project);
  const commit = requireCommit(options.commits?.go);
  const overlayPath = path.join(options.root, ...GO_CANDIDATE_COMPOSE_OVERLAY_RELATIVE_PATH.split("/"));
  const candidateComposeOverride = {
    services: {
      p2p: { networks: { candidate: {} } },
      workspace: { networks: { default: {} }, environment: { ...PASSIVE_PROVIDER_DISABLED_ENV } },
      worker: { networks: { default: {} }, environment: { ...PASSIVE_PROVIDER_DISABLED_ENV } },
      web: { networks: { candidate: {} } },
    },
  };
  const candidateCompose = structuredClone(releaseFixtures.goCompose);
  for (const serviceName of PASSIVE_CANDIDATE_SERVICES) {
    candidateCompose.services[serviceName].networks = structuredClone(
      candidateComposeOverride.services[serviceName].networks,
    );
  }
  for (const serviceName of ["workspace", "worker"]) {
    candidateCompose.services[serviceName].environment = {
      ...candidateCompose.services[serviceName].environment,
      ...candidateComposeOverride.services[serviceName].environment,
    };
  }
  validateCandidateDocuments({
    goCompose: releaseFixtures.goCompose,
    candidateCompose,
    candidateComposeOverride,
  });

  const networkName = candidateNetworkName(project, commit);
  const containerNames = candidateContainerNames(commit);
  return {
    candidateCompose,
    candidateOverlayPath: overlayPath,
    candidateNetworkName: networkName,
    candidateContainerNames: containerNames,
  };
}

/**
 * Return the only Compose hook needed by release-helper's real
 * `release_start_candidates` path.  The caller must privately write the
 * full `candidateCompose` before sourcing this hook.
 */
function buildPassiveCandidateComposeAdapter({ project, commit, candidateComposePath, candidateOverlayPath }) {
  const safeProject = requireProject(project);
  const safeCommit = requireCommit(commit);
  const basePath = requirePosixAbsolutePath(candidateComposePath, "candidate_compose_path_invalid");
  const overlayPath = requirePosixAbsolutePath(candidateOverlayPath, "candidate_overlay_path_invalid");
  if (!overlayPath.endsWith(`/${GO_CANDIDATE_COMPOSE_OVERLAY_RELATIVE_PATH}`)) {
    invalid("candidate_overlay_path_not_canonical");
  }
  if (basePath === overlayPath) {
    invalid("candidate_compose_paths_must_differ");
  }
  const networkName = candidateNetworkName(safeProject, safeCommit);

  return {
    profile: PASSIVE_CANDIDATE_PROFILE,
    candidateNetworkName: networkName,
    candidateComposePath: basePath,
    candidateOverlayPath: overlayPath,
    reason: "Reuse the real Go candidate overlay over the full private candidate base and reject publish flags.",
    script: [
      "candidate_compose() {",
      `  [[ \"${"${RELEASE_PROFILE_NAME:-}"}\" == ${shellQuote(PASSIVE_CANDIDATE_PROFILE)} ]] || { printf '%s\\n' passive_candidate_profile_invalid >&2; return 1; }`,
      `  [[ \"${"${DUALLANE_GO_CANDIDATE_NETWORK:-}"}\" == ${shellQuote(networkName)} ]] || { printf '%s\\n' passive_candidate_network_invalid >&2; return 1; }`,
      `  [[ -f ${shellQuote(basePath)} && ! -L ${shellQuote(basePath)} ]] || { printf '%s\\n' passive_candidate_compose_missing_or_symlink >&2; return 1; }`,
      `  [[ -f ${shellQuote(overlayPath)} && ! -L ${shellQuote(overlayPath)} ]] || { printf '%s\\n' passive_candidate_overlay_missing_or_symlink >&2; return 1; }`,
      "  local argument",
      "  for argument in \"$@\"; do",
      "    case \"${argument}\" in",
      "      --service-ports|--service-ports=*|-P|--publish-all|--publish-all=*|--publish|--publish=*|-p|-p*)",
      "        printf '%s\\n' passive_candidate_published_ports_forbidden >&2",
      "        return 1",
      "        ;;",
      "    esac",
      "  done",
      `  COMPOSE_DISABLE_ENV_FILE=1 docker compose --project-name ${shellQuote(safeProject)} --profile rollback -f ${shellQuote(basePath)} -f ${shellQuote(overlayPath)} \"$@\"`,
      "}",
    ].join("\n"),
    cleanup: {
      candidateNames: "release-helper",
      network: "release-helper",
      adapterDeletesNothing: true,
    },
  };
}

export {
  GO_CANDIDATE_COMPOSE_OVERLAY_RELATIVE_PATH,
  PASSIVE_CANDIDATE_PROFILE,
  PASSIVE_CANDIDATE_SERVICES,
  PASSIVE_PROVIDER_DISABLED_ENV,
  buildPassiveCandidateComposeAdapter,
  buildPassiveCandidateFixture,
};
