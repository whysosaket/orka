import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { forgetShapes } from "skullet";
import type { Snapshot } from "../../types.js";
import { Button } from "../button.js";
import { Overlay } from "../overlay.js";
import { Switch } from "../switch.js";
import { SegmentedControl } from "../segmented-control.js";
import { ActivityIndicator } from "../activity-indicator.js";
import { LoadingRegion } from "../loading-region.js";
import { legacySharing, ProjectSharingChoices } from "../project-sharing.js";
import { connectProject } from "../use-project-setup.js";
import {
  SettingsNavigation,
  type SettingsSection,
} from "./settings-navigation.js";
import { SettingsGeneral, SettingsFolder } from "./settings-sections.js";
import { SettingsDeviceScreen } from "./settings-devices.js";
import { SettingsProfile } from "./settings-profile.js";
import { SettingsMembers } from "./settings-members.js";
import { SettingsPermissions } from "./settings-permissions.js";
import { SettingsHeading, type SettingsEditor } from "./settings-shared.js";

export interface SettingsNavigationHandle {
  requestExit: (action: () => void) => void;
  requestSection: (section: SettingsSection) => void;
  requestProject: (projectId: string, action: () => void) => void;
}
type Destination =
  { section: SettingsSection; projectId: string } | (() => void) | "close";
const normalized = (section: SettingsSection) =>
  section === "folder" || section === "sharing" ? "general" : section;
const syncDraft = (state: Snapshot) => ({
  minutes: state.config ? String(state.config.syncMinutes ?? 15) : "",
  background: state.background,
});

export const SettingsModal = forwardRef<
  SettingsNavigationHandle,
  {
    state: Snapshot;
    initialProjectId: string;
    initialSection?: SettingsSection;
    onSectionChange?: (section: SettingsSection) => void;
    busy: boolean;
    run: (action: () => Promise<unknown>) => Promise<void>;
    onSignedOut: () => void;
    onSyncActivity: (projectId: string) => void;
    onManage: (projectId: string, section: "requests" | "logs") => void;
    onClose: () => void;
  }
>(function SettingsModal(
  {
    state,
    initialProjectId,
    initialSection = "general",
    onSectionChange,
    busy: workspaceBusy,
    run: workspaceRun,
    onSignedOut,
    onSyncActivity,
    onManage,
    onClose,
  },
  ref,
) {
  const [projectId, setProjectId] = useState(
    initialProjectId || state.projects[0]?.id || "",
  );
  const [section, setSection] = useState<SettingsSection>(
    normalized(initialSection),
  );
  const availableProject = state.projects.find((item) => item.id === projectId);
  const lastProject = useRef(availableProject);
  if (availableProject) lastProject.current = availableProject;
  const project =
    availableProject ??
    (lastProject.current?.id === projectId ? lastProject.current : undefined);
  const projectUnavailable = Boolean(project && !availableProject);
  const [nameDraft, setNameDraft] = useState<{
    value: string | null;
    revision: number;
    requestId: string;
    review?: { name: string; revision: number } | null;
  } | null>(null);
  const savedName =
    project?.role === "owner" ? project.name : (project?.localName ?? null);
  const name = nameDraft ? nameDraft.value : savedName;
  const nameDirty = nameDraft !== null && (name?.trim() ?? null) !== savedName;
  const [sharing, setSharing] = useState(project?.sharing ?? legacySharing),
    [savedSharing, setSavedSharing] = useState(sharing);
  const [sync, setSync] = useState(() => syncDraft(state)),
    [savedSync, setSavedSync] = useState(sync);
  const [serviceDirty, setServiceDirty] = useState(false),
    [draftVersion, setDraftVersion] = useState(0);
  const [pending, setPending] = useState<Destination | null>(null);
  const [confirmation, setConfirmation] = useState<{
    action: "disconnect" | "signout";
    sourceId?: string;
  } | null>(null);
  const [saving, setSaving] = useState(false),
    [folderBusy, setFolderBusy] = useState(false),
    [error, setError] = useState(""),
    [folderError, setFolderError] = useState(""),
    [notice, setNotice] = useState("");
  const editor = useRef<SettingsEditor>(null),
    locked = useRef(false),
    active = useRef(true),
    heading = useRef<HTMLDivElement>(null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    forgetShapes();
  }, [projectId]);
  useEffect(() => {
    if (initialSection === "folder" || initialSection === "sharing")
      document
        .getElementById(`settings-${initialSection}`)
        ?.scrollIntoView({ block: "start" });
  }, [initialSection]);
  const sharingDirty = Object.keys(sharing).some(
    (key) =>
      sharing[key as keyof typeof sharing] !==
      savedSharing[key as keyof typeof sharing],
  );
  const syncDirty =
    sync.minutes !== savedSync.minutes ||
    sync.background !== savedSync.background;
  const dirty = () =>
    section === "general"
      ? nameDirty || sharingDirty
      : section === "sync"
        ? syncDirty
        : serviceDirty || Boolean(editor.current?.dirty);
  const queued = state.outbox.filter(
    (item) => item.project === projectId,
  ).length;
  const busy = workspaceBusy || saving;
  const syncMinutes = state.config?.syncMinutes;
  const background = state.background;
  const hasConfig = Boolean(state.config);
  const [syncExtended, setSyncExtended] = useState(false);
  useEffect(() => {
    setSyncExtended(false);
    if (section !== "sync" || (hasConfig && background !== null)) return;
    const timer = window.setTimeout(() => setSyncExtended(true), 8000);
    return () => window.clearTimeout(timer);
  }, [section, hasConfig, background]);
  // Refresh local confirmed values only when the corresponding field has no draft.
  useEffect(() => {
    if (!sharingDirty && project?.sharing) {
      setSharing(project.sharing);
      setSavedSharing(project.sharing);
    }
  }, [project?.sharing, sharingDirty]);
  useEffect(() => {
    if (!syncDirty) {
      const next = {
        minutes: hasConfig ? String(syncMinutes ?? 15) : "",
        background,
      };
      setSync(next);
      setSavedSync(next);
    }
  }, [syncMinutes, background, syncDirty, hasConfig]);
  const run = async (action: () => Promise<unknown>, message = "") => {
    if (locked.current || workspaceBusy) return false;
    locked.current = true;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await workspaceRun(action);
      if (active.current) setNotice(message);
      return true;
    } catch (error) {
      if (active.current) setError(String(error));
      return false;
    } finally {
      locked.current = false;
      if (active.current) setSaving(false);
    }
  };
  const folderRun = async (action: () => Promise<unknown>) => {
    if (folderBusy || workspaceBusy) return false;
    setFolderBusy(true);
    setFolderError("");
    try {
      await workspaceRun(action);
      return true;
    } catch (error) {
      if (active.current) setFolderError(String(error));
      return false;
    } finally {
      if (active.current) setFolderBusy(false);
    }
  };
  const reset = (id = projectId) => {
    const target = state.projects.find((item) => item.id === id);
    const choices = target?.sharing ?? legacySharing;
    setSharing(choices);
    setSavedSharing(choices);
    setNameDraft(null);
    const preferences = syncDraft(state);
    setSync(preferences);
    setSavedSync(preferences);
    setServiceDirty(false);
    setDraftVersion((value) => value + 1);
    setError("");
    setFolderError("");
    setNotice("");
  };
  const navigate = (destination: Destination) => {
    setPending(null);
    editor.current?.discard();
    if (destination === "close") {
      onClose();
      return;
    }
    if (typeof destination === "function") {
      destination();
      return;
    }
    reset(destination.projectId);
    setProjectId(destination.projectId);
    setSection(normalized(destination.section));
    onSectionChange?.(normalized(destination.section));
    requestAnimationFrame(() =>
      heading.current?.querySelector<HTMLHeadingElement>("h2")?.focus(),
    );
  };
  const request = (destination: Destination) => {
    if (locked.current || pending || confirmation) return;
    if (dirty()) setPending(() => destination);
    else navigate(destination);
  };
  useImperativeHandle(ref, () => ({
    requestExit: (action) => request(action),
    requestProject: (id, action) =>
      request(() => {
        reset(id);
        setProjectId(id);
        action();
      }),
    requestSection: (next) => {
      if (normalized(next) !== section) request({ section: next, projectId });
    },
  }));
  const exitGuard = useRef({ dirty, request });
  exitGuard.current = { dirty, request };
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (exitGuard.current.dirty()) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", unload);
    if (!isTauri())
      return () => window.removeEventListener("beforeunload", unload);
    let disposed = false;
    const registration = listen<"close" | "quit">(
      "settings-close-requested",
      ({ payload }) => {
        exitGuard.current.request(() => {
          window.removeEventListener("beforeunload", unload);
          void invoke("finish_settings_close", {
            quit: payload === "quit",
          }).catch((error) => {
            window.addEventListener("beforeunload", unload);
            setError(String(error));
          });
        });
      },
    )
      .then(async (unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }
        await invoke("guard_settings_close", { enabled: true });
        return unlisten;
      })
      .catch((error) => {
        if (!disposed)
          setError(
            `Couldn’t protect unsaved changes when closing. ${String(error)}`,
          );
      });
    return () => {
      disposed = true;
      window.removeEventListener("beforeunload", unload);
      void registration.then(async (unlisten) => {
        if (unlisten) {
          unlisten();
          await invoke("guard_settings_close", { enabled: false });
        }
      });
    };
  }, []);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !pending &&
        !confirmation
      ) {
        event.preventDefault();
        request("close");
      }
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  });
  async function save() {
    if (
      projectUnavailable &&
      ["general", "permissions", "members"].includes(section)
    ) {
      setError(
        "This project is no longer available. Your draft is kept for copying.",
      );
      return false;
    }
    if (section === "account" || section === "permissions")
      return run(async () => {
        const result = await editor.current?.save();
        if (result !== true)
          throw new Error(result ?? "This editor is unavailable.");
      });
    if (!dirty()) return true;
    if (section === "general") {
      if (!project) {
        setError(
          "This project is no longer available. Your edits haven’t been saved.",
        );
        return false;
      }
      if (
        nameDirty &&
        name !== null &&
        (!name.trim() || name.trim().length > 100)
      ) {
        setError("Enter a project name from 1 to 100 characters.");
        return false;
      }
      if (
        nameDirty &&
        project.role === "owner" &&
        nameDraft &&
        (nameDraft.review !== undefined ||
          (project.lifecycleRevision ?? 0) !== nameDraft.revision)
      ) {
        if (nameDraft.review === undefined)
          setNameDraft({
            ...nameDraft,
            review: {
              name: project.name,
              revision: project.lifecycleRevision ?? 0,
            },
          });
        setError(
          "The project name changed. Review the latest name before saving.",
        );
        return false;
      }
      const completed: string[] = [];
      return run(async () => {
        try {
          if (nameDirty) {
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
            if (active.current) setNameDraft(null);
            completed.push("Project name saved.");
          }
          if (sharingDirty) {
            await invoke("project_command", {
              action: "sharing",
              input: { projectId, sharing },
            });
            if (active.current) setSavedSharing(sharing);
            completed.push("Sharing choices saved.");
          }
        } catch (error) {
          if (
            active.current &&
            nameDirty &&
            !completed.length &&
            String(error).includes("409:")
          )
            setNameDraft((draft) =>
              draft ? { ...draft, review: null } : draft,
            );
          throw new Error(`${completed.join(" ")} ${String(error)}`.trim(), {
            cause: error,
          });
        }
      }, "Changes saved.");
    }
    if (section === "sync") {
      if (!state.config || sync.background === null) {
        setError(
          "Sync preferences are unavailable. Try again after refreshing.",
        );
        return false;
      }
      const completed: string[] = [];
      return run(async () => {
        try {
          if (sync.minutes !== savedSync.minutes) {
            if (!["1", "5", "15"].includes(sync.minutes))
              throw new Error("Choose one of the three sync intervals.");
            await invoke("configure", {
              config: { ...state.config, syncMinutes: Number(sync.minutes) },
            });
            if (active.current)
              setSavedSync((current) => ({
                ...current,
                minutes: sync.minutes,
              }));
            completed.push("Sync interval saved.");
          }
          if (sync.background !== savedSync.background) {
            await invoke("background_agent", { enabled: sync.background });
            if (active.current)
              setSavedSync((current) => ({
                ...current,
                background: sync.background,
              }));
            completed.push("Background sync saved.");
          }
        } catch (error) {
          throw new Error(`${completed.join(" ")} ${String(error)}`.trim(), {
            cause: error,
          });
        }
      }, "Sync preferences saved.");
    }
    return false;
  }
  async function confirm() {
    if (confirmation?.action === "signout") {
      if (await run(() => invoke("sign_out"))) onSignedOut();
    } else if (confirmation?.action === "disconnect") {
      if (!project || queued) {
        setFolderError(
          "Finish syncing queued changes before disconnecting this folder.",
        );
        return;
      }
      const saved = await folderRun(() =>
        confirmation.sourceId
          ? invoke("disconnect_project_source", {
              id: projectId,
              sourceId: confirmation.sourceId,
            })
          : invoke("disconnect_project", { id: projectId }),
      );
      if (saved) {
        setConfirmation(null);
        setNotice(
          "Folder disconnected. Local files and shared content are kept.",
        );
      }
    }
  }
  return (
    <>
      <section className="settings-workspace" aria-label="Settings">
        <SettingsNavigation
          projects={state.projects}
          projectId={projectId}
          section={section}
          onSection={(next) => {
            if (next !== section) request({ section: next, projectId });
          }}
        />
        <div
          className="settings-panel"
          data-section={section}
          ref={heading}
          key={`${projectId}:${section}:${draftVersion}`}
        >
          {projectUnavailable &&
            ["general", "permissions", "members"].includes(section) && (
              <div>
                <p role="alert">
                  Access to {project!.name} is no longer available. Your draft
                  is read-only so you can copy it before leaving.
                </p>
                <textarea
                  className="settings-invite"
                  aria-label="Settings draft to copy"
                  readOnly
                  value={
                    section === "general"
                      ? `Project name: ${name ?? project!.name}\nSharing: ${JSON.stringify(sharing)}`
                      : (editor.current?.draftText?.() ?? "No unsaved text.")
                  }
                />
              </div>
            )}
          <fieldset
            className="settings-content"
            disabled={
              projectUnavailable &&
              ["general", "permissions", "members"].includes(section)
            }
          >
            {!project &&
            ["general", "members", "permissions"].includes(section) ? (
              <>
                <SettingsHeading
                  title={section[0].toUpperCase() + section.slice(1)}
                />
                <p>
                  {state.projects.length
                    ? "This project is no longer available. Choose another project."
                    : "Create or join a project to manage its settings."}
                </p>
              </>
            ) : (
              <>
                {section === "general" && project && (
                  <>
                    <SettingsHeading
                      title="General"
                      description="Project details and settings for this Mac."
                      action={
                        <Button
                          variant="primary"
                          disabled={busy || (!nameDirty && !sharingDirty)}
                          onClick={() => void save()}
                        >
                          {saving && <ActivityIndicator />}
                          {saving ? "Saving…" : "Save changes"}
                        </Button>
                      }
                    />
                    <SettingsGeneral
                      project={project}
                      name={name}
                      busy={busy}
                      onName={(value) => {
                        setNameDraft({
                          ...nameDraft,
                          value,
                          requestId: crypto.randomUUID(),
                          revision:
                            nameDraft?.revision ??
                            project.lifecycleRevision ??
                            0,
                        });
                        setError("");
                        setNotice("");
                      }}
                    />
                    {nameDraft?.review !== undefined && (
                      <div
                        className="settings-notice"
                        aria-label="Project name conflict"
                      >
                        <p>
                          The shared project name changed. Your draft is kept.
                        </p>
                        {nameDraft.review ? (
                          <>
                            <p>Your draft: {nameDraft.value}</p>
                            <p>Latest: {nameDraft.review.name}</p>
                            <div className="settings-inline-actions">
                              <Button
                                disabled={busy}
                                onClick={() => {
                                  setNameDraft(null);
                                  setError("");
                                }}
                              >
                                Use latest name
                              </Button>
                              <Button
                                disabled={busy}
                                onClick={() => {
                                  setNameDraft({
                                    value: nameDraft.value,
                                    revision: nameDraft.review!.revision,
                                    requestId: crypto.randomUUID(),
                                  });
                                  setError("");
                                }}
                              >
                                Keep my edit
                              </Button>
                            </div>
                          </>
                        ) : (
                          <Button
                            disabled={busy}
                            onClick={() =>
                              void run(async () => {
                                const result = await invoke<{
                                  projects: (Snapshot["projects"][number] & {
                                    revoked?: boolean;
                                    archivedAt?: string | null;
                                  })[];
                                }>("project_command", {
                                  action: "list",
                                  input: {},
                                });
                                const latest = result.projects.find(
                                  (item) =>
                                    item.id === projectId &&
                                    !item.revoked &&
                                    !item.archivedAt,
                                );
                                if (!latest)
                                  throw new Error(
                                    "This project is no longer available.",
                                  );
                                setNameDraft((draft) =>
                                  draft
                                    ? {
                                        ...draft,
                                        review: {
                                          name: latest.name,
                                          revision:
                                            latest.lifecycleRevision ?? 0,
                                        },
                                      }
                                    : draft,
                                );
                              })
                            }
                          >
                            Load latest name
                          </Button>
                        )}
                      </div>
                    )}
                    <section id="settings-folder" aria-label="Source folders">
                      <h3>Source Folder</h3>
                      <SettingsFolder
                        project={project}
                        run={folderRun}
                        queued={queued}
                        busy={folderBusy || workspaceBusy}
                        onConnect={() =>
                          void folderRun(() => connectProject(projectId))
                        }
                        onDisconnect={() =>
                          setConfirmation({ action: "disconnect" })
                        }
                        onDisconnectSource={(sourceId) =>
                          setConfirmation({ action: "disconnect", sourceId })
                        }
                        onSyncActivity={() =>
                          request(() => onSyncActivity(projectId))
                        }
                      />
                      {folderBusy && (
                        <p role="status">
                          <ActivityIndicator /> Updating source folders…
                        </p>
                      )}
                      {folderError && <p role="alert">{folderError}</p>}
                    </section>
                    <section id="settings-sharing" aria-label="Sharing">
                      <h3>Sharing</h3>
                      <ProjectSharingChoices
                        context="settings"
                        value={sharing}
                        disabled={busy}
                        onChange={(value) => {
                          setSharing(value);
                          setError("");
                          setNotice("");
                        }}
                      />
                    </section>
                  </>
                )}
                {section === "sync" && (
                  <>
                    <SettingsHeading
                      title="Sync & startup"
                      description="Applies to all projects on this Mac."
                      action={
                        <Button
                          variant="primary"
                          disabled={
                            busy ||
                            !syncDirty ||
                            !state.config ||
                            sync.background === null
                          }
                          onClick={() => void save()}
                        >
                          {saving && <ActivityIndicator />}
                          {saving ? "Saving…" : "Save changes"}
                        </Button>
                      }
                    />
                    <div className="settings-group settings-sync-group">
                      <div className="settings-row">
                        <div>
                          <h3>Sync interval</h3>
                          <p>How often Orka checks for project updates.</p>
                          {sync.minutes &&
                            !["1", "5", "15"].includes(sync.minutes) && (
                              <p>
                                Current interval: {sync.minutes} minutes. Kept
                                until you choose a preset.
                              </p>
                            )}
                        </div>
                        <LoadingRegion
                          id="settings-sync-interval"
                          label="Loading sync interval…"
                          data={hasConfig ? sync.minutes : null}
                          sample="15"
                          loading={!hasConfig}
                        >
                          {(minutes) => (
                            <SegmentedControl
                              label="Sync interval"
                              value={minutes}
                              options={[
                                { value: "1", label: "1 min" },
                                { value: "5", label: "5 min" },
                                { value: "15", label: "15 min" },
                              ]}
                              disabled={busy || !state.config}
                              onChange={(minutes) => {
                                setSync({ ...sync, minutes });
                                setNotice("");
                              }}
                            />
                          )}
                        </LoadingRegion>
                      </div>
                      <div className="settings-row">
                        <div>
                          <h3>Background sync</h3>
                          <p>
                            Start at login and keep syncing when Orka is closed.
                          </p>
                        </div>
                        <LoadingRegion
                          id="settings-background"
                          label="Loading background sync preference…"
                          data={sync.background}
                          sample={false}
                          loading={sync.background === null}
                        >
                          {(background) => (
                            <Switch
                              aria-label="Background sync"
                              checked={background}
                              disabled={busy || sync.background === null}
                              onChange={(event) => {
                                setSync({
                                  ...sync,
                                  background: event.target.checked,
                                });
                                setNotice("");
                              }}
                            />
                          )}
                        </LoadingRegion>
                      </div>
                    </div>
                    {syncExtended && (
                      <p>
                        Still checking preferences. You can use the other
                        settings.{" "}
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() => void run(async () => {})}
                        >
                          Retry
                        </Button>
                      </p>
                    )}
                  </>
                )}
                {section === "devices" && (
                  <SettingsDeviceScreen state={state} />
                )}
                {section === "account" && (
                  <SettingsProfile
                    ref={editor}
                    state={state}
                    onSignedOut={onSignedOut}
                    onSignOut={() =>
                      request(() => setConfirmation({ action: "signout" }))
                    }
                    onStartService={(action) => request(action)}
                    run={run}
                    onServiceDirty={setServiceDirty}
                  />
                )}
                {section === "members" && project && (
                  <SettingsMembers
                    state={state}
                    project={project}
                    onReviews={() =>
                      request(() => onManage(projectId, "requests"))
                    }
                    onLogs={() => request(() => onManage(projectId, "logs"))}
                  />
                )}
                {section === "permissions" && project && (
                  <SettingsPermissions
                    ref={editor}
                    state={state}
                    project={project}
                  />
                )}
              </>
            )}
            {error && <p role="alert">{error}</p>}
            {notice && <p role="status">{notice}</p>}
          </fieldset>
        </div>
      </section>
      {pending !== null && (
        <Overlay
          open
          title={serviceDirty ? "Discard service setup?" : "Save your changes?"}
          className="settings-confirm"
          onClose={() => {
            if (!saving) setPending(null);
          }}
        >
          <h2>
            {serviceDirty ? "Discard service setup?" : "Save your changes?"}
          </h2>
          {serviceDirty && <p>Your current service will stay connected.</p>}
          {editor.current?.pendingSave && (
            <p>
              The save may already have reached the service. Leave and check its
              outcome later.
            </p>
          )}
          {error && <p role="alert">{error}</p>}
          <div className="settings-confirm-actions">
            <Button disabled={saving} onClick={() => setPending(null)}>
              Stay
            </Button>
            <Button disabled={saving} onClick={() => navigate(pending)}>
              {editor.current?.pendingSave
                ? "Leave and check later"
                : "Discard"}
            </Button>
            {!serviceDirty && (
              <Button
                variant="primary"
                disabled={saving}
                onClick={() => {
                  const destination = pending;
                  void save().then((saved) => {
                    if (saved && active.current) navigate(destination);
                  });
                }}
              >
                {saving ? <ActivityIndicator /> : null}Save
              </Button>
            )}
          </div>
        </Overlay>
      )}
      {confirmation && (
        <Overlay
          open
          title={
            confirmation.action === "disconnect"
              ? "Disconnect folder?"
              : "Sign out?"
          }
          className="settings-confirm"
          onClose={() => {
            if (!busy && !folderBusy) setConfirmation(null);
          }}
        >
          <h2>
            {confirmation.action === "disconnect"
              ? "Disconnect folder?"
              : "Sign out?"}
          </h2>
          <p>
            {confirmation.action === "disconnect"
              ? "Disconnect this folder on this Mac? Local files and shared content are kept."
              : "Projects and queued changes are kept. Sign in to this account again to resume sync."}
          </p>
          {confirmation.action === "disconnect"
            ? folderError && <p role="alert">{folderError}</p>
            : error && <p role="alert">{error}</p>}
          <div className="settings-confirm-actions">
            <Button
              disabled={busy || folderBusy}
              onClick={() => setConfirmation(null)}
            >
              Stay
            </Button>
            <Button
              variant="primary"
              disabled={
                busy ||
                folderBusy ||
                (confirmation.action === "disconnect" &&
                  (!project || queued > 0))
              }
              onClick={() => void confirm()}
            >
              {(saving || folderBusy) && <ActivityIndicator />}
              {confirmation.action === "disconnect"
                ? "Disconnect folder"
                : "Sign out"}
            </Button>
          </div>
        </Overlay>
      )}
    </>
  );
});
