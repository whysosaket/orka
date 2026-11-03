import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sessionAncestors,
  sessionTree,
} from "../apps/mac/src/components/session-tree.js";
import type { ProjectResource } from "../apps/mac/src/types.js";

const resource = (
  id: string,
  parentId?: string,
  projectId = "project",
): ProjectResource => ({
  resourceId: id,
  projectId,
  source: "codex",
  kind: "session",
  logicalPath: `codex/${id}`,
  title: id,
  revision: 1,
  owner: "user",
  updatedBy: "user",
  updatedAt: "2026-11-02T00:00:00Z",
  deleted: false,
  hash: "hash",
  files: [],
  ...(parentId
    ? {
        fork: {
          parentId,
          nativeId: id,
          destination: "desktop",
          createdAt: "2026-11-02T00:00:00Z",
        },
      }
    : {}),
});

void test("fork trees preserve sibling sort order, nested ancestry, and filtered orphans", () => {
  const list = [
    resource("newest", "source"),
    resource("grandchild", "older"),
    resource("source"),
    resource("older", "source"),
    resource("other"),
  ];
  const tree = sessionTree(list);
  assert.deepEqual(
    tree.roots.map((r) => r.resourceId),
    ["source", "other"],
  );
  assert.deepEqual(
    tree.children.get("source")?.map((r) => r.resourceId),
    ["newest", "older"],
  );
  assert.deepEqual(sessionAncestors("grandchild", tree.parents), [
    "older",
    "source",
  ]);
  assert.deepEqual(
    sessionTree(list.filter((r) => r.resourceId === "grandchild")).roots.map(
      (r) => r.resourceId,
    ),
    ["grandchild"],
  );
});

void test("invalid lineage cannot hide sessions or join different projects and repositories", () => {
  const list = [
    resource("a", "b"),
    resource("b", "a"),
    resource("self", "self"),
    resource("orphan", "gone"),
    resource("foreign", "orphan", "other-project"),
    { ...resource("other-repo", "orphan"), sourceId: "different" },
  ];
  const tree = sessionTree(list);
  assert.equal(tree.roots.length, list.length);
  assert.equal(tree.parents.size, 0);
});
