import React from "react";
import { XIcon } from "@primer/octicons-react";
import type { Resource } from "@portable/protocol";
import type { LocalDraft } from "../types.js";
import { Button } from "./button.js";
import { FileReview } from "./file-review.js";
import { IconButton } from "./icon-button.js";
import { Overlay } from "./overlay.js";
import { displayText } from "./resource-presentation.js";
import { handleReviewTab } from "./review-focus.js";
import type { FileManifestEntry } from "./diff-model.js";

export interface SuggestionDetail {
  draft: LocalDraft;
  files: Record<string, string>;
  related: { resource: Resource; duplicate: boolean }[];
  canPublish?: boolean;
  baseRevision?: number;
  before?: Record<string, string>;
  manifest?: FileManifestEntry[];
  beforeManifest?: FileManifestEntry[];
}

export function ProjectChangeReview({
  detail,
  busy,
  error,
  onClose,
  onRefresh,
  onSubmit,
}: {
  detail: SuggestionDetail;
  busy: boolean;
  error: string;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onSubmit: () => Promise<void>;
}) {
  const { draft } = detail;
  const resource = draft.resource;
  const sharedVersion = detail.baseRevision
    ? `Version ${detail.baseRevision}`
    : Object.keys(detail.before ?? {}).length > 0
      ? "Shared version"
      : "Not shared";
  return (
    <Overlay
      open
      title="Review changes"
      className="changes-review-modal"
      onClose={() => {
        if (!busy) onClose();
      }}
      onEscapeKeyDown={(event) => {
        if (busy) event.preventDefault();
      }}
      onKeyDownCapture={handleReviewTab}
    >
      <header className="review-header">
        <div className="review-heading">
          <h2>Review changes</h2>
          <div className="review-versions" aria-label="Compared versions">
            <span className="version-pill">{sharedVersion}</span>
            <span aria-hidden="true">to</span>
            <span className="sr-only">compared with</span>
            <span className="version-pill">This Mac</span>
          </div>
        </div>
        <IconButton
          icon={XIcon}
          size="sm"
          variant="tertiary"
          aria-label="Close review changes"
          disabled={busy}
          onClick={onClose}
        />
      </header>
      <div className="changes-review-body">
        <h3>{displayText(resource.title)}</h3>
        <p>
          Scope: {resource.memory?.scope || "Project"} · Provider:{" "}
          {resource.memory?.provider ?? resource.source}
        </p>
        <p>
          Known source context: {resource.contextSources?.length ?? 0}{" "}
          resources. Sharing keeps their audience restrictions.
        </p>
        {(resource.memory?.supersedes?.length ?? 0) > 0 && (
          <p>Supersedes: {resource.memory!.supersedes.join(", ")}</p>
        )}
        {error && <p role="alert">{error}</p>}
        <FileReview
          files={resource.deleted ? {} : detail.files}
          before={detail.before}
          beforeManifest={detail.beforeManifest}
          afterManifest={
            resource.deleted ? [] : (detail.manifest ?? draft.resource.files)
          }
        />
        {detail.related?.length > 0 && (
          <section>
            <h3>Related shared knowledge</h3>
            {detail.related.map((related) => (
              <p key={related.resource.resourceId}>
                {displayText(related.resource.title)}
                {related.duplicate
                  ? " · Same content"
                  : " · Review scope and possible conflicts"}
              </p>
            ))}
          </section>
        )}
      </div>
      <footer className="review-footer">
        {["stale", "rejected"].includes(draft.status) && (
          <Button disabled={busy} onClick={() => void onRefresh()}>
            Review latest and retry
          </Button>
        )}
        <Button variant="secondary" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button
          disabled={busy || draft.status !== "local"}
          aria-busy={busy}
          onClick={() => void onSubmit()}
        >
          {detail.canPublish ? "Publish update" : "Send for approval"}
        </Button>
      </footer>
    </Overlay>
  );
}
