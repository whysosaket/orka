import React, { useEffect, useMemo, useRef, useState } from "react";
import { AlertIcon, SyncIcon } from "@primer/octicons-react";
import type { ProjectResource as Resource } from "../types.js";
import { SegmentedControl } from "./segmented-control.js";
import { IconButton } from "./icon-button.js";
import { Button } from "./button.js";
import { Icon } from "./icon.js";
import { useToasts } from "./toasts.js";
import {
  IndexToolbar,
  applyIndexFilters,
  collectionNoun,
  defaultIndexFilters,
  indexNoun,
  type IndexFilters,
} from "./index-toolbar.js";
import { ResourceTable } from "./resource-table.js";
import { LoadingRegion } from "./loading-region.js";
import { CollectionSkeleton } from "./collection-skeleton.js";
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
  discovering?: boolean;
  discoveryResult?: { errors: string[] };
  onRefreshLocal?: () => void;
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
  discovering = false,
  discoveryResult,
  onRefreshLocal,
  status,
  accessRequest,
  floatingAction,
  focusResource,
  onFocusHandled,
  onOpen,
}: ResourceIndexProps) {
  const memberName = useMemberLabel(user);
  const { notify } = useToasts();
  const discoveryErrors = discoveryResult?.errors ?? [];
  const [refreshRequest, setRefreshRequest] = useState<{
    result: typeof discoveryResult;
  } | null>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const refreshing = discovering || refreshRequest !== null;
  const refreshLocal = () => {
    if (!onRefreshLocal || refreshing) return;
    setRefreshRequest({ result: discoveryResult });
    onRefreshLocal();
  };
  useEffect(() => {
    if (
      !refreshRequest ||
      !discoveryResult ||
      discovering ||
      discoveryResult === refreshRequest.result
    )
      return;
    setRefreshRequest(null);
    setRefreshFailed(Boolean(discoveryResult?.errors.length));
    if (!discoveryResult?.errors.length)
      notify({
        kind: "success",
        title: `Local ${collectionNoun(kind)} refreshed`,
      });
  }, [discovering, discoveryResult, refreshRequest, kind, notify]);
  const ownership = kind === "skill" ? "all" : (filters.ownership ?? "all");
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
        {kind !== "skill" && (
          <div className="resource-ownership-toolbar">
            <SegmentedControl
              className="resource-ownership-tabs"
              label="Filter by ownership"
              value={ownership}
              options={[
                {
                  value: "all",
                  label: "All",
                },
                { value: "mine", label: "Mine" },
                { value: "shared", label: "Shared with me" },
              ]}
              onChange={(ownership) => onFilters({ ...filters, ownership })}
            />
            {onRefreshLocal && (
              <IconButton
                icon={SyncIcon}
                size="sm"
                variant="tertiary"
                aria-label="Refresh local items"
                title={`Refresh local ${collectionNoun(kind)}`}
                disabled={refreshing}
                onClick={refreshLocal}
              />
            )}
          </div>
        )}
        {discovering && resources.length > 0 && (
          <span className="sr-only" role="status">
            Refreshing {collectionNoun(kind)}…
          </span>
        )}
        {kind !== "skill" && discoveryErrors.length > 0 && (
          <div className="resource-discovery-status">
            <div role={refreshing ? "status" : "alert"} aria-atomic="true">
              <p className="resource-discovery-title">
                <Icon icon={AlertIcon} size="sm" variant="secondary" />
                {refreshing
                  ? `Checking local ${collectionNoun(kind)}…`
                  : refreshFailed
                    ? `Couldn’t refresh local ${collectionNoun(kind)}`
                    : `Some local ${collectionNoun(kind)} couldn’t be checked`}
              </p>
              <p className="resource-discovery-message">
                Previously discovered items are still available.
              </p>
              {!refreshing &&
                discoveryErrors.map((error, index) => (
                  <p className="resource-discovery-message" key={index}>
                    {error}
                  </p>
                ))}
            </div>
            {onRefreshLocal && (
              <Button
                size="sm"
                variant="tertiary"
                onClick={refreshLocal}
                disabled={refreshing}
              >
                <span className={refreshing ? "sync-activity-icon" : ""}>
                  <Icon icon={SyncIcon} size="sm" />
                </span>
                {refreshing ? "Checking…" : "Try again"}
              </Button>
            )}
          </div>
        )}
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
        {discovering && !resources.length ? (
          <LoadingRegion
            id={`collection:${kind}`}
            label={`Loading ${collectionNoun(kind)}…`}
            loading
            skeleton={<CollectionSkeleton />}
          >
            <div />
          </LoadingRegion>
        ) : !visible.length &&
          (!filtered ||
            (!resources.length &&
              (discovering || discoveryErrors.length > 0))) ? (
          <p className="empty" role="status">
            {discoveryErrors.length > 0 && !resources.length
              ? `Local ${collectionNoun(kind)} could not be checked.`
              : noAccess && ownership === "shared"
                ? `Access to shared ${collectionNoun(kind)} is restricted.`
                : ownership === "mine"
                  ? `No ${collectionNoun(kind)} of your own yet.`
                  : ownership === "shared"
                    ? `No ${collectionNoun(kind)} have been shared with you yet.`
                    : noAccess
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
                onFilters({
                  ...defaultIndexFilters,
                  ownership,
                  sort: filters.sort,
                })
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
            filtered={filtered || ownership !== "all"}
            onOpen={onOpen}
          />
        )}
      </div>
      {floatingAction}
    </section>
  );
}
