import { diffLines } from "diff";

export interface DiffSummary {
  additions: number;
  deletions: number;
  /** "Lines 18, 47–48" style summary in new-file numbering; empty when equal. */
  ranges: string;
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

/** Header metadata only. Pierre owns diff rows, word emphasis, and expansion. */
export function summarizeDiff(oldText: string, newText: string): DiffSummary {
  const parts = diffLines(oldText, newText);
  const changed: number[] = [];
  const lastLine = Math.max(1, splitLines(newText).length);
  let line = 1;
  let additions = 0;
  let deletions = 0;
  for (const [index, part] of parts.entries()) {
    const count = part.count ?? 0;
    if (part.removed) {
      deletions += count;
      // A replacement is located by its added lines. A deletion alone points
      // to the next surviving line, or the last line when it removes the tail.
      if (!parts[index + 1]?.added) changed.push(Math.min(line, lastLine));
    } else {
      if (part.added) {
        additions += count;
        for (let offset = 0; offset < count; offset++)
          changed.push(line + offset);
      }
      line += count;
    }
  }
  return { additions, deletions, ranges: formatRanges(changed) };
}

export type FileChangeStatus = "modified" | "added" | "removed";

export interface FileChange {
  path: string;
  status: FileChangeStatus;
  before: string;
  after: string;
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
        binary: true,
        comparisonUnavailable: !hasIdentities && hadFile && hasFile,
      });
      continue;
    }
    if (previous === next) continue;
    changes.push({
      path,
      status: !hadFile ? "added" : !hasFile ? "removed" : "modified",
      before: previous ?? "",
      after: next ?? "",
    });
  }
  return changes;
}
