import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mergeText, resourceInput, relativePath } from "@portable/protocol";
await test("plans require a provider path and one bounded non-executable Markdown file", () => {
  for (const source of ["codex", "claude"]) {
    const plan = {
      resourceId: randomUUID(),
      kind: "plan",
      source,
      logicalPath: `${source}/files/feature.md`,
      title: "Feature plan",
      files: [
        {
          path: "content.md",
          hash: "a".repeat(64),
          size: 100,
          executable: false,
        },
      ],
      deleted: false,
    };
    assert.equal(resourceInput.safeParse(plan).success, true);
    assert.equal(
      resourceInput.safeParse({ ...plan, files: [], deleted: true }).success,
      true,
    );
    for (const override of [
      { source: "shared" },
      { logicalPath: "other/feature.md" },
      { logicalPath: `${source}/files/feature.json` },
      { logicalPath: `${source}/files/../secret.md` },
      { files: [...plan.files, ...plan.files] },
      { files: [{ ...plan.files[0], path: "other.md" }] },
      { files: [{ ...plan.files[0], executable: true }] },
      { files: [{ ...plan.files[0], size: 1_000_001 }] },
    ])
      assert.equal(
        resourceInput.safeParse({ ...plan, ...override }).success,
        false,
      );
  }
});
await test("three-way line merging preserves independent additions, deletions, and replacements", () => {
  assert.equal(mergeText("a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n"), "A\nb\nC\n");
  assert.equal(mergeText("a\nb\nc\n", "a\nc\n", "a\nb\nc\nd\n"), "a\nc\nd\n");
  assert.equal(mergeText("a\nb\nc\n", "A\nB\nc\n", "a\nb\nC\n"), "A\nB\nC\n");
  assert.equal(
    mergeText("a\nb\nc\n", "A\nextra\nc\n", "a\nb\nC\n"),
    "A\nextra\nC\n",
  );
  assert.equal(mergeText("", "first\n", "later\n"), "later\n");
});
await test("overlapping edits use server acceptance order and preserve unrelated lines", () => {
  assert.equal(
    mergeText("a\nb\nc\n", "first\nB\nc\n", "later\nb\nc\n"),
    "later\nB\nc\n",
  );
  assert.equal(mergeText("a\nb\nc\n", "a\nB\nc\n", "a\nc\n"), "a\nc\n");
  assert.equal(mergeText("a\nb\nc\n", "a\nc\n", "a\nB\nc\n"), "a\nB\nc\n");
  assert.equal(
    mergeText("a\nb\n", "a\nfirst\nb\n", "a\nlater\nb\n"),
    "a\nlater\nb\n",
  );
  assert.equal(
    mergeText("a\nb\nc\n", "X\nY\nZ\nnew\n", "a\nB\nc\n"),
    "X\nB\nZ\nnew\n",
  );
});
await test("protocol rejects unsafe and ambiguous packages", () => {
  for (const path of ["../x", "a/../x", "/x", "a\\x", "a//x", "a/./x"])
    assert.equal(relativePath.safeParse(path).success, false);
  const file = {
    path: "SKILL.md",
    hash: "a".repeat(64),
    size: 10,
    executable: false,
  };
  const resource = {
    resourceId: randomUUID(),
    kind: "skill",
    source: "shared",
    logicalPath: "test",
    title: "test",
    files: [file],
    deleted: false,
  };
  assert.equal(resourceInput.safeParse(resource).success, true);
  assert.equal(
    resourceInput.safeParse({ ...resource, files: [file, file] }).success,
    false,
  );
  assert.equal(
    resourceInput.safeParse({ ...resource, deleted: true }).success,
    false,
  );
  assert.equal(
    resourceInput.safeParse({
      ...resource,
      kind: "memory",
      logicalPath: "instructions/.git/config",
      files: [{ ...file, path: "content.md" }],
    }).success,
    false,
  );
});
