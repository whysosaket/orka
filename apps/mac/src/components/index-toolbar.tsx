import React from "react";
import { SyncIcon } from "@primer/octicons-react";
import type { Resource } from "@portable/protocol";
import { IconButton } from "./icon-button.js";
import { SearchField } from "./search-field.js";
import { SegmentedControl } from "./segmented-control.js";
import { SourceLabel } from "./source-label.js";
import { SortMenu } from "./sort-menu.js";
import { memberLabel } from "./project-permissions.js";

export type IndexSort = "updated" | "title" | "author" | "usage";
export type OwnershipFilter = "all" | "mine" | "shared";
export type SourceFilter = Resource["source"] | "all";

/** Presentation-only view state for one collection; never touches stored data. */
export interface IndexFilters {
  query: string;
  source: SourceFilter;
  sort: IndexSort;
  repository?: string;
  ownership?: OwnershipFilter;
}

export const defaultIndexFilters: IndexFilters = {
  query: "",
  source: "all",
  sort: "updated",
  ownership: "all",
};

const sortLabels: Record<IndexSort, string> = {
  usage: "Most used",
  updated: "Recently updated",
  title: "Title",
  author: "Author",
};

const nouns: Record<Resource["kind"], [string, string]> = {
  memory: ["memory", "memories"],
  skill: ["skill", "skills"],
  session: ["session", "sessions"],
  plan: ["plan", "plans"],
};
export const indexNoun = (kind: Resource["kind"], count: number) =>
  nouns[kind][count === 1 ? 0 : 1];
/** The lowercase plural used for labels such as "Search memories". */
export const collectionNoun = (kind: Resource["kind"]) => nouns[kind][1];

const sourceOrder: Resource["source"][] = ["claude", "codex", "shared"];
const sourceName = (source: Resource["source"]) =>
  source === "codex" ? "Codex" : source === "claude" ? "Claude" : "Shared";

interface IndexContext {
  displayTitle: (resource: Resource) => string;
  user: string | null;
  memberName?: (id: string) => string;
  usageCounts?: Record<string, number>;
}

/** Filters loaded titles, paths, and sources, then orders by the chosen sort. */
export function applyIndexFilters(
  resources: Resource[],
  filters: IndexFilters,
  {
    displayTitle,
    user,
    memberName = (id) => memberLabel(id, user),
    usageCounts,
  }: IndexContext,
): Resource[] {
  const query = filters.query.trim().toLocaleLowerCase();
  const matches = resources.filter((resource) => {
    if (resource.kind !== "skill") {
      if (filters.ownership === "mine" && resource.owner !== user) return false;
      if (filters.ownership === "shared" && resource.owner === user)
        return false;
    }
    if (
      filters.repository &&
      filters.repository !== "all" &&
      resource.sourceId !== filters.repository
    )
      return false;
    if (filters.source !== "all" && resource.source !== filters.source)
      return false;
    if (!query) return true;
    return [
      displayTitle(resource),
      resource.title,
      resource.logicalPath,
      sourceName(resource.source),
    ].some((text) => text.toLocaleLowerCase().includes(query));
  });
  const byUpdated = (a: Resource, b: Resource) =>
    Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  return [...matches].sort((a, b) => {
    if (filters.sort === "usage")
      return (
        (usageCounts?.[b.resourceId] ?? 0) -
          (usageCounts?.[a.resourceId] ?? 0) ||
        displayTitle(a).localeCompare(displayTitle(b), undefined, {
          sensitivity: "base",
        }) ||
        byUpdated(a, b)
      );
    if (filters.sort === "title")
      return (
        displayTitle(a).localeCompare(displayTitle(b), undefined, {
          sensitivity: "base",
        }) || byUpdated(a, b)
      );
    if (filters.sort === "author")
      return (
        memberName(a.updatedBy).localeCompare(
          memberName(b.updatedBy),
          undefined,
          {
            sensitivity: "base",
          },
        ) || byUpdated(a, b)
      );
    return byUpdated(a, b);
  });
}

export interface IndexToolbarProps {
  kind: Resource["kind"];
  /** Items shown after the current filters. */
  count: number;
  /** Sources present in the loaded collection. */
  sources: Resource["source"][];
  filters: IndexFilters;
  onChange: (filters: IndexFilters) => void;
  onRefreshUsage?: () => void;
  usageLoading?: boolean;
}

/** The shared 32px toolbar above every index: search, source filter, count, sort. */
export function IndexToolbar({
  kind,
  count,
  sources,
  filters,
  onChange,
  onRefreshUsage,
  usageLoading,
}: IndexToolbarProps) {
  const plural = collectionNoun(kind);
  const present = sourceOrder.filter(
    (source) => sources.includes(source) || filters.source === source,
  );
  const filtered = Boolean(
    filters.query.trim() ||
    (kind !== "skill" && filters.ownership && filters.ownership !== "all") ||
    filters.source !== "all" ||
    (filters.repository && filters.repository !== "all"),
  );
  return (
    <div className="index-toolbar" role="group" aria-label={`${plural} tools`}>
      <SearchField
        size="sm"
        value={filters.query}
        onValueChange={(query) => onChange({ ...filters, query })}
        placeholder={`Search ${plural}…`}
        aria-label={`Search ${plural}`}
      />
      {(present.length > 1 || filters.source !== "all") && (
        <SegmentedControl<SourceFilter>
          label="Filter by source"
          value={filters.source}
          options={[
            { value: "all", label: "All" },
            ...present.map((source) => ({
              value: source,
              label: <SourceLabel source={source} />,
            })),
          ]}
          onChange={(source) => onChange({ ...filters, source })}
        />
      )}
      {filtered && (
        <span className="index-toolbar-count" role="status">
          {count} {indexNoun(kind, count)}
        </span>
      )}
      <SortMenu
        options={(Object.keys(sortLabels) as IndexSort[])
          .filter((sort) => sort !== "usage" || kind === "skill")
          .map((sort) => ({ value: sort, label: sortLabels[sort] }))}
        value={filters.sort}
        onChange={(sort) => onChange({ ...filters, sort })}
      />
      {kind === "skill" && onRefreshUsage && (
        <IconButton
          icon={SyncIcon}
          size="sm"
          variant="tertiary"
          aria-label="Refresh skill usage"
          title="Refresh skill usage"
          disabled={usageLoading}
          onClick={onRefreshUsage}
        />
      )}
    </div>
  );
}
