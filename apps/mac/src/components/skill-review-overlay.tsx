import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  CommentIcon,
  EyeIcon,
  PencilIcon,
  XIcon,
  type Icon as OcticonIcon,
} from "@primer/octicons-react";
import type { AccessMode } from "@portable/protocol";
import type {
  Inspection,
  LocalDraft,
  Project,
  ProjectResource,
  Snapshot,
} from "../types.js";
import { Overlay } from "./overlay.js";
import { Button } from "./button.js";
import { Icon } from "./icon.js";
import { IconButton } from "./icon-button.js";
import { LoadingRegion } from "./loading-region.js";
import { FileDiffCard } from "./file-diff.js";
import { ReaderState } from "./skill-state.js";
import {
  changedFiles,
  type FileChange,
  type FileManifestEntry,
} from "./diff-model.js";
import {
  accessNames,
  governanceCall,
  type InstallPreview,
} from "./project-permissions.js";
import {
  actionableDraftStatuses,
  skillAccessMode,
  skillBinding,
  skillDraft,
} from "./skill-review-state.js";

export type ReviewMode = "outgoing" | "incoming";

interface Loaded {
  changes: FileChange[];
  /** Incoming reviews: the approved revision and its preview token. */
  revision: number;
  token?: string;
  dirty: boolean;
  otherCopies: number;
  draft?: LocalDraft;
  /** What the preview was built from; a different snapshot makes it stale. */
  signature: string;
}

type Phase =
  | { status: "loading" }
  | { status: "error"; message: string }
  | ({ status: "ready" } & Loaded);

const sampleLoaded: Loaded = {
  changes: [
    {
      path: "SKILL.md",
      status: "modified",
      before:
        "# Review checklist\n\nRead the issue report.\nInspect related pull requests.\n",
      after:
        "# Review checklist\n\nRead the issue report and confirm the root cause.\nInspect related pull requests.\n",
    },
  ],
  revision: 1,
  dirty: false,
  otherCopies: 0,
  signature: "",
};

const accessIcons: Record<AccessMode, OcticonIcon> = {
  publish: PencilIcon,
  suggest: CommentIcon,
  read: EyeIcon,
  hidden: EyeIcon,
};

const stalePattern = /review the update again/i;

/** Radix's light-DOM focus loop cannot see Pierre's shadow-root controls. */
function handleReviewTab(event: React.KeyboardEvent<HTMLDivElement>) {
  if (
    event.key !== "Tab" ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.defaultPrevented
  )
    return;

  const candidates: HTMLElement[] = [];
  const visit = (element: Element) => {
    if (
      element.hasAttribute("inert") ||
      element.getAttribute("aria-hidden") === "true"
    )
      return;
    if (
      element instanceof HTMLElement &&
      element.tabIndex >= 0 &&
      !element.matches(":disabled") &&
      element.getClientRects().length > 0 &&
      !["hidden", "collapse"].includes(getComputedStyle(element).visibility)
    )
      candidates.push(element);

    if (element instanceof HTMLSlotElement) {
      const assigned = element.assignedElements({ flatten: true });
      for (const child of assigned.length
        ? assigned
        : Array.from(element.children))
        visit(child);
    } else {
      for (const child of Array.from(
        element.shadowRoot?.children ?? element.children,
      ))
        visit(child);
    }
  };
  for (const child of Array.from(event.currentTarget.children)) visit(child);

  // Stop Radix's shallow bubble handler after resolving the actual focused node.
  event.preventDefault();
  event.stopPropagation();
  if (candidates.length === 0) {
    event.currentTarget.focus();
    return;
  }
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement)
    active = active.shadowRoot.activeElement;
  const current = candidates.indexOf(active as HTMLElement);
  const next =
    current < 0
      ? event.shiftKey
        ? candidates.length - 1
        : 0
      : (current + (event.shiftKey ? -1 : 1) + candidates.length) %
        candidates.length;
  candidates[next].focus();
}

export interface SkillReviewOverlayProps {
  mode: ReviewMode;
  project: Project;
  resource: ProjectResource;
  state: Snapshot;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onNotice: (message: string) => void;
  onCloseAutoFocus?: (event: Event) => void;
}

/**
 * The right-side review drawer. Outgoing reviews compare the approved shared
 * version with the draft on this Mac, publishing or requesting approval by access; incoming
 * reviews preview an approved update or removal and install it with the
 * reviewed token.
 */
export function SkillReviewOverlay({
  mode,
  project,
  resource,
  state,
  onClose,
  onRefresh,
  onNotice,
  onCloseAutoFocus,
}: SkillReviewOverlayProps) {
  const removal = mode === "incoming" && resource.deleted === true;
  const title =
    mode === "outgoing"
      ? "Review local edits"
      : removal
        ? "Review skill removal"
        : "Review local update";
  const binding = skillBinding(state, resource);
  const outgoingDraft =
    mode === "outgoing" ? skillDraft(state, resource) : undefined;
  const signature = JSON.stringify([
    resource.revision,
    resource.hash,
    binding,
    outgoingDraft?.id,
    outgoingDraft?.status,
    outgoingDraft?.resource.files,
  ]);
  const access = skillAccessMode(resource, state, project);
  const [phase, setPhase] = useState<Phase>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [failure, setFailure] = useState("");
  const generation = useRef(0);
  const latest = useRef({ state, resource, signature });
  useLayoutEffect(() => {
    latest.current = { state, resource, signature };
  }, [state, resource, signature]);
  const call = useCallback(
    <T,>(action: string, input: Record<string, unknown> = {}) =>
      governanceCall<T>(action, { projectId: project.id, ...input }),
    [project.id],
  );
  const load = useCallback(async () => {
    const current = ++generation.current;
    // Capture the snapshot at this explicit review, not when the callback was
    // created. Binding changes mark an open preview stale without auto-reloading.
    const {
      state: currentState,
      resource: currentResource,
      signature: currentSignature,
    } = latest.current;
    setPhase({ status: "loading" });
    setStale(false);
    setFailure("");
    try {
      let loaded: Loaded;
      if (mode === "incoming") {
        const preview = await call<InstallPreview>("preview-install", {
          resourceId: currentResource.resourceId,
        });
        loaded = {
          changes: changedFiles(preview.before, removal ? {} : preview.after, {
            beforeManifest: preview.beforeManifest,
            afterManifest: removal ? [] : preview.afterManifest,
          }),
          revision: preview.revision,
          token: preview.token,
          dirty: preview.dirty,
          otherCopies: Math.max((preview.copies?.length ?? 1) - 1, 0),
          signature: currentSignature,
        };
      } else {
        const draft = skillDraft(currentState, currentResource);
        if (!draft)
          loaded = {
            changes: [],
            revision: currentResource.revision,
            dirty: false,
            otherCopies: 0,
            signature: currentSignature,
          };
        else {
          const detail = await call<{
            files: Record<string, string>;
            draft?: LocalDraft;
            manifest?: FileManifestEntry[];
          }>("draft", { id: draft.id });
          const shared: Record<string, string> = {};
          const sharedManifest = await Promise.all(
            currentResource.files.map(async (file) => {
              const inspection = await invoke<Inspection>("inspect_resource", {
                id: currentResource.resourceId,
                file: file.path,
                conflictId: null,
              });
              if (inspection.content !== null)
                shared[file.path] = inspection.content;
              return { ...file, binary: inspection.content === null };
            }),
          );
          loaded = {
            changes: changedFiles(shared, detail.files, {
              beforeManifest: sharedManifest,
              afterManifest:
                detail.manifest ??
                detail.draft?.resource.files ??
                draft.resource.files,
            }),
            revision: currentResource.revision,
            dirty: false,
            otherCopies: 0,
            draft: detail.draft ?? draft,
            signature: currentSignature,
          };
        }
      }
      if (current === generation.current)
        setPhase({ status: "ready", ...loaded });
    } catch (error) {
      if (current === generation.current)
        setPhase({ status: "error", message: String(error) });
    }
    // The signature is read when a preview starts; later changes mark it stale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call, mode, removal, resource.resourceId, resource.revision]);
  useEffect(() => {
    void load();
  }, [load]);
  // A preview built from an older snapshot cannot be applied safely.
  useEffect(() => {
    if (phase.status === "ready" && phase.signature !== signature)
      setStale(true);
  }, [phase, signature]);

  const run = async (
    action: () => Promise<void>,
    onError: (message: string) => void,
  ) => {
    if (busy) return;
    setBusy(true);
    setFailure("");
    try {
      await action();
    } catch (error) {
      onError(String(error));
    } finally {
      setBusy(false);
    }
  };
  const install = () =>
    run(
      async () => {
        if (phase.status !== "ready" || !phase.token) return;
        await call("apply-install", {
          resourceId: resource.resourceId,
          token: phase.token,
          preserveLocal: true,
        });
        onNotice(
          removal ? "Reviewed version removed" : "Reviewed version installed",
        );
        await onRefresh();
        onClose();
      },
      (message) => {
        if (stalePattern.test(message)) setStale(true);
        else setFailure(message);
      },
    );
  const submit = () =>
    run(
      async () => {
        if (phase.status !== "ready" || !phase.draft) return;
        if (stale || phase.signature !== latest.current.signature) {
          setStale(true);
          return;
        }
        await call("submit-draft", {
          id: phase.draft.id,
          reviewedFiles: phase.draft.resource.files,
          reviewedRevision: phase.revision,
          ...(access === "publish" ? { publishIfAllowed: true } : {}),
        });
        onNotice(
          access === "publish"
            ? "Update queued for publishing."
            : "Suggestion submitted for publisher review.",
        );
        await onRefresh();
        onClose();
      },
      (message) => {
        if (stalePattern.test(message)) setStale(true);
        else
          setFailure(
            access === "publish"
              ? "Couldn’t queue update"
              : "Couldn’t send suggestion",
          );
      },
    );
  const refreshDraft = () =>
    run(
      async () => {
        if (phase.status !== "ready" || !phase.draft) return;
        await call("refresh-draft", { id: phase.draft.id });
        await onRefresh();
        await load();
      },
      (message) => setFailure(message),
    );

  // The bottom fade only appears while more of the diff continues below.
  const bodyRef = useRef<HTMLDivElement>(null);
  const [hasMore, setHasMore] = useState(false);
  const measure = useCallback(() => {
    const body = bodyRef.current;
    if (!body) return;
    setHasMore(body.scrollTop + body.clientHeight < body.scrollHeight - 1);
  }, []);
  useLayoutEffect(() => {
    measure();
    const body = bodyRef.current;
    if (!body || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    for (const child of Array.from(body.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [measure, phase]);

  const ready = phase.status === "ready" ? phase : null;
  const draftActionable = Boolean(
    ready?.draft && actionableDraftStatuses.includes(ready.draft.status),
  );
  const draftNeedsRefresh = Boolean(
    ready?.draft && ["stale", "rejected"].includes(ready.draft.status),
  );
  const versionLabel = `Version ${ready?.revision ?? resource.revision}`;
  const empty = phase.status === "error" || ready?.changes.length === 0;
  const preservationDescriptionId = useId();
  const footer = (() => {
    if (!ready) return null;
    const outgoing = mode === "outgoing";
    if (outgoing && (!ready.draft || access === "read" || access === "hidden"))
      return null;
    if (stale)
      return (
        <Button
          size="sm"
          variant="primary"
          disabled={busy}
          onClick={() => void (outgoing ? refreshDraft() : load())}
        >
          Review latest
        </Button>
      );
    if (ready.changes.length === 0) return null;
    if (outgoing) {
      if (draftNeedsRefresh)
        return (
          <Button size="sm" disabled={busy} onClick={() => void refreshDraft()}>
            Review latest and retry
          </Button>
        );
      if (!draftActionable) return null;
    }
    const label = outgoing
      ? access === "publish"
        ? "Publish update"
        : "Send for approval"
      : removal
        ? ready.dirty
          ? "Keep edits and remove"
          : "Remove from this Mac"
        : ready.dirty
          ? "Keep edits and install"
          : "Install update";
    const busyLabel = outgoing
      ? access === "publish"
        ? "Publishing update"
        : "Sending suggestion"
      : removal
        ? "Removing"
        : "Installing";
    const preserveEdits = !outgoing && ready.dirty;
    return (
      <>
        {busy && !outgoing ? (
          <p className="review-footer-status" role="status">
            {busyLabel}…
          </p>
        ) : (
          failure && <p className="review-footer-note">{failure}</p>
        )}
        <Button
          size="sm"
          variant="primary"
          className="review-action"
          disabled={busy}
          aria-busy={busy || undefined}
          aria-label={busy ? busyLabel : undefined}
          aria-describedby={
            preserveEdits ? preservationDescriptionId : undefined
          }
          onClick={() => void (outgoing ? submit() : install())}
        >
          {busy ? (
            <>
              <span className="review-action-label" aria-hidden="true">
                {outgoing ? label : `${busyLabel}…`}
              </span>
              <span
                className="activity-indicator review-action-spinner"
                aria-hidden="true"
              />
            </>
          ) : failure ? (
            "Try again"
          ) : (
            label
          )}
        </Button>
        {preserveEdits && (
          <span className="sr-only" id={preservationDescriptionId}>
            Your local edits will be saved privately on this Mac before
            {removal ? " removal." : " installation."}
          </span>
        )}
      </>
    );
  })();

  return (
    <Overlay
      open
      drawer
      title={title}
      className={`review-drawer${empty ? " review-drawer--empty" : ""}`}
      onClose={() => {
        if (!busy) onClose();
      }}
      onEscapeKeyDown={(event) => {
        if (busy) event.preventDefault();
      }}
      onCloseAutoFocus={onCloseAutoFocus}
      onKeyDownCapture={handleReviewTab}
    >
      <header className="review-header">
        <div className="review-heading">
          <h2>{title}</h2>
          {!empty && (
            <div className="review-versions" aria-label="Compared versions">
              {mode === "outgoing" ? (
                <>
                  <span className="version-pill">{versionLabel}</span>
                  <span aria-hidden="true">to</span>
                  <span className="sr-only">compared with</span>
                  <span className="version-pill">This Mac</span>
                </>
              ) : removal ? (
                <span className="version-pill">This Mac</span>
              ) : (
                <>
                  <span className="version-pill">This Mac</span>
                  <span aria-hidden="true">to</span>
                  <span className="sr-only">compared with</span>
                  <span className="version-pill">{versionLabel}</span>
                </>
              )}
            </div>
          )}
        </div>
        <IconButton
          icon={XIcon}
          size="sm"
          variant="tertiary"
          aria-label="Close review"
          disabled={busy}
          onClick={onClose}
        />
      </header>
      <div className="review-scroll">
        <div className="review-body" ref={bodyRef} onScroll={measure}>
          {phase.status === "error" ? (
            <ReaderState
              size="overlay"
              tone="alert"
              illustration="preview-unavailable"
              title="Preview unavailable"
              action={
                <Button
                  size="sm"
                  variant="tertiary"
                  onClick={() => void load()}
                >
                  Retry
                </Button>
              }
            />
          ) : (
            <LoadingRegion
              id="skill-review"
              label="Loading changes…"
              data={ready}
              sample={sampleLoaded}
            >
              {(loaded) =>
                loaded.changes.length === 0 ? (
                  mode === "outgoing" ? (
                    <ReaderState
                      size="overlay"
                      illustration="up-to-date"
                      title="No local edits"
                      message="This Mac matches the shared version."
                    />
                  ) : (
                    <ReaderState
                      size="overlay"
                      illustration="up-to-date"
                      title="Up to date"
                      message="This Mac has the approved version."
                    />
                  )
                ) : (
                  <div className="review-files">
                    {mode === "outgoing" && (
                      <span className={`access-pill access-pill--${access}`}>
                        <Icon icon={accessIcons[access]} size="sm" />
                        <span className="sr-only">Skill access: </span>
                        {accessNames[access]}
                      </span>
                    )}
                    {stale && (
                      <p
                        className="skill-status skill-status--warning"
                        role="status"
                      >
                        Files changed since this preview.
                      </p>
                    )}
                    {mode === "incoming" && loaded.otherCopies > 0 && (
                      <p className="review-note">
                        {loaded.otherCopies === 1
                          ? "One other local copy"
                          : `${loaded.otherCopies} other local copies`}{" "}
                        on this Mac will be updated as well.
                      </p>
                    )}
                    {loaded.changes.map((change) => (
                      <FileDiffCard
                        key={change.path}
                        path={change.path}
                        before={change.before}
                        after={change.after}
                        status={change.status}
                        binary={change.binary}
                        comparisonUnavailable={change.comparisonUnavailable}
                      />
                    ))}
                  </div>
                )
              }
            </LoadingRegion>
          )}
        </div>
        <div
          className="review-fade"
          data-visible={hasMore}
          aria-hidden="true"
        />
      </div>
      {footer && <footer className="review-footer">{footer}</footer>}
    </Overlay>
  );
}
