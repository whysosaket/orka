import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Resource } from "@portable/protocol";
import type { Inspection } from "../types.js";

type SkillSummary = { name: string; description: string };
export type SkillSummaries = Record<string, SkillSummary | null>;
export const skillSummaryKey = (skill: Resource) =>
  `${skill.resourceId}:${skill.revision}:${skill.files.find((file) => file.path === "SKILL.md")?.hash ?? ""}`;
const cache = new Map<string, SkillSummary | null>();
const pending = new Map<string, Promise<SkillSummary | null>>();

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
export function useSkillSummaries(resources: Resource[]): SkillSummaries {
  const manifest = JSON.stringify(
    resources
      .filter((resource) => resource.kind === "skill")
      .map((skill) => ({
        id: skill.resourceId,
        key: skillSummaryKey(skill),
      })),
  );
  const [summaries, setSummaries] = useState<SkillSummaries>({});
  useEffect(() => {
    const items: { id: string; key: string }[] = JSON.parse(manifest);
    let cancelled = false;
    let index = 0;
    setSummaries(
      Object.fromEntries(
        items
          .filter(({ key }) => cache.has(key))
          .map(({ key }) => [key, cache.get(key)!]),
      ),
    );
    async function worker() {
      while (!cancelled && index < items.length) {
        const item = items[index++];
        const summary = await loadSummary(item.id, item.key);
        if (!cancelled)
          setSummaries((current) => ({ ...current, [item.key]: summary }));
      }
    }
    void Promise.all(Array.from({ length: 4 }, () => worker()));
    return () => {
      cancelled = true;
    };
  }, [manifest]);
  return summaries;
}
