import { sourcePath } from "./project-sources.js";
import { ENV_ENABLED } from "../lib/features.js";
import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useToastNotice } from "./toasts.js";
import { XIcon } from "@primer/octicons-react";
import type { Project, Snapshot } from "../types.js";
import { Overlay } from "./overlay.js";
import { handleReviewTab } from "./review-focus.js";
import { Button } from "./button.js";
import { IconButton } from "./icon-button.js";
import {
  governanceCall,
  type GovernanceCatalog as Catalog,
  type InstallPreview as Preview,
} from "./project-permissions.js";
import { displayText } from "./resource-presentation.js";
import { FileReview } from "./file-review.js";

export function GovernanceDialog({
  project,
  state,
  onClose,
  onRefresh,
  initialResource,
  initialEnv,
}: {
  project: Project;
  state: Snapshot;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  initialResource: string;
  initialEnv?: { title: string };
}) {
  const [catalog, setCatalog] = useState<Catalog | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const selectedResource = initialResource;
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewSignature, setPreviewSignature] = useState("");
  const [loading, setLoading] = useState(true);
  const [stale, setStale] = useState(false);
  const setMessage = useToastNotice();
  const [replacement, setReplacement] = useState("");
  const preservationId = useId();
  const call = useCallback(
    <T,>(action: string, input: Record<string, unknown> = {}) =>
      governanceCall<T>(action, { projectId: project.id, ...input }),
    [project.id],
  );
  const resources = [
    ...state.resources.filter(
      (r) =>
        r.projectId === project.id &&
        (!r.deleted ||
          (r.kind === "memory" &&
            r.logicalPath.startsWith("instructions/") &&
            state.bindings.some(
              (b) =>
                b.base?.resourceId === r.resourceId &&
                b.installationState !== "current",
            ))),
    ),
    ...(ENV_ENABLED && initialEnv
      ? [
          {
            resourceId: initialResource,
            title: initialEnv.title,
            kind: "env" as const,
            logicalPath: "env/" + initialResource,
          },
        ]
      : []),
    ...(ENV_ENABLED ? (catalog?.envSets ?? []) : []).map((r) => ({
      ...r,
      kind: "env" as const,
      logicalPath: "env/" + r.resourceId,
    })),
  ];
  const binding = state.bindings.find(
    (b) => b.base?.resourceId === selectedResource,
  );
  const selected = resources.find((r) => r.resourceId === selectedResource);
  const instructions =
    selected?.kind === "memory" &&
    selected.logicalPath.startsWith("instructions/");
  const hasSource = Boolean(
    sourcePath(
      project,
      selected && "sourceId" in selected
        ? (selected.sourceId as string)
        : undefined,
    ),
  );
  const removal = Boolean(
    selected && "deleted" in selected && selected.deleted,
  );
  const signature = JSON.stringify([
    selected && "revision" in selected ? selected.revision : undefined,
    selected && "hash" in selected ? selected.hash : undefined,
    binding,
  ]);
  const latestSignature = useRef(signature);
  useLayoutEffect(() => {
    latestSignature.current = signature;
  }, [signature]);
  const generation = useRef({ value: 0 });
  const load = useCallback(async () => {
    const current = ++generation.current.value;
    setLoading(true);
    setError("");
    setPreview(null);
    setStale(false);
    try {
      const c = await call<Catalog>("catalog");
      if (current !== generation.current.value) return;
      setCatalog(c);
      if (c.governed && instructions && hasSource) {
        const reviewedSignature = latestSignature.current;
        const value = await call<Preview>("preview-install", {
          resourceId: selectedResource,
        });
        if (current !== generation.current.value) return;
        setPreview(value);
        setPreviewSignature(reviewedSignature);
      }
    } catch (e) {
      if (current === generation.current.value) setError(String(e));
    } finally {
      if (current === generation.current.value) setLoading(false);
    }
  }, [call, instructions, hasSource, selectedResource]);
  useEffect(() => {
    const pending = generation.current;
    void load();
    return () => {
      pending.value++;
    };
  }, [load]);
  const run = async (fn: () => Promise<void>) => {
    if (busy) return false;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
      setCatalog(await call<Catalog>("catalog"));
      await onRefresh();
      return true;
    } catch (e) {
      const message = String(e);
      if (/review the update again/i.test(message)) setStale(true);
      setError(message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const previewStale = stale || (preview && previewSignature !== signature);
  const title = initialEnv ? "Replace ENV set" : "Review local update";
  return (
    <Overlay
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      title={title}
      className="changes-review-modal governance-dialog"
      onEscapeKeyDown={(event) => {
        if (busy) event.preventDefault();
      }}
      onKeyDownCapture={handleReviewTab}
    >
      <header className="review-header">
        <h2>{title}</h2>
        <IconButton
          icon={XIcon}
          aria-label={`Close ${title.toLowerCase()}`}
          disabled={busy}
          onClick={onClose}
          variant="tertiary"
          size="sm"
        />
      </header>
      <div className="changes-review-body">
        <h3>{displayText(selected?.title ?? "Shared item")}</h3>
        {error && <p role="alert">{error}</p>}
        {loading ? (
          <p role="status">Loading update…</p>
        ) : !catalog ? (
          <Button size="sm" onClick={() => void load()}>
            Try again
          </Button>
        ) : !catalog.governed ? (
          <p>Enable project permissions in Manage first.</p>
        ) : (
          <>
            {selected?.kind === "env" && catalog.owner && (
              <section>
                <p>
                  An approved device first prepares and publishes a fresh
                  encrypted set. Choose it below to disable the old set. Signed
                  history stays unchanged.
                </p>
                <label>
                  Replacement set
                  <select
                    value={replacement}
                    onChange={(e) => setReplacement(e.target.value)}
                  >
                    <option value="">Choose a published replacement</option>
                    {(catalog.envSets ?? [])
                      .filter((r) => r.resourceId !== selectedResource)
                      .map((r) => (
                        <option value={r.resourceId} key={r.resourceId}>
                          {r.title}
                        </option>
                      ))}
                  </select>
                </label>
                <Button
                  disabled={busy || !replacement}
                  onClick={() =>
                    void run(async () => {
                      await call("replace-env", {
                        setId: selectedResource,
                        replacementId: replacement,
                        expectedPolicyRevision: catalog.policyRevision,
                      });
                      setMessage(
                        "Old ENV set disabled. Recipients must review the replacement’s trust.",
                      );
                    })
                  }
                >
                  Mark old ENV set replaced
                </Button>
              </section>
            )}
            {instructions && (
              <>
                <p>
                  Local version:{" "}
                  {(binding?.installationState ?? "current").replaceAll(
                    "_",
                    " ",
                  )}
                </p>
                {!hasSource ? (
                  <p role="status">
                    Connect this project’s source folder to review and install
                    the update.
                  </p>
                ) : preview ? (
                  <>
                    <FileReview
                      files={preview.after}
                      before={preview.before}
                      beforeManifest={preview.beforeManifest}
                      afterManifest={preview.afterManifest}
                    />
                    {preview.copies
                      ?.slice(1)
                      .filter(
                        (c) =>
                          JSON.stringify(c.files) !==
                          JSON.stringify(preview.before),
                      )
                      .map((c) => (
                        <section key={c.path}>
                          <h4>Other local copy: {c.path}</h4>
                          <FileReview
                            files={preview.after}
                            before={c.files}
                            beforeManifest={c.manifest}
                            afterManifest={preview.afterManifest}
                          />
                        </section>
                      ))}
                    {previewStale && (
                      <p role="status">
                        Files changed since this preview. Review the latest
                        update before installing.
                      </p>
                    )}
                  </>
                ) : (
                  <Button size="sm" disabled={busy} onClick={() => void load()}>
                    Try again
                  </Button>
                )}
              </>
            )}
          </>
        )}
      </div>
      <footer className="review-footer">
        {preview?.dirty && (
          <p id={preservationId} className="review-footer-note">
            Your local edits will be saved privately on this Mac before{" "}
            {removal ? "removal" : "installation"}.
          </p>
        )}
        <Button variant="tertiary" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        {preview &&
          !loading &&
          (previewStale ? (
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => void load()}
            >
              Review latest
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={busy}
              aria-busy={busy}
              aria-describedby={preview.dirty ? preservationId : undefined}
              onClick={() =>
                void (async () => {
                  const installed = await run(async () => {
                    await call("apply-install", {
                      resourceId: selectedResource,
                      token: preview.token,
                      preserveLocal: true,
                    });
                    setMessage(
                      removal
                        ? "Reviewed version removed"
                        : "Reviewed update installed",
                    );
                  });
                  if (installed) onClose();
                })()
              }
            >
              {removal
                ? preview.dirty
                  ? "Keep edits and remove"
                  : "Remove from this Mac"
                : preview.dirty
                  ? "Keep edits and install"
                  : "Install update"}
            </Button>
          ))}
      </footer>
    </Overlay>
  );
}
