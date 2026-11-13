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

await test("native scanner, installation recovery and publication aliases share one resource review", () => {
  const skill = { ...resource, sourceId: "source-a", logicalPath: "writing" };
  const message = "Local skill edits preserved";
  for (const scanId of ["one:source-a", "one:source:source-a"]) {
    const selected = projectAttention(
      snapshot({
        resources: [skill],
        bindings: [
          {
            resourceId: "skill",
            projectId: "one",
            installationState: "locally_modified",
          },
        ],
        drafts: [{ ...draft("local"), resource: skill }],
        reviewRequests: [request("review-request", "pending", true)],
        errors: [
          { source: "skill", error: message },
          { source: `${scanId}:scan:skills/writing`, error: message },
          {
            source: "one:installation:skill",
            error: "Installation recovery pending",
          },
          {
            source: "one:publish:review-request",
            error: "Publication needs review",
          },
          { source: "one:publish:local", error: "Local draft needs review" },
        ],
      }),
      "one",
    );
    assert.equal(selected.items.length, 1);
    assert.equal(selected.items[0].resourceId, "skill");
    assert.equal(selected.items[0].messages.length, 4);
    assert.equal(selected.items[0].requests.length, 1);
    assert.equal(selected.items[0].draft?.id, "local");
  }
});

await test("legacy unscoped scanner aliases match only the exact unscoped logical identity", () => {
  const instruction = {
    ...resource,
    resourceId: "instruction",
    kind: "memory" as const,
    logicalPath: "instructions/AGENTS.md",
  };
  const skill = { ...resource, logicalPath: "writing" };
  const selected = projectAttention(
    snapshot({
      resources: [skill, instruction],
      errors: [
        { source: "skill", error: "Skill differs" },
        { source: "one:scan:skills/writing", error: "Skill differs" },
        { source: "instruction", error: "Instructions differ" },
        {
          source: "one:scan:instructions/AGENTS.md",
          error: "Instructions differ",
        },
      ],
    }),
    "one",
  );
  assert.deepEqual(
    selected.items.map((item) => item.resourceId),
    ["skill", "instruction"],
  );
});

await test("publication aliases follow frozen prepared IDs and queued operation identities", () => {
  const prepared = {
    ...resource,
    resourceId: "published-memory",
    kind: "memory" as const,
  };
  const original = { ...prepared, resourceId: "private-memory" };
  const saved: LocalDraft = {
    ...draft("draft-record", "proposed"),
    resource: original,
    requestId: "request-id",
    submission: {
      id: "frozen-operation",
      resource: { resourceId: prepared.resourceId },
    },
    automaticSharing: true,
  };
  const selected = projectAttention(
    snapshot({
      resources: [prepared],
      drafts: [saved],
      outbox: [
        {
          id: "queued-operation",
          project: "one",
          resourceId: prepared.resourceId,
          error: "Upload blocked",
        },
      ],
      errors: [
        { source: "one:publish:request-id", error: "Review required" },
        { source: "one:publish:draft-record", error: "Review required" },
        { source: "one:publish:frozen-operation", error: "Review required" },
        { source: "one:publish:queued-operation", error: "Review required" },
      ],
    }),
    "one",
  );
  assert.equal(selected.items.length, 1);
  assert.equal(selected.items[0].resourceId, prepared.resourceId);
  assert.deepEqual(selected.items[0].messages, [
    "Upload blocked",
    "Review required",
  ]);
});

await test("unknown and ambiguous scanner aliases remain separate diagnostics despite equal messages", () => {
  const first = {
    ...resource,
    resourceId: "first",
    sourceId: "source-a",
    logicalPath: "writing",
  };
  const second = { ...first, resourceId: "second", sourceId: "source-b" };
  const errors = [
    { source: "first", error: "Local edits preserved" },
    { source: "second", error: "Local edits preserved" },
    { source: "one:scan:skills/writing", error: "Local edits preserved" },
    {
      source: "one:source-unknown:scan:skills/writing",
      error: "Local edits preserved",
    },
    {
      source: "one:source-a:scan:skills/unknown",
      error: "Local edits preserved",
    },
  ];
  const selected = projectAttention(
    snapshot({ resources: [first, second], errors }),
    "one",
  );
  assert.equal(selected.items.length, errors.length);
  assert.equal(selected.items.filter((item) => item.resourceId).length, 2);
  const ambiguous = projectAttention(
    snapshot({
      resources: [first, { ...first, resourceId: "same-source-duplicate" }],
      errors: [
        {
          source: "one:source-a:scan:skills/writing",
          error: "Review required",
        },
      ],
    }),
    "one",
  );
  assert.equal(ambiguous.items.length, 1);
  assert.equal(ambiguous.items[0].resourceId, undefined);
});

await test("unknown installation/publication aliases and conflicting publication identities are not guessed", () => {
  const selected = projectAttention(
    snapshot({
      reviewRequests: [request("ambiguous", "pending", true)],
      outbox: [
        {
          id: "ambiguous",
          project: "one",
          resourceId: "another-resource",
          error: "Review required",
        },
      ],
      errors: [
        { source: "one:publish:ambiguous", error: "Review required" },
        { source: "one:publish:unknown", error: "Review required" },
        { source: "one:installation:unknown", error: "Review required" },
        { source: "two:installation:skill", error: "Foreign project" },
      ],
    }),
    "one",
  );
  assert.equal(selected.items.length, 5);
  assert.equal(selected.items.filter((item) => !item.resourceId).length, 3);
  assert.equal(
    selected.items.some((item) => item.messages.includes("Foreign project")),
    false,
  );
});

await test("exact scanner binding paths and resource deletion IDs retain source boundaries", () => {
  const session = {
    ...resource,
    resourceId: "session",
    sourceId: "source-a",
    kind: "session" as const,
  };
  const plan = {
    ...session,
    resourceId: "plan",
    kind: "plan" as const,
    logicalPath: "codex/sessions/native/plan.md",
  };
  const selected = projectAttention(
    snapshot({
      resources: [session, plan],
      bindings: [
        {
          resourceId: "session",
          projectId: "one",
          paths: ["/synthetic/transcript.jsonl"],
        },
        { resourceId: "plan", projectId: "one", paths: ["/synthetic/plan.md"] },
      ],
      errors: [
        { source: "session", error: "Session differs" },
        {
          source: "one:source-a:scan:/synthetic/transcript.jsonl",
          error: "Session differs",
        },
        { source: "one:source-a:scan:session", error: "Session differs" },
        { source: "plan", error: "Plan differs" },
        {
          source: "one:source-a:scan:plans:/synthetic/plan.md",
          error: "Plan differs",
        },
        {
          source: "one:source-a:scan:plan:codex/sessions/native/plan.md",
          error: "Plan differs",
        },
        {
          source: "one:source-b:scan:/synthetic/transcript.jsonl",
          error: "Wrong source",
        },
      ],
    }),
    "one",
  );
  assert.equal(selected.items.length, 3);
  assert.equal(
    selected.items.find((item) => item.resourceId === "session")?.messages
      .length,
    1,
  );
  assert.equal(
    selected.items.find((item) => item.resourceId === "plan")?.messages.length,
    1,
  );
  assert.equal(
    selected.items.find((item) => item.messages.includes("Wrong source"))
      ?.resourceId,
    undefined,
  );
});
