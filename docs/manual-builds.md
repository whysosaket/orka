# On-demand macOS builds

The public repository owns its desktop checks and builds. Checks and Security checks run on pull requests, pushes to `main`, and manual dispatch. They use no Apple signing credentials. Dependency version-update automation remains paused at `.github/dependabot.yml.disabled`.

## Build from GitHub

1. Open [On-demand macOS build](https://github.com/whysosaket/orka/actions/workflows/release.yml).
2. Click **Run workflow** on `main`.
3. Choose Apple Silicon (`aarch64-apple-darwin`), Intel (`x86_64-apple-darwin`), or universal, then select the signing mode.
4. Download the artifact from the completed run.

The default development mode needs no Apple credentials. It produces an ad-hoc signed app and DMG without notarization. Downloads contain a DMG, `Orka.app.tar.gz` preserving modes and symlinks, `build.json` recording the source and options, and `SHA256SUMS`. Artifacts expire after seven days; no GitHub Release is published automatically.

```sh
gh workflow run release.yml --repo whysosaket/orka --ref main \
  -f target=aarch64-apple-darwin -f signing=development
gh run list --repo whysosaket/orka --workflow release.yml --limit 5
gh run download RUN_ID --repo whysosaket/orka
```

The workflow runs only from `main`, allows one active build, caches dependencies, and has a 60-minute timeout. Development builds use the `macos-development` environment. `ORKA_CLOUD_URL` defaults to `https://api.tryorka.ai` and must be an HTTPS URL without credentials, query, or fragment.

## Notarized builds

Configure the protected `macos-signing` environment, restrict deployment branches to `main`, and add these environment secrets:

- `APPLE_CERTIFICATE`: base64-encoded Developer ID Application `.p12` with its private key.
- `APPLE_CERTIFICATE_PASSWORD`: the certificate export password.
- `APPLE_SIGNING_IDENTITY`: the complete Developer ID Application identity.
- `APPLE_ID`: the signing Apple Account email.
- `APPLE_PASSWORD`: its app-specific password.
- `APPLE_TEAM_ID`: the signing team identifier.

GitHub cannot export existing secret values. Configure credentials directly in the new environment; never commit them or provide them as workflow inputs. Missing credentials fail before dependency installation or compilation. Pull-request checks and development builds do not receive Apple secrets.

Notarized mode verifies the app signature, submits the DMG to Apple, records the submission, requires acceptance, staples and validates the app and DMG, and checks Gatekeeper. If processing outlasts the job, download the receipts and query that submission before requesting another build.

A configured workflow is not evidence of a completed build. Complete the [release checklist](release-checklist.md) before distributing a release candidate.

For recovery-enabled notarized installers, feed setup, and promoting or withdrawing desktop updates, see [Desktop updates and recovery](desktop-updates.md).
