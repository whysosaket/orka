# Public source releases

The public `orka` repository begins with a reviewed desktop source snapshot and fresh Git history. The original repository remains private under `orka-private`; it retains its history, branches, pull requests, workflow logs, and historical artifacts.

Public source includes the desktop, its client protocol package, tests, documentation, integration plugin, and a reviewed server snapshot in `server/`. The server includes shared implementation packages, migrations, deployment tooling and service integration suites. Private environment files, runtime data and historical Git metadata remain excluded. Preserve [contributor attribution](../AUTHORS.md), [MIT licensing](../LICENSE), and [third-party notices](../THIRD_PARTY_NOTICES.md).

The canonical backend exporter copies an explicit source allowlist and records the source commit, candidate status and per-file SHA-256 in `server/source-manifest.json`. It never copies Git history, provider credentials or runtime data. Before publishing, review this manifest and validate the source-built Compose stack. An uncommitted candidate is not a tagged backend release; source publication and registry/image publication are separate actions. See the [server source-update guide](../server/README.md#source-updates).

## Prepare a source archive

1. Commit the candidate and run the contributor checks, `npm run check:repository`, and `npm run licenses:check`.
2. Review dependency audits and [known advisories](dependency-security.md).
3. Scan the source, archives, and all Git refs intended for publication with Gitleaks; review private metadata separately.
4. With Gitleaks on `PATH` and a clean committed checkout, run `npm run package:source` to create an archive and SHA-256 checksum under ignored `artifacts/release/`.

The source exporter includes committed files only. Do not merge or push branches from the historical private repository into this repository; that would reintroduce the old history. Transfer reviewed changes as patches or new commits.

## Repository configuration

Keep private vulnerability reporting, secret scanning, push protection, and default-branch protection enabled. Review the settings actually applied by GitHub; workflow files alone do not configure repository settings.

An alpha source release does not establish a stable binary release. Build a fresh candidate with the [macOS workflow](manual-builds.md) and complete the [binary release checklist](release-checklist.md). Historical private installers are not copied automatically.
