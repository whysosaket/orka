# Verification and limitations

Run checks against the exact source revision being evaluated. Historical private-repository results do not establish that a new public snapshot passes.

## Desktop checks

The public checks cover repository boundaries and protocol checksums, TypeScript, lint and formatting, client unit tests, the production frontend build, browser UI flows, Rust formatting/tests/Clippy, and a native debug app build. Browser fixtures simulate the service and Tauri bridge; they do not establish live sign-in or sync behavior.

`npm run test:profiles` exercises isolated desktop profiles, callback routing, local settings, and background-agent state. `npm run test:native-smoke` uses an isolated Codex home without running a model turn and requires an installed compatible Codex executable.

The public `server/` workspace has separate build, type, lint, unit, PostgreSQL integration and final-image checks. Its CI builds the OSS image from source and exercises the public Compose configuration with real GoTrue, captured mail, membership isolation, blobs and backup/restore. Desktop checks remain independent. These checks do not establish public DNS/TLS, real provider delivery, external OAuth consent or signed-app handoff; record those separately for an actual deployment.

## Release acceptance

Use the [release checklist](release-checklist.md) for live service and physical two-Mac verification. In particular, native desktop sidebar insertion/removal and active-session protection need checks with the actual supported Codex and Claude Desktop versions.

A source release does not establish a stable binary release. Development downloads are ad-hoc signed. A notarized installer additionally requires Apple acceptance, stapling, signature verification, and Gatekeeper checks; see [manual builds](manual-builds.md).
