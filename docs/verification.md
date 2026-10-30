# Verification and limitations

Run checks against the exact source revision being evaluated. Historical private-repository results do not establish that a new public snapshot passes.

## Desktop checks

The public checks cover repository boundaries and protocol checksums, TypeScript, lint and formatting, client unit tests, the production frontend build, browser UI flows, Rust formatting/tests/Clippy, and a native debug app build. Browser fixtures simulate the service and Tauri bridge; they do not establish live sign-in or sync behavior.

`npm run test:profiles` exercises isolated desktop profiles, callback routing, local settings, and background-agent state. `npm run test:native-smoke` uses an isolated Codex home without running a model turn and requires an installed compatible Codex executable.

The backend implementation and service integration suites remain private. The public desktop checks do not require them and do not claim to validate a deployed API, OAuth provider, email delivery, database migration, or restore.

## Release acceptance

Use the [release checklist](release-checklist.md) for live service and physical two-Mac verification. In particular, native desktop sidebar insertion/removal and active-session protection need checks with the actual supported Codex and Claude Desktop versions.

A source release does not establish a stable binary release. Development downloads are ad-hoc signed. A notarized installer additionally requires Apple acceptance, stapling, signature verification, and Gatekeeper checks; see [manual builds](manual-builds.md).
