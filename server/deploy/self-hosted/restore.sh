#!/bin/sh
# Recover only into a new installation; never reuse a live project's volumes.
set -eu
umask 077
fail() { printf '%s\n' "$*" >&2; exit 1; }
backup=${1:?Usage: orka-server restore /absolute/backup [--project name] [--port number]}
shift
case "$backup" in /*) ;; *) backup="$(pwd)/$backup" ;; esac
project='' port=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --project) [ "$#" -ge 2 ] || fail '--project needs a name.'; project=$2; shift 2 ;;
    --port) [ "$#" -ge 2 ] || fail '--port needs a number.'; port=$2; shift 2 ;;
    *) fail 'Usage: orka-server restore directory [--project name] [--port number]' ;;
  esac
done
[ ! -e .env ] || fail 'Restore requires a fresh installation directory without .env.'
[ -f "$backup/operator.env" ] || fail 'The backup is missing operator.env.'
command -v bash >/dev/null || fail 'Install Bash for recovery.'
sh deploy/ec2/restore-check.sh "$backup"
saved() { sed -n "s/^$1=//p" "$backup/operator.env" | tail -n 1; }
project=${project:-$(saved COMPOSE_PROJECT_NAME)}
case "$project" in ''|[!a-z0-9]*|*[!a-z0-9_-]*) fail 'Use a lowercase Compose project name.' ;; esac
if [ -n "$port" ]; then
  [ "$(saved ORKA_SERVER_MODE)" = local ] || fail '--port is only available for local backups.'
  case "$port" in *[!0-9]*|0*|??????*) fail 'Port must be from 1 to 65535.' ;; esac
  [ "$port" -le 65535 ] || fail 'Port must be from 1 to 65535.'
fi
[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$project")" ] || fail 'That Compose project already has containers; choose a new --project.'
[ -z "$(docker volume ls -q --filter "label=com.docker.compose.project=$project")" ] || fail 'That Compose project already has volumes; choose a new --project.'
# Legacy bind mounts need their original migration procedure, not fresh volumes.
[ -z "$(saved DATA_ROOT)" ] || fail 'Bind-mounted backups require the documented operator migration.'
files=compose.yml
image=$(saved ORKA_IMAGE)
if [ -n "$image" ]; then files="$files:compose.image.yml"; fi
if [ "$(saved ORKA_SERVER_MODE)" = local ]; then files="$files:deploy/local/compose.yml"; fi
temporary=$(mktemp .env.restore.XXXXXX)
trap 'rm -f "$temporary"' EXIT INT TERM
awk -v project="$project" -v files="$files" -v port="$port" -v uid="$(id -u)" -v gid="$(id -g)" '
  /^COMPOSE_PROJECT_NAME=/ {next}
  /^COMPOSE_FILE=/ {next}
  /^ORKA_OPERATOR_UID=/ {next}
  /^ORKA_OPERATOR_GID=/ {next}
  /^ORKA_LOCAL_PORT=/ && port != "" {next}
  {print}
  END {print "COMPOSE_PROJECT_NAME=" project; print "COMPOSE_FILE=" files; print "ORKA_OPERATOR_UID=" uid; print "ORKA_OPERATOR_GID=" gid; if (port != "") print "ORKA_LOCAL_PORT=" port}
' "$backup/operator.env" > "$temporary"
mv "$temporary" .env
export COMPOSE_PROJECT_NAME="$project" COMPOSE_FILE="$files"
mkdir -p .runtime/accounts
chmod 700 .runtime .runtime/accounts
# A replacement host may have none of the stack's images cached.
if [ "$(saved ORKA_SERVER_MODE)" = local ]; then
  docker compose pull --policy missing db auth
else
  docker compose pull --policy missing db auth caddy
fi
if [ -n "$image" ]; then
  docker image inspect "$image" >/dev/null 2>&1 || docker pull "$image"
else
  sh ./orka-server build
fi
docker compose up --no-build --pull never -d --wait db
docker compose exec -T db pg_restore --clean --if-exists --exit-on-error -U postgres -d orka < "$backup/database.dump"
archive="$backup/blobs.tar.gz"
if [ -f "$archive" ]; then
  bash -o pipefail -c 'gzip -dc "$1" | docker compose run --rm -T --no-deps --entrypoint sh api -c "tar -C /data -xf -"' sh "$archive"
else
  docker compose run --rm -T --no-deps --entrypoint sh api -c 'tar -C /data -xf -' < "$backup/blobs.tar"
fi
sh ./orka-server start
printf 'Recovery completed in Compose project %s. Existing account passwords remain valid.\n' "$project"
