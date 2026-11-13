import { sourcePath } from "./project-sources.js";
import { ENV_ENABLED } from "../lib/features.js";
import React, { useCallback, useEffect, useState } from "react";
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
  const setMessage = useToastNotice();
  const [replacement, setReplacement] = useState("");
  const call = useCallback(
    <T,>(action: string, input: Record<string, unknown> = {}) =>
      governanceCall<T>(action, { projectId: project.id, ...input }),
    [project.id],
  );
  const refresh = useCallback(async () => {
    const c = await call<Catalog>("catalog");
    setCatalog(c);
    await onRefresh();
  }, [call, onRefresh]);
  useEffect(() => {
    let active = true;
    void call<Catalog>("catalog")
      .then((c) => {
        if (active) setCatalog(c);
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [call]);
  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
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
  const title = initialEnv ? "Replace ENV set" : "Review local update";
  return (
    <Overlay
      open
      onClose={onClose}
      title={title}
      className="governance-dialog"
      onKeyDownCapture={handleReviewTab}
    >
      <div className="actions">
        <h2>{title}</h2>
        <span className="spacer" />
        <IconButton
          icon={XIcon}
          aria-label={`Close ${title.toLowerCase()}`}
          onClick={onClose}
          variant="tertiary"
          size="sm"
        />
      </div>
      {error && <p role="alert">{error}</p>}
      {!catalog ? (
        <p role="status">Loading update…</p>
      ) : !catalog.governed ? (
        <p>Enable project permissions in Manage first.</p>
      ) : (
        <>
          {catalog.governed && (
            <section>
              <h3>{displayText(selected?.title ?? "Shared item")}</h3>
              {selected && (
                <>
                  {!initialEnv && (
                    <p>
                      Local version:{" "}
                      {(binding?.installationState ?? "current").replaceAll(
                        "_",
                        " ",
                      )}
                    </p>
                  )}
                  {selected.kind === "env" && catalog.owner && (
                    <section>
                      <h4>Replace ENV set</h4>
                      <p>
                        An approved device first prepares and publishes a fresh
                        encrypted set. Choose it below to disable the old set.
                        Signed history stays unchanged.
                      </p>
                      <label>
                        Replacement set
                        <select
                          value={replacement}
                          onChange={(e) => setReplacement(e.target.value)}
                        >
                          <option value="">
                            Choose a published replacement
                          </option>
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
                  {selected.kind === "memory" &&
                    selected.logicalPath.startsWith("instructions/") && (
                      <section>
                        <h4>
                          {"deleted" in selected && selected.deleted
                            ? "Review approved removal on this Mac"
                            : "Install an approved version on this Mac"}
                        </h4>
                        <Button
                          size="sm"
                          disabled={
                            busy ||
                            !sourcePath(
                              project,
                              "sourceId" in selected
                                ? (selected.sourceId as string)
                                : undefined,
                            )
                          }
                          onClick={() =>
                            void run(async () => {
                              setPreview(
                                await call<Preview>("preview-install", {
                                  resourceId: selectedResource,
                                }),
                              );
                            })
                          }
                        >
                          {"deleted" in selected && selected.deleted
                            ? "Review local removal"
                            : "Review local update"}
                        </Button>
                        {preview && (
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
                            {preview.dirty && (
                              <p>
                                Your local edits will be saved privately on this
                                Mac before installation.
                              </p>
                            )}
                            <Button
                              disabled={busy}
                              onClick={() =>
                                void run(async () => {
                                  await call("apply-install", {
                                    resourceId: selectedResource,
                                    token: preview.token,
                                    preserveLocal: true,
                                  });
                                  setPreview(null);
                                  setMessage(
                                    "deleted" in selected && selected.deleted
                                      ? "Reviewed version removed"
                                      : "Reviewed update installed",
                                  );
                                })
                              }
                            >
                              {"deleted" in selected && selected.deleted
                                ? "Preserve edits and remove reviewed version"
                                : "Preserve edits and install reviewed version"}
                            </Button>
                          </>
                        )}
                      </section>
                    )}
                </>
              )}
            </section>
          )}
        </>
      )}
    </Overlay>
  );
}
