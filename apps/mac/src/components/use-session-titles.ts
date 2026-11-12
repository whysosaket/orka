import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Resource } from "@portable/protocol";

type Preview = { title: string | null; unavailable?: boolean };

export function useSessionTitles(
  resources: Resource[],
  enabled: boolean,
  scope: string,
) {
  const caches = useMemo(
    () => ({
      scope,
      previews: new Map<string, Preview>(),
      pending: new Map<string, Promise<Preview>>(),
    }),
    [scope],
  );
  const manifest = JSON.stringify(
    enabled
      ? resources
          .filter((r) => r.kind === "session")
          .map((r) => ({
            id: r.resourceId,
            key: `${caches.scope}:${r.projectId}:${r.resourceId}:${r.files.map((f) => f.hash).join(":") || r.revision}`,
          }))
      : [],
  );
  const [loaded, setLoaded] = useState<{
    manifest: string;
    previews: Record<string, Preview>;
    loading: boolean;
  }>({ manifest: "", previews: {}, loading: false });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const items: { id: string; key: string }[] = JSON.parse(manifest);
    let canceled = false;
    let index = 0;
    const { previews: cache, pending } = caches;
    setLoaded({
      manifest,
      previews: Object.fromEntries(
        items
          .filter((item) => cache.has(item.key))
          .map((item) => [item.id, cache.get(item.key)!]),
      ),
      loading: items.length > 0,
    });
    const loadTitle = (id: string, key: string): Promise<Preview> => {
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
    };
    async function worker() {
      while (!canceled && index < items.length) {
        const item = items[index++];
        const preview = await loadTitle(item.id, item.key);
        if (!canceled)
          setLoaded((current) => ({
            ...current,
            previews: { ...current.previews, [item.id]: preview },
          }));
      }
    }
    // Complete histories stay native-side; at most two title reads run at once.
    void Promise.all([worker(), worker()]).then(() => {
      if (!canceled) setLoaded((current) => ({ ...current, loading: false }));
    });
    return () => {
      canceled = true;
    };
  }, [manifest, caches, retry]);
  const previews = loaded.manifest === manifest ? loaded.previews : {};
  return {
    previews,
    loading:
      loaded.manifest === manifest
        ? loaded.loading
        : enabled && resources.length > 0,
    unavailable: Object.values(previews).some((item) => item.unavailable),
    retry: () => setRetry((value) => value + 1),
  };
}
