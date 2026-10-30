import React from "react";
import { AlertIcon, ChevronRightIcon } from "@primer/octicons-react";
import type { ProjectResource as Resource } from "../types.js";
import { SourceLabel } from "./source-label.js";
import { useMemberLabel } from "./member-names.js";
import { RepositoryLabel } from "./repository-label.js";

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
  return resource.kind === "session"
    ? `Session ${resource.resourceId.slice(0, 8)}`
    : resource.logicalPath.split("/").slice(-2).join("/");
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
  onOpen,
}: ResourceTableProps) {
  const memberName = useMemberLabel(user);
  const showRepository = resources.some((resource) => resource.repositoryName);
  return (
    <table className="resource-table" aria-busy={loading}>
      <colgroup>
        <col />
        {showRepository && <col className="resource-table-col-repository" />}
        <col className="resource-table-col-source" />
        <col className="resource-table-col-author" />
        <col className="resource-table-col-updated" />
        <col className="resource-table-col-chevron" />
      </colgroup>
      <thead className="sr-only">
        <tr>
          <th scope="col">{label}</th>
          {showRepository && <th scope="col">Repository</th>}
          <th scope="col">Source</th>
          <th scope="col">Author</th>
          <th scope="col">Updated</th>
          <th scope="col">
            <span className="sr-only">Open</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {resources.map((resource) => {
          const title = displayTitle(resource);
          return (
            <tr
              key={resource.resourceId}
              onClick={() => onOpen(resource.resourceId)}
            >
              <th scope="row" className="resource-table-title">
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
                {duplicateTitles?.has(title.toLocaleLowerCase()) && (
                  <small
                    className="resource-table-suffix"
                    title={resource.logicalPath}
                  >
                    {pathSuffix(resource)}
                  </small>
                )}
                {conflicted.has(resource.resourceId) && (
                  <span className="resource-conflict">
                    <AlertIcon size={12} aria-hidden="true" />
                    Needs resolution
                  </span>
                )}
              </th>
              {showRepository && (
                <td className="resource-table-repository">
                  <RepositoryLabel name={resource.repositoryName} />
                </td>
              )}
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
              <td className="resource-table-updated">
                <time
                  dateTime={resource.updatedAt}
                  title={`Updated ${new Date(resource.updatedAt).toLocaleString()}`}
                >
                  {relativeUpdated(resource.updatedAt)}
                </time>
              </td>
              <td className="resource-table-chevron">
                <ChevronRightIcon size={16} aria-hidden="true" />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
