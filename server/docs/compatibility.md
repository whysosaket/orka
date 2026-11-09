# Release compatibility

## GitHub repository connections

Release 0.6.0 adds optional repository bindings, native clone support and
user-scoped GitHub access requests. It builds on the initial schema baseline,
adding migration `002_github_repositories.sql`. Older services retain local-folder
setup. Both editions share the implementation; see [configuration and the
single-app migration guide](github-repositories.md). Publishing this release does
not provision an operator's GitHub App, credentials or webhook configuration.

## Initial schema baseline

The server starts from `001_initial.sql`, containing the complete baseline
Orka schema, then applies the incremental migrations shipped after it. A fresh
database records each completed migration in `orka.schema_migrations`; repeated
startup does not replay historical upgrades.
GoTrue maintains its own authentication schema and migration ledger separately.

A database that completed the previous eleven Orka migrations can preserve its
data while replacing only that ledger. Take and verify a coordinated backup,
then run the new image's migration command in the existing Compose deployment:

```sh
docker compose stop api auth
docker compose run --rm --no-deps --entrypoint node api packages/server-core/dist/migrate.js --reset-ledger
```

The source-built helper combines backup, verification, ledger adoption and restart
as `sh ./orka-server upgrade --reset-ledger`. Adoption is explicit, transactional,
and accepts only the complete known historical ledger. Partial, missing or unknown
histories are rejected without deleting data or ledger entries. Finish an older
upgrade with its matching server version first, or use a fresh database.
This operation never resets GoTrue accounts, projects, resources or blobs.
Keep historical API instances stopped during adoption. Afterwards, use
baseline-based server images only; rollback to an older lineage requires restoring
the verified pre-adoption backup, not just switching the image.

Release notes below describe the historical migration names; those SQL upgrade
files are no longer shipped. Baseline-era backups restore through the normal
recovery procedure. Historical backups need the matching older server or the
explicit ledger-adoption step before a baseline-based server can start.

## Selected sharing

`selectedSharing: 1` in `/v2/projects/capabilities` advertises authenticated `POST /v2/sharing/selected`. The endpoint accepts the existing v2 change schema and returns `published` with its normal mutation receipt, `conflict` with its normal conflict receipt, or `approval_required` with an immutable review request. Exact retries retain their identity. Deletions and secret-file payloads are rejected. Existing membership, source audience, publication, suggestion, and ownership checks apply.

Automatic category sharing is a local desktop preference. The updated native plugin bridge can submit one explicitly selected frozen snapshot without changing that preference. Remote MCP tokens remain `orka.read` and cannot call this ordinary API endpoint. OSS and managed editions share this implementation. No protocol or database migration, OAuth scope expansion, provider setting, or environment variable is required. Update the service before enabling local publication; older remote read-only plugins remain compatible.

Backend 0.5.3 adds nullable `email` to the existing governance
catalog member rows in both editions. Migration 011 adds one column to the
existing identity table; the normal authenticated GoTrue `/user` lookup refreshes
it from the account email, never user-editable metadata or profile input. Project
membership still gates the entire catalog. Managed deployment backfills existing
project members from GoTrue using the operator-only SQL in `deploy/ec2/` after
migration 011; authenticated requests continue refreshing those identities.
Self-hosted operators can run the same backfill or allow identities to populate
on their next authenticated request. Missing account emails remain null. No per-member network
calls, new endpoint, client state, or protocol package update is needed. Older
desktops ignore the extra field. Deployment status is recorded in the release workflow.

The release advertises `profile.conditionalSave: 1` and returns
an opaque `revision` with profile reads/writes. A Settings profile save supplies
`expectedRevision`; the shared core compares it under the profile row lock and
returns 409 without writing when it is stale. All values remain parameterized.
Existing onboarding and older clients can still write without that optional field.
The new desktop requires this capability for Settings profile edits, displaying
older services as read-only until updated. No database migration or protocol
package change is required.

The release adds role-policy contracts, Admin membership,
idempotent policy operations, and optional device hardware metadata through the
shared core and migration 010. Existing projects keep their rules until the Owner
confirms migration; both server editions use the same authorization and migration.
Retained restriction catalogs expose all records to the Owner and only a person's
own records to other roles. The desktop consumes canonical policy definitions
from a checksummed protocol candidate; its manifest records working-tree
provenance separately from a published release. Older services keep their current
rules and make the new Permissions controls read-only. Earlier desktops cannot
configure role policies and require an update to manage the new Settings model;
server authorization continues to enforce access. Production rollout and final-image
upgrade/restore acceptance remain separate release work.

The onboarding candidate retains projects created before migration 008 through
explicit desktop selection. Owners can fill an unset remote key after connecting;
members retain source-mapping access without permission to set that hint. Renamed
local checkouts keep the existing source ID, and multi-repository projects require
an explicit repository choice when the folder cannot be matched. These corrections
require no additional migration or protocol package update.

An unmatched remote can be connected explicitly to any authorized project,
including a project already keyed to another repository. Desktop remote identity
preserves non-default ports and private-host path case. Dismissed offline setup
retains its reviewed connection receipts for recovery through ordinary sync
without restarting the app. Native acceptance covers these cases against this
API; server migrations and wire schemas are unchanged.

Both SMTP and Resend onboarding mail use sign-in links without code-entry
instructions. Final-image acceptance signs in both fixture accounts through
scanner-safe confirmation and PKCE, while retaining replay, interception, refresh,
membership, blob and backup/restore checks.

Backend 0.5.1 adds owner-only shared project renaming through the existing
`/v2/projects/action` route and advertises `rename: 1` in project capabilities.
Renames use lifecycle revisions and durable receipts, preserving archive/delete
concurrency checks. Both editions use the same core; no schema migration or
protocol format change is needed. The updated desktop keeps optional personal
names in its account/service-specific local cache. Shared names still refresh
from the catalog, while personal names remain on that Mac until reset. Earlier
compatible servers support personal names; shared renaming reports an explicit
upgrade requirement. Production acceptance is recorded in the deployment receipt.

The 0.5.0 source-folder model adds shared source descriptors and repository-scoped
resource identity, signed ENV source identity, and native folder mapping. Existing
projects require the explicit server and per-Mac cache migrations documented in
[project sources](project-sources.md). Coordinate desktop and API upgrades; older
clients are outside this model's support contract. Both editions share schema 006,
the source API, and scoped authorization. Local candidate packages are distinct
from a published or deployed release.

New governed projects default to member editing and publication of instructions,
memories, skills, plans and sessions. The existing ENV read/suggest rule, owner-only
sharing management and creator-only session mutation are preserved. Both editions
use the canonical protocol defaults through the shared store. No wire change,
database migration or desktop update is required; the behavior takes effect when
the updated backend is released and deployed. Existing saved policies are retained.

Backend 0.4.3 adds an optional `url` to `/v2/invites` when `PUBLIC_URL`
is configured. The existing `token` and authenticated `/v2/join` contract are
unchanged. Both editions serve the scanner-safe `/join/<token>` preview from
the shared core; upgraded desktops preserve the invite and service through
sign-in and validate the selected service natively. Older servers retain
desktop-only links. No migration or shared protocol schema change is required.
The complete handoff requires the updated desktop. Existing desktop 0.4.2
candidate packages remain compatible; no client package update is required
to consume the optional invite URL from a deployed 0.4.3 server.

The 0.4.2 candidate adds paginated, permission-filtered management logs and owner-only
sharing management. Migration 005 imports existing request outcomes as historical
records and clears sharing delegation while preserving file access modes. Earlier
clients may still read these modes, but attempts to delegate sharing are rejected.
The current desktop removes file ACL editing and uses category access with one
additions checkbox. Both OSS and managed entry points consume the same migration
and core. No deployment settings or ENV encryption formats change.

The 0.4.1 candidate adds account display names to the existing member catalog and
category access requests. Collection requests require 0.4.1 on the server; prior
file requests remain supported. Owners review category requests using the same
revision and exact-preview checks. Existing file exceptions, creation permissions,
and sharing delegation remain unchanged. No database migration is needed.

The 0.4.0 candidate adds resource policy, immutable review requests, memory
provenance and permission-aware sync. Migration 004 is additive. Existing projects
remain legacy until an owner activates governance; new upgraded clients create
governed projects. Governed operations require `X-Orka-Governance: 1` and pull's
`governance=1` declaration, with server authorization on every operation. Earlier
clients receive an upgrade requirement. Capability declarations are compatibility
checks, never proof of permission. Both images use the same core and protocol.
See [governed sharing](governed-sharing.md) for activation and rollback boundaries.

Candidate verification covers 28 backend unit tests and six HTTP/PostgreSQL
integration tests. Native/client verification uses locally pinned packages from
the source commit; published images and signed applications remain coordinated
release acceptance work.

The 0.3.0 candidate adds JEV memory consolidation and optional `event.memoryResolutions` metadata while preserving v2 request/resource formats. No migration is required. Earlier clients ignore additive event fields and already retry HTTP 503 without dropping their queued edit. Operators must configure `JEV_API_KEY` for replacements or explicitly defer them with `MEMORY_JEV_ENABLED=false`. Both editions share the implementation; see [memory consolidation](memory-consolidation.md).

Backend 0.2.0 extracts the previous Orka server without changing `/v2` resource, sync, encrypted ENV or native command formats. Both images use the same protocol 0.2.0, migration files and GoTrue v2.196.0.

| Consumer                                  | Backend                        | Validation                                                                                                    |
| ----------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Current `orka` onboarding branch          | OSS and managed 0.2.0          | Native stack test for email/code/PKCE, cache isolation, password, sync/conflicts, retries, daemon and restore |
| Current `orka`                            | Packaged core/protocol 0.2.0   | PostgreSQL integration and three-native-client encrypted ENV/UI tests                                         |
| Earlier password/default-callback clients | 0.2.0                          | Original route contracts retained; direct verify remains available, password is on by default                 |
| Current `orka`                            | Previous password-only service | Capability fallback and existing native auth tests                                                            |

Compatibility rows about retained contracts are not a claim of testing every historical signed app. Actual signed-app browser handoff, external GitHub consent, delivery to a real mailbox and physical two-Mac native sidebar checks remain staging/release acceptance gates.

The desktop consumes immutable npm tarballs stored under `vendor/`, with the source commit, SHA-256 and npm integrity in `manifest.json` and the lockfile. This works for private repos without shipping registry credentials. Source ownership stays here; the tarballs are generated release artifacts, not another editable server. To update, run `npm run backend:update -- vX.Y.Z` in `orka` with GitHub repository read access, then its compatibility checks. Local pre-release validation accepts an explicit release-directory argument. Never use an unversioned sibling-path dependency.

Rust verifies the canonical signing fixture from the installed protocol package. Both repositories retain contract tests to verify their respective package/source boundary. Client tests import backend test helpers and core rather than maintaining backend source. Production uses released images; local development can explicitly build a sibling checkout with `ORKA_API_SOURCE=../orka-api npm run local:up`.

Before upgrades, take and verify a coordinated database/blob backup. Baseline-era startup is idempotent; adopt a completed historical ledger explicitly as described above. Rollback after a destructive migration needs a tested restore; changing an image tag alone is not a database rollback plan.
