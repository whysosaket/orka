import React, { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import {
  ChevronRightIcon,
  GearIcon,
  SyncIcon,
  XIcon,
} from "@primer/octicons-react";
import type { Resource } from "@portable/protocol";
import type { Snapshot } from "../types.js";
import { Button } from "./button.js";
import { IconButton } from "./icon-button.js";
import { Icon } from "./icon.js";
import { useMemberLabel } from "./member-names.js";

import { syncIssueRecovery } from "./sync-issues.js";
import type { ProjectAttention } from "./sync-attention.js";

export function SyncMenu({
  state,
  attention,
  busy,
  onSync,
  onRetry,
  onSettings,
  onConnect,
  onOpen,
  canConnect = true,
  open: controlledOpen,
  onOpenChange,
  onReview,
  placement = "sidebar",
  actionError = "",
  onDismissError,
  onResumeSetup,
  skillUsagePartial = false,
}: {
  placement?: "sidebar" | "header";
  actionError?: string;
  onDismissError?: () => void;
  onResumeSetup?: () => void;
  skillUsagePartial?: boolean;
  state: Snapshot;
  attention: ProjectAttention;
  busy: boolean;
  onSync: () => void;
  onRetry: () => void;
  onSettings: () => void;
  onConnect: () => void;
  onOpen: (id: string) => void;
  canConnect?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onReview?: () => void;
}) {
  const memberName = useMemberLabel(state.user);
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = onOpenChange ?? setLocalOpen;
  const running = Boolean(state.daemon?.running);
  const connected = running && state.sync?.online && !attention.accountError;
  const progress = running && state.user ? state.syncProgress : null;
  const total = progress?.total;
  const completed =
    total && total > 0 && progress?.completed !== undefined
      ? Math.min(total, Math.max(0, progress.completed))
      : null;
  const percentage =
    completed !== null && total ? Math.round((completed / total) * 100) : null;
  const pending = attention.outbox.filter((item) => item.error);
  const setup = state.onboarding?.setup;
  const setupProjects =
    setup?.projects.filter((p) => setup.selected.includes(p.path)) ?? [];
  const setupRunning = setup?.step === "syncing" || setup?.step === "retrying";
  const needsReconnect = attention.items.some((item) =>
    item.messages.some((message) =>
      /folder (changed|unavailable)|mount is missing/i.test(message),
    ),
  );
  const independentActionError =
    actionError &&
    actionError !== attention.accountError &&
    !attention.items.some((item) => item.messages.includes(actionError));
  const count =
    attention.items.length +
    Number(Boolean(attention.accountError)) +
    Number(Boolean(independentActionError)) +
    Number(Boolean(setup && !setup.deferred && !setupRunning));
  const historyCount =
    attention.historyRequests.length +
    attention.historyDrafts.length +
    attention.activity.length;
  const status = !running
    ? "Sync stopped"
    : connected
      ? "Sync running"
      : "Sync offline";
  const visibleStatus = progress
    ? "Syncing…"
    : placement === "header" && connected
      ? attention.outbox.some((item) => !item.error)
        ? "Changes pending"
        : count
          ? "Needs attention"
          : state.sync?.lastSync
            ? "Up to date"
            : "Connected"
      : status;
  const label = `${visibleStatus}${count ? `, ${count} ${count === 1 ? "notification" : "notifications"}` : ""}`;
  const compactStatus: Record<string, string> = {
    "Changes pending": "Pending",
    "Needs attention": "Attention",
    "Sync stopped": "Stopped",
    "Sync offline": "Offline",
  };
  const leave = (action: () => void) => {
    setOpen(false);
    action();
  };
  const resourceTitle = (id: string) =>
    state.resources.find((item: Resource) => item.resourceId === id)?.title ??
    "Session";
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={`sync-status sync-status--${placement}`}
          data-offline={(running && state.sync?.online === false) || undefined}
          data-only-offline-notice={
            (state.sync?.online === false &&
              !!state.sync.error &&
              count === 1 &&
              attention.items.length === 0 &&
              pending.length === 0) ||
            undefined
          }
          aria-label={label}
          title={label}
        >
          <span
            className={`sync-status-indicator${connected ? " connected" : ""}`}
            aria-hidden="true"
          >
            {progress ? (
              <Icon icon={SyncIcon} size="xs" className="sync-activity-icon" />
            ) : (
              <span className={`dot${connected ? " connected" : ""}`} />
            )}
          </span>
          <span className="sync-status-label">
            {placement === "header"
              ? (compactStatus[visibleStatus] ?? visibleStatus)
              : visibleStatus}
          </span>
          {count > 0 && (
            <span className="sync-status-count" aria-hidden="true">
              {count > 99 ? "99+" : count}
            </span>
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="sync-menu"
          side={placement === "header" ? "bottom" : "right"}
          align="end"
          sideOffset={8}
          collisionPadding={12}
          aria-label="Sync status and notifications"
        >
          <div className="sync-menu-heading">
            <h2>Sync</h2>
            <IconButton
              icon={GearIcon}
              size="sm"
              variant="tertiary"
              aria-label="Sync settings"
              onClick={() => leave(onSettings)}
            />
            <Popover.Close asChild>
              <IconButton
                icon={XIcon}
                size="sm"
                variant="tertiary"
                aria-label="Close sync status"
              />
            </Popover.Close>
          </div>
          <div className="sync-menu-status">
            <div>
              <span
                className={`dot${connected ? " connected" : ""}`}
                aria-hidden="true"
              />
              <strong>
                {!running
                  ? "Background sync stopped"
                  : connected
                    ? "Connected"
                    : "Waiting to sync"}
              </strong>
            </div>
            <p>
              Last success:{" "}
              {state.sync?.lastSync
                ? new Date(state.sync.lastSync).toLocaleString()
                : "Never"}
            </p>
            <div className="sync-menu-actions">
              {needsReconnect && (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy || !canConnect}
                  onClick={() => leave(onConnect)}
                >
                  Reconnect folder
                </Button>
              )}
              <Button
                variant="secondary"
                size="sm"
                disabled={busy || !running || Boolean(progress)}
                onClick={onSync}
              >
                <Icon icon={SyncIcon} />
                {progress ? "Syncing…" : busy ? "Working…" : "Sync now"}
              </Button>
              {!running && (
                <Button
                  variant="tertiary"
                  size="sm"
                  onClick={() => leave(onSettings)}
                >
                  Set up background sync
                </Button>
              )}
            </div>
          </div>
          <div
            className="sync-menu-feed"
            tabIndex={0}
            aria-label="Sync details"
          >
            {skillUsagePartial && (
              <section
                className="sync-menu-notification"
                aria-label="Skill usage details"
              >
                <h3>Skill usage</h3>
                <p>
                  Usage covers available local history; some records could not
                  be read.
                </p>
              </section>
            )}
            {setup && (
              <section className="sync-menu-notification">
                <h3>
                  {setup.deferred
                    ? "Project setup saved"
                    : setupRunning
                      ? "Initial project sync"
                      : "Project setup needs attention"}
                </h3>
                {setup.deferred ? (
                  <p>Resume where you left off when you’re ready.</p>
                ) : (
                  <>
                    <p>
                      {
                        setupProjects.filter((p) => p.status === "synced")
                          .length
                      }{" "}
                      of {setupProjects.length} projects synced
                    </p>
                    <ul>
                      {setupProjects.map((p) => (
                        <li key={p.path}>
                          {p.name} ·{" "}
                          {p.status === "synced"
                            ? "Synced"
                            : p.error ||
                              (setupRunning ? "In progress" : "Pending")}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {!setupRunning && onResumeSetup && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => leave(onResumeSetup)}
                  >
                    {setup.deferred ? "Resume setup" : "Open setup recovery"}
                  </Button>
                )}
              </section>
            )}
            {independentActionError && (
              <section
                className="sync-menu-notification"
                aria-label="Action details"
              >
                <h3>Action details</h3>
                <p>{actionError}</p>
                {onDismissError && (
                  <Button size="sm" variant="tertiary" onClick={onDismissError}>
                    Dismiss
                  </Button>
                )}
              </section>
            )}
            {attention.accountError && (
              <section
                className="sync-menu-notification"
                aria-label="Account sync"
              >
                <h3>Account sync</h3>
                <p>{attention.accountError}</p>
              </section>
            )}
            {attention.accountIssues.length > 0 && (
              <section
                className="sync-menu-notification"
                aria-label="Account diagnostics"
              >
                <details>
                  <summary>
                    <ChevronRightIcon
                      className="sync-disclosure-chevron"
                      size={14}
                      aria-hidden="true"
                    />
                    Account diagnostics ({attention.accountIssues.length})
                  </summary>
                  {attention.accountIssues.map((issue) => (
                    <div key={issue.source}>
                      <p>{issue.error}</p>
                      <small>
                        {issue.source.slice("history:unattributed:".length)}
                      </small>
                    </div>
                  ))}
                </details>
              </section>
            )}
            {attention.items.length > 0 && (
              <h3>
                {attention.items.length}{" "}
                {attention.items.length === 1 ? "item needs" : "items need"}{" "}
                attention
              </h3>
            )}
            {attention.items.map((item) => (
              <section
                className="sync-menu-notification"
                key={item.key}
                role="group"
                aria-label={item.title}
              >
                <h4>{item.title}</h4>
                {item.requests.length > 0 && (
                  <p>
                    {item.requests.length === 1
                      ? "A request is ready for your decision."
                      : `${item.requests.length} requests are ready for your decision.`}
                  </p>
                )}
                {item.binding && (
                  <p>
                    {item.binding.installationState === "locally_modified"
                      ? "Local edits are preserved. Review the shared update and local copies."
                      : "A local update needs review."}
                  </p>
                )}
                {item.draft && !item.binding && (
                  <p>Local changes are ready for review.</p>
                )}
                {item.messages.map((message) => (
                  <p key={message}>{message}</p>
                ))}
                {item.paths.length > 0 && (
                  <details>
                    <summary>
                      <ChevronRightIcon
                        className="sync-disclosure-chevron"
                        size={14}
                        aria-hidden="true"
                      />
                      Show affected copies ({item.paths.length})
                    </summary>
                    <ul>
                      {item.paths.map((path) => (
                        <li key={path}>{path}</li>
                      ))}
                    </ul>
                  </details>
                )}
                {item.messages.map(
                  (message) =>
                    syncIssueRecovery(message) && (
                      <small key={message}>{syncIssueRecovery(message)}</small>
                    ),
                )}
                {item.messages.some((message) =>
                  /unsupported.*version|unsupported.*format/i.test(message),
                ) && (
                  <small>
                    Requires compatible tool or transcript support in Orka.
                  </small>
                )}
                {item.conflicts.length > 0 ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      leave(() => onOpen(item.conflicts[0].resourceId))
                    }
                  >
                    Review conflict
                  </Button>
                ) : item.requests.length > 0 || item.binding || item.draft ? (
                  onReview && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => leave(onReview)}
                    >
                      Review changes
                    </Button>
                  )
                ) : item.uploads.length > 0 ? (
                  item.uploads.every(
                    (upload) =>
                      !/^4\d\d:/.test(upload.error ?? "") ||
                      /^(401|408|429):/.test(upload.error ?? ""),
                  ) ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      onClick={onRetry}
                    >
                      Retry uploads
                    </Button>
                  ) : (
                    item.resourceId && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => leave(() => onOpen(item.resourceId!))}
                      >
                        View change
                      </Button>
                    )
                  )
                ) : null}
              </section>
            ))}
            {attention.waitingRequests.length > 0 && (
              <section className="sync-menu-notification">
                <h3>Waiting for approval</h3>
                {attention.waitingRequests.map((request) => (
                  <p key={request.id}>{request.title}</p>
                ))}
                {onReview && (
                  <Button
                    size="sm"
                    variant="tertiary"
                    onClick={() => leave(onReview)}
                  >
                    Open requests
                  </Button>
                )}
              </section>
            )}
            {historyCount > 0 && (
              <section className="sync-menu-notification">
                <details>
                  <summary>
                    <ChevronRightIcon
                      className="sync-disclosure-chevron"
                      size={14}
                      aria-hidden="true"
                    />
                    History ({historyCount})
                  </summary>
                  {attention.historyRequests.map((request) => (
                    <p key={request.id}>
                      {request.title} · {request.status}
                    </p>
                  ))}
                  {attention.historyDrafts.slice(0, 5).map((draft) => (
                    <p key={draft.id}>
                      {draft.resource.title} ·{" "}
                      {draft.dismissalReason === "superseded"
                        ? "superseded"
                        : draft.status}
                    </p>
                  ))}
                  {attention.historyDrafts.length > 5 && (
                    <p>
                      {attention.historyDrafts.length - 5} more saved changes
                    </p>
                  )}
                  {attention.activity.map((activity) => (
                    <div key={activity.id}>
                      <p>
                        {memberName(activity.author)} continued your session as
                        a copy.
                      </p>
                      <small>{resourceTitle(activity.copyId)}</small>
                      <Button
                        variant="tertiary"
                        size="sm"
                        onClick={() => leave(() => onOpen(activity.copyId))}
                      >
                        View copy
                      </Button>
                    </div>
                  ))}
                  {onReview &&
                    attention.historyRequests.length +
                      attention.historyDrafts.length >
                      0 && (
                      <Button
                        size="sm"
                        variant="tertiary"
                        onClick={() => leave(onReview)}
                      >
                        Open request history
                      </Button>
                    )}
                </details>
              </section>
            )}
          </div>
          {progress && (
            <div className="sync-menu-progress">
              <div
                className="sync-menu-progress-status"
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                <Icon
                  icon={SyncIcon}
                  size="sm"
                  className="sync-activity-icon"
                />
                <div className="sync-menu-progress-copy">
                  <strong>{progress.label}</strong>
                  {progress.detail && (
                    <p title={progress.detail}>{progress.detail}</p>
                  )}
                </div>
                {percentage !== null && (
                  <span className="sync-menu-progress-count">
                    {completed} of {total}
                  </span>
                )}
              </div>
              {percentage !== null && (
                <div
                  className="sync-menu-progress-track"
                  role="progressbar"
                  aria-label={progress.label}
                  aria-valuemin={0}
                  aria-valuemax={total ?? undefined}
                  aria-valuenow={completed ?? undefined}
                  aria-valuetext={`${completed} of ${total} complete (${percentage}%)`}
                >
                  <span style={{ width: `${percentage}%` }} />
                </div>
              )}
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
