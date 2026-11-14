# Architecture

The public desktop has three boundaries:

1. `apps/mac/src` renders the React interface and invokes the Tauri bridge.
2. `apps/mac/src-tauri/src` implements native indexing, local SQLite state, Keychain authentication, imports/exports, and background synchronization. The UI does not start a second sync loop.
3. The checksummed `@portable/protocol` package in `vendor/` supplies shared schemas, validation, merge contracts, and signing fixtures. Its provenance is recorded in `vendor/manifest.json`.

The API is a separate service. The public `server/` tree includes its shared implementation, authorization, migrations, Docker Compose deployment tooling and integration suites. It has a separate npm workspace and is not a desktop build dependency. Both Cloud and self-hosted services use the same desktop binary and wire contracts. `server/source-manifest.json` records the canonical backend commit and file hashes; maintainers import reviewed changes without private Git history. See [server source updates](../server/README.md#source-updates).

## Data flow

The user connects a local project and explicitly chooses categories to share. The daemon indexes those categories, persists an outbox, uploads changes, pulls accepted revisions, and applies permitted changes locally. Retry identities and project cursors make interrupted operations resumable. Repository code is transferred with Git.

The desktop library also reads a separate private local catalog for sessions,
memories, and plans, independent of automatic sharing. Discovery runs through a
native asynchronous command when a collection opens or refreshes, rather than
rescanning histories during every workspace snapshot. Local content is not added
to the published resource table or outbox merely to make it readable. The UI merges
local and authorized shared identities and filters ownership independently of
provider and repository.

The native `local_resources` SQLite table persists the local index independently of
the UI's in-memory catalogs. Collections restore those entries in a read transaction
before running discovery, so a restart does not wait for a filesystem scan or the
background sync lock. Cached reads do not scan files or write provenance. Discovery
still serializes with sync and project changes; a busy workspace returns the saved
catalog and the visible collection retries automatically after five seconds, without
reporting contention as a discovery failure. The UI reuses completed and pending
reads across navigation to avoid extra discovery. Catalog and skill-usage freshness and visible-view refreshes follow
the configured sync interval, including changes to that setting. Explicit refresh
remains immediate, and revalidation preserves loaded rows and counts. This timing
also applies when automatic sharing is off; browsing does not queue publication.

Memories, plans, and text skill files use three-way merges. Binary files and executable flags use whole-value acceptance. Sessions preserve complete native snapshots and use explicit conflict handling; they are never line-merged. Active native sessions are protected from incoming replacement or deletion.

ENV support remains in the native implementation for compatibility, but is currently disabled in the desktop UI. See the [security model](security-model.md).

The desktop derives project attention from current requests, queued operations,
local review state, and conflicts, grouping overlapping states by resource identity.
Binding snapshots retain their own resource and project identities even before a
base revision is installed. Completed decisions and superseded local draft
snapshots remain history; reconciliation preserves their stored content and does
not resolve differing files or pending operations. Existing instruction files
that exactly match an authorized revision can acquire a baseline without a file
write.

## Native modules

`indexer.rs`, `plans.rs`, and session readers discover scoped native content. `sync.rs` handles exchange and local materialization. `codex_import.rs` and `claude_import.rs` preserve native identities. `env/` owns dotenv parsing, encryption, device approval, and guarded file writes. `db.rs` and `auth.rs` isolate local persistence and credentials.

Keep `com.orka.v1`, the existing Tauri bundle identifier, Keychain service names, and protocol versions stable unless a reviewed migration accompanies a change. Desktop account caches and credentials are bound to the selected service. Authentication secrets and administrative server credentials never belong in the React interface or desktop build.
