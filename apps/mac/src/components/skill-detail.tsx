import React, {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ChecklistIcon,
  DownloadIcon,
  FileIcon,
  GitCompareIcon,
  GitPullRequestIcon,
  PencilIcon,
} from "@primer/octicons-react";
import type {
  Inspection,
  Project,
  ProjectResource as Resource,
  Snapshot,
} from "../types.js";
import { Button } from "./button.js";
import { Icon } from "./icon.js";
import { IconButton } from "./icon-button.js";
import { CopyLinkButton } from "./copy-link-button.js";
import { SegmentedControl } from "./segmented-control.js";
import { ActionPopover } from "./resource-actions.js";
import { LoadingRegion } from "./loading-region.js";
import { markdownComponents } from "./resource-content.js";
import { readSkillMarkdown, type SkillMarkdown } from "./skill-markdown.js";
import { skillSharing } from "./skill-sharing.js";
import { sourcePath } from "./project-sources.js";
import { useMemberLabel } from "./member-names.js";
import { useElementWidth } from "../hooks/use-element-width.js";
import { FileDiffCard, SourceCard, fileKind } from "./file-diff.js";
import { ReaderState } from "./skill-state.js";
import { SkillActionTooltip } from "./skill-action-tooltip.js";
import { SkillReviewOverlay, type ReviewMode } from "./skill-review-overlay.js";
import { reviewStatus, skillReviewState } from "./skill-review-state.js";
import type { ResourceView } from "./use-resource-view.js";
import type { ResourceActionHandlers } from "./use-resource-actions.js";

/** Below this reader width the rail folds into the single-column layout. */
const COMPACT_WIDTH = 840;

const sampleInspection: Inspection = {
  content:
    "# Review checklist\n\nKeep the project context available across your tools.\n\n## Working notes\n\nReview the current approach and the decisions behind it.\n\n- Inspect the existing behavior\n- Keep useful context together\n- Verify the result",
  previous: null,
  paths: [],
};

const factDate = (iso: string) => {
  const date = new Date(iso);
  return `${date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })} at ${date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  })}`;
};
const metaDate = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

interface SkillDocumentProps {
  inspection: Inspection;
  file: string;
  changes: boolean;
  rawMarkdown: boolean;
}

/**
 * The document column body. It is a component rather than an inline render so
 * the loading region's skeleton pass, which clones element children through
 * React.Children.map, never reaches Markdown's string child.
 */
function SkillDocument({
  inspection,
  file,
  changes,
  rawMarkdown,
}: SkillDocumentProps) {
  const kind = fileKind(file);
  const skillFile = file === "SKILL.md";
  if (kind.label === "PDF") return <SourceCard path={file} content={null} />;
  if (changes) {
    if (inspection.previous === null)
      return (
        <ReaderState
          illustration="previous-version-unavailable"
          title="Previous version unavailable"
          message="The previous version isn’t cached on this Mac."
        />
      );
    if (inspection.content === null)
      return (
        <ReaderState
          illustration="preview-unavailable"
          title="Preview unavailable"
          message="Binary files can’t be compared. Use Open in editor to view this file."
        />
      );
    if (inspection.previous === inspection.content)
      return (
        <ReaderState
          className="reader-state--large"
          illustration="no-changes"
          title="No changes"
          message="This file matches its cached version."
        />
      );
    return (
      <div className="skill-comparison">
        <span className="skill-comparison-timeline" aria-hidden="true">
          <span />
        </span>
        <FileDiffCard
          path={file}
          before={inspection.previous}
          after={inspection.content}
        />
      </div>
    );
  }
  if (inspection.content === null)
    return <SourceCard path={file} content={null} />;
  if (kind.language !== "markdown")
    return <SourceCard path={file} content={inspection.content} />;
  const document = skillFile ? readSkillMarkdown(inspection.content) : null;
  if (document?.invalid)
    return (
      <SourceCard path={file} content={inspection.content} variant="plain" />
    );
  if (rawMarkdown)
    return <SourceCard path={file} content={inspection.content} />;
  const body = document ? document.body : inspection.content;
  if (!body.trim())
    return (
      <ReaderState
        illustration="empty-markdown-body"
        title={skillFile ? "No skill instructions" : "Empty file"}
        message={
          skillFile
            ? "Only skill metadata is present."
            : "This file has no content yet."
        }
      />
    );
  return (
    <article className="markdown-content" aria-label="Rendered Markdown">
      <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {body}
      </Markdown>
    </article>
  );
}

export interface SkillDetailProps {
  resource: Resource;
  /** The display title with SKILL.md frontmatter already applied. */
  title: string;
  skill: (SkillMarkdown & { key: string }) | null;
  project: Project;
  user: string | null;
  busy: boolean;
  accessRequest?: React.ReactNode;
  view: ResourceView;
  actions: ResourceActionHandlers;
  state: Snapshot;
  offline: boolean;
  onRefresh: () => Promise<void>;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
  /** Opens Requests for local skills whose sharing needs review. */
  onGovernance?: () => void;
}

/**
 * The skill reader: a document column beside a 360px rail with Skill info
 * and Files, folding into one column when the reader is narrow.
 */
export function SkillDetail({
  resource,
  title,
  skill,
  project,
  user,
  busy,
  accessRequest,
  view,
  actions,
  state,
  offline,
  onRefresh,
  onNotice,
  onError,
  onGovernance,
}: SkillDetailProps) {
  const [rootRef, width] = useElementWidth<HTMLElement>();
  const compact = width > 0 && width < COMPACT_WIDTH;
  const memberName = useMemberLabel(user);
  const author = memberName(resource.updatedBy);
  const sharing = skillSharing(resource);
  const review = skillReviewState(resource, state, project);
  const status = reviewStatus(review);
  const infoHeadingId = useId();
  const filesHeadingId = useId();
  const [overlay, setOverlay] = useState<ReviewMode | null>(null);
  const incomingRef = useRef<HTMLButtonElement>(null);
  const outgoingRef = useRef<HTMLButtonElement>(null);
  const editorRef = useRef<HTMLButtonElement>(null);

  // SKILL.md is the expected entry point even if its manifest entry is missing.
  const files = resource.files.map(({ path }) => ({ path }));
  if (!files.some((file) => file.path === "SKILL.md"))
    files.unshift({ path: "SKILL.md" });
  files.sort((a, b) =>
    a.path === "SKILL.md" ? -1 : b.path === "SKILL.md" ? 1 : 0,
  );
  const fileListed = resource.files.some((file) => file.path === view.file);
  const selectedFileMissing =
    !fileListed || /file not found/i.test(view.inspectionError);
  const skillFile = view.file === "SKILL.md";
  const kind = fileKind(view.file);
  const rawForced = skillFile && skill?.invalid === true;
  const editorPath = sourcePath(project, resource.sourceId);
  const shared = !resource.local && resource.revision > 0;
  const firstApproval = resource.local && resource.sharing === "approval";
  const sharedAccessRequest =
    resource.local || review.pending ? null : accessRequest;
  const installedRevision = review.binding?.base?.revision;
  const versionLabel =
    review.incoming &&
    installedRevision !== undefined &&
    installedRevision !== resource.revision
      ? `${resource.revision} shared · ${installedRevision} on this Mac`
      : String(resource.revision);
  const contentPending = !view.inspection && !view.inspectionError;
  const description = skill?.description ?? "";

  // Compact readers clamp long descriptions and offer Show more.
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const descriptionRef = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    const element = descriptionRef.current;
    if (!element || !compact || expanded) {
      if (!compact) setOverflowing(false);
      return;
    }
    setOverflowing(element.scrollHeight > element.clientHeight + 1);
  }, [compact, expanded, description, width]);

  const retry = (
    <Button size="sm" variant="tertiary" onClick={view.retryInspection}>
      Retry
    </Button>
  );
  const errorState = (message: string) => {
    if (!fileListed || /file not found/i.test(message))
      return (
        <ReaderState
          illustration="skill-md-missing"
          title={`${view.file} is missing`}
          message={
            files.some((file) => file.path !== view.file)
              ? "You can still open the other skill files."
              : undefined
          }
          action={retry}
        />
      );
    if (offline)
      return (
        <ReaderState
          illustration="file-unavailable-offline"
          title="File unavailable offline"
          message="Reconnect and sync to load this file."
          action={retry}
        />
      );
    return (
      <ReaderState
        tone="alert"
        illustration="preview-unavailable"
        title={`Couldn’t load ${view.file}`}
        action={retry}
      />
    );
  };
  const selectFile = (event: MouseEvent, path: string) => {
    event.preventDefault();
    if (fileKind(path).label === "PDF") view.setChanges(false);
    view.setFile(path);
  };
  const fileRows = files.map((file) => {
    const selected = file.path === view.file;
    const missing =
      !resource.files.some((entry) => entry.path === file.path) ||
      (selected && selectedFileMissing);
    return (
      <li key={file.path}>
        <button
          type="button"
          className="skill-file"
          aria-current={selected ? "true" : undefined}
          title={file.path}
          onClick={(event) => selectFile(event, file.path)}
        >
          <Icon
            icon={fileKind(file.path).listIcon}
            size="sm"
            variant={selected ? "primary" : "tertiary"}
          />
          <span className="skill-file-name">
            {file.path}
            {missing ? " · Missing" : ""}
          </span>
        </button>
      </li>
    );
  });
  const infoActions = (
    <div className="skill-info-actions">
      {review.incoming && (
        <SkillActionTooltip label="Review local update">
          <span className="skill-action-badge">
            <IconButton
              ref={incomingRef}
              icon={ChecklistIcon}
              size="sm"
              variant="tertiary"
              aria-label={
                review.incomingBlocked
                  ? "Review local update. Local edits need install review"
                  : "Review local update"
              }
              disabled={busy}
              onClick={() => setOverlay("incoming")}
            />
            {review.incomingBlocked && (
              <span className="skill-action-dot" aria-hidden="true" />
            )}
          </span>
        </SkillActionTooltip>
      )}
      {review.outgoing && (
        <SkillActionTooltip label="Review local edits">
          <IconButton
            ref={outgoingRef}
            icon={GitPullRequestIcon}
            size="sm"
            variant="tertiary"
            aria-label="Review local edits"
            disabled={busy}
            onClick={() => setOverlay("outgoing")}
          />
        </SkillActionTooltip>
      )}
      {shared && (
        <SkillActionTooltip label="Copy skill link">
          <CopyLinkButton
            iconOnly
            nativeTooltip={false}
            value={`orka://project/${project.id}/${resource.resourceId}`}
            label="Copy skill link"
            disabled={busy}
            onError={onError}
          />
        </SkillActionTooltip>
      )}
      {shared && (
        <SkillActionTooltip label="Export ZIP">
          <IconButton
            icon={DownloadIcon}
            size="sm"
            variant="tertiary"
            aria-label="Export ZIP"
            disabled={busy}
            onClick={() => void actions.exportZip()}
          />
        </SkillActionTooltip>
      )}
    </div>
  );
  const primaryActions = (
    <>
      <Button
        ref={editorRef}
        variant="primary"
        size="sm"
        disabled={
          busy ||
          !editorPath ||
          selectedFileMissing ||
          (offline && !!view.inspectionError)
        }
        onClick={() => void actions.openEditor(view.file)}
      >
        <Icon icon={PencilIcon} /> Open in editor
      </Button>
      {!resource.local && (
        <Button
          size="sm"
          variant="tertiary"
          className="skill-compare"
          disabled={
            busy ||
            contentPending ||
            !fileListed ||
            !!view.inspectionError ||
            kind.label === "PDF" ||
            view.inspection?.content === null
          }
          aria-pressed={view.changes}
          onClick={() => view.setChanges((value) => !value)}
        >
          <Icon icon={view.changes ? FileIcon : GitCompareIcon} />
          {view.changes ? "Show content" : "View changes"}
        </Button>
      )}
    </>
  );
  const localNote =
    resource.local && !firstApproval ? (
      <p className="skill-info-note">
        <span>{sharing.message}</span>
        {project.governed &&
          project.sharing?.skill !== false &&
          sharing.reviewable &&
          onGovernance && (
            <Button size="sm" variant="tertiary" onClick={onGovernance}>
              Review changes
            </Button>
          )}
      </p>
    ) : null;
  const segmented = kind.language === "markdown" && (
    <SegmentedControl
      label="Markdown view"
      value={view.rawMarkdown || rawForced ? "markdown" : "formatted"}
      options={[
        { value: "formatted", label: "Formatted" },
        { value: "markdown", label: "Markdown" },
      ]}
      disabled={
        rawForced || contentPending || !fileListed || !!view.inspectionError
      }
      onChange={(mode) => {
        view.setRawMarkdown(mode === "markdown");
        view.setChanges(false);
      }}
    />
  );

  return (
    <section
      ref={rootRef}
      className="resource-detail resource-detail--skill skill-detail"
      data-layout={compact ? "compact" : "wide"}
      aria-label="Skill details"
    >
      <div className="skill-reader">
        <div className="skill-title-card">
          {status && (
            <span className={`skill-status skill-status--${status.tone}`}>
              {status.label}
            </span>
          )}
          {resource.local && (
            <span
              className={`skill-status skill-status--${resource.sharing === "approval" ? "warning" : "neutral"}`}
            >
              {sharing.label}
            </span>
          )}
          <div className="skill-title-row">
            <h2 className="skill-title">{title}</h2>
            {resource.global && (
              <span className="skill-origin-badge">Global</span>
            )}
          </div>
          {description && (
            <p
              ref={descriptionRef}
              className={`skill-description${
                compact && !expanded ? " skill-description--clamped" : ""
              }`}
            >
              {description}
            </p>
          )}
          {compact && (overflowing || expanded) && (
            <Button
              size="sm"
              variant="tertiary"
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? "Show less" : "Show more"}
            </Button>
          )}
        </div>
        {compact && (
          <>
            <p className="skill-meta">
              Updated by {author} · {metaDate(resource.updatedAt)} ·{" "}
              {resource.local ? sharing.label : `Version ${versionLabel}`}
            </p>
            {(sharedAccessRequest || localNote) && (
              <div className="skill-compact-notes">
                {sharedAccessRequest}
                {localNote}
              </div>
            )}
            <div className="skill-compact-actions">
              <div className="skill-actions-inline">{primaryActions}</div>
              {infoActions}
            </div>
          </>
        )}
        {!editorPath && (
          <p className="skill-context">
            Reconnect the project folder in Settings to open files in your
            editor.
          </p>
        )}
        {rawForced && (
          <p className="skill-context">
            Couldn’t read skill metadata. Showing the original file.
          </p>
        )}
        {(segmented || compact) && (
          <div
            className="skill-file-tabs"
            data-forced-markdown={rawForced || undefined}
            data-unavailable={
              contentPending ||
              !!view.inspectionError ||
              !fileListed ||
              undefined
            }
          >
            <div className="skill-file-tabs-start">{segmented}</div>
            {compact && files.length > 0 && (
              <ActionPopover
                label="Files"
                align="end"
                className="skill-files-popover"
                trigger={
                  <Button
                    size="sm"
                    variant="tertiary"
                    aria-label={`Files, ${files.length}`}
                  >
                    Files · {files.length}
                  </Button>
                }
              >
                <ul className="skill-file-list">{fileRows}</ul>
              </ActionPopover>
            )}
          </div>
        )}
        <div className="skill-document">
          <LoadingRegion
            id="skill-content"
            label="Loading content…"
            data={view.inspection}
            sample={sampleInspection}
            skeleton={
              <div className="skill-content-skeleton" aria-hidden="true">
                {[74, 100, 95, 90, 64, 100, 96, 88].map((width, index) => (
                  <span key={index} style={{ width: `${width}%` }} />
                ))}
              </div>
            }
            error={
              view.inspectionError || !fileListed
                ? errorState(view.inspectionError)
                : undefined
            }
          >
            {(inspection) => (
              <SkillDocument
                inspection={inspection}
                file={view.file}
                changes={view.changes}
                rawMarkdown={view.rawMarkdown}
              />
            )}
          </LoadingRegion>
        </div>
      </div>
      {!compact && (
        <aside className="skill-rail" aria-label="Skill information">
          {sharedAccessRequest}
          <section
            className="skill-rail-card skill-info"
            aria-labelledby={infoHeadingId}
          >
            <div className="skill-info-body">
              <div className="skill-info-heading">
                <h2 id={infoHeadingId} className="skill-card-label">
                  Skill info
                </h2>
                {infoActions}
              </div>
              <dl className="skill-facts">
                <div className="skill-fact">
                  <dt>Updated by</dt>
                  <dd>{author}</dd>
                </div>
                <div className="skill-fact">
                  <dt>Updated at</dt>
                  <dd>
                    <time dateTime={resource.updatedAt}>
                      {factDate(resource.updatedAt)}
                    </time>
                  </dd>
                </div>
                {firstApproval ? null : resource.local ? (
                  <div className="skill-fact">
                    <dt>Source</dt>
                    <dd>{sharing.label}</dd>
                  </div>
                ) : (
                  <div className="skill-fact">
                    <dt>Version</dt>
                    <dd>{versionLabel}</dd>
                  </div>
                )}
              </dl>
              {localNote}
            </div>
            <div className="skill-actions">{primaryActions}</div>
          </section>
          <section
            className="skill-rail-card skill-files"
            aria-labelledby={filesHeadingId}
          >
            <div className="skill-files-heading">
              <h2 id={filesHeadingId}>Files</h2>
              <span className="skill-files-count">
                <span className="sr-only">
                  {files.length} {files.length === 1 ? "file" : "files"}
                </span>
                <span aria-hidden="true">{files.length}</span>
              </span>
            </div>
            <ul className="skill-file-list">{fileRows}</ul>
          </section>
        </aside>
      )}
      {overlay && (
        <SkillReviewOverlay
          mode={overlay}
          project={project}
          resource={resource}
          state={state}
          onClose={() => setOverlay(null)}
          onRefresh={onRefresh}
          onNotice={onNotice}
          onCloseAutoFocus={(event) => {
            // Return focus to the opener explicitly: WebKit does not focus a
            // clicked button, so the captured active element can be the body.
            const trigger =
              overlay === "incoming"
                ? incomingRef.current
                : outgoingRef.current;
            event.preventDefault();
            (trigger?.isConnected ? trigger : editorRef.current)?.focus();
          }}
        />
      )}
    </section>
  );
}
