#!/usr/bin/env bash
# Builds the Docker images and checks them:
#   - the containers do not run as root;
#   - no .env files from the build context end up in the images;
#   - the web bundle calls the API on the port the server is published on;
#   - ports are published on 127.0.0.1 only (the defaults carry well-known credentials);
#   - every service has memory and CPU limits, and Node's heap limit is below the memory limit;
#   - `docker compose up` brings the stack up in order: postgres -> migrate -> server -> web,
#     the server and web report healthy, and the API answers.
# Runs in its own compose project with its own volumes and host ports, and removes them on exit.
#
# Usage: scripts/docker-smoke.sh   (env: SMOKE_SERVER_PORT, SMOKE_WEB_PORT, SMOKE_POSTGRES_PORT)
set -euo pipefail
cd "$(dirname "$0")/.."

export COMPOSE_PROJECT_NAME=fieldsync-smoke
export SERVER_PORT="${SMOKE_SERVER_PORT:-13001}"
export WEB_PORT="${SMOKE_WEB_PORT:-13000}"
export POSTGRES_PORT="${SMOKE_POSTGRES_PORT:-15432}"
export SEED_DEMO=true

CANARY=FIELDSYNC_SMOKE_CANARY
created=()
failures=0

cleanup() {
  docker compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  for file in "${created[@]+"${created[@]}"}"; do rm -f "$file"; done
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  failures=$((failures + 1))
}

# Put a canary .env file wherever a developer might keep one, unless one is already there.
for file in apps/server/.env apps/web/.env apps/web/.env.local; do
  if [ ! -e "$file" ]; then
    echo "$CANARY=1" > "$file"
    created+=("$file")
  fi
done

echo "== build"
docker compose build

echo "== image checks"
# Force new containers: ones left by an interrupted run would still point at the old images.
docker compose create --force-recreate server web >/dev/null
for service in server web; do
  image=$(docker inspect --format '{{.Image}}' "$(docker compose ps --all --quiet "$service")")
  uid=$(docker run --rm --entrypoint id "$image" -u)
  [ "$uid" != "0" ] || fail "$service image runs as root"
  leaked=$(docker run --rm --entrypoint sh "$image" -c \
    "find / -xdev \( -name '.env' -o -name '.env.*' \) ! -name '.env.example' 2>/dev/null; grep -rls $CANARY /app 2>/dev/null || true")
  [ -z "$leaked" ] || fail "$service image contains files from the build context that must stay out: $leaked"
done
web_image=$(docker inspect --format '{{.Image}}' "$(docker compose ps --all --quiet web)")
docker run --rm --entrypoint sh "$web_image" -c "grep -rqs 'http://localhost:$SERVER_PORT' /app/apps/web/.next/static" ||
  fail "the web bundle does not call the API at http://localhost:$SERVER_PORT (SERVER_PORT)"

echo "== stack"
docker compose up --detach --wait --wait-timeout 180 server web || fail "the stack did not become healthy"

migrate=$(docker compose ps --all --quiet migrate 2>/dev/null || true)
if [ -z "$migrate" ]; then
  fail "no migrate service ran before the server"
else
  code=$(docker inspect --format '{{.State.ExitCode}}' "$migrate")
  [ "$code" = "0" ] || fail "migrate exited with $code"
fi

for service in server web; do
  container=$(docker compose ps --all --quiet "$service")
  health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container")
  [ "$health" = "healthy" ] || fail "$service health is '$health', expected 'healthy'"
done

# Every service runs with a memory and CPU limit, and Node's heap stays below the memory limit.
for service in postgres migrate server web; do
  container=$(docker compose ps --all --quiet "$service")
  limits=$(docker inspect --format '{{.HostConfig.Memory}} {{.HostConfig.NanoCpus}}' "$container")
  set -- $limits
  [ "$1" -gt 0 ] && [ "$2" -gt 0 ] || fail "$service runs without a memory and CPU limit ($limits)"
done
for service in migrate server web; do
  container=$(docker compose ps --all --quiet "$service")
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container" | grep -q '^NODE_OPTIONS=.*--max-old-space-size=' ||
    fail "$service sets no Node heap limit below its memory limit"
done

for published in "postgres 5432" "server 3001" "web 3000"; do
  set -- $published
  address=$(docker compose port "$1" "$2" 2>/dev/null || true)
  case "$address" in
    127.0.0.1:*) ;;
    *) fail "$1 is published on '$address', expected 127.0.0.1 only" ;;
  esac
done

curl --fail --silent "http://localhost:$SERVER_PORT/health" >/dev/null || fail "server /health did not answer"
# Every sync route checks the protocol version the client speaks (FieldSync-Protocol, see README 3.3.7).
curl --fail --silent -H 'authorization: Bearer tech-a-token' -H 'FieldSync-Protocol: 1' \
  "http://localhost:$SERVER_PORT/me" >/dev/null ||
  fail "server /me did not answer for the demo technician"
curl --fail --silent "http://localhost:$WEB_PORT/" >/dev/null || fail "web did not answer"

if [ "$failures" -gt 0 ]; then
  echo "docker smoke check: $failures problem(s)" >&2
  docker compose logs --no-color --tail 50 >&2 || true
  exit 1
fi
echo "docker smoke check passed"
