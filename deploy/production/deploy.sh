#!/usr/bin/env bash

set -Eeuo pipefail

umask 077

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd -P)"
readonly ENV_FILE="${DUALLANE_ENV_FILE:-${PROJECT_DIR}/.env}"
readonly BACKUP_DIR="${DUALLANE_BACKUP_DIR:-${PROJECT_DIR}/backups/production}"
readonly LOCK_FILE="${DUALLANE_DEPLOY_LOCK_FILE:-/tmp/duallane-production-deploy.lock}"
readonly BASE_COMPOSE_FILES=(
  --env-file "${ENV_FILE}"
  -f "${PROJECT_DIR}/docker-compose.yml"
  -f "${PROJECT_DIR}/docker-compose.production.yml"
)

source "${SCRIPT_DIR}/release-helper.sh"

bootstrap=false
expected_commit=""
release_profile="node-default"
go_upgrade=false
previous_release_snapshot=""
prepare_go_permissions=false
app_replaced=false
buildx_builder=""
buildx_builder_ready=false
buildx_cache_max=""
expected_app_version=""
release_state_file=""
release_recovery_file=""

usage() {
  cat <<'EOF'
Usage: deploy/production/deploy.sh [--bootstrap] --expected-commit <git-sha> [--release-profile node-default|go-full] [--prepare-go-permissions]

Deploys the fixed Node default profile unless the explicit go-full profile is
selected. The script refuses to switch an existing PostgreSQL container to a
different volume. Use --bootstrap only when creating the first production
container for an already provisioned POSTGRES_VOLUME_NAME. The expected commit
is mandatory so an operator cannot accidentally deploy a different checkout.
The checkout must also match DUALLANE_PRODUCTION_DIR, which defaults to
$HOME/duallane. go-full additionally requires the parent-provided Go Compose,
health, and candidate-runtime wiring; the manifest cannot satisfy those checks
by itself. Go-to-Go upgrades require --previous-release-snapshot pointing at
the mode-0600 snapshot from the last successful Go release.
--prepare-go-permissions is a root-only first Node-to-Go cutover option. It
backs up the private credential before snapshotting, then fences Node and
verifies a quiescent backup before tightening existing data-volume permissions.
It introduces a maintenance outage before passive candidates are checked.
EOF
}

while (($# > 0)); do
  case "$1" in
    --bootstrap)
      bootstrap=true
      shift
      ;;
    --expected-commit)
      if (($# < 2)); then
        echo "Missing value for --expected-commit" >&2
        exit 2
      fi
      expected_commit="$2"
      shift 2
      ;;
    --release-profile)
      if (($# < 2)); then
        echo "Missing value for --release-profile" >&2
        exit 2
      fi
      release_profile="$2"
      shift 2
      ;;
    --go-upgrade)
      go_upgrade=true
      shift
      ;;
    --previous-release-snapshot)
      if (($# < 2)); then
        echo "Missing value for --previous-release-snapshot" >&2
        exit 2
      fi
      previous_release_snapshot="$2"
      shift 2
      ;;
    --prepare-go-permissions)
      prepare_go_permissions=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "${prepare_go_permissions}" == true ]]; then
  if [[ "${release_profile}" != go-full || "${go_upgrade}" == true || "${bootstrap}" == true || "${EUID}" != 0 ]]; then
    echo "--prepare-go-permissions requires root and a first non-bootstrap go-full release" >&2
    exit 2
  fi
fi

if [[ "${go_upgrade}" == true && "${release_profile}" != "go-full" ]]; then
  echo "--go-upgrade requires the explicit go-full release profile" >&2
  exit 2
fi
if [[ "${go_upgrade}" == true && -z "${previous_release_snapshot}" ]]; then
  echo "--go-upgrade requires --previous-release-snapshot" >&2
  exit 2
fi
if [[ "${go_upgrade}" != true && -n "${previous_release_snapshot}" ]]; then
  echo "--previous-release-snapshot requires --go-upgrade" >&2
  exit 2
fi
if [[ "${go_upgrade}" == true ]]; then
  release_private_artifact_path "${previous_release_snapshot}" "previous Go snapshot" || exit 2
fi
export RELEASE_GO_UPGRADE="${go_upgrade}"
export RELEASE_PREVIOUS_RELEASE_SNAPSHOT="${previous_release_snapshot}"

compose() {
  if [[ "${release_profile:-node-default}" == go-full && -n "${RELEASE_GO_ACTIVATION_COMPOSE_FILE:-}" ]]; then
    docker compose --project-name "${RELEASE_GO_ACTIVATION_PROJECT}" \
      --profile rollback -f "${RELEASE_GO_ACTIVATION_COMPOSE_FILE}" "$@"
    return "$?"
  fi
  local compose_files=("${BASE_COMPOSE_FILES[@]}")
  if [[ "${release_profile:-node-default}" == "go-full" ]]; then
    compose_files+=(--profile rollback -f "${PROJECT_DIR}/docker-compose.go-production.yml")
    if [[ -n "${RELEASE_GO_IMAGE_OVERRIDE_FILE:-}" ]]; then
      compose_files+=(-f "${RELEASE_GO_IMAGE_OVERRIDE_FILE}")
    fi
  fi
  docker compose "${compose_files[@]}" "$@"
}

candidate_compose() {
  if [[ "${release_profile:-node-default}" != "go-full" ]]; then
    compose "$@"
    return "$?"
  fi
  if [[ -n "${RELEASE_GO_ACTIVATION_COMPOSE_FILE:-}" ]]; then
    docker compose --project-name "${RELEASE_GO_ACTIVATION_PROJECT}" --profile rollback \
      -f "${RELEASE_GO_ACTIVATION_COMPOSE_FILE}" \
      -f "${PROJECT_DIR}/deploy/production/go-candidate.compose.yml" "$@"
    return "$?"
  fi
  local compose_files=(
    "${BASE_COMPOSE_FILES[@]}"
    --profile rollback
    -f "${PROJECT_DIR}/docker-compose.go-production.yml"
    -f "${PROJECT_DIR}/deploy/production/go-candidate.compose.yml"
  )
  if [[ -n "${RELEASE_GO_IMAGE_OVERRIDE_FILE:-}" ]]; then
    compose_files+=(-f "${RELEASE_GO_IMAGE_OVERRIDE_FILE}")
  fi
  docker compose "${compose_files[@]}" "$@"
}

rollback_compose() {
  if [[ -n "${RELEASE_NODE_RECOVERY_COMPOSE_FILE:-}" ]]; then
    docker compose --project-name "${RELEASE_NODE_RECOVERY_PROJECT}" \
      -f "${RELEASE_NODE_RECOVERY_COMPOSE_FILE}" "$@"
    return "$?"
  fi
  # Rollback must reconstruct the captured Node stack from the base files;
  # the Go production override changes the Web image, user, dependencies, and
  # filesystem policy and is never valid for the old Node owner.
  docker compose "${BASE_COMPOSE_FILES[@]}" "$@"
}

go_upgrade_rollback_compose() {
  [[ "${RELEASE_GO_UPGRADE:-false}" == true ]] || {
    echo "Go-to-Go rollback Compose is only available for an explicit upgrade" >&2
    return 1
  }
  [[ -n "${RELEASE_GO_UPGRADE_OLD_PROJECT}" && -n "${RELEASE_GO_UPGRADE_OLD_COMPOSE_FILE}" ]] || {
    echo "Go-to-Go rollback Compose snapshot is unavailable" >&2
    return 1
  }
  docker compose \
    --project-name "${RELEASE_GO_UPGRADE_OLD_PROJECT}" \
    -f "${RELEASE_GO_UPGRADE_OLD_COMPOSE_FILE}" \
    "$@"
}

read_env_value() {
  local key="$1"
  sed -n "s/^${key}=//p" "${ENV_FILE}" | tail -n 1
}

wait_for_docker() {
  local attempt
  for attempt in {1..10}; do
    if docker info >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  echo "Docker daemon did not become ready within 20 seconds" >&2
  return 1
}

ensure_buildx_builder() {
  local builder_name="$1"
  local buildkit_image="$2"
  local driver
  if ! docker buildx inspect "${builder_name}" >/dev/null 2>&1; then
    docker buildx create \
      --name "${builder_name}" \
      --driver docker-container \
      --driver-opt "image=${buildkit_image}" >/dev/null
  fi
  driver="$(docker buildx inspect "${builder_name}" | sed -n 's/^Driver:[[:space:]]*//p')"
  if [[ "${driver}" != "docker-container" ]]; then
    echo "Buildx builder ${builder_name} must use the docker-container driver" >&2
    return 1
  fi
  buildx_builder_ready=true
  docker buildx inspect "${builder_name}" --bootstrap >/dev/null
}

stop_buildx_builder() {
  if [[ "${buildx_builder_ready}" != true || -z "${buildx_builder}" ]]; then
    return 0
  fi
  echo "Stopping Buildx builder ${buildx_builder}"
  if ! docker buildx stop "${buildx_builder}" >/dev/null; then
    echo "WARNING: could not stop Buildx builder ${buildx_builder}" >&2
  fi
  buildx_builder_ready=false
}

prune_buildx_cache() {
  local cache_max="$1"
  echo "Constraining Buildx cache to ${cache_max}"
  if ! docker buildx prune \
    --builder "${buildx_builder}" \
    --force \
    --max-used-space "${cache_max}" >/dev/null; then
    echo "WARNING: could not constrain Buildx cache for ${buildx_builder}" >&2
  fi
}

read_running_app_version() {
  local container_id="$1"
  local image_ref version
  version="$(docker inspect "${container_id}" --format '{{index .Config.Labels "org.opencontainers.image.version"}}' 2>/dev/null || true)"
  if [[ -n "${version}" ]]; then
    printf '%s\n' "${version}"
    return 0
  fi
  if [[ "$(docker inspect "${container_id}" --format '{{.State.Running}}')" == "true" ]]; then
    docker exec "${container_id}" node -p "require('/app/apps/web/package.json').version"
    return "$?"
  fi
  image_ref="$(docker inspect "${container_id}" --format '{{.Image}}')"
  docker run --rm --entrypoint node "${image_ref}" -p "require('/app/apps/web/package.json').version"
}

container_volume() {
  local container_id="$1"
  docker inspect "${container_id}" \
    --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}'
}

container_health() {
  local container_id="$1"
  docker inspect "${container_id}" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}'
}

wait_for_postgres() {
  local container_id="$1"
  local attempt status
  for attempt in {1..30}; do
    status="$(container_health "${container_id}")"
    if [[ "${status}" == "healthy" ]]; then
      return 0
    fi
    if [[ "${status}" == "exited" || "${status}" == "dead" ]]; then
      echo "PostgreSQL container entered state ${status}" >&2
      return 1
    fi
    sleep 2
  done
  echo "PostgreSQL did not become healthy within 60 seconds" >&2
  return 1
}

wait_for_app() {
  local url="$1"
  local expected_version="$2"
  local attempt response
  for attempt in {1..30}; do
    if response="$(curl --fail --silent --show-error --max-time 5 "${url}" 2>/dev/null)"; then
      if node -e '
        const health = JSON.parse(process.argv[1]);
        process.exit(health.ok === true && health.appVersion === process.argv[2] ? 0 : 1);
      ' "${response}" "${expected_version}" 2>/dev/null; then
        return 0
      fi
    fi
    sleep 2
  done
  echo "Application health/version check failed: ${url} (expected ${expected_version})" >&2
  return 1
}

verify_container_release() {
  local container_id="$1"
  local service_name="$2"
  local image_version image_commit
  image_version="$(docker inspect "${container_id}" --format '{{index .Config.Labels "org.opencontainers.image.version"}}')"
  image_commit="$(docker inspect "${container_id}" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
  if [[ "${image_version}" != "${expected_app_version}" || "${image_commit}" != "${current_commit}" ]]; then
    echo "${service_name} release metadata mismatch: version=${image_version}, commit=${image_commit}" >&2
    return 1
  fi
}

wait_for_candidate() {
  local container_name="$1"
  local service_name="$2"
  local attempt status
  for attempt in {1..40}; do
    status="$(container_health "${container_name}")"
    if [[ "${status}" == "healthy" ]]; then
      return 0
    fi
    if [[ "${status}" == "exited" || "${status}" == "dead" || "${status}" == "unhealthy" ]]; then
      echo "Candidate ${service_name} container entered state ${status}" >&2
      return 1
    fi
    sleep 2
  done
  echo "Candidate ${service_name} did not become healthy within 80 seconds" >&2
  return 1
}

cleanup_candidates() {
  release_cleanup_candidates || return 1
  release_cleanup_candidate_network
}

preflight_candidates() {
  release_start_candidates
}

rollback_app() {
  if [[ "${app_replaced}" != true ]]; then
    return 0
  fi
  echo "Deployment failed after replacing the application; fencing new owners and restoring the previous application state" >&2
  release_rollback_application
}

restore_runtime_after_daemon_restart() {
  release_restore_daemon_snapshot
}

restore_runtime_after_successful_deploy() {
  release_restore_daemon_after_success
}

start_release_service() {
  local service="$1"
  local ids id running
  if [[ "${RELEASE_PROFILE_NAME}" == go-full ]] && release_go_upgrade_service_is_managed "${service}"; then
    if [[ "${RELEASE_GO_UPGRADE:-false}" == true ]]; then
      release_go_upgrade_note_new_service_attempt "${service}" || return 1
    fi
    compose up --no-start --pull never --no-build --no-deps --force-recreate "${service}" >/dev/null 2>&1 || return 1
    ids="$(compose ps -a -q "${service}" 2>/dev/null)" || return 1
    release_go_upgrade_require_single_current_id "${service}" "${ids}" || return 1
    id="${REPLY}"
    release_verify_fence_owner "${service}" "${id}" || return 1
    verify_container_release "${id}" "${service}" || return 1
    release_verify_go_service_image_id "${service}" || return 1
    running="$(docker inspect "${id}" --format '{{.State.Running}}' 2>/dev/null)" || return 1
    [[ "${running}" == false ]] || {
      echo "Go owner was already running before activation verification" >&2
      return 1
    }
    if [[ "${RELEASE_GO_UPGRADE:-false}" == true ]]; then
      release_go_upgrade_record_new_owner "${service}" "${id}" || return 1
    fi
    docker start "${id}" >/dev/null 2>&1 || return 1
    release_wait_container_ready "${id}" "${service}" || return 1
    release_verify_go_service_image_id "${service}"
    return "$?"
  fi
  compose up -d --no-deps --wait --wait-timeout 120 "${service}" >/dev/null || return 1
  ids="$(compose ps -q "${service}")"
  [[ -n "${ids}" ]] || {
    echo "Compose did not return a container for ${service}" >&2
    return 1
  }
  while IFS= read -r id; do
    [[ -n "${id}" ]] || continue
    verify_container_release "${id}" "${service}"
    release_verify_go_service_image_id "${service}"
  done <<<"${ids}"
}

stop_legacy_services_for_go() {
  local service
  for service in "${RELEASE_STOP_BEFORE_BACKEND[@]}"; do
    release_stop_service_and_confirm "${service}" || return 1
  done
  echo "P2P in-memory sessions are interrupted by the whole-backend cutover" >&2
}

start_release_backend() {
  local service
  if [[ "${RELEASE_PROFILE_NAME}" == "go-full" ]]; then
    release_snapshot_validate_for_go_cutover || return 1
    app_replaced=true
    if [[ "${RELEASE_GO_UPGRADE:-false}" == true ]]; then
      release_go_upgrade_fence_old_services || return 1
    else
      stop_legacy_services_for_go || return 1
    fi
    release_require_drained_runtime activation || return 1
  else
    app_replaced=true
  fi
  for service in "${RELEASE_BACKEND_SERVICES[@]}"; do
    start_release_service "${service}" || return 1
  done
  for service in "${RELEASE_WORKER_SERVICES[@]}"; do
    start_release_service "${service}" || return 1
  done
}

start_release_edge() {
  local service
  for service in "${RELEASE_EDGE_SERVICES[@]}"; do
    start_release_service "${service}"
  done
}

on_error() {
  local exit_code=$?
  local recovery_failed=false
  local application_recovered=true
  trap - ERR
  if [[ -n "${backup_temporary:-}" ]]; then
    rm -f "${backup_temporary}" || true
  fi
  if ! cleanup_candidates; then
    recovery_failed=true
  fi
  if ! rollback_app; then
    recovery_failed=true
    application_recovered=false
  fi
  # A failed fence/drain is not permission for the generic daemon-restorer
  # to start the old writer. Leave ambiguous ownership stopped for review.
  if [[ "${application_recovered}" == true ]]; then
    if ! restore_runtime_after_daemon_restart; then
      recovery_failed=true
    fi
  fi
  if [[ "${recovery_failed}" == true ]]; then
    echo "Production deployment failed and automatic runtime recovery was incomplete; operator review is required" >&2
    exit 1
  fi
  # Recovery still needs the immutable current/previous Compose artifacts.
  # Keep them for operator diagnosis if automatic recovery was incomplete.
  release_cleanup_go_upgrade_artifacts || true
  echo "Production deployment failed with exit code ${exit_code}" >&2
  exit "${exit_code}"
}

on_exit() {
  local exit_code=$?
  trap - EXIT
  cleanup_candidates || true
  stop_buildx_builder || true
  exit "${exit_code}"
}

trap on_error ERR
trap on_exit EXIT

for command in docker cmp curl find flock git grep node realpath sed sha256sum sort stat systemctl tail; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "Required command is unavailable: ${command}" >&2
    exit 1
  fi
done

if ! release_load_profile "${release_profile}"; then
  exit 1
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Production environment file does not exist: ${ENV_FILE}" >&2
  exit 1
fi

exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
  echo "Another DualLane production deployment is already running" >&2
  exit 1
fi

cd "${PROJECT_DIR}"

production_dir="${DUALLANE_PRODUCTION_DIR:-$(read_env_value DUALLANE_PRODUCTION_DIR)}"
production_dir="${production_dir:-${HOME}/duallane}"
if [[ "${production_dir}" != /* ]]; then
  echo "DUALLANE_PRODUCTION_DIR must be an absolute path: ${production_dir}" >&2
  exit 1
fi
if ! production_dir="$(realpath -e -- "${production_dir}" 2>/dev/null)"; then
  echo "DUALLANE_PRODUCTION_DIR does not exist: ${production_dir}" >&2
  exit 1
fi
if [[ "${PROJECT_DIR}" != "${production_dir}" ]]; then
  echo "Refusing deployment from ${PROJECT_DIR}; production checkout is ${production_dir}" >&2
  exit 1
fi

if [[ -z "${expected_commit}" ]]; then
  echo "--expected-commit is required for production deployment" >&2
  exit 2
fi

if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
  echo "Production worktree must be clean before deployment" >&2
  exit 1
fi

readonly current_branch="$(git symbolic-ref --quiet --short HEAD || true)"
if [[ "${current_branch}" != "main" ]]; then
  echo "Production deployment requires the main branch, found ${current_branch:-detached HEAD}" >&2
  exit 1
fi
readonly current_commit="$(git rev-parse HEAD)"
requested_commit="${expected_commit}"
if [[ ! "${requested_commit}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "--expected-commit must be a full 40-character lowercase Git SHA" >&2
  exit 2
fi
if ! expected_commit="$(git rev-parse --verify "${requested_commit}^{commit}" 2>/dev/null)"; then
  echo "Expected commit is not a valid Git commit: ${requested_commit}" >&2
  exit 2
fi
if [[ "${current_commit}" != "${expected_commit}" ]]; then
  echo "Expected commit ${expected_commit}, found ${current_commit}" >&2
  exit 1
fi
if ! git show-ref --verify --quiet refs/remotes/origin/main; then
  echo "Production deployment requires a fetched origin/main reference" >&2
  exit 1
fi
readonly origin_main_commit="$(git rev-parse refs/remotes/origin/main)"
if [[ "${current_commit}" != "${origin_main_commit}" ]]; then
  echo "Production HEAD ${current_commit} does not match origin/main ${origin_main_commit}" >&2
  exit 1
fi

root_app_version="$(node -p "require('./package.json').version")"
expected_app_version="$(node -p "require('./apps/web/package.json').version")"
if [[ ! "${expected_app_version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Invalid application version in apps/web/package.json: ${expected_app_version}" >&2
  exit 1
fi
if [[ "${root_app_version}" != "${expected_app_version}" ]]; then
  echo "Package version mismatch: root=${root_app_version}, web=${expected_app_version}" >&2
  exit 1
fi
export DUALLANE_APP_VERSION="${expected_app_version}"
export DUALLANE_GIT_COMMIT="${current_commit}"

postgres_volume="${POSTGRES_VOLUME_NAME:-$(read_env_value POSTGRES_VOLUME_NAME)}"
if [[ ! "${postgres_volume}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]+$ ]]; then
  echo "POSTGRES_VOLUME_NAME is missing or invalid" >&2
  exit 1
fi
export POSTGRES_VOLUME_NAME="${postgres_volume}"

buildx_builder="${DUALLANE_BUILDX_BUILDER:-$(read_env_value DUALLANE_BUILDX_BUILDER)}"
buildx_builder="${buildx_builder:-duallane-production}"
buildkit_image="${DUALLANE_BUILDKIT_IMAGE:-$(read_env_value DUALLANE_BUILDKIT_IMAGE)}"
buildkit_image="${buildkit_image:-docker.m.daocloud.io/moby/buildkit:buildx-stable-1}"
buildx_cache_max="${DUALLANE_BUILDX_CACHE_MAX:-$(read_env_value DUALLANE_BUILDX_CACHE_MAX)}"
buildx_cache_max="${buildx_cache_max:-4gb}"
if [[ ! "${buildx_builder}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]+$ || -z "${buildkit_image}" || \
  ! "${buildx_cache_max}" =~ ^[1-9][0-9]*([KkMmGgTt]i?[Bb])?$ ]]; then
  echo "DUALLANE_BUILDX_BUILDER, DUALLANE_BUILDKIT_IMAGE, or DUALLANE_BUILDX_CACHE_MAX is invalid" >&2
  exit 1
fi

wait_for_docker
readonly docker_started_before="$(systemctl show docker -p ExecMainStartTimestampMonotonic --value 2>/dev/null || true)"
if [[ -z "${docker_started_before}" ]]; then
  echo "Could not capture the Docker daemon start marker" >&2
  exit 1
fi
docker volume inspect "${postgres_volume}" >/dev/null
compose config --quiet
release_validate_resolved_compose
release_pin_compose_project

if ! postgres_container="$(compose ps -a -q postgres 2>/dev/null)"; then
  echo "Could not inspect the PostgreSQL Compose container" >&2
  exit 1
fi
if [[ -n "${postgres_container}" ]]; then
  mounted_volume="$(container_volume "${postgres_container}")"
  if [[ "${mounted_volume}" != "${postgres_volume}" ]]; then
    echo "Refusing PostgreSQL volume switch: running configuration uses ${mounted_volume}, requested ${postgres_volume}" >&2
    exit 1
  fi
elif [[ "${bootstrap}" != true ]]; then
  echo "No existing PostgreSQL container was found; rerun with --bootstrap only after verifying ${postgres_volume}" >&2
  exit 1
fi

if ! running_api_container="$(compose ps -a -q api 2>/dev/null)"; then
  echo "Could not inspect the API Compose container" >&2
  exit 1
fi
if [[ "${go_upgrade}" != true && -n "${running_api_container}" ]]; then
  running_app_version="$(read_running_app_version "${running_api_container}")"
  running_app_commit="$(docker inspect "${running_api_container}" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null || true)"
  if [[ ! "${running_app_version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Cannot determine a valid version for the existing API container" >&2
    exit 1
  fi
  if [[ "${running_app_commit}" != "${current_commit}" ]] && \
    ! version_is_greater "${expected_app_version}" "${running_app_version}"; then
    echo "Release version ${expected_app_version} must be newer than running version ${running_app_version}" >&2
    exit 1
  fi
  if [[ "${release_profile}" == go-full ]]; then
    [[ "${running_app_commit}" =~ ^[0-9a-f]{40}$ ]] || {
      echo "Node-to-Go recovery requires a complete previous release revision" >&2
      exit 1
    }
    RELEASE_PREVIOUS_NODE_VERSION="${running_app_version}"
    RELEASE_PREVIOUS_NODE_COMMIT="${running_app_commit}"
  fi
fi

release_preflight_permission_tools
mkdir -p "${BACKUP_DIR}"
readonly timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
readonly backup_path="${BACKUP_DIR}/duallane-${timestamp}-${current_commit:0:12}.dump"
readonly backup_temporary="${backup_path}.tmp"
release_state_file="${BACKUP_DIR}/duallane-${timestamp}-${current_commit:0:12}.state"
release_recovery_file="${BACKUP_DIR}/duallane-${timestamp}-${current_commit:0:12}.recovery"
RELEASE_RECOVERY_FILE="${release_recovery_file}"
: >"${release_recovery_file}"
release_snapshot_app_state "${release_state_file}"
release_snapshot_validate_for_go_cutover
release_prepare_permission_inputs
release_freeze_node_recovery_compose

if [[ -z "${postgres_container}" || "$(container_health "${postgres_container}")" != "healthy" ]]; then
  compose up -d --no-deps postgres
  postgres_container="$(compose ps -q postgres)"
  wait_for_postgres "${postgres_container}"
fi

compose exec -T postgres sh -eu -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' >"${backup_temporary}"
if [[ ! -s "${backup_temporary}" ]]; then
  echo "PostgreSQL backup is empty" >&2
  exit 1
fi
mv "${backup_temporary}" "${backup_path}"
(
  cd "${BACKUP_DIR}"
  sha256sum "$(basename "${backup_path}")" >"$(basename "${backup_path}").sha256"
)

export BUILDX_BUILDER="${buildx_builder}"
export COMPOSE_PARALLEL_LIMIT="${COMPOSE_PARALLEL_LIMIT:-1}"
ensure_buildx_builder "${buildx_builder}" "${buildkit_image}"
compose build "${RELEASE_BUILD_SERVICES[@]}"
release_verify_go_edge_images
release_verify_go_image_identity
release_freeze_go_activation_compose
release_verify_activation_authority
if [[ "${RELEASE_PROFILE_NAME}" == "go-full" ]]; then
  release_verify_schema_upgrade_compatibility
  release_run_go_migration_and_verify
else
  compose run --rm --no-deps migrate
fi

if [[ "${RELEASE_PROFILE_NAME}" == "node-default" ]]; then
  release_start_candidate api
  start_release_backend
  release_start_candidate web
  start_release_edge
else
  if [[ "${prepare_go_permissions}" == true ]]; then
    # The snapshot records the genuinely running Node owner. From this point
    # any failure must recover that owner through the normal fences.
    app_replaced=true
    stop_legacy_services_for_go
    release_require_drained_runtime activation
    release_prepare_offline_data_permissions
  fi
  preflight_candidates
  start_release_backend
  start_release_edge
fi

web_bind="$(read_env_value DUALLANE_WEB_BIND)"
web_bind="${web_bind:-127.0.0.1}"
web_port="$(read_env_value DUALLANE_WEB_PORT)"
web_port="${web_port:-8787}"
if [[ "${web_bind}" == "0.0.0.0" ]]; then
  web_bind="127.0.0.1"
elif [[ "${web_bind}" == "::" ]]; then
  web_bind="[::1]"
elif [[ "${web_bind}" == *:* && "${web_bind}" != \[*\] ]]; then
  web_bind="[${web_bind}]"
fi
health_url="${DUALLANE_DEPLOY_HEALTH_URL:-$(read_env_value DUALLANE_DEPLOY_HEALTH_URL)}"
health_url="${health_url:-http://${web_bind}:${web_port}/api/health}"
if [[ ! "${health_url}" =~ ^https?:// ]]; then
  echo "DUALLANE_DEPLOY_HEALTH_URL or PUBLIC_BASE_URL must be an HTTP(S) URL" >&2
  exit 1
fi
wait_for_app "${health_url}" "${expected_app_version}"

readonly docker_started_after="$(systemctl show docker -p ExecMainStartTimestampMonotonic --value)"
if [[ -z "${docker_started_after}" ]]; then
  echo "Could not read the Docker daemon end marker" >&2
  exit 1
fi
if [[ -n "${docker_started_before}" && "${docker_started_before}" != "${docker_started_after}" ]]; then
  restore_runtime_after_successful_deploy
fi
if [[ "${RELEASE_PROFILE_NAME}" == go-full ]]; then
  release_run_gateway_smoke go-full "${expected_app_version}" "${current_commit}"
  release_capture_successful_go_snapshot
fi

app_replaced=false
trap - ERR
prune_buildx_cache "${buildx_cache_max}"
stop_buildx_builder

echo "Production deployment completed"
echo "commit=${current_commit}"
echo "version=${expected_app_version}"
echo "release_profile=${RELEASE_PROFILE_NAME}"
echo "postgres_volume=${postgres_volume}"
echo "backup=${backup_path}"
echo "state=${release_state_file}"
echo "health=${health_url}"
