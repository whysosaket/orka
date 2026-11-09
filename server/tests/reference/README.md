# Frozen TypeScript reference

This directory is the previous server implementation, retained as a test oracle
for the Go migration. It is excluded from the production Docker build, release
executable, and operator archive. Its dependencies are development dependencies.
Production code lives in `internal/server` and `cmd/orka-server`.

Integration tests use `tests/bridge` to execute mutations, permission checks,
HTTP requests, MCP, migrations and account authentication in a separate Go test
process. The bridge's control endpoints and callback authentication exist only
under the `orkatest` build tag. The production binary cannot enable them.

Pure TypeScript tests and fixture generators use this frozen reference to detect
contract changes. Update the canonical shared protocol in `packages/protocol`,
regenerate Go contracts, and change the Go implementation when adding features.
Do not add features to this reference or use it as a deployment entry point.
