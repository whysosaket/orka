import { z } from "zod";
import { diffArrays } from "diff";
import { isEnvPath } from "./env.js";
import { memoryMetadata } from "./governance.js";
export * from "./env.js";
export * from "./governance.js";
export * from "./sources.js";
export * from "./repositories.js";
export * from "./role-policies.js";

export const VERSION = 2 as const;
export const uuid = z.uuid();
export const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const relativePath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !p.includes("\\") &&
      // eslint-disable-next-line no-control-regex -- Reject control characters in untrusted paths.
      !/[\u0000-\u001f\u007f]/.test(p) &&
      p.split("/").every((s) => s !== "" && s !== "." && s !== ".."),
    "Unsafe relative path",
  );
export const file = z
  .object({
    path: relativePath,
    hash: digest,
    size: z
      .number()
      .int()
      .min(0)
      .max(128 * 1024 * 1024),
    executable: z.boolean(),
  })
  .strict();
export const resourceInput = z
  .object({
    resourceId: uuid,
    sourceId: uuid.optional(),
    kind: z.enum(["memory", "skill", "session", "plan"]),
    source: z.enum(["shared", "claude", "codex"]),
    logicalPath: relativePath,
    title: z.string().min(1).max(256),
    files: z.array(file).max(200),
    deleted: z.boolean(),
    memory: memoryMetadata.optional(),
    contextSources: z.array(z.uuid()).max(100).optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.kind === "skill" && r.files.some((f) => isEnvPath(f.path)))
      ctx.addIssue({
        code: "custom",
        message: "ENV files must use encrypted ENV sets",
      });
    if (new Set(r.files.map((f) => f.path)).size !== r.files.length)
      ctx.addIssue({ code: "custom", message: "Duplicate file path" });
    const size = r.files.reduce((n, f) => n + f.size, 0);
    if ((!r.deleted && !r.files.length) || (r.deleted && r.files.length))
      ctx.addIssue({ code: "custom", message: "Invalid deletion manifest" });
    if (
      r.kind === "skill" &&
      !r.deleted &&
      (!r.files.some((f) => f.path === "SKILL.md") ||
        size > 4_000_000 ||
        r.files.some((f) => f.size > 1_000_000))
    )
      ctx.addIssue({
        code: "custom",
        message: "Invalid skill package or size",
      });
    if (
      r.kind === "skill" &&
      (r.logicalPath.includes("/") ||
        r.logicalPath.startsWith(".") ||
        r.logicalPath.length > 128)
    )
      ctx.addIssue({ code: "custom", message: "Invalid skill folder name" });
    if (
      r.kind === "memory" &&
      ((!r.deleted &&
        (r.files.length !== 1 || r.files[0].path !== "content.md")) ||
        (r.source === "shared" &&
          !/^knowledge\/[0-9a-f-]{36}\.md$/.test(r.logicalPath) &&
          (!r.logicalPath.startsWith("instructions/") ||
            !["AGENTS.md", "AGENTS.override.md", "CLAUDE.md"].includes(
              r.logicalPath.split("/").at(-1)!,
            ) ||
            r.logicalPath
              .split("/")
              .some((p) => [".git", ".orka"].includes(p)))) ||
        (r.source === "claude" && !r.logicalPath.startsWith("claude/")) ||
        (r.source === "codex" && !r.logicalPath.startsWith("codex/")))
    )
      ctx.addIssue({ code: "custom", message: "Invalid memory resource" });
    if (
      r.memory &&
      (r.kind !== "memory" || !r.logicalPath.startsWith("knowledge/"))
    )
      ctx.addIssue({
        code: "custom",
        message: "Metadata requires a curated knowledge entry",
      });
    if (
      r.kind === "memory" &&
      r.logicalPath.startsWith("knowledge/") &&
      (r.source !== "shared" ||
        !r.memory ||
        r.logicalPath !== `knowledge/${r.resourceId}.md`)
    )
      ctx.addIssue({
        code: "custom",
        message: "Invalid curated knowledge identity",
      });
    if (r.kind === "memory" && size > 1_000_000)
      ctx.addIssue({ code: "custom", message: "Memory exceeds 1 MB" });
    if (
      r.kind === "plan" &&
      (r.source === "shared" ||
        !r.logicalPath.startsWith(`${r.source}/`) ||
        !/\.md$/i.test(r.logicalPath) ||
        size > 1_000_000 ||
        (!r.deleted &&
          (r.files.length !== 1 ||
            r.files[0].path !== "content.md" ||
            r.files[0].executable)))
    )
      ctx.addIssue({ code: "custom", message: "Invalid plan resource" });
    if (
      r.kind === "session" &&
      (r.source === "shared" ||
        (!r.deleted && !r.files.some((f) => f.path === "session.jsonl")) ||
        size > 256 * 1024 * 1024)
    )
      ctx.addIssue({ code: "custom", message: "Invalid session bundle" });
  });
export const change = z
  .object({
    version: z.literal(VERSION),
    id: uuid,
    projectId: uuid,
    deviceId: uuid,
    baseRevision: z.number().int().nonnegative(),
    resource: resourceInput,
  })
  .strict();
export type FileEntry = z.infer<typeof file>;
export type ResourceInput = z.infer<typeof resourceInput>;
export type Change = z.infer<typeof change>;
export type Resource = ResourceInput & {
  access?: import("./governance.js").EffectiveAccess;
  hash: string;
  projectId: string;
  revision: number;
  owner: string;
  updatedBy: string;
  updatedAt: string;
};
export type SessionConflict = {
  id: string;
  resourceId: string;
  author: string;
  deviceId: string;
  candidate: Resource;
  revision: number;
};
export type Activity = {
  id: string;
  type: "session_copied";
  resourceId: string;
  copyId: string;
  author: string;
  notifyOwner: string;
};
export type Event = {
  revision: number;
  resource: Resource;
  conflicts: SessionConflict[];
  activity: Activity | null;
  related?: { resource: Resource; conflicts: SessionConflict[] }[];
  memoryResolutions?: MemoryResolution[];
};
export type MemoryChoice = "keep_current" | "accept_incoming" | "keep_both";
export type MemoryResolution = {
  path: string;
  startLine: number;
  endLine: number;
  model: string;
  choice: MemoryChoice;
  confidence: number;
  probabilities: Record<MemoryChoice, number>;
};
export type Receipt = { event: Event; conflict: boolean };
export const resolution = z
  .object({
    version: z.literal(VERSION),
    id: uuid,
    projectId: uuid,
    deviceId: uuid,
    resourceId: uuid,
    expectedRevision: z.number().int().positive(),
    conflictId: uuid,
    action: z.enum(["keep", "override", "copy"]),
    selected: z.enum(["current", "candidate"]),
  })
  .strict();
export const sessionCopy = z
  .object({
    version: z.literal(VERSION),
    id: uuid,
    projectId: uuid,
    deviceId: uuid,
    resourceId: uuid,
    expectedRevision: z.number().int().positive(),
  })
  .strict();
export type Resolution = z.infer<typeof resolution>;
export type SessionCopy = z.infer<typeof sessionCopy>;

export type TextEdit = { start: number; end: number; lines: string[] };
export function textLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}
function edits(base: string[], next: string[]): TextEdit[] {
  const result: TextEdit[] = [];
  let position = 0;
  const parts = diffArrays(base, next);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part.added && !part.removed) {
      position += part.value.length;
      continue;
    }
    const start = position;
    let end = start;
    let added: string[] = [];
    if (part.removed) {
      end += part.value.length;
      position = end;
      if (parts[i + 1]?.added) added = parts[++i].value;
    } else added = part.value;
    if (end > start) {
      const replaced = Math.min(end - start, added.length);
      for (let j = start; j < end; j++)
        result.push({
          start: j,
          end: j + 1,
          lines: j - start < replaced ? [added[j - start]] : [],
        });
      if (added.length > replaced)
        result.push({ start: end, end, lines: added.slice(replaced) });
    } else result.push({ start, end, lines: added });
  }
  return result;
}
export function diffText(base: string, next: string): TextEdit[] {
  return edits(textLines(base), textLines(next));
}
function overlap(a: TextEdit, b: TextEdit): boolean {
  if (a.start === a.end && b.start === b.end) return a.start === b.start;
  if (a.start === a.end) return a.start >= b.start && a.start < b.end;
  if (b.start === b.end) return b.start >= a.start && b.start < a.end;
  return a.start < b.end && b.start < a.end;
}
// The incoming operation is later in the server's serialized acceptance order.
export function mergeText(
  base: string,
  current: string,
  incoming: string,
): string {
  if (incoming === base) return current;
  if (current === base || current === incoming) return incoming;
  const original = textLines(base),
    latest = edits(original, textLines(incoming));
  const merged = [
    ...edits(original, textLines(current)).filter(
      (e) => !latest.some((n) => overlap(e, n)),
    ),
    ...latest,
  ].sort((a, b) => a.start - b.start || a.end - b.end);
  let result = "",
    position = 0;
  for (const e of merged) {
    result += original.slice(position, e.start).join("") + e.lines.join("");
    position = e.end;
  }
  return result + original.slice(position).join("");
}
