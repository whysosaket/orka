import React from "react";
import type { SessionConflict } from "@portable/protocol";
import type {
  Project,
  ProjectResource as Resource,
  Snapshot,
} from "../types.js";
import { displayText } from "./resource-presentation.js";
import { DetailHeader } from "./detail-header.js";
import { ResourceContent } from "./resource-content.js";
import { SessionView } from "./session-view.js";
import { SkillDetail } from "./skill-detail.js";
import { useSkillMetadata } from "./skill-metadata.js";
import type { SkillSummary } from "./use-skill-summaries.js";
import { useResourceActions, type Run } from "./use-resource-actions.js";
import type { ResourceView } from "./use-resource-view.js";

export interface ResourceDetailProps {
  scope: string;
  resource: Resource;
  /** The cleaned index title; SKILL.md frontmatter overrides it for skills. */
  displayTitle: string;
  /** Metadata already read for this exact revision in the Skills collection. */
  skillSummary?: SkillSummary | null;
  project: Project;
  user: string | null;
  deviceId: string;
  busy: boolean;
  accessRequest?: React.ReactNode;
  /** The project's unresolved conflicts; the panel shows this resource's. */
  conflicts: SessionConflict[];
  view: ResourceView;
  act: Run;
  /** The workspace snapshot; skills read bindings, drafts, and access from it. */
  state: Snapshot;
  offline?: boolean;
  onRefresh: () => Promise<void>;
  onBack: () => void;
  onNotice: (message: string) => void;
  onGovernance?: () => void;
  onError: (message: string) => void;
}

/** Routes Skills to their reader and shares the other resource reading shells. */
export function ResourceDetail(props: ResourceDetailProps) {
  const {
    resource,
    view,
    act,
    onNotice,
    displayTitle,
    state,
    offline = false,
    onRefresh,
    ...shared
  } = props;
  const inspectedSkill = useSkillMetadata(resource, props.scope);
  const skill =
    inspectedSkill ??
    (props.skillSummary
      ? {
          ...props.skillSummary,
          body: "",
          invalid: false,
          key: `${props.scope}:${resource.resourceId}:${resource.revision}`,
        }
      : null);
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
  if (resource.kind === "skill")
    return (
      <SkillDetail
        resource={resource}
        title={title}
        skill={skill}
        project={props.project}
        user={props.user}
        busy={props.busy}
        accessRequest={props.accessRequest}
        view={view}
        actions={actions}
        state={state}
        offline={offline}
        onRefresh={onRefresh}
        onNotice={onNotice}
        onError={props.onError}
        onGovernance={props.onGovernance}
      />
    );
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
          />
        }
      />
    );
  const body = (
    <div className="detail-body">
      {view.changes && (
        <p className="detail-notice">Comparing with the previous revision</p>
      )}
      <ResourceContent
        inspection={view.inspection}
        error={view.inspectionError}
        onRetry={view.retryInspection}
        changes={view.changes}
        markdown={view.canRenderMarkdown && !view.rawMarkdown}
      />
    </div>
  );
  return (
    <section
      className="resource-detail resource-detail--memory"
      aria-label={resource.kind === "plan" ? "Plan details" : "Memory details"}
    >
      {header}
      {body}
    </section>
  );
}
