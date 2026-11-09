import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  CheckCircleFillIcon,
  AlertFillIcon,
  DotFillIcon,
  FileDirectoryIcon,
  KebabHorizontalIcon,
  PlusIcon,
  SyncIcon,
  XIcon,
} from "@primer/octicons-react";
import type { RepositoryAccessRequest } from "@portable/protocol";
import type { Project, Snapshot } from "../types.js";
import { Button } from "./button.js";
import { IconButton } from "./icon-button.js";
import { TextField } from "./text-field.js";
import { Overlay } from "./overlay.js";
import { ActionPopover } from "./resource-actions.js";
import { connectProject } from "./use-project-setup.js";
import {
  RepositoryPicker,
  type RepositorySource,
} from "./repository-picker.js";
import { useRepositories, useRepositoryCommand } from "./use-repositories.js";
export { useRepositoryCommand } from "./use-repositories.js";

type ConnectionDialog = {
  kind: "connect" | "request";
  source?: RepositorySource;
} | null;
export function RepositoryConnections({
  project,
  state,
  refresh,
  renderLocalFolders,
  onLocalFolder,
  onDisconnectSource,
  folderBusy = false,
  queued = 0,
  initiallyOpen = false,
  initialSource,
  dialogOnly = false,
  onClose,
  onConnecting,
}: {
  project: Project;
  state: Snapshot;
  refresh: () => Promise<unknown>;
  renderLocalFolders?: (
    enabled: boolean,
    onLink: (source: RepositorySource) => void,
  ) => ReactNode;
  onLocalFolder?: () => Promise<unknown>;
  onDisconnectSource?: (sourceId: string) => void;
  folderBusy?: boolean;
  queued?: number;
  initiallyOpen?: boolean;
  initialSource?: RepositorySource;
  dialogOnly?: boolean;
  onClose?: () => void;
  onConnecting?: () => void;
}) {
  const controller = useRepositories(project, state, refresh);
  const { call, enabled, busy, access, jobs, run, error, status } = controller;
  const multipleSources =
    (project.sources ?? []).filter(
      (source) =>
        source.repository &&
        (!source.path || source.folderState === "reconnect"),
    ).length > 1;
  const [dialog, setDialog] = useState<ConnectionDialog>(
    initiallyOpen && !multipleSources
      ? { kind: "connect", source: initialSource }
      : null,
  );
  const [reason, setReason] = useState("");
  const [requested, setRequested] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const denied = Object.values(access).some(
    (value) => value.state === "access_unavailable",
  );
  useEffect(() => {
    if (!denied) return;
    let canceled = false;
    void call<{ items: RepositoryAccessRequest[] }>("requests", {
      projectId: project.id,
    })
      .then((value) => {
        if (!canceled)
          setRequested(
            value.items
              .filter(
                (request) =>
                  request.requester === state.user &&
                  [
                    "requested",
                    "waiting_on_github",
                    "invitation_pending",
                  ].includes(request.status),
              )
              .map((request) => request.sourceId),
          );
      })
      .catch(() => {});
    return () => {
      canceled = true;
    };
  }, [call, denied, project.id, state.user]);
  const close = () => {
    setDialog(null);
    onClose?.();
  };
  const openPicker = (source?: RepositorySource) => {
    setNotice("");
    setDialog({ kind: "connect", source });
  };
  if (!enabled) return <>{renderLocalFolders?.(false, openPicker)}</>;
  const disabled = busy || folderBusy;
  const sources = (project.sources ?? []).filter((source) => source.repository);
  const needsAccountConnection =
    !status?.connected ||
    Object.values(access).some((value) =>
      ["not_connected", "reconnect"].includes(value.state),
    );
  const dialogUi =
    dialog?.kind === "connect" ? (
      <RepositoryPicker
        project={project}
        source={
          dialog.source
            ? (project.sources?.find(
                (source) => source.id === dialog.source?.id,
              ) ?? dialog.source)
            : undefined
        }
        controller={controller}
        onClose={close}
        onRequestAccess={(source) => {
          setReason("");
          setDialog({ kind: "request", source });
        }}
        onLocalFolder={
          onLocalFolder ??
          (async () => {
            const connected = await connectProject(project.id);
            if (connected) await refresh();
            return connected;
          })
        }
        onConnected={() => {
          close();
          onConnecting?.();
        }}
      />
    ) : (
      dialog?.source && (
        <Overlay
          open
          title="Request repository access"
          className="repository-dialog"
          onClose={() => {
            if (!busy) close();
          }}
        >
          <div className="repository-dialog-heading">
            <h2>Request access</h2>
            <IconButton
              icon={XIcon}
              size="sm"
              variant="tertiary"
              aria-label="Close access request"
              disabled={busy}
              onClick={close}
            />
          </div>
          <p>{dialog.source.repository?.fullName}</p>
          <TextField
            label="Reason for repository access"
            maxLength={1000}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <p>A project owner will coordinate access on GitHub.</p>
          <details className="repository-help">
            <summary>Already have repository access?</summary>
            <p>
              Orka may need permission to use this repository. Your organization
              may require approval.
            </p>
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(() => controller.openGitHub(status!.installationUrl))
              }
            >
              Manage GitHub access
            </Button>
          </details>
          <div className="repository-dialog-footer">
            <span />
            <Button
              variant="primary"
              disabled={busy || !reason.trim()}
              onClick={() =>
                void run(async () => {
                  const sourceId = dialog.source!.id;
                  await call("request-access", {
                    projectId: project.id,
                    sourceId,
                    reason,
                  });
                  setRequested((values) => [...values, sourceId]);
                  setNotice(
                    "Access request sent. Follow it in Settings → Members.",
                  );
                  close();
                })
              }
            >
              {busy ? "Sending…" : "Send request"}
            </Button>
          </div>
          {error && <p role="alert">{error}</p>}
        </Overlay>
      )
    );
  const content = (
    <section
      aria-label="Project repositories"
      className="repository-connections"
    >
      <div className="settings-group settings-source-list">
        {renderLocalFolders?.(true, openPicker)}
        {sources.map((source) => {
          const value = access[source.id];
          const job = jobs.find(
            (job) => job.sourceId === source.id && job.state !== "connected",
          );
          const active =
            job && ["queued", "cloning", "connecting"].includes(job.state);
          const ready = value?.state === "ready";
          const needsGithub =
            value && ["not_connected", "reconnect"].includes(value.state);
          const denied = value?.state === "access_unavailable";
          const failed = value?.state === "unavailable";
          const connected = Boolean(
            source.path && source.folderState !== "reconnect",
          );
          const label = !value
            ? "Checking GitHub access"
            : ready
              ? "GitHub access verified"
              : denied
                ? "GitHub access required"
                : needsGithub
                  ? "Connect GitHub to verify access"
                  : "Could not check GitHub access";
          const StatusIcon = ready
            ? CheckCircleFillIcon
            : value
              ? AlertFillIcon
              : DotFillIcon;
          return (
            <div className="repository-card-row" key={source.id}>
              <div className="repository-card-main">
                <FileDirectoryIcon size={18} aria-hidden="true" />
                <div className="repository-card-identity">
                  <strong>{source.repository!.fullName}</strong>
                  <span className="repository-card-meta">
                    {active
                      ? job.message
                      : connected
                        ? "Connected on this Mac"
                        : source.folderState === "reconnect"
                          ? "Folder needs reconnecting"
                          : "Not connected on this Mac"}
                  </span>
                </div>
                <span
                  className="repository-access-icon"
                  data-state={ready ? "ready" : value ? "warning" : "checking"}
                  role="img"
                  aria-label={label}
                  title={`${label}${value?.checkedAt ? ` · ${new Date(value.checkedAt).toLocaleString()}` : ""}`}
                >
                  <StatusIcon size={16} />
                </span>
                <div className="repository-card-actions">
                  {active ? (
                    job.state !== "connecting" && (
                      <IconButton
                        icon={XIcon}
                        size="sm"
                        variant="tertiary"
                        aria-label={`Cancel clone for ${source.name}`}
                        title="Cancel clone"
                        onClick={() =>
                          void run(async () => {
                            await call("cancel-clone", { id: job.id });
                          })
                        }
                      />
                    )
                  ) : job?.folderIdentity && ready ? (
                    <Button
                      size="sm"
                      disabled={disabled}
                      onClick={() =>
                        void run(async () => {
                          await call("retry-connect", { id: job.id });
                          await refresh();
                        })
                      }
                    >
                      Finish connecting
                    </Button>
                  ) : needsGithub ? null : denied ? (
                    <Button
                      size="sm"
                      disabled={disabled || requested.includes(source.id)}
                      onClick={() => {
                        setReason("");
                        setDialog({ kind: "request", source });
                      }}
                    >
                      {requested.includes(source.id)
                        ? "Request sent"
                        : "Request access"}
                    </Button>
                  ) : failed ? (
                    <IconButton
                      icon={SyncIcon}
                      size="sm"
                      variant="tertiary"
                      aria-label={`Retry access check for ${source.name}`}
                      title="Retry access check"
                      disabled={disabled}
                      onClick={() =>
                        void run(() => controller.recheck(source.id))
                      }
                    />
                  ) : (
                    !connected && (
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={disabled || !ready}
                        onClick={() =>
                          source.path
                            ? void run(async () => {
                                await connectProject(
                                  project.id,
                                  source.id,
                                  source.path!,
                                );
                                await refresh();
                              })
                            : openPicker(source)
                        }
                      >
                        {source.path ? "Reconnect" : "Connect"}
                      </Button>
                    )
                  )}
                  <ActionPopover
                    label={`Options for ${source.name}`}
                    trigger={
                      <IconButton
                        icon={KebabHorizontalIcon}
                        size="sm"
                        variant="tertiary"
                        aria-label={`Options for ${source.name}`}
                        disabled={disabled || Boolean(active)}
                      />
                    }
                  >
                    {!connected && (
                      <Button
                        size="sm"
                        onClick={() =>
                          void run(async () => {
                            await connectProject(
                              project.id,
                              source.id,
                              source.path ?? undefined,
                            );
                            await refresh();
                          })
                        }
                      >
                        Use existing folder
                      </Button>
                    )}
                    {connected && onDisconnectSource && (
                      <Button
                        size="sm"
                        disabled={queued > 0}
                        onClick={() => onDisconnectSource(source.id)}
                      >
                        Disconnect folder on this Mac
                      </Button>
                    )}
                    {value && !ready && (
                      <Button
                        size="sm"
                        onClick={() =>
                          void run(() => controller.recheck(source.id))
                        }
                      >
                        Refresh access
                      </Button>
                    )}
                    {project.role === "owner" && (
                      <Button
                        size="sm"
                        onClick={() =>
                          void run(async () => {
                            await call("unlink", {
                              projectId: project.id,
                              sourceId: source.id,
                              expectedRevision:
                                source.repositoryRevision ??
                                source.repository!.revision,
                            });
                            await refresh();
                          })
                        }
                      >
                        Remove GitHub link
                      </Button>
                    )}
                  </ActionPopover>
                </div>
              </div>
              {job && !active && (
                <p className="repository-job-feedback" role="status">
                  {job.message}
                </p>
              )}
            </div>
          );
        })}
        {(needsAccountConnection || project.role === "owner") && (
          <div className="settings-add-folder-row">
            <Button
              variant={needsAccountConnection ? "primary" : "tertiary"}
              className={
                needsAccountConnection ? undefined : "settings-add-folder"
              }
              disabled={disabled}
              onClick={() =>
                openPicker(needsAccountConnection ? sources[0] : undefined)
              }
            >
              {!needsAccountConnection && (
                <PlusIcon size={16} aria-hidden="true" />
              )}
              {needsAccountConnection ? "Connect GitHub" : "Connect repository"}
            </Button>
          </div>
        )}
      </div>
      {notice && <p role="status">{notice}</p>}
      {error && !dialog && <p role="alert">{error}</p>}
      {dialogUi}
    </section>
  );
  if (dialogOnly && multipleSources)
    return (
      <Overlay
        open
        title="Connect project repositories"
        className="repository-dialog"
        onClose={close}
      >
        <div className="repository-dialog-heading">
          <h2>Connect repositories</h2>
          <IconButton
            icon={XIcon}
            variant="tertiary"
            size="sm"
            aria-label="Close project repository setup"
            onClick={close}
          />
        </div>
        {content}
      </Overlay>
    );
  return dialogOnly ? dialogUi : content;
}

export function RepositoryRequests({
  project,
  state,
}: {
  project: Project;
  state: Snapshot;
}) {
  const call = useRepositoryCommand(state);
  const [requests, setRequests] = useState<RepositoryAccessRequest[]>([]);
  const [enabled, setEnabled] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const load = useCallback(
    async (offset = 0) => {
      const value = await call<{
        items: RepositoryAccessRequest[];
        nextOffset: number | null;
      }>("requests", { projectId: project.id, offset });
      setRequests((previous) =>
        offset ? [...previous, ...value.items] : value.items,
      );
      setNextOffset(value.nextOffset);
    },
    [call, project.id],
  );
  useEffect(() => {
    let canceled = false;
    void call<{ enabled: boolean }>("capabilities")
      .then(async (value) => {
        if (!canceled && value.enabled) {
          setEnabled(true);
          await load();
        }
      })
      .catch((e) => {
        if (!canceled) setError(String(e));
      });
    return () => {
      canceled = true;
    };
  }, [call, load]);
  if (!enabled) return null;
  const review = async (request: RepositoryAccessRequest, status: string) => {
    setBusy(true);
    setError("");
    try {
      await call("review", {
        projectId: project.id,
        id: request.id,
        expectedRevision: request.revision,
        status,
        note:
          notes[request.id] ||
          (status === "canceled" ? "Canceled by requester" : ""),
      });
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="repository-panel"
      aria-label="Repository access requests"
    >
      <h3>Repository access requests</h3>
      <p>
        Project owners coordinate grants in GitHub. Access becomes verified only
        after the requester checks GitHub access.
      </p>
      <Button
        size="sm"
        disabled={busy}
        onClick={() => void load().catch((e) => setError(String(e)))}
      >
        Refresh repository requests
      </Button>
      {requests.length === 0 && <p>No repository access requests.</p>}
      {requests.map((request) => (
        <div key={request.id} className="repository-source">
          <h3>
            {request.fullName} · @{request.githubLogin}
          </h3>
          <p>{request.reason}</p>
          <p>Status: {request.status.replaceAll("_", " ")}</p>
          {request.note && <p>{request.note}</p>}
          {["requested", "waiting_on_github", "invitation_pending"].includes(
            request.status,
          ) && (
            <>
              <div className="actions">
                <Button
                  size="sm"
                  onClick={() =>
                    void call("open-github", {
                      url: `https://github.com/${request.fullName}`,
                    }).catch((e) => setError(String(e)))
                  }
                >
                  Open repository on GitHub
                </Button>
              </div>
              {request.canReview && (
                <>
                  <TextField
                    label={`Review note for ${request.githubLogin}`}
                    value={notes[request.id] ?? ""}
                    maxLength={1000}
                    onChange={(event) =>
                      setNotes((previous) => ({
                        ...previous,
                        [request.id]: event.target.value,
                      }))
                    }
                  />
                  <div className="actions">
                    {[
                      ["waiting_on_github", "Coordinate in GitHub"],
                      ["invitation_pending", "Invitation sent"],
                      ["rejected", "Reject request"],
                    ].map(([status, label]) => (
                      <Button
                        key={status}
                        size="sm"
                        disabled={busy || !notes[request.id]?.trim()}
                        onClick={() => void review(request, status)}
                      >
                        {label}
                      </Button>
                    ))}
                  </div>
                </>
              )}
              {request.requester === state.user && (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void review(request, "canceled")}
                >
                  Cancel repository request
                </Button>
              )}
            </>
          )}
        </div>
      ))}
      {nextOffset !== null && (
        <Button
          size="sm"
          disabled={busy}
          onClick={() =>
            void load(nextOffset).catch((e) => setError(String(e)))
          }
        >
          Load more requests
        </Button>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
