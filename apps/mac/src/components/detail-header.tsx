import React from "react";
import {
  ArrowLeftIcon,
  ArrowUpRightIcon,
  GitCompareIcon,
} from "@primer/octicons-react";
import type { SessionConflict } from "@portable/protocol";
import type { Project, ProjectResource as Resource } from "../types.js";
import { Button } from "./button.js";
import { Icon } from "./icon.js";
import { CopyLinkButton } from "./copy-link-button.js";
import { ConflictPanel } from "./conflict-panel.js";
import { ResourceActions } from "./resource-actions.js";
import { ResourceFacts } from "./resource-facts.js";
import { SegmentedControl } from "./segmented-control.js";
import type { ResourceActionHandlers } from "./use-resource-actions.js";
import { SessionLauncher } from "./session-launcher.js";
import type { ResourceView } from "./use-resource-view.js";
import { skillSharing } from "./skill-sharing.js";
import { sourcePath } from "./project-sources.js";

const collectionNames: Record<Resource["kind"], string> = {
  memory: "Memories",
  skill: "Skills",
  session: "Sessions",
  plan: "Plans",
};

export interface DetailHeaderProps {
  scope: string;
  resource: Resource;
  /** The display title, with SKILL.md frontmatter already applied. */
  title: string;
  project: Project;
  user: string | null;
  deviceId: string;
  busy: boolean;
  accessRequest?: React.ReactNode;
  /** The project's unresolved conflicts; only this resource's are shown. */
  conflicts: SessionConflict[];
  view: ResourceView;
  actions: ResourceActionHandlers;
  onBack: () => void;
  onError: (message: string) => void;
  onGovernance?: () => void;
}

/** Back row, title row with the primary action and More menu, facts, note, and conflicts. */
export function DetailHeader({
  scope,
  resource,
  title,
  project,
  user,
  deviceId,
  busy,
  accessRequest,
  conflicts,
  view,
  actions,
  onBack,
  onError,
  onGovernance,
}: DetailHeaderProps) {
  const session = resource.kind === "session";
  const rawToggle = session
    ? !view.fullTranscript
    : view.canRenderMarkdown && !view.changes;
  return (
    <>
      <div className="detail-back">
        <Button size="sm" variant="tertiary" onClick={onBack}>
          <Icon icon={ArrowLeftIcon} /> Back to {collectionNames[resource.kind]}
        </Button>
        {accessRequest}
      </div>
      <div
        className={`detail-title-row${session ? " detail-title-row--session" : ""}`}
      >
        <h2 className="detail-title">{title}</h2>
        <div className="detail-title-actions">
          {session ? (
            <>
              <SegmentedControl
                label="Session view"
                value={view.fullTranscript ? "transcript" : "conversation"}
                options={[
                  { value: "conversation", label: "Conversation" },
                  { value: "transcript", label: "Transcript" },
                ]}
                onChange={(mode) =>
                  view.setFullTranscript(mode === "transcript")
                }
              />
              <SessionLauncher
                resource={resource}
                project={project}
                scope={scope}
                busy={busy}
                actions={actions}
                onError={onError}
              />
            </>
          ) : (
            <Button
              disabled={busy || !sourcePath(project, resource.sourceId)}
              onClick={() => void actions.openEditor(view.file)}
              variant="primary"
              size="sm"
            >
              <Icon icon={ArrowUpRightIcon} /> Open in editor
            </Button>
          )}
          <ResourceActions key={resource.resourceId}>
            {!session && !resource.local && (
              <Button
                size="sm"
                variant="tertiary"
                aria-pressed={view.changes}
                onClick={() => view.setChanges((value) => !value)}
              >
                <Icon icon={GitCompareIcon} />
                {view.changes
                  ? "Show content"
                  : "Compare with previous revision"}
              </Button>
            )}

            {!resource.local &&
              project.governed &&
              onGovernance &&
              (resource.kind === "skill" ||
                (resource.kind === "memory" &&
                  resource.logicalPath.startsWith("instructions/"))) && (
                <Button
                  size="sm"
                  variant="tertiary"
                  disabled={busy}
                  onClick={onGovernance}
                >
                  Review local update
                </Button>
              )}
            {/* Keep the menu open so the inline Copied confirmation is visible. */}
            {!resource.local && (
              <div data-keep-open>
                <CopyLinkButton
                  value={`orka://project/${project.id}/${resource.resourceId}`}
                  disabled={busy}
                  onError={onError}
                />
              </div>
            )}
            {!resource.local && !session && resource.kind !== "memory" && (
              <Button
                disabled={busy}
                onClick={() => void actions.exportZip()}
                variant="secondary"
                size="sm"
              >
                Export ZIP
              </Button>
            )}
            {rawToggle && (
              <Button
                size="sm"
                variant="tertiary"
                aria-pressed={view.rawMarkdown}
                onClick={() => view.setRawMarkdown((value) => !value)}
              >
                {view.rawMarkdown ? "Show formatted" : "Show Markdown"}
              </Button>
            )}
            {session && (
              <>
                <Button
                  disabled={busy}
                  onClick={() => void actions.sessionAction("copy")}
                  variant="tertiary"
                  size="sm"
                >
                  Create copy
                </Button>
                {resource.owner === user && (
                  <Button
                    disabled={busy}
                    onClick={() => void actions.sessionAction("delete")}
                    variant="tertiary"
                    size="sm"
                  >
                    Remove from history
                  </Button>
                )}
              </>
            )}
            <div className="resource-diagnostics">
              {!resource.local && <p>Revision {resource.revision}</p>}
              <p className="detail-path">{resource.logicalPath}</p>
              {resource.title.trim() !== title.trim() && (
                <p>Stored as “{resource.title}”</p>
              )}
            </div>
          </ResourceActions>
        </div>
      </div>
      <ResourceFacts
        resource={resource}
        user={user}
        file={
          session ? undefined : { selected: view.file, onSelect: view.setFile }
        }
      />
      {resource.local && (
        <div className="detail-note">
          <span>{skillSharing(resource).message}</span>{" "}
          {project.governed &&
            project.sharing?.skill !== false &&
            skillSharing(resource).reviewable &&
            onGovernance && (
              <Button size="sm" variant="tertiary" onClick={onGovernance}>
                Review changes
              </Button>
            )}
        </div>
      )}
      {session && actions.launchError && (
        <p className="detail-note detail-launch-error" role="alert">
          {actions.launchError}
        </p>
      )}
      {session && resource.owner !== user && (
        <p className="detail-note">
          Resuming saves your continuation as a copy.
        </p>
      )}
      {conflicts
        .filter((c) => c.resourceId === resource.resourceId)
        .map((c) => (
          <ConflictPanel
            key={c.id}
            conflict={c}
            deviceId={deviceId}
            user={user}
            owner={resource.owner}
            busy={busy}
            preview={view.preview}
            onPreview={view.setPreview}
            onResolve={(action, conflictId, selected) =>
              void actions.sessionAction(action, conflictId, selected)
            }
          />
        ))}
    </>
  );
}
