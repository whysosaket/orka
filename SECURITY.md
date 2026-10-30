# Security policy

Orka is currently alpha software. Security fixes target the current development branch; there is no supported stable release series yet.

## Report a vulnerability privately

Use this repository's **Security → Advisories → Report a vulnerability** form when available. Send only the minimum reproduction needed, using synthetic data. Do not open a public issue containing exploit details, credentials, session transcripts, or environment values.

If private reporting is unavailable, open an issue requesting a private contact channel without including vulnerability details. A maintainer must establish that channel before you send the report. No response-time or security-audit guarantee is implied.

## Accidental credential exposure

Revoke or rotate an exposed credential first. Removing a file or rewriting Git history does not invalidate a credential or remove copies others may already have. Privately coordinate any history, release-asset, or log cleanup with the maintainers.

## Scope and deployment

See the [security model](docs/security-model.md) for data flows and trust boundaries. Self-hosting operators are responsible for their accounts, TLS, backups, host access, and private configuration. Never give a desktop client the authentication service's signing secret or an administrative token.
