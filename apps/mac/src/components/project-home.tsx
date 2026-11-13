import React, { useMemo } from "react";
import {
  ChevronRightIcon,
  CommentDiscussionIcon,
  FileIcon,
  LogIcon,
  VersionsIcon,
} from "@primer/octicons-react";
import type { Project, ProjectResource as Resource } from "../types.js";
import { ResourceItemMenu } from "./resource-menu.js";
import { ItemMenuButton } from "./item-menu.js";
import {
  resourceDisplayTitle,
  sessionFallbackTitle,
} from "./resource-presentation.js";
import { useSessionTitles } from "./use-session-titles.js";
import { skillSummaryKey, useSkillSummaries } from "./use-skill-summaries.js";
import { useMemberLabel } from "./member-names.js";
import "./project-home.css";

const collections = [
  { kind: "memory", label: "Memories", noun: "Memory", icon: VersionsIcon },
  { kind: "skill", label: "Skills", noun: "Skill", icon: FileIcon },
  {
    kind: "session",
    label: "Sessions",
    noun: "Session",
    icon: CommentDiscussionIcon,
  },
  { kind: "plan", label: "Plans", noun: "Plan", icon: LogIcon },
] as const;

function updatedTime(value: string, now: number) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const minutes = Math.max(0, Math.floor((now - date.getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60)
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} ${days === 1 ? "day" : "days"} ago`;
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year:
      date.getFullYear() === new Date(now).getFullYear()
        ? undefined
        : "numeric",
  });
}

export function ProjectHome({
  scope,
  project,
  resources,
  user,
  onNavigate,
  onOpen,
}: {
  scope: string;
  project: Project;
  resources: Resource[];
  user?: string | null;
  onNavigate: (kind: Resource["kind"]) => void;
  onOpen: (resource: Resource) => void;
}) {
  const memberName = useMemberLabel(user ?? null);
  const items = useMemo(
    () =>
      resources.filter(
        (item) => item.projectId === project.id && !item.deleted,
      ),
    [resources, project.id],
  );
  const recent = useMemo(
    () =>
      [...items]
        .sort(
          (a, b) =>
            (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0),
        )
        .slice(0, 6),
    [items],
  );
  // Reuse the reading views' bounded, cached metadata lookups for these six rows.
  const sessionTitles = useSessionTitles(recent, true, scope);
  const skillSummaries = useSkillSummaries(recent, scope);
  const pendingTitles = new Set(
    recent
      .filter((item) =>
        item.kind === "skill"
          ? skillSummaries[skillSummaryKey(item)] === undefined
          : item.kind === "session" &&
            sessionTitles.loading &&
            sessionTitles.previews[item.resourceId] === undefined,
      )
      .map((item) => item.resourceId),
  );
  const now = Date.now();

  return (
    <div className="project-home-overview">
      <section className="home-overview-totals" aria-label="Project totals">
        {collections.map(({ kind, label, icon: CollectionIcon }) => {
          const count = items.filter((item) => item.kind === kind).length;
          return (
            <button
              type="button"
              className="home-overview-total"
              key={kind}
              onClick={() => onNavigate(kind)}
            >
              <span className="sr-only">View </span>
              <span className="home-overview-total-label">
                <CollectionIcon
                  size={16}
                  aria-hidden="true"
                  focusable="false"
                />
                {label}
              </span>
              <strong>{count}</strong>
            </button>
          );
        })}
      </section>
      <section className="home-updates" aria-labelledby="home-updates-title">
        <h2 id="home-updates-title">Recent Updates</h2>
        {pendingTitles.size > 0 && (
          <span className="sr-only" role="status">
            Loading recent updates…
          </span>
        )}
        {recent.length ? (
          <ul
            className="home-updates-list"
            aria-label="Recently updated resources"
          >
            {recent.map((item, index) => {
              const collection = collections.find(
                ({ kind }) => kind === item.kind,
              )!;
              const title =
                item.kind === "session"
                  ? sessionFallbackTitle(
                      sessionTitles.previews[item.resourceId]?.title ||
                        item.title,
                    )
                  : (item.kind === "skill" &&
                      skillSummaries[skillSummaryKey(item)]?.name) ||
                    resourceDisplayTitle(item.title, project.path);
              const actor = memberName(item.updatedBy);
              const time = updatedTime(item.updatedAt, now);
              return (
                <li key={item.resourceId}>
                  <ResourceItemMenu resource={item}>
                    {(actions) => (
                      <div className="home-update-row">
                        <button
                          type="button"
                          className="home-update"
                          data-resource-id={item.resourceId}
                          onClick={() => onOpen(item)}
                        >
                          <span
                            className={`home-update-icon home-overview-kind--${item.kind}`}
                            aria-hidden="true"
                          >
                            <collection.icon size={16} focusable="false" />
                          </span>
                          <span className="home-update-description">
                            <span className="home-update-title" title={title}>
                              {pendingTitles.has(item.resourceId) ? (
                                <>
                                  <span className="sr-only">{title}</span>
                                  <span
                                    className="home-update-title-skeleton"
                                    aria-hidden="true"
                                    style={{ opacity: 1 - index * 0.12 }}
                                  >
                                    <span className="loading-fade" />
                                  </span>
                                </>
                              ) : (
                                title
                              )}
                              <span className="sr-only">
                                {" "}
                                ({collection.noun})
                              </span>
                            </span>
                            <span className="home-update-metadata">
                              Updated by {actor === "You" ? "you" : actor}
                              {time && (
                                <>
                                  <span aria-hidden="true"> · </span>
                                  <time
                                    dateTime={item.updatedAt}
                                    title={new Date(
                                      item.updatedAt,
                                    ).toLocaleString()}
                                  >
                                    {time}
                                  </time>
                                </>
                              )}
                            </span>
                          </span>
                          <span
                            className="home-update-chevron"
                            aria-hidden="true"
                          >
                            <ChevronRightIcon size={16} focusable="false" />
                          </span>
                        </button>
                        {actions.length > 0 && (
                          <ItemMenuButton
                            actions={actions}
                            label={`Actions for ${title}`}
                          />
                        )}
                      </div>
                    )}
                  </ResourceItemMenu>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="home-updates-empty">
            <h3>No updates yet</h3>
          </div>
        )}
      </section>
    </div>
  );
}
