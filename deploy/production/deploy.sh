#!/usr/bin/env bash

set -Eeuo pipefail

umask 077

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
readonly ENV_FILE="${DUALLANE_ENV_FILE:-${PROJECT_DIR}/.env}"
readonly BACKUP_DIR="${DUALLANE_BACKUP_DIR:-${PROJECT_DIR}/backups/production}"
readonly LOCK_FILE="${DUALLANE_DEPLOY_LOCK_FILE:-/tmp/duallane-production-deploy.lock}"
readonly COMPOSE_FILES=(
  --env-file "${ENV_FILE}"
  -f "${PROJECT_DIR}/docker-compose.yml"
  -f "${PROJECT_DIR}/docker-compose.production.yml"
)

bootstrap=false
expected_commit=""
app_replaced=false
rollback_api_id=""
rollback_api_ref=""
rollback_web_id=""
rollback_web_ref=""

usage() {
  cat <<'EOF'
Usage: deploy/production/deploy.sh [--bootstrap] [--expected-commit <git-sha>]

Deploys API and Web through the production Compose override. The script refuses
to switch an existing PostgreSQL container to a different volume. Use
--bootstrap only when creating the first production container for an already
provisioned POSTGRES_VOLUME_NAME.
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

compose() {
  docker compose "${COMPOSE_FILES[@]}" "$@"
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
      compose logs --tail 80 postgres >&2 || true
      return 1
    fi
    sleep 2
  done
  echo "PostgreSQL did not become healthy within 60 seconds" >&2
  compose logs --tail 80 postgres >&2 || true
  return 1
}

wait_for_app() {
  local url="$1"
  local attempt
  for attempt in {1..30}; do
    if curl --fail --silent --show-error --max-time 5 "${url}" | grep -q '"ok":true'; then
      return 0
    fi
    sleep 2
  done
  echo "Application health check failed: ${url}" >&2
  compose ps >&2 || true
  compose logs --tail 120 api web >&2 || true
  return 1
}

capture_rollback_image() {
  local service="$1"
  local container_id
  container_id="$(compose ps -a -q "${service}" 2>/dev/null || true)"
  if [[ -z "${container_id}" ]]; then
    return 0
  fi
  if [[ "${service}" == "api" ]]; then
    rollback_api_id="$(docker inspect "${container_id}" --format '{{.Image}}')"
    rollback_api_ref="$(docker inspect "${container_id}" --format '{{.Config.Image}}')"
  else
    rollback_web_id="$(docker inspect "${container_id}" --format '{{.Image}}')"
    rollback_web_ref="$(docker inspect "${container_id}" --format '{{.Config.Image}}')"
  fi
}

rollback_app() {
  if [[ "${app_replaced}" != true ]]; then
    return 0
  fi
  echo "Deployment failed after replacing the application; restoring previous images" >&2
  if [[ -n "${rollback_api_id}" && -n "${rollback_api_ref}" ]]; then
    docker image tag "${rollback_api_id}" "${rollback_api_ref}"
  fi
  if [[ -n "${rollback_web_id}" && -n "${rollback_web_ref}" ]]; then
    docker image tag "${rollback_web_id}" "${rollback_web_ref}"
  fi
  compose up -d --no-deps --force-recreate api web || true
}

on_error() {
  local exit_code=$?
  trap - ERR
  if [[ -n "${backup_temporary:-}" ]]; then
    rm -f "${backup_temporary}" || true
  fi
  rollback_app || true
  echo "Production deployment failed with exit code ${exit_code}" >&2
  exit "${exit_code}"
}

trap on_error ERR

for command in docker curl git grep sed sha256sum flock; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "Required command is unavailable: ${command}" >&2
    exit 1
  fi
done

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

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Tracked production worktree changes must be committed before deployment" >&2
  exit 1
fi

readonly current_commit="$(git rev-parse HEAD)"
if [[ -n "${expected_commit}" && "${current_commit}" != "${expected_commit}"* ]]; then
  echo "Expected commit ${expected_commit}, found ${current_commit}" >&2
  exit 1
fi
if git show-ref --verify --quiet refs/remotes/origin/main; then
  readonly origin_main_commit="$(git rev-parse refs/remotes/origin/main)"
  if [[ "${current_commit}" != "${origin_main_commit}" ]]; then
    echo "Production HEAD ${current_commit} does not match origin/main ${origin_main_commit}" >&2
    exit 1
  fi
fi

postgres_volume="${POSTGRES_VOLUME_NAME:-$(read_env_value POSTGRES_VOLUME_NAME)}"
if [[ ! "${postgres_volume}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]+$ ]]; then
  echo "POSTGRES_VOLUME_NAME is missing or invalid" >&2
  exit 1
fi
export POSTGRES_VOLUME_NAME="${postgres_volume}"

wait_for_docker
docker volume inspect "${postgres_volume}" >/dev/null
compose config --quiet

readonly docker_started_before="$(systemctl show docker -p ExecMainStartTimestampMonotonic --value 2>/dev/null || true)"

postgres_container="$(compose ps -a -q postgres 2>/dev/null || true)"
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

if [[ -z "${postgres_container}" || "$(container_health "${postgres_container}")" != "healthy" ]]; then
  compose up -d --no-deps postgres
  postgres_container="$(compose ps -q postgres)"
  wait_for_postgres "${postgres_container}"
fi

mkdir -p "${BACKUP_DIR}"
readonly timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
readonly backup_path="${BACKUP_DIR}/duallane-${timestamp}-${current_commit:0:12}.dump"
readonly backup_temporary="${backup_path}.tmp"
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

capture_rollback_image api
capture_rollback_image web

compose build api web migrate
compose run --rm --no-deps migrate

app_replaced=true
compose up -d --no-deps api web

health_url="${DUALLANE_DEPLOY_HEALTH_URL:-$(read_env_value PUBLIC_BASE_URL)/api/health}"
if [[ ! "${health_url}" =~ ^https?:// ]]; then
  echo "DUALLANE_DEPLOY_HEALTH_URL or PUBLIC_BASE_URL must be an HTTP(S) URL" >&2
  exit 1
fi
wait_for_app "${health_url}"

readonly docker_started_after="$(systemctl show docker -p ExecMainStartTimestampMonotonic --value 2>/dev/null || true)"
if [[ -n "${docker_started_before}" && "${docker_started_before}" != "${docker_started_after}" ]]; then
  echo "WARNING: Docker daemon restarted during deployment; services are healthy but the host requires operator review" >&2
fi

app_replaced=false
trap - ERR

echo "Production deployment completed"
echo "commit=${current_commit}"
echo "postgres_volume=${postgres_volume}"
echo "backup=${backup_path}"
echo "health=${health_url}"
