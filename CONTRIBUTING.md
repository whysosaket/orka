# Contributing to Orka

Orka is an alpha macOS desktop application. Discuss substantial behavior or protocol changes in an issue before implementing them. Small fixes can go directly to a pull request.

## Setup

Run commands from the repository root. Install Node.js 24+ (CI uses `.node-version`), Rust, and Apple's Command Line Tools, then run `npm ci`. No private repository, registry credentials, Docker stack, or database is required for desktop development. See [local development](docs/development.md).

The self-hosted server is a separate workspace in `server/`. Follow its
[development and verification instructions](server/README.md#direct-compose-and-development).
Running the Compose server requires Docker, a shell and OpenSSL; backend source
development additionally needs Node.js and PostgreSQL test binaries.

## Before submitting

Run the checks relevant to your changes:

```sh
npm run check:repository
npm run lint
npm run format:check
npm run typecheck
npm test
npm run build
npx playwright install chrome
npm run test:ui
cargo fmt --manifest-path apps/mac/src-tauri/Cargo.toml --check
cargo test --locked --manifest-path apps/mac/src-tauri/Cargo.toml
cargo clippy --locked --manifest-path apps/mac/src-tauri/Cargo.toml --all-targets -- -D warnings
npm run licenses:check
```

Browser tests use Google Chrome on macOS and Playwright Chromium on Linux. Native tests run on macOS. `npm run test:profiles` checks isolated desktop profiles without a service. `npm run test:native-smoke` additionally requires a compatible installed Codex executable; see [session compatibility](docs/session-compatibility.md). Live service and physical two-Mac checks remain separate [release gates](docs/release-checklist.md).

## Change conventions

- Run `npm run format` and keep ESLint and Prettier checks passing.
- Keep native request lifetimes and account/project workflows in their dedicated hooks. Bind asynchronous results to the selected resource and revision, clear stale content, and provide retries for failed reads.
- Keep changes focused and reuse existing protocol schemas, native contracts, and UI components.
- Read the [design system](docs/design-system/components.md) before changing the interface.
- Preserve app identifiers, Keychain services, account storage, and sync contracts unless an explicit migration accompanies the change.
- Cover behavior changes at the relevant boundary using synthetic fixtures and isolated native homes.
- Keep lockfiles committed. Never commit credentials, database copies, logs, build outputs, or native session history.
- Keep server dependencies and deployment tooling in `server/`, outside the desktop dependency graph. `check:repository` verifies protocol-only desktop vendoring and the imported server source manifest. Maintainers coordinate server changes through the [canonical backend export](server/README.md#source-updates).
- Describe what changed, why, and which checks ran in the pull request.

## Reporting problems

Use a minimal synthetic example and review screenshots and logs before attaching them. For vulnerabilities or accidental credential exposure, follow [SECURITY.md](SECURITY.md).
