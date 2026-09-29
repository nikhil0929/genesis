#!/usr/bin/env bash
# Local development: Postgres + MinIO-compatible S3 in Docker, a filled-in .env, and the API server.
#
#   ./scripts/dev.sh           start everything and run the API server (Ctrl-C stops the server only)
#   ./scripts/dev.sh setup     start everything but don't run the server
#   ./scripts/dev.sh stop      stop the Postgres and S3 containers (data is kept)
#   ./scripts/dev.sh reset     delete the containers and all their data
#
# Ports can be changed with MCPDET_DEV_PG_PORT, MCPDET_DEV_S3_PORT and MCPDET_DEV_CONSOLE_PORT.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"

PG_CONTAINER="mcpdet-dev-postgres"
PG_VOLUME="mcpdet-dev-postgres"
PG_IMAGE="postgres:17-alpine"
PG_PORT="${MCPDET_DEV_PG_PORT:-55432}"
PG_USER="mcpdet"
PG_PASSWORD="mcpdet"
PG_DB="mcpdet"

# MinIO's own images were pulled from Docker Hub and Quay; Silo is a drop-in fork with the same API and config.
S3_CONTAINER="mcpdet-dev-minio"
S3_VOLUME="mcpdet-dev-minio"
S3_IMAGE="pgsty/silo:RELEASE.2026-09-16T00-00-00Z"
S3_PORT="${MCPDET_DEV_S3_PORT:-9000}"
CONSOLE_PORT="${MCPDET_DEV_CONSOLE_PORT:-9001}"
S3_USER="mcpdet"
S3_PASSWORD="mcpdet-dev-secret"
S3_BUCKET="mcpdet-runs"
S3_REGION="us-east-1"

DEFAULT_LISTEN="127.0.0.1:8787"

if [[ -t 1 ]]; then
  BOLD=$'\033[1m' RED=$'\033[31m' GREEN=$'\033[32m' YELLOW=$'\033[33m' DIM=$'\033[2m' RESET=$'\033[0m'
else
  BOLD="" RED="" GREEN="" YELLOW="" DIM="" RESET=""
fi

step() { printf '%s==>%s %s\n' "$BOLD" "$RESET" "$*"; }
ok() { printf '    %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '    %s!%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
die() {
  printf '\n%sError:%s %s\n' "$RED$BOLD" "$RESET" "$1" >&2
  shift
  for line in "$@"; do printf '       %s\n' "$line" >&2; done
  exit 1
}

usage() {
  sed -n '4,7p' "${BASH_SOURCE[0]}" | sed 's/^# *//'
}

# ---------- preflight ----------

check_docker() {
  command -v docker >/dev/null 2>&1 ||
    die "Docker isn't installed." "Install Docker Desktop from https://docs.docker.com/get-docker/ and try again."
  local err
  if ! err="$(docker version --format '{{.Server.Version}}' 2>&1 >/dev/null)"; then
    if grep -qi "permission denied" <<<"$err"; then
      die "Docker is running, but your user isn't allowed to use it." \
        "On Linux, run: sudo usermod -aG docker \$USER, then log out and back in."
    fi
    die "Docker daemon not found. Please start Docker Desktop (or your Docker engine) and try again." \
      "${DIM}docker said: $(head -n 1 <<<"$err")${RESET}"
  fi
}

check_node() {
  local wanted
  wanted="$(grep -oE '[0-9]+' "$ROOT/.nvmrc" 2>/dev/null | head -n 1)"
  wanted="${wanted:-24}"
  command -v node >/dev/null 2>&1 ||
    die "Node.js isn't installed." "Install Node $wanted or newer (for example with fnm or nvm: 'nvm install $wanted') and try again."
  command -v npm >/dev/null 2>&1 ||
    die "npm wasn't found next to Node.js." "Reinstall Node $wanted or newer, which ships with npm, and try again."
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  ((major >= wanted)) ||
    die "Node $major is too old; this project needs Node $wanted or newer." \
      "Switch with 'nvm use' or 'fnm use' in the repo folder, then try again."
}

# ---------- containers ----------

container_state() { docker inspect -f '{{.State.Status}}' "$1" 2>/dev/null || true; }

port_in_use() {
  command -v lsof >/dev/null 2>&1 || return 1
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

# ensure_container NAME LABEL "PORT ..." IMAGE docker-run-args...
# Recreates the container when its settings changed; named volumes keep the data.
ensure_container() {
  local name=$1 label=$2 ports=$3 image=$4
  shift 4
  local config
  config="$(printf '%s\n' "$@" | cksum | cut -d' ' -f1)"
  local state
  state="$(container_state "$name")"

  if [[ -n $state ]]; then
    local existing
    existing="$(docker inspect -f '{{index .Config.Labels "mcpdet.dev.config"}}' "$name")"
    if [[ $existing != "$config" ]]; then
      warn "$label settings changed; recreating the container (data is kept)"
      docker rm -f "$name" >/dev/null
      state=""
    fi
  fi

  case "$state" in
    running)
      ok "$label is already running"
      return
      ;;
    "") ;;
    *)
      check_ports "$label" "$ports"
      docker start "$name" >/dev/null || die "Couldn't start the $label container." "See 'docker logs $name' for details."
      ok "$label started"
      return
      ;;
  esac

  check_ports "$label" "$ports"
  if ! docker image inspect "$image" >/dev/null 2>&1; then
    printf '    %sdownloading %s (first run only)...%s\n' "$DIM" "$image" "$RESET"
    docker pull -q "$image" >/dev/null ||
      die "Couldn't download the Docker image $image." "Check your internet connection and try again."
  fi
  local err
  if ! err="$(docker run -d --name "$name" --label "mcpdet.dev.config=$config" "$@" 2>&1 >/dev/null)"; then
    docker rm -f "$name" >/dev/null 2>&1 || true
    if grep -qiE "port is already allocated|address already in use" <<<"$err"; then
      die "A port $label needs is already in use ($ports)." "Stop whatever is using it, or pick other ports (see the top of scripts/dev.sh)."
    fi
    die "Couldn't start the $label container." "${DIM}docker said: $(head -n 1 <<<"$err")${RESET}"
  fi
  ok "$label started"
}

port_setting() {
  case "$1" in
    "$PG_PORT") echo MCPDET_DEV_PG_PORT ;;
    "$S3_PORT") echo MCPDET_DEV_S3_PORT ;;
    *) echo MCPDET_DEV_CONSOLE_PORT ;;
  esac
}

check_ports() {
  local label=$1 port
  for port in $2; do
    if port_in_use "$port"; then
      die "Port $port is already in use, so $label can't start." \
        "Stop the program using it (find it with: lsof -nP -iTCP:$port -sTCP:LISTEN)," \
        "or use another port: $(port_setting "$port")=<free port> ./scripts/dev.sh"
    fi
  done
}

wait_for() {
  local label=$1 container=$2
  shift 2
  local i
  for ((i = 0; i < 60; i++)); do
    if docker exec "$container" "$@" >/dev/null 2>&1; then
      ok "$label is ready"
      return
    fi
    if [[ $(container_state "$container") != running ]]; then break; fi
    sleep 1
  done
  printf '\n%sLast log lines from %s:%s\n' "$DIM" "$container" "$RESET" >&2
  docker logs --tail 15 "$container" >&2 || true
  die "$label didn't become ready in time." "The log lines above usually say why. 'docker logs $container' has the full log."
}

start_services() {
  step "Starting Postgres and S3 (MinIO) in Docker"
  ensure_container "$PG_CONTAINER" "Postgres" "$PG_PORT" "$PG_IMAGE" \
    -e POSTGRES_USER="$PG_USER" -e POSTGRES_PASSWORD="$PG_PASSWORD" -e POSTGRES_DB="$PG_DB" \
    -p "127.0.0.1:$PG_PORT:5432" \
    -v "$PG_VOLUME:/var/lib/postgresql/data" \
    "$PG_IMAGE"
  ensure_container "$S3_CONTAINER" "S3 (MinIO)" "$S3_PORT $CONSOLE_PORT" "$S3_IMAGE" \
    -e MINIO_ROOT_USER="$S3_USER" -e MINIO_ROOT_PASSWORD="$S3_PASSWORD" \
    -p "127.0.0.1:$S3_PORT:9000" -p "127.0.0.1:$CONSOLE_PORT:9001" \
    -v "$S3_VOLUME:/data" \
    "$S3_IMAGE" server /data --console-address :9001

  wait_for "Postgres" "$PG_CONTAINER" pg_isready -q -h 127.0.0.1 -U "$PG_USER" -d "$PG_DB"
  wait_for "S3 (MinIO)" "$S3_CONTAINER" curl -fsS http://127.0.0.1:9000/minio/health/ready

  local err
  err="$(docker exec -e "MC_HOST_local=http://$S3_USER:$S3_PASSWORD@127.0.0.1:9000" "$S3_CONTAINER" \
    mc mb --ignore-existing "local/$S3_BUCKET" 2>&1)" ||
    die "Couldn't create the S3 bucket '$S3_BUCKET'." "${DIM}mc said: $(head -n 1 <<<"$err")${RESET}"
  ok "bucket '$S3_BUCKET' exists"
}

# ---------- .env ----------

env_get() {
  [[ -f $ENV_FILE ]] || return 0
  K="$1" Q="'" awk '
    BEGIN { k = ENVIRON["K"]; q = ENVIRON["Q"] }
    { line = $0; sub(/\r$/, "", line); sub(/^[ \t]*export[ \t]+/, "", line) }
    index(line, k "=") == 1 { v = substr(line, length(k) + 2); found = 1 }
    END { if (found) { gsub("^[\"" q "]|[\"" q "]$", "", v); print v } }
  ' "$ENV_FILE"
}

env_set() {
  local tmp
  tmp="$(mktemp "$ENV_FILE.XXXXXX")"
  K="$1" V="$2" awk '
    BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"] }
    { line = $0; sub(/^[ \t]*export[ \t]+/, "", line) }
    index(line, k "=") == 1 { if (!done) { print k "=" v; done = 1 } next }
    { print }
    END { if (!done) print k "=" v }
  ' "$ENV_FILE" >"$tmp"
  mv "$tmp" "$ENV_FILE"
}

BACKED_UP=0

# put_env KEY VALUE [keep]  — "keep" leaves a value that is already set alone.
put_env() {
  local key=$1 value=$2 mode=${3:-}
  local current has=0
  if grep -qE "^[[:space:]]*(export[[:space:]]+)?$key=" "$ENV_FILE"; then has=1; fi
  current="$(env_get "$key")"
  if ((has)) && [[ $mode == keep && -n $current ]]; then
    ok "$key kept"
    return
  fi
  if ((has)) && [[ $current == "$value" ]]; then
    ok "$key already set"
    return
  fi
  if ((has)) && [[ -n $current ]] && ((!BACKED_UP)); then
    cp "$ENV_FILE" "$ENV_FILE.backup"
    BACKED_UP=1
    warn "some values are changing; the old file was saved as .env.backup"
  fi
  env_set "$key" "$value"
  if ((has)); then ok "$key updated"; else ok "$key added"; fi
}

DATABASE_URL="postgres://$PG_USER:$PG_PASSWORD@127.0.0.1:$PG_PORT/$PG_DB"
S3_ENDPOINT="http://127.0.0.1:$S3_PORT"

write_env() {
  if [[ -f $ENV_FILE ]]; then
    step "Filling in your existing .env (other lines are left alone)"
  else
    step "Creating .env"
    printf '# Local development settings, written by scripts/dev.sh.\n' >"$ENV_FILE"
  fi

  put_env DATABASE_URL "$DATABASE_URL"
  put_env MCPDET_S3_BUCKET "$S3_BUCKET"
  put_env MCPDET_S3_ENDPOINT "$S3_ENDPOINT"
  put_env AWS_ACCESS_KEY_ID "$S3_USER"
  put_env AWS_SECRET_ACCESS_KEY "$S3_PASSWORD"
  put_env AWS_REGION "$S3_REGION"
  put_env MCPDET_LISTEN "$DEFAULT_LISTEN" keep

  # Variables exported in the shell beat .env when the CLI loads it.
  local key
  for key in DATABASE_URL MCPDET_S3_BUCKET MCPDET_S3_ENDPOINT AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_REGION MCPDET_LISTEN; do
    if [[ -n ${!key:-} && ${!key} != "$(env_get "$key")" ]]; then
      warn "$key is also set in your shell, and that value wins over .env. Run 'unset $key' if the server can't connect."
    fi
  done

  if [[ -z $(env_get ANTHROPIC_API_KEY) && -z ${ANTHROPIC_API_KEY:-} ]]; then
    warn "ANTHROPIC_API_KEY isn't set. Runs still work, but they won't get judge results until you add it to .env."
  fi
}

# ---------- app ----------

build_app() {
  cd "$ROOT"
  step "Installing dependencies and building"
  if [[ ! -f node_modules/.package-lock.json || package-lock.json -nt node_modules/.package-lock.json ]]; then
    npm install --no-audit --no-fund --loglevel=error || die "npm install failed." "Read the npm output above for the reason."
    ok "dependencies installed"
  else
    ok "dependencies are up to date"
  fi
  npm run --silent build || die "The TypeScript build failed." "Fix the errors above and run the script again."
  ok "built into dist/"

  step "Creating the database tables"
  local out
  if ! out="$(DATABASE_URL="$DATABASE_URL" npx --no-install drizzle-kit migrate 2>&1)"; then
    printf '%s\n' "$out" >&2
    die "The database migration failed." "Read the output above. Postgres is at $DATABASE_URL"
  fi
  ok "migrations applied"
}

summary() {
  local listen
  listen="$(env_get MCPDET_LISTEN)"
  cat <<EOF

${GREEN}${BOLD}Local environment is ready.${RESET}

  API             http://${listen:-$DEFAULT_LISTEN}
  Postgres        $DATABASE_URL
  S3 endpoint     $S3_ENDPOINT   bucket: $S3_BUCKET
  MinIO console   http://127.0.0.1:$CONSOLE_PORT   (login: $S3_USER / $S3_PASSWORD)

  Try it:
    curl http://${listen:-$DEFAULT_LISTEN}/runs/<run-id>

  Stop the containers with ./scripts/dev.sh stop

EOF
}

# ---------- commands ----------

cmd_up() {
  check_docker
  check_node
  start_services
  write_env
  build_app
  summary
}

cmd_stop() {
  check_docker
  step "Stopping the local containers (data is kept)"
  local name
  for name in "$PG_CONTAINER" "$S3_CONTAINER"; do
    if [[ $(container_state "$name") == running ]]; then
      docker stop "$name" >/dev/null
      ok "stopped $name"
    else
      ok "$name isn't running"
    fi
  done
}

cmd_reset() {
  check_docker
  printf 'This deletes the local Postgres database and every file in the local S3 bucket. Type "yes" to continue: '
  local answer=""
  read -r answer || true
  [[ $answer == yes ]] || die "Nothing was deleted."
  step "Removing the local containers and their data"
  docker rm -f "$PG_CONTAINER" "$S3_CONTAINER" >/dev/null 2>&1 || true
  docker volume rm "$PG_VOLUME" "$S3_VOLUME" >/dev/null 2>&1 || true
  ok "done. Run ./scripts/dev.sh to start fresh (your .env is left as is)"
}

case "${1:-start}" in
  start)
    cmd_up
    listen="${MCPDET_LISTEN:-$(env_get MCPDET_LISTEN)}"
    listen="${listen:-$DEFAULT_LISTEN}"
    if port_in_use "${listen##*:}"; then
      die "Port ${listen##*:} is already in use, so the API server can't start." \
        "Another copy of the server may already be running. Stop it, or set MCPDET_LISTEN=127.0.0.1:<free port> in .env."
    fi
    step "Starting the API server (Ctrl-C to stop)"
    cd "$ROOT"
    exec node dist/src/app/cli.js serve
    ;;
  setup) cmd_up ;;
  stop) cmd_stop ;;
  reset) cmd_reset ;;
  -h | --help | help) usage ;;
  *)
    usage >&2
    die "Unknown command '$1'."
    ;;
esac
