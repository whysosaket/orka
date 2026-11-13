import React, { useRef, useState } from "react";
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
import { projectAttention } from "./sync-attention.js";
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
  const requestHeading = useRef<HTMLHeadingElement>(null);
  const requestTrigger = useRef<HTMLElement | null>(null);
  const [selectedRequest, setSelectedRequest] = useState<ReviewRequest | null>(
    null,
  );
  const [request, setRequest] = useState<RequestDetail | null>(null);
  const [suggestion, setSuggestion] = useState<SuggestionDetail | null>(null);
  const attention = projectAttention(
    { ...state, reviewRequests: catalog.requests },
    project.id,
  );
  const localReviews = attention.items.filter(
    (item) => item.binding || item.draft,
  );
  const labelMember = (id: string) =>
    memberLabel(id, state.user, catalog.members);
  const requests = attention.items.flatMap((item) => item.requests);
  const [historyPreview, setHistoryPreview] = useState(false);
  const loadRequest = (id: string) =>
    run(async () => {
      setRequest(await call<RequestDetail>("request", { id }));
      await call("read-notification", { id });
    });
  const closeRequest = () => {
    setSelectedRequest(null);
    setRequest(null);
  };
  const showRequest = (selected: ReviewRequest) => {
    requestTrigger.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setSelectedRequest(selected);
    setRequest(null);
    void loadRequest(selected.id);
  };
  return (
    <div className="project-requests">
      <section>
        <h3 ref={requestHeading} tabIndex={-1}>
          Requests to review
        </h3>
        {requests.length === 0 && <p>No requests need your decision.</p>}
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
              onClick={() => showRequest(r)}
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
            title={
              selectedRequest.status === "pending"
                ? "Review request"
                : "Request history"
            }
            className="changes-review-modal request-review-modal"
            onClose={() => {
              if (!busy) closeRequest();
            }}
            onEscapeKeyDown={(event) => {
              if (busy) event.preventDefault();
            }}
            onKeyDownCapture={handleReviewTab}
            onCloseAutoFocus={(event) => {
              if (!requestTrigger.current?.isConnected) {
                event.preventDefault();
                requestHeading.current?.focus();
              }
            }}
          >
            <header className="review-header">
              <h2>
                {selectedRequest.status === "pending"
                  ? "Review request"
                  : "Request history"}
              </h2>
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
                    {selectedRequest.status !== "pending"
                      ? `Request ${request.request.status}.`
                      : request.request.type === "access"
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
              {selectedRequest.status === "pending" &&
                request?.request.status === "pending" &&
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
      {attention.waitingRequests.length > 0 && (
        <section aria-label="Waiting for approval">
          <h3>Waiting for approval</h3>
          {attention.waitingRequests.map((r) => (
            <div className="governance-row" key={r.id}>
              <span>
                {displayText(r.title)}
                <small>{labelMember(r.author)} · pending</small>
              </span>
              <Button
                size="sm"
                variant="tertiary"
                disabled={busy}
                onClick={() => showRequest(r)}
              >
                View request
              </Button>
            </div>
          ))}
        </section>
      )}
      <section aria-label="Local reviews">
        <h3>Changes on this Mac</h3>
        {localReviews.length === 0 && <p>No local changes need review.</p>}
        {localReviews.map((item) => (
          <div className="governance-row" key={item.key}>
            <span>
              {displayText(item.title)}
              {item.binding && (
                <small>
                  {(item.binding.installationState ?? "").replaceAll("_", " ")}
                </small>
              )}
              {item.draft && (
                <small>
                  {item.draft.status === "stale"
                    ? "Shared version changed"
                    : "Local edits preserved"}
                </small>
              )}
              {item.paths.map((path) => (
                <small key={path}>{path}</small>
              ))}
            </span>
            {item.binding && item.resourceId && (
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => onReviewFile(item.resourceId!)}
              >
                Review update
              </Button>
            )}
            {item.draft && (
              <>
                <Button
                  size="sm"
                  variant="tertiary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      setHistoryPreview(false);
                      setSuggestion(
                        await call<SuggestionDetail>("draft", {
                          id: item.draft!.id,
                        }),
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
                      await call("dismiss", { id: item.draft!.id });
                      setSuggestion(null);
                    })
                  }
                >
                  Dismiss
                </Button>
              </>
            )}
          </div>
        ))}
      </section>
      {(attention.historyRequests.length > 0 ||
        attention.historyDrafts.length > 0) && (
        <section aria-label="Request history">
          <details>
            <summary>
              History (
              {attention.historyRequests.length +
                attention.historyDrafts.length}
              )
            </summary>
            {attention.historyRequests.map((r) => (
              <div className="governance-row" key={r.id}>
                <span>
                  {displayText(r.title)}
                  <small>
                    {labelMember(r.author)} · {r.status}
                  </small>
                </span>
                <Button
                  size="sm"
                  variant="tertiary"
                  disabled={busy}
                  onClick={() => showRequest(r)}
                >
                  View request
                </Button>
              </div>
            ))}
            {attention.historyDrafts.map((draft) => (
              <div className="governance-row" key={draft.id}>
                <span>
                  {displayText(draft.resource.title)}
                  <small>
                    {draft.dismissalReason === "superseded"
                      ? "Superseded snapshot"
                      : draft.status}{" "}
                    ·{" "}
                    {new Date(
                      draft.updatedAt ?? draft.createdAt,
                    ).toLocaleString()}
                  </small>
                </span>
                <Button
                  size="sm"
                  variant="tertiary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      setHistoryPreview(true);
                      setSuggestion(
                        await call<SuggestionDetail>("draft", { id: draft.id }),
                      );
                    })
                  }
                >
                  View saved change
                </Button>
              </div>
            ))}
          </details>
        </section>
      )}
      {suggestion && (
        <ProjectChangeReview
          detail={suggestion}
          readOnly={historyPreview}
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
    </div>
  );
}
