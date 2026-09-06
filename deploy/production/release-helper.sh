#!/usr/bin/env bash

# Shared, deliberately small release helpers. The caller owns the Compose
# function and the production preflight; this file only handles the fixed
# release profiles' state transitions.

readonly RELEASE_HELPER_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly RELEASE_MANIFEST_HELPER="${RELEASE_HELPER_DIR}/release-manifest.mjs"

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
  local service="$1"
  local ids
  ids="$(release_current_service_ids "${service}")" || return 1
  [[ -n "${ids}" ]] || return 0
  compose stop --timeout "${RELEASE_STOP_TIMEOUT}" "${service}" >/dev/null || return 1
  release_wait_ids_not_running "${ids}" || return 1
}

release_remove_service_if_present() {
  local service="$1"
  local ids
  ids="$(release_current_service_ids "${service}")" || return 1
  [[ -n "${ids}" ]] || return 0
  compose rm -sf "${service}" >/dev/null || return 1
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
        -e WORKSPACE_EMAIL_WORKER_ENABLED=false
        -e WORKSPACE_NTFY_WORKER_ENABLED=false
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
  release_candidate_environment_args "${service}"
  local environment
  if ! environment="$(docker inspect "${container_name}" --format '{{range .Config.Env}}{{println .}}{{end}}')"; then
    return 1
  fi
  case "${service}" in
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
  release_candidate_environment_args "${service}"
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
  if [[ "${RELEASE_PROFILE_NAME}" == "go-full" ]]; then
    release_verify_candidate_environment "${candidate_name}" "${service}" || return 1
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
    release_record_replacement "${service}" "${current_id}"
    return 0
  fi
  current_ids="$(release_rollback_service_ids "${service}")" || return 1
  [[ -n "${current_ids}" ]] || return 0
  release_rollback_compose rm -sf "${service}" >/dev/null || return 1
}

release_rollback_application() {
  local service
  [[ -f "${RELEASE_SNAPSHOT_FILE}" ]] || {
    echo "cannot rollback without an application state snapshot" >&2
    return 1
  }

  # Whole-backend rollback fences every Go service before restoring Node.
  for service in "${RELEASE_GO_SERVICES[@]}"; do
    release_stop_service_and_confirm "${service}" || return 1
  done
  release_retag_snapshot_images || return 1
  for service in "${RELEASE_GO_SERVICES[@]}"; do
    if ! release_snapshot_has_record "${service}"; then
      release_remove_service_if_present "${service}" || return 1
    fi
  done
  for service in "${RELEASE_ROLLBACK_ORDER[@]}"; do
    release_restore_snapshot_service "${service}" || return 1
  done
}
