import React, { useEffect, useMemo, useRef } from "react";
import type { Resource } from "@portable/protocol";
import { Button } from "./button.js";
import {
  IndexToolbar,
  applyIndexFilters,
  collectionNoun,
  defaultIndexFilters,
  indexNoun,
  type IndexFilters,
} from "./index-toolbar.js";
import { ResourceTable } from "./resource-table.js";
import type { SkillSummaries } from "./use-skill-summaries.js";
import { SkillGrid } from "./skill-grid.js";
import { useMemberLabel } from "./member-names.js";
import {
  ProjectSkillUsageStatus,
  type useProjectSkillUsage,
} from "./skill-usage.js";

export interface ResourceIndexProps {
  skillSummaries: SkillSummaries;
  skillUsage?: ReturnType<typeof useProjectSkillUsage>;
  kind: Resource["kind"];
  /** The loaded, non-deleted collection before any filter. */
  resources: Resource[];
  filters: IndexFilters;
  onFilters: (filters: IndexFilters) => void;
  user: string | null;
  displayTitle: (resource: Resource) => string;
  /** Lowercased display titles that repeat in the collection. */
  duplicateTitles: Set<string>;
  /** Resource IDs with an unresolved conflict. */
  conflicted: Set<string>;
  /** Whether this Mac has a connected folder; it changes the empty copy. */
  connected: boolean;
  noAccess?: boolean;
  /** Session titles still loading. */
  loading?: boolean;
  /** A notice above the toolbar, such as unavailable session titles. */
  status?: React.ReactNode;
  accessRequest?: React.ReactNode;
  floatingAction?: React.ReactNode;
  /**
   * The resource whose reading view was just closed. Its row or card takes
   * focus, or the search field when the current filters hide it.
   */
  focusResource?: string;
  onFocusHandled?: () => void;
  onOpen: (id: string) => void;
}

/** The shared toolbar over a T1 table (memories, sessions) or the K1 skill cards. */
export function ResourceIndex({
  skillSummaries,
  skillUsage,
  kind,
  resources,
  filters,
  onFilters,
  user,
  displayTitle,
  duplicateTitles,
  conflicted,
  connected,
  noAccess,
  loading,
  status,
  accessRequest,
  floatingAction,
  focusResource,
  onFocusHandled,
  onOpen,
}: ResourceIndexProps) {
  const memberName = useMemberLabel(user);
  const root = useRef<HTMLElement>(null);
  const visible = useMemo(
    () =>
      applyIndexFilters(resources, filters, {
        displayTitle,
        user,
        memberName,
        usageCounts: skillUsage?.usage?.counts,
      }),
    [resources, filters, displayTitle, user, memberName, skillUsage?.usage],
  );
  const sources = useMemo(
    () => [...new Set(resources.map((r) => r.source))],
    [resources],
  );
  const filtered = Boolean(
    filters.query.trim() ||
    filters.source !== "all" ||
    (filters.repository && filters.repository !== "all"),
  );
  useEffect(() => {
    if (!focusResource) return;
    const target =
      root.current?.querySelector<HTMLElement>(
        `[data-resource-id="${CSS.escape(focusResource)}"]`,
      ) ?? root.current?.querySelector<HTMLElement>('input[type="search"]');
    target?.focus();
    onFocusHandled?.();
  }, [focusResource, onFocusHandled]);
  return (
    <section
      className={`resource-index${floatingAction ? " resource-index--floating-action" : ""}`}
      aria-label={collectionNoun(kind)}
      ref={root}
    >
      {status}
      {kind === "skill" && skillUsage && (
        <ProjectSkillUsageStatus {...skillUsage} />
      )}
      <div className="resource-index-body">
        {accessRequest}
        {(resources.length > 0 || filtered) && (
          <IndexToolbar
            kind={kind}
            count={visible.length}
            sources={sources}
            filters={filters}
            onChange={onFilters}
            onRefreshUsage={skillUsage?.retry}
            usageLoading={skillUsage?.loading}
          />
        )}
        {!resources.length && !filtered ? (
          <p className="empty">
            {noAccess
              ? `Access to shared ${collectionNoun(kind)} is restricted.`
              : connected
                ? `No ${collectionNoun(kind)} yet.`
                : "Connect a folder to get started."}
          </p>
        ) : !visible.length ? (
          <div className="index-empty-filtered" role="status">
            <p>No {indexNoun(kind, 0)} match</p>
            <Button
              size="sm"
              variant="tertiary"
              onClick={() =>
                onFilters({ ...defaultIndexFilters, sort: filters.sort })
              }
            >
              Clear filters
            </Button>
          </div>
        ) : kind === "skill" ? (
          <SkillGrid
            skills={visible}
            summaries={skillSummaries}
            usageCounts={skillUsage?.usage?.counts}
            displayTitle={displayTitle}
            duplicateTitles={duplicateTitles}
            conflicted={conflicted}
            onOpen={onOpen}
          />
        ) : (
          <ResourceTable
            resources={visible}
            label={
              kind === "session"
                ? "Session"
                : kind === "plan"
                  ? "Plan"
                  : "Memory"
            }
            user={user}
            displayTitle={displayTitle}
            duplicateTitles={duplicateTitles}
            conflicted={conflicted}
            loading={loading}
            focusResource={focusResource}
            filtered={filtered}
            onOpen={onOpen}
          />
        )}
      </div>
      {floatingAction}
    </section>
  );
}
