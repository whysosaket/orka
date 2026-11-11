import test from "node:test";
import assert from "node:assert/strict";
import {
  summarizeDiff,
  changedFiles,
  formatRanges,
  splitLines,
} from "../apps/mac/src/components/diff-model.js";
import { tokenizeMarkdown } from "../apps/mac/src/components/markdown-tokens.js";

const lines = (count: number, prefix = "line") =>
  Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`).join("\n") +
  "\n";

await test("ranges compress consecutive line numbers with an en dash", () => {
  assert.equal(formatRanges([18, 47, 48]), "Lines 18, 47–48");
  assert.equal(formatRanges([5]), "Line 5");
  assert.equal(formatRanges([]), "");
  assert.equal(formatRanges([3, 1, 2]), "Lines 1–3");
});

await test("split lines ignore a trailing newline and treat empty text as no lines", () => {
  assert.deepEqual(splitLines("a\nb\n"), ["a", "b"]);
  assert.deepEqual(splitLines("a\r\nb"), ["a", "b"]);
  assert.deepEqual(splitLines(""), []);
});

await test("diff headers count changes and summarize new-file line numbers", () => {
  const before = lines(60);
  const after = before
    .replace("line 18\n", "line 18 changed\n")
    .replace("line 47\n", "line 47 changed\nline 47b\n");
  assert.deepEqual(summarizeDiff(before, after), {
    additions: 3,
    deletions: 2,
    ranges: "Lines 18, 47–48",
  });
});

await test("deletion summaries point to surviving new-file lines", () => {
  assert.deepEqual(summarizeDiff("a\nb\nc\n", "b\nc\n"), {
    additions: 0,
    deletions: 1,
    ranges: "Line 1",
  });
  assert.deepEqual(summarizeDiff("a\nb\nc\n", "a\nc\n"), {
    additions: 0,
    deletions: 1,
    ranges: "Line 2",
  });
  assert.deepEqual(summarizeDiff("a\nb\nc\n", "a\nb\n"), {
    additions: 0,
    deletions: 1,
    ranges: "Line 2",
  });
  // An independent later insertion must not hide an earlier deletion's position.
  assert.deepEqual(summarizeDiff("a\nb\nc\nd\n", "a\nc\nd\ne\n"), {
    additions: 1,
    deletions: 1,
    ranges: "Lines 2, 4",
  });
});

await test("empty, whole-file, and newline-only changes retain honest counts", () => {
  assert.deepEqual(summarizeDiff("same\n", "same\n"), {
    additions: 0,
    deletions: 0,
    ranges: "",
  });
  assert.deepEqual(summarizeDiff("", "one\ntwo\n"), {
    additions: 2,
    deletions: 0,
    ranges: "Lines 1–2",
  });
  assert.deepEqual(summarizeDiff("one\ntwo\n", ""), {
    additions: 0,
    deletions: 2,
    ranges: "Line 1",
  });
  assert.deepEqual(summarizeDiff("same", "same\n"), {
    additions: 1,
    deletions: 1,
    ranges: "Line 1",
  });
});

await test("changed files omit equal content and preserve whole-file changes", () => {
  assert.deepEqual(
    changedFiles(
      { "SKILL.md": "a\n", "scripts/run.sh": "x\n", "docs/old.md": "gone\n" },
      {
        "SKILL.md": "a\n",
        "scripts/run.sh": "y\n",
        "docs/new.md": "one\ntwo\n",
      },
    ),
    [
      {
        path: "scripts/run.sh",
        status: "modified",
        before: "x\n",
        after: "y\n",
      },
      { path: "docs/old.md", status: "removed", before: "gone\n", after: "" },
      { path: "docs/new.md", status: "added", before: "", after: "one\ntwo\n" },
    ],
  );
  assert.deepEqual(changedFiles({ "SKILL.md": "a" }, { "SKILL.md": "a" }), []);
});

await test("review files follow manifest order with SKILL.md pinned first", () => {
  const before = {
    "references/check.md": "old",
    "scripts/run.sh": "old",
    "SKILL.md": "old",
  };
  const after = {
    "references/check.md": "new",
    "scripts/run.sh": "new",
    "SKILL.md": "new",
  };
  const order = ["scripts/run.sh", "SKILL.md", "references/check.md"];
  const changes = changedFiles(before, after, {
    beforeManifest: order.map((path) => ({
      path,
      hash: `old-${path}`,
      binary: false,
    })),
    afterManifest: order.map((path) => ({
      path,
      hash: `new-${path}`,
      binary: false,
    })),
  });
  assert.deepEqual(
    changes.map(({ path }) => path),
    ["SKILL.md", "scripts/run.sh", "references/check.md"],
  );
});

await test("markdown tinting marks frontmatter, headings, list markers, and code spans", () => {
  const tokens = tokenizeMarkdown(
    "---\nname: review\n---\n# Title\n- item with `code` and [link](https://x.test)\n```\n# not a heading\n```\n",
  );
  assert.deepEqual(tokens[0], [{ kind: "punct", text: "---" }]);
  assert.deepEqual(tokens[1], [
    { kind: "key", text: "name" },
    { kind: "punct", text: ":" },
    { kind: "string", text: " review" },
  ]);
  assert.deepEqual(tokens[3], [
    { kind: "punct", text: "#" },
    { kind: "text", text: " " },
    { kind: "heading", text: "Title" },
  ]);
  assert.deepEqual(
    tokens[4].map((token) => token.kind),
    [
      "punct",
      "text",
      "text",
      "punct",
      "string",
      "punct",
      "text",
      "punct",
      "text",
      "punct",
      "string",
      "punct",
    ],
  );
  assert.deepEqual(tokens[6], [{ kind: "text", text: "# not a heading" }]);
});

await test("binary changes use file identities and have no invented line counts", () => {
  const changes = changedFiles(
    {
      "assets/changed.pdf": "Binary asset",
      "assets/same.pdf": "Binary asset",
      "assets/removed.pdf": "Binary asset",
    },
    {
      "assets/changed.pdf": "Binary asset",
      "assets/same.pdf": "Binary asset",
      "assets/added.pdf": "Binary asset",
    },
    {
      beforeManifest: [
        { path: "assets/changed.pdf", hash: "old", binary: true },
        { path: "assets/same.pdf", hash: "same", binary: true },
        { path: "assets/removed.pdf", hash: "removed", binary: true },
      ],
      afterManifest: [
        { path: "assets/changed.pdf", hash: "new", binary: true },
        { path: "assets/same.pdf", hash: "same", binary: true },
        { path: "assets/added.pdf", hash: "added", binary: true },
      ],
    },
  );
  assert.deepEqual(
    changes.map((change) => [change.path, change.status]),
    [
      ["assets/changed.pdf", "modified"],
      ["assets/removed.pdf", "removed"],
      ["assets/added.pdf", "added"],
    ],
  );
  for (const change of changes) {
    assert.equal(change.binary, true);
    assert.ok(!("additions" in change) && !("deletions" in change));
    assert.equal(change.before + change.after, "");
  }
});

await test("unchanged binary inspection omissions do not look like outgoing additions", () => {
  const manifest = [{ path: "review.pdf", hash: "same", binary: true }];
  assert.deepEqual(
    changedFiles(
      {},
      { "review.pdf": "Binary asset" },
      { beforeManifest: manifest, afterManifest: manifest },
    ),
    [],
  );
});

await test("executable permission changes remain reviewable with identical bytes", () => {
  for (const binary of [false, true]) {
    for (const executable of [false, true]) {
      const files = {
        "scripts/run.sh": binary ? "Binary asset" : "echo ready\n",
      };
      const entry = { path: "scripts/run.sh", hash: "same", binary };
      const changes = changedFiles(files, files, {
        beforeManifest: [{ ...entry, executable: !executable }],
        afterManifest: [{ ...entry, executable }],
      });
      assert.equal(changes.length, 1);
      assert.equal(changes[0].status, "modified");
      assert.equal(
        changes[0].executableChange,
        executable ? "added" : "removed",
      );
      assert.deepEqual(summarizeDiff(changes[0].before, changes[0].after), {
        additions: 0,
        deletions: 0,
        ranges: "",
      });
      assert.deepEqual(
        changedFiles(files, files, {
          beforeManifest: [{ ...entry, executable }],
          afterManifest: [{ ...entry, executable }],
        }),
        [],
      );
    }
  }
});

await test("explicit text metadata distinguishes literal Binary asset text", () => {
  const changes = changedFiles(
    { "notes.txt": "Binary asset" },
    { "notes.txt": "New text" },
    {
      beforeManifest: [{ path: "notes.txt", hash: "old", binary: false }],
      afterManifest: [{ path: "notes.txt", hash: "new", binary: false }],
    },
  );
  assert.equal(changes[0].binary, undefined);
  assert.deepEqual(summarizeDiff(changes[0].before, changes[0].after), {
    additions: 1,
    deletions: 1,
    ranges: "Line 1",
  });
});

await test("legacy binary placeholders remain reviewable instead of claiming up to date", () => {
  const changes = changedFiles(
    { "review.pdf": "Binary asset" },
    { "review.pdf": "Binary asset" },
  );
  assert.equal(changes.length, 1);
  assert.equal(changes[0].binary, true);
  assert.equal(changes[0].comparisonUnavailable, true);
});
