import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  CopyIcon,
  FileDirectoryIcon,
  PlusIcon,
  XIcon,
  KebabHorizontalIcon,
} from "@primer/octicons-react";
import { ActionPopover } from "../resource-actions.js";
import { RepositoryConnections } from "../repository-connections.js";
import { CopyLinkButton } from "../copy-link-button.js";
import type { Project, Snapshot } from "../../types.js";
import { Button } from "../button.js";
import { Icon } from "../icon.js";
import { IconButton } from "../icon-button.js";
import { TextField } from "../text-field.js";
import { connectProject } from "../use-project-setup.js";
import { activeSources } from "../project-sources.js";
import { useSettingsQuery } from "./use-settings-query.js";

export function SettingsGeneral({
  project,
  name,
  busy,
  onName,
}: {
  project: Project;
  name: string | null;
  busy: boolean;
  onName: (name: string | null) => void;
}) {
  const [copyError, setCopyError] = useState("");
  return (
    <>
      <div className="settings-project-name">
        <TextField
          label="Project name"
          size="lg"
          hint={
            project.role === "owner"
              ? undefined
              : name === null
                ? "Uses the shared name. Changes apply only on this Mac."
                : "Only on this Mac. Shared renames won’t replace this name."
          }
          value={name ?? project.name}
          maxLength={100}
          disabled={busy}
          onChange={(event) => onName(event.target.value)}
        />
        {project.role === "owner" && (
          <Button
            size="lg"
            disabled={busy || name === project.name}
            onClick={() => onName(project.name)}
          >
            Reset to default
          </Button>
        )}
        {project.role !== "owner" && name !== null && (
          <Button size="lg" disabled={busy} onClick={() => onName(null)}>
            Use shared name
          </Button>
        )}
      </div>
      <TextField
        label="Project ID"
        size="lg"
        value={project.id}
        readOnly
        trailing={
          <CopyLinkButton
            value={project.id}
            label="Copy Project ID"
            icon={CopyIcon}
            iconOnly
            onError={(error) => setCopyError(error)}
          />
        }
      />
      {copyError && <p role="alert">{copyError}</p>}
    </>
  );
}

export function SettingsFolder({
  project,
  state,
  queued,
  busy,
  onConnect,
  onDisconnect,
  onDisconnectSource,
  onRemoveSource,
  onSyncActivity,
  run,
}: {
  project: Project;
  state: Snapshot;
  queued: number;
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onDisconnectSource: (sourceId: string) => void;
  onRemoveSource: (sourceId: string) => void;
  onSyncActivity: () => void;
  run: (action: () => Promise<unknown>) => Promise<unknown>;
}) {
  const user = state.user,
    service = state.config?.apiUrl;
  const loadCapabilities = useCallback(async () => {
    const capabilities = await invoke<{ sourcesRemoval?: number }>(
      "settings_command",
      {
        action: "capabilities",
        context: { user, service },
      },
    );
    return { user, service, supported: capabilities.sourcesRemoval === 1 };
  }, [user, service]);
  const capabilities = useSettingsQuery(loadCapabilities);
  const canRemove =
    project.role === "owner" &&
    capabilities.data?.user === user &&
    capabilities.data?.service === service &&
    capabilities.data.supported;
  const sources: NonNullable<Project["sources"]> = project.sources
    ? activeSources(project.sources)
    : [
        {
          id: "",
          name: project.path?.split("/").filter(Boolean).at(-1) ?? project.name,
          path: project.path,
          folderState: project.folderState,
        },
      ];
  return (
    <>
      <RepositoryConnections
        project={project}
        state={state}
        refresh={() => run(async () => {})}
        folderBusy={busy}
        queued={queued}
        onDisconnectSource={onDisconnectSource}
        onRemoveSource={canRemove ? onRemoveSource : undefined}
        onLocalFolder={async () => {
          let connected = false;
          await run(async () => {
            connected = await connectProject(project.id);
          });
          return connected;
        }}
        renderLocalFolders={(enabled, onLink) => (
          <div
            className={
              enabled
                ? "repository-local-folders"
                : "settings-group settings-source-list"
            }
          >
            {sources
              .filter((source) => !enabled || !source.repository)
              .map((source) => {
                const folderState = source.path
                  ? (source.folderState ?? "connected")
                  : "locate";
                const connect = () =>
                  source.id
                    ? void run(() =>
                        connectProject(
                          project.id,
                          source.id,
                          source.path ?? undefined,
                        ),
                      )
                    : onConnect();
                return (
                  <div className="settings-folder-row" key={source.id}>
                    <div className="settings-folder-identity">
                      <Icon
                        icon={FileDirectoryIcon}
                        className="settings-folder-icon"
                      />
                      <span
                        className="settings-folder-name"
                        title={source.path ?? undefined}
                      >
                        {source.name}
                      </span>
                    </div>
                    <div className="settings-folder-actions">
                      {folderState !== "connected" && (
                        <Button
                          variant={
                            folderState === "locate" ? "primary" : "secondary"
                          }
                          size="sm"
                          className={
                            folderState === "reconnect"
                              ? "settings-folder-reconnect"
                              : undefined
                          }
                          disabled={busy}
                          aria-label={`${folderState === "locate" ? "Locate Folder for" : "Reconnect"} ${source.name}${folderState === "locate" ? "" : " folder"}`}
                          onClick={connect}
                        >
                          {folderState === "locate"
                            ? "Locate Folder"
                            : "Reconnect"}
                        </Button>
                      )}
                      {source.id ? (
                        <ActionPopover
                          label={`Options for ${source.name}`}
                          trigger={
                            <IconButton
                              icon={KebabHorizontalIcon}
                              variant="secondary"
                              size="sm"
                              className="repository-source-options"
                              title={`Options for ${source.name}`}
                              aria-label={`Options for ${source.name}`}
                              disabled={busy}
                            />
                          }
                        >
                          {enabled && project.role === "owner" && (
                            <Button size="sm" onClick={() => onLink(source)}>
                              Link GitHub repository
                            </Button>
                          )}
                          <Button
                            size="sm"
                            disabled={busy || queued > 0 || !source.path}
                            onClick={() =>
                              source.id
                                ? onDisconnectSource(source.id)
                                : onDisconnect()
                            }
                          >
                            Disconnect folder on this Mac
                          </Button>
                          {canRemove && (
                            <Button
                              size="sm"
                              disabled={busy || queued > 0}
                              onClick={() => onRemoveSource(source.id)}
                            >
                              Remove source folder
                            </Button>
                          )}
                        </ActionPopover>
                      ) : (
                        <IconButton
                          icon={XIcon}
                          variant="tertiary"
                          size="sm"
                          aria-label={`Disconnect ${source.name} folder`}
                          title={
                            !source.path
                              ? "Connect this folder before disconnecting"
                              : queued > 0
                                ? "Sync queued changes before disconnecting"
                                : "Disconnect folder on this Mac"
                          }
                          disabled={busy || queued > 0 || !source.path}
                          onClick={() =>
                            source.id
                              ? onDisconnectSource(source.id)
                              : onDisconnect()
                          }
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            {!enabled && sources.length === 0 && project.role !== "owner" && (
              <p className="settings-folder-empty">
                No source folders added yet.
              </p>
            )}
            {!enabled && project.role === "owner" && (
              <div className="settings-add-folder-row">
                <Button
                  variant="tertiary"
                  className="settings-add-folder"
                  disabled={busy}
                  onClick={onConnect}
                >
                  <Icon icon={PlusIcon} />
                  <span className="settings-add-folder-label">Add Folder</span>
                </Button>
              </div>
            )}
          </div>
        )}
      />
      {queued > 0 && (
        <div className="settings-notice settings-folder-notice">
          <p>Sync queued changes before disconnecting folders.</p>
          <Button size="sm" onClick={onSyncActivity}>
            View sync activity
          </Button>
        </div>
      )}
    </>
  );
}
