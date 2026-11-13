import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Project, ProjectResource, Snapshot } from "../types.js";
import {
  ItemContextMenu,
  ItemMenuButton,
  type ItemMenuAction,
} from "./item-menu.js";
import { Overlay } from "./overlay.js";
import { Button } from "./button.js";
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
  } | null>(null);
  const isCurrent = (resource: ProjectResource) =>
    active.current &&
    currentResources.current.some(
      (item) => !item.deleted && identity(item) === identity(resource),
    );
  const context: ResourceMenuContextValue = {
    ...props,
    isCurrent,
    request: (kind, resource) => {
      if (isCurrent(resource)) setRequest({ kind, resource });
    },
  };
  return (
    <ResourceMenuContext.Provider value={context}>
      {children}
      {request && (
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
  const [attempt, setAttempt] = useState(0);
  const active = useRef(true);
  const actions = useResourceActions({
    act: context.act,
    resource,
    user: context.state.user,
    onNotice: context.onNotice,
    scope: context.scope,
  });
  const stale = !context.isCurrent(resource) || !project;
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
    void invoke<CommandPreview>("resource_command", {
      action: `preview-${kind}`,
      input: { accountId, serviceOrigin, projectId, resourceId },
    })
      .then((result) => {
        if (!canceled) setPreview(result);
      })
      .catch((failure: unknown) => {
        if (!canceled) setError(String(failure));
      })
      .finally(() => {
        if (!canceled) setLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [kind, attempt, accountId, serviceOrigin, projectId, resourceId]);
  const submit = async () => {
    if (busy || !preview || stale) return;
    setBusy(true);
    setError("");
    try {
      const result = await invoke<{ status: string }>("resource_command", {
        action: kind,
        input: { ...input, previewToken: preview.previewToken },
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
      await context.onRefresh();
      if (active.current) onClose();
    } catch (failure) {
      if (active.current) setError(String(failure));
    } finally {
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
      <h2>{title}</h2>
      <p className="command-copy">{preview?.title ?? resource.title}</p>
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
          {kind === "share" && (
            <p className="command-copy">
              Share this snapshot with <strong>{project?.name}</strong> on{" "}
              {context.state.config?.mode === "self-hosted"
                ? "your self-hosted service"
                : "Orka Cloud"}
              . The local original and automatic sharing settings stay
              unchanged.
            </p>
          )}
          {loading && (
            <p role="status">
              Preparing the exact {kind === "share" ? "snapshot" : "deletion"}{" "}
              for review…
            </p>
          )}
          {preview?.note && <p className="command-copy">{preview.note}</p>}
          {preview?.files && (
            <>
              <p className="command-copy">
                {preview.files.length}{" "}
                {preview.files.length === 1 ? "file" : "files"} ·{" "}
                {(preview.totalBytes ?? 0).toLocaleString()} bytes
              </p>
              <ul className="resource-command-files">
                {preview.files.map((file) => (
                  <li key={file.path}>{file.path}</li>
                ))}
              </ul>
            </>
          )}
          {!!preview?.paths?.length && (
            <ul className="resource-command-files">
              {preview.paths.map((path) => (
                <li key={path}>{path}</li>
              ))}
            </ul>
          )}
        </>
      )}
      {stale && (
        <p role="alert">
          This item or account changed. Close this review and open the item’s
          actions again.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="actions">
        {error && !preview && (
          <Button
            disabled={busy || loading || stale}
            onClick={() => setAttempt((value) => value + 1)}
          >
            Try again
          </Button>
        )}
        <Button variant="tertiary" disabled={busy} onClick={onClose}>
          {kind === "launch" ? "Close" : "Cancel"}
        </Button>
        {kind !== "launch" && (
          <Button
            className={kind === "delete" ? "management-danger" : undefined}
            disabled={busy || context.busy || loading || !preview || stale}
            onClick={() => void submit()}
          >
            {busy
              ? "Working…"
              : kind === "share"
                ? "Share this snapshot"
                : "Confirm deletion"}
          </Button>
        )}
      </div>
    </Overlay>
  );
}
