import type { Project, Snapshot } from "../../types.js";
import { Button } from "../button.js";
import { TextField } from "../text-field.js";
import { legacySharing, sharingChoices } from "../project-sharing.js";
import type { SettingsSection } from "./settings-navigation.js";
import { invoke } from "@tauri-apps/api/core";
import { SourceFolders, useSourceFolders } from "../source-folders.js";
import { connectProject } from "../use-project-setup.js";

export function SettingsGeneral({
  project,
  name,
  busy,
  onName,
  onSection,
  onManage,
}: {
  project: Project;
  name: string | null;
  busy: boolean;
  onName: (name: string | null) => void;
  onSection: (section: SettingsSection) => void;
  onManage: () => void;
}) {
  const sharing = project.sharing ?? legacySharing;
  const count = sharingChoices.filter(({ key }) => sharing[key]).length;
  return (
    <>
      <TextField
        label="Project name"
        hint={
          project.role === "owner"
            ? "Updates the name for members using the shared name."
            : name === null
              ? "Follows the owner's name until you change it on this Mac."
              : "Only on this Mac. Owner renames won't replace this name."
        }
        value={name ?? project.name}
        maxLength={100}
        disabled={busy}
        onChange={(event) => onName(event.target.value)}
      />
      {project.role !== "owner" && name !== null && (
        <Button size="sm" disabled={busy} onClick={() => onName(null)}>
          Use shared name
        </Button>
      )}
      <div className="settings-detail">
        <h3>Project ID</h3>
        <p className="settings-path">{project.id}</p>
      </div>
      <div className="settings-row">
        <div>
          <h3>Folder on this Mac</h3>
          <p className="settings-path">
            {project.sources
              ? `${project.sources.filter((source) => source.path).length} of ${project.sources.length} source folders connected`
              : (project.path ?? "No folder connected")}
          </p>
        </div>
        <Button size="sm" onClick={() => onSection("folder")}>
          Manage folder
        </Button>
      </div>
      <div className="settings-row">
        <div>
          <h3>Shared from this Mac</h3>
          <p>
            {count} of {sharingChoices.length} categories enabled
          </p>
        </div>
        <Button size="sm" onClick={() => onSection("sharing")}>
          Manage sharing
        </Button>
      </div>
      <div className="settings-row">
        <h3>Members, permissions, and requests</h3>
        <Button size="sm" onClick={onManage}>
          Open Manage
        </Button>
      </div>
    </>
  );
}

export function SettingsFolder({
  project,
  queued,
  busy,
  onConnect,
  onDisconnect,
  onSyncActivity,
  run,
}: {
  project: Project;
  queued: number;
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onSyncActivity: () => void;
  run: (action: () => Promise<unknown>) => Promise<unknown>;
}) {
  const selection = useSourceFolders();
  if (project.sources)
    return (
      <>
        {project.sources.map((source) => (
          <div className="settings-row" key={source.id}>
            <div>
              <h3>{source.name}</h3>
              <p className="settings-path">
                {source.path ?? "Not connected on this Mac"}
              </p>
            </div>
            {source.path ? (
              <Button
                size="sm"
                disabled={busy || queued > 0}
                onClick={() =>
                  void run(() =>
                    invoke("disconnect_project_source", {
                      id: project.id,
                      sourceId: source.id,
                    }),
                  )
                }
              >
                Disconnect
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run(() => connectProject(project.id, source.id))
                }
              >
                Locate folder
              </Button>
            )}
          </div>
        ))}
        {queued > 0 && (
          <div className="settings-notice">
            <p>Sync queued changes before disconnecting folders.</p>
            <Button size="sm" onClick={onSyncActivity}>
              View sync activity
            </Button>
          </div>
        )}
        {project.role === "owner" && (
          <>
            <SourceFolders
              selection={selection}
              busy={busy}
              run={(action) => void run(action)}
            />
            {selection.folders.length > 0 && (
              <Button
                disabled={busy}
                variant="primary"
                onClick={() =>
                  void run(async () => {
                    await invoke("connect_project_sources", {
                      id: project.id,
                      paths: selection.folders,
                    });
                    selection.clear();
                  })
                }
              >
                Add selected folders
              </Button>
            )}
          </>
        )}
      </>
    );
  return (
    <>
      <div className="settings-detail">
        <h3>Folder on this Mac</h3>
        <p className="settings-folder-path">
          {project.path ?? "No folder connected"}
        </p>
      </div>
      {project.path ? (
        <>
          {queued > 0 && (
            <div className="settings-notice">
              <p>
                Sync {queued} queued {queued === 1 ? "change" : "changes"}{" "}
                before disconnecting.
              </p>
              <Button size="sm" onClick={onSyncActivity}>
                View sync activity
              </Button>
            </div>
          )}
          <Button disabled={busy || queued > 0} onClick={onDisconnect}>
            Disconnect folder
          </Button>
        </>
      ) : (
        <Button variant="primary" disabled={busy} onClick={onConnect}>
          Connect folder
        </Button>
      )}
    </>
  );
}

export function SettingsDevices({ state }: { state: Snapshot }) {
  return (
    <>
      {state.devices === null ? (
        <p role="status">
          Connected Macs are unavailable. Try again after the next sync.
        </p>
      ) : state.devices.length === 0 ? (
        <p>No connected Macs reported yet.</p>
      ) : (
        <div className="settings-devices">
          {state.devices.map((device) => (
            <div className="settings-row" key={device.id}>
              <div>
                <h3>
                  {device.name}
                  {device.id === state.deviceId && (
                    <span className="settings-device-label">This Mac</span>
                  )}
                </h3>
                <p>
                  Last seen{" "}
                  {device.seen_at && Number.isFinite(Date.parse(device.seen_at))
                    ? new Date(device.seen_at).toLocaleString()
                    : "unavailable"}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
