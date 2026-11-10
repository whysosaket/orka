#!/bin/bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/orka-recovery-tests.XXXXXXXX")
trap 'rm -rf "$work"' EXIT
xcrun swiftc -warnings-as-errors -D ORKA_RECOVERY_TESTS -target "$(uname -m)-apple-macosx12.0" \
  "$root"/apps/mac/recovery/*.swift "$root/tests/macos/recovery-tests.swift" -o "$work/recovery-tests"
"$work/recovery-tests" "$@"
