#!/usr/bin/env bash
set -euo pipefail
umask 077
bundle=${1:?Usage: deploy-ssh.sh bundle-directory}
: "${DEPLOY_SSH_HOST:?Set production secret DEPLOY_SSH_HOST}"
: "${DEPLOY_SSH_USER:?Set production secret DEPLOY_SSH_USER}"
: "${DEPLOY_SSH_KEY:?Set production secret DEPLOY_SSH_KEY}"
: "${DEPLOY_KNOWN_HOSTS:?Set production secret DEPLOY_KNOWN_HOSTS}"
: "${GH_TOKEN:?Missing package read token}"
: "${GITHUB_ACTOR:?Missing registry username}"
[[ "$DEPLOY_SSH_HOST" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]]
[[ "$DEPLOY_SSH_USER" =~ ^[a-z_][a-z0-9_-]*$ ]]
[[ "$GITHUB_ACTOR" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]*(\[bot\])?$ ]]
image=$(cat "$bundle/image")
commit=$(cat "$bundle/commit")
[[ "$image" =~ ^ghcr.io/[a-z0-9_-]+/orka-api@sha256:[a-f0-9]{64}$ ]]
[[ "$commit" =~ ^[a-f0-9]{40}$ ]]
credentials=$(mktemp -d)
remote_stage=
cleanup() {
  if [[ -n "$remote_stage" ]]; then
    # All remote arguments are locally expanded after allowlist validation.
    # shellcheck disable=SC2029
    ssh "${options[@]}" "$destination" "rm -rf -- '$remote_stage'" || true
  fi
  rm -rf -- "$credentials"
}
trap cleanup EXIT
printf '%s\n' "$DEPLOY_SSH_KEY" > "$credentials/key"
printf '%s\n' "$DEPLOY_KNOWN_HOSTS" > "$credentials/known_hosts"
unset DEPLOY_SSH_KEY DEPLOY_KNOWN_HOSTS
options=(-i "$credentials/key" -o "UserKnownHostsFile=$credentials/known_hosts" -o StrictHostKeyChecking=yes -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4)
destination="$DEPLOY_SSH_USER@$DEPLOY_SSH_HOST"
candidate_stage=$(ssh "${options[@]}" "$destination" 'umask 077; mktemp -d /tmp/orka-deploy.XXXXXXXX')
[[ "$candidate_stage" =~ ^/tmp/orka-deploy\.[a-zA-Z0-9]{8}$ ]]
remote_stage=$candidate_stage
scp "${options[@]}" "$bundle/deploy.tar" scripts/deploy-managed.sh scripts/verify-deployment.ts \
  deploy/ec2/backup.sh deploy/ec2/restore-check.sh deploy/ec2/verify-blobs.py "$destination:$remote_stage/"
# shellcheck disable=SC2029
printf '%s' "$GH_TOKEN" | ssh "${options[@]}" "$destination" \
  "bash '$remote_stage/deploy-managed.sh' /opt/orka-api '$remote_stage' '$image' '$commit' '$GITHUB_ACTOR'"
printf '\nDeployment and public health checks passed.\n' >> "$GITHUB_STEP_SUMMARY"
