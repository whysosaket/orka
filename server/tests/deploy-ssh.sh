#!/usr/bin/env bash
# Exercise transport failures without connecting to a server or using real secrets.
set -euo pipefail
workspace=$(mktemp -d)
trap 'rm -rf -- "$workspace"' EXIT
mkdir "$workspace/bin" "$workspace/bundle"
export PATH="$workspace/bin:$PATH"
export TEST_LOG="$workspace/events"
export DEPLOY_SSH_HOST=server.example.test DEPLOY_SSH_USER=deployer
export DEPLOY_SSH_KEY=fixture-key DEPLOY_KNOWN_HOSTS=fixture-host-key
export GH_TOKEN=fixture-token GITHUB_ACTOR='release-bot[bot]'
export GITHUB_STEP_SUMMARY="$workspace/summary"
printf 'a%.0s' {1..40} > "$workspace/bundle/commit"
printf 'ghcr.io/whysosaket/orka-api@sha256:%s' "$(printf 'b%.0s' {1..64})" > "$workspace/bundle/image"
touch "$workspace/bundle/deploy.tar"
cat > "$workspace/bin/ssh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ "$*" = *'StrictHostKeyChecking=yes'* && "$*" = *'BatchMode=yes'* && "$*" = *'IdentitiesOnly=yes'* ]]
[[ $(stat -c %a "$2") = 600 ]]
printf '%s\n' "$2" > "$TEST_LOG.key"
command=${!#}
if [[ "$command" = *'mktemp -d'* ]]; then
  echo connect >> "$TEST_LOG"
  [[ ${TEST_FAILURE:-} != host-key ]] || exit 255
  echo /tmp/orka-deploy.ABC12345
elif [[ "$command" = bash* ]]; then
  echo deploy >> "$TEST_LOG"
  [[ $(cat) = fixture-token ]]
  [[ ${TEST_FAILURE:-} != deploy ]] || exit 1
elif [[ "$command" = 'rm -rf '* ]]; then
  echo cleanup >> "$TEST_LOG"
else
  exit 1
fi
SH
cat > "$workspace/bin/scp" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ "$*" = *'StrictHostKeyChecking=yes'* ]]
echo upload >> "$TEST_LOG"
[[ ${TEST_FAILURE:-} != upload ]]
SH
chmod +x "$workspace/bin/"*
deploy() {
  : > "$TEST_LOG"
  : > "$GITHUB_STEP_SUMMARY"
  bash scripts/deploy-ssh.sh "$workspace/bundle" > "$workspace/output" 2>&1
}
deploy
[[ $(cat "$TEST_LOG") = $'connect\nupload\ndeploy\ncleanup' ]]
[[ ! -e $(cat "$TEST_LOG.key") ]]
grep -q 'checks passed' "$GITHUB_STEP_SUMMARY"
for failure in host-key upload deploy; do
  export TEST_FAILURE="$failure"
  if deploy; then echo "Expected failure: $failure" >&2; exit 1; fi
  [[ ! -s "$GITHUB_STEP_SUMMARY" && ! -e $(cat "$TEST_LOG.key") ]]
  if [[ "$failure" = host-key ]]; then
    [[ $(cat "$TEST_LOG") = connect ]]
  else
    [[ $(tail -1 "$TEST_LOG") = cleanup ]]
  fi
  if grep -Eq 'fixture-(key|token|host-key)' "$workspace/output"; then exit 1; fi
done
unset TEST_FAILURE
export DEPLOY_SSH_HOST='server; exit 0'
if deploy; then echo 'Expected hostname validation failure' >&2; exit 1; fi
[[ ! -s "$TEST_LOG" ]]
echo 'Deployment SSH transport checks passed.'
