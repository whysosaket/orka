#!/usr/bin/env bash
# Runs on the Linux Docker host; registry token arrives only on stdin.
set -euo pipefail
umask 077
root=${1:?Missing deployment root}
stage=${2:?Missing upload directory}
image=${3:?Missing immutable image}
commit=${4:?Missing source commit}
registry_user=${5:?Missing registry username}
fail() { printf '%s\n' "$*" >&2; exit 1; }
[[ "$root" = /* && "$stage" = /* ]]
[[ "$image" =~ ^ghcr.io/[a-z0-9_-]+/orka-api@sha256:[a-f0-9]{64}$ ]]
[[ "$commit" =~ ^[a-f0-9]{40}$ ]]
[[ -d "$root" && -f "$root/.env" && -d "$root/backups" ]] || fail 'Prepare the deployment directory, private .env and backup directory first.'
[[ $(stat -c %a "$root/.env") = 600 ]] || fail 'Set server .env permissions to 600.'
# The bootstrap service dependency and this check prevent writing to an unmounted EBS path.
mountpoint -q /srv/orka || fail '/srv/orka must be a mounted data volume.'
exec 9> "$root/deploy.lock"
flock -w 60 9 || fail 'Another deployment holds the host lock.'
mkdir -p "$root/releases"
release=$(mktemp -d "$root/releases/$commit.XXXXXXXX")
tar -xf "$stage/deploy.tar" -C "$release"
mkdir "$release/operations"
cp "$stage/backup.sh" "$stage/restore-check.sh" "$stage/verify-blobs.py" "$release/operations/"
printf '%s\n' "$image" > "$release/image"
printf '%s\n' "$commit" > "$release/commit"
export DOCKER_CONFIG
DOCKER_CONFIG=$(mktemp -d)
backup=
cleanup() {
  status=$?
  rm -rf -- "$DOCKER_CONFIG"
  if [[ "$status" != 0 ]]; then
    printf 'Deployment failed. Attempt: %s; backup: %s. Inspect active/current before recovery; no database rollback was attempted.\n' "$release" "${backup:-not taken}" >&2
  fi
}
trap cleanup EXIT
docker login ghcr.io --username "$registry_user" --password-stdin >/dev/null
docker pull "$image" >/dev/null
[[ $(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image") = "$commit" ]] || fail 'Image revision does not match the release commit.'
docker run --rm --network none --user 0 --entrypoint orka-server \
  -v "$root/.env:/run/orka.env:ro" "$image" check-deployment /run/orka.env --cloud
docker run --rm --network none --user 0 --entrypoint orka-server \
  -v "$root/.env:/run/orka.env:ro" "$image" check-data-root /run/orka.env
export COMPOSE_PROJECT_NAME=orka-managed
export COMPOSE_ENV_FILES="$root/.env"
export COMPOSE_FILE ORKA_IMAGE
use_release() {
  COMPOSE_FILE="$1/deploy/ec2/compose.yml:$1/deploy/cloud/compose.yml"
  ORKA_IMAGE=$(cat "$1/image")
}
use_release "$release"
docker compose config --quiet
docker compose pull --quiet
if [[ -e "$root/active" ]]; then
  previous=$(readlink -f "$root/active")
  [[ "$previous" = "$root/releases/"* ]] || fail 'Active release must be inside the deployment releases directory.'
  if [[ ! -r "$previous/image" ]]; then
    # A manual root-owned release must return to the existing Docker operator.
    # Preserve file modes and symlinks; never change .env or persistent-data ownership.
    docker run --rm --network none --user 0 --entrypoint sh \
      -v "$previous:/run/previous" "$image" -c \
      'chown -h "$1" /run/previous && chown -R -h "$1" /run/previous/image /run/previous/deploy' \
      -- "$(id -u):$(id -g)"
  fi
  use_release "$previous"
  # Compressed archives are capped at available space; blob checks stream.
  command -v python3 >/dev/null || fail 'Install Python 3 for streaming blob verification.'
  db_kib=$(docker compose exec -T db psql -XAt -U postgres -d orka -c "select ceil(pg_database_size('orka')/1024.0)::bigint")
  [[ "$db_kib" =~ ^[0-9]+$ ]] || fail 'Could not estimate backup space.'
  needed_kib=$((db_kib + 1048576))
  backup_free=$(df -Pk "$root/backups" | awk 'NR==2 {print $4}')
  restore_free=$(df -Pk "${TMPDIR:-/tmp}" | awk 'NR==2 {print $4}')
  if [[ $(stat -Lc %d "$root/backups") = "$(stat -Lc %d "${TMPDIR:-/tmp}")" ]]; then
    needed_kib=$((needed_kib * 2))
  fi
  printf 'Backup/restore space: need %s KiB; backup free %s KiB; restore free %s KiB.\n' "$needed_kib" "$backup_free" "$restore_free"
  [[ "$backup_free" -ge "$needed_kib" && "$restore_free" -ge "$needed_kib" ]] || fail 'Insufficient backup/restore space; live writers were not stopped.'
  backup="$root/backups/$(basename "$release")"
  bash "$release/operations/backup.sh" "$backup"
  bash "$release/operations/restore-check.sh" "$backup"
else
  # Initial provisioning is explicit; never adopt an unrelated running stack.
  [[ -z $(docker ps -aq --filter label=com.docker.compose.project=orka-managed) ]] || fail 'Existing orka-managed containers require explicit migration before CI adoption.'
  # Read as root inside Docker: the SSH user cannot inspect PostgreSQL's private directory.
  docker run --rm --network none --user 0 --entrypoint orka-server \
    -v /srv/orka:/run/data:ro "$image" check-empty-database /run/data/postgres
fi
use_release "$release"
# active records the actual attempted configuration, even if health later fails.
ln -s "$release" "$release/active.next"
mv -Tf "$release/active.next" "$root/active"
docker compose up -d --wait --wait-timeout 180
# Populate existing members from GoTrue without granting the API auth-schema access.
# Older release bundles do not contain this additive migration's operator backfill.
if [[ -f "$release/deploy/ec2/backfill-member-emails.sql" ]]; then
  docker compose exec -T db psql -X -U postgres -d orka -v ON_ERROR_STOP=1 \
    < "$release/deploy/ec2/backfill-member-emails.sql"
fi
docker run --rm --user 0 --entrypoint orka-server \
  -v "$root/.env:/run/orka.env:ro" "$image" verify-deployment /run/orka.env
ln -s "$release" "$release/current.next"
mv -Tf "$release/current.next" "$root/current"
docker compose ps
if [[ -n "$backup" ]]; then
  # Prune only generated deployment backups after restore and health checks pass.
  for old_backup in "$root/backups/"*; do
    [[ "$old_backup" != "$backup" && -d "$old_backup" && ! -L "$old_backup" ]] || continue
    backup_name=$(basename "$old_backup")
    [[ "$backup_name" =~ ^[a-f0-9]{40}\.[a-zA-Z0-9]{8}$ ]] || continue
    # Older root-run deployments leave private backups unreadable to this user.
    docker run --rm --network none --user 0 --entrypoint sh \
      -v "$root/backups:/run/backups" "$image" \
      -c 'rm -rf --one-file-system -- "/run/backups/$1"' -- "$backup_name"
  done
  printf 'Retained verified backup: %s\n' "$backup"
fi
printf 'Deployment verified: %s\n' "$commit"
