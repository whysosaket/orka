import React, { useState } from "react";
import { XIcon } from "@primer/octicons-react";
import type { ReviewRequest, Resource } from "@portable/protocol";
import type { Project, Snapshot } from "../types.js";
import { displayText } from "./resource-presentation.js";
import { Button } from "./button.js";
import { IconButton } from "./icon-button.js";
import { Overlay } from "./overlay.js";
import { handleReviewTab } from "./review-focus.js";
import { FileReview } from "./file-review.js";
import {
  ProjectChangeReview,
  type SuggestionDetail,
} from "./project-change-review.js";
import { visibleRequest } from "../lib/features.js";
import type { FileManifestEntry } from "./diff-model.js";
import {
  accessNames,
  memberLabel,
  type GovernanceCatalog,
  type ProjectCall,
} from "./project-permissions.js";

interface RequestDetail {
  request: ReviewRequest;
  files?: Record<string, string>;
  before?: Record<string, string>;
  audience?: string[];
  content?: { resource?: Resource };
  manifest?: FileManifestEntry[];
  beforeManifest?: FileManifestEntry[];
}
export function ProjectRequests({
  project,
  state,
  catalog,
  call,
  run,
  busy,
  error,
  setMessage,
  onReviewFile,
}: {
  project: Project;
  state: Snapshot;
  catalog: GovernanceCatalog;
  call: ProjectCall;
  run: (fn: () => Promise<void>) => Promise<void>;
  busy: boolean;
  error: string;
  setMessage: (value: string) => void;
  onReviewFile: (id: string) => void;
}) {
  const [visibleCount, setVisibleCount] = useState(5);
  const [selectedRequest, setSelectedRequest] = useState<ReviewRequest | null>(
    null,
  );
  const [request, setRequest] = useState<RequestDetail | null>(null);
  const [suggestion, setSuggestion] = useState<SuggestionDetail | null>(null);
  const suggestions = (state.drafts ?? []).filter(
    (d) =>
      d.projectId === project.id &&
      !["dismissed", "published", "approved"].includes(d.status) &&
      !d.automaticSharing,
  );
  const updates = state.bindings.filter(
    (b) =>
      b.base?.projectId === project.id &&
      b.installationState &&
      b.installationState !== "current",
  );
  const labelMember = (id: string) =>
    memberLabel(id, state.user, catalog.members);
  const requests = catalog.requests.filter(visibleRequest);
  const loadRequest = (id: string) =>
    run(async () => {
      setRequest(await call<RequestDetail>("request", { id }));
      await call("read-notification", { id });
    });
  const closeRequest = () => {
    setSelectedRequest(null);
    setRequest(null);
  };
  return (
    <div className="project-requests">
      <section>
        <h3>Requests</h3>
        {requests.length === 0 && <p>No requests available.</p>}
        {requests.slice(0, visibleCount).map((r) => (
          <div key={r.id} className="governance-row">
            <span>
              {displayText(r.title)}
              <small>
                {labelMember(r.author)} · {r.status}
                {r.type === "access"
                  ? ` · ${accessNames[r.requestedMode!]} requested`
                  : ""}
              </small>
            </span>
            <Button
              size="sm"
              variant="tertiary"
              disabled={busy}
              onClick={() => {
                setSelectedRequest(r);
                setRequest(null);
                void loadRequest(r.id);
              }}
            >
              Review request
            </Button>
          </div>
        ))}
        {requests.length > visibleCount && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setVisibleCount((count) => count + 5)}
          >
            View more requests
          </Button>
        )}
        {selectedRequest && (
          <Overlay
            open
            title="Review request"
            className="changes-review-modal request-review-modal"
            onClose={() => {
              if (!busy) closeRequest();
            }}
            onEscapeKeyDown={(event) => {
              if (busy) event.preventDefault();
            }}
            onKeyDownCapture={handleReviewTab}
          >
            <header className="review-header">
              <h2>Review request</h2>
              <IconButton
                icon={XIcon}
                size="sm"
                variant="tertiary"
                aria-label="Close review request"
                disabled={busy}
                onClick={closeRequest}
              />
            </header>
            <div className="changes-review-body">
              <h3>{displayText(selectedRequest.title)}</h3>
              {error && <p role="alert">{error}</p>}
              {!request ? (
                busy ? (
                  <p role="status">Loading request…</p>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => void loadRequest(selectedRequest.id)}
                  >
                    Try again
                  </Button>
                )
              ) : (
                <>
                  {request.content?.resource?.memory && (
                    <p>
                      Topic: {request.content?.resource.memory.topic} · Scope:{" "}
                      {request.content?.resource.memory.scope || "Project"} ·
                      Provider: {request.content?.resource.memory.provider}
                    </p>
                  )}
                  {(request.content?.resource?.memory?.supersedes?.length ??
                    0) > 0 && (
                    <p>
                      Replaces active knowledge:{" "}
                      {request.content?.resource!.memory!.supersedes.join(", ")}
                    </p>
                  )}
                  {request.audience && (
                    <p>
                      Visible after approval:{" "}
                      {request.audience.map(labelMember).join(", ")}. Known
                      source restrictions continue to apply.
                    </p>
                  )}
                  {request.files && (
                    <FileReview
                      files={
                        request.content?.resource?.deleted ? {} : request.files
                      }
                      before={request.before}
                      beforeManifest={request.beforeManifest}
                      afterManifest={
                        request.content?.resource?.deleted
                          ? []
                          : (request.manifest ??
                            request.content?.resource?.files)
                      }
                    />
                  )}
                  <p>
                    {request.request.type === "access"
                      ? `Requested access: ${accessNames[request.request.requestedMode!]}`
                      : "Approval publishes exactly this prepared version."}
                  </p>
                </>
              )}
            </div>
            <footer className="review-footer">
              <Button variant="tertiary" disabled={busy} onClick={closeRequest}>
                Cancel
              </Button>
              {request?.request.status === "pending" &&
                request.request.canReview && (
                  <>
                    {(["reject", "approve"] as const).map((decision) => (
                      <Button
                        key={decision}
                        disabled={busy}
                        aria-busy={busy}
                        variant={
                          decision === "approve" ? "primary" : "secondary"
                        }
                        onClick={() =>
                          void (async () => {
                            let decided = false;
                            await run(async () => {
                              const result = await call<ReviewRequest>(
                                "decide",
                                {
                                  id: request.request.id,
                                  decision,
                                  previewHash: request.request.previewHash,
                                  expectedPolicyRevision:
                                    catalog.policyRevision,
                                },
                              );
                              setMessage(
                                result.status === "stale"
                                  ? "The resource or permissions changed. A refreshed suggestion is needed."
                                  : `Request ${result.status}.`,
                              );
                              decided = true;
                            });
                            if (decided) closeRequest();
                          })()
                        }
                      >
                        {decision === "approve" ? "Approve request" : "Reject"}
                      </Button>
                    ))}
                  </>
                )}
            </footer>
          </Overlay>
        )}
      </section>
      <section aria-label="Local updates">
        <h3>Updates on this Mac</h3>
        <p>
          Shared skills install automatically when Skills sharing is enabled.
          Review conflicting local edits and project instruction updates here.
          Local edits are kept.
        </p>
        {updates.length === 0 && <p>No updates need review.</p>}
        {updates.map((b) => (
          <div className="governance-row" key={b.base.resourceId}>
            <span>
              {displayText(b.base.title)}
              <small>{(b.installationState ?? "").replaceAll("_", " ")}</small>
            </span>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => onReviewFile(b.base.resourceId)}
            >
              Review update
            </Button>
          </div>
        ))}
      </section>
      {suggestions.length > 0 && (
        <section aria-label="Local changes">
          <h3>Changes on this Mac</h3>
          <p>
            Share selected changes here. Publishing permission lets you share
            directly; suggested changes need a publisher’s approval.
          </p>
          {suggestions.map((d) => (
            <div className="governance-row" key={d.id}>
              <span>
                {displayText(d.resource.title)}
                <small>
                  {d.status === "proposed"
                    ? "Review pending"
                    : d.status === "local"
                      ? "Only on this Mac"
                      : `Request ${d.status}`}
                </small>
              </span>
              <Button
                size="sm"
                variant="tertiary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    setSuggestion(
                      await call<SuggestionDetail>("draft", { id: d.id }),
                    );
                  })
                }
              >
                Review changes
              </Button>
              <Button
                size="sm"
                variant="tertiary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await call("dismiss", { id: d.id });
                    setSuggestion(null);
                  })
                }
              >
                Dismiss
              </Button>
            </div>
          ))}
          {suggestion && (
            <ProjectChangeReview
              detail={suggestion}
              busy={busy}
              error={error}
              onClose={() => setSuggestion(null)}
              onRefresh={() =>
                run(async () => {
                  await call("refresh-draft", { id: suggestion.draft.id });
                  setSuggestion(
                    await call<SuggestionDetail>("draft", {
                      id: suggestion.draft.id,
                    }),
                  );
                })
              }
              onSubmit={() =>
                run(async () => {
                  await call("submit-draft", {
                    id: suggestion.draft.id,
                    reviewedFiles: suggestion.draft.resource.files,
                    ...(suggestion.baseRevision === undefined
                      ? {}
                      : { reviewedRevision: suggestion.baseRevision }),
                  });
                  setSuggestion(null);
                  setMessage(
                    suggestion.canPublish
                      ? "Change queued for sharing."
                      : "Suggestion submitted for publisher review.",
                  );
                })
              }
            />
          )}
        </section>
      )}
    </div>
  );
}
