# Dependency security

Checks and Security checks run on pull requests and pushes to `main`. The Security workflow audits production JavaScript dependencies, runs RustSec, and scans Git history for secrets. Version-update automation remains paused at `.github/dependabot.yml.disabled`. Actions use immutable commit pins and Gitleaks is checksum verified. See [manual builds](manual-builds.md) for the build policy.

## JavaScript snapshot review: 30 October 2026

The public snapshot updates `zod` to 4.6.7 and `postcss-selector-parser` to 6.1.5 within the existing dependency ranges. The full `npm audit` reports zero known vulnerabilities at snapshot preparation. Re-run the audit when evaluating later releases; this result is specific to the lockfile and advisory database at that time.

Tailwind remains on 3.4 to preserve the macOS 12 WebView baseline. The desktop ships compiled CSS rather than the Tailwind compiler. Treat external source and build configuration as untrusted, and keep pull-request jobs bounded and free of signing credentials.

## Rust dependencies

The snapshot updates Tokio to 1.53.3 and requires zip 9.0.5 or later in the 9.x series for [GHSA-m665-v7pm-7grj](https://github.com/advisories/GHSA-m665-v7pm-7grj). Run `cargo audit --file apps/mac/src-tauri/Cargo.lock` against the current advisory database. GitHub dependency alerts supplement RustSec because their advisory databases can differ. Maintenance and platform-specific warnings remain visible in the Security workflow. Orka currently supports macOS; Linux desktop support needs its own dependency and compatibility review.

### Scoped exception: RUSTSEC-2026-0387

The unfiltered audit reports [RUSTSEC-2026-0387](https://rustsec.org/advisories/RUSTSEC-2026-0387.html) through `age 0.12.1 → p256/hpke → elliptic-curve → crypto-bigint 0.5.5`. The advisory lists a fix in crypto-bigint 0.7.6, outside this dependency chain's compatible version range. The unfiltered Rust audit is not clean.

The Security workflow ignores only this advisory. In the reviewed desktop, `env/crypto.rs` generates and parses `age::x25519::Identity` and `age::x25519::Recipient` explicitly. It does not construct age's P256-based `tag` or `tagpq` recipients, which bring in the affected dependency. ENV functionality is also currently disabled by the shared desktop feature flag. This is a reviewed call-path exception, not a claim that crypto-bigint has been patched.

Reassess the exception when updating age, changing recipient parsing or cryptography, enabling additional key types, or re-enabling ENV support. Remove it when a compatible upstream fix is available. Other vulnerability findings still fail CI; maintenance and platform-specific warnings remain visible. Native encryption, signatures, recipient isolation, tampering, and protocol-fixture tests remain required.
