import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Resource } from "@portable/protocol";

type Preview = { title: string | null; unavailable?: boolean };
const cache = new Map<string, Preview>();
const pending = new Map<string, Promise<Preview>>();

function loadTitle(id: string, key: string): Promise<Preview> {
  if (cache.has(key)) return Promise.resolve(cache.get(key)!);
  if (pending.has(key)) return pending.get(key)!;
  const request = invoke<string | null>("session_display_title", { id })
    .then((title) => {
      const preview = { title };
      cache.set(key, preview);
      if (cache.size > 500) cache.delete(cache.keys().next().value!);
      return preview;
    })
    .catch(() => ({ title: null, unavailable: true }))
    .finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
}

export function useSessionTitles(resources: Resource[], enabled: boolean) {
  const manifest = JSON.stringify(
    enabled
      ? resources
          .filter((r) => r.kind === "session")
          .map((r) => ({
            id: r.resourceId,
            key: `${r.resourceId}:${r.files.find((f) => f.path === "session.jsonl")?.hash ?? r.revision}`,
          }))
      : [],
  );
  const [previews, setPreviews] = useState<Record<string, Preview>>({});
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const items: { id: string; key: string }[] = JSON.parse(manifest);
    let cancelled = false;
    let index = 0;
    setLoading(items.length > 0);
    setPreviews(
      Object.fromEntries(
        items
          .filter((item) => cache.has(item.key))
          .map((item) => [item.id, cache.get(item.key)!]),
      ),
    );
    async function worker() {
      while (!cancelled && index < items.length) {
        const item = items[index++];
        const preview = await loadTitle(item.id, item.key);
        if (!cancelled)
          setPreviews((current) => ({ ...current, [item.id]: preview }));
      }
    }
    // Keep transcript reads off the UI thread and limit concurrent native reads.
    void Promise.all([worker(), worker()]).then(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [manifest, retry]);
  return {
    previews,
    loading,
    unavailable: Object.values(previews).some((item) => item.unavailable),
    retry: () => setRetry((value) => value + 1),
  };
}
