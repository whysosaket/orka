#!/usr/bin/env bash
# Verify archive failures and size limits always restart both live writers.
set -euo pipefail
workspace=$(mktemp -d)
trap 'rm -rf -- "$workspace"' EXIT
mkdir -p "$workspace/bin" "$workspace/source/blobs"
dd if=/dev/urandom of="$workspace/source/blobs/fixture" bs=1024 count=64 2>/dev/null
tar -cf "$workspace/fixture.tar" -C "$workspace/source" blobs
export TEST_ARCHIVE="$workspace/fixture.tar" TEST_LOG="$workspace/events"
export PATH="$workspace/bin:$PATH"
cat > "$workspace/bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  'compose stop api auth') echo stop >> "$TEST_LOG" ;;
  'compose start auth api') echo start >> "$TEST_LOG" ;;
  'compose exec -T db pg_dump '*) echo fixture-database ;;
  'compose exec -T db pg_dumpall '*) echo fixture-roles ;;
  'compose exec -T db psql '*) echo 1 ;;
  'compose ps -aq api') printf 'a%.0s' {1..64} ;;
  'cp '*':/data/blobs -') cat "$TEST_ARCHIVE"; [[ ${TEST_FAILURE:-} != archive ]] ;;
  *) exit 1 ;;
esac
SH
cat > "$workspace/bin/df" <<'SH'
#!/usr/bin/env bash
if [[ ${TEST_FAILURE:-} = limit ]]; then
  printf 'Filesystem 1024-blocks Used Available Capacity Mounted\nfixture 2000000 0 1048578 0%% /fixture\n'
else
  /bin/df "$@"
fi
SH
chmod +x "$workspace/bin/"*
for scenario in happy archive limit; do
  : > "$TEST_LOG"
  export TEST_FAILURE="$scenario"
  if bash deploy/ec2/backup.sh "$workspace/$scenario" > "$workspace/output" 2>&1; then
    [[ "$scenario" = happy ]]
    (cd "$workspace/$scenario" && sha256sum -c SHA256SUMS >/dev/null)
    gzip -dc "$workspace/$scenario/blobs.tar.gz" | cmp - "$TEST_ARCHIVE"
  else
    [[ "$scenario" != happy && ! -e "$workspace/$scenario/SHA256SUMS" ]]
  fi
  [[ $(cat "$TEST_LOG") = $'stop\nstart' ]]
done
echo 'Compressed backup and failure recovery checks passed.'
