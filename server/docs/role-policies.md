# Role policies and Settings compatibility

Migration 010 adds Admin membership, nullable project role policies, logical-operation receipts, migration snapshots, and optional device hardware metadata. Existing projects stay on their current rules. New HTTP-created projects use the approved role defaults, including clients that omit the optional capability opt-in.

The existing governance transaction locks the project row before role-policy actions. Owner-only `save-role-policy` accepts exactly eight values in `policies.admin` and `policies.member` for memory, session, plan, and skill. Values are none, read, add, or write. The payload also contains `projectId`, `operationId`, and `expectedPolicyRevision`. Owner access is fixed and excluded.

One transaction changes all values, increments the revision, and records the operation result. Repeating the exact logical operation returns its receipt. Reusing an ID with a different request or submitting a stale revision returns a conflict. `policy-operation` reports committed or not_found so a client can reconcile a dropped response before retrying.

## Existing projects

`migration-preview` returns an exact snapshot and hash covering old mixed category rules, person overrides, retained resource/source restrictions, membership, and pending proposals. Confirmation must submit that hash with the current revision. A changed snapshot requires another review. The same transaction stores the snapshot, retires non-ENV person-category overrides, advances eligible pending proposals, and commits the role policies. Any failure rolls back every step.

Retained file/source rules are ceilings on a role, including recursive source restrictions. They cannot grant more than the category policy. Pending access records remain reviewable, but migrated projects reject new individual requests and redirect individual grants to role policies. Exact pre-migration content proposals retain the reviewed contribution path; current membership, source visibility, files, and base checks still apply.

Restriction catalog records remain private to the Owner and the person they restrict. In role-policy projects, Admins and Members can inspect their own records; neither role can enumerate another person's resource IDs or restrictions. Legacy projects keep the Owner-only catalog behavior.

## Authorization

Only Owner changes policies, appoints/demotes Admins, or transfers ownership. An Owner must transfer before leaving. Admins invite/remove Members, and cannot manage Owner or another Admin. Invitations retain one use and a 24-hour expiry.

Add only permits creation and reading one's own submissions, with no editing. Members cannot delete shared content. Admin deletion requires write access; Owner may delete. Another person's session cannot be rewritten. An authorized session tombstone preserves attribution/metadata and immutable prior snapshots, and requires the current revision. Role promotion never uploads private work.

## Verification and rollout

`tests/role-policies.integration.ts` exercises real PostgreSQL/HTTP boundaries, concurrent clients, a database fault after the policy update, a dropped response after commit, migration rollback, retained content/source restrictions, and membership controls. With `ORKA_ENV_NATIVE_BIN` set to the desktop debug binary, it also runs three isolated native profiles against the real service and checks SQLite queues, revoked uploads, per-Mac preferences, and retained files.

Run migration and the compatible service as one release. Cloud and self-hosted compositions share this core. The local tests do not establish that production Cloud has been deployed. No production migration or deployment was performed for this local Settings implementation.
