import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Project, ProjectPage, ProjectResource } from "../types.js";

type LocalKind = "memory" | "session" | "plan";
type Catalog = { resources: ProjectResource[]; errors: string[] };
type CatalogEntry = {
  catalog?: Catalog;
  updatedAt: number;
  pending?: Promise<void>;
};
type Catalogs = Partial<Record<LocalKind, CatalogEntry>>;
const kinds: LocalKind[] = ["memory", "session", "plan"];

/** Private discovery runs separately from the workspace's inexpensive snapshots. */
export function useLocalResources({
  scope,
  project,
  page,
  user,
  serviceOrigin,
  syncMinutes = 15,
}: {
  scope: string;
  project: Project | undefined;
  page: ProjectPage;
  user: string | null;
  serviceOrigin: string | undefined;
  syncMinutes?: number;
}) {
  const refreshInterval = Math.max(1, Math.min(syncMinutes, 1440)) * 60_000;
  const cache = useMemo(
    () => ({
      scope,
      user,
      serviceOrigin,
      projects: new Map<string, { key: string; catalogs: Catalogs }>(),
    }),
    [scope, user, serviceOrigin],
  );
  const projectId = project?.id;
  const key = JSON.stringify([projectId, project?.path, project?.sources]);
  const catalogs = useMemo(() => {
    const cached = cache.projects.get(projectId ?? "");
    if (cached?.key === key) return cached.catalogs;
    const catalogs: Catalogs = {};
    cache.projects.set(projectId ?? "", { key, catalogs });
    return catalogs;
  }, [cache, key, projectId]);
  const kind = kinds.find((kind) => kind === page);
  const [, setVersion] = useState(0);
  const [retry, setRetry] = useState(0);
  const refresh = useCallback(() => {
    if (kind && catalogs[kind]) catalogs[kind].updatedAt = 0;
    setRetry((value) => value + 1);
  }, [catalogs, kind]);
  useEffect(() => {
    if (!kind || !projectId || !user || !serviceOrigin) return;
    let canceled = false;
    let timer: number | undefined;
    let running = false;
    const schedule = () => {
      const age = Date.now() - (catalogs[kind]?.updatedAt ?? 0);
      timer = window.setTimeout(
        () => {
          if (document.visibilityState === "visible") void load();
          else schedule();
        },
        document.visibilityState === "visible"
          ? Math.max(refreshInterval - age, 1000)
          : refreshInterval,
      );
    };
    const load = async () => {
      if (canceled || running) return;
      running = true;
      window.clearTimeout(timer);
      const entry = (catalogs[kind] ??= { updatedAt: 0 });
      if (
        !entry.pending &&
        (!entry.updatedAt || Date.now() - entry.updatedAt >= refreshInterval)
      ) {
        // A request belongs to its catalog, so navigation can reuse its result.
        entry.pending = invoke<Catalog | null>("local_resource_catalog", {
          projectId,
          kind,
          accountId: user,
          serviceOrigin,
        })
          .then((result) => {
            entry.catalog = {
              resources: result?.resources ?? [],
              errors: result?.errors ?? [],
            };
          })
          .catch((error) => {
            entry.catalog = {
              resources: entry.catalog?.resources ?? [],
              errors: [String(error)],
            };
          })
          .finally(() => {
            entry.updatedAt = Date.now();
            entry.pending = undefined;
          });
      }
      if (entry.pending) {
        setVersion((value) => value + 1);
        await entry.pending;
        if (!canceled) setVersion((value) => value + 1);
      }
      running = false;
      if (!canceled) schedule();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    void load();
    return () => {
      canceled = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [catalogs, projectId, kind, user, serviceOrigin, refreshInterval, retry]);
  return {
    resources: Object.values(catalogs).flatMap(
      (entry) => entry.catalog?.resources ?? [],
    ),
    errors: kind ? (catalogs[kind]?.catalog?.errors ?? []) : [],
    loading: Boolean(
      kind &&
      projectId &&
      user &&
      serviceOrigin &&
      (catalogs[kind]?.pending || !catalogs[kind]?.catalog),
    ),
    refresh,
  };
}
