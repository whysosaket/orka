import test from "node:test";
import assert from "node:assert/strict";
import type { ReviewRequest } from "@portable/protocol";
import type {
  LocalDraft,
  ProjectResource,
  Snapshot,
} from "../apps/mac/src/types.js";
import { projectAttention } from "../apps/mac/src/components/sync-attention.js";
import { skillBinding } from "../apps/mac/src/components/skill-review-state.js";

const resource = {
  resourceId: "skill",
  projectId: "one",
  kind: "skill",
  title: "Writing guide",
} as ProjectResource;
const draft = (
  id: string,
  status = "local",
  date = "2026-11-01T10:00:00Z",
): LocalDraft => ({ id, projectId: "one", resource, status, createdAt: date });
const request = (
  id: string,
  status: ReviewRequest["status"],
  canReview: boolean,
): ReviewRequest => ({
  id,
  projectId: "one",
  resourceId: resource.resourceId,
  title: resource.title,
  author: "author",
  type: "change",
  status,
  canReview,
  unread: true,
  createdAt: "2026-11-01T10:00:00Z",
  baseRevision: 1,
  policyRevision: 1,
  previewHash: "hash",
});
const snapshot = (overrides: Partial<Snapshot> = {}): Snapshot => ({
  user: "user",
  config: null,
  projects: [],
  resources: [resource],
  bindings: [],
  conflicts: [],
  activity: [],
  outbox: [],
  errors: [],
  sync: { online: true },
  daemon: { running: true },
  devices: [],
  deviceId: "device",
  background: true,
  ...overrides,
});

await test("attention requires a pending review decision, regardless of unread state", () => {
  const result = projectAttention(
    snapshot({
      reviewRequests: [
        request("approved", "approved", true),
        request("rejected", "rejected", true),
        request("waiting", "pending", false),
        { ...request("pending", "pending", true), unread: false },
      ],
    }),
    "one",
  );
  assert.equal(result.items.length, 1);
  assert.deepEqual(
    result.items[0].requests.map((r) => r.id),
    ["pending"],
  );
  assert.deepEqual(
    result.waitingRequests.map((r) => r.id),
    ["waiting"],
  );
  assert.deepEqual(
    result.historyRequests.map((r) => r.id),
    ["approved", "rejected"],
  );
});

await test("a resource counts once across request, partial binding, draft, error and failed upload", () => {
  const binding = {
    resourceId: "skill",
    projectId: "one",
    installationState: "locally_modified",
    paths: [
      "/project/.agents/skills/writing",
      "/project/.claude/skills/writing",
    ],
  };
  const state = snapshot({
    reviewRequests: [request("review", "pending", true)],
    bindings: [binding],
    drafts: [draft("local")],
    errors: [{ source: "skill", error: "Local edits preserved" }],
    outbox: [
      {
        id: "upload",
        project: "one",
        resourceId: "skill",
        error: "Local edits preserved",
      },
    ],
  });
  const result = projectAttention(state, "one");
  assert.equal(result.items.length, 1);
  const item = result.items[0];
  assert.equal(item.binding, binding);
  assert.equal(item.draft?.id, "local");
  assert.equal(item.uploads.length, 1);
  assert.equal(item.requests.length, 1);
  assert.deepEqual(item.messages, ["Local edits preserved"]);
  assert.equal(item.paths.length, 2);
  assert.equal(skillBinding(state, resource), binding);
});

await test("foreign project operations and their last-error copy do not leak into this project", () => {
  const error = "409: Resource changed";
  const state = snapshot({
    resources: [
      resource,
      { ...resource, resourceId: "other", projectId: "two" },
    ],
    errors: [{ source: "other", error }],
    outbox: [{ id: "upload", project: "two", resourceId: "other", error }],
    sync: { online: true, error },
  });
  const selected = projectAttention(state, "one");
  assert.equal(selected.items.length, 0);
  assert.equal(selected.outbox.length, 0);
  assert.equal(selected.accountError, undefined);
  assert.equal(projectAttention(state, "two").items.length, 1);
});

await test("distinct project errors and genuine account connectivity remain available", () => {
  const state = snapshot({
    errors: [
      { source: "one:folder-a", error: "Folder unavailable" },
      { source: "one:folder-b", error: "Folder unavailable" },
      {
        source: "history:unattributed:session.jsonl",
        error: "Transcript cannot be read",
      },
    ],
    sync: { online: false, error: "Service unavailable" },
  });
  const selected = projectAttention(state, "one");
  assert.equal(selected.items.length, 2);
  assert.equal(selected.accountError, "Service unavailable");
  assert.deepEqual(selected.accountIssues, [
    {
      source: "history:unattributed:session.jsonl",
      error: "Transcript cannot be read",
    },
  ]);
  assert.equal(projectAttention(state, "two").items.length, 0);
});

await test("newer publication does not hide a still-unresolved local snapshot", () => {
  const saved = draft("unresolved");
  const published = draft("published", "published", "2026-11-02T10:00:00Z");
  const selected = projectAttention(
    snapshot({ drafts: [published, saved] }),
    "one",
  );
  assert.equal(selected.items[0].draft?.id, "unresolved");
  assert.deepEqual(
    selected.historyDrafts.map((d) => d.id),
    ["published"],
  );
});

await test("newest actionable capture is one review while older and archived bytes stay in history", () => {
  const saved = {
    ...draft("older"),
    resource: {
      ...resource,
      files: [
        { path: "SKILL.md", hash: "old-bytes", size: 10, executable: false },
      ],
    },
  };
  const current = draft("newer", "local", "2026-11-02T10:00:00Z");
  const archived = {
    ...draft("archived", "dismissed", "2026-10-01T10:00:00Z"),
    dismissalReason: "superseded",
  };
  const selected = projectAttention(
    snapshot({ drafts: [saved, archived, current] }),
    "one",
  );
  assert.equal(selected.items.length, 1);
  assert.equal(selected.items[0].draft?.id, "newer");
  assert.deepEqual(
    selected.historyDrafts.map((d) => d.id),
    ["older", "archived"],
  );
  assert.equal(selected.historyDrafts[0].resource.files[0].hash, "old-bytes");
});

await test("session conflicts stay actionable while copy activity is history", () => {
  const session = {
    ...resource,
    resourceId: "session",
    kind: "session" as const,
  };
  const copy = { ...session, resourceId: "copy" };
  const conflict = {
    id: "conflict",
    resourceId: "session",
    revision: 4,
    author: "author",
    deviceId: "other",
    candidate: session,
  };
  const state = snapshot({
    resources: [session, copy],
    conflicts: [conflict],
    outbox: [
      {
        id: "session-upload",
        project: "one",
        resourceId: "session",
        error: "409: Session changed",
      },
    ],
    activity: [
      {
        id: "copy-event",
        type: "session_copied",
        author: "author",
        notifyOwner: "user",
        resourceId: "session",
        copyId: "copy",
      },
    ],
  });
  const selected = projectAttention(state, "one");
  assert.equal(selected.items.length, 1);
  assert.deepEqual(selected.items[0].conflicts, [conflict]);
  assert.equal(selected.activity.length, 1);
});

await test("detached bindings with no resource do not invent review targets", () => {
  assert.equal(
    projectAttention(
      snapshot({
        bindings: [
          {
            resourceId: "detached",
            projectId: "one",
            installationState: "locally_modified",
          },
        ],
      }),
      "one",
    ).items.length,
    0,
  );
});
