# Resource permissions and private memory

This desktop candidate uses canonical backend/protocol 0.4.1. Deploy the matching
backend before using governed projects. OSS and managed deployments share the
same policy evaluation, migrations and request implementation.

## Enable and configure

New projects on a supported service use resource permissions. Existing projects
retain their previous behavior until an owner opens **Members** in the sidebar, reviews published resources and queued changes, and enables the model.
Activation preserves previously published memory as shared knowledge. Unsupported
clients must upgrade before accessing a governed project.

Owners retain membership administration. **Members and permissions** has Members
and Requests views. Select a member or **Default member permissions** to configure
Memories, Skills, Plans, Sessions, and ENV sets. Memories groups the existing
instruction and learned-memory policy classes; changing one field preserves the
other fields in each class, including older differences. View only, Suggest
changes, and Can edit explain consumption, reviewed proposals, and publication.
New-item permissions and sharing delegation remain separate.

Changes are staged locally, reviewed, then saved with revision checks. The existing
backend accepts one category per transaction. A multi-category save uses each
returned revision, stops on failure, refreshes accepted settings, and retains any
unsaved changes for another review. A policy change after review requires reviewing
again. This interface does not claim an atomic multi-category save.

Individual file exceptions appear below a selected member. Open a file's More
menu and choose **Permissions and updates**, or an ENV set's **Permissions** action,
to review its exception. Each explicit member/resource rule replaces its default.
**Use project defaults** and **Use member default** remove overrides.

- Hidden excludes a resource from Orka access, sync and generated context.
- Read permits consuming accepted content and authorized history.
- Suggest also permits submitting immutable changes for review.
- Publish permits updating accepted content and reviewing suggestions.
- Manage sharing is independent. Delegates can grant existing members access up
  to their own current level; only owners delegate sharing management.

For selected audiences, configure the relevant defaults as Hidden and grant the
selected members resource access. Owners administer ordinary shared resources.
ENV access additionally requires signed recipients and trusted devices. Session
originals retain their author's protection; teammates continue through copies.
Known Orka source context constrains copies and derived plans.
Governed ZIP imports remain private until submitted. A governed bundle retains
its source project and audience; automatic import into a different project is
blocked in this release. Cross-tool handoffs retain their source lineage, including
the interval before the receiving transcript is indexed.

## Personal learning and promotion

Enabling Memories permits discovery into private candidates. It never publishes
new native memory automatically. Codex and Claude keep updating their own stores.
Incoming knowledge lives at
`<project>/.orka/memory/resources/<resourceId>/content.md`, outside native memory.
Legacy Orka cache copies are detached, retaining edits as private drafts.

Review discovered candidates under **Manage → Requests → Changes on this Mac**.
There is no manual memory-topic form or separate Drafts view. Native agents can
still save scoped Markdown candidates and identify a same-scope accepted entry to
supersede through the existing JSON bridge. Related entries and exact duplicates use bounded
deterministic matching. Distinct scopes coexist; superseded facts leave active
context and remain in history.

Submit only selected content. Publishers inspect the exact prepared diff, scope,
provenance, supersession and prospective audience. Instructions bypass inference.
Knowledge uses existing JEV consolidation against its target revision. Missing
credentials or uncertainty preserve the private candidate. Approval binds the
preview hash, target revision and permission revision. Stale/rejected drafts can
be refreshed and explicitly resubmitted as a new request.

Request access from Memories, Skills, Plans, or Sessions. Collection requests
work even with no visible items and are reviewed by project owners. Item views use the same
category request; they do not expose individual file permission controls. Existing individual file
restrictions and creation rights remain enforced. Only owners manage sharing. Requests
are reviewed in Manage → Requests; the management page has no request form. ENV
requests stay in the encrypted ENV workflow and retain recipient and trusted-device
requirements. Member names come from account metadata, with email as a fallback.

Notifications open **Manage → Requests**; read state persists across devices. Attachments
are restricted to their author and current reviewers until acceptance. Target,
proposer or policy changes can make requests stale.

## Local installation and revocation

On updated clients, authorized shared skills install into both project skill
folders automatically when Skills sharing is enabled and a folder is connected.
Clean updates and shared removals apply during sync. Sharing off pauses these
writes. Local edits, conflicting copies, unsafe destinations, and interrupted
installations stay protected and appear as sync issues for resolution.
Shared instructions still need explicit local installation review.
**Requests → Updates on this Mac** and file-specific reviews show Current,
Update available, Locally modified or Review pending. Conflict and instruction
reviews bind the live diff to the exact shared version and local hashes. Both
skill mirrors, assets and executable flags are covered by a durable installation
journal. Changed local hashes invalidate the preview. Edits are preserved as
private drafts; deleting a mirror never deletes the shared skill.

Revocation removes Orka-managed context after reconnect and retains dirty work
privately. It cannot erase previously downloaded files or existing conversations.
A revoked resource is not represented as a project-wide deletion.

## Native agent bridge

Trusted native hooks inject bounded authorized, accepted knowledge with paths,
provenance, the executable path, project ID and valid JSON examples. Native hooks
include provider/session IDs; known session sources survive session end. Existing
hook configuration and native trust controls remain in effect.

Use the executable and arguments supplied by the installed hook, including its
`--profile` selector, followed by `--orka-context`. This keeps agent commands bound
to the same local account as the hook. Pass JSON on stdin:

```json
{
  "action": "context",
  "input": { "projectId": "<project UUID>", "cwd": "<project folder>" }
}
```

Operations: `catalog`, `resource` (effective access), `context`, `drafts`, `draft`, `save-candidate`, `submit-draft`,
`refresh-draft`, `request-access`, `requests`, `request`. Candidates accept `topic`,
`scope`, `content`, `provider`, optional `supersedes`, `contextToken` and `sessionId`.
Saving returns a private ID; submission explicitly sends that ID. Authentication
stays in Orka. Agent operations provide no administration or installation authority.

## ENV and rollout

Read/publish policy intersects existing signed recipient/device rules. Local
dotenv overrides and preview/Git checks remain available. Blocked publishers
request access, then use encrypted publishing. ENV plaintext never enters review
notifications or memory inference. New read access may remain **Awaiting trusted
device** until encryption and approval finish.

For creator departure, an eligible device prepares and publishes a fresh
replacement. Recipients review its trust; an owner marks the old set replaced.
Removal immediately blocks server access and disables sets created by that member.
Existing eligible devices may read a disabled set pending replacement for recovery.
Completed replacement blocks old reads. Signed creator history never changes.

The additive migration requires a coordinated database/blob backup. Do not roll
back to a server without enforcement while governed projects exist. Packages are
locally pinned by backend source commit and integrity; this is not a deployment.
Physical two-Mac, signed-app trust and desktop sidebar acceptance remain release
checks in [verification](verification.md).

Regression tests cover HTTP/blob permissions, exact approvals, native learning,
revocation, installation/removal, durable session provenance and independent native
clients. ENV tests use real ciphertext and an isolated Keychain substitute. Tests
never use personal memory, real dotenv files or production credentials.

V1 adds no custom roles, groups, policy language, private memory sync, vector store,
background extraction service or encryption format.

## Management iteration (0.4.2)

Manage keeps Members and Requests, with five compact access cards. Can suggest
new items requires approval; Can add new items publishes directly. Choose one
or neither independently of editing access. ENV keeps its encrypted publishing
workflow. View logs floats at the bottom right while page content scrolls, without a footer bar. Only owners change permissions or remove members; the
creator cannot be removed. Sharing delegation and individual file ACL editors are
removed from the product UI. Migration 005 clears historical sharing delegation
without changing file access modes, and advances affected policy revisions.

View logs opens a separate, paginated cloud activity page. Backend records include
requests, decisions, membership and permission changes, with actor names captured
at the time. Owners see the project history; other members see project-wide events
and events involving themselves. Logs contain no file content, ENV values or
invite tokens. Database triggers reject row edits and deletion; deleting the whole
project retains normal cascade behavior. Existing request outcomes import once,
labeled historical records at migration time.

Read-only native management operations no longer take the workspace file lock or
schedule background sync. Local file operations retain the lock and server
mutations retain project transaction authorization. Request lists start at five
entries and expand in groups of five. Skills and instruction update reviews retain
the exact-version and local-edit preservation checks.
