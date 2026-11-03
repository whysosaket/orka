# Multiple repositories in a project

A project contains named source folders. Source IDs and names are shared through
the API; each Mac stores its own path and filesystem identity for each source.
Git transfers repository code. Orka synchronizes context inside the selected
sources and preserves the existing sharing and resource-approval rules.

Create a project and use **Add folders** to select several directories, or
**Scan parent folder** to list repositories directly inside a directory. Scan
results require selection. Scanning recognizes both `.git` directories and files,
does not follow directory symlinks, and does not recursively include unrelated
repositories. Ordinary folders can be added through the folder picker.

Use **Settings → Source folders** to attach more repositories, locate a shared
source on this Mac, or disconnect one source. Owners register shared sources;
members connect their checkout using Locate folder. Paths can differ between Macs.
Two source folders cannot cover the same or overlapping local directories.

Use **Reconnect folder** beside a connected source to confirm its existing folder
after a replacement or a stale connection warning. This preserves queued changes;
changing the path still requires disconnecting first. On macOS, new connections
use the volume's persistent UUID and directory ID, so disk device renumbering does
not invalidate them. Older connections upgrade during catalog refresh only while
their original device and directory IDs still match. If those IDs already differ,
select the existing folder once to reconnect; Orka does not silently trust it.

Memories, Skills, Sessions, Plans, and ENVs share an **All repositories** dropdown
in the top bar beside sync status. The selection follows those pages within a
project and resets when switching projects, accounts, or services. Search,
coding-tool filters, and sorting remain separate for each collection. Home
continues to show recent updates across the project. Repository names appear in
their own table column, below skill titles, and alongside ENV sets; long names
truncate with the full name available on hover. ENV filters preserve unpublished
drafts and hide revealed values when the selection changes.

Resources carry their source identity through upload, review, conflict,
download, installation, and session resume. Identical relative paths in different
sources stay independent. A disconnected source remains readable in the catalog;
local writes require its connected checkout. An unavailable or replaced folder
pauses writes and deletion discovery for that source while other sources scan.

Global-skill import chooses a destination repository. New encrypted ENV sets
also choose a repository; that source ID is part of the signed manifest and
cannot change in later revisions. Preview and apply resolve that repository's
local folder and require a new preview if the binding changes. Encryption,
recipient approvals, and manual publication remain separate from background sync.

## Migrating existing projects

Version 0.5.0 uses the new source structure. Stop the API, desktop, and background
sync agents before migrating. Back up the server database and blob storage and
verify a restore using the existing operator procedure. The scripts migrate
data; they do not deploy either application or stop a running daemon.

1. Build the matching API and run its normal schema migration, then run
   `npm run migrate:sources` for a data dry run and
   `npm run migrate:sources -- --apply` to convert existing server projects.
2. On **every Mac**, run
   `python3 scripts/migrate-project-sources.py --database /path/to/account.sqlite`
   to inspect a cache, then repeat with `--apply`. Run this separately for each
   account/service cache. The apply command creates a private SQLite backup.
3. Start the matching API and desktop and sync before adding additional sources.
   Review and resubmit any pending suggestions invalidated by migration.

Each migrated project gets a default source whose ID equals the existing project
ID. Native resource IDs remain stable; local paths are retained only on that Mac.
Server resource snapshots, conflicts, and event history gain the default source
ID. Pending exact-preview requests become stale. Local queued resource changes
get fresh retry IDs, pending drafts return to local review, and pull cursors reset.
Both data scripts are idempotent. Signed historical ENV headers are retained
unchanged and resolve to this default source, preserving signature verification.

The runtime does not transparently convert old project caches. Coordinate the
desktop and backend update; older clients are outside the 0.5.0 support contract.
OSS and managed servers use the same schema, migration, and source validation.

## Local backend candidates

The desktop still consumes checksum-pinned backend tarballs. For local development
with uncommitted backend work, run `npm run build` and
`node scripts/package-release.mjs --candidate` in the API, then
`npm run backend:update -- v0.5.0 /path/to/release-artifacts` in the desktop (maintainer access required; only the client protocol is imported).
Candidate manifests record the base commit and a source-tree SHA-256, explicitly
identifying uncommitted source. They are accepted only from an explicit local
release directory. Release packaging without `--candidate` still requires a clean,
committed source tree. A local candidate is not a published server release.
