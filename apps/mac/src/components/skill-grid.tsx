import React from "react";
import { AlertIcon } from "@primer/octicons-react";
import type { ProjectResource as Resource } from "../types.js";
import { skillSummaryKey, type SkillSummaries } from "./use-skill-summaries.js";
import { SourceLabel } from "./source-label.js";
import { SkillUsageCount } from "./skill-usage.js";
import { skillSharing } from "./skill-sharing.js";
import { RepositoryLabel } from "./repository-label.js";
import "./skill-grid.css";

export function SkillGrid({
  skills,
  summaries,
  usageCounts,
  displayTitle,
  duplicateTitles,
  conflicted,
  onOpen,
}: {
  skills: Resource[];
  summaries: SkillSummaries;
  usageCounts?: Record<string, number>;
  displayTitle: (skill: Resource) => string;
  duplicateTitles: Set<string>;
  conflicted: Set<string>;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="skill-grid">
      {skills.some(
        (skill) => summaries[skillSummaryKey(skill)] === undefined,
      ) && (
        <span className="sr-only" role="status">
          Loading skill descriptions…
        </span>
      )}
      {skills.map((skill) => {
        const summary = summaries[skillSummaryKey(skill)];
        const title = displayTitle(skill);
        return (
          <button
            key={skill.resourceId}
            className="skill-card"
            data-resource-id={skill.resourceId}
            onClick={() => onOpen(skill.resourceId)}
          >
            <span className="skill-card-title">
              <strong title={skill.title}>{title}</strong>
              {skill.global && (
                <span className="skill-origin-badge">Global</span>
              )}
            </span>
            <RepositoryLabel name={skill.repositoryName} />
            {duplicateTitles.has(title.toLocaleLowerCase()) && (
              <small title={skill.logicalPath}>
                {skill.logicalPath.split("/").slice(-2).join("/")}
              </small>
            )}
            {summary === undefined ? (
              <span
                className="skill-card-description-skeleton loading-fade"
                aria-hidden="true"
              >
                <span />
                <span />
                <span />
              </span>
            ) : summary?.description ? (
              <p className="skill-card-description">{summary.description}</p>
            ) : null}
            {conflicted.has(skill.resourceId) && (
              <span className="resource-conflict">
                <AlertIcon size={12} aria-hidden="true" />
                Needs resolution
              </span>
            )}
            <SkillUsageCount count={usageCounts?.[skill.resourceId]} />
            <span className="skill-card-meta">
              {skill.local ? (
                <span>{skillSharing(skill).label}</span>
              ) : (
                <SourceLabel source={skill.source} />
              )}
              {skill.files.length > 1 && (
                <span className="skill-card-files">
                  {skill.files.length} files
                </span>
              )}
              <time
                dateTime={skill.updatedAt}
                title={`Updated ${new Date(skill.updatedAt).toLocaleString()}`}
              >
                {new Date(skill.updatedAt).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                })}
              </time>
            </span>
          </button>
        );
      })}
    </div>
  );
}
