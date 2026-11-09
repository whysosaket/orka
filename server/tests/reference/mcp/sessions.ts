import type { Resource } from "@portable/protocol";
import type { Store } from "../store.js";
import { HttpError } from "../store.js";

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
const text = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(object)
    .filter((p) =>
      ["text", "input_text", "output_text", "Text"].includes(String(p.type)),
    )
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .join("\n");
};

export type SessionMessage = { role: "user" | "assistant"; text: string };
/** Readable conversation only. Analysis, tool payloads and injected setup are excluded. */
export function sessionMessages(records: RecordValue[]): SessionMessage[] {
  const candidates: { message: SessionMessage; tier: number; turn: number }[] =
    [];
  let turn = 0;
  for (const record of records) {
    const payload = object(record.payload);
    if (
      record.type === "session_meta" ||
      (record.type === "event_msg" &&
        ["task_started", "user_message"].includes(String(payload.type)))
    )
      turn++;
    let value: RecordValue,
      tier = 0;
    if (record.type === "response_item") value = payload;
    else if (record.type === "event_msg" && payload.type === "item_completed") {
      value = object(payload.item);
      tier = 1;
    } else if (
      record.type === "event_msg" &&
      ["user_message", "agent_message"].includes(String(payload.type))
    ) {
      value = payload;
      tier = 2;
    } else if (["user", "assistant"].includes(String(record.type)))
      value = object(record.message);
    else continue;
    if (
      record.isMeta === true ||
      value.channel === "analysis" ||
      (value.type === "agent_message" && typeof value.author === "string")
    )
      continue;
    const rawRole =
      value.role ??
      (["user", "assistant"].includes(String(record.type))
        ? record.type
        : value.type);
    const role = [
      "user",
      "user_message",
      "userMessage",
      "UserMessage",
    ].includes(String(rawRole))
      ? "user"
      : ["assistant", "agent_message", "agentMessage", "AgentMessage"].includes(
            String(rawRole),
          )
        ? "assistant"
        : undefined;
    if (!role) continue;
    let content = text(
      tier === 2 ? value.message : (value.content ?? value.text),
    );
    if (role === "user") {
      content = content.split("## My request:").at(-1) ?? content;
      content = content
        .replace(
          /<(environment_context|INSTRUCTIONS|user_instructions|system-reminder|local-command-caveat|in-app-browser-context|external_codex_apps_open_page)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g,
          "",
        )
        .trim();
      if (
        /^(# AGENTS\.md instructions|<environment_context|<local-command|<command-|<INSTRUCTIONS|<user_instructions|<turn_aborted|<task-notification|<external_codex_apps|This session is being continued|You are continuing a task)/.test(
          content,
        )
      )
        continue;
    }
    if (content.trim())
      candidates.push({ message: { role, text: content.trim() }, tier, turn });
  }
  const counts = new Map<string, number[]>(),
    seen = new Map<string, number[]>();
  const key = (c: (typeof candidates)[number]) =>
    JSON.stringify([c.turn, c.message.role, c.message.text]);
  for (const c of candidates) {
    const n = counts.get(key(c)) ?? [0, 0, 0];
    n[c.tier]++;
    counts.set(key(c), n);
  }
  return candidates
    .filter((c) => {
      const n = seen.get(key(c)) ?? [0, 0, 0];
      n[c.tier]++;
      seen.set(key(c), n);
      return !counts
        .get(key(c))!
        .slice(0, c.tier)
        .some((count) => count >= n[c.tier]);
    })
    .map((c) => c.message);
}

/** Resolve only the exact inherited prefix in a paginated Codex manifest. */
export async function readSession(
  store: Store,
  resource: Resource,
): Promise<SessionMessage[]> {
  if (resource.kind !== "session" || resource.deleted)
    throw new HttpError(404, "Session unavailable");
  if (resource.files.reduce((n, f) => n + f.size, 0) > 32_000_000)
    throw new HttpError(
      413,
      "Session exceeds the plugin's 32 MB reading limit. Open it in Orka.",
    );
  const files = new Map(resource.files.map((f) => [f.path, f]));
  const visited = new Set<string>();
  const load = async (
    path: string,
    expected?: { id: string; end: number; bytes: number },
  ): Promise<RecordValue[]> => {
    if (visited.has(path) || visited.size >= 100)
      throw new HttpError(422, "Invalid session lineage");
    visited.add(path);
    const file = files.get(path);
    if (!file)
      throw new HttpError(
        422,
        "Incomplete session lineage. Sync this session from its source device.",
      );
    const bytes = await store.blobs.read(resource.projectId, file.hash);
    if (
      bytes.length !== file.size ||
      (expected && bytes.length !== expected.bytes) ||
      bytes.at(-1) !== 10
    )
      throw new HttpError(422, "Invalid session boundary");
    let records: RecordValue[];
    try {
      records = new TextDecoder("utf-8", { fatal: true })
        .decode(bytes)
        .trimEnd()
        .split("\n")
        .filter(Boolean)
        .map((line) => object(JSON.parse(line)));
    } catch {
      throw new HttpError(
        422,
        "Cannot decode the session. Open the original in Orka.",
      );
    }
    if (resource.source === "claude") {
      const ids = new Set(records.map((r) => r.sessionId).filter(Boolean));
      if (ids.size > 1) throw new HttpError(422, "Mixed session identities");
      return records;
    }
    const meta = object(records[0]?.payload);
    if (records[0]?.type !== "session_meta" || typeof meta.id !== "string")
      throw new HttpError(422, "Unknown Codex session format");
    const mode = meta.history_mode;
    if (mode != null && mode !== "legacy" && mode !== "paginated")
      throw new HttpError(422, "Unsupported Codex history mode");
    if (expected && meta.id !== expected.id)
      throw new HttpError(422, "Session lineage identity changed");
    if (mode === "paginated") {
      const start = Number(
        object(meta.history_base).end_ordinal_exclusive ?? 0,
      );
      if (records.some((r, i) => r.ordinal !== start + i))
        throw new HttpError(422, "Invalid history ordinals");
      if (expected && start + records.length !== expected.end)
        throw new HttpError(422, "Session lineage boundary changed");
    } else if (expected || meta.history_base)
      throw new HttpError(422, "Invalid inherited history");
    const base = object(meta.history_base);
    if (!Object.keys(base).length) return records;
    if (
      typeof base.thread_id !== "string" ||
      !Number.isSafeInteger(base.end_ordinal_exclusive) ||
      !Number.isSafeInteger(base.end_byte_offset) ||
      Number(base.end_byte_offset) < 1 ||
      Number(base.end_ordinal_exclusive) < 1
    )
      throw new HttpError(422, "Invalid inherited boundary");
    const preferred = `lineage/${base.thread_id}/${base.end_ordinal_exclusive}.jsonl`;
    const parent = await load(
      files.has(preferred) ? preferred : `lineage/${base.thread_id}.jsonl`,
      {
        id: base.thread_id,
        end: Number(base.end_ordinal_exclusive),
        bytes: Number(base.end_byte_offset),
      },
    );
    return [...parent, ...records];
  };
  const records = await load("session.jsonl");
  if (visited.size !== files.size)
    throw new HttpError(422, "Session has unreferenced history files");
  return sessionMessages(records);
}
