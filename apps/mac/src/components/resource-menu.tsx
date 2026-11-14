import React, {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { FileIcon, SyncIcon } from "@primer/octicons-react";
import type {
  Project,
  ProjectResource,
  Snapshot,
  SyncProgress,
} from "../types.js";
import {
  ItemContextMenu,
  ItemMenuButton,
  type ItemMenuAction,
} from "./item-menu.js";
import { Overlay } from "./overlay.js";
import { Button } from "./button.js";
import { Icon } from "./icon.js";
import { SessionLauncher } from "./session-launcher.js";
import type { ResourceView } from "./use-resource-view.js";
import { sourcePath } from "./project-sources.js";
import { skillReviewState } from "./skill-review-state.js";
import { useResourceActions, type Run } from "./use-resource-actions.js";

interface ResourceMenuContextValue {
  scope: string;
  state: Snapshot;
  busy: boolean;
  act: Run;
  onOpen: (resource: ProjectResource, compare?: boolean) => void;
  onReview: (resource: ProjectResource, mode: "incoming" | "outgoing") => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
  onRefresh: () => Promise<void>;
  isCurrent: (resource: ProjectResource) => boolean;
  request: (
    kind: "share" | "delete" | "launch",
    resource: ProjectResource,
  ) => void;
}

const ResourceMenuContext = createContext<ResourceMenuContextValue | null>(
  null,
);
const identity = (resource: ProjectResource) =>
  JSON.stringify([
    resource.projectId,
    resource.resourceId,
    resource.revision,
    resource.hash,
    resource.files,
  ]);

export function canDeleteSharedResource(
  resource: ProjectResource,
  project: Project,
  state: Snapshot,
) {
  if (
    resource.local ||
    resource.localChanges ||
    resource.revision < 1 ||
    resource.deleted
  )
    return false;
  if (
    resource.kind === "memory" &&
    (!project.governed ||
      resource.source !== "shared" ||
      resource.logicalPath.startsWith("instructions/"))
  )
    return false;
  const category = resource.kind;
  const access =
    resource.access?.mode ??
    state.governance?.find((entry) => entry.projectId === project.id)?.catalog
      .access[category]?.mode ??
    (project.role === "owner" || !project.governed ? "publish" : "read");
  if (project.rolePolicies)
    return (
      project.role === "owner" ||
      (project.role === "admin" && access === "publish")
    );
  return (
    access === "publish" &&
    (resource.kind !== "session" || resource.owner === state.user)
  );
}

export function ResourceMenuProvider({
  resources,
  children,
  ...props
}: Omit<ResourceMenuContextValue, "isCurrent" | "request"> & {
  resources: ProjectResource[];
  children: React.ReactNode;
}) {
  const currentResources = useRef(resources);
  currentResources.current = resources;
  const scope = useRef(props.scope);
  scope.current = props.scope;
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const [request, setRequest] = useState<{
    kind: "share" | "delete" | "launch";
    resource: ProjectResource;
    scope: string;
  } | null>(null);
  useEffect(() => {
    setRequest(null);
  }, [props.scope]);
  const isCurrent = (resource: ProjectResource) =>
    active.current &&
    scope.current === props.scope &&
    currentResources.current.some(
      (item) => !item.deleted && identity(item) === identity(resource),
    );
  const context: ResourceMenuContextValue = {
    ...props,
    isCurrent,
    request: (kind, resource) => {
      if (isCurrent(resource))
        setRequest({ kind, resource, scope: props.scope });
    },
  };
  return (
    <ResourceMenuContext.Provider value={context}>
      {children}
      {request && request.scope === props.scope && (
        <ResourceCommandDialog
          key={`${props.scope}:${request.kind}:${identity(request.resource)}`}
          kind={request.kind}
          resource={request.resource}
          context={context}
          onClose={() => setRequest(null)}
        />
      )}
    </ResourceMenuContext.Provider>
  );
}

export function resourceViewMenuActions(
  view: ResourceView,
  session: boolean,
): ItemMenuAction[] {
  const items: ItemMenuAction[] = [];
  if (view.changes)
    items.push({
      id: "show-content",
      label: "Show content",
      onSelect: () => view.setChanges(false),
    });
  if (session ? !view.fullTranscript : view.canRenderMarkdown && !view.changes)
    items.push({
      id: "markdown",
      label: view.rawMarkdown ? "Show formatted" : "Show Markdown",
      onSelect: () => view.setRawMarkdown((value) => !value),
    });
  return items;
}

function resourceMenuFacts(resource: ProjectResource) {
  return (
    <div className="resource-diagnostics" role="note">
      {!resource.local && resource.revision > 0 && (
        <p>Revision {resource.revision}</p>
      )}
      <p>{resource.logicalPath}</p>
      <p>Stored as “{resource.title}”</p>
    </div>
  );
}

function ResourceMenuTarget({
  resource,
  file,
  extraActions = [],
  children,
}: {
  resource: ProjectResource;
  file?: string;
  extraActions?: ItemMenuAction[];
  children: (actions: ItemMenuAction[]) => React.ReactNode;
}) {
  const context = useContext(ResourceMenuContext)!;
  const project = context.state.projects.find(
    (item) => item.id === resource.projectId,
  );
  const actions = useResourceActions({
    act: context.act,
    resource,
    user: context.state.user,
    onNotice: context.onNotice,
    scope: context.scope,
  });
  if (!project) return children([]);
  const shared = !resource.local && resource.revision > 0;
  const connected = Boolean(sourcePath(project, resource.sourceId));
  const selectedFile =
    file ??
    (resource.kind === "skill" ? "SKILL.md" : (resource.files[0]?.path ?? ""));
  const input = {
    accountId: context.state.user,
    serviceOrigin: context.state.config?.apiUrl,
    projectId: project.id,
    resourceId: resource.resourceId,
  };
  const copy = (load: () => Promise<string>, successTitle: string) => {
    void context.act(
      async () => {
        const text = await load();
        if (!context.isCurrent(resource))
          throw new Error("This item changed. Open its actions again.");
        await navigator.clipboard.writeText(text);
      },
      { successTitle, errorTitle: "Couldn’t copy", retryable: true },
    );
  };
  const review = skillReviewState(resource, context.state, project);
  const items: ItemMenuAction[] = [
    { id: "open", label: "Open", onSelect: () => context.onOpen(resource) },
  ];
  if (resource.kind === "session") {
    items.push({
      id: "launch",
      label: "Continue or fork in…",
      disabled: context.busy,
      onSelect: () => context.request("launch", resource),
    });
    items.push({
      id: "prompt",
      label: "Copy session prompt",
      disabled: context.busy,
      onSelect: () => copy(actions.sessionPrompt, "Session prompt copied"),
    });
    if (shared && !resource.localChanges)
      items.push({
        id: "copy",
        label: "Create copy",
        disabled: context.busy,
        onSelect: () => void actions.sessionAction("copy"),
      });
  } else {
    items.push({
      id: "editor",
      label: "Open in editor",
      disabled: context.busy || !connected,
      reason: !connected
        ? "Connect this repository on this Mac first"
        : undefined,
      onSelect: () => void actions.openEditor(selectedFile),
    });
    items.push({
      id: "content",
      label: resource.kind === "skill" ? "Copy file content" : "Copy content",
      disabled: context.busy,
      onSelect: () =>
        copy(async () => {
          const result = await invoke<{ content: string | null }>(
            "inspect_resource",
            { id: resource.resourceId, file: selectedFile, conflictId: null },
          );
          if (result.content === null)
            throw new Error("This file has no text preview.");
          return result.content;
        }, "Content copied"),
    });
    if (shared && !resource.localChanges)
      items.push({
        id: "compare",
        label: "Compare with previous revision",
        onSelect: () => context.onOpen(resource, true),
      });
  }
  if (shared)
    items.push({
      id: "link",
      label: resource.localChanges ? "Copy shared snapshot link" : "Copy link",
      onSelect: () =>
        copy(
          () =>
            Promise.resolve(
              `orka://project/${project.id}/${resource.resourceId}`,
            ),
          "Link copied",
        ),
    });
  if (connected) {
    items.push({
      id: "reveal",
      label: "Show in Finder",
      disabled: context.busy,
      onSelect: () =>
        void context.act(
          () => invoke("resource_command", { action: "reveal", input }),
          { errorTitle: "Couldn’t show this item in Finder" },
        ),
    });
    items.push({
      id: "path",
      label: "Copy local path",
      disabled: context.busy,
      onSelect: () =>
        copy(
          async () =>
            (
              await invoke<{ paths: string[] }>("resource_command", {
                action: "paths",
                input,
              })
            ).paths.join("\n"),
          "Local path copied",
        ),
    });
  }
  if (
    (resource.local || resource.localChanges) &&
    resource.sharing !== "queued" &&
    resource.sharing !== "approval" &&
    (resource.kind === "skill" || resource.owner === context.state.user)
  )
    items.push({
      id: "share",
      label: "Share snapshot with project…",
      separator: true,
      disabled: context.busy || !connected,
      reason: !connected
        ? "Connect this repository on this Mac first"
        : undefined,
      onSelect: () => context.request("share", resource),
    });
  if (review.incoming)
    items.push({
      id: "review-incoming",
      label: "Review local update…",
      onSelect: () => context.onReview(resource, "incoming"),
    });
  if (review.outgoing)
    items.push({
      id: "review-outgoing",
      label: "Review local edits…",
      onSelect: () => context.onReview(resource, "outgoing"),
    });
  if (
    resource.kind === "memory" &&
    shared &&
    project.governed &&
    resource.logicalPath.startsWith("instructions/")
  )
    items.push({
      id: "review-instructions",
      label: "Review local update…",
      onSelect: () => context.onReview(resource, "incoming"),
    });
  if (resource.kind !== "memory")
    items.push({
      id: "export",
      label:
        resource.kind === "session"
          ? "Download session (.zip)…"
          : "Export ZIP…",
      disabled: context.busy,
      onSelect: () => void actions.exportZip(),
    });
  items.push(...extraActions);
  if (canDeleteSharedResource(resource, project, context.state))
    items.push({
      id: "delete",
      label:
        resource.kind === "session"
          ? "Remove from history…"
          : `Delete shared ${resource.kind}…`,
      separator: true,
      danger: true,
      disabled: context.busy,
      onSelect: () => context.request("delete", resource),
    });
  return children(
    items.map((item) => ({
      ...item,
      restoreFocus: ![
        "open",
        "compare",
        "launch",
        "share",
        "delete",
        "review-incoming",
        "review-outgoing",
        "review-instructions",
      ].includes(item.id),
    })),
  );
}

export function ResourceItemMenu({
  resource,
  file,
  extraActions,
  children,
}: {
  resource: ProjectResource;
  file?: string;
  extraActions?: ItemMenuAction[];
  children: (actions: ItemMenuAction[]) => React.ReactElement;
}) {
  const context = useContext(ResourceMenuContext);
  if (!context) return children([]);
  return (
    <ResourceMenuTarget
      resource={resource}
      file={file}
      extraActions={extraActions}
    >
      {(actions) => (
        <ItemContextMenu actions={actions} label={`${resource.kind} actions`}>
          {children(actions)}
        </ItemContextMenu>
      )}
    </ResourceMenuTarget>
  );
}

export function ResourceMenuButton({
  resource,
  file,
  extraActions,
  label = "More resource actions",
}: {
  resource: ProjectResource;
  file?: string;
  extraActions?: ItemMenuAction[];
  label?: string;
}) {
  const context = useContext(ResourceMenuContext);
  if (!context) return null;
  return (
    <ResourceMenuTarget
      resource={resource}
      file={file}
      extraActions={extraActions}
    >
      {(actions) => (
        <ItemMenuButton
          actions={actions}
          footer={resourceMenuFacts(resource)}
          label={label}
          disabled={context.busy}
        />
      )}
    </ResourceMenuTarget>
  );
}

interface CommandPreview {
  previewToken: string;
  title: string;
  kind: string;
  note: string;
  files?: { path: string; size: number }[];
  totalBytes?: number;
  paths?: string[];
}

function fileSize(bytes: number) {
  for (const [size, unit] of [
    [1e9, "GB"],
    [1e6, "MB"],
    [1e3, "KB"],
    [1, "B"],
  ] as const) {
    if (bytes >= size || size === 1)
      return `${(bytes / size).toLocaleString(undefined, { maximumFractionDigits: size === 1 ? 0 : 1 })} ${unit}`;
  }
}

function ResourceCommandDialog({
  kind,
  resource,
  context,
  onClose,
}: {
  kind: "share" | "delete" | "launch";
  resource: ProjectResource;
  context: ResourceMenuContextValue;
  onClose: () => void;
}) {
  const project = context.state.projects.find(
    (item) => item.id === resource.projectId,
  );
  const [preview, setPreview] = useState<CommandPreview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(kind !== "launch");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [attempt, setAttempt] = useState(0);
  const active = useRef(true);
  const workspace = useRef<HTMLDivElement>(null);
  const actions = useResourceActions({
    act: context.act,
    resource,
    user: context.state.user,
    onNotice: context.onNotice,
    scope: context.scope,
  });
  const stale = !context.isCurrent(resource) || !project;
  const current = useRef(true);
  current.current = !stale;
  const input = {
    accountId: context.state.user,
    serviceOrigin: context.state.config?.apiUrl,
    projectId: resource.projectId,
    resourceId: resource.resourceId,
  };
  const accountId = context.state.user;
  const serviceOrigin = context.state.config?.apiUrl;
  const projectId = resource.projectId;
  const resourceId = resource.resourceId;
  useLayoutEffect(() => {
    if (workspace.current) workspace.current.scrollTop = 0;
  }, [loading, busy, error, stale]);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    if (kind === "launch") return;
    let canceled = false;
    setLoading(true);
    setError("");
    setPreview(null);
    setProgress({
      label:
        kind === "share"
          ? "Preparing snapshot for review…"
          : "Preparing deletion for review…",
    });
    const onProgress = new Channel<SyncProgress>((value) => {
      if (!canceled && active.current && current.current) setProgress(value);
    });
    void invoke<CommandPreview>("resource_command", {
      action: `preview-${kind}`,
      input: { accountId, serviceOrigin, projectId, resourceId },
      onProgress,
    })
      .then((result) => {
        if (!canceled) setPreview(result);
      })
      .catch((failure: unknown) => {
        if (!canceled) setError(String(failure));
      })
      .finally(() => {
        if (!canceled) {
          canceled = true;
          setLoading(false);
        }
      });
    return () => {
      canceled = true;
    };
  }, [kind, attempt, accountId, serviceOrigin, projectId, resourceId]);
  const submit = async () => {
    if (busy || !preview || stale) return;
    setBusy(true);
    setError("");
    setProgress({
      label:
        kind === "share"
          ? "Sharing reviewed snapshot…"
          : "Confirming shared deletion…",
    });
    let finished = false;
    const onProgress = new Channel<SyncProgress>((value) => {
      if (!finished && active.current && current.current) setProgress(value);
    });
    try {
      const result = await invoke<{ status: string }>("resource_command", {
        action: kind,
        input: { ...input, previewToken: preview.previewToken },
        onProgress,
      });
      if (!active.current) return;
      if (kind === "delete" && result.status !== "deleted") {
        setError(
          "The item changed before it could be deleted. Review the latest version and try again.",
        );
        return;
      }
      context.onNotice(
        kind === "delete"
          ? "Shared item deleted. Local copies follow sync and review rules."
          : result.status === "published"
            ? "Snapshot shared"
            : result.status === "approval_required"
              ? "Snapshot sent for approval"
              : result.status === "conflict"
                ? "Snapshot needs conflict review"
                : "Snapshot sharing queued",
      );
      finished = true;
      setProgress({ label: "Refreshing project…" });
      await context.onRefresh();
      if (active.current) onClose();
    } catch (failure) {
      if (active.current) setError(String(failure));
    } finally {
      finished = true;
      if (active.current) setBusy(false);
    }
  };
  const title =
    kind === "launch"
      ? "Continue or fork session"
      : kind === "share"
        ? "Share snapshot with project"
        : resource.kind === "session"
          ? "Remove from history"
          : `Delete shared ${resource.kind}`;
  const total = progress?.total;
  const completed =
    total && total > 0 && progress?.completed !== undefined
      ? Math.min(total, Math.max(0, progress.completed))
      : null;
  const percentage =
    completed !== null && total ? (completed / total) * 100 : null;
  const progressCount =
    completed !== null && total
      ? `${completed} of ${total}`
      : progress?.completed
        ? `${progress.completed} checked`
        : undefined;
  return (
    <Overlay
      open
      title={title}
      onClose={() => {
        if (!busy) onClose();
      }}
      className="resource-command-dialog"
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        document
          .querySelector<HTMLElement>(
            `button[data-resource-id="${CSS.escape(resource.resourceId)}"]`,
          )
          ?.focus();
      }}
    >
      <h2 title={title}>{title}</h2>
      <section className="resource-command-item" aria-label="Selected item">
        <Icon icon={FileIcon} size="sm" variant="secondary" />
        <div>
          <span className="resource-command-kind">{resource.kind}</span>
          <p title={preview?.title ?? resource.title}>
            {preview?.title ?? resource.title}
          </p>
        </div>
      </section>
      {kind === "share" && (
        <>
          <dl className="resource-command-destination">
            <div>
              <dt>Project</dt>
              <dd title={project?.name}>{project?.name}</dd>
            </div>
            <div>
              <dt>Service</dt>
              <dd
                title={
                  context.state.config?.mode === "self-hosted"
                    ? "Your self-hosted service"
                    : "Orka Cloud"
                }
              >
                {context.state.config?.mode === "self-hosted"
                  ? "Your self-hosted service"
                  : "Orka Cloud"}
              </dd>
            </div>
          </dl>
          <p className="command-copy">
            The local original and automatic sharing settings stay unchanged.
          </p>
        </>
      )}
      <div
        className="resource-command-workspace"
        ref={workspace}
        role="region"
        aria-label="Review details"
        tabIndex={0}
      >
        {stale && (
          <p role="alert">
            This item or account changed. Close this review and open the item’s
            actions again.
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        {kind === "launch" && project ? (
          <SessionLauncher
            resource={resource}
            project={project}
            scope={context.scope}
            busy={context.busy || stale}
            actions={actions}
            onError={context.onError}
          />
        ) : (
          <>
            {(loading || busy) && !stale && progress ? (
              <section
                className="resource-command-progress"
                aria-label="Item action progress"
              >
                <div
                  className="resource-command-progress-status"
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  <Icon
                    icon={SyncIcon}
                    size="sm"
                    className="sync-activity-icon"
                  />
                  <div>
                    <strong title={progress.label}>{progress.label}</strong>
                    {progress.detail && (
                      <p title={progress.detail}>{progress.detail}</p>
                    )}
                  </div>
                  <span
                    className="resource-command-progress-count"
                    title={progressCount}
                  >
                    {progressCount}
                  </span>
                </div>
                <div
                  className="resource-command-progress-track"
                  data-indeterminate={percentage === null || undefined}
                  role="progressbar"
                  aria-label={progress.label}
                  aria-valuemin={0}
                  aria-valuemax={
                    completed === null ? undefined : (total ?? undefined)
                  }
                  aria-valuenow={completed ?? undefined}
                  aria-valuetext={progressCount}
                >
                  <span
                    style={
                      percentage === null
                        ? undefined
                        : { width: `${percentage}%` }
                    }
                  />
                </div>
              </section>
            ) : (
              <>
                {preview?.files && (
                  <section
                    className="resource-command-manifest"
                    aria-label="Snapshot contents"
                  >
                    <div className="resource-command-manifest-heading">
                      <h3>Snapshot files</h3>
                      <span>
                        {preview.files.length}{" "}
                        {preview.files.length === 1 ? "file" : "files"} ·{" "}
                        {fileSize(
                          preview.totalBytes ??
                            preview.files.reduce(
                              (bytes, file) => bytes + file.size,
                              0,
                            ),
                        )}
                      </span>
                    </div>
                    <ul
                      className="resource-command-files"
                      aria-label="Snapshot files"
                      tabIndex={0}
                    >
                      {preview.files.map((file) => (
                        <li key={file.path}>
                          <Icon icon={FileIcon} size="xs" variant="secondary" />
                          <span
                            className="resource-command-filename"
                            title={file.path}
                          >
                            {file.path}
                          </span>
                          <span
                            className="resource-command-filesize"
                            title={`${file.size.toLocaleString()} bytes`}
                          >
                            {fileSize(file.size)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                {kind === "delete" && !!preview?.paths?.length && (
                  <section
                    className="resource-command-paths"
                    aria-label="Local copies affected"
                  >
                    <h3>Local copies affected</h3>
                    <ul tabIndex={0}>
                      {preview.paths.map((path) => (
                        <li key={path}>{path}</li>
                      ))}
                    </ul>
                  </section>
                )}
              </>
            )}
            {preview?.note && (
              <p className="resource-command-note">{preview.note}</p>
            )}
          </>
        )}
      </div>
      <div className="actions">
        {error && !preview && (
          <Button
            disabled={busy || loading || stale}
            onClick={() => setAttempt((value) => value + 1)}
          >
            Try again
          </Button>
        )}
        <div className="resource-command-main-actions">
          <Button variant="tertiary" disabled={busy} onClick={onClose}>
            {kind === "launch" ? "Close" : "Cancel"}
          </Button>
          {kind !== "launch" && (
            <Button
              className={`resource-command-confirm${kind === "delete" ? " management-danger" : ""}`}
              disabled={busy || context.busy || loading || !preview || stale}
              onClick={() => void submit()}
            >
              <span className="resource-command-button-size" aria-hidden="true">
                {kind === "share" ? "Share this snapshot" : "Confirm deletion"}
              </span>
              <span>
                {busy
                  ? "Working…"
                  : kind === "share"
                    ? "Share this snapshot"
                    : "Confirm deletion"}
              </span>
            </Button>
          )}
        </div>
      </div>
    </Overlay>
  );
}
