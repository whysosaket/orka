#!/usr/bin/env bash
# Limit EC2 SSH ingress to the current runner for the duration of a deployment.
set -euo pipefail
: "${DEPLOY_SECURITY_GROUP_ID:?Set production variable DEPLOY_SECURITY_GROUP_ID}"
: "${GITHUB_RUN_ID:?Missing workflow run ID}"
: "${GITHUB_RUN_ATTEMPT:?Missing workflow attempt}"
[[ "$DEPLOY_SECURITY_GROUP_ID" =~ ^sg-[a-f0-9]{8,17}$ ]] || exit 1
[[ "$GITHUB_RUN_ID" =~ ^[0-9]+$ ]] || exit 1
[[ "$GITHUB_RUN_ATTEMPT" =~ ^[0-9]+$ ]] || exit 1
description="orka-api-ci-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
case ${1:-} in
  open)
    ip=$(curl --fail --silent --show-error --max-time 15 https://checkip.amazonaws.com)
    python3 - "$ip" <<'PY'
import ipaddress
import sys
address = ipaddress.IPv4Address(sys.argv[1])
if not address.is_global:
    raise ValueError("Runner must have a public IPv4 address")
PY
    permissions=$(printf '[{"IpProtocol":"tcp","FromPort":22,"ToPort":22,"IpRanges":[{"CidrIp":"%s/32","Description":"%s"}]}]' "$ip" "$description")
    aws ec2 authorize-security-group-ingress --group-id "$DEPLOY_SECURITY_GROUP_ID" \
      --ip-permissions "$permissions" --no-cli-pager >/dev/null
    ;;
  close)
    # Query by our unique run identity even when opening succeeded but its response was lost.
    rules=$(aws ec2 describe-security-group-rules \
      --filters "Name=group-id,Values=$DEPLOY_SECURITY_GROUP_ID" \
      --query "SecurityGroupRules[?Description == \`$description\`].SecurityGroupRuleId" \
      --output text --no-cli-pager)
    if [[ -n "$rules" && "$rules" != None ]]; then
      read -r -a ids <<< "$rules"
      for id in "${ids[@]}"; do [[ "$id" =~ ^sgr-[a-f0-9]{8,17}$ ]] || exit 1; done
      aws ec2 revoke-security-group-ingress --group-id "$DEPLOY_SECURITY_GROUP_ID" \
        --security-group-rule-ids "${ids[@]}" --no-cli-pager >/dev/null
    fi
    ;;
  *) echo 'Usage: deploy-network.sh open|close' >&2; exit 1 ;;
esac
