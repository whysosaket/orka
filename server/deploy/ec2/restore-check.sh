#!/bin/sh
# Restore into an isolated disposable database and verify every referenced blob.
set -eu
umask 077
input=${1:?Usage: restore-check.sh /absolute/backup-directory}
command -v python3 >/dev/null || { echo 'Install Python 3 for streaming blob verification.' >&2; exit 1; }
case "$input" in /*) ;; *) echo 'Use an absolute backup path' >&2; exit 1;; esac
(cd "$input" && { if command -v sha256sum >/dev/null; then sha256sum -c SHA256SUMS; else shasum -a 256 -c SHA256SUMS; fi; })
name="orka-restore-$$"
stage=$(mktemp -d)
trap 'docker rm -fv "$name" >/dev/null 2>&1 || true; rm -rf "$stage"' EXIT INT TERM
docker run -d --name "$name" -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17.9-bookworm >/dev/null
attempt=0
until docker exec "$name" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; do
  attempt=$((attempt+1)); [ "$attempt" -lt 60 ] || exit 1; sleep 1
done
docker exec "$name" createdb -U postgres restored
docker exec "$name" psql -U postgres -d restored -v ON_ERROR_STOP=1 -c 'create role supabase_auth_admin; create role orka_api;'
docker exec -i "$name" pg_restore -U postgres -d restored --no-owner --exit-on-error < "$input/database.dump"
docker exec "$name" psql -U postgres -d restored -At -F ' ' -c 'select project_id,hash,size from orka.blobs' > "$stage/manifest"
archive="$input/blobs.tar.gz"
[ -f "$archive" ] || archive="$input/blobs.tar"
python3 "$(dirname "$0")/verify-blobs.py" "$archive" "$stage/manifest"
docker exec "$name" psql -U postgres -d restored -v ON_ERROR_STOP=1 -c 'select count(*) as projects from orka.projects; select count(*) as auth_users from auth.users; select count(*) as revisions from orka.snapshots;'
printf 'Isolated database restore and blob verification passed.\n'
