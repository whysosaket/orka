import {
  diffText,
  textLines,
  type MemoryChoice,
  type MemoryResolution,
  type TextEdit,
} from "@portable/protocol";

export type MemoryConflict = {
  startLine: number;
  endLine: number;
  base: string;
  current: string;
  incoming: string;
};
export type MemoryContext = {
  logicalPath: string;
  title: string;
  source: string;
  baseRevision: number;
  currentRevision: number;
  currentAuthor?: string;
  incomingAuthor: string;
};
export type MemoryState = {
  context: MemoryContext;
  base: string;
  current: string;
  incoming: string;
  conflicts: MemoryConflict[];
};
export type MemoryAnswer = Pick<
  MemoryResolution,
  "model" | "choice" | "confidence" | "probabilities"
>;
export interface MemoryResolver {
  resolve(state: MemoryState): Promise<MemoryAnswer[]>;
}
export class MemoryUnavailable extends Error {
  constructor(code: string) {
    super(`Memory consolidation pending: ${code}`);
  }
}

type TaggedEdit = TextEdit & { side: "current" | "incoming" };
type Part = MemoryConflict & { text?: string };

function overlaps(a: TextEdit, b: TextEdit): boolean {
  if (a.start === a.end && b.start === b.end) return a.start === b.start;
  if (a.start === a.end) return a.start > b.start && a.start < b.end;
  if (b.start === b.end) return b.start > a.start && b.start < a.end;
  return a.start < b.end && b.start < a.end;
}

function apply(
  original: string[],
  start: number,
  end: number,
  changes: TextEdit[],
): string {
  let result = "",
    position = start;
  for (const edit of changes.sort(
    (a, b) => a.start - b.start || a.end - b.end,
  )) {
    result +=
      original.slice(position, edit.start).join("") + edit.lines.join("");
    position = edit.end;
  }
  return result + original.slice(position, end).join("");
}

function both(current: string, incoming: string): string {
  if (!current) return incoming;
  if (!incoming || current === incoming) return current;
  return current + (current.endsWith("\n") ? "" : "\n") + incoming;
}

function plan(base: string, current: string, incoming: string): Part[] {
  const original = textLines(base);
  const pending: TaggedEdit[] = [
    ...diffText(base, current).map((e) => ({ ...e, side: "current" as const })),
    ...diffText(base, incoming).map((e) => ({
      ...e,
      side: "incoming" as const,
    })),
  ].sort((a, b) => a.start - b.start || a.end - b.end);
  const parts: Part[] = [];
  while (pending.length) {
    const group = [pending.shift()!];
    // Take the transitive overlap closure, including edits spanning several hunks.
    for (let i = 0; i < pending.length;) {
      if (group.some((e) => overlaps(e, pending[i]))) {
        group.push(...pending.splice(i, 1));
        i = 0;
      } else i++;
    }
    const start = Math.min(...group.map((e) => e.start));
    const end = Math.max(...group.map((e) => e.end));
    const accepted = group.filter((e) => e.side === "current");
    const proposed = group.filter((e) => e.side === "incoming");
    const part: Part = {
      startLine: start + 1,
      endLine: end + 1,
      base: original.slice(start, end).join(""),
      current: apply(original, start, end, accepted),
      incoming: apply(original, start, end, proposed),
    };
    if (!proposed.length || part.current === part.incoming)
      part.text = part.current;
    else if (group.every((e) => e.start === e.end))
      part.text = both(part.current, part.incoming);
    else if (
      !proposed.some((e) => e.end > e.start && e.lines.length) &&
      (!accepted.length || group.every((e) => !e.lines.length))
    )
      part.text = part.incoming;
    const previous = parts.at(-1);
    if (
      part.text === undefined &&
      previous &&
      previous.text === undefined &&
      previous.endLine === part.startLine
    ) {
      previous.endLine = part.endLine;
      previous.base += part.base;
      previous.current += part.current;
      previous.incoming += part.incoming;
    } else parts.push(part);
  }
  return parts;
}

export async function consolidateMemory(
  base: string,
  current: string,
  incoming: string,
  context: MemoryContext,
  resolver: MemoryResolver,
): Promise<{ text: string; resolutions: MemoryResolution[] }> {
  if (incoming === base || incoming === current)
    return { text: current, resolutions: [] };
  const parts = plan(base, current, incoming);
  const conflicts = parts.filter((p) => p.text === undefined);
  const answers = conflicts.length
    ? await resolver.resolve({ context, base, current, incoming, conflicts })
    : [];
  if (answers.length !== conflicts.length)
    throw new MemoryUnavailable("invalid_answers");
  const resolutions: MemoryResolution[] = [];
  let answerIndex = 0,
    position = 0,
    text = "";
  const original = textLines(base);
  for (const part of parts) {
    let resolved = part.text;
    if (resolved === undefined) {
      const answer = answers[answerIndex++];
      const choices: Record<MemoryChoice, string> = {
        keep_current: part.current,
        accept_incoming: part.incoming,
        keep_both: both(part.current, part.incoming),
      };
      resolved = choices[answer.choice];
      resolutions.push({
        path: context.logicalPath,
        startLine: part.startLine,
        endLine: part.endLine,
        ...answer,
      });
    }
    text += original.slice(position, part.startLine - 1).join("") + resolved;
    position = part.endLine - 1;
  }
  return { text: text + original.slice(position).join(""), resolutions };
}
