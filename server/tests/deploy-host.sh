#!/usr/bin/env bash
# Linux lifecycle test: real filesystem/locking, simulated Docker and backup failures.
set -euo pipefail
workspace=$(mktemp -d)
trap 'rm -rf -- "$workspace"' EXIT
mkdir -p "$workspace/bin" "$workspace/fixture/deploy/ec2" "$workspace/fixture/deploy/cloud" "$workspace/stage"
export PATH="$workspace/bin:$PATH"
export TEST_COMMIT
TEST_COMMIT=$(printf 'a%.0s' {1..40})
image="ghcr.io/whysosaket/orka-api@sha256:$(printf 'b%.0s' {1..64})"
cat > "$workspace/bin/mountpoint" <<'SH'
#!/usr/bin/env bash
[[ ${TEST_FAILURE:-} != mount ]]
SH
printf '#!/usr/bin/env bash\nexit 0\n' > "$workspace/bin/python3"
cat > "$workspace/bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$TEST_LOG"
printf '%s\n' "$DOCKER_CONFIG" > "$TEST_LOG.credentials"
case "$*" in
  'login '*) token=$(cat); [[ "$token" = fixture-token ]] ;;
  'image inspect '*)
    if [[ ${TEST_FAILURE:-} = revision ]]; then echo wrong; else echo "$TEST_COMMIT"; fi ;;
  *'--entrypoint sh '*'/run/previous/image /run/previous/deploy'*)
    [[ "$*" = *"--network none --user 0"* && "$*" = *"/releases/"* ]]
    chmod 600 "$TEST_UNREADABLE_IMAGE" ;;
  *'--entrypoint sh '*'/run/backups '*)
    [[ "$*" = *'--network none --user 0'* ]]
    backup_name=${!#}
    [[ "$backup_name" =~ ^[a-f0-9]{40}\.[a-zA-Z0-9]{8}$ ]]
    # Simulate root's directory access without changing any shared blob modes.
    chmod u+rwx "$TEST_BACKUP_ROOT/$backup_name"
    rm -rf --one-file-system -- "$TEST_BACKUP_ROOT/$backup_name" ;;
  'compose config '*) [[ ${TEST_FAILURE:-} != config ]] ;;
  'compose up '*)
    [[ "$ORKA_IMAGE" = ghcr.io/whysosaket/orka-api@sha256:* ]]
    [[ "$COMPOSE_PROJECT_NAME" = orka-managed ]]
    [[ -f "$COMPOSE_ENV_FILES" ]]
    [[ "$COMPOSE_FILE" = *"/deploy/cloud/compose.yml" ]]
    [[ ${TEST_FAILURE:-} != up ]] ;;
  *"pg_database_size('orka')"*) if [[ ${TEST_FAILURE:-} = space ]]; then echo 1000000000000; else echo 100; fi ;;
  'compose exec -T db psql '*) cat >/dev/null; [[ ${TEST_FAILURE:-} != backfill ]] ;;
  *'verify-deployment /run/orka.env') [[ ${TEST_FAILURE:-} != health ]] ;;
  'ps '*) if [[ ${TEST_FAILURE:-} = existing ]]; then echo existing-container; fi ;;
  *'check-empty-database /run/data/postgres') [[ ${TEST_FAILURE:-} != existing-data ]] ;;
esac
SH
cat > "$workspace/fixture/deploy/ec2/backup.sh" <<'SH'
#!/usr/bin/env bash
echo backup >> "$TEST_LOG"
[[ ${TEST_FAILURE:-} != backup ]] || exit 1
mkdir "$1"
SH
cat > "$workspace/fixture/deploy/ec2/restore-check.sh" <<'SH'
#!/usr/bin/env bash
echo restore >> "$TEST_LOG"
[[ ${TEST_FAILURE:-} != restore ]]
SH
chmod +x "$workspace/bin/"*
touch "$workspace/fixture/deploy/ec2/compose.yml" "$workspace/fixture/deploy/cloud/compose.yml"
cp deploy/ec2/backfill-member-emails.sql "$workspace/fixture/deploy/ec2/"
tar -cf "$workspace/stage/deploy.tar" -C "$workspace/fixture" deploy
cp "$workspace/fixture/deploy/ec2/backup.sh" "$workspace/fixture/deploy/ec2/restore-check.sh" "$workspace/stage/"
touch "$workspace/stage/verify-blobs.py"
new_root() {
  root="$workspace/$1"
  mkdir -p "$root/backups"
  touch "$root/.env"
  chmod 600 "$root/.env"
  export TEST_LOG="$root/events"
  export TEST_BACKUP_ROOT="$root/backups"
}
deploy() {
  : > "$TEST_LOG"
  printf fixture-token | bash scripts/managed/deploy-managed.sh "$root" "$workspace/stage" "$image" "$TEST_COMMIT" fixture-user > "$root/output" 2>&1
}
check_credentials_removed() {
  [[ ! -e $(cat "$TEST_LOG.credentials") ]]
  if grep -q fixture-token "$root/output"; then exit 1; fi
}
new_root happy
first_backup="$root/backups/$(printf 'c%.0s' {1..40}).ABC12345"
mkdir "$first_backup"
deploy
[[ -d "$first_backup" ]]
[[ $(readlink "$root/active") = "$(readlink "$root/current")" ]]
if grep -q '^backup$' "$TEST_LOG"; then exit 1; fi
check_credentials_removed
initial=$(readlink "$root/current")
deploy
[[ $(readlink "$root/current") != "$initial" ]]
[[ ! -e "$first_backup" ]]
[[ $(sed -n '/^backup$/,/^compose up/p' "$TEST_LOG" | head -2) = $'backup\nrestore' ]]
[[ $(sed -n '/verify-deployment /,$p' "$TEST_LOG" | grep -c '/run/backups ') -eq 1 ]]
check_credentials_removed
previous=$(readlink "$root/current")
previous_backup="$root/backups/$(basename "$previous")"
[[ -d "$previous_backup" ]]
chmod 000 "$previous_backup"
export TEST_UNREADABLE_IMAGE="$previous/image"
chmod 000 "$TEST_UNREADABLE_IMAGE"
deploy
grep -q -- 'chown -h ' "$TEST_LOG"
[[ -r "$TEST_UNREADABLE_IMAGE" && $(readlink "$root/current") != "$previous" ]]
[[ ! -e "$previous_backup" ]]
[[ -d "$root/backups/$(basename "$(readlink "$root/current")")" ]]
check_credentials_removed
for failure in revision config space backup restore up backfill health; do
  export TEST_FAILURE="$failure"
  successful=$(readlink "$root/current")
  backups_before=("$root/backups/"*)
  if deploy; then echo "Expected failure: $failure" >&2; exit 1; fi
  for previous_backup in "${backups_before[@]}"; do [[ -d "$previous_backup" ]]; done
  if grep -q '/run/backups ' "$TEST_LOG"; then exit 1; fi
  [[ $(readlink "$root/current") = "$successful" ]]
  if [[ "$failure" != up && "$failure" != backfill && "$failure" != health ]]; then
    if grep -q '^compose up ' "$TEST_LOG"; then exit 1; fi
  else
    [[ $(readlink "$root/active") != "$successful" ]]
  fi
  if [[ "$failure" = space ]] && grep -q '^backup$' "$TEST_LOG"; then exit 1; fi
  check_credentials_removed
done
unset TEST_FAILURE
deploy
[[ $(find "$root/backups" -mindepth 1 -maxdepth 1 -type d | wc -l) -eq 1 ]]
[[ -d "$root/backups/$(basename "$(readlink "$root/current")")" ]]
for failure in mount existing existing-data; do
  new_root "$failure"
  export TEST_FAILURE="$failure"
  if deploy; then echo "Expected failure: $failure" >&2; exit 1; fi
  [[ ! -e "$root/active" && ! -e "$root/current" ]]
  if grep -q '^compose up ' "$TEST_LOG"; then exit 1; fi
done
unset TEST_FAILURE
new_root symlinked-backups
mkdir "$workspace/managed-backups" "$workspace/live-blobs"
rmdir "$root/backups"
ln -s "$workspace/managed-backups" "$root/backups"
deploy
deploy
previous_backup="$root/backups/$(basename "$(readlink "$root/current")")"
printf 'live blob\n' > "$workspace/live-blobs/blob"
ln "$workspace/live-blobs/blob" "$previous_backup/blob"
ln -s "$workspace/live-blobs" "$previous_backup/live-link"
printf 'private config\n' > "$root/.env"
mkdir "$root/backups/manual-snapshot"
touch "$root/backups/operator-notes"
backup_link="$root/backups/$(printf 'c%.0s' {1..40}).ABC12345"
ln -s "$workspace/live-blobs" "$backup_link"
deploy
[[ ! -e "$previous_backup" ]]
[[ -d "$root/backups/$(basename "$(readlink "$root/current")")" ]]
[[ $(find -H "$root/backups" -mindepth 1 -maxdepth 1 -type d | wc -l) -eq 2 ]]
[[ -d "$root/backups/manual-snapshot" && -f "$root/backups/operator-notes" && -L "$backup_link" ]]
[[ $(cat "$workspace/live-blobs/blob") = 'live blob' && $(cat "$root/.env") = 'private config' ]]
new_root outside-release
mkdir "$workspace/unrelated"
ln -s "$workspace/unrelated" "$root/active"
if deploy; then echo 'Expected active release boundary check to fail' >&2; exit 1; fi
if grep -q -- 'chown -h ' "$TEST_LOG"; then exit 1; fi
[[ ! -e "$root/current" ]]
new_root permissions
chmod 644 "$root/.env"
if deploy; then echo 'Expected private env check to fail' >&2; exit 1; fi
[[ ! -s "$TEST_LOG" ]]
new_root dashboard
printf '%s\n' 'DASHBOARD_URL=https://dashboard.example.test' > "$root/.env"
deploy
[[ $(readlink "$root/active") = "$(readlink "$root/current")" ]]
check_credentials_removed
: > "$root/.env"
deploy
[[ $(readlink "$root/active") = "$(readlink "$root/current")" ]]
echo 'Managed deployment lifecycle checks passed.'
