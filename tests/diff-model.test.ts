import test from "node:test";
import assert from "node:assert/strict";
import {
  buildUnifiedDiff,
  changedFiles,
  diffRows,
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

await test("unified diffs count changes, number both sides, and collapse unchanged lines", () => {
  const before = lines(60);
  const after = before
    .replace("line 18\n", "line 18 changed\n")
    .replace("line 47\n", "line 47 changed\nline 47b\n");
  const diff = buildUnifiedDiff(before, after);
  assert.equal(diff.equal, false);
  assert.equal(diff.additions, 3);
  assert.equal(diff.deletions, 2);
  assert.equal(diff.ranges, "Lines 18, 47–48");
  // Leading, middle, and trailing unchanged regions collapse into gaps.
  const collapsed = diffRows(diff, before, new Set());
  const gaps = collapsed.filter((row) => row.type === "gap");
  assert.deepEqual(
    gaps.map((row) => (row.type === "gap" ? row.count : 0)),
    [14, 22, 10],
  );
  const removed = collapsed.find(
    (row) => row.type === "line" && row.line.kind === "removed",
  );
  assert.ok(removed?.type === "line" && removed.line.number === 18);
  const added = collapsed.filter(
    (row) => row.type === "line" && row.line.kind === "added",
  );
  assert.deepEqual(
    added.map((row) => (row.type === "line" ? row.line.number : 0)),
    [18, 47, 48],
  );
  // Expanding the middle gap reveals its lines with new-file numbers.
  const expanded = diffRows(diff, before, new Set([1]));
  const revealed = expanded.filter(
    (row) =>
      row.type === "line" &&
      row.key.startsWith("context-") &&
      row.key.includes("gap-1"),
  );
  assert.equal(revealed.length, 22);
  assert.ok(
    revealed[0].type === "line" &&
      revealed[0].line.number === 22 &&
      revealed[0].line.text === "line 22",
  );
});

await test("paired removed and added lines carry word-level emphasis", () => {
  const diff = buildUnifiedDiff(
    "- Review the issue report.\n",
    "- Read the issue report and confirm the root cause.\n",
  );
  const [hunk] = diff.blocks;
  assert.ok(hunk.type === "hunk");
  const removed = hunk.lines.find((line) => line.kind === "removed");
  const added = hunk.lines.find((line) => line.kind === "added");
  assert.ok(removed?.segments && added?.segments);
  assert.deepEqual(
    removed.segments.filter((s) => s.changed).map((s) => s.text),
    ["Review"],
  );
  assert.deepEqual(
    added.segments.filter((s) => s.changed).map((s) => s.text.trim()),
    ["Read", "and confirm the root cause"],
  );
  // Rewritten lines keep plain text instead of a wall of emphasis.
  const rewritten = buildUnifiedDiff(
    "alpha beta\n",
    "completely different words\n",
  );
  const block = rewritten.blocks[0];
  assert.ok(
    block.type === "hunk" && block.lines.every((line) => !line.segments),
  );
});

await test("review chunks use configured context and expand only interior gaps", () => {
  const before = lines(60);
  const after = before
    .replace("line 18\n", "line 18 changed\n")
    .replace("line 47\n", "line 47 changed\nline 47b\n");
  const diff = buildUnifiedDiff(before, after, 2);
  const collapsed = diffRows(diff, before, new Set(), true);
  assert.deepEqual(
    collapsed.filter((row) => row.type === "gap").map((row) => row.count),
    [24],
  );
  const first = collapsed[0];
  assert.ok(first.type === "line" && first.line.number === 16);
  const last = collapsed.at(-1);
  assert.ok(last?.type === "line" && last.line.number === 50);
  const expanded = diffRows(diff, before, new Set([1]), true);
  assert.equal(expanded.filter((row) => row.type === "gap").length, 0);
  assert.equal(expanded.length, collapsed.length + 23);
  assert.ok(
    expanded.some((row) => row.type === "line" && row.line.text === "line 21"),
  );
  assert.ok(
    !expanded.some((row) => row.type === "line" && row.line.text === "line 15"),
  );
  const script = buildUnifiedDiff(
    before,
    before.replace("line 13\n", "updated\n"),
    5,
  );
  const scriptRows = diffRows(script, before, new Set(), true);
  assert.ok(scriptRows[0].type === "line" && scriptRows[0].line.number === 8);
});

await test("equal content and whole-file changes are summarized per file", () => {
  assert.equal(buildUnifiedDiff("same\n", "same\n").equal, true);
  const changes = changedFiles(
    { "SKILL.md": "a\n", "scripts/run.sh": "x\n", "docs/old.md": "gone\n" },
    { "SKILL.md": "a\n", "scripts/run.sh": "y\n", "docs/new.md": "one\ntwo\n" },
  );
  assert.deepEqual(
    changes.map((change) => [
      change.path,
      change.status,
      change.additions,
      change.deletions,
      change.ranges,
    ]),
    [
      ["scripts/run.sh", "modified", 1, 1, "Line 1"],
      ["docs/old.md", "removed", 0, 1, ""],
      ["docs/new.md", "added", 2, 0, "Lines 1–2"],
    ],
  );
  assert.equal(
    changedFiles({ "SKILL.md": "a" }, { "SKILL.md": "a" }).length,
    0,
  );
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
    assert.equal(change.additions, 0);
    assert.equal(change.deletions, 0);
    assert.equal(change.ranges, "");
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
  assert.equal(changes[0].additions, 1);
  assert.equal(changes[0].deletions, 1);
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
