import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Resource } from "@portable/protocol";
import type { Inspection } from "../types.js";

export type SkillSummary = { name: string; description: string };
export type SkillSummaries = Record<string, SkillSummary | null>;
export const skillSummaryKey = (skill: Resource) =>
  `${skill.projectId}:${skill.resourceId}:${skill.revision}:${skill.files.find((file) => file.path === "SKILL.md")?.hash ?? ""}`;
// Home and Skills can read the same revision. Share completed and pending reads,
// but include the account/service/profile scope in every key. The 500-entry
// bound below applies across scopes, not separately to each mounted reader.
const cache = new Map<string, SkillSummary | null>();
const pending = new Map<string, Promise<SkillSummary | null>>();
const cacheKey = (scope: string, key: string) => JSON.stringify([scope, key]);

function loadSummary(id: string, key: string): Promise<SkillSummary | null> {
  if (cache.has(key)) return Promise.resolve(cache.get(key)!);
  if (pending.has(key)) return pending.get(key)!;
  const request = invoke<Inspection>("inspect_resource", {
    id,
    file: "SKILL.md",
    conflictId: null,
  })
    .then(async (value) => {
      if (value.content === null) return null;
      const { readSkillMarkdown } = await import("./skill-markdown.js");
      const { name, description } = readSkillMarkdown(value.content);
      return { name, description };
    })
    .catch(() => null)
    .then((summary) => {
      // Unreadable revisions keep their fallback title until the file changes.
      cache.set(key, summary);
      if (cache.size > 500) cache.delete(cache.keys().next().value!);
      return summary;
    })
    .finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
}

/** Resolve the entire collection before search and sorting, with bounded reads. */
export function useSkillSummaries(
  resources: Resource[],
  scope: string,
): SkillSummaries {
  const manifest = JSON.stringify(
    resources
      .filter((resource) => resource.kind === "skill")
      .map((skill) => ({
        id: skill.resourceId,
        key: skillSummaryKey(skill),
      })),
  );
  const [result, setResult] = useState<{
    scope: string;
    summaries: SkillSummaries;
  }>(() => ({ scope, summaries: {} }));
  useEffect(() => {
    const items: { id: string; key: string }[] = JSON.parse(manifest);
    let cancelled = false;
    let index = 0;
    setResult({
      scope,
      summaries: Object.fromEntries(
        items
          .filter(({ key }) => cache.has(cacheKey(scope, key)))
          .map(({ key }) => [key, cache.get(cacheKey(scope, key))!]),
      ),
    });
    async function worker() {
      while (!cancelled && index < items.length) {
        const item = items[index++];
        const summary = await loadSummary(item.id, cacheKey(scope, item.key));
        if (!cancelled)
          setResult((current) => ({
            scope,
            summaries: {
              ...(current.scope === scope ? current.summaries : {}),
              [item.key]: summary,
            },
          }));
      }
    }
    void Promise.all(Array.from({ length: 4 }, () => worker()));
    return () => {
      cancelled = true;
    };
  }, [manifest, scope]);
  return result.scope === scope ? result.summaries : {};
}
