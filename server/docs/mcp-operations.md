# Operating Orka through MCP

The plugin exposes accepted shared resources to local and cloud agents using the
same project permissions and review services as Orka. Private local files,
credentials and encrypted ENV sets are excluded from the remote tools.

## Consent and compatibility

Migration `004_mcp_operations.sql` adds scope persistence to MCP grants and durable
operation receipts. Existing tokens remain `orka.read`. Reconnect and explicitly
consent to additional permissions before using writes or administration. A refresh
can retain or reduce its grant; it cannot add permissions. Refresh rotation and
family revocation continue to apply.

| Scope | Tools |
| --- | --- |
| `orka.read` | Existing context/session tools, `search_resources`, `get_resource_history`, `compare_revisions`, `list_skills`, `get_permissions`, `list_requests` |
| `orka.read orka.write` | `create_memory`, `update_plan`, `resolve_conflict` |
| `orka.read orka.manage` | `update_permissions`, `review_request` |

Inspection through `resolve_conflict` or `review_request` requires that tool's
write/manage scope even when the individual call does not mutate state. OAuth
consent does not override project membership, source restrictions, session
ownership, current permissions or the existing approval workflow. Missing scopes
return an MCP `insufficient_scope` challenge. Both server editions share this
implementation.

The managed Dashboard must describe the returned `scopes` on the consent page,
including failed-login retries, with matching permission descriptions.
Its issuer, resource and token endpoints remain on the API. Self-hosted consent
uses the API's matching permission descriptions. Deploy compatible consent pages
and migration before distributing the updated plugin. Older read-only clients
continue to work.

## Discover and inspect

`search_resources` and shared `list_skills` accept an optional project/repository
source, query, limit and cursor. A source filter requires its project ID. Search
matches titles and readable content; instruction resources are classified as
`instructions`, while curated memories use `memory`. Follow `nextCursor` even on
an empty page: permission filtering can remove all matches from a scan page.
Results describe accepted shared snapshots, not live agent activity.

History uses `beforeRevision`/`nextBeforeRevision`. Revision comparisons return
changed file manifests, changed metadata and bounded before/after text for the
selected file. Continue with `nextOffset` and the same revision pair. Session
comparisons use the readable conversation representation and omit setup,
analysis and tool records. Every history read checks current access and the
historical resource's source dependencies.

Skill discovery includes complete file manifests, executable flags, revision and
`snapshotHash`. Installations use the separate local `install_skill` tool; a cloud
MCP connection cannot write onto a disconnected Mac. The native authenticated
`installation` governance action checks the exact current accepted skill revision
before returning its resource and access, and existing blob routes enforce access
on every download. Complete packages retain the normal 200-file, 4 MB total and
1 MB per-file limits.

## Writes and retries

Use one fresh `requestId` for an intended memory, plan update, permission change or
conflict resolution. Retry the identical arguments with the same ID after an
uncertain response. Reusing an ID with different content is rejected. Receipts
are transactional and current authorization is checked again on retry.

`create_memory` saves a curated knowledge entry with optional source, relative
folder scope and context sources. `update_plan` retains the accepted plan's
identity and requires its current `expectedRevision`. A stale plan is rejected
before changes are applied. Both tools return `published` or `approval_required`;
a pending proposal is not published content.

`get_permissions` reports effective category or resource access. Only an owner
can inspect another member's effective permissions. `update_permissions` uses
Orka's current policy, resource-access and member-role workflows, with a current
`expectedPolicyRevision`. It cannot delegate sharing or silently migrate a project
to role policies; review that migration in Orka Settings first. Non-owner callers
cannot change sharing permissions.

`list_requests` returns authorized access/change requests, excluding ENV requests.
Inspect with `review_request` before deciding. Proposed text/skill file bytes are
included for exact review. Session proposals use paginated readable conversations,
without raw native files. Continue a session proposal with its `nextOffset` and
`previewHash`. Decisions require the exact preview hash and current policy
revision; stale requests follow Orka's existing stale-review behavior.

Inspect session conflicts with `resolve_conflict` and `action: inspect`. Current
and candidate conversations include their authors, revisions, bounded text and
`nextOffset`. Continue using the current accepted revision as `expectedRevision`;
restart inspection after a revision change. `accept` or `copy` applies the selected
current/candidate version through the existing resolver, preserving session
ownership, copy provenance and permissions. Identical retries return the saved
result even after the conflict has been resolved.

This API does not operate a machine's outbox or install skills directly. Local
`get_sync_status`, `retry_sync`, `repair_sync` and `install_skill` are implemented by
the desktop plugin against that machine's connected account and service.
