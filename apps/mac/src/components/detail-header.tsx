import React from "react";
import { ArrowLeftIcon, ArrowUpRightIcon } from "@primer/octicons-react";
import type { SessionConflict } from "@portable/protocol";
import type { Project, ProjectResource as Resource } from "../types.js";
import { Button } from "./button.js";
import { Icon } from "./icon.js";
import { ConflictPanel } from "./conflict-panel.js";
import {
  ResourceMenuButton,
  resourceViewMenuActions,
} from "./resource-menu.js";
import { ResourceFacts } from "./resource-facts.js";
import { SegmentedControl } from "./segmented-control.js";
import type { ResourceActionHandlers } from "./use-resource-actions.js";
import { SessionLauncher } from "./session-launcher.js";
import type { ResourceView } from "./use-resource-view.js";
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
  /** The cleaned resource title. Skills use their own detail header. */
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
}: DetailHeaderProps) {
  const session = resource.kind === "session";
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
          <ResourceMenuButton
            resource={resource}
            file={view.file}
            extraActions={resourceViewMenuActions(view, session)}
          />
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
        <p className="detail-note">
          On this Mac. This {resource.kind} hasn’t been shared.
        </p>
      )}
      {resource.localChanges && (
        <p className="detail-note">
          Local changes are only on this Mac. Shared links open the last shared
          snapshot.
        </p>
      )}
      {session && actions.launchError && (
        <p className="detail-note detail-launch-error" role="alert">
          {actions.launchError}
        </p>
      )}
      {session && resource.fork && resource.owner === user && (
        <p className="detail-note">
          Forked session. Opening continues this session; choose Fork and open
          to create another.
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
