import React from "react";
import type { SessionConflict } from "@portable/protocol";
import type { Project, ProjectResource as Resource } from "../types.js";
import { displayText } from "./resource-presentation.js";
import { DetailHeader } from "./detail-header.js";
import { ResourceContent } from "./resource-content.js";
import { SessionView } from "./session-view.js";
import { useSkillMetadata } from "./skill-metadata.js";
import { useResourceActions, type Run } from "./use-resource-actions.js";
import type { ResourceView } from "./use-resource-view.js";

export interface ResourceDetailProps {
  scope: string;
  resource: Resource;
  /** The cleaned index title; SKILL.md frontmatter overrides it for skills. */
  displayTitle: string;
  project: Project;
  user: string | null;
  deviceId: string;
  busy: boolean;
  accessRequest?: React.ReactNode;
  /** The project's unresolved conflicts; the panel shows this resource's. */
  conflicts: SessionConflict[];
  view: ResourceView;
  act: Run;
  onBack: () => void;
  onNotice: (message: string) => void;
  onGovernance?: () => void;
  onError: (message: string) => void;
}

/** Option D: one full-width reading shell for memories, skills, and sessions. */
export function ResourceDetail(props: ResourceDetailProps) {
  const { resource, view, act, onNotice, displayTitle, ...shared } = props;
  const skill = useSkillMetadata(resource);
  const title = displayText(skill?.name || displayTitle);
  const actions = useResourceActions({
    act,
    resource,
    user: props.user,
    onNotice,
    scope: JSON.stringify([
      props.scope,
      props.project.id,
      props.project.path,
      props.project.sources,
    ]),
  });
  const header = (
    <DetailHeader
      {...shared}
      resource={resource}
      view={view}
      title={title}
      actions={actions}
    />
  );
  if (resource.kind === "session")
    return (
      <SessionView
        key={resource.resourceId}
        id={resource.resourceId}
        revision={resource.revision}
        conflictId={view.preview}
        source={resource.source}
        header={header}
        mode={view.fullTranscript ? "transcript" : "conversation"}
        raw={view.rawMarkdown}
        transcript={
          <ResourceContent
            inspection={view.inspection}
            error={view.inspectionError}
            onRetry={view.retryInspection}
            changes={false}
            markdown={false}
            conversation={false}
          />
        }
      />
    );
  const skillDocument = resource.kind === "skill" && view.file === "SKILL.md";
  const body = (
    <div className="detail-body">
      {view.changes && (
        <p className="detail-notice">Comparing with the previous revision</p>
      )}
      {skillDocument && !view.changes && skill?.description && (
        <p className="detail-lede">{skill.description}</p>
      )}
      <ResourceContent
        inspection={view.inspection}
        error={view.inspectionError}
        onRetry={view.retryInspection}
        changes={view.changes}
        markdown={view.canRenderMarkdown && !view.rawMarkdown}
        skillDocument={skillDocument}
        conversation={false}
      />
    </div>
  );
  return (
    <section
      // Literal class names: Tailwind emits layered rules only for names it can see.
      className={
        resource.kind === "skill"
          ? "resource-detail resource-detail--skill"
          : "resource-detail resource-detail--memory"
      }
      aria-label={
        resource.kind === "skill"
          ? "Skill details"
          : resource.kind === "plan"
            ? "Plan details"
            : "Memory details"
      }
    >
      {header}
      {body}
    </section>
  );
}
