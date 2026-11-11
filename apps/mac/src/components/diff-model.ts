import { diffWordsWithSpace, structuredPatch } from "diff";

export type DiffLineKind = "context" | "removed" | "added";

export interface DiffSegment {
  text: string;
  /** Part of a word-level change inside a modified line pair. */
  changed: boolean;
}

export interface DiffLine {
  kind: DiffLineKind;
  /** The old-file number for removed lines, the new-file number otherwise. */
  number: number;
  text: string;
  segments?: DiffSegment[];
}

export type DiffRow =
  | { type: "line"; key: string; line: DiffLine }
  | { type: "gap"; key: string; index: number; count: number };

interface GapBlock {
  type: "gap";
  index: number;
  /** First unchanged old-file line (1-based) and its new-file number. */
  start: number;
  newStart: number;
  count: number;
}
interface HunkBlock {
  type: "hunk";
  lines: DiffLine[];
}

export interface UnifiedDiff {
  additions: number;
  deletions: number;
  /** "Lines 18, 47–48" style summary in new-file numbering; empty when equal. */
  ranges: string;
  /** Collapsed unchanged regions; expand them by index with diffRows. */
  gaps: number;
  equal: boolean;
  blocks: (GapBlock | HunkBlock)[];
}

/** Lines without a phantom entry after a trailing newline; empty text has none. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  return text.replace(/\r?\n$/, "").split(/\r\n|\n/);
}

export function formatRanges(numbers: number[]): string {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  if (sorted.length === 0) return "";
  const parts: string[] = [];
  let start = sorted[0];
  let end = sorted[0];
  for (const number of sorted.slice(1)) {
    if (number === end + 1) {
      end = number;
      continue;
    }
    parts.push(start === end ? `${start}` : `${start}–${end}`);
    start = number;
    end = number;
  }
  parts.push(start === end ? `${start}` : `${start}–${end}`);
  const single = parts.length === 1 && start === end;
  return `${single ? "Line" : "Lines"} ${parts.join(", ")}`;
}

/** Word-level emphasis for consecutive removed/added runs with shared words. */
function pairWords(lines: DiffLine[]) {
  let i = 0;
  while (i < lines.length) {
    if (lines[i].kind !== "removed") {
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && lines[j].kind === "removed") j++;
    let k = j;
    while (k < lines.length && lines[k].kind === "added") k++;
    const pairs = Math.min(j - i, k - j);
    for (let n = 0; n < pairs; n++) {
      const removed = lines[i + n];
      const added = lines[j + n];
      const parts = diffWordsWithSpace(removed.text, added.text);
      const shared = parts
        .filter((part) => !part.added && !part.removed)
        .reduce((sum, part) => sum + part.value.trim().length, 0);
      const longest = Math.max(removed.text.length, added.text.length, 1);
      if (shared / longest < 0.3) continue;
      removed.segments = parts
        .filter((part) => !part.added)
        .map((part) => ({ text: part.value, changed: Boolean(part.removed) }));
      added.segments = parts
        .filter((part) => !part.removed)
        .map((part) => ({ text: part.value, changed: Boolean(part.added) }));
    }
    i = k;
  }
}

/** A unified line diff with configurable context and collapsible gaps. */
export function buildUnifiedDiff(
  oldText: string,
  newText: string,
  context = 3,
): UnifiedDiff {
  if (oldText === newText)
    return {
      additions: 0,
      deletions: 0,
      ranges: "",
      gaps: 0,
      equal: true,
      blocks: [],
    };
  const patch = structuredPatch("a", "b", oldText, newText, "", "", {
    context,
  });
  const oldLines = splitLines(oldText);
  const blocks: (GapBlock | HunkBlock)[] = [];
  const changed: number[] = [];
  let additions = 0;
  let deletions = 0;
  let cursor = 1;
  let offset = 0;
  let gaps = 0;
  for (const hunk of patch.hunks) {
    if (hunk.oldStart > cursor && hunk.oldLines > 0)
      blocks.push({
        type: "gap",
        index: gaps++,
        start: cursor,
        newStart: cursor + offset,
        count: hunk.oldStart - cursor,
      });
    const lines: DiffLine[] = [];
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const raw of hunk.lines) {
      const marker = raw[0];
      const text = raw.slice(1);
      if (marker === " ") {
        lines.push({ kind: "context", number: newLine, text });
        oldLine++;
        newLine++;
      } else if (marker === "-") {
        lines.push({ kind: "removed", number: oldLine, text });
        oldLine++;
        deletions++;
      } else if (marker === "+") {
        lines.push({ kind: "added", number: newLine, text });
        changed.push(newLine);
        newLine++;
        additions++;
      }
    }
    pairWords(lines);
    // Removed lines without an added counterpart mark the new-file position.
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.kind !== "removed" || line.segments) continue;
      const paired = lines
        .slice(i + 1)
        .find((next) => next.kind === "added" && !next.segments);
      if (!paired) {
        const position = lines
          .slice(i + 1)
          .find((next) => next.kind !== "removed");
        changed.push(
          position
            ? position.number
            : Math.max(1, hunk.newStart + hunk.newLines - 1),
        );
      }
    }
    blocks.push({ type: "hunk", lines });
    cursor = hunk.oldStart + Math.max(hunk.oldLines, 0);
    offset += hunk.newLines - hunk.oldLines;
  }
  if (cursor <= oldLines.length)
    blocks.push({
      type: "gap",
      index: gaps++,
      start: cursor,
      newStart: cursor + offset,
      count: oldLines.length - cursor + 1,
    });
  return {
    additions,
    deletions,
    ranges: formatRanges(changed),
    gaps,
    equal: false,
    blocks,
  };
}

/** Rows for rendering; expanded gaps reveal their unchanged lines as context. */
export function diffRows(
  diff: UnifiedDiff,
  oldText: string,
  expanded: ReadonlySet<number>,
  /** Review cards show chunks; the source reader exposes the whole file. */
  omitEdgeGaps = false,
): DiffRow[] {
  const oldLines = splitLines(oldText);
  const rows: DiffRow[] = [];
  for (const [blockIndex, block] of diff.blocks.entries()) {
    if (block.type === "hunk") {
      block.lines.forEach((line, i) =>
        rows.push({
          type: "line",
          key: `${line.kind}-${line.number}-${rows.length}-${i}`,
          line,
        }),
      );
      continue;
    }
    if (
      omitEdgeGaps &&
      (blockIndex === 0 || blockIndex === diff.blocks.length - 1)
    )
      continue;
    if (!expanded.has(block.index)) {
      rows.push({
        type: "gap",
        key: `gap-${block.index}`,
        index: block.index,
        count: block.count,
      });
      continue;
    }
    for (let i = 0; i < block.count; i++)
      rows.push({
        type: "line",
        key: `context-${block.newStart + i}-gap-${block.index}`,
        line: {
          kind: "context",
          number: block.newStart + i,
          text: oldLines[block.start - 1 + i] ?? "",
        },
      });
  }
  return rows;
}

export type FileChangeStatus = "modified" | "added" | "removed";

export interface FileChange {
  path: string;
  status: FileChangeStatus;
  before: string;
  after: string;
  additions: number;
  deletions: number;
  ranges: string;
  /** Binary changes use manifest hashes when the native preview provides them. */
  binary?: boolean;
  /** Older native previews do not include enough data to compare binary bytes. */
  comparisonUnavailable?: boolean;
}

export interface FileManifestEntry {
  path: string;
  hash: string;
  /** Explicit encoding information avoids treating literal text as a sentinel. */
  binary?: boolean;
}

export interface FileComparisonMetadata {
  beforeManifest?: readonly FileManifestEntry[];
  afterManifest?: readonly FileManifestEntry[];
}

const pathOrder = (a: string, b: string) =>
  Number(b === "SKILL.md") - Number(a === "SKILL.md");

/** Changed files in manifest/input order, SKILL.md first; unchanged files are omitted. */
export function changedFiles(
  before: Record<string, string>,
  after: Record<string, string>,
  metadata: FileComparisonMetadata = {},
): FileChange[] {
  const oldManifest = metadata.beforeManifest
    ? new Map(metadata.beforeManifest.map((file) => [file.path, file]))
    : null;
  const newManifest = metadata.afterManifest
    ? new Map(metadata.afterManifest.map((file) => [file.path, file]))
    : null;
  const paths = [
    ...new Set([
      ...(oldManifest ? oldManifest.keys() : Object.keys(before)),
      ...(newManifest ? newManifest.keys() : Object.keys(after)),
    ]),
  ];
  const changes: FileChange[] = [];
  for (const path of paths.sort(pathOrder)) {
    const previous = before[path];
    const next = after[path];
    const previousFile = oldManifest?.get(path);
    const nextFile = newManifest?.get(path);
    const hadFile = oldManifest
      ? oldManifest.has(path)
      : previous !== undefined;
    const hasFile = newManifest ? newManifest.has(path) : next !== undefined;
    const hasIdentities = Boolean(oldManifest && newManifest);
    if (previousFile && nextFile && previousFile.hash === nextFile.hash)
      continue;
    const binary =
      previousFile?.binary === true ||
      nextFile?.binary === true ||
      (previousFile?.binary !== false && previous === "Binary asset") ||
      (nextFile?.binary !== false && next === "Binary asset") ||
      (hadFile && previous === undefined) ||
      (hasFile && next === undefined);
    if (binary) {
      changes.push({
        path,
        status: !hadFile ? "added" : !hasFile ? "removed" : "modified",
        before: "",
        after: "",
        additions: 0,
        deletions: 0,
        ranges: "",
        binary: true,
        comparisonUnavailable: !hasIdentities && hadFile && hasFile,
      });
      continue;
    }
    if (previous === next) continue;
    if (previous === undefined) {
      const lines = splitLines(next ?? "").length;
      changes.push({
        path,
        status: "added",
        before: "",
        after: next ?? "",
        additions: lines,
        deletions: 0,
        ranges: lines
          ? formatRanges(Array.from({ length: lines }, (_, i) => i + 1))
          : "",
      });
      continue;
    }
    if (next === undefined) {
      changes.push({
        path,
        status: "removed",
        before: previous,
        after: "",
        additions: 0,
        deletions: splitLines(previous).length,
        ranges: "",
      });
      continue;
    }
    const diff = buildUnifiedDiff(previous, next);
    changes.push({
      path,
      status: "modified",
      before: previous,
      after: next,
      additions: diff.additions,
      deletions: diff.deletions,
      ranges: diff.ranges,
    });
  }
  return changes;
}
