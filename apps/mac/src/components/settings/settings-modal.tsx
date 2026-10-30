import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { XIcon } from "@primer/octicons-react";
import type { Snapshot } from "../../types.js";
import { Button } from "../button.js";
import { IconButton } from "../icon-button.js";
import { Overlay } from "../overlay.js";
import { TextField } from "../text-field.js";
import { useToastNotice } from "../toasts.js";
import { legacySharing, ProjectSharingChoices } from "../project-sharing.js";
import { projectLabel } from "../project-navigation.js";
import { connectProject } from "../use-project-setup.js";
import {
  SettingsNavigation,
  settingsSections,
  type SettingsSection,
} from "./settings-navigation.js";
import {
  SettingsGeneral,
  SettingsFolder,
  SettingsDevices,
} from "./settings-sections.js";
import { SettingsAccount } from "./settings-account.js";

type Destination =
  | { section: SettingsSection; projectId: string }
  | { manage: string }
  | "close";
const syncDraft = (state: Snapshot) => ({
  minutes: String(state.config?.syncMinutes ?? 15),
  background: state.background !== false,
});

export function SettingsModal({
  state,
  initialProjectId,
  initialSection = "general",
  busy: workspaceBusy,
  run: workspaceRun,
  onSignedOut,
  onSyncActivity,
  onManage,
  onClose,
}: {
  state: Snapshot;
  initialProjectId: string;
  initialSection?: SettingsSection;
  busy: boolean;
  run: (action: () => Promise<unknown>) => Promise<void>;
  onSignedOut: () => void;
  onSyncActivity: (projectId: string) => void;
  onManage: (projectId: string) => void;
  onClose: () => void;
}) {
  const [projectId, setProjectId] = useState(
    initialProjectId || state.projects[0]?.id || "",
  );
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const project = state.projects.find((item) => item.id === projectId);
  const [nameDraft, setNameDraft] = useState<{
    value: string | null;
    revision: number;
    requestId: string;
  } | null>(null);
  const savedName =
    project?.role === "owner" ? project.name : (project?.localName ?? null);
  const name = nameDraft ? nameDraft.value : savedName;
  const nameDirty = nameDraft !== null && (name?.trim() ?? null) !== savedName;
  const [sharing, setSharing] = useState(project?.sharing ?? legacySharing);
  const [savedSharing, setSavedSharing] = useState(sharing);
  const [sync, setSync] = useState(() => syncDraft(state));
  const [savedSync, setSavedSync] = useState(sync);
  const [serviceDirty, setServiceDirty] = useState(false);
  const [draftVersion, setDraftVersion] = useState(0);
  const [pending, setPending] = useState<Destination | null>(null);
  const [confirmation, setConfirmation] = useState<
    "disconnect" | "signout" | null
  >(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const setNotice = useToastNotice();
  const locked = useRef(false);
  const openingSync = useRef(false);
  const busy = workspaceBusy || saving;
  const dirty =
    section === "general"
      ? nameDirty
      : section === "sharing"
        ? Object.keys(sharing).some(
            (key) =>
              sharing[key as keyof typeof sharing] !==
              savedSharing[key as keyof typeof sharing],
          )
        : section === "sync"
          ? sync.minutes !== savedSync.minutes ||
            sync.background !== savedSync.background
          : serviceDirty;
  const canSave =
    section === "general" || section === "sharing" || section === "sync";
  const showFooter =
    canSave || dirty || Boolean(error) || section === "account";
  const queued = state.outbox.filter(
    (item) => item.project === projectId,
  ).length;

  const run = async (action: () => Promise<unknown>, message = "") => {
    if (locked.current || workspaceBusy) return false;
    locked.current = true;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await workspaceRun(action);
      setNotice(message);
      return true;
    } catch (error) {
      setError(String(error));
      return false;
    } finally {
      locked.current = false;
      setSaving(false);
    }
  };
  const reset = (id = projectId) => {
    const target = state.projects.find((item) => item.id === id);
    const next = target?.sharing ?? legacySharing;
    setSharing(next);
    setSavedSharing(next);
    setNameDraft(null);
    setSync(syncDraft(state));
    setSavedSync(syncDraft(state));
    setServiceDirty(false);
    setDraftVersion((value) => value + 1);
    setError("");
    setNotice("");
  };
  const navigate = (destination: Destination) => {
    setPending(null);
    if (destination === "close") {
      onClose();
      return;
    }
    if ("manage" in destination) {
      onManage(destination.manage);
      return;
    }
    reset(destination.projectId);
    setProjectId(destination.projectId);
    setSection(destination.section);
  };
  const request = (destination: Destination) => {
    if (busy || locked.current || pending !== null || confirmation) return;
    if (dirty) setPending(destination);
    else navigate(destination);
  };
  const changeSection = (next: SettingsSection) => {
    if (next !== section) request({ section: next, projectId });
  };
  const save = async () => {
    if (!dirty) return true;
    if (section === "general") {
      if (!project) {
        setError(
          "This project is no longer available. Your edits haven’t been saved.",
        );
        return false;
      }
      if (name !== null && (!name.trim() || name.trim().length > 100)) {
        setError("Enter a project name from 1 to 100 characters.");
        return false;
      }
      const saved = await run(async () => {
        await invoke("project_command", {
          action: project.role === "owner" ? "rename" : "local_name",
          input: {
            projectId,
            name: name?.trim() ?? null,
            ...(project.role === "owner" && nameDraft
              ? {
                  requestId: nameDraft.requestId,
                  expectedRevision: nameDraft.revision,
                }
              : {}),
          },
        });
      }, "Project name saved.");
      if (saved) setNameDraft(null);
      return saved;
    }
    if (section === "sharing") {
      if (!project) {
        setError(
          "This project is no longer available. Your edits haven’t been saved.",
        );
        return false;
      }
      return run(async () => {
        await invoke("project_command", {
          action: "sharing",
          input: { projectId, sharing },
        });
        setSavedSharing(sharing);
      }, "Sharing choices saved.");
    }
    if (section === "sync") {
      const minutes = Number(sync.minutes);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
        setError("Enter a whole number from 1 to 1440 minutes.");
        return false;
      }
      return run(async () => {
        // Acknowledged steps become the baseline even if a later step fails.
        if (sync.minutes !== savedSync.minutes) {
          await invoke("configure", {
            config: { ...state.config, syncMinutes: minutes },
          });
          setSavedSync((current) => ({ ...current, minutes: sync.minutes }));
        }
        if (sync.background !== savedSync.background) {
          await invoke("background_agent", { enabled: sync.background });
          setSavedSync((current) => ({
            ...current,
            background: sync.background,
          }));
        }
      }, "Sync preferences saved.");
    }
    return false;
  };
  const saveAndContinue = async () => {
    const destination = pending;
    if (destination !== null && (await save())) navigate(destination);
  };
  const confirm = async () => {
    if (confirmation === "disconnect") {
      if (!project || queued) {
        setError(
          "Finish syncing queued changes before disconnecting this folder.",
        );
        return;
      }
      if (
        await run(
          () => invoke("disconnect_project", { id: projectId }),
          "Folder disconnected. Local files are kept.",
        )
      )
        setConfirmation(null);
    } else if (confirmation === "signout") {
      if (await run(() => invoke("sign_out"))) onSignedOut();
    }
  };
  return (
    <>
      <Overlay
        open
        dismissOnBackdrop
        title="Settings"
        className="settings-modal"
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          if (!busy && pending !== null) setPending(null);
          else if (!busy && confirmation) setConfirmation(null);
          else request("close");
        }}
        onCloseAutoFocus={(event) => {
          if (openingSync.current) event.preventDefault();
        }}
        onClose={() => request("close")}
      >
        <SettingsNavigation
          projects={state.projects}
          projectId={projectId}
          section={section}
          disabled={busy}
          onProject={(id) => {
            if (id !== projectId)
              request({ projectId: id, section: "general" });
          }}
          onSection={changeSection}
        />
        <IconButton
          className="settings-close"
          icon={XIcon}
          variant="tertiary"
          size="sm"
          aria-label="Close settings"
          disabled={busy}
          onClick={() => request("close")}
        />
        <div className="settings-panel">
          <div className="settings-header">
            <h2>{settingsSections[section].label}</h2>
          </div>
          <div className="settings-content" key={`${projectId}:${section}`}>
            {!project && ["general", "sharing", "folder"].includes(section) ? (
              <p>
                {state.projects.length
                  ? "This project is no longer available. Choose another project above."
                  : "Create or join a project to manage its settings."}
              </p>
            ) : (
              <>
                {section === "general" && project && (
                  <SettingsGeneral
                    project={project}
                    name={name}
                    busy={busy}
                    onName={(value) => {
                      setNameDraft({
                        value,
                        requestId: crypto.randomUUID(),
                        revision:
                          nameDraft?.revision ?? project.lifecycleRevision ?? 0,
                      });
                      setNotice("");
                      setError("");
                    }}
                    onSection={changeSection}
                    onManage={() => request({ manage: projectId })}
                  />
                )}
                {section === "folder" && project && (
                  <SettingsFolder
                    run={run}
                    project={project}
                    queued={queued}
                    busy={busy}
                    onConnect={() => void run(() => connectProject(projectId))}
                    onDisconnect={() => {
                      setError("");
                      setConfirmation("disconnect");
                    }}
                    onSyncActivity={() => {
                      openingSync.current = true;
                      onSyncActivity(projectId);
                    }}
                  />
                )}
                {section === "sharing" && (
                  <ProjectSharingChoices
                    context="settings"
                    value={sharing}
                    disabled={busy}
                    onChange={(value) => {
                      setSharing(value);
                      setNotice("");
                      setError("");
                    }}
                  />
                )}
                {section === "sync" && (
                  <>
                    <TextField
                      label="Sync every (minutes)"
                      type="number"
                      min="1"
                      max="1440"
                      step="1"
                      required
                      value={sync.minutes}
                      disabled={busy}
                      onChange={(event) => {
                        setSync({ ...sync, minutes: event.target.value });
                        setNotice("");
                        setError("");
                      }}
                    />
                    <label className="settings-check">
                      <input
                        type="checkbox"
                        checked={sync.background}
                        disabled={busy}
                        onChange={(event) => {
                          setSync({
                            ...sync,
                            background: event.target.checked,
                          });
                          setNotice("");
                        }}
                      />
                      <span>
                        <strong>Run in the background</strong>
                        <span>
                          Start at login and sync while Orka is closed.
                        </span>
                      </span>
                    </label>
                  </>
                )}
                {section === "devices" && <SettingsDevices state={state} />}
                {section === "account" && (
                  <SettingsAccount
                    key={draftVersion}
                    state={state}
                    busy={busy}
                    run={run}
                    onDirty={setServiceDirty}
                    onSignedOut={onSignedOut}
                  />
                )}
              </>
            )}
          </div>
          {showFooter && (
            <footer className="settings-footer">
              <div className="settings-feedback" aria-live="polite">
                {!pending && !confirmation && error ? (
                  <p role="alert">{error}</p>
                ) : dirty ? (
                  <p>Unsaved changes</p>
                ) : null}
              </div>
              {dirty && (
                <Button size="sm" disabled={busy} onClick={() => reset()}>
                  {serviceDirty ? "Cancel setup" : "Discard"}
                </Button>
              )}
              {canSave && (
                <Button
                  size="sm"
                  variant="primary"
                  disabled={
                    busy ||
                    !dirty ||
                    (["general", "sharing"].includes(section) && !project)
                  }
                  onClick={() => void save()}
                >
                  {saving ? "Saving…" : "Save changes"}
                </Button>
              )}
              {section === "account" && !serviceDirty && (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setError("");
                    setConfirmation("signout");
                  }}
                >
                  Sign out
                </Button>
              )}
            </footer>
          )}
        </div>
      </Overlay>
      {pending !== null && (
        <Overlay
          open
          dismissOnBackdrop
          title={serviceDirty ? "Discard service setup?" : "Save your changes?"}
          className="settings-confirm"
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!busy) {
              setPending(null);
              setConfirmation(null);
            }
          }}
          onClose={() => {
            if (!busy) setPending(null);
          }}
        >
          <h2>
            {serviceDirty ? "Discard service setup?" : "Save your changes?"}
          </h2>
          {serviceDirty && <p>Your current service will stay connected.</p>}
          {error && <p role="alert">{error}</p>}
          <div className="settings-confirm-actions">
            <Button size="sm" disabled={busy} onClick={() => setPending(null)}>
              Keep editing
            </Button>
            <Button size="sm" disabled={busy} onClick={() => navigate(pending)}>
              Discard changes
            </Button>
            {!serviceDirty && (
              <Button
                size="sm"
                variant="primary"
                disabled={busy}
                onClick={() => void saveAndContinue()}
              >
                {saving ? "Saving…" : "Save and continue"}
              </Button>
            )}
          </div>
        </Overlay>
      )}
      {confirmation && (
        <Overlay
          open
          dismissOnBackdrop
          title={
            confirmation === "disconnect" ? "Disconnect folder?" : "Sign out?"
          }
          className="settings-confirm"
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!busy) {
              setPending(null);
              setConfirmation(null);
            }
          }}
          onClose={() => {
            if (!busy) setConfirmation(null);
          }}
        >
          <h2>
            {confirmation === "disconnect" ? "Disconnect folder?" : "Sign out?"}
          </h2>
          <p>
            {confirmation === "disconnect"
              ? `Disconnect “${project ? projectLabel(project) : "this project"}” on this Mac? Local and shared files are kept.`
              : "Projects and queued changes are kept. Sign in to this account again to resume sync."}
          </p>
          {error && <p role="alert">{error}</p>}
          <div className="settings-confirm-actions">
            <Button disabled={busy} onClick={() => setConfirmation(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={
                busy ||
                (confirmation === "disconnect" && (!project || queued > 0))
              }
              onClick={() => void confirm()}
            >
              {confirmation === "disconnect" ? "Disconnect folder" : "Sign out"}
            </Button>
          </div>
        </Overlay>
      )}
    </>
  );
}
