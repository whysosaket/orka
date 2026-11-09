# Governed sharing and curated memory

Backend 0.4.0 adds resource permissions without replacing owner/member administration.
Both images use the same protocol, migrations and server core. This checkout is a
local candidate until its packages and images are released together with the desktop.

Existing projects remain legacy projects until an owner reviews the catalog and
activates governance. Updated desktop clients request governance when creating a
new project. Clients using governed projects send `X-Orka-Governance: 1`; pull also
sends `governance=1` and its last `policyRevision`. These declarations are compatibility
checks. Every operation still authorizes the authenticated user on the server.

## Policies

New governed projects let members edit and add instructions, memories, skills,
plans and sessions by default. ENV sets retain view access with suggested
additions; encrypted recipient and trusted-device checks still apply. Owners
can choose more restrictive project defaults or member overrides. Existing saved
project policies are not migrated, and session originals remain creator-only.

`hidden`, `read`, `suggest`, and `publish` are increasing access levels. Owners
configure category defaults and member overrides. Only the owner controls sharing
and membership. `canShare` remains in the wire format for compatibility, but nonowner
effective access always returns false and new delegation attempts are rejected.
Migration 005 clears historical delegation without broadening file access. Existing
resource overrides remain enforced internally; current clients expose category
controls only. Creation rights are represented as a Can add new items checkbox.

Instructions are classified from validated `memory/shared/instructions/...`
identities; curated knowledge uses `memory/shared/knowledge/<resourceId>.md`.
Provider identity never determines privacy. New ordinary resource and ENV IDs
cannot collide. Session originals retain creator-only mutation.

Creating, copying, restoring and suggesting check category creation rights. File
manifests require verified uploader-owned bytes or an authorized reference. Blob
downloads require current readable accepted history or an authorized proposal;
unreferenced staged uploads are private to their uploader. Known source references
constrain derived audiences dynamically, including later membership/policy changes.
Self-references, cycles and more than 100 normalized sources are rejected.

## Review and sync

`POST /v2/governance/action` provides catalog, activation, policy, resource access,
change submission, access requests, request inspection/decisions, read receipts,
member removal and ENV replacement. Mutations serialize on the project lock.
Owners can remove member/resource exceptions with `inherit`. ENV listing and
reads hold the shared project lock so access and signed headers describe one
authorized state. Prepared proposal blobs use current proposal authorization;
uploader ownership only permits downloads of genuinely unreferenced staging bytes.
Requests hold an immutable prepared manifest and preview hash. Content reviewers
need publication rights; access reviewers must be the project owner. Approval checks
current proposer/reviewer membership, policy revision, target revision and preview.
Changed policy or target versions leave an approval stale. Repeated decisions do
not republish. Instructions, skills and plans reject stale-base publication in
governed projects. Instructions bypass semantic consolidation. Knowledge previews
retain existing bounded JEV consolidation, without rerunning it after approval.

Permission changes and new memberships increment `policyRevision`. Joining holds
the publication lock and requires a supported client before consuming its invite.
A mismatched pull returns an
authorized current snapshot and cursor with `reset: true`. Clients reconcile
revocations locally, retaining dirty work as private drafts. Filtered pages advance
to the last scanned event even when every event is hidden. Receipt, related-event,
presence and blob authorization use current access. Permissions cannot erase
already downloaded copies or existing conversations.

## Personal memory and ENV

Personal native memory stays local. Only selected promotion sends content to the
service. Curated entries carry topic, scope, provider and supersession references.
Related lookup is deterministic and bounded; this release does not infer facts
from all sessions or promise semantic conflict detection across files. Shared
knowledge is reference material, not permission policy or executable instructions.

ENV remains format 1, encrypted and manually applied. Server read/publish policy
intersects signed grants/device approval. Owners do not automatically decrypt.
New access can require a trusted device before it is ready. Read-only recipients
request publishing access rather than submitting plaintext change proposals.
Creator departure never changes signed history: an eligible remaining device
creates a replacement set, and an owner disables the old set using replacement
metadata. Disabled sets cannot publish; a set pending replacement remains readable
to its existing authorized devices for recovery. A completed replacement blocks
old-set reads. Local dotenv overrides remain outside shared publication policy.

No new deployment secrets or inference services are required. Existing JEV settings
and their retry/uncertainty behavior are unchanged. Back up database and blobs
together before applying migration 004. Its additive tables/columns preserve legacy
projects; do not roll back to a server without governance enforcement while governed
projects exist.

## Verification

`npm test`, `npm run typecheck`, `npm run build` and `npm run test:integration`
exercise the shared implementation. The governance HTTP test uses synthetic users,
temporary PostgreSQL and blob storage, and covers proposals, exact approvals,
stale previews, private attachments, guessed hashes, grants/revocations, derivative
audiences, unsupported clients, delegated grants and disabled ENV publication.
Desktop/native/real-agent acceptance belongs to the coordinated client release.

## Management logs (0.4.2)

The `logs` action returns at most 100 records (25 by default), newest first, with
an opaque decimal `before` cursor and `next` for pagination. Owners see all project
records. Other members see project-wide records and events where they are actor
or subject. Current project membership is required. Logs snapshot actor/subject
names, action, time and category/access metadata, never content, values or tokens.
Request creation and final decisions use deduplication keys in the same transaction
as their state change. Row updates and deletes are rejected by a database trigger;
whole-project deletion can cascade. Migration 005 imports existing request outcomes
once at migration time without claiming to recover their decision timestamps.

Take a coordinated database/blob backup before upgrading. An older image does not
restore sharing delegation or remove logs; do not roll back to a version that
omits governance enforcement. No new environment configuration is required.
