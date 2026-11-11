import React, { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import {
  ChevronRightIcon,
  GearIcon,
  SyncIcon,
  XIcon,
} from "@primer/octicons-react";
import type {
  Resource,
  SessionConflict,
  Activity,
  ReviewRequest,
} from "@portable/protocol";
import type { Snapshot } from "../types.js";
import { Button } from "./button.js";
import { IconButton } from "./icon-button.js";
import { Icon } from "./icon.js";
import { useMemberLabel } from "./member-names.js";

import { syncIssueRecovery } from "./sync-issues.js";

export function SyncMenu({
  state,
  issues,
  issueCount,
  conflicts,
  notifications,
  busy,
  onSync,
  onRetry,
  onSettings,
  onConnect,
  onOpen,
  canConnect = true,
  open: controlledOpen,
  onOpenChange,
  reviewRequests = [],
  localUpdates = 0,
  privateDrafts = 0,
  onReview,
  placement = "sidebar",
  actionError = "",
  onDismissError,
  onResumeSetup,
}: {
  placement?: "sidebar" | "header";
  actionError?: string;
  onDismissError?: () => void;
  onResumeSetup?: () => void;
  state: Snapshot;
  issues: Map<string, string[]>;
  issueCount: number;
  conflicts: SessionConflict[];
  notifications: Activity[];
  busy: boolean;
  onSync: () => void;
  onRetry: () => void;
  onSettings: () => void;
  onConnect: () => void;
  onOpen: (id: string) => void;
  canConnect?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  reviewRequests?: ReviewRequest[];
  localUpdates?: number;
  privateDrafts?: number;
  onReview?: () => void;
}) {
  const memberName = useMemberLabel(state.user);
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = onOpenChange ?? setLocalOpen;
  const running = Boolean(state.daemon?.running);
  const connected = running && state.sync?.online && !state.sync?.error;
  const pending = state.outbox.filter((item) => item.error);
  const setup = state.onboarding?.setup;
  const setupProjects =
    setup?.projects.filter((p) => setup.selected.includes(p.path)) ?? [];
  const setupRunning = setup?.step === "syncing" || setup?.step === "retrying";
  const needsReconnect = [...issues.keys()].some((message) =>
    /folder (changed|unavailable)|mount is missing/i.test(message),
  );
  const count =
    issueCount +
    conflicts.length +
    notifications.length +
    reviewRequests.length +
    localUpdates +
    privateDrafts +
    Number(Boolean(actionError)) +
    Number(Boolean(setup));
  const status = !running
    ? "Sync stopped"
    : connected
      ? "Sync running"
      : "Sync offline";
  const visibleStatus =
    placement === "header" && connected
      ? state.outbox.length
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
          aria-label={label}
          title={label}
        >
          <span
            className={`sync-status-indicator${connected ? " connected" : ""}`}
            aria-hidden="true"
          >
            <span className={`dot${connected ? " connected" : ""}`} />
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
                disabled={busy || !running}
                onClick={onSync}
              >
                <Icon icon={SyncIcon} />
                {busy ? "Working…" : "Sync now"}
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
          <div className="sync-menu-feed">
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
            {actionError && (
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
            {onReview &&
              reviewRequests.length + localUpdates + privateDrafts > 0 && (
                <section className="sync-menu-notification">
                  <h3>Requests and updates</h3>
                  {reviewRequests.map((r) => (
                    <p key={r.id}>
                      {r.title} · {r.status}
                    </p>
                  ))}
                  {localUpdates > 0 && (
                    <p>{localUpdates} local updates need review.</p>
                  )}
                  {privateDrafts > 0 && (
                    <p>{privateDrafts} local changes are ready for review.</p>
                  )}
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => leave(onReview)}
                  >
                    Open requests
                  </Button>
                </section>
              )}
            {issueCount > 0 && (
              <h3>
                {issueCount} sync {issueCount === 1 ? "issue" : "issues"}
              </h3>
            )}
            {state.sync?.error && !issues.has(state.sync.error) && (
              <div className="sync-menu-notification">
                <p>{state.sync.error}</p>
              </div>
            )}
            {pending.length > 0 && (
              <div className="sync-menu-notification">
                <h4>Failed uploads</h4>
                <p className="muted">Upload queue across all projects.</p>
                <ul>
                  {pending.map((item) => (
                    <li key={item.id}>{item.error}</li>
                  ))}
                </ul>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={onRetry}
                >
                  Retry uploads
                </Button>
              </div>
            )}
            {[...issues].map(([message, sources]) => (
              <div className="sync-menu-notification" key={message}>
                <p>{message}</p>
                <details>
                  <summary>
                    <ChevronRightIcon
                      className="sync-disclosure-chevron"
                      size={14}
                      aria-hidden="true"
                      focusable="false"
                    />
                    Show affected items ({sources.length})
                  </summary>
                  <ul>
                    {sources.map((source, index) => (
                      <li key={`${source}-${index}`}>{source}</li>
                    ))}
                  </ul>
                </details>
                {syncIssueRecovery(message) && (
                  <small>{syncIssueRecovery(message)}</small>
                )}
                {/unsupported.*version|unsupported.*format/i.test(message) && (
                  <small>
                    Requires compatible tool or transcript support in Orka.
                  </small>
                )}
              </div>
            ))}
            {conflicts.length > 0 && <h3>Session conflicts</h3>}
            {conflicts.map((conflict) => (
              <div className="sync-menu-notification" key={conflict.id}>
                <p>{resourceTitle(conflict.resourceId)}</p>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => leave(() => onOpen(conflict.resourceId))}
                >
                  Review conflict
                </Button>
              </div>
            ))}
            {notifications.length > 0 && <h3>Session activity</h3>}
            {notifications.map((item) => (
              <div className="sync-menu-notification" key={item.id}>
                <p>
                  {memberName(item.author)} continued your session as a copy.
                </p>
                <small>{resourceTitle(item.copyId)}</small>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => leave(() => onOpen(item.copyId))}
                >
                  View copy
                </Button>
              </div>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
