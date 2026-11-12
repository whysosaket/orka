import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Project, ProjectPage, ProjectResource } from "../types.js";

type LocalKind = "memory" | "session" | "plan";
type Catalog = { resources: ProjectResource[]; errors: string[] };
const kinds: LocalKind[] = ["memory", "session", "plan"];

/** Private discovery runs separately from the workspace's inexpensive snapshots. */
export function useLocalResources({
  scope,
  project,
  page,
  user,
  serviceOrigin,
}: {
  scope: string;
  project: Project | undefined;
  page: ProjectPage;
  user: string | null;
  serviceOrigin: string | undefined;
}) {
  const key = JSON.stringify([scope, project?.id]);
  const kind = kinds.find((kind) => kind === page);
  const folders = JSON.stringify([project?.path, project?.sources]);
  const [stored, setStored] = useState<{
    key: string;
    catalogs: Partial<Record<LocalKind, Catalog>>;
    loading?: LocalKind;
  }>({ key, catalogs: {} });
  const current = stored.key === key ? stored : { key, catalogs: {} };
  const [retry, setRetry] = useState(0);
  const refresh = useCallback(() => setRetry((value) => value + 1), []);
  const projectId = project?.id;
  useEffect(() => {
    if (!kind || !projectId || !user || !serviceOrigin) return;
    let canceled = false;
    let timer: number | undefined;
    let running = false;
    const schedule = () => {
      timer = window.setTimeout(() => {
        if (document.visibilityState === "visible") void load();
        else schedule();
      }, 30_000);
    };
    const load = async () => {
      if (running || canceled) return;
      running = true;
      setStored((stored) => ({
        key,
        catalogs: stored.key === key ? stored.catalogs : {},
        loading: kind,
      }));
      try {
        const result = await invoke<Catalog | null>("local_resource_catalog", {
          projectId,
          kind,
          accountId: user,
          serviceOrigin,
        });
        if (!canceled)
          setStored((stored) => ({
            key,
            catalogs: {
              ...(stored.key === key ? stored.catalogs : {}),
              [kind]: {
                resources: result?.resources ?? [],
                errors: result?.errors ?? [],
              },
            },
          }));
      } catch (error) {
        if (!canceled)
          setStored((stored) => ({
            key,
            catalogs: {
              ...(stored.key === key ? stored.catalogs : {}),
              [kind]: {
                resources:
                  (stored.key === key && stored.catalogs[kind]?.resources) ||
                  [],
                errors: [String(error)],
              },
            },
          }));
      } finally {
        running = false;
        if (!canceled) schedule();
      }
    };
    void load();
    return () => {
      canceled = true;
      window.clearTimeout(timer);
    };
  }, [key, projectId, kind, user, serviceOrigin, folders, retry]);
  return {
    resources: Object.values(current.catalogs).flatMap(
      (catalog) => catalog.resources,
    ),
    errors: kind ? (current.catalogs[kind]?.errors ?? []) : [],
    loading: Boolean(
      kind &&
      user &&
      serviceOrigin &&
      (current.loading === kind || !current.catalogs[kind]),
    ),
    refresh,
  };
}
