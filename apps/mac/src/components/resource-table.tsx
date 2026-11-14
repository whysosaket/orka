import { ResourceItemMenu } from "./resource-menu.js";
import { ItemMenuButton } from "./item-menu.js";
import React, { useMemo, useState } from "react";
import {
  AlertIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  RepoForkedIcon,
} from "@primer/octicons-react";
import type { ProjectResource as Resource } from "../types.js";
import { SourceLabel } from "./source-label.js";
import { useMemberLabel } from "./member-names.js";
import { RepositoryLabel } from "./repository-label.js";
import { sessionAncestors, sessionTree } from "./session-tree.js";
import { Button } from "./button.js";
import { SessionIdentity } from "./session-identity.js";

/** "23h ago" style labels for recent activity, calendar dates beyond a week. */
function relativeUpdated(value: string, now = Date.now()) {
  const date = new Date(value);
  const seconds = Math.max(0, Math.round((now - date.getTime()) / 1000));
  if (seconds < 60) return "Just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year:
      date.getFullYear() === new Date(now).getFullYear()
        ? undefined
        : "numeric",
  });
}

/** Disambiguates repeated display titles without exposing full paths in the row. */
function pathSuffix(resource: Resource) {
  return resource.logicalPath.split("/").slice(-2).join("/");
}

export interface ResourceTableProps {
  resources: Resource[];
  /** Singular column name for the visually hidden header, e.g. "Memory". */
  label: string;
  user: string | null;
  displayTitle: (resource: Resource) => string;
  /** Lowercased display titles that appear more than once. */
  duplicateTitles?: Set<string>;
  /** Resource IDs with an unresolved conflict. */
  conflicted: Set<string>;
  loading?: boolean;
  focusResource?: string;
  filtered?: boolean;
  onOpen: (id: string) => void;
}

/** Scannable index shared by memories and sessions. Each row opens the reading view. */
export function ResourceTable({
  resources,
  label,
  user,
  displayTitle,
  duplicateTitles,
  conflicted,
  loading = false,
  focusResource,
  filtered = false,
  onOpen,
}: ResourceTableProps) {
  const memberName = useMemberLabel(user);
  const sessions = resources[0]?.kind === "session";
  const showRepository = resources.some((resource) => resource.repositoryName);
  const tree = useMemo(() => sessionTree(resources), [resources]);
  const [expanded, setExpanded] = useState(
    () => new Set(sessionAncestors(focusResource, tree.parents)),
  );
  const [limits, setLimits] = useState<Record<string, number>>(() => {
    const initial: Record<string, number> = {};
    for (const id of [
      focusResource,
      ...sessionAncestors(focusResource, tree.parents),
    ]) {
      if (!id) continue;
      const parent = tree.parents.get(id);
      if (parent)
        initial[parent] = Math.max(
          5,
          (tree.children
            .get(parent)
            ?.findIndex((child) => child.resourceId === id) ?? 0) + 1,
        );
    }
    return initial;
  });
  const rows: (
    | { resource: Resource; depth: number }
    | { parent: Resource; remaining: number; depth: number }
  )[] = [];
  const append = (resource: Resource, depth: number) => {
    rows.push({ resource, depth });
    const children = tree.children.get(resource.resourceId) ?? [];
    if (!expanded.has(resource.resourceId) && !filtered) return;
    const limit = filtered
      ? children.length
      : (limits[resource.resourceId] ?? 5);
    children.slice(0, limit).forEach((child) => append(child, depth + 1));
    if (children.length > limit)
      rows.push({
        parent: resource,
        remaining: children.length - limit,
        depth: depth + 1,
      });
  };
  tree.roots.forEach((resource) => append(resource, 0));
  return (
    <table className="resource-table" aria-busy={loading}>
      <colgroup>
        <col />
        {showRepository && <col className="resource-table-col-repository" />}
        {!sessions && <col className="resource-table-col-source" />}
        <col className="resource-table-col-author" />
        <col className="resource-table-col-updated" />
        <col className="resource-table-col-actions" />
      </colgroup>
      <thead className="sr-only">
        <tr>
          <th scope="col">{label}</th>
          {showRepository && <th scope="col">Repository</th>}
          {!sessions && <th scope="col">Source</th>}
          <th scope="col">{sessions ? "Tool and author" : "Updated by"}</th>
          <th scope="col">Updated</th>
          <th scope="col">
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          if ("parent" in row)
            return (
              <tr
                key={`more:${row.parent.resourceId}`}
                className="session-forks-more"
              >
                <td colSpan={(showRepository ? 6 : 5) - (sessions ? 1 : 0)}>
                  <Button
                    variant="tertiary"
                    size="sm"
                    aria-label={`Show more forks of ${displayTitle(row.parent)}`}
                    onClick={() =>
                      setLimits((current) => ({
                        ...current,
                        [row.parent.resourceId]:
                          (current[row.parent.resourceId] ?? 5) + 5,
                      }))
                    }
                  >
                    View more ({row.remaining})
                  </Button>
                </td>
              </tr>
            );
          const { resource, depth } = row;
          const title = displayTitle(resource);
          const children = tree.children.get(resource.resourceId) ?? [];
          const open = filtered || expanded.has(resource.resourceId);
          return (
            <ResourceItemMenu key={resource.resourceId} resource={resource}>
              {(actions) => (
                <tr
                  className={depth > 0 ? "session-fork-row" : undefined}
                  onClick={() => onOpen(resource.resourceId)}
                >
                  <th scope="row" className="resource-table-title">
                    <div
                      className="resource-table-title-content"
                      style={{ paddingInlineStart: Math.min(depth, 4) * 20 }}
                    >
                      {tree.children.size > 0 && (
                        <span className="session-forks-disclosure">
                          {children.length > 0 && (
                            <button
                              type="button"
                              className="session-forks-toggle"
                              aria-expanded={open}
                              aria-label={`${open ? "Collapse" : "Expand"} ${children.length} ${children.length === 1 ? "fork" : "forks"} of ${title}`}
                              disabled={filtered}
                              onClick={(event) => {
                                event.stopPropagation();
                                setExpanded((current) => {
                                  const next = new Set(current);
                                  if (next.has(resource.resourceId))
                                    next.delete(resource.resourceId);
                                  else next.add(resource.resourceId);
                                  return next;
                                });
                              }}
                            >
                              {open ? (
                                <ChevronDownIcon size={16} />
                              ) : (
                                <ChevronRightIcon size={16} />
                              )}
                              <span>{children.length}</span>
                            </button>
                          )}
                        </span>
                      )}
                      {resource.fork && (
                        <RepoForkedIcon
                          className="session-fork-icon"
                          size={16}
                          aria-label="Forked session"
                        />
                      )}
                      <div className="resource-table-title-text">
                        <button
                          type="button"
                          className="resource-table-open"
                          data-resource-id={resource.resourceId}
                          title={resource.title}
                          onClick={(event) => {
                            event.stopPropagation();
                            onOpen(resource.resourceId);
                          }}
                        >
                          {title}
                        </button>
                        {!sessions &&
                          duplicateTitles?.has(title.toLocaleLowerCase()) && (
                            <small
                              className="resource-table-suffix"
                              title={resource.logicalPath}
                            >
                              {pathSuffix(resource)}
                            </small>
                          )}
                        {(resource.local ||
                          (resource.fork && resource.revision === 0) ||
                          resource.localChanges) && (
                          <small className="resource-table-suffix">
                            {resource.localChanges
                              ? "Local changes"
                              : sessions
                                ? "Local Only"
                                : "On this Mac"}
                          </small>
                        )}
                        {!sessions &&
                          !resource.local &&
                          resource.owner !== user && (
                            <small className="resource-table-suffix">
                              Owner: {memberName(resource.owner)}
                            </small>
                          )}
                        {conflicted.has(resource.resourceId) && (
                          <span className="resource-conflict">
                            <AlertIcon size={12} aria-hidden="true" />
                            Needs resolution
                          </span>
                        )}
                      </div>
                    </div>
                  </th>
                  {showRepository && (
                    <td className="resource-table-repository">
                      <RepositoryLabel name={resource.repositoryName} />
                    </td>
                  )}
                  {sessions ? (
                    <td>
                      <SessionIdentity resource={resource} user={user} />
                    </td>
                  ) : (
                    <>
                      <td>
                        <span className="resource-source-pill">
                          <SourceLabel source={resource.source} />
                        </span>
                      </td>
                      <td
                        className="resource-table-author"
                        title={memberName(resource.updatedBy)}
                      >
                        {memberName(resource.updatedBy)}
                      </td>
                    </>
                  )}
                  <td className="resource-table-updated">
                    <time
                      dateTime={resource.updatedAt}
                      title={`Updated ${new Date(resource.updatedAt).toLocaleString()}`}
                    >
                      {relativeUpdated(resource.updatedAt)}
                    </time>
                  </td>
                  <td className="resource-table-actions">
                    {actions.length > 0 ? (
                      <ItemMenuButton
                        actions={actions}
                        label={`Actions for ${title}`}
                      />
                    ) : (
                      <ChevronRightIcon size={16} aria-hidden="true" />
                    )}
                  </td>
                </tr>
              )}
            </ResourceItemMenu>
          );
        })}
      </tbody>
    </table>
  );
}
