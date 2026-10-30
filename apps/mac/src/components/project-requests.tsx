import React, { useState } from "react";
import type { ReviewRequest, Resource } from "@portable/protocol";
import type { LocalDraft, Project, Snapshot } from "../types.js";
import { displayText } from "./resource-presentation.js";
import { Button } from "./button.js";
import { FileReview } from "./file-review.js";
import { visibleRequest } from "../lib/features.js";
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
}
interface SuggestionDetail {
  draft: LocalDraft;
  files: Record<string, string>;
  related: { resource: Resource; duplicate: boolean }[];
}
export function ProjectRequests({
  project,
  state,
  catalog,
  call,
  run,
  busy,
  setMessage,
  onReviewFile,
}: {
  project: Project;
  state: Snapshot;
  catalog: GovernanceCatalog;
  call: ProjectCall;
  run: (fn: () => Promise<void>) => Promise<void>;
  busy: boolean;
  setMessage: (value: string) => void;
  onReviewFile: (id: string) => void;
}) {
  const [visibleCount, setVisibleCount] = useState(5);
  const [request, setRequest] = useState<RequestDetail | null>(null);
  const [suggestion, setSuggestion] = useState<SuggestionDetail | null>(null);
  const suggestions = (state.drafts ?? []).filter(
    (d) =>
      d.projectId === project.id &&
      !["dismissed", "published"].includes(d.status) &&
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
              onClick={() =>
                void run(async () => {
                  setRequest(
                    await call<RequestDetail>("request", { id: r.id }),
                  );
                  await call("read-notification", { id: r.id });
                })
              }
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
        {request && (
          <section>
            <h4>{displayText(request.request.title)}</h4>
            {request.content?.resource?.memory && (
              <p>
                Topic: {request.content?.resource.memory.topic} · Scope:{" "}
                {request.content?.resource.memory.scope || "Project"} ·
                Provider: {request.content?.resource.memory.provider}
              </p>
            )}
            {(request.content?.resource?.memory?.supersedes?.length ?? 0) >
              0 && (
              <p>
                Replaces active knowledge:{" "}
                {request.content?.resource!.memory!.supersedes.join(", ")}
              </p>
            )}
            {request.audience && (
              <p>
                Visible after approval:{" "}
                {request.audience.map(labelMember).join(", ")}. Known source
                restrictions continue to apply.
              </p>
            )}
            {request.files && (
              <FileReview files={request.files} before={request.before} />
            )}
            <p>
              {request.request.type === "access"
                ? `Requested access: ${accessNames[request.request.requestedMode!]}`
                : "Approval publishes exactly this prepared version."}
            </p>
            {request.request.status === "pending" &&
              request.request.canReview && (
                <div className="actions">
                  {(["approve", "reject"] as const).map((decision) => (
                    <Button
                      key={decision}
                      disabled={busy}
                      variant={decision === "approve" ? "primary" : "secondary"}
                      onClick={() =>
                        void run(async () => {
                          const result = await call<ReviewRequest>("decide", {
                            id: request.request.id,
                            decision,
                            previewHash: request.request.previewHash,
                            expectedPolicyRevision: catalog.policyRevision,
                          });
                          setRequest(null);
                          setMessage(
                            result.status === "stale"
                              ? "The resource or permissions changed. A refreshed suggestion is needed."
                              : `Request ${result.status}.`,
                          );
                        })
                      }
                    >
                      {decision === "approve" ? "Approve request" : "Reject"}
                    </Button>
                  ))}
                </div>
              )}
          </section>
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
            These changes are private until you review and send them for
            approval. Personal memory continues to update normally.
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
            <section>
              <h4>{displayText(suggestion.draft.resource.title)}</h4>
              <p>
                Scope: {suggestion.draft.resource.memory?.scope || "Project"} ·
                Provider:{" "}
                {suggestion.draft.resource.memory?.provider ??
                  suggestion.draft.resource.source}
              </p>
              <p>
                Known source context:{" "}
                {suggestion.draft.resource.contextSources?.length ?? 0}{" "}
                resources. Sharing keeps their audience restrictions.
              </p>
              {(suggestion.draft.resource.memory?.supersedes?.length ?? 0) >
                0 && (
                <p>
                  Supersedes:{" "}
                  {suggestion.draft.resource.memory!.supersedes.join(", ")}
                </p>
              )}
              <FileReview files={suggestion.files} />
              {["stale", "rejected"].includes(suggestion.draft.status) && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await call("refresh-draft", { id: suggestion.draft.id });
                      setSuggestion(
                        await call<SuggestionDetail>("draft", {
                          id: suggestion.draft.id,
                        }),
                      );
                    })
                  }
                >
                  Review latest and retry
                </Button>
              )}
              {suggestion.related?.length > 0 && (
                <>
                  <h4>Related shared knowledge</h4>
                  {suggestion.related.map((r) => (
                    <p key={r.resource.resourceId}>
                      {displayText(r.resource.title)}
                      {r.duplicate
                        ? " · Same content"
                        : " · Review scope and possible conflicts"}
                    </p>
                  ))}
                </>
              )}
              <Button
                disabled={busy || suggestion.draft.status !== "local"}
                onClick={() =>
                  void run(async () => {
                    await call("submit-draft", { id: suggestion.draft.id });
                    setSuggestion(null);
                    setMessage("Suggestion submitted for publisher review.");
                  })
                }
              >
                Send for approval
              </Button>
            </section>
          )}
        </section>
      )}
    </div>
  );
}
