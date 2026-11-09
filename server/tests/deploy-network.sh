#!/usr/bin/env bash
set -euo pipefail
workspace=$(mktemp -d)
trap 'rm -rf -- "$workspace"' EXIT
mkdir "$workspace/bin"
export PATH="$workspace/bin:$PATH" TEST_LOG="$workspace/events"
export DEPLOY_SECURITY_GROUP_ID=sg-0123456789abcdef0 GITHUB_RUN_ID=123 GITHUB_RUN_ATTEMPT=2
cat > "$workspace/bin/curl" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "${TEST_IP:-8.8.8.8}"
SH
cat > "$workspace/bin/aws" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$TEST_LOG"
case "$2" in
  authorize-security-group-ingress)
    [[ "$*" = *'"CidrIp":"8.8.8.8/32"'* && "$*" = *'"FromPort":22,"ToPort":22'* ]]
    [[ "$*" = *'"Description":"orka-api-ci-123-2"'* ]]
    [[ ${TEST_FAILURE:-} != authorize ]]
    ;;
  describe-security-group-rules)
    [[ "$*" = *'Name=group-id,Values=sg-0123456789abcdef0'* ]]
    [[ "$*" = *'Description == `orka-api-ci-123-2`'* ]]
    printf '%s\n' "${TEST_RULES-sgr-0123456789abcdef0}"
    ;;
  revoke-security-group-ingress)
    [[ "$*" = *'--security-group-rule-ids sgr-0123456789abcdef0'* ]]
    [[ ${TEST_FAILURE:-} != revoke ]]
    ;;
  *) exit 1 ;;
esac
SH
chmod +x "$workspace/bin/"*
bash scripts/deploy-network.sh open
bash scripts/deploy-network.sh close
[[ $(wc -l < "$TEST_LOG") = 3 ]]
: > "$TEST_LOG"
TEST_RULES='' bash scripts/deploy-network.sh close
[[ $(wc -l < "$TEST_LOG") = 1 ]]
for invalid in '127.0.0.1' '10.0.0.1' '8.8.8.8/0' '8.8.8.8;id'; do
  : > "$TEST_LOG"
  if TEST_IP="$invalid" bash scripts/deploy-network.sh open >/dev/null 2>&1; then exit 1; fi
  [[ ! -s "$TEST_LOG" ]]
done
if TEST_FAILURE=authorize bash scripts/deploy-network.sh open; then exit 1; fi
# Cleanup must still find the rule after an ambiguous/opening failure.
bash scripts/deploy-network.sh close
if TEST_FAILURE=revoke bash scripts/deploy-network.sh close; then exit 1; fi
if GITHUB_RUN_ID='123`bad' bash scripts/deploy-network.sh close; then exit 1; fi
echo 'Deployment network access checks passed.'
