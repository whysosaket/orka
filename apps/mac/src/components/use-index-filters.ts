import { useCallback, useEffect, useState } from "react";
import type { Resource } from "@portable/protocol";
import { defaultIndexFilters, type IndexFilters } from "./index-toolbar.js";

type Kind = Resource["kind"];
const initial: Record<Kind, IndexFilters> = {
  memory: defaultIndexFilters,
  skill: { ...defaultIndexFilters, sort: "usage" },
  session: defaultIndexFilters,
  plan: defaultIndexFilters,
};

/** Collection tools stay independent; repository selection spans the project. */
export function useIndexFilters(scope: string) {
  const [stored, setStored] = useState({
    scope,
    filters: initial,
    repository: "all",
  });
  const current =
    stored.scope === scope
      ? stored
      : { scope, filters: initial, repository: "all" };
  useEffect(() => {
    setStored({ scope, filters: initial, repository: "all" });
  }, [scope]);
  const set = useCallback(
    (kind: Kind, next: IndexFilters) => {
      const { repository = "all", ...collection } = next;
      setStored((stored) => ({
        scope,
        repository,
        filters: {
          ...(stored.scope === scope ? stored.filters : initial),
          [kind]: collection,
        },
      }));
    },
    [scope],
  );
  const setRepository = useCallback(
    (repository: string) =>
      setStored((stored) => ({
        scope,
        repository,
        filters: stored.scope === scope ? stored.filters : initial,
      })),
    [scope],
  );
  return {
    filters: current.filters,
    repository: current.repository,
    setRepository,
    set,
  };
}
