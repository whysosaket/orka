#!/usr/bin/env bash
# Run from deploy/ec2 as the EBS volume owner (normally root).
set -euo pipefail
umask 077
output=${1:?Usage: backup.sh /absolute/backup-directory}
case "$output" in /*) ;; *) echo 'Use an absolute backup path' >&2; exit 1;; esac
mkdir "$output"
# Stop both writers before taking a coordinated DB and blob snapshot.
trap 'docker compose start auth api >/dev/null' EXIT INT TERM
docker compose stop api auth >/dev/null
docker compose exec -T db pg_dump -U postgres -d orka -Fc > "$output/database.dump"
docker compose exec -T db pg_dumpall -U postgres --globals-only > "$output/roles.sql"
# Bound the compressed output and reserve restore-database space plus 1 GiB so
# backup and restore can safely share a filesystem. A poor compression ratio
# fails safely instead of exhausting the live data volume.
db_kib=$(docker compose exec -T db psql -XAt -U postgres -d orka -c "select ceil(pg_database_size('orka')/1024.0)::bigint")
[[ "$db_kib" =~ ^[0-9]+$ ]] || { echo 'Could not estimate restore space' >&2; exit 1; }
reserve_kib=$((db_kib + 1048576))
available_kib=$(df -Pk "$output" | awk 'NR==2 {print $4}')
(( available_kib > reserve_kib )) || { echo 'Insufficient archive space' >&2; exit 1; }
api_container=$(docker compose ps -aq api)
[[ "$api_container" =~ ^[a-f0-9]{12,64}$ ]] || { echo 'Expected one stopped API container' >&2; exit 1; }
(
  ulimit -f "$((available_kib - reserve_kib))"
  # Copy the stopped container's volume directly; no archive bytes enter Docker logs.
  docker cp "$api_container:/data/blobs" - | gzip -1 > "$output/blobs.tar.gz"
)
(cd "$output" && { if command -v sha256sum >/dev/null; then sha256sum database.dump roles.sql blobs.tar.gz; else shasum -a 256 database.dump roles.sql blobs.tar.gz; fi; } > SHA256SUMS)
printf 'Backup saved to %s. Run restore-check.sh before relying on it.\n' "$output"
