import { test } from "node:test";
import assert from "node:assert/strict";
import type { ProjectResource } from "../apps/mac/src/types.js";
import { resourceCatalog } from "../apps/mac/src/components/resource-catalog.js";
import {
  applyIndexFilters,
  defaultIndexFilters,
} from "../apps/mac/src/components/index-toolbar.js";

const resource = (
  id: string,
  fields: Partial<ProjectResource> = {},
): ProjectResource => ({
  resourceId: id,
  projectId: "project",
  sourceId: "frontend",
  source: "codex",
  kind: "session",
  logicalPath: `codex/${id}`,
  title: id,
  revision: 2,
  owner: "me",
  updatedBy: "me",
  updatedAt: "2026-11-13T08:00:00Z",
  deleted: false,
  hash: `snapshot-${id}`,
  files: [],
  ...fields,
});
const context = {
  displayTitle: (resource: ProjectResource) => resource.title,
  user: "me",
};

void test("the default collection includes private, own shared, and teammate content", () => {
  const shared = [
    resource("my-shared", { updatedBy: "teammate" }),
    resource("teammate-shared", { owner: "teammate", updatedBy: "me" }),
  ];
  const privateItem = resource("private", { local: true, revision: 0 });
  const catalog = resourceCatalog(shared, [privateItem]);
  assert.equal(defaultIndexFilters.ownership, "all");
  assert.deepEqual(
    applyIndexFilters(catalog, defaultIndexFilters, context).map(
      (item) => item.resourceId,
    ),
    ["my-shared", "teammate-shared", "private"],
  );
});

for (const kind of ["memory", "session", "plan"] as const) {
  void test(`${kind} ownership views follow the owner despite edits and downloaded copies`, () => {
    const catalog = [
      resource("mine", { kind, updatedBy: "teammate" }),
      resource("private", { kind, local: true, revision: 0 }),
      resource("downloaded", { kind, owner: "teammate", updatedBy: "me" }),
    ];
    assert.deepEqual(
      applyIndexFilters(
        catalog,
        { ...defaultIndexFilters, ownership: "mine" },
        context,
      ).map((item) => item.resourceId),
      ["mine", "private"],
    );
    assert.deepEqual(
      applyIndexFilters(
        catalog,
        { ...defaultIndexFilters, ownership: "shared" },
        context,
      ).map((item) => item.resourceId),
      ["downloaded"],
    );
  });
}

void test("ownership composes with repository, provider, search, and sorting", () => {
  const catalog = [
    resource("mine-latest", {
      title: "Backend notes",
      sourceId: "backend",
      updatedAt: "2026-11-13T09:00:00Z",
    }),
    resource("mine-earlier", {
      title: "Backend notes",
      sourceId: "backend",
    }),
    resource("teammate", {
      owner: "teammate",
      title: "Backend notes",
      sourceId: "backend",
    }),
    resource("other-provider", {
      source: "claude",
      title: "Backend notes",
      sourceId: "backend",
    }),
    resource("other-repository", { title: "Backend notes" }),
    resource("other-title", { title: "Unrelated", sourceId: "backend" }),
  ];
  const filters = {
    ...defaultIndexFilters,
    ownership: "mine" as const,
    repository: "backend",
    source: "codex" as const,
    query: " NOTES ",
  };
  assert.deepEqual(
    applyIndexFilters(catalog, filters, context).map((item) => item.resourceId),
    ["mine-latest", "mine-earlier"],
  );
  assert.equal(catalog.length, 6);
});

void test("author sorting follows session and plan owners while memories and skills keep their updater", () => {
  for (const kind of ["session", "memory", "plan", "skill"] as const) {
    const catalog = [
      resource("alex-session", { kind, owner: "alex", updatedBy: "zoe" }),
      resource("zoe-session", { kind, owner: "zoe", updatedBy: "alex" }),
    ];
    const sorted = applyIndexFilters(
      catalog,
      { ...defaultIndexFilters, sort: "author" },
      {
        ...context,
        memberName: (id) => id,
      },
    ).map((item) => item.resourceId);
    assert.deepEqual(
      sorted,
      kind === "session" || kind === "plan"
        ? ["alex-session", "zoe-session"]
        : ["zoe-session", "alex-session"],
    );
  }
});

void test("a private continuation occupies one row while preserving its published ownership and revision", () => {
  const published = resource("continued");
  const continuation = {
    ...published,
    files: [
      {
        path: "session.jsonl",
        hash: "new-content",
        size: 24,
        executable: false,
      },
    ],
    hash: "new-content",
    localChanges: true,
    sharedRevision: published.revision,
  };
  const catalog = resourceCatalog([published], [continuation]);
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].hash, "new-content");
  assert.equal(catalog[0].owner, published.owner);
  assert.equal(catalog[0].revision, published.revision);
  assert.equal(catalog[0].local, undefined);
  assert.equal(published.hash, "snapshot-continued");
});

void test("a newly received publication wins over discoveries from an older shared base", () => {
  const latest = resource("continued", { revision: 3, hash: "latest-shared" });
  const olderDiscovery = resource("continued", {
    revision: 2,
    localChanges: true,
    hash: "older-discovery",
  });
  const unpublishedDiscovery = resource("continued", {
    local: true,
    revision: 0,
    hash: "before-publication",
  });
  for (const discovery of [olderDiscovery, unpublishedDiscovery]) {
    const catalog = resourceCatalog([latest], [discovery]);
    assert.equal(catalog.length, 1);
    assert.equal(catalog[0].hash, "latest-shared");
    assert.equal(catalog[0].revision, 3);
  }
});

void test("a newly removed shared snapshot cannot be resurrected by a cached published discovery", () => {
  const removed = resource("removed", { deleted: true, revision: 3 });
  for (const localChanges of [false, true]) {
    const cached = resource("removed", { revision: 2, localChanges });
    const catalog = resourceCatalog([removed], [cached]);
    assert.equal(catalog.length, 1);
    assert.equal(catalog[0].deleted, true);
    assert.equal(catalog[0].revision, 3);
  }
});

void test("revoked shared resources cannot survive through cached catalog entries", () => {
  const privateItem = resource("private", { local: true, revision: 0 });
  const cached = [
    resource("teammate", { owner: "teammate" }),
    resource("my-continuation", { localChanges: true, sharedRevision: 2 }),
    privateItem,
  ];
  const catalog = resourceCatalog([], cached);
  assert.deepEqual(
    catalog.map((item) => item.resourceId),
    ["private"],
  );
  assert.equal(catalog[0].local, true);
  assert.equal(catalog[0].revision, 0);
});

void test("a cached overlay cannot gain shared status through another local catalog entry", () => {
  const privateItem = resource("same", { local: true, revision: 0 });
  const stalePublished = resource("same", { localChanges: true });
  const catalog = resourceCatalog([], [privateItem, stalePublished]);
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].local, true);
  assert.equal(catalog[0].revision, 0);
});

void test("removing a shared snapshot does not hide a surviving private copy", () => {
  const removed = resource("retained", { deleted: true, revision: 3 });
  const local = resource("retained", { local: true, revision: 0 });
  const catalog = resourceCatalog([removed], [local]);
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].deleted, false);
  assert.equal(catalog[0].local, true);
  assert.equal(catalog[0].revision, 0);
  assert.equal(removed.deleted, true);
});

void test("matching titles and identities in separate projects remain distinct", () => {
  const shared = resource("same-id", { title: "Same title" });
  const local = [
    resource("different-id", { title: "Same title", local: true, revision: 0 }),
    resource("same-id", {
      title: "Same title",
      projectId: "another-project",
      local: true,
      revision: 0,
    }),
  ];
  const catalog = resourceCatalog([shared], local);
  assert.equal(catalog.length, 3);
  assert.equal(
    new Set(catalog.map((item) => `${item.projectId}:${item.resourceId}`)).size,
    3,
  );
});
