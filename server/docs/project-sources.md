# Project source folders

The shared server core implements source folders for both OSS and managed APIs.
`GET /v2/projects` includes `sources: [{id,name}]` and `sourceModel`. Absolute paths
and filesystem identities belong to each desktop cache and are never accepted
by the source-registration schema.

Owners register up to 100 sources with
`POST /v2/projects/sources {projectId,sources:[{id,name}]}`. Registration is atomic
and retryable with the same IDs; reusing an ID with different metadata fails.
Membership and governed-client checks apply. Members may locate an existing
source locally; registering a new shared source requires ownership.

When `/v2/projects/capabilities` advertises `sourcesRemoval: 1`, owners can use
`POST /v2/projects/sources/remove {projectId,sourceId}`. Removal is idempotent and
returns `{sourceId,removedAt}`. Migration `005_source_removal.sql` adds the nullable
timestamp. The source remains in the catalog with its name and `removedAt` so
existing resources, snapshots, ENV signatures and history retain their identity.
Clients hide removed sources from connection and publication destinations and
clear their local binding when the catalog refreshes. Removal does not delete
local folders, downloaded code or shared content.

Removed sources cannot receive new changes, repository links or ENV versions.
Their GitHub binding is cleared and active repository access requests are
canceled. A removed source ID cannot be registered again; add a new source to
connect that folder later. Only active sources count toward the 100-source limit.
Existing upload receipts and read access to previously shared history remain
valid. Deploy the additive backend migration before exposing removal in a client;
older services retain local disconnect only.

Resources include optional `sourceId`. The source must belong to the resource's
project, cannot change after creation, and participates in logical-path
uniqueness. An omitted source denotes a project-level resource; desktop
filesystem materialization requires a specific connected source. Source identity
survives receipts, snapshots, conflict candidates, reviews, and pull events.
New ENV manifests can include a signed source ID, checked against the project
and immutable across revisions. Existing signed ENV histories remain unmodified.

## Coordinated migration to 0.5.0

Stop writers and back up PostgreSQL plus blobs using the deployment runbook.
Build the new packages, run `npm run migrate` to install schema migration 006,
then run `npm run migrate:sources` to inspect the existing projects. Apply with
`npm run migrate:sources -- --apply`. The data migration runs transactionally,
locks affected tables, and is idempotent. New projects already use source model 1
and are excluded from this legacy conversion.

Legacy projects get one default source with ID equal to the project ID. Resource
IDs, revisions, membership, and access policy remain stable. Resource payloads,
snapshots, conflict candidates, and events acquire that default source. Pending
exact-preview requests become stale and must be resubmitted. Signed ENV headers
retain their original bytes; a missing historical ENV source resolves to the
default source. The desktop has a separate explicit SQLite migration; run it on
each Mac before restarting sync. See the desktop's `docs/multiple-repositories.md`.

Both editions require the matching desktop for the new source model. The scripts
do not deploy images or migrate a running production service automatically.
