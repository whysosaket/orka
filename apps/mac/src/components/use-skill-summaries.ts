import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Resource } from "@portable/protocol";
import type { Inspection } from "../types.js";

export type SkillSummary = { name: string; description: string };
export type SkillSummaries = Record<string, SkillSummary | null>;
export const skillSummaryKey = (skill: Resource) =>
  `${skill.projectId}:${skill.resourceId}:${skill.revision}:${skill.files.find((file) => file.path === "SKILL.md")?.hash ?? ""}`;
type SummaryCache = {
  scope: string;
  values: Map<string, SkillSummary | null>;
  pending: Map<string, Promise<SkillSummary | null>>;
};

function loadSummary(
  id: string,
  key: string,
  store: SummaryCache,
): Promise<SkillSummary | null> {
  const { values: cache, pending } = store;
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
  // A successful collection read can also support a failed detail preview.
  // Separate stores prevent metadata crossing accounts, services, or profiles.
  const store = useMemo<SummaryCache>(
    () => ({
      scope,
      values: new Map(),
      pending: new Map(),
    }),
    [scope],
  );
  const manifest = JSON.stringify(
    resources
      .filter((resource) => resource.kind === "skill")
      .map((skill) => ({
        id: skill.resourceId,
        key: skillSummaryKey(skill),
      })),
  );
  const [result, setResult] = useState<{
    store: SummaryCache;
    summaries: SkillSummaries;
  }>(() => ({ store, summaries: {} }));
  useEffect(() => {
    const items: { id: string; key: string }[] = JSON.parse(manifest);
    let cancelled = false;
    let index = 0;
    setResult({
      store,
      summaries: Object.fromEntries(
        items
          .filter(({ key }) => store.values.has(key))
          .map(({ key }) => [key, store.values.get(key)!]),
      ),
    });
    async function worker() {
      while (!cancelled && index < items.length) {
        const item = items[index++];
        const summary = await loadSummary(item.id, item.key, store);
        if (!cancelled)
          setResult((current) => ({
            store,
            summaries: {
              ...(current.store === store ? current.summaries : {}),
              [item.key]: summary,
            },
          }));
      }
    }
    void Promise.all(Array.from({ length: 4 }, () => worker()));
    return () => {
      cancelled = true;
    };
  }, [manifest, store]);
  return result.store === store ? result.summaries : {};
}
