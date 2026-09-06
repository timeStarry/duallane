#!/usr/bin/env bash

# Shared release helpers. The caller owns the Compose
# function and the production preflight; this file only handles the fixed
# release profiles' state transitions.

readonly RELEASE_HELPER_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly RELEASE_MANIFEST_HELPER="${RELEASE_HELPER_DIR}/release-manifest.mjs"
readonly RELEASE_COMPOSE_SNAPSHOT_HELPER="${RELEASE_HELPER_DIR}/release-compose-snapshot.mjs"

RELEASE_PROFILE_NAME=""
RELEASE_SERVICES=()
RELEASE_BUILD_SERVICES=()
RELEASE_CANDIDATE_SERVICES=()
RELEASE_BACKEND_SERVICES=()
RELEASE_WORKER_SERVICES=()
RELEASE_EDGE_SERVICES=()
RELEASE_GO_SERVICES=()
RELEASE_GO_WRITERS=()
RELEASE_STOP_BEFORE_BACKEND=()
RELEASE_SNAPSHOT_SERVICES=()
RELEASE_RESTORE_ORDER=()
RELEASE_ROLLBACK_ORDER=()
RELEASE_HEALTH_REQUIRED=()
RELEASE_REQUIRED_SERVICES=()
RELEASE_CANDIDATE_RECORDS=()
RELEASE_CANDIDATE_NETWORK_NAME=""
RELEASE_SNAPSHOT_FILE=""
RELEASE_RECOVERY_FILE=""
RELEASE_GO_IMAGE_REF=""
RELEASE_GO_IMAGE_ID=""
RELEASE_GO_IMAGE_REVISION=""
RELEASE_GO_IMAGE_VERSION=""
RELEASE_GO_MIGRATION_VERIFIED=false
RELEASE_GO_P2P_IMAGE_ID=""
RELEASE_GO_WEB_IMAGE_ID=""
RELEASE_GO_ACTIVATION_COMPOSE_FILE=""
RELEASE_GO_ACTIVATION_PROJECT=""
RELEASE_GO_ACTIVATION_EXTERNAL_MANIFEST=""
RELEASE_NODE_RECOVERY_COMPOSE_FILE=""
RELEASE_NODE_RECOVERY_EXTERNAL_MANIFEST=""
RELEASE_NODE_RECOVERY_PROJECT=""
RELEASE_DRAIN_CHECK_NUMBER=0
RELEASE_PREVIOUS_NODE_VERSION=""
RELEASE_PREVIOUS_NODE_COMMIT=""
RELEASE_GO_IMAGE_OVERRIDE_FILE=""
RELEASE_GO_RUN_ID=""
RELEASE_GO_UPGRADE_OLD_COMPOSE_FILE=""
RELEASE_GO_UPGRADE_OLD_EXTERNAL_MANIFEST=""
RELEASE_GO_UPGRADE_OLD_VOLUME_MANIFEST=""
RELEASE_GO_UPGRADE_OLD_PROJECT=""
RELEASE_GO_UPGRADE_OLD_COMMIT=""
RELEASE_GO_UPGRADE_OLD_VERSION=""
RELEASE_GO_UPGRADE_OLD_SCHEMA_VERSION=""
RELEASE_GO_UPGRADE_OLD_P2P_IMAGE_ID=""
RELEASE_GO_UPGRADE_OLD_WORKSPACE_IMAGE_ID=""
RELEASE_GO_UPGRADE_OLD_WORKER_IMAGE_ID=""
RELEASE_GO_UPGRADE_OLD_WEB_IMAGE_ID=""
RELEASE_GO_UPGRADE_OLD_MIGRATE_IMAGE_ID=""
RELEASE_GO_UPGRADE_VALIDATED=false
RELEASE_GO_UPGRADE_CURRENT_COMPOSE_FILE=""
RELEASE_GO_UPGRADE_NEW_ATTEMPTED_SERVICES=()
RELEASE_GO_UPGRADE_TEMP_FILES=()
RELEASE_GO_UPGRADE_NEW_SNAPSHOT_FILES=()
RELEASE_GO_UPGRADE_SNAPSHOT_PUBLISHED=false
RELEASE_GO_UPGRADE_DAEMON_RECOVERY_DONE=false
RELEASE_STOP_TIMEOUT="${DUALLANE_DEPLOY_STOP_TIMEOUT:-30}"
RELEASE_STOP_ATTEMPTS="${DUALLANE_DEPLOY_STOP_ATTEMPTS:-30}"
RELEASE_HEALTH_ATTEMPTS="${DUALLANE_DEPLOY_HEALTH_ATTEMPTS:-40}"

release_parse_array() {
  local value="$1"
  if [[ -z "${value}" ]]; then
    REPLY=()
  else
    IFS=',' read -r -a REPLY <<<"${value}"
  fi
}

version_is_greater() {
  local candidate="$1" current="$2"
  [[ "${candidate}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "${current}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  # Decimal strings avoid shell arithmetic overflow on malformed release
  # metadata. The repository only publishes three-component numeric versions.
  node -e '
    const a = process.argv[1].split(".").map(BigInt);
    const b = process.argv[2].split(".").map(BigInt);
    for (let i = 0; i < 3; i++) {
      if (a[i] !== b[i]) process.exit(a[i] > b[i] ? 0 : 1);
    }
    process.exit(1);
  ' "${candidate}" "${current}"
}

release_load_profile() {
  local profile="$1"
  local plan line key value
  if ! plan="$(node "${RELEASE_MANIFEST_HELPER}" --profile "${profile}" --format shell)"; then
    return 1
  fi

  RELEASE_PROFILE_NAME=""
  RELEASE_SERVICES=()
  RELEASE_BUILD_SERVICES=()
  RELEASE_CANDIDATE_SERVICES=()
  RELEASE_BACKEND_SERVICES=()
  RELEASE_WORKER_SERVICES=()
  RELEASE_EDGE_SERVICES=()
  RELEASE_GO_SERVICES=()
  RELEASE_GO_WRITERS=()
  RELEASE_STOP_BEFORE_BACKEND=()
  RELEASE_SNAPSHOT_SERVICES=()
  RELEASE_RESTORE_ORDER=()
  RELEASE_ROLLBACK_ORDER=()
  RELEASE_HEALTH_REQUIRED=()
  RELEASE_REQUIRED_SERVICES=()
  RELEASE_GO_IMAGE_REF=""
  RELEASE_GO_IMAGE_ID=""
  RELEASE_GO_IMAGE_REVISION=""
  RELEASE_GO_IMAGE_VERSION=""
  RELEASE_GO_MIGRATION_VERIFIED=false
  RELEASE_GO_P2P_IMAGE_ID=""
  RELEASE_GO_WEB_IMAGE_ID=""
  RELEASE_GO_ACTIVATION_COMPOSE_FILE=""
  RELEASE_GO_ACTIVATION_PROJECT=""
  RELEASE_GO_ACTIVATION_EXTERNAL_MANIFEST=""
  RELEASE_NODE_RECOVERY_COMPOSE_FILE=""
  RELEASE_NODE_RECOVERY_EXTERNAL_MANIFEST=""
  RELEASE_NODE_RECOVERY_PROJECT=""
  RELEASE_DRAIN_CHECK_NUMBER=0
  RELEASE_PREVIOUS_NODE_VERSION=""
  RELEASE_PREVIOUS_NODE_COMMIT=""
  RELEASE_GO_IMAGE_OVERRIDE_FILE=""
  RELEASE_GO_RUN_ID=""
  RELEASE_GO_UPGRADE_OLD_COMPOSE_FILE=""
  RELEASE_GO_UPGRADE_OLD_EXTERNAL_MANIFEST=""
  RELEASE_GO_UPGRADE_OLD_VOLUME_MANIFEST=""
  RELEASE_GO_UPGRADE_OLD_PROJECT=""
  RELEASE_GO_UPGRADE_OLD_COMMIT=""
  RELEASE_GO_UPGRADE_OLD_VERSION=""
  RELEASE_GO_UPGRADE_OLD_SCHEMA_VERSION=""
  RELEASE_GO_UPGRADE_OLD_P2P_IMAGE_ID=""
  RELEASE_GO_UPGRADE_OLD_WORKSPACE_IMAGE_ID=""
  RELEASE_GO_UPGRADE_OLD_WORKER_IMAGE_ID=""
  RELEASE_GO_UPGRADE_OLD_WEB_IMAGE_ID=""
  RELEASE_GO_UPGRADE_OLD_MIGRATE_IMAGE_ID=""
  RELEASE_GO_UPGRADE_VALIDATED=false
  RELEASE_GO_UPGRADE_CURRENT_COMPOSE_FILE=""
  RELEASE_GO_UPGRADE_NEW_ATTEMPTED_SERVICES=()
  RELEASE_GO_UPGRADE_TEMP_FILES=()
  RELEASE_GO_UPGRADE_NEW_SNAPSHOT_FILES=()
  RELEASE_GO_UPGRADE_SNAPSHOT_PUBLISHED=false
  RELEASE_GO_UPGRADE_DAEMON_RECOVERY_DONE=false

  while IFS= read -r line; do
    [[ -n "${line}" ]] || continue
    key="${line%%=*}"
    value="${line#*=}"
    case "${key}" in
      PROFILE)
        RELEASE_PROFILE_NAME="${value}"
        ;;
      SERVICES)
        release_parse_array "${value}"
        RELEASE_SERVICES=("${REPLY[@]}")
        ;;
      BUILD_SERVICES)
        release_parse_array "${value}"
        RELEASE_BUILD_SERVICES=("${REPLY[@]}")
        ;;
      CANDIDATE_SERVICES)
        release_parse_array "${value}"
        RELEASE_CANDIDATE_SERVICES=("${REPLY[@]}")
        ;;
      BACKEND_SERVICES)
        release_parse_array "${value}"
        RELEASE_BACKEND_SERVICES=("${REPLY[@]}")
        ;;
      WORKER_SERVICES)
        release_parse_array "${value}"
        RELEASE_WORKER_SERVICES=("${REPLY[@]}")
        ;;
      EDGE_SERVICES)
        release_parse_array "${value}"
        RELEASE_EDGE_SERVICES=("${REPLY[@]}")
        ;;
      GO_SERVICES)
        release_parse_array "${value}"
        RELEASE_GO_SERVICES=("${REPLY[@]}")
        ;;
      GO_WRITERS)
        release_parse_array "${value}"
        RELEASE_GO_WRITERS=("${REPLY[@]}")
        ;;
      STOP_BEFORE_BACKEND)
        release_parse_array "${value}"
        RELEASE_STOP_BEFORE_BACKEND=("${REPLY[@]}")
        ;;
      SNAPSHOT_SERVICES)
        release_parse_array "${value}"
        RELEASE_SNAPSHOT_SERVICES=("${REPLY[@]}")
        ;;
      RESTORE_ORDER)
        release_parse_array "${value}"
        RELEASE_RESTORE_ORDER=("${REPLY[@]}")
        ;;
      ROLLBACK_ORDER)
        release_parse_array "${value}"
        RELEASE_ROLLBACK_ORDER=("${REPLY[@]}")
        ;;
      HEALTH_REQUIRED)
        release_parse_array "${value}"
        RELEASE_HEALTH_REQUIRED=("${REPLY[@]}")
        ;;
      REQUIRED_SERVICES)
        release_parse_array "${value}"
        RELEASE_REQUIRED_SERVICES=("${REPLY[@]}")
        ;;
      *)
        echo "release manifest emitted an unknown field: ${key}" >&2
        return 1
        ;;
    esac
  done <<<"${plan}"

  [[ "${RELEASE_PROFILE_NAME}" == "${profile}" ]] || {
    echo "release manifest profile mismatch" >&2
    return 1
  }
}

release_validate_resolved_compose() {
  compose config --format json | node "${RELEASE_MANIFEST_HELPER}" --profile "${RELEASE_PROFILE_NAME}" --check-compose
}

release_pin_compose_project() {
  local resolved
  resolved="$(compose config --format json | node -e '
    try {
      const data = require("node:fs").readFileSync(0, "utf8");
      const name = JSON.parse(data).name;
      if (typeof name !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(name)) process.exit(1);
      process.stdout.write(name);
    } catch { process.exit(1); }
  ')" || {
    echo "could not pin the resolved Compose project identity" >&2
    return 1
  }
  # Includes Compose's --env-file/project-name resolution. The directory
  # basename is not proof of the project which owns the current containers.
  export COMPOSE_PROJECT_NAME="${resolved}"
}

release_private_artifact_path() {
  local path="$1"
  local label="${2:-artifact}"
  local mode
  [[ "${path}" == /* && "${path}" != *$'\n'* && "${path}" != *$'\r'* && "${path}" != *$'\t'* ]] || {
    echo "${label} path must be an absolute path without control characters" >&2
    return 1
  }
  [[ -f "${path}" && ! -L "${path}" ]] || {
    echo "${label} must be a regular non-symlink file" >&2
    return 1
  }
  if ! mode="$(stat -c '%a' -- "${path}" 2>/dev/null)"; then
    echo "could not inspect ${label} permissions" >&2
    return 1
  fi
  [[ "${mode}" == 600 ]] || {
    echo "${label} must have mode 0600" >&2
    return 1
  }
}

release_private_new_artifact_path() {
  local path="$1"
  local label="${2:-artifact}"
  [[ "${path}" == /* && "${path}" != *$'\n'* && "${path}" != *$'\r'* && "${path}" != *$'\t'* ]] || {
    echo "${label} path must be an absolute path without control characters" >&2
    return 1
  }
  if [[ -e "${path}" || -L "${path}" ]]; then
    echo "refusing to overwrite existing ${label}" >&2
    return 1
  fi
}

release_external_files_helper_path() {
  local helper_path="${RELEASE_EXTERNAL_FILES_HELPER:-${RELEASE_HELPER_DIR}/release-external-files.mjs}"
  [[ "${helper_path}" == /* && "${helper_path}" != *$'\n'* && "${helper_path}" != *$'\r'* && "${helper_path}" != *$'\t'* ]] || {
    echo "external-files helper path is not an absolute safe path" >&2
    return 1
  }
  [[ -f "${helper_path}" && ! -L "${helper_path}" ]] || {
    echo "external-files helper is unavailable; Go recovery is disabled" >&2
    return 1
  }
  printf '%s\n' "${helper_path}"
}

release_verify_external_files_manifest() {
  local compose_file="$1"
  local manifest_file="$2"
  local helper_path
  release_private_artifact_path "${compose_file}" "canonical recovery Compose" || return 1
  release_private_artifact_path "${manifest_file}" "external-files manifest" || return 1
  helper_path="$(release_external_files_helper_path)" || return 1
  node "${helper_path}" verify \
    --compose "${compose_file}" \
    --input "${manifest_file}" >/dev/null 2>/dev/null || {
    echo "external-file verification rejected the selected Go recovery snapshot" >&2
    return 1
  }
}

release_validate_go_snapshot_sidecars() {
  local snapshot_file="$1"
  local compose_file="${snapshot_file}.compose.json"
  local verification_file="${compose_file}.verify.${BASHPID}.json"
  release_private_artifact_path "${snapshot_file}" "previous Go snapshot" || return 1
  release_private_artifact_path "${compose_file}" "previous canonical recovery Compose" || return 1
  release_private_artifact_path "${snapshot_file}.volumes.json" "previous volume authority manifest" || return 1
  release_private_new_artifact_path "${verification_file}" "snapshot verification Compose" || return 1

  if ! node "${RELEASE_COMPOSE_SNAPSHOT_HELPER}" recover \
    --input "${snapshot_file}" \
    --output "${verification_file}" >/dev/null 2>/dev/null; then
    rm -f -- "${verification_file}"
    echo "previous Go snapshot could not be recovered" >&2
    return 1
  fi
  if ! cmp -s -- "${verification_file}" "${compose_file}"; then
    rm -f -- "${verification_file}"
    echo "previous Go recovery Compose differs from the pinned snapshot" >&2
    return 1
  fi
  rm -f -- "${verification_file}"
  release_verify_external_files_manifest "${compose_file}" "${snapshot_file}.external.json"
}

release_read_go_snapshot_metadata() {
  local snapshot_file="$1"
  RELEASE_SNAPSHOT_HELPER_PATH="${RELEASE_COMPOSE_SNAPSHOT_HELPER}" node --input-type=module - "${snapshot_file}" <<'NODE'
import { pathToFileURL } from "node:url";

const helperPath = process.env.RELEASE_SNAPSHOT_HELPER_PATH;
const snapshotPath = process.argv[2];
try {
  const { readSnapshot } = await import(pathToFileURL(helperPath).href);
  const snapshot = await readSnapshot(snapshotPath);
  const ids = snapshot.imageIDs;
  process.stdout.write([
    snapshot.project,
    snapshot.commit,
    snapshot.semver,
    String(snapshot.schemaVersion),
    ids.p2p,
    ids.workspace,
    ids.worker,
    ids.web,
    ids.migrate,
  ].join("\t") + "\n");
} catch {
  process.exitCode = 1;
}
NODE
}

release_prepare_current_go_compose_artifact() {
  local destination="$1"
  release_private_new_artifact_path "${destination}" "current resolved Compose" || return 1
  umask 077
  if ! compose config --format json >"${destination}"; then
    rm -f -- "${destination}"
    echo "could not capture the current resolved Compose configuration" >&2
    return 1
  fi
  if ! chmod 600 -- "${destination}" || ! release_private_artifact_path "${destination}" "current resolved Compose"; then
    rm -f -- "${destination}"
    return 1
  fi
}

release_freeze_go_activation_compose() {
  [[ "${RELEASE_PROFILE_NAME}" == go-full ]] || return 0
  [[ -z "${RELEASE_GO_ACTIVATION_COMPOSE_FILE}" ]] || return 0
  local artifact="${RELEASE_RECOVERY_FILE}.go-activation.compose.json"
  local project
  project="$(release_compose_project_name)" || return 1
  release_prepare_current_go_compose_artifact "${artifact}" || return 1
  # All post-build operations use this resolved, image-pinned configuration;
  # later edits of .env cannot silently move the writer or checker authority.
  RELEASE_GO_ACTIVATION_COMPOSE_FILE="${artifact}"
  RELEASE_GO_ACTIVATION_PROJECT="${project}"
  RELEASE_GO_ACTIVATION_EXTERNAL_MANIFEST="${artifact}.external.json"
  node "${RELEASE_HELPER_DIR}/release-external-files.mjs" capture \
    --compose "${artifact}" --services p2p,workspace,worker,web,migrate \
    --output "${RELEASE_GO_ACTIVATION_EXTERNAL_MANIFEST}" >/dev/null || return 1
}

release_freeze_node_recovery_compose() {
  [[ "${RELEASE_PROFILE_NAME}" == go-full && "${RELEASE_GO_UPGRADE:-false}" != true ]] || return 0
  local raw="${RELEASE_RECOVERY_FILE}.node-resolved.compose.json"
  local frozen="${RELEASE_RECOVERY_FILE}.node-recovery.compose.json"
  release_private_new_artifact_path "${raw}" "Node resolved Compose" || return 1
  release_private_new_artifact_path "${frozen}" "Node recovery Compose" || return 1
  umask 077
  release_rollback_compose config --format json >"${raw}" || return 1
  RELEASE_PRIVATE_JSON_HELPER="${RELEASE_HELPER_DIR}/release-drain-config.mjs" \
    node --input-type=module - "${raw}" "${frozen}" "${RELEASE_SNAPSHOT_FILE}" <<'NODE'
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
try {
  const { readPrivateJSON, writePrivateJSON } = await import(pathToFileURL(process.env.RELEASE_PRIVATE_JSON_HELPER));
  const [source, output, snapshot] = process.argv.slice(2);
  const compose = await readPrivateJSON(source, "node_compose");
  const rows = (await readFile(snapshot, "utf8")).trim().split("\n").map(row => row.split("\t"));
  for (const service of ["api", "web"]) {
    const matches = rows.filter(row => row[0] === service);
    if (matches.length !== 1 || matches[0][4] !== "true" || !/^sha256:[0-9a-f]{64}$/.test(matches[0][2]) || !compose.services?.[service]) throw new Error();
    compose.services[service].image = matches[0][2];
    delete compose.services[service].build;
    compose.services[service].pull_policy = "never";
  }
  await writePrivateJSON(output, compose);
} catch { process.stderr.write("Node recovery Compose could not be pinned\n"); process.exitCode = 1; }
NODE
  local result=$?
  [[ "${result}" == 0 ]] || return 1
  RELEASE_NODE_RECOVERY_COMPOSE_FILE="${frozen}"
  RELEASE_NODE_RECOVERY_PROJECT="$(release_compose_project_name)" || return 1
  RELEASE_NODE_RECOVERY_EXTERNAL_MANIFEST="${frozen}.external.json"
  node "${RELEASE_HELPER_DIR}/release-external-files.mjs" capture \
    --compose "${frozen}" --services api,web \
    --output "${RELEASE_NODE_RECOVERY_EXTERNAL_MANIFEST}" >/dev/null || return 1
}

release_verify_activation_authority() {
  [[ "${RELEASE_PROFILE_NAME}" == go-full ]] || return 0
  release_verify_external_files_manifest "${RELEASE_GO_ACTIVATION_COMPOSE_FILE}" \
    "${RELEASE_GO_ACTIVATION_EXTERNAL_MANIFEST}" || return 1
  if [[ "${RELEASE_GO_UPGRADE:-false}" == true ]]; then
    release_verify_pinned_volume_authority "${RELEASE_GO_UPGRADE_OLD_COMPOSE_FILE}" \
      "${RELEASE_GO_ACTIVATION_COMPOSE_FILE}" || return 1
  else
    release_verify_external_files_manifest "${RELEASE_NODE_RECOVERY_COMPOSE_FILE}" \
      "${RELEASE_NODE_RECOVERY_EXTERNAL_MANIFEST}" || return 1
    node "${RELEASE_HELPER_DIR}/release-node-authority.mjs" verify \
      --compose "${RELEASE_GO_ACTIVATION_COMPOSE_FILE}" \
      --node-compose "${RELEASE_NODE_RECOVERY_COMPOSE_FILE}" >/dev/null || return 1
  fi
}

release_require_drained_runtime() {
  [[ "${RELEASE_PROFILE_NAME}" == go-full ]] || return 0
  local phase="$1"
  [[ "${phase}" == activation || "${phase}" == recovery ]] || return 1
  release_verify_activation_authority || return 1
  RELEASE_DRAIN_CHECK_NUMBER=$((RELEASE_DRAIN_CHECK_NUMBER + 1))
  local artifact="${RELEASE_RECOVERY_FILE}.drain-${phase}-${RELEASE_DRAIN_CHECK_NUMBER}"
  node "${RELEASE_HELPER_DIR}/release-drain-run.mjs" run \
    --compose "${RELEASE_GO_ACTIVATION_COMPOSE_FILE}" \
    --workspace-image "${RELEASE_GO_IMAGE_ID}" \
    --output "${artifact}.compose.json" --report "${artifact}.report.json" \
    --run-id "${RELEASE_GO_RUN_ID}" >/dev/null || {
      echo "Release drain is blocked or failed; keep writers fenced and reconcile the private report before recovery" >&2
      return 1
    }
  release_verify_activation_authority || return 1
  release_append_recovery_record "drain_${phase}=ready" || return 1
}

release_run_gateway_smoke() {
  local profile="$1" version="$2" commit="$3"
  local web_ids web_id base_url observed_version observed_commit
  [[ "${version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "${commit}" =~ ^[0-9a-f]{40}$ ]] || {
    echo "gateway smoke requires verified release metadata" >&2
    return 1
  }
  web_ids="$(release_current_service_ids web)" || return 1
  release_go_upgrade_require_single_current_id web "${web_ids}" || return 1
  web_id="${REPLY}"
  release_verify_fence_owner web "${web_id}" || return 1
  observed_version="$(docker inspect "${web_id}" --format '{{index .Config.Labels "org.opencontainers.image.version"}}' 2>/dev/null)" || return 1
  observed_commit="$(docker inspect "${web_id}" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null)" || return 1
  [[ "${observed_version}" == "${version}" && "${observed_commit}" == "${commit}" ]] || {
    echo "gateway release metadata differs from the expected release" >&2
    return 1
  }
  # Resolve the actual local published port, not an operator-controlled URL
  # that could point to another release. The probe cannot follow redirects.
  base_url="$(docker inspect "${web_id}" --format '{{json .NetworkSettings.Ports}}' 2>/dev/null | node -e '
    try {
      const ports = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
      const bindings = ports["8080/tcp"];
      if (!Array.isArray(bindings) || bindings.length !== 1) process.exit(1);
      const { HostIp, HostPort } = bindings[0];
      if (!/^[0-9]+$/.test(HostPort) || Number(HostPort) < 1 || Number(HostPort) > 65535) process.exit(1);
      const host = HostIp === "0.0.0.0" || HostIp === "127.0.0.1" ? "127.0.0.1" :
        HostIp === "::" || HostIp === "::1" ? "[::1]" : null;
      if (!host) process.exit(1);
      process.stdout.write(`http://${host}:${HostPort}`);
    } catch { process.exit(1); }
  ')" || {
    echo "gateway smoke requires one supported local application binding" >&2
    return 1
  }
  local enabled=true api_ids
  if [[ "${profile}" == node-default ]]; then
    api_ids="$(release_current_service_ids api)" || return 1
    release_go_upgrade_require_single_current_id api "${api_ids}" || return 1
    enabled="$(docker inspect "${REPLY}" --format '{{json .Config.Env}}' 2>/dev/null | node -e '
      try {
        const env = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
        if (!Array.isArray(env)) process.exit(1);
        const values = env.filter((v) => typeof v === "string" && v.startsWith("WORKSPACE_ENABLED="));
        if (values.length > 1) process.exit(1);
        process.stdout.write(values[0] === "WORKSPACE_ENABLED=true" ? "true" : "false");
      } catch { process.exit(1); }
    ')" || return 1
  fi
  node "${RELEASE_HELPER_DIR}/../../scripts/backend/gateway-readonly-smoke.mjs" \
    --base-url "${base_url}" --expected-version "${version}" --full-commit "${commit}" \
    --profile "${profile}" --workspace-enabled "${enabled}" || return 1
  release_append_recovery_record "gateway_smoke_passed=${profile}:${commit}"
}

release_run_previous_gateway_smoke() {
  [[ "${RELEASE_PROFILE_NAME}" == go-full ]] || return 0
  if [[ "${RELEASE_GO_UPGRADE:-false}" == true ]]; then
    release_run_gateway_smoke go-full "${RELEASE_GO_UPGRADE_OLD_VERSION}" "${RELEASE_GO_UPGRADE_OLD_COMMIT}"
  else
    release_run_gateway_smoke node-default "${RELEASE_PREVIOUS_NODE_VERSION}" "${RELEASE_PREVIOUS_NODE_COMMIT}"
  fi
}

release_verify_go_upgrade_storage_authority() {
  local previous_compose="$1"
  local current_compose="$2"
  if declare -F release_verify_pinned_volume_authority >/dev/null 2>&1; then
    release_verify_pinned_volume_authority "${previous_compose}" "${current_compose}" || {
      echo "named-volume authority differs between the previous Go release and the candidate" >&2
      return 1
    }
    return 0
  fi
  echo "named-volume authority verifier is unavailable; refusing Go-to-Go recovery" >&2
  return 1
}

release_capture_go_volume_authority() {
  node "${RELEASE_HELPER_DIR}/release-volume-authority.mjs" capture \
    --compose "$1" --output "$2" >/dev/null || return 1
}

release_verify_pinned_volume_authority() {
  [[ -n "${RELEASE_GO_UPGRADE_OLD_VOLUME_MANIFEST}" ]] || {
    echo "previous volume authority manifest is unavailable" >&2
    return 1
  }
  node "${RELEASE_HELPER_DIR}/release-volume-authority.mjs" verify \
    --previous-compose "$1" --current-compose "$2" \
    --input "${RELEASE_GO_UPGRADE_OLD_VOLUME_MANIFEST}" >/dev/null || return 1
}

release_capture_successful_go_snapshot() {
  [[ "${RELEASE_PROFILE_NAME}" == go-full ]] || return 0
  local input_file snapshot_file compose_file external_file volume_file project schema_version
  local p2p_image workspace_image worker_image web_image migrate_image
  input_file="${RELEASE_RECOVERY_FILE}.go-success.snapshot-input.json"
  snapshot_file="${RELEASE_RECOVERY_FILE}.go-compose.snapshot.json"
  compose_file="${snapshot_file}.compose.json"
  external_file="${snapshot_file}.external.json"
  volume_file="${snapshot_file}.volumes.json"

  release_private_new_artifact_path "${input_file}" "Go snapshot capture input" || return 1
  release_private_new_artifact_path "${snapshot_file}" "Go success snapshot" || return 1
  release_private_new_artifact_path "${compose_file}" "Go recovery Compose" || return 1
  release_private_new_artifact_path "${external_file}" "Go external-files manifest" || return 1
  release_private_new_artifact_path "${volume_file}" "Go volume authority manifest" || return 1
  RELEASE_GO_UPGRADE_TEMP_FILES+=("${input_file}")
  RELEASE_GO_UPGRADE_NEW_SNAPSHOT_FILES+=("${snapshot_file}" "${compose_file}" "${external_file}" "${volume_file}")

  local resolved_compose="${RELEASE_RECOVERY_FILE}.go-success.resolved.compose.json"
  release_private_new_artifact_path "${resolved_compose}" "Go success resolved Compose" || return 1
  release_prepare_current_go_compose_artifact "${resolved_compose}" || return 1
  RELEASE_GO_UPGRADE_TEMP_FILES+=("${resolved_compose}")

  p2p_image="$(release_current_go_service_image_id p2p)" || return 1
  workspace_image="$(release_current_go_service_image_id workspace)" || return 1
  worker_image="$(release_current_go_service_image_id worker)" || return 1
  web_image="$(release_current_go_service_image_id web)" || return 1
  migrate_image="${RELEASE_GO_IMAGE_ID}"
  [[ "${workspace_image}" == "${RELEASE_GO_IMAGE_ID}" && "${worker_image}" == "${RELEASE_GO_IMAGE_ID}" && "${migrate_image}" == "${RELEASE_GO_IMAGE_ID}" ]] || {
    echo "active Workspace, worker, and migrate images are not the verified Go image" >&2
    return 1
  }
  [[ "${p2p_image}" =~ ^sha256:[0-9a-f]{64}$ && "${web_image}" =~ ^sha256:[0-9a-f]{64}$ ]] || {
    echo "active Go edge image identity is not canonical" >&2
    return 1
  }
  project="$(release_compose_project_name)" || return 1
  schema_version="$(release_current_schema_version)" || return 1
  [[ "${schema_version}" =~ ^[0-9]+$ ]] || return 1

  CAPTURE_INPUT_PATH="${input_file}" \
  CAPTURE_COMPOSE_PATH="${resolved_compose}" \
  CAPTURE_P2P_IMAGE="${p2p_image}" \
  CAPTURE_WORKSPACE_IMAGE="${workspace_image}" \
  CAPTURE_WORKER_IMAGE="${worker_image}" \
  CAPTURE_WEB_IMAGE="${web_image}" \
  CAPTURE_MIGRATE_IMAGE="${migrate_image}" \
  CAPTURE_PROJECT="${project}" \
  CAPTURE_COMMIT="${current_commit}" \
  CAPTURE_VERSION="${expected_app_version}" \
  CAPTURE_SCHEMA_VERSION="${schema_version}" \
  node --input-type=module - <<'NODE'
import { readFile, writeFile } from "node:fs/promises";

const compose = JSON.parse(await readFile(process.env.CAPTURE_COMPOSE_PATH, "utf8"));
const input = {
  compose,
  imageIDs: {
    p2p: process.env.CAPTURE_P2P_IMAGE,
    workspace: process.env.CAPTURE_WORKSPACE_IMAGE,
    worker: process.env.CAPTURE_WORKER_IMAGE,
    web: process.env.CAPTURE_WEB_IMAGE,
    migrate: process.env.CAPTURE_MIGRATE_IMAGE,
  },
  profile: "go-full",
  project: process.env.CAPTURE_PROJECT,
  commit: process.env.CAPTURE_COMMIT,
  semver: process.env.CAPTURE_VERSION,
  schemaVersion: Number(process.env.CAPTURE_SCHEMA_VERSION),
};
await writeFile(process.env.CAPTURE_INPUT_PATH, JSON.stringify(input) + "\n", {
  encoding: "utf8",
  flag: "wx",
  mode: 0o600,
});
NODE
  chmod 600 "${input_file}" || return 1
  node "${RELEASE_COMPOSE_SNAPSHOT_HELPER}" capture --input "${input_file}" --output "${snapshot_file}" >/dev/null || return 1
  node "${RELEASE_COMPOSE_SNAPSHOT_HELPER}" recover --input "${snapshot_file}" --output "${compose_file}" >/dev/null || return 1
  local external_helper
  external_helper="$(release_external_files_helper_path)" || return 1
  node "${external_helper}" capture \
    --compose "${compose_file}" \
    --services p2p,workspace,worker,web,migrate \
    --output "${external_file}" >/dev/null || return 1
  release_capture_go_volume_authority "${compose_file}" "${volume_file}" || return 1
  release_validate_go_snapshot_sidecars "${snapshot_file}" || return 1
  rm -f -- "${input_file}" "${resolved_compose}"
  release_append_recovery_record "go_upgrade_success_snapshot=${snapshot_file}" || return 1
  RELEASE_GO_UPGRADE_SNAPSHOT_PUBLISHED=true
}

release_cleanup_go_upgrade_artifacts() {
  local path
  for path in "${RELEASE_GO_UPGRADE_TEMP_FILES[@]}"; do
    [[ -n "${path}" && -f "${path}" && ! -L "${path}" ]] || continue
    rm -f -- "${path}"
  done
  # A published successful-release snapshot is durable operator evidence.
  [[ "${RELEASE_GO_UPGRADE_SNAPSHOT_PUBLISHED}" != true ]] || return 0
  for path in "${RELEASE_GO_UPGRADE_NEW_SNAPSHOT_FILES[@]}"; do
    [[ -n "${path}" && -f "${path}" && ! -L "${path}" ]] || continue
    rm -f -- "${path}"
  done
}

release_go_upgrade_old_image_id() {
  local service="$1"
  case "${service}" in
    p2p) printf '%s\n' "${RELEASE_GO_UPGRADE_OLD_P2P_IMAGE_ID}" ;;
    workspace) printf '%s\n' "${RELEASE_GO_UPGRADE_OLD_WORKSPACE_IMAGE_ID}" ;;
    worker) printf '%s\n' "${RELEASE_GO_UPGRADE_OLD_WORKER_IMAGE_ID}" ;;
    web) printf '%s\n' "${RELEASE_GO_UPGRADE_OLD_WEB_IMAGE_ID}" ;;
    migrate) printf '%s\n' "${RELEASE_GO_UPGRADE_OLD_MIGRATE_IMAGE_ID}" ;;
    *)
      echo "no pinned previous Go image is defined for ${service}" >&2
      return 1
      ;;
  esac
}

release_go_upgrade_service_is_managed() {
  case "$1" in
    p2p|workspace|worker|web) return 0 ;;
    *) return 1 ;;
  esac
}

release_go_upgrade_require_single_current_id() {
  local service="$1"
  local ids="$2"
  [[ -n "${ids}" && "${ids}" != *$'\n'* ]] || {
    echo "Go-to-Go recovery requires exactly one ${service} container" >&2
    return 1
  }
  REPLY="${ids}"
}

release_go_upgrade_verify_owner_container() {
  local service="$1"
  local container_id="$2"
  local expected_image="$3"
  local expected_commit="$4"
  local identity image revision version running
  if ! identity="$(docker inspect "${container_id}" --format '{{.Id}}' 2>/dev/null)"; then
    echo "could not inspect the ${service} Go owner identity" >&2
    return 1
  fi
  [[ "${identity}" =~ ^[0-9a-f]{64}$ ]] || {
    echo "${service} Go owner identity is not canonical" >&2
    return 1
  }
  release_verify_fence_owner "${service}" "${identity}" || return 1
  if ! image="$(docker inspect "${identity}" --format '{{.Image}}' 2>/dev/null)"; then
    echo "could not inspect the ${service} Go owner image" >&2
    return 1
  fi
  [[ "${image}" == "${expected_image}" ]] || {
    echo "${service} Go owner image differs from its pinned previous image" >&2
    return 1
  }
  if ! revision="$(docker inspect "${identity}" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null)"; then
    echo "could not inspect the ${service} Go owner revision" >&2
    return 1
  fi
  [[ "${revision}" == "${expected_commit}" ]] || {
    echo "${service} Go owner revision differs from the previous release" >&2
    return 1
  }
  if ! version="$(docker inspect "${identity}" --format '{{index .Config.Labels "org.opencontainers.image.version"}}' 2>/dev/null)" ||
    [[ "${version}" != "${RELEASE_GO_UPGRADE_OLD_VERSION}" ]]; then
    echo "${service} Go owner version differs from the previous release" >&2
    return 1
  fi
  if ! running="$(docker inspect "${identity}" --format '{{.State.Running}}' 2>/dev/null)"; then
    echo "could not inspect the ${service} Go owner state" >&2
    return 1
  fi
  [[ "${running}" == true ]] || {
    echo "previous ${service} Go owner is not running" >&2
    return 1
  }
  REPLY="${identity}"
}

release_go_upgrade_previous_owner_record() {
  local wanted_service="$1"
  local kind service identity image_id commit
  local found=0
  [[ -f "${RELEASE_RECOVERY_FILE:-}" ]] || return 1
  while IFS=$'\t' read -r kind service identity image_id commit; do
    [[ "${kind}" == go_upgrade_old_owner && "${service}" == "${wanted_service}" ]] || continue
    found=$((found + 1))
    REPLY="${identity}"$'\t'"${image_id}"$'\t'"${commit}"
  done <"${RELEASE_RECOVERY_FILE}"
  [[ "${found}" == 1 ]]
}

release_go_upgrade_verify_previous_owners() {
  local service ids expected_image identity recorded_identity recorded_image recorded_commit
  for service in p2p workspace worker web; do
    if ! ids="$(release_current_service_ids "${service}")"; then
      echo "could not inspect the previous ${service} Go owner" >&2
      return 1
    fi
    release_go_upgrade_require_single_current_id "${service}" "${ids}" || return 1
    identity="${REPLY}"
    expected_image="$(release_go_upgrade_old_image_id "${service}")" || return 1
    release_go_upgrade_verify_owner_container "${service}" "${identity}" "${expected_image}" "${RELEASE_GO_UPGRADE_OLD_COMMIT}" || return 1
    if release_go_upgrade_previous_owner_record "${service}"; then
      IFS=$'\t' read -r recorded_identity recorded_image recorded_commit <<<"${REPLY}"
      [[ "${recorded_identity}" == "${identity}" && "${recorded_image}" == "${expected_image}" && "${recorded_commit}" == "${RELEASE_GO_UPGRADE_OLD_COMMIT}" ]] || {
        echo "previous ${service} Go owner identity changed before fencing" >&2
        return 1
      }
    else
      release_append_recovery_record $'go_upgrade_old_owner\t'"${service}"$'\t'"${identity}"$'\t'"${expected_image}"$'\t'"${RELEASE_GO_UPGRADE_OLD_COMMIT}" || return 1
    fi
  done
}

release_prepare_go_upgrade_snapshot() {
  [[ "${RELEASE_PROFILE_NAME}" == go-full && "${RELEASE_GO_UPGRADE:-false}" == true ]] || return 0
  [[ "${RELEASE_GO_UPGRADE_VALIDATED}" != true ]] || return 0
  local snapshot_file="${RELEASE_PREVIOUS_RELEASE_SNAPSHOT:-}"
  local metadata previous_project previous_commit previous_version previous_schema
  local previous_p2p previous_workspace previous_worker previous_web previous_migrate
  local current_project current_compose_file api_ids api_id api_running
  [[ -n "${snapshot_file}" ]] || {
    echo "Go-to-Go requires --previous-release-snapshot" >&2
    return 1
  }
  release_validate_go_snapshot_sidecars "${snapshot_file}" || return 1
  if ! metadata="$(release_read_go_snapshot_metadata "${snapshot_file}")"; then
    echo "previous Go snapshot metadata could not be read safely" >&2
    return 1
  fi
  IFS=$'\t' read -r previous_project previous_commit previous_version previous_schema \
    previous_p2p previous_workspace previous_worker previous_web previous_migrate <<<"${metadata}"
  [[ -n "${previous_project}" && -n "${previous_commit}" && -n "${previous_version}" && -n "${previous_schema}" && \
    -n "${previous_p2p}" && -n "${previous_workspace}" && -n "${previous_worker}" && -n "${previous_web}" && -n "${previous_migrate}" ]] || {
    echo "previous Go snapshot metadata is incomplete" >&2
    return 1
  }
  current_project="$(release_compose_project_name)" || return 1
  [[ "${previous_project}" == "${current_project}" ]] || {
    echo "previous Go snapshot belongs to a different Compose project" >&2
    return 1
  }
  [[ "${previous_commit}" != "${current_commit}" ]] || {
    echo "Go-to-Go requires a different previous release commit" >&2
    return 1
  }
  [[ "${previous_commit}" =~ ^[0-9a-f]{40}$ ]] || {
    echo "previous Go snapshot commit is malformed" >&2
    return 1
  }
  if ! version_is_greater "${expected_app_version}" "${previous_version}"; then
    echo "Go release version must be newer than the pinned previous Go version" >&2
    return 1
  fi

  RELEASE_GO_UPGRADE_OLD_PROJECT="${previous_project}"
  RELEASE_GO_UPGRADE_OLD_COMMIT="${previous_commit}"
  RELEASE_GO_UPGRADE_OLD_VERSION="${previous_version}"
  RELEASE_GO_UPGRADE_OLD_SCHEMA_VERSION="${previous_schema}"
  RELEASE_GO_UPGRADE_OLD_P2P_IMAGE_ID="${previous_p2p}"
  RELEASE_GO_UPGRADE_OLD_WORKSPACE_IMAGE_ID="${previous_workspace}"
  RELEASE_GO_UPGRADE_OLD_WORKER_IMAGE_ID="${previous_worker}"
  RELEASE_GO_UPGRADE_OLD_WEB_IMAGE_ID="${previous_web}"
  RELEASE_GO_UPGRADE_OLD_MIGRATE_IMAGE_ID="${previous_migrate}"
  RELEASE_GO_UPGRADE_OLD_COMPOSE_FILE="${snapshot_file}.compose.json"
  RELEASE_GO_UPGRADE_OLD_EXTERNAL_MANIFEST="${snapshot_file}.external.json"
  RELEASE_GO_UPGRADE_OLD_VOLUME_MANIFEST="${snapshot_file}.volumes.json"

  current_compose_file="${RELEASE_RECOVERY_FILE}.go-upgrade.current.compose.json"
  release_prepare_current_go_compose_artifact "${current_compose_file}" || return 1
  RELEASE_GO_UPGRADE_CURRENT_COMPOSE_FILE="${current_compose_file}"
  RELEASE_GO_UPGRADE_TEMP_FILES+=("${current_compose_file}")
  release_verify_go_upgrade_storage_authority "${RELEASE_GO_UPGRADE_OLD_COMPOSE_FILE}" "${current_compose_file}" || return 1

  if ! api_ids="$(release_current_service_ids api)"; then
    echo "could not inspect the Node API while checking for mixed Go ownership" >&2
    return 1
  fi
  while IFS= read -r api_id; do
    [[ -n "${api_id}" ]] || continue
    if ! api_running="$(docker inspect "${api_id}" --format '{{.State.Running}}' 2>/dev/null)"; then
      echo "could not inspect the Node API state" >&2
      return 1
    fi
    if [[ "${api_running}" == true ]]; then
      echo "Go-to-Go refuses a mixed active Node API owner" >&2
      return 1
    fi
  done <<<"${api_ids}"

  release_go_upgrade_verify_previous_owners || return 1
  release_append_recovery_record $'go_upgrade_previous_snapshot\t'"${snapshot_file}" || return 1
  RELEASE_GO_UPGRADE_VALIDATED=true
}

release_current_go_service_image_id() {
  local service="$1"
  local ids identity image_id
  release_go_upgrade_service_is_managed "${service}" || return 1
  if ! ids="$(release_current_service_ids "${service}")"; then
    echo "could not inspect active Go ${service} containers for snapshot capture" >&2
    return 1
  fi
  release_go_upgrade_require_single_current_id "${service}" "${ids}" || return 1
  identity="${REPLY}"
  if ! image_id="$(docker inspect "${identity}" --format '{{.Image}}' 2>/dev/null)"; then
    echo "could not inspect active Go ${service} image identity for snapshot capture" >&2
    return 1
  fi
  [[ "${image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] || {
    echo "active Go ${service} image identity is not canonical" >&2
    return 1
  }
  printf '%s\n' "${image_id}"
}

release_current_schema_version() {
  # This is the canonical release schema, not an operator-supplied number or
  # a claim based only on filenames. Capture requires this run's exact-image
  # migration to have completed successfully; readiness also checks history.
  [[ "${RELEASE_GO_MIGRATION_VERIFIED}" == true && -n "${PROJECT_DIR:-}" ]] || {
    echo "a verified successful migration is required for schema snapshot capture" >&2
    return 1
  }
  node -e '
    const fs = require("node:fs");
    try {
      const files = fs.readdirSync(process.argv[1], { withFileTypes: true });
      const sql = files.filter((f) => f.name.endsWith(".sql"));
      if (sql.length === 0 || sql.some((f) => !f.isFile() || !/^[0-9]+_[a-z0-9_]+\.sql$/.test(f.name))) process.exit(1);
      const versions = sql.map((f) => Number(f.name.split("_", 1)[0]));
      if (versions.some((v) => !Number.isSafeInteger(v) || v < 1)) process.exit(1);
      process.stdout.write(String(Math.max(...versions)) + "\n");
    } catch { process.exit(1); }
  ' "${PROJECT_DIR}/apps/web/server/migrations"
}

release_record_go_image_identity() {
  [[ -n "${RELEASE_RECOVERY_FILE:-}" ]] || return 0
  local value
  for value in "${RELEASE_GO_IMAGE_REF}" "${RELEASE_GO_IMAGE_ID}" \
    "${RELEASE_GO_IMAGE_REVISION}" "${RELEASE_GO_IMAGE_VERSION}" "${RELEASE_GO_RUN_ID}"; do
    if [[ "${value}" == *$'\n'* || "${value}" == *$'\r'* || "${value}" == *$'\t'* ]]; then
      echo "Go image identity contains an unsafe control character" >&2
      return 1
    fi
  done
  umask 077
  {
    printf 'go_image_ref=%s\n' "${RELEASE_GO_IMAGE_REF}"
    printf 'go_image_id=%s\n' "${RELEASE_GO_IMAGE_ID}"
    printf 'go_image_revision=%s\n' "${RELEASE_GO_IMAGE_REVISION}"
    printf 'go_image_version=%s\n' "${RELEASE_GO_IMAGE_VERSION}"
    printf 'go_image_run_id=%s\n' "${RELEASE_GO_RUN_ID}"
  } >>"${RELEASE_RECOVERY_FILE}"
}

release_create_go_image_override() {
  [[ "${RELEASE_PROFILE_NAME}" == "go-full" ]] || return 0
  [[ -n "${RELEASE_RECOVERY_FILE:-}" ]] || {
    echo "Go image pinning requires a recovery file" >&2
    return 1
  }
  [[ "${RELEASE_GO_IMAGE_ID}" =~ ^sha256:[0-9a-f]{64}$ ]] || {
    echo "Go image pinning requires a canonical image ID" >&2
    return 1
  }
  local override_file="${RELEASE_RECOVERY_FILE}.go-image.override.yml"
  local temporary_file="${override_file}.tmp.$$"
  local run_seed
  if [[ -z "${RELEASE_GO_RUN_ID}" ]]; then
    run_seed="${current_commit:-}:${BASHPID:-$$}:$(date -u +%s%N)"
    if ! RELEASE_GO_RUN_ID="$(printf '%s' "${run_seed}" | sha256sum | cut -d ' ' -f1)"; then
      echo "could not generate a unique Go release run label" >&2
      return 1
    fi
  fi
  [[ "${RELEASE_GO_RUN_ID}" =~ ^[0-9a-f]{64}$ ]] || {
    echo "Go release run label is malformed" >&2
    return 1
  }
  if [[ "${override_file}" == *$'\n'* || "${override_file}" == *$'\r'* || "${override_file}" == *$'\t'* || \
    "${temporary_file}" == *$'\n'* || "${temporary_file}" == *$'\r'* || "${temporary_file}" == *$'\t'* ]]; then
    echo "Go image override path contains an unsafe control character" >&2
    return 1
  fi
  if [[ -e "${override_file}" || -L "${override_file}" || -e "${temporary_file}" || -L "${temporary_file}" ]]; then
    echo "refusing to overwrite an existing Go image override" >&2
    return 1
  fi
  umask 077
  if ! {
    printf 'services:\n'
    if [[ -n "${RELEASE_GO_P2P_IMAGE_ID}" && -n "${RELEASE_GO_WEB_IMAGE_ID}" ]]; then
      printf '  p2p:\n    image: %s\n    labels:\n      com.duallane.release-run: %s\n' "${RELEASE_GO_P2P_IMAGE_ID}" "${RELEASE_GO_RUN_ID}"
      printf '  web:\n    image: %s\n    labels:\n      com.duallane.release-run: %s\n' "${RELEASE_GO_WEB_IMAGE_ID}" "${RELEASE_GO_RUN_ID}"
    fi
    printf '  workspace:\n    image: %s\n    labels:\n      com.duallane.release-run: %s\n' "${RELEASE_GO_IMAGE_ID}" "${RELEASE_GO_RUN_ID}"
    printf '  worker:\n    image: %s\n    labels:\n      com.duallane.release-run: %s\n' "${RELEASE_GO_IMAGE_ID}" "${RELEASE_GO_RUN_ID}"
    printf '  migrate:\n    image: %s\n    labels:\n      com.duallane.release-run: %s\n' "${RELEASE_GO_IMAGE_ID}" "${RELEASE_GO_RUN_ID}"
  } >"${temporary_file}"; then
    rm -f -- "${temporary_file}"
    echo "could not write the private Go image override" >&2
    return 1
  fi
  if ! chmod 600 -- "${temporary_file}" || ! mv -- "${temporary_file}" "${override_file}"; then
    rm -f -- "${temporary_file}"
    echo "could not install the private Go image override" >&2
    return 1
  fi
  RELEASE_GO_IMAGE_OVERRIDE_FILE="${override_file}"
}

release_verify_go_edge_images() {
  [[ "${RELEASE_PROFILE_NAME}" == go-full ]] || return 0
  local service ref image revision version
  for service in p2p web; do
    if ! ref="$(compose config --format json 2>/dev/null | node -e '
      try {
        const value = JSON.parse(require("node:fs").readFileSync(0, "utf8")).services[process.argv[1]].image;
        if (typeof value !== "string" || !value || /[\x00-\x20\x7f]/.test(value)) process.exit(1);
        process.stdout.write(value);
      } catch { process.exit(1); }
    ' "${service}")" ||
      ! image="$(docker image inspect "${ref}" --format '{{.Id}}' 2>/dev/null)" ||
      [[ ! "${image}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
      echo "could not resolve the built Go ${service} image identity" >&2
      return 1
    fi
    revision="$(docker image inspect "${image}" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null)" || return 1
    version="$(docker image inspect "${image}" --format '{{index .Config.Labels "org.opencontainers.image.version"}}' 2>/dev/null)" || return 1
    [[ "${revision}" == "${current_commit}" && "${version}" == "${expected_app_version}" ]] || {
      echo "Go ${service} image release metadata differs from the requested release" >&2
      return 1
    }
    case "${service}" in
      p2p) RELEASE_GO_P2P_IMAGE_ID="${image}" ;;
      web) RELEASE_GO_WEB_IMAGE_ID="${image}" ;;
    esac
    release_append_recovery_record "go_${service}_image_id=${image}" || return 1
  done
}

release_expected_go_service_image_id() {
  case "$1" in
    p2p) REPLY="${RELEASE_GO_P2P_IMAGE_ID}" ;;
    web) REPLY="${RELEASE_GO_WEB_IMAGE_ID}" ;;
    workspace|worker|migrate) REPLY="${RELEASE_GO_IMAGE_ID}" ;;
    *) return 1 ;;
  esac
  [[ "${REPLY}" =~ ^sha256:[0-9a-f]{64}$ ]] || {
    echo "Go service image was not pinned before activation" >&2
    return 1
  }
}

release_verify_go_image_identity() {
  [[ "${RELEASE_PROFILE_NAME}" == "go-full" ]] || return 0
  local image_refs image_ref image_id image_revision image_version
  local verified_image_id="" verified_image_ref="" image_count=0
  if ! image_refs="$(compose config --format json 2>/dev/null | node -e '
    const fs = require("node:fs");
    let compose;
    try {
      compose = JSON.parse(fs.readFileSync(0, "utf8"));
    } catch {
      process.exit(1);
    }
    const services = compose && compose.services;
    const names = ["workspace", "worker", "migrate"];
    if (!services || typeof services !== "object" || Array.isArray(services)) process.exit(1);
    const refs = names.map((name) => services[name] && services[name].image);
    if (refs.some((ref) => typeof ref !== "string" || ref.length === 0 || ref.includes("\n") || ref.includes("\r") || ref.includes("\t"))) process.exit(1);
    if (!refs.every((ref) => ref === refs[0])) process.exit(1);
    process.stdout.write(refs.join("\n"));
  ')"; then
    echo "could not resolve the Workspace, worker, and migrate image references" >&2
    return 1
  fi
  while IFS= read -r image_ref; do
    [[ -n "${image_ref}" && "${image_ref}" != *$'\r'* && "${image_ref}" != *$'\t'* ]] || {
      echo "Go image reference is empty or malformed" >&2
      return 1
    }
    ((image_count += 1))
    if ! image_id="$(docker image inspect "${image_ref}" --format '{{.Id}}' 2>/dev/null)"; then
      echo "could not inspect the built Go image" >&2
      return 1
    fi
    if [[ ! "${image_id}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
      echo "built Go image did not return a canonical image ID" >&2
      return 1
    fi
    if [[ -z "${verified_image_id}" ]]; then
      verified_image_id="${image_id}"
      verified_image_ref="${image_ref}"
    elif [[ "${image_id}" != "${verified_image_id}" ]]; then
      echo "Workspace, worker, and migrate resolved to different image IDs" >&2
      return 1
    fi
  done <<<"${image_refs}"
  if ((image_count != 3)); then
    echo "Go image identity gate did not receive all three service references" >&2
    return 1
  fi
  if ! image_revision="$(docker image inspect "${verified_image_id}" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null)"; then
    echo "could not inspect the verified Go image revision" >&2
    return 1
  fi
  if ! image_version="$(docker image inspect "${verified_image_id}" --format '{{index .Config.Labels "org.opencontainers.image.version"}}' 2>/dev/null)"; then
    echo "could not inspect the verified Go image version" >&2
    return 1
  fi
  if [[ "${image_revision}" != "${current_commit}" || "${image_version}" != "${expected_app_version}" ]]; then
    echo "Go image release metadata does not match the requested commit/version" >&2
    return 1
  fi
  RELEASE_GO_IMAGE_REF="${verified_image_ref}"
  RELEASE_GO_IMAGE_ID="${verified_image_id}"
  RELEASE_GO_IMAGE_REVISION="${current_commit}"
  RELEASE_GO_IMAGE_VERSION="${expected_app_version}"
  release_create_go_image_override || return 1
  release_record_go_image_identity || return 1
}

release_verify_go_service_image_id() {
  [[ "${RELEASE_PROFILE_NAME}" == "go-full" ]] || return 0
  local service="$1"
  local ids id actual_image_id expected_image
  release_profile_contains "${service}" p2p workspace worker web || return 0
  release_expected_go_service_image_id "${service}" || return 1
  expected_image="${REPLY}"
  if ! ids="$(release_current_service_ids "${service}")"; then
    echo "could not inspect active ${service} image" >&2
    return 1
  fi
  [[ -n "${ids}" ]] || {
    echo "active ${service} has no container for image identity verification" >&2
    return 1
  }
  while IFS= read -r id; do
    [[ -n "${id}" ]] || continue
    if ! actual_image_id="$(docker inspect "${id}" --format '{{.Image}}' 2>/dev/null)"; then
      echo "could not inspect active ${service} image ID" >&2
      return 1
    fi
    if [[ "${actual_image_id}" != "${expected_image}" ]]; then
      echo "active ${service} does not use the verified Go image ID" >&2
      return 1
    fi
  done <<<"${ids}"
}

release_verify_migration_container_owner() {
  local migration_id="$1"
  local project label expected actual label_check
  [[ "${migration_id}" =~ ^[0-9a-f]{12,64}$ ]] || {
    echo "Go migration container identifier is invalid" >&2
    return 1
  }
  project="$(release_compose_project_name)" || return 1
  local -a checks=(
    "com.docker.compose.project=${project}"
    "com.docker.compose.service=migrate"
    "com.duallane.release-run=${RELEASE_GO_RUN_ID}"
  )
  for label_check in "${checks[@]}"; do
    label="${label_check%%=*}"
    expected="${label_check#*=}"
    if ! actual="$(docker inspect "${migration_id}" --format "{{index .Config.Labels \"${label}\"}}" 2>/dev/null)"; then
      echo "could not inspect Go migration ownership labels" >&2
      return 1
    fi
    if [[ "${actual}" != "${expected}" ]]; then
      echo "refusing to use an unowned Go migration container" >&2
      return 1
    fi
  done
}

release_remove_owned_migration_container() {
  local migration_id="$1"
  release_verify_migration_container_owner "${migration_id}" || return 1
  if ! docker rm -f "${migration_id}" >/dev/null 2>&1; then
    echo "could not remove the owned Go migration container" >&2
    return 1
  fi
}

release_run_go_migration_and_verify() {
  RELEASE_GO_MIGRATION_VERIFIED=false
  [[ "${RELEASE_PROFILE_NAME}" == "go-full" ]] || {
    echo "Go migration image verification requires the go-full profile" >&2
    return 1
  }
  [[ -n "${RELEASE_GO_IMAGE_ID}" ]] || {
    echo "Go migration image identity was not verified before migration" >&2
    return 1
  }
  local existing migration_id migration_running migration_status actual_image_id
  if ! existing="$(compose ps -a -q migrate 2>/dev/null)"; then
    echo "could not inspect existing Go migration containers" >&2
    return 1
  fi
  if [[ -n "${existing}" ]]; then
    echo "refusing to reuse an existing Go migration container" >&2
    return 1
  fi
  if ! compose up --no-start --pull never --no-build --no-deps migrate >/dev/null 2>&1; then
    echo "Go migration container could not be created" >&2
    return 1
  fi
  if ! migration_id="$(compose ps -a -q migrate 2>/dev/null)"; then
    echo "could not identify the created Go migration container" >&2
    return 1
  fi
  if [[ ! "${migration_id}" =~ ^[0-9a-f]{12,64}$ ]]; then
    echo "Go migration container identifier is invalid" >&2
    return 1
  fi
  release_verify_migration_container_owner "${migration_id}" || return 1
  if ! migration_running="$(docker inspect "${migration_id}" --format '{{.State.Running}}' 2>/dev/null)"; then
    echo "could not inspect the created Go migration container state" >&2
    release_remove_owned_migration_container "${migration_id}" || return 1
    return 1
  fi
  if [[ "${migration_running}" != "false" ]]; then
    echo "Go migration container was running before image verification" >&2
    release_remove_owned_migration_container "${migration_id}" || return 1
    return 1
  fi
  if ! actual_image_id="$(docker inspect "${migration_id}" --format '{{.Image}}' 2>/dev/null)"; then
    echo "could not inspect the created Go migration image" >&2
    release_remove_owned_migration_container "${migration_id}" || return 1
    return 1
  fi
  if [[ "${actual_image_id}" != "${RELEASE_GO_IMAGE_ID}" ]]; then
    echo "Go migration did not use the verified Go image ID" >&2
    release_remove_owned_migration_container "${migration_id}" || return 1
    return 1
  fi
  if ! docker start "${migration_id}" >/dev/null 2>&1; then
    echo "Go migration container could not be started" >&2
    release_remove_owned_migration_container "${migration_id}" || return 1
    return 1
  fi
  if ! migration_status="$(docker wait "${migration_id}" 2>/dev/null)"; then
    echo "Go migration did not reach a terminal state" >&2
    release_remove_owned_migration_container "${migration_id}" || return 1
    return 1
  fi
  if [[ "${migration_status}" != "0" ]]; then
    echo "Go migration exited unsuccessfully" >&2
    release_remove_owned_migration_container "${migration_id}" || return 1
    return 1
  fi
  if ! actual_image_id="$(docker inspect "${migration_id}" --format '{{.Image}}' 2>/dev/null)"; then
    echo "could not inspect the completed Go migration image" >&2
    release_remove_owned_migration_container "${migration_id}" || return 1
    return 1
  fi
  if [[ "${actual_image_id}" != "${RELEASE_GO_IMAGE_ID}" ]]; then
    echo "completed Go migration did not retain the verified image ID" >&2
    release_remove_owned_migration_container "${migration_id}" || return 1
    return 1
  fi
  release_remove_owned_migration_container "${migration_id}" || return 1
  release_append_recovery_record "go_migration_verified_image=${RELEASE_GO_IMAGE_ID}" || return 1
  RELEASE_GO_MIGRATION_VERIFIED=true
}

release_candidate_compose() {
  if declare -F candidate_compose >/dev/null 2>&1; then
    candidate_compose "$@"
  else
    compose "$@"
  fi
}

release_rollback_compose() {
  if declare -F rollback_compose >/dev/null 2>&1; then
    rollback_compose "$@"
  else
    compose "$@"
  fi
}

release_compose_service_configured() {
  local service="$1"
  local configured
  if ! configured="$(compose config --services 2>/dev/null)"; then
    echo "cannot inspect the Compose service inventory" >&2
    return 2
  fi
  if grep -Fxq -- "${service}" <<<"${configured}"; then
    return 0
  fi
  return 1
}

release_profile_contains() {
  local wanted="$1"
  shift
  local value
  for value in "$@"; do
    [[ "${value}" == "${wanted}" ]] && return 0
  done
  return 1
}

release_current_service_ids() {
  local service="$1"
  local inventory_status
  if release_compose_service_configured "${service}"; then
    compose ps -a -q "${service}"
    return
  else
    inventory_status=$?
  fi
  if ((inventory_status == 1)); then
    return 0
  fi
  return 1
}

release_rollback_service_ids() {
  local service="$1"
  local configured
  if configured="$(release_rollback_compose config --services 2>/dev/null)"; then
    :
  else
    echo "cannot inspect the rollback Compose service inventory" >&2
    return 1
  fi
  if grep -Fxq -- "${service}" <<<"${configured}"; then
    release_rollback_compose ps -a -q "${service}"
    return
  fi
  return 0
}

release_snapshot_app_state() {
  local destination="$1"
  local service ids id image_id image_ref running status health
  [[ -n "${destination}" ]] || return 1
  umask 077
  : >"${destination}"

  for service in "${RELEASE_SNAPSHOT_SERVICES[@]}"; do
    if ! ids="$(release_current_service_ids "${service}")"; then
      echo "cannot inspect current containers for service ${service}" >&2
      return 1
    fi
    while IFS= read -r id; do
      [[ -n "${id}" ]] || continue
      image_id="$(docker inspect "${id}" --format '{{.Image}}')"
      image_ref="$(docker inspect "${id}" --format '{{.Config.Image}}')"
      running="$(docker inspect "${id}" --format '{{.State.Running}}')"
      status="$(docker inspect "${id}" --format '{{.State.Status}}')"
      health="$(docker inspect "${id}" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')"
      if [[ -z "${image_id}" || -z "${image_ref}" || ("${running}" != "true" && "${running}" != "false") ]]; then
        echo "cannot capture safe state for service ${service}" >&2
        return 1
      fi
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "${service}" "${id}" "${image_id}" "${image_ref}" "${running}" "${status}" "${health}" >>"${destination}"
    done <<<"${ids}"
  done
  RELEASE_SNAPSHOT_FILE="${destination}"
}

release_snapshot_has_record() {
  local service="$1"
  local record_service id image_id image_ref running status health
  [[ -f "${RELEASE_SNAPSHOT_FILE}" ]] || return 1
  while IFS=$'\t' read -r record_service id image_id image_ref running status health; do
    [[ "${record_service}" == "${service}" ]] && return 0
  done <"${RELEASE_SNAPSHOT_FILE}"
  return 1
}

release_snapshot_was_running() {
  local service="$1"
  local record_service id image_id image_ref running status health
  [[ -f "${RELEASE_SNAPSHOT_FILE}" ]] || return 1
  while IFS=$'\t' read -r record_service id image_id image_ref running status health; do
    if [[ "${record_service}" == "${service}" && "${running}" == "true" ]]; then
      return 0
    fi
  done <"${RELEASE_SNAPSHOT_FILE}"
  return 1
}

release_append_recovery_record() {
  local record="$1"
  [[ -n "${RELEASE_RECOVERY_FILE:-}" ]] || {
    echo "restart-policy fencing requires a private recovery file" >&2
    return 1
  }
  [[ "${record}" != *$'\n'* && "${record}" != *$'\r'* ]] || {
    echo "restart-policy fencing record contains unsafe control data" >&2
    return 1
  }
  umask 077
  printf '%s\n' "${record}" >>"${RELEASE_RECOVERY_FILE}"
}

release_fence_service_has_target() {
  local wanted_service="$1"
  local kind service identity restart_name restart_max original_running
  [[ -f "${RELEASE_RECOVERY_FILE:-}" ]] || return 1
  while IFS=$'\t' read -r kind service identity restart_name restart_max original_running; do
    if [[ "${kind}" == "fence_target" && "${service}" == "${wanted_service}" ]]; then
      return 0
    fi
  done <"${RELEASE_RECOVERY_FILE}"
  return 1
}

release_fence_service_is_complete() {
  local wanted_service="$1"
  local kind service rest
  [[ -f "${RELEASE_RECOVERY_FILE:-}" ]] || return 1
  while IFS=$'\t' read -r kind service rest; do
    if [[ "${kind}" == "fence_complete" && "${service}" == "${wanted_service}" ]]; then
      return 0
    fi
  done <"${RELEASE_RECOVERY_FILE}"
  return 1
}

release_fence_target_count_for_service() {
  local wanted_service="$1"
  local count=0
  local kind service identity restart_name restart_max original_running
  [[ -f "${RELEASE_RECOVERY_FILE:-}" ]] || {
    printf '0\n'
    return 0
  }
  while IFS=$'\t' read -r kind service identity restart_name restart_max original_running; do
    [[ "${kind}" == "fence_target" && "${service}" == "${wanted_service}" ]] || continue
    count=$((count + 1))
  done <"${RELEASE_RECOVERY_FILE}"
  printf '%s\n' "${count}"
}

release_fence_require_single_target() {
  local service="$1"
  local count
  count="$(release_fence_target_count_for_service "${service}")" || return 1
  [[ "${count}" == 1 ]] || {
    echo "${service} restart-policy recovery requires exactly one fenced container" >&2
    return 1
  }
}

release_fence_target_for_identity() {
  local wanted_service="$1"
  local wanted_identity="$2"
  local kind service identity restart_name restart_max original_running
  [[ -f "${RELEASE_RECOVERY_FILE:-}" ]] || return 1
  while IFS=$'\t' read -r kind service identity restart_name restart_max original_running; do
    if [[ "${kind}" == "fence_target" && "${service}" == "${wanted_service}" && "${identity}" == "${wanted_identity}" ]]; then
      printf '%s\t%s\t%s\t%s\n' "${identity}" "${restart_name}" "${restart_max}" "${original_running}"
      return 0
    fi
  done <"${RELEASE_RECOVERY_FILE}"
  return 1
}

release_fence_target_records_for_service() {
  local wanted_service="$1"
  local kind service identity restart_name restart_max original_running
  [[ -f "${RELEASE_RECOVERY_FILE:-}" ]] || return 0
  while IFS=$'\t' read -r kind service identity restart_name restart_max original_running; do
    [[ "${kind}" == "fence_target" && "${service}" == "${wanted_service}" ]] || continue
    printf '%s\t%s\t%s\t%s\n' "${identity}" "${restart_name}" "${restart_max}" "${original_running}"
  done <"${RELEASE_RECOVERY_FILE}"
}

release_capture_fence_target() {
  local service="$1"
  local container_id="$2"
  local identity restart_name restart_max original_running existing
  [[ -n "${RELEASE_RECOVERY_FILE:-}" ]] || {
    echo "restart-policy fencing requires a private recovery file" >&2
    return 1
  }
  [[ -n "${container_id}" && "${container_id}" != *$'\n'* && "${container_id}" != *$'\r'* && "${container_id}" != *$'\t'* ]] || {
    echo "cannot capture an invalid container identity" >&2
    return 1
  }
  if ! identity="$(docker inspect "${container_id}" --format '{{.Id}}' 2>/dev/null)"; then
    echo "cannot inspect container identity before restart-policy fencing" >&2
    return 1
  fi
  [[ "${identity}" =~ ^[0-9a-f]{64}$ ]] || {
    echo "container identity is invalid for restart-policy fencing" >&2
    return 1
  }
  release_verify_fence_owner "${service}" "${identity}" || return 1
  if existing="$(release_fence_target_for_identity "${service}" "${identity}")"; then
    REPLY="${existing}"
    return 0
  fi
  if release_fence_service_is_complete "${service}"; then
    echo "refusing to fence a new container after ${service} fencing completed" >&2
    return 1
  fi
  if ! restart_name="$(docker inspect "${identity}" --format '{{.HostConfig.RestartPolicy.Name}}' 2>/dev/null)" || \
    ! restart_max="$(docker inspect "${identity}" --format '{{.HostConfig.RestartPolicy.MaximumRetryCount}}' 2>/dev/null)" || \
    ! original_running="$(docker inspect "${identity}" --format '{{.State.Running}}' 2>/dev/null)"; then
    echo "cannot capture container restart policy before fencing" >&2
    return 1
  fi
  case "${restart_name}" in
    no|always|unless-stopped|on-failure)
      ;;
    *)
      echo "container has an unsupported restart policy" >&2
      return 1
      ;;
  esac
  [[ "${restart_max}" =~ ^[0-9]+$ && ("${original_running}" == true || "${original_running}" == false) ]] || {
    echo "container restart policy state is invalid" >&2
    return 1
  }
  release_append_recovery_record $'fence_target\t'"${service}"$'\t'"${identity}"$'\t'"${restart_name}"$'\t'"${restart_max}"$'\t'"${original_running}" || return 1
  REPLY="${identity}"$'\t'"${restart_name}"$'\t'"${restart_max}"$'\t'"${original_running}"
}

release_verify_fence_identity() {
  local container_id="$1"
  local expected_identity="$2"
  local actual_identity
  if ! actual_identity="$(docker inspect "${container_id}" --format '{{.Id}}' 2>/dev/null)"; then
    echo "cannot inspect container identity during restart-policy fencing" >&2
    return 1
  fi
  if [[ "${actual_identity}" != "${expected_identity}" ]]; then
    echo "container identity changed during restart-policy fencing" >&2
    return 1
  fi
}

release_verify_canonical_container_identity() {
  local container_id="$1"
  local actual_identity
  if ! actual_identity="$(docker inspect "${container_id}" --format '{{.Id}}' 2>/dev/null)"; then
    echo "cannot inspect container identity during restart-policy recovery" >&2
    return 1
  fi
  [[ "${actual_identity}" =~ ^[0-9a-f]{64}$ ]] || {
    echo "container identity is invalid during restart-policy recovery" >&2
    return 1
  }
}

release_verify_fence_owner() {
  local service="$1"
  local container_id="$2"
  local project label expected actual label_check
  project="$(release_compose_project_name)" || return 1
  for label_check in \
    "com.docker.compose.project=${project}" \
    "com.docker.compose.service=${service}"; do
    label="${label_check%%=*}"
    expected="${label_check#*=}"
    if ! actual="$(docker inspect "${container_id}" --format "{{index .Config.Labels \"${label}\"}}" 2>/dev/null)"; then
      echo "cannot inspect ${service} ownership labels during recovery" >&2
      return 1
    fi
    if [[ "${actual}" != "${expected}" ]]; then
      echo "refusing to recover an owner with mismatched Compose labels" >&2
      return 1
    fi
  done
}

release_verify_restart_policy() {
  local container_id="$1"
  local expected_name="$2"
  local expected_max="$3"
  local actual_name actual_max
  if ! actual_name="$(docker inspect "${container_id}" --format '{{.HostConfig.RestartPolicy.Name}}' 2>/dev/null)" || \
    ! actual_max="$(docker inspect "${container_id}" --format '{{.HostConfig.RestartPolicy.MaximumRetryCount}}' 2>/dev/null)"; then
    echo "cannot inspect container restart policy" >&2
    return 1
  fi
  [[ "${actual_name}" == "${expected_name}" && "${actual_max}" == "${expected_max}" ]] || {
    echo "container restart policy did not match the expected state" >&2
    return 1
  }
}

release_fence_target_restart_policy() {
  local service="$1"
  local identity="$2"
  release_verify_fence_owner "${service}" "${identity}" || return 1
  release_verify_fence_identity "${identity}" "${identity}" || return 1
  if ! docker update --restart=no "${identity}" >/dev/null 2>&1; then
    echo "could not disable restart policy for ${service}" >&2
    return 1
  fi
  release_verify_fence_identity "${identity}" "${identity}" || return 1
  release_verify_restart_policy "${identity}" no 0 || return 1
  release_append_recovery_record $'fence_updated\t'"${service}"$'\t'"${identity}"
}

release_stop_fenced_target() {
  local service="$1"
  local identity="$2"
  release_verify_fence_owner "${service}" "${identity}" || return 1
  release_verify_fence_identity "${identity}" "${identity}" || return 1
  if ! docker stop --time "${RELEASE_STOP_TIMEOUT}" "${identity}" >/dev/null 2>&1; then
    echo "could not stop fenced ${service}" >&2
    return 1
  fi
  release_wait_ids_not_running "${identity}" || return 1
  release_verify_fence_identity "${identity}" "${identity}" || return 1
  release_append_recovery_record $'fence_stopped\t'"${service}"$'\t'"${identity}"
}

release_fence_service_and_confirm() {
  local service="$1"
  local ids container_id target identity restart_name restart_max original_running
  [[ -n "${RELEASE_RECOVERY_FILE:-}" ]] || {
    echo "restart-policy fencing requires a private recovery file" >&2
    return 1
  }
  if ! ids="$(release_current_service_ids "${service}")"; then
    echo "could not inspect current containers for ${service} fencing" >&2
    return 1
  fi
  [[ -n "${ids}" ]] || return 0

  local container_count=0
  while IFS= read -r container_id; do
    [[ -n "${container_id}" ]] || continue
    container_count=$((container_count + 1))
  done <<<"${ids}"
  [[ "${container_count}" == 1 ]] || {
    echo "${service} restart-policy fencing supports exactly one container" >&2
    return 1
  }
  if release_fence_service_has_target "${service}"; then
    release_fence_require_single_target "${service}" || return 1
  fi

  local -a targets=()
  while IFS= read -r container_id; do
    [[ -n "${container_id}" ]] || continue
    release_capture_fence_target "${service}" "${container_id}" || return 1
    targets+=("${REPLY}")
  done <<<"${ids}"
  [[ "${#targets[@]}" -gt 0 ]] || return 0

  for target in "${targets[@]}"; do
    IFS=$'\t' read -r identity restart_name restart_max original_running <<<"${target}"
    release_fence_target_restart_policy "${service}" "${identity}" || return 1
  done
  for target in "${targets[@]}"; do
    IFS=$'\t' read -r identity restart_name restart_max original_running <<<"${target}"
    release_stop_fenced_target "${service}" "${identity}" || return 1
  done
  release_append_recovery_record $'fence_complete\t'"${service}"
}

release_wait_ids_not_running() {
  local ids="$1"
  local attempt id running all_stopped
  for ((attempt = 1; attempt <= RELEASE_STOP_ATTEMPTS; attempt += 1)); do
    all_stopped=true
    while IFS= read -r id; do
      [[ -n "${id}" ]] || continue
      if ! running="$(docker inspect "${id}" --format '{{.State.Running}}')"; then
        echo "cannot inspect stopped container state" >&2
        return 1
      fi
      if [[ "${running}" != "false" ]]; then
        all_stopped=false
      fi
    done <<<"${ids}"
    if [[ "${all_stopped}" == true ]]; then
      return 0
    fi
    sleep 1
  done
  echo "service did not reach confirmed not-running state" >&2
  return 1
}

release_stop_service_and_confirm() {
  release_fence_service_and_confirm "$1"
}

release_go_upgrade_fence_target_count() {
  local wanted_phase="$1"
  local wanted_service="$2"
  local kind phase service identity restart_name restart_max original_running image_id commit
  local count=0
  [[ -f "${RELEASE_RECOVERY_FILE:-}" ]] || {
    printf '0\n'
    return 0
  }
  while IFS=$'\t' read -r kind phase service identity restart_name restart_max original_running image_id commit; do
    [[ "${kind}" == go_upgrade_fence_target && "${phase}" == "${wanted_phase}" && "${service}" == "${wanted_service}" ]] || continue
    count=$((count + 1))
  done <"${RELEASE_RECOVERY_FILE}"
  printf '%s\n' "${count}"
}

release_go_upgrade_fence_target_for_service() {
  local wanted_phase="$1"
  local wanted_service="$2"
  local kind phase service identity restart_name restart_max original_running image_id commit
  local found=0
  [[ -f "${RELEASE_RECOVERY_FILE:-}" ]] || return 1
  while IFS=$'\t' read -r kind phase service identity restart_name restart_max original_running image_id commit; do
    [[ "${kind}" == go_upgrade_fence_target && "${phase}" == "${wanted_phase}" && "${service}" == "${wanted_service}" ]] || continue
    found=$((found + 1))
    REPLY="${identity}"$'\t'"${restart_name}"$'\t'"${restart_max}"$'\t'"${original_running}"$'\t'"${image_id}"$'\t'"${commit}"
  done <"${RELEASE_RECOVERY_FILE}"
  [[ "${found}" == 1 ]]
}

release_go_upgrade_fence_complete() {
  local wanted_phase="$1"
  local wanted_service="$2"
  local kind phase service identity rest
  [[ -f "${RELEASE_RECOVERY_FILE:-}" ]] || return 1
  while IFS=$'\t' read -r kind phase service identity rest; do
    if [[ "${kind}" == go_upgrade_fence_complete && "${phase}" == "${wanted_phase}" && "${service}" == "${wanted_service}" ]]; then
      return 0
    fi
  done <"${RELEASE_RECOVERY_FILE}"
  return 1
}

release_go_upgrade_fence_phase_and_confirm() {
  local phase="$1"
  local service="$2"
  local expected_image="$3"
  local expected_commit="$4"
  local expected_identity="${5:-}"
  local ids container_id identity image revision restart_name restart_max original_running running target
  if ! ids="$(release_current_service_ids "${service}")"; then
    echo "could not inspect ${phase} Go owner ${service} before fencing" >&2
    return 1
  fi
  release_go_upgrade_require_single_current_id "${service}" "${ids}" || return 1
  container_id="${REPLY}"
  if ! identity="$(docker inspect "${container_id}" --format '{{.Id}}' 2>/dev/null)"; then
    echo "could not inspect ${phase} Go owner identity for ${service}" >&2
    return 1
  fi
  [[ "${identity}" =~ ^[0-9a-f]{64}$ ]] || {
    echo "${phase} Go owner identity for ${service} is not canonical" >&2
    return 1
  }
  [[ -z "${expected_identity}" || "${identity}" == "${expected_identity}" ]] || {
    echo "${phase} Go owner identity changed before fencing ${service}" >&2
    return 1
  }
  release_verify_fence_owner "${service}" "${identity}" || return 1
  if ! image="$(docker inspect "${identity}" --format '{{.Image}}' 2>/dev/null)" || [[ "${image}" != "${expected_image}" ]]; then
    echo "${phase} Go owner image for ${service} is not the expected pinned image" >&2
    return 1
  fi
  if ! revision="$(docker inspect "${identity}" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null)" || [[ "${revision}" != "${expected_commit}" ]]; then
    echo "${phase} Go owner revision for ${service} is not the expected release" >&2
    return 1
  fi

  if release_go_upgrade_fence_target_for_service "${phase}" "${service}"; then
    IFS=$'\t' read -r identity restart_name restart_max original_running image revision <<<"${REPLY}"
    [[ "${identity}" == "$(docker inspect "${container_id}" --format '{{.Id}}' 2>/dev/null)" ]] || {
      echo "${phase} Go fence target for ${service} changed" >&2
      return 1
    }
  else
    if [[ "$(release_go_upgrade_fence_target_count "${phase}" "${service}")" != 0 ]]; then
      echo "${phase} Go fencing found multiple targets for ${service}" >&2
      return 1
    fi
    if ! restart_name="$(docker inspect "${identity}" --format '{{.HostConfig.RestartPolicy.Name}}' 2>/dev/null)" || \
      ! restart_max="$(docker inspect "${identity}" --format '{{.HostConfig.RestartPolicy.MaximumRetryCount}}' 2>/dev/null)" || \
      ! original_running="$(docker inspect "${identity}" --format '{{.State.Running}}' 2>/dev/null)"; then
      echo "could not capture ${phase} Go restart policy for ${service}" >&2
      return 1
    fi
    case "${restart_name}" in
      no|always|unless-stopped|on-failure) ;;
      *) echo "${phase} Go owner ${service} has an unsupported restart policy" >&2; return 1 ;;
    esac
    [[ "${restart_max}" =~ ^[0-9]+$ && ("${original_running}" == true || "${original_running}" == false) ]] || {
      echo "${phase} Go restart policy state for ${service} is invalid" >&2
      return 1
    }
    release_append_recovery_record $'go_upgrade_fence_target\t'"${phase}"$'\t'"${service}"$'\t'"${identity}"$'\t'"${restart_name}"$'\t'"${restart_max}"$'\t'"${original_running}"$'\t'"${image}"$'\t'"${revision}" || return 1
  fi

  if ! running="$(docker inspect "${identity}" --format '{{.State.Running}}' 2>/dev/null)"; then
    echo "could not inspect ${phase} Go owner state for ${service}" >&2
    return 1
  fi
  if ! release_verify_restart_policy "${identity}" no 0; then
    if ! docker update --restart=no "${identity}" >/dev/null 2>&1; then
      echo "could not disable ${phase} Go owner restart policy for ${service}" >&2
      return 1
    fi
    release_verify_fence_identity "${identity}" "${identity}" || return 1
    release_verify_restart_policy "${identity}" no 0 || return 1
    release_append_recovery_record $'go_upgrade_fence_updated\t'"${phase}"$'\t'"${service}"$'\t'"${identity}" || return 1
  fi
  if [[ "${running}" == true ]]; then
    release_verify_fence_identity "${identity}" "${identity}" || return 1
    if ! docker stop --time "${RELEASE_STOP_TIMEOUT}" "${identity}" >/dev/null 2>&1; then
      echo "could not stop ${phase} Go owner ${service}" >&2
      return 1
    fi
    release_wait_ids_not_running "${identity}" || return 1
    release_verify_fence_identity "${identity}" "${identity}" || return 1
    release_append_recovery_record $'go_upgrade_fence_stopped\t'"${phase}"$'\t'"${service}"$'\t'"${identity}" || return 1
  else
    [[ "${running}" == false ]] || {
      echo "${phase} Go owner ${service} has an invalid running state" >&2
      return 1
    }
    release_wait_ids_not_running "${identity}" || return 1
  fi
  if ! release_go_upgrade_fence_complete "${phase}" "${service}"; then
    release_append_recovery_record $'go_upgrade_fence_complete\t'"${phase}"$'\t'"${service}"$'\t'"${identity}" || return 1
  fi
}

release_go_upgrade_fence_old_services() {
  [[ "${RELEASE_GO_UPGRADE:-false}" == true ]] || return 0
  local service ids identity expected_identity expected_image expected_commit
  for service in p2p workspace worker web; do
    if release_go_upgrade_previous_owner_record "${service}"; then
      IFS=$'\t' read -r expected_identity expected_image expected_commit <<<"${REPLY}"
    else
      if ! ids="$(release_current_service_ids "${service}")"; then
        echo "could not inspect the previous ${service} Go owner before fencing" >&2
        return 1
      fi
      release_go_upgrade_require_single_current_id "${service}" "${ids}" || return 1
      identity="${REPLY}"
      expected_image="$(release_go_upgrade_old_image_id "${service}")" || return 1
      release_go_upgrade_verify_owner_container "${service}" "${identity}" "${expected_image}" "${RELEASE_GO_UPGRADE_OLD_COMMIT}" || return 1
      expected_identity="${identity}"
      expected_commit="${RELEASE_GO_UPGRADE_OLD_COMMIT}"
      release_append_recovery_record $'go_upgrade_old_owner\t'"${service}"$'\t'"${expected_identity}"$'\t'"${expected_image}"$'\t'"${expected_commit}" || return 1
    fi
    [[ "${expected_commit}" == "${RELEASE_GO_UPGRADE_OLD_COMMIT}" ]] || {
      echo "previous ${service} Go owner record has the wrong release commit" >&2
      return 1
    }
    release_go_upgrade_fence_phase_and_confirm old "${service}" "${expected_image}" "${RELEASE_GO_UPGRADE_OLD_COMMIT}" "${expected_identity}" || return 1
  done
  release_append_recovery_record 'go_upgrade_old_owners_fenced=true'
}

release_go_upgrade_note_new_service_attempt() {
  local service="$1"
  release_go_upgrade_service_is_managed "${service}" || return 0
  local existing
  for existing in "${RELEASE_GO_UPGRADE_NEW_ATTEMPTED_SERVICES[@]}"; do
    [[ "${existing}" == "${service}" ]] && return 0
  done
  RELEASE_GO_UPGRADE_NEW_ATTEMPTED_SERVICES+=("${service}")
  release_append_recovery_record $'go_upgrade_new_attempt\t'"${service}"
}

release_go_upgrade_new_owner_record() {
  local wanted_service="$1"
  local kind service identity image_id commit
  local found=0
  [[ -f "${RELEASE_RECOVERY_FILE:-}" ]] || return 1
  while IFS=$'\t' read -r kind service identity image_id commit; do
    [[ "${kind}" == go_upgrade_new_owner && "${service}" == "${wanted_service}" ]] || continue
    found=$((found + 1))
    REPLY="${identity}"$'\t'"${image_id}"$'\t'"${commit}"
  done <"${RELEASE_RECOVERY_FILE}"
  [[ "${found}" == 1 ]]
}

release_go_upgrade_record_new_owner() {
  local service="$1"
  local container_id="$2"
  local identity image_id revision expected_image
  release_go_upgrade_service_is_managed "${service}" || return 0
  if ! identity="$(docker inspect "${container_id}" --format '{{.Id}}' 2>/dev/null)"; then
    echo "could not inspect new Go ${service} owner identity" >&2
    return 1
  fi
  [[ "${identity}" =~ ^[0-9a-f]{64}$ ]] || {
    echo "new Go ${service} owner identity is not canonical" >&2
    return 1
  }
  release_verify_fence_owner "${service}" "${identity}" || return 1
  release_expected_go_service_image_id "${service}" || return 1
  expected_image="${REPLY}"
  if ! image_id="$(docker inspect "${identity}" --format '{{.Image}}' 2>/dev/null)" || [[ ! "${image_id}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "new Go ${service} owner image identity is not canonical" >&2
    return 1
  fi
  [[ "${image_id}" == "${expected_image}" ]] || {
    echo "new Go ${service} owner does not use its pinned candidate image" >&2
    return 1
  }
  if ! revision="$(docker inspect "${identity}" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null)" || [[ "${revision}" != "${current_commit}" ]]; then
    echo "new Go ${service} owner revision is not the requested release" >&2
    return 1
  fi
  # Record the verified created container before start/health can fail. This
  # record also identifies an unhealthy writer during fail-closed recovery.
  if release_go_upgrade_new_owner_record "${service}"; then
    local recorded_identity recorded_image recorded_commit
    IFS=$'\t' read -r recorded_identity recorded_image recorded_commit <<<"${REPLY}"
    [[ "${recorded_identity}" == "${identity}" && "${recorded_image}" == "${image_id}" && "${recorded_commit}" == "${current_commit}" ]] || {
      echo "new Go ${service} owner identity changed" >&2
      return 1
    }
    return 0
  fi
  release_append_recovery_record $'go_upgrade_new_owner\t'"${service}"$'\t'"${identity}"$'\t'"${image_id}"$'\t'"${current_commit}"
}

release_go_upgrade_fence_new_services() {
  [[ "${RELEASE_GO_UPGRADE:-false}" == true ]] || return 0
  local service ids identity old_identity expected_image new_identity new_image new_commit
  for service in "${RELEASE_GO_UPGRADE_NEW_ATTEMPTED_SERVICES[@]}"; do
    if ! ids="$(release_current_service_ids "${service}")"; then
      echo "could not inspect failed new Go ${service} owner" >&2
      return 1
    fi
    [[ -n "${ids}" ]] || continue
    release_go_upgrade_require_single_current_id "${service}" "${ids}" || return 1
    identity="${REPLY}"
    release_go_upgrade_previous_owner_record "${service}" || {
      echo "previous Go ${service} owner record is missing during failed-owner fencing" >&2
      return 1
    }
    IFS=$'\t' read -r old_identity expected_image _ <<<"${REPLY}"
    if [[ "${identity}" == "${old_identity}" ]]; then
      release_go_upgrade_fence_phase_and_confirm old "${service}" "${expected_image}" \
        "${RELEASE_GO_UPGRADE_OLD_COMMIT}" "${identity}" || return 1
      continue
    fi
    if release_go_upgrade_is_recreated_old_owner "${service}" "${identity}"; then
      release_go_upgrade_fence_phase_and_confirm "recovered-${identity}" "${service}" "${expected_image}" \
        "${RELEASE_GO_UPGRADE_OLD_COMMIT}" "${identity}" || return 1
      continue
    fi
    release_go_upgrade_new_owner_record "${service}" || {
      echo "new Go ${service} owner was not recorded before failure" >&2
      return 1
    }
    IFS=$'\t' read -r new_identity new_image new_commit <<<"${REPLY}"
    [[ "${identity}" == "${new_identity}" && "${new_commit}" == "${current_commit}" ]] || {
      echo "new Go ${service} owner identity drifted before fencing" >&2
      return 1
    }
    release_go_upgrade_fence_phase_and_confirm new "${service}" "${new_image}" "${current_commit}" "${new_identity}" || return 1
  done
}

release_go_upgrade_rollback_compose() {
  if declare -F go_upgrade_rollback_compose >/dev/null 2>&1; then
    go_upgrade_rollback_compose "$@"
    return
  fi
  echo "Go-to-Go rollback Compose function is unavailable" >&2
  return 1
}

release_go_upgrade_is_recreated_old_owner() {
  local wanted_service="$1" wanted_id="$2" kind service identity image commit expected count=0
  expected="$(release_go_upgrade_old_image_id "${wanted_service}")" || return 1
  [[ "${wanted_id}" =~ ^[0-9a-f]{64}$ && -f "${RELEASE_RECOVERY_FILE}" ]] || return 1
  while IFS=$'\t' read -r kind service identity image commit; do
    [[ "${kind}" == go_upgrade_old_created && "${service}" == "${wanted_service}" && "${identity}" == "${wanted_id}" ]] || continue
    [[ "${image}" == "${expected}" && "${commit}" == "${RELEASE_GO_UPGRADE_OLD_COMMIT}" ]] || return 1
    count=$((count + 1))
  done <"${RELEASE_RECOVERY_FILE}"
  [[ "${count}" == 1 ]]
}

release_go_upgrade_restore_old_service() {
  local service="$1"
  local current_ids current_id old_image old_identity old_commit restored_ids restored_id image revision project service_label running
  local fenced_identity restart_name restart_max original_running fenced_image fenced_commit
  release_go_upgrade_service_is_managed "${service}" || return 1
  [[ -n "${RELEASE_GO_UPGRADE_OLD_COMPOSE_FILE}" ]] || {
    echo "previous Go recovery Compose is unavailable" >&2
    return 1
  }
  release_verify_external_files_manifest "${RELEASE_GO_UPGRADE_OLD_COMPOSE_FILE}" "${RELEASE_GO_UPGRADE_OLD_EXTERNAL_MANIFEST}" || return 1
  release_verify_pinned_volume_authority "${RELEASE_GO_UPGRADE_OLD_COMPOSE_FILE}" \
    "${RELEASE_GO_ACTIVATION_COMPOSE_FILE:-${RELEASE_GO_UPGRADE_CURRENT_COMPOSE_FILE}}" || return 1
  old_image="$(release_go_upgrade_old_image_id "${service}")" || return 1
  release_go_upgrade_previous_owner_record "${service}" || return 1
  IFS=$'\t' read -r old_identity _ old_commit <<<"${REPLY}"
  [[ "${old_commit}" == "${RELEASE_GO_UPGRADE_OLD_COMMIT}" ]] || return 1
  release_go_upgrade_fence_target_for_service old "${service}" || return 1
  IFS=$'\t' read -r fenced_identity restart_name restart_max original_running fenced_image fenced_commit <<<"${REPLY}"
  [[ "${fenced_identity}" == "${old_identity}" && "${fenced_image}" == "${old_image}" && \
    "${fenced_commit}" == "${old_commit}" && "${original_running}" == true ]] || return 1
  release_restart_policy_spec "${restart_name}" "${restart_max}" || return 1

  if ! release_go_upgrade_rollback_compose up --no-start --pull never --no-build --no-deps --force-recreate "${service}" >/dev/null 2>&1; then
    echo "could not recreate previous Go ${service} from its canonical Compose" >&2
    return 1
  fi
  if ! restored_ids="$(release_go_upgrade_rollback_compose ps -a -q "${service}" 2>/dev/null)"; then
    echo "could not identify restored Go ${service}" >&2
    return 1
  fi
  release_go_upgrade_require_single_current_id "${service}" "${restored_ids}" || return 1
  restored_id="${REPLY}"
  if ! image="$(docker inspect "${restored_id}" --format '{{.Image}}' 2>/dev/null)" || [[ "${image}" != "${old_image}" ]]; then
    echo "restored Go ${service} does not use the pinned previous image" >&2
    return 1
  fi
  release_verify_fence_owner "${service}" "${restored_id}" || return 1
  if ! revision="$(docker inspect "${restored_id}" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null)" || [[ "${revision}" != "${RELEASE_GO_UPGRADE_OLD_COMMIT}" ]]; then
    echo "restored Go ${service} revision does not match the previous release" >&2
    return 1
  fi
  if ! running="$(docker inspect "${restored_id}" --format '{{.State.Running}}' 2>/dev/null)" || [[ "${running}" != false ]]; then
    echo "previous Go ${service} was running before recovery verification" >&2
    return 1
  fi
  local version
  if ! version="$(docker inspect "${restored_id}" --format '{{index .Config.Labels "org.opencontainers.image.version"}}' 2>/dev/null)" || [[ "${version}" != "${RELEASE_GO_UPGRADE_OLD_VERSION}" ]]; then
    echo "restored Go service version differs from its pinned previous release" >&2
    return 1
  fi
  # Retrying recovery must recognize this exact replacement even if start,
  # readiness, or the final gateway smoke fails after creation.
  release_verify_fence_identity "${restored_id}" "${restored_id}" || return 1
  release_append_recovery_record $'go_upgrade_old_created\t'"${service}"$'\t'"${restored_id}"$'\t'"${old_image}"$'\t'"${RELEASE_GO_UPGRADE_OLD_COMMIT}" || return 1
  release_apply_restart_policy "${restored_id}" no 0 || return 1
  release_verify_pinned_volume_authority "${RELEASE_GO_UPGRADE_OLD_COMPOSE_FILE}" \
    "${RELEASE_GO_ACTIVATION_COMPOSE_FILE:-${RELEASE_GO_UPGRADE_CURRENT_COMPOSE_FILE}}" || return 1
  docker start "${restored_id}" >/dev/null 2>&1 || return 1
  release_wait_container_ready "${restored_id}" "${service}" || return 1
  release_verify_pinned_volume_authority "${RELEASE_GO_UPGRADE_OLD_COMPOSE_FILE}" \
    "${RELEASE_GO_ACTIVATION_COMPOSE_FILE:-${RELEASE_GO_UPGRADE_CURRENT_COMPOSE_FILE}}" || return 1
  release_apply_restart_policy "${restored_id}" "${restart_name}" "${restart_max}" || return 1
  release_record_replacement "${service}" "${restored_id}" || return 1
  release_append_recovery_record $'go_upgrade_old_restored\t'"${service}"$'\t'"${restored_id}"
}

release_go_upgrade_recover_all_services() {
  [[ "${RELEASE_PROFILE_NAME}" == go-full && "${RELEASE_GO_UPGRADE:-false}" == true ]] || return 1
  [[ "${RELEASE_GO_UPGRADE_VALIDATED}" == true && -n "${RELEASE_GO_UPGRADE_OLD_COMPOSE_FILE}" ]] || {
    echo "Go-to-Go daemon recovery requires a validated previous release snapshot" >&2
    return 1
  }
  [[ "${RELEASE_GO_UPGRADE_DAEMON_RECOVERY_DONE}" != true ]] || return 0

  local service ids identity old_identity old_image old_commit
  local new_identity new_image new_commit new_running
  local -a services=(p2p workspace worker web)

  # This is deliberately a complete first phase. No old Go owner is restored
  # until every service has either fenced its new owner or confirmed that no
  # recorded new owner is running.
  for service in "${services[@]}"; do
    release_go_upgrade_previous_owner_record "${service}" || {
      echo "previous ${service} Go owner record is missing during daemon recovery" >&2
      return 1
    }
    IFS=$'\t' read -r old_identity old_image old_commit <<<"${REPLY}"
    [[ "${old_commit}" == "${RELEASE_GO_UPGRADE_OLD_COMMIT}" ]] || {
      echo "previous ${service} Go owner record has the wrong release commit" >&2
      return 1
    }

    if ! ids="$(release_current_service_ids "${service}")"; then
      echo "could not inspect ${service} during Go-to-Go daemon recovery" >&2
      return 1
    fi
    if [[ -n "${ids}" ]]; then
      release_go_upgrade_require_single_current_id "${service}" "${ids}" || return 1
      identity="${REPLY}"
      if [[ "${identity}" == "${old_identity}" ]]; then
        release_go_upgrade_fence_phase_and_confirm old "${service}" "${old_image}" "${RELEASE_GO_UPGRADE_OLD_COMMIT}" "${old_identity}" || return 1
        continue
      fi
      if release_go_upgrade_is_recreated_old_owner "${service}" "${identity}"; then
        release_go_upgrade_fence_phase_and_confirm "recovered-${identity}" "${service}" "${old_image}" \
          "${RELEASE_GO_UPGRADE_OLD_COMMIT}" "${identity}" || return 1
        continue
      fi
      release_go_upgrade_new_owner_record "${service}" || {
        echo "unrecorded Go-to-Go owner found during daemon recovery" >&2
        return 1
      }
      IFS=$'\t' read -r new_identity new_image new_commit <<<"${REPLY}"
      [[ "${identity}" == "${new_identity}" && "${new_commit}" == "${current_commit}" ]] || {
        echo "new Go-to-Go owner identity drifted during daemon recovery" >&2
        return 1
      }
      release_go_upgrade_fence_phase_and_confirm new "${service}" "${new_image}" "${current_commit}" "${new_identity}" || return 1
      continue
    fi

    # A failed start may have left a recorded container outside the current
    # Compose service inventory. It is safe to continue only after Docker
    # confirms that exact owner is stopped. An inspect failure, including
    # an unproven absence, blocks automatic recovery for operator review.
    if release_go_upgrade_new_owner_record "${service}"; then
      IFS=$'\t' read -r new_identity new_image new_commit <<<"${REPLY}"
      [[ "${new_commit}" == "${current_commit}" ]] || {
        echo "recorded new Go ${service} owner has the wrong release commit" >&2
        return 1
      }
      if ! new_running="$(docker inspect "${new_identity}" --format '{{.State.Running}}' 2>/dev/null)"; then
        echo "could not confirm the recorded new Go ${service} owner is gone" >&2
        return 1
      fi
      [[ "${new_running}" == false ]] || {
        echo "recorded new Go ${service} owner is not stopped during daemon recovery" >&2
        return 1
      }
    fi
  done
  release_append_recovery_record 'go_upgrade_daemon_new_owners_fenced=true' || return 1

  release_require_drained_runtime recovery || return 1

  for service in "${services[@]}"; do
    release_go_upgrade_restore_old_service "${service}" || return 1
  done
  release_append_recovery_record 'go_upgrade_daemon_old_owners_restored=true' || return 1
  release_run_previous_gateway_smoke || return 1
  RELEASE_GO_UPGRADE_DAEMON_RECOVERY_DONE=true
}

release_go_upgrade_recover_service() {
  local service="$1"
  release_go_upgrade_service_is_managed "${service}" || return 1
  release_go_upgrade_recover_all_services
}

release_go_upgrade_rollback_application() {
  [[ "${RELEASE_PROFILE_NAME}" == go-full && "${RELEASE_GO_UPGRADE:-false}" == true ]] || return 1
  [[ "${RELEASE_GO_UPGRADE_VALIDATED}" == true && -n "${RELEASE_GO_UPGRADE_OLD_COMPOSE_FILE}" ]] || {
    echo "Go-to-Go rollback requires a validated previous release snapshot" >&2
    return 1
  }
  release_append_recovery_record 'go_upgrade_rollback_started=true' || return 1
  # A previous recovery may already have recreated services that the partial
  # activation never attempted. Re-fence the complete current owner set on
  # every retry, using the same recovery path as a daemon interruption.
  release_go_upgrade_recover_all_services || return 1
  release_append_recovery_record 'go_upgrade_rollback_complete=true' || return 1
}

release_remove_service_if_present() {
  local service="$1"
  local ids identity expected_image actual_image actual_run running remaining
  ids="$(release_current_service_ids "${service}")" || return 1
  [[ -n "${ids}" ]] || return 0
  release_go_upgrade_require_single_current_id "${service}" "${ids}" || return 1
  identity="${REPLY}"
  release_verify_fence_owner "${service}" "${identity}" || return 1
  release_verify_fence_identity "${identity}" "${identity}" || return 1
  release_expected_go_service_image_id "${service}" || return 1
  expected_image="${REPLY}"
  actual_image="$(docker inspect "${identity}" --format '{{.Image}}' 2>/dev/null)" || return 1
  actual_run="$(docker inspect "${identity}" --format '{{index .Config.Labels "com.duallane.release-run"}}' 2>/dev/null)" || return 1
  [[ "${RELEASE_GO_RUN_ID}" =~ ^[0-9a-f]{64}$ && "${actual_run}" == "${RELEASE_GO_RUN_ID}" && "${actual_image}" == "${expected_image}" ]] || {
    echo "refusing to remove a container outside the pinned release run" >&2
    return 1
  }
  release_fence_target_for_identity "${service}" "${identity}" || return 1
  release_fence_service_is_complete "${service}" || return 1
  release_verify_restart_policy "${identity}" no 0 || return 1
  running="$(docker inspect "${identity}" --format '{{.State.Running}}' 2>/dev/null)" || return 1
  [[ "${running}" == false ]] || return 1
  # Never resolve the service name again inside a destructive command. A
  # concurrent replacement is not this run's cleanup target; rm without force
  # also refuses a container that restarted after the stopped-state check.
  docker rm "${identity}" >/dev/null 2>&1 || return 1
  remaining="$(release_current_service_ids "${service}")" || return 1
  [[ -z "${remaining}" ]] || {
    echo "a service owner appeared during release cleanup; recovery is blocked" >&2
    return 1
  }
  release_append_recovery_record $'removed_release_owner\t'"${service}"$'\t'"${identity}"
}

release_candidate_network_alias() {
  case "$1" in
    p2p|workspace|worker|web)
      printf '%s\n' "$1"
      ;;
    *)
      echo "candidate service $1 has no fixed network alias" >&2
      return 1
      ;;
  esac
}

release_candidate_container_id() {
  local candidate_name="$1"
  local ids
  if ! ids="$(docker ps -a --filter "name=^/${candidate_name}$" --format '{{.ID}}' 2>/dev/null)"; then
    echo "cannot inspect release candidate ${candidate_name}" >&2
    return 1
  fi
  if [[ -z "${ids}" ]]; then
    return 0
  fi
  if [[ "${ids}" == *$'\n'* ]]; then
    echo "multiple containers match release candidate ${candidate_name}" >&2
    return 1
  fi
  printf '%s\n' "${ids}"
}

release_verify_candidate_ownership() {
  local candidate_name="$1"
  local service="$2"
  local container_id="$3"
  local project label expected actual label_check
  [[ -n "${container_id}" ]] || {
    echo "release candidate ${candidate_name} is missing" >&2
    return 1
  }
  project="$(release_compose_project_name)" || return 1
  local -a checks=(
    "com.duallane.release-owned=true"
    "com.duallane.release-profile=${RELEASE_PROFILE_NAME}"
    "com.duallane.release-commit=${current_commit}"
    "com.duallane.release-service=${service}"
    "com.docker.compose.project=${project}"
    "com.docker.compose.service=${service}"
  )
  for label_check in "${checks[@]}"; do
    label="${label_check%%=*}"
    expected="${label_check#*=}"
    if ! actual="$(docker inspect "${container_id}" --format "{{index .Config.Labels \"${label}\"}}" 2>/dev/null)"; then
      echo "cannot inspect release candidate ownership labels" >&2
      return 1
    fi
    if [[ "${actual}" != "${expected}" ]]; then
      echo "refusing to use an unowned release candidate ${candidate_name}" >&2
      return 1
    fi
  done
}

release_remove_owned_candidate_if_present() {
  local candidate_name="$1"
  local service="$2"
  local container_id
  if ! container_id="$(release_candidate_container_id "${candidate_name}")"; then
    return 1
  fi
  [[ -n "${container_id}" ]] || return 0
  release_verify_candidate_ownership "${candidate_name}" "${service}" "${container_id}" || return 1
  docker rm -f "${container_id}" >/dev/null 2>&1 || return 1
}

release_prepare_candidate_network() {
  [[ "${RELEASE_PROFILE_NAME}" == "go-full" ]] || return 0
  local project network_name
  project="$(release_compose_project_name)" || return 1
  network_name="${project}-go-full-candidate-network-${current_commit:0:12}"
  local owned profile commit
  export DUALLANE_GO_CANDIDATE_NETWORK="${network_name}"

  if docker network inspect "${network_name}" >/dev/null 2>&1; then
    if ! owned="$(docker network inspect "${network_name}" --format '{{index .Labels "com.duallane.release-owned"}}')"; then return 1; fi
    if ! profile="$(docker network inspect "${network_name}" --format '{{index .Labels "com.duallane.release-profile"}}')"; then return 1; fi
    if ! commit="$(docker network inspect "${network_name}" --format '{{index .Labels "com.duallane.release-commit"}}')"; then return 1; fi
    if [[ "${owned}" != true || "${profile}" != "${RELEASE_PROFILE_NAME}" || "${commit}" != "${current_commit}" ]]; then
      echo "refusing to reuse an unowned Go candidate network" >&2
      return 1
    fi
  else
    if ! docker network create \
      --driver bridge \
      --label com.duallane.release-owned=true \
      --label "com.duallane.release-profile=${RELEASE_PROFILE_NAME}" \
      --label "com.duallane.release-commit=${current_commit}" \
      "${network_name}" >/dev/null; then
      echo "could not create the Go candidate network" >&2
      return 1
    fi
  fi
  RELEASE_CANDIDATE_NETWORK_NAME="${network_name}"
}

release_candidate_network_contains() {
  local container_name="$1"
  [[ -n "${RELEASE_CANDIDATE_NETWORK_NAME}" ]] || return 1
  local network_json
  network_json="$(docker inspect "${container_name}" --format '{{json .NetworkSettings.Networks}}')" || return 2
  printf '%s' "${network_json}" | node -e '
    const [expectedNetwork] = process.argv.slice(1);
    let networks;
    try {
      networks = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    } catch {
      process.exit(2);
    }
    if (!networks || typeof networks !== "object" || Array.isArray(networks)) process.exit(2);
    process.exit(Object.prototype.hasOwnProperty.call(networks, expectedNetwork) ? 0 : 1);
  ' "${RELEASE_CANDIDATE_NETWORK_NAME}" 2>/dev/null
}

release_attach_candidate_alias() {
  local container_name="$1"
  local service="$2"
  local alias
  alias="$(release_candidate_network_alias "${service}")" || return 1
  [[ -n "${RELEASE_CANDIDATE_NETWORK_NAME}" ]] || {
    echo "candidate network was not prepared" >&2
    return 1
  }
  local attached_status=0
  if release_candidate_network_contains "${container_name}"; then
    docker network disconnect "${RELEASE_CANDIDATE_NETWORK_NAME}" "${container_name}" >/dev/null || return 1
  else
    attached_status=$?
    if ((attached_status != 1)); then
      echo "cannot inspect candidate network attachment" >&2
      return 1
    fi
  fi
  docker network connect --alias "${alias}" "${RELEASE_CANDIDATE_NETWORK_NAME}" "${container_name}" >/dev/null || return 1
}

release_verify_candidate_network_alias() {
  local container_name="$1"
  local service="$2"
  local alias network_json
  alias="$(release_candidate_network_alias "${service}")" || return 1
  network_json="$(docker inspect "${container_name}" --format '{{json .NetworkSettings.Networks}}')" || return 1
  if ! printf '%s' "${network_json}" | node -e '
    const [expectedNetwork, expectedAlias] = process.argv.slice(1);
    let networks;
    try {
      networks = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    } catch {
      process.exit(1);
    }
    const candidate = networks[expectedNetwork];
    if (!candidate || !(candidate.Aliases ?? []).includes(expectedAlias)) process.exit(1);
    for (const [name, endpoint] of Object.entries(networks)) {
      if (name !== expectedNetwork && (endpoint.Aliases ?? []).includes(expectedAlias)) process.exit(1);
    }
  ' "${RELEASE_CANDIDATE_NETWORK_NAME}" "${alias}" 2>/dev/null; then
    echo "${service} candidate network alias is not isolated" >&2
    return 1
  fi
}

release_cleanup_candidate_network() {
  local network_name="${RELEASE_CANDIDATE_NETWORK_NAME}"
  [[ -n "${network_name}" ]] || return 0
  local owned profile commit
  if ! docker network inspect "${network_name}" >/dev/null 2>&1; then
    echo "cannot inspect the owned Go candidate network during cleanup" >&2
    return 1
  fi
  if ! owned="$(docker network inspect "${network_name}" --format '{{index .Labels "com.duallane.release-owned"}}')"; then return 1; fi
  if ! profile="$(docker network inspect "${network_name}" --format '{{index .Labels "com.duallane.release-profile"}}')"; then return 1; fi
  if ! commit="$(docker network inspect "${network_name}" --format '{{index .Labels "com.duallane.release-commit"}}')"; then return 1; fi
  if [[ "${owned}" != true || "${profile}" != "${RELEASE_PROFILE_NAME}" || "${commit}" != "${current_commit}" ]]; then
    echo "refusing to remove an unowned Go candidate network" >&2
    return 1
  fi
  docker network rm "${network_name}" >/dev/null || return 1
  RELEASE_CANDIDATE_NETWORK_NAME=""
  unset DUALLANE_GO_CANDIDATE_NETWORK
}

release_candidate_environment_args() {
  local service="$1"
  RELEASE_CANDIDATE_ENV_ARGS=()
  case "${service}" in
    api)
      RELEASE_CANDIDATE_ENV_ARGS+=(
        -e WORKSPACE_ENABLED=false
        -e DATABASE_AUTO_MIGRATE=false
        -e WORKSPACE_EMAIL_WORKER_ENABLED=false
        -e WORKSPACE_NTFY_WORKER_ENABLED=false
        -e WORKSPACE_ECHO_DELIVERY_WORKER_ENABLED=false
        -e DUALLANE_DATA_DIR=/tmp/duallane-candidate-api
      )
      ;;
    p2p)
      ;;
    workspace)
      RELEASE_CANDIDATE_ENV_ARGS+=(
        -e WORKSPACE_ENABLED=true
        -e WORKSPACE_CANDIDATE_HEALTH_ONLY=true
      )
      ;;
    worker)
      RELEASE_CANDIDATE_ENV_ARGS+=(
        -e WORKSPACE_ENABLED=true
        -e WORKER_VALIDATE_ONLY=true
      )
      ;;
    web)
      ;;
    *)
      echo "candidate service ${service} is not part of the fixed release interface" >&2
      return 1
      ;;
  esac
}

release_verify_candidate_environment() {
  local container_name="$1"
  local service="$2"
  local expected
  release_candidate_environment_args "${service}" || return 1
  local environment
  if ! environment="$(docker inspect "${container_name}" --format '{{range .Config.Env}}{{println .}}{{end}}')"; then
    return 1
  fi
  case "${service}" in
    api)
      local key count
      for expected in \
        WORKSPACE_ENABLED=false \
        DATABASE_AUTO_MIGRATE=false \
        WORKSPACE_EMAIL_WORKER_ENABLED=false \
        WORKSPACE_NTFY_WORKER_ENABLED=false \
        WORKSPACE_ECHO_DELIVERY_WORKER_ENABLED=false \
        DUALLANE_DATA_DIR=/tmp/duallane-candidate-api; do
        key="${expected%%=*}"
        count="$(grep -c -E "^${key}=" <<<"${environment}" || true)"
        [[ "${count}" == "1" ]] || {
          echo "api candidate effective environment is not exact" >&2
          return 1
        }
        grep -Fxq "${expected}" <<<"${environment}" || {
          echo "api candidate effective environment is not safe" >&2
          return 1
        }
      done
      ;;
    workspace)
      for expected in WORKSPACE_ENABLED=true WORKSPACE_CANDIDATE_HEALTH_ONLY=true; do
        grep -Fxq "${expected}" <<<"${environment}" || return 1
      done
      ;;
    worker)
      for expected in \
        WORKSPACE_ENABLED=true \
        WORKER_VALIDATE_ONLY=true; do
        grep -Fxq "${expected}" <<<"${environment}" || return 1
      done
      ;;
  esac
}

release_verify_candidate_private_data_path() {
  local container_name="$1"
  local service="$2"
  [[ "${RELEASE_PROFILE_NAME}" == "node-default" && "${service}" == "api" ]] || return 0

  local destinations
  if ! destinations="$(docker inspect "${container_name}" --format '{{range .Mounts}}{{println .Destination}}{{end}}')"; then
    echo "cannot inspect Node API candidate data mounts" >&2
    return 1
  fi
  local destination
  while IFS= read -r destination; do
    [[ -n "${destination}" ]] || continue
    case "${destination}" in
      /|/tmp|/tmp/*)
        echo "Node API candidate data path is covered by a container mount" >&2
        return 1
        ;;
    esac
  done <<<"${destinations}"
}

release_verify_candidate_user() {
  local container_name="$1"
  local service="$2"
  local expected_user=""
  case "${service}" in
    workspace|worker)
      expected_user="65532:65532"
      ;;
    *)
      return 0
      ;;
  esac

  local actual_user
  actual_user="$(docker inspect "${container_name}" --format '{{.Config.User}}')"
  if [[ "${actual_user}" != "${expected_user}" ]]; then
    echo "${service} candidate must run as ${expected_user}" >&2
    return 1
  fi
}

release_verify_candidate_filesystem() {
  local container_name="$1"
  local service="$2"
  case "${service}" in
    workspace|worker)
      ;;
    *)
      return 0
      ;;
  esac

  local data_mount_rw rootfs_readonly
  if ! data_mount_rw="$(docker inspect "${container_name}" --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.RW}}{{end}}{{end}}' 2>/dev/null)"; then
    echo "cannot inspect ${service} candidate data mount" >&2
    return 1
  fi
  if [[ "${data_mount_rw}" != "false" ]]; then
    echo "${service} candidate data mount must be read-only" >&2
    return 1
  fi
  if ! rootfs_readonly="$(docker inspect "${container_name}" --format '{{.HostConfig.ReadonlyRootfs}}' 2>/dev/null)"; then
    echo "cannot inspect ${service} candidate root filesystem policy" >&2
    return 1
  fi
  if [[ "${rootfs_readonly}" != "true" ]]; then
    echo "${service} candidate root filesystem must be read-only" >&2
    return 1
  fi
}

release_verify_candidate_mode() {
  local container_name="$1"
  local service="$2"
  local expected_mode
  case "${service}" in
    workspace)
      expected_mode="candidate-health-only"
      ;;
    worker)
      expected_mode="validate-only"
      ;;
    *)
      return 0
      ;;
  esac
  docker exec "${container_name}" \
    /usr/local/bin/duallane-healthcheck \
    http://127.0.0.1:8787/readyz \
    "--expect-mode=${expected_mode}" >/dev/null 2>&1
}

release_verify_candidate_has_no_published_ports() {
  local container_name="$1"
  local bindings
  bindings="$(docker inspect "${container_name}" --format '{{json .HostConfig.PortBindings}}')"
  case "${bindings}" in
    ""|"null"|"{}"|"[]")
      return 0
      ;;
    *)
      echo "candidate has a published host port" >&2
      return 1
      ;;
  esac
}

release_verify_container_release() {
  local container_name="$1"
  local service="$2"
  local image_version image_commit
  image_version="$(docker inspect "${container_name}" --format '{{index .Config.Labels "org.opencontainers.image.version"}}')"
  image_commit="$(docker inspect "${container_name}" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
  if [[ "${image_version}" != "${expected_app_version:-}" || "${image_commit}" != "${current_commit:-}" ]]; then
    echo "${service} candidate release metadata mismatch" >&2
    return 1
  fi
}

release_wait_candidate() {
  local container_name="$1"
  local service="$2"
  local attempt status
  for ((attempt = 1; attempt <= RELEASE_HEALTH_ATTEMPTS; attempt += 1)); do
    if ! status="$(docker inspect "${container_name}" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}')"; then
      echo "cannot inspect candidate ${service} state" >&2
      return 1
    fi
    if [[ "${status}" == "healthy" ]]; then
      return 0
    fi
    if [[ "${status}" == "exited" || "${status}" == "dead" || "${status}" == "unhealthy" ]]; then
      echo "candidate ${service} did not become healthy" >&2
      return 1
    fi
    sleep 2
  done
  echo "candidate ${service} readiness timed out" >&2
  return 1
}

release_start_candidate() {
  local service="$1"
  local candidate_name="duallane-${RELEASE_PROFILE_NAME}-candidate-${service}-${current_commit:0:12}"
  local candidate_run_options=(-d --no-deps)
  local candidate_record="${service}"$'\t'"${candidate_name}"
  release_candidate_environment_args "${service}" || return 1
  if [[ "${RELEASE_PROFILE_NAME}" == "go-full" ]]; then
    case "${service}" in
      p2p|web)
        candidate_run_options+=(--use-aliases)
        ;;
      workspace|worker)
        # These services also use the production default network for
        # PostgreSQL. Attach their upstream alias only to the isolated
        # candidate network below; --use-aliases would publish it on both.
        ;;
    esac
  fi
  release_remove_owned_candidate_if_present "${candidate_name}" "${service}" || return 1
  candidate_run_options+=(
    --label com.duallane.release-owned=true
    --label "com.duallane.release-profile=${RELEASE_PROFILE_NAME}"
    --label "com.duallane.release-commit=${current_commit}"
    --label "com.duallane.release-service=${service}"
  )
  RELEASE_CANDIDATE_RECORDS+=("${candidate_record}")
  if ! release_candidate_compose run "${candidate_run_options[@]}" --name "${candidate_name}" "${RELEASE_CANDIDATE_ENV_ARGS[@]}" "${service}" >/dev/null; then
    echo "could not start ${service} release candidate" >&2
    return 1
  fi
  local candidate_id
  if ! candidate_id="$(release_candidate_container_id "${candidate_name}")"; then
    return 1
  fi
  release_verify_candidate_ownership "${candidate_name}" "${service}" "${candidate_id}" || return 1
  release_verify_container_release "${candidate_name}" "${service}" || return 1
  release_verify_candidate_environment "${candidate_name}" "${service}" || return 1
  release_verify_candidate_private_data_path "${candidate_name}" "${service}" || return 1
  if [[ "${RELEASE_PROFILE_NAME}" == "go-full" ]]; then
    release_verify_candidate_user "${candidate_name}" "${service}" || return 1
    release_verify_candidate_filesystem "${candidate_name}" "${service}" || return 1
    release_attach_candidate_alias "${candidate_name}" "${service}" || return 1
    release_verify_candidate_network_alias "${candidate_name}" "${service}" || return 1
  fi
  release_verify_candidate_has_no_published_ports "${candidate_name}" || return 1
  release_wait_candidate "${candidate_name}" "${service}" || return 1
  if [[ "${RELEASE_PROFILE_NAME}" == "go-full" ]]; then
    release_verify_candidate_mode "${candidate_name}" "${service}" || return 1
  fi
  if [[ "${RELEASE_PROFILE_NAME}" != "go-full" ]]; then
    release_remove_owned_candidate_if_present "${candidate_name}" "${service}" || return 1
    local remaining_records=()
    local record
    for record in "${RELEASE_CANDIDATE_RECORDS[@]}"; do
      [[ "${record}" == "${candidate_record}" ]] || remaining_records+=("${record}")
    done
    RELEASE_CANDIDATE_RECORDS=("${remaining_records[@]}")
  fi
}

release_start_candidates() {
  local service
  release_prepare_candidate_network || return 1
  for service in "${RELEASE_CANDIDATE_SERVICES[@]}"; do
    if ! release_start_candidate "${service}"; then
      return 1
    fi
  done
  release_cleanup_candidates || return 1
  release_cleanup_candidate_network
}

release_cleanup_candidates() {
  local record service candidate_name
  for record in "${RELEASE_CANDIDATE_RECORDS[@]}"; do
    [[ -n "${record}" ]] || continue
    IFS=$'\t' read -r service candidate_name <<<"${record}"
    if ! release_remove_owned_candidate_if_present "${candidate_name}" "${service}"; then
      echo "could not clean owned release candidate ${candidate_name}" >&2
      return 1
    fi
  done
  RELEASE_CANDIDATE_RECORDS=()
}

release_compose_project_name() {
  local project="${COMPOSE_PROJECT_NAME:-}"
  if [[ -z "${project}" ]]; then
    project="${PROJECT_DIR:-duallane}"
    project="${project##*/}"
  fi
  printf '%s\n' "${project}"
}

release_refuse_node_profile_with_active_go() {
  [[ "${RELEASE_PROFILE_NAME}" == "node-default" ]] || return 0
  local project service ids
  project="$(release_compose_project_name)"
  for service in p2p workspace worker; do
    if ! ids="$(docker ps \
      --filter "label=com.docker.compose.project=${project}" \
      --filter "label=com.docker.compose.service=${service}" \
      --filter status=running \
      --quiet)"; then
      echo "cannot inspect active Go services before the Node release" >&2
      return 1
    fi
    if [[ -n "${ids}" ]]; then
      echo "node-default refuses to run while Go service ${service} is active; use the explicit Go transition procedure" >&2
      return 1
    fi
  done
}

release_snapshot_validate_for_go_cutover() {
  if [[ "${RELEASE_PROFILE_NAME}" != "go-full" ]]; then
    release_refuse_node_profile_with_active_go
    return
  fi
  if [[ "${RELEASE_GO_UPGRADE:-false}" == true ]]; then
    release_prepare_go_upgrade_snapshot
    return
  fi
  local service
  [[ -f "${RELEASE_SNAPSHOT_FILE}" ]] || {
    echo "go-full requires an application state snapshot before handoff" >&2
    return 1
  }
  for service in "${RELEASE_GO_SERVICES[@]}"; do
    if release_snapshot_was_running "${service}"; then
      echo "go-full currently supports the Node-to-Go first cutover only; active Go service ${service} was found" >&2
      return 1
    fi
  done
}

release_snapshot_records_for_service() {
  local wanted_service="$1"
  local record_service id image_id image_ref running status health
  [[ -f "${RELEASE_SNAPSHOT_FILE}" ]] || return 0
  while IFS=$'\t' read -r record_service id image_id image_ref running status health; do
    [[ "${record_service}" == "${wanted_service}" ]] || continue
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "${id}" "${image_id}" "${image_ref}" "${running}" "${status}" "${health}"
  done <"${RELEASE_SNAPSHOT_FILE}"
}

release_service_requires_health() {
  release_profile_contains "$1" "${RELEASE_HEALTH_REQUIRED[@]}"
}

release_wait_container_ready() {
  local container_id="$1"
  local service="$2"
  local attempt state health
  for ((attempt = 1; attempt <= RELEASE_HEALTH_ATTEMPTS; attempt += 1)); do
    state="$(docker inspect "${container_id}" --format '{{.State.Status}}')"
    health="$(docker inspect "${container_id}" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')"
    if [[ "${state}" == "running" ]] && { ! release_service_requires_health "${service}" || [[ "${health}" == "healthy" ]]; }; then
      return 0
    fi
    if [[ "${state}" == "exited" || "${state}" == "dead" || "${health}" == "unhealthy" ]]; then
      echo "restored ${service} is not healthy" >&2
      return 1
    fi
    sleep 2
  done
  echo "restored ${service} readiness timed out" >&2
  return 1
}

release_restart_policy_spec() {
  local restart_name="$1"
  local restart_max="$2"
  [[ "${restart_max}" =~ ^[0-9]+$ ]] || {
    echo "container restart policy retry count is invalid" >&2
    return 1
  }
  case "${restart_name}" in
    no|always|unless-stopped)
      [[ "${restart_max}" == 0 ]] || {
        echo "container restart policy retry count is invalid" >&2
        return 1
      }
      REPLY="${restart_name}"
      ;;
    on-failure)
      if [[ "${restart_max}" == 0 ]]; then
        REPLY="on-failure"
      else
        REPLY="on-failure:${restart_max}"
      fi
      ;;
    *)
      echo "container restart policy is unsupported" >&2
      return 1
      ;;
  esac
}

release_apply_restart_policy() {
  local container_id="$1"
  local restart_name="$2"
  local restart_max="$3"
  local restart_spec
  release_restart_policy_spec "${restart_name}" "${restart_max}" || return 1
  restart_spec="${REPLY}"
  if ! docker update --restart="${restart_spec}" "${container_id}" >/dev/null 2>&1; then
    echo "could not restore the selected container restart policy" >&2
    return 1
  fi
  release_verify_restart_policy "${container_id}" "${restart_name}" "${restart_max}"
}

release_fence_first_target_for_service() {
  local wanted_service="$1"
  local kind service identity restart_name restart_max original_running
  [[ -f "${RELEASE_RECOVERY_FILE:-}" ]] || return 1
  while IFS=$'\t' read -r kind service identity restart_name restart_max original_running; do
    if [[ "${kind}" == "fence_target" && "${service}" == "${wanted_service}" ]]; then
      printf '%s\t%s\t%s\t%s\n' "${identity}" "${restart_name}" "${restart_max}" "${original_running}"
      return 0
    fi
  done <"${RELEASE_RECOVERY_FILE}"
  return 1
}

release_restore_fenced_policy_on_container() {
  local service="$1"
  local container_id="$2"
  local target old_identity restart_name restart_max original_running
  if ! release_fence_service_has_target "${service}"; then
    return 0
  fi
  release_fence_require_single_target "${service}" || return 1
  release_fence_service_is_complete "${service}" || {
    echo "cannot restore a known-good ${service} owner before fencing completes" >&2
    return 1
  }
  release_verify_fence_owner "${service}" "${container_id}" || return 1
  release_verify_canonical_container_identity "${container_id}" || return 1
  if ! target="$(release_fence_first_target_for_service "${service}")"; then
    return 1
  fi
  IFS=$'\t' read -r old_identity restart_name restart_max original_running <<<"${target}"
  [[ "${original_running}" == true ]] || return 0
  release_apply_restart_policy "${container_id}" "${restart_name}" "${restart_max}" || return 1
  release_append_recovery_record $'fence_replacement_restored\t'"${service}"$'\t'"${container_id}"
}

release_restore_fenced_service() {
  local service="$1"
  release_fence_require_single_target "${service}" || return 1
  release_fence_service_is_complete "${service}" || {
    echo "cannot restore ${service} before restart-policy fencing completes" >&2
    return 1
  }
  local target identity restart_name restart_max original_running current_state found=false
  while IFS=$'\t' read -r identity restart_name restart_max original_running; do
    [[ -n "${identity}" ]] || continue
    found=true
    [[ "${original_running}" == true ]] || continue
    release_verify_fence_owner "${service}" "${identity}" || return 1
    release_verify_fence_identity "${identity}" "${identity}" || return 1
    if ! current_state="$(docker inspect "${identity}" --format '{{.State.Running}}' 2>/dev/null)"; then
      echo "cannot inspect the fenced ${service} owner during recovery" >&2
      return 1
    fi
    [[ "${current_state}" == false ]] || {
      echo "refusing to restore a fenced ${service} owner that is still running" >&2
      return 1
    }
    release_verify_restart_policy "${identity}" no 0 || return 1
    docker start "${identity}" >/dev/null || return 1
    release_wait_container_ready "${identity}" "${service}" || return 1
    release_apply_restart_policy "${identity}" "${restart_name}" "${restart_max}" || return 1
    release_append_recovery_record $'fence_restored\t'"${service}"$'\t'"${identity}"
  done < <(release_fence_target_records_for_service "${service}")
  [[ "${found}" == true ]]
}

release_start_snapshot_service() {
  local service="$1"
  local record id image_id image_ref running status health current_state
  while IFS=$'\t' read -r id image_id image_ref running status health; do
    [[ -n "${id}" ]] || continue
    [[ "${running}" == "true" ]] || continue
    if ! current_state="$(docker inspect "${id}" --format '{{.State.Running}}')"; then
      echo "cannot inspect captured ${service} container during recovery" >&2
      return 1
    fi
    if [[ "${current_state}" != "true" ]]; then
      docker start "${id}" >/dev/null || return 1
    fi
    release_wait_container_ready "${id}" "${service}" || return 1
  done < <(release_snapshot_records_for_service "${service}")
}

release_record_replacement() {
  local service="$1"
  local container_id="$2"
  [[ -n "${RELEASE_RECOVERY_FILE:-}" && -n "${service}" && -n "${container_id}" ]] || return 0
  umask 077
  printf 'replacement_%s=%s\n' "${service}" "${container_id}" >>"${RELEASE_RECOVERY_FILE}"
}

release_replacement_id_for_service() {
  local service="$1"
  local key replacement
  [[ -f "${RELEASE_RECOVERY_FILE:-}" ]] || return 0
  key="replacement_${service}"
  while IFS= read -r replacement; do
    [[ -n "${replacement}" ]] || continue
    printf '%s\n' "${replacement}"
    return 0
  done < <(sed -n "s/^${key}=//p" "${RELEASE_RECOVERY_FILE}")
}

release_start_recovery_service() {
  local service="$1"
  local replacement current_state
  if [[ "${RELEASE_GO_UPGRADE:-false}" == true ]] && release_go_upgrade_service_is_managed "${service}"; then
    release_go_upgrade_recover_service "${service}"
    return
  fi
  if release_profile_contains "${service}" "${RELEASE_GO_SERVICES[@]}"; then
    if release_fence_service_has_target "${service}"; then
      release_fence_service_is_complete "${service}" || {
        echo "cannot recover while failed Go ${service} fencing is incomplete" >&2
        return 1
      }
      echo "skipping fenced failed Go ${service} owner during daemon recovery" >&2
      return 0
    fi
    if release_snapshot_was_running "${service}"; then
      echo "refusing to resurrect a failed Go ${service} owner during daemon recovery" >&2
      return 1
    fi
  fi
  replacement="$(release_replacement_id_for_service "${service}")"
  if [[ -n "${replacement}" ]]; then
    if ! current_state="$(docker inspect "${replacement}" --format '{{.State.Running}}')"; then
      echo "replacement container for ${service} is unavailable after daemon restart" >&2
      return 1
    fi
    if [[ "${current_state}" != "true" ]]; then
      docker start "${replacement}" >/dev/null || return 1
    fi
    release_wait_container_ready "${replacement}" "${service}" || return 1
    release_restore_fenced_policy_on_container "${service}" "${replacement}" || return 1
    return
  fi
  if release_fence_service_has_target "${service}"; then
    release_restore_fenced_service "${service}" || return 1
    return
  fi
  release_start_snapshot_service "${service}" || return 1
}

release_restore_daemon_snapshot() {
  local daemon_started_after service
  [[ -n "${docker_started_before:-}" ]] || return 0
  daemon_started_after="$(systemctl show docker -p ExecMainStartTimestampMonotonic --value 2>/dev/null)" || return 1
  [[ -n "${daemon_started_after}" ]] || return 1
  [[ "${daemon_started_after}" != "${docker_started_before}" ]] || return 0
  [[ -f "${RELEASE_SNAPSHOT_FILE}" ]] || {
    echo "Docker restarted without a captured application state snapshot" >&2
    return 1
  }
  if declare -F wait_for_docker >/dev/null 2>&1; then
    wait_for_docker || return 1
  else
    docker info >/dev/null || return 1
  fi
  echo "Docker daemon restarted; restoring the pre-deploy application state" >&2
  for service in "${RELEASE_RESTORE_ORDER[@]}"; do
    release_start_recovery_service "${service}" || return 1
  done
  if [[ -n "${RELEASE_RECOVERY_FILE:-}" ]]; then
    umask 077
    printf 'daemon_restart_restored=true\nprofile=%s\n' "${RELEASE_PROFILE_NAME}" >>"${RELEASE_RECOVERY_FILE}"
  fi
}

release_restore_success_nonparticipants() {
  local service
  for service in "${RELEASE_RESTORE_ORDER[@]}"; do
    release_snapshot_was_running "${service}" || continue
    if release_profile_contains "${service}" "${RELEASE_SERVICES[@]}"; then
      continue
    fi
    if release_profile_contains "${service}" "${RELEASE_STOP_BEFORE_BACKEND[@]}"; then
      continue
    fi
    release_start_snapshot_service "${service}" || return 1
  done
}

release_fence_success_legacy_services() {
  local service
  for service in "${RELEASE_STOP_BEFORE_BACKEND[@]}"; do
    release_stop_service_and_confirm "${service}" || return 1
  done
}

release_verify_success_profile_health() {
  local service ids id
  for service in "${RELEASE_HEALTH_REQUIRED[@]}"; do
    release_profile_contains "${service}" "${RELEASE_SERVICES[@]}" || continue
    if ! ids="$(release_current_service_ids "${service}")"; then
      echo "cannot inspect active ${service} containers after the Docker daemon restart" >&2
      return 1
    fi
    [[ -n "${ids}" ]] || {
      echo "active release profile has no container for ${service} after the Docker daemon restart" >&2
      return 1
    }
    while IFS= read -r id; do
      [[ -n "${id}" ]] || continue
      release_wait_container_ready "${id}" "${service}" || return 1
    done <<<"${ids}"
  done
}

release_restore_daemon_after_success() {
  local daemon_started_after
  [[ -n "${docker_started_before:-}" ]] || return 0
  daemon_started_after="$(systemctl show docker -p ExecMainStartTimestampMonotonic --value 2>/dev/null)" || return 1
  [[ -n "${daemon_started_after}" ]] || return 1
  [[ "${daemon_started_after}" != "${docker_started_before}" ]] || return 0
  [[ -f "${RELEASE_SNAPSHOT_FILE}" ]] || {
    echo "Docker restarted without a captured application state snapshot" >&2
    return 1
  }
  if declare -F wait_for_docker >/dev/null 2>&1; then
    wait_for_docker || return 1
  else
    docker info >/dev/null || return 1
  fi
  echo "Docker daemon restarted; restoring non-participating application services" >&2
  release_fence_success_legacy_services || return 1
  release_restore_success_nonparticipants || return 1
  release_verify_success_profile_health || return 1
  if [[ -n "${RELEASE_RECOVERY_FILE:-}" ]]; then
    umask 077
    printf 'daemon_restart_success_restored=true\nprofile=%s\n' "${RELEASE_PROFILE_NAME}" >>"${RELEASE_RECOVERY_FILE}"
  fi
}

release_retag_snapshot_images() {
  local service id image_id image_ref running status health
  [[ -f "${RELEASE_SNAPSHOT_FILE}" ]] || return 1
  while IFS=$'\t' read -r service id image_id image_ref running status health; do
    [[ -n "${service}" ]] || continue
    docker image tag "${image_id}" "${image_ref}" >/dev/null
  done <"${RELEASE_SNAPSHOT_FILE}"
}

release_restore_snapshot_service() {
  local service="$1"
  local id image_id image_ref running status health current_ids current_id
  if release_snapshot_was_running "${service}"; then
    if [[ "${RELEASE_PROFILE_NAME}" == go-full && -n "${RELEASE_NODE_RECOVERY_COMPOSE_FILE}" ]]; then
      release_restore_pinned_node_service "${service}"
      return
    fi
    release_rollback_compose up -d --no-deps --force-recreate --wait --wait-timeout 120 "${service}" >/dev/null || return 1
    current_ids="$(release_rollback_service_ids "${service}")" || return 1
    [[ -n "${current_ids}" ]] || {
      echo "rollback Compose did not return a container for ${service}" >&2
      return 1
    }
    if [[ "${current_ids}" == *$'\n'* ]]; then
      echo "rollback recovery expected one container for ${service}" >&2
      return 1
    fi
    current_id="${current_ids}"
    release_wait_container_ready "${current_id}" "${service}" || return 1
    release_restore_fenced_policy_on_container "${service}" "${current_id}" || return 1
    release_record_replacement "${service}" "${current_id}"
    return 0
  fi
  current_ids="$(release_rollback_service_ids "${service}")" || return 1
  [[ -n "${current_ids}" ]] || return 0
  release_rollback_compose rm -sf "${service}" >/dev/null || return 1
}

release_restore_pinned_node_service() {
  local service="$1" rows id image image_ref running status health current_id observed
  [[ "${service}" == api || "${service}" == web ]] || return 1
  release_verify_activation_authority || return 1
  rows="$(release_snapshot_records_for_service "${service}")" || return 1
  [[ -n "${rows}" && "${rows}" != *$'\n'* ]] || return 1
  IFS=$'\t' read -r id image image_ref running status health <<<"${rows}"
  [[ "${image}" =~ ^sha256:[0-9a-f]{64}$ && "${running}" == true ]] || return 1
  release_rollback_compose up --no-start --pull never --no-build --no-deps --force-recreate "${service}" >/dev/null 2>&1 || return 1
  current_id="$(release_rollback_service_ids "${service}")" || return 1
  release_go_upgrade_require_single_current_id "${service}" "${current_id}" || return 1
  release_verify_fence_owner "${service}" "${current_id}" || return 1
  observed="$(docker inspect "${current_id}" --format '{{.Image}}' 2>/dev/null)" || return 1
  [[ "${observed}" == "${image}" ]] || return 1
  observed="$(docker inspect "${current_id}" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null)" || return 1
  [[ "${observed}" == "${RELEASE_PREVIOUS_NODE_COMMIT}" ]] || return 1
  observed="$(docker inspect "${current_id}" --format '{{index .Config.Labels "org.opencontainers.image.version"}}' 2>/dev/null)" || return 1
  [[ "${observed}" == "${RELEASE_PREVIOUS_NODE_VERSION}" ]] || return 1
  observed="$(docker inspect "${current_id}" --format '{{.State.Running}}' 2>/dev/null)" || return 1
  [[ "${observed}" == false ]] || return 1
  # Re-creation must not silently change mounts or database/provider authority.
  # Recheck the real replacement before it can write, and again after health.
  release_verify_activation_authority || return 1
  release_record_replacement "${service}" "${current_id}" || return 1
  docker start "${current_id}" >/dev/null 2>&1 || return 1
  release_wait_container_ready "${current_id}" "${service}" || return 1
  release_verify_activation_authority || return 1
  release_restore_fenced_policy_on_container "${service}" "${current_id}" || return 1
}

release_rollback_application() {
  local service
  if [[ "${RELEASE_GO_UPGRADE:-false}" == true ]]; then
    release_go_upgrade_rollback_application
    return
  fi
  [[ -f "${RELEASE_SNAPSHOT_FILE}" ]] || {
    echo "cannot rollback without an application state snapshot" >&2
    return 1
  }

  # Whole-backend rollback fences every Go service before restoring Node.
  for service in "${RELEASE_GO_SERVICES[@]}"; do
    release_stop_service_and_confirm "${service}" || return 1
  done
  # A failed first cutover may have stopped midway through fencing Node.
  # Complete that fence as well before treating a database snapshot as quiet.
  if [[ "${RELEASE_PROFILE_NAME}" == go-full ]]; then
    release_stop_service_and_confirm api || return 1
  fi
  release_require_drained_runtime recovery || return 1
  if [[ "${RELEASE_PROFILE_NAME}" != go-full ]]; then
    release_retag_snapshot_images || return 1
  fi
  for service in "${RELEASE_GO_SERVICES[@]}"; do
    if ! release_snapshot_has_record "${service}"; then
      release_remove_service_if_present "${service}" || return 1
    fi
  done
  for service in "${RELEASE_ROLLBACK_ORDER[@]}"; do
    release_restore_snapshot_service "${service}" || return 1
  done
  release_run_previous_gateway_smoke || return 1
  release_verify_activation_authority
}
