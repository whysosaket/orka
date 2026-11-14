import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertIcon,
  ArrowUpRightIcon,
  CheckIcon,
  ClockIcon,
  CloudOfflineIcon,
  FileDirectoryIcon,
  SyncIcon,
} from "@primer/octicons-react";
import type { Snapshot, SyncProgress } from "../types.js";
import { Button } from "./button.js";
import { Icon } from "./icon.js";
import "./menu-bar.css";

export interface MenuBarSnapshot {
  user: string | null;
  onboarding: boolean;
  background: boolean;
  running: boolean;
  sync: Snapshot["sync"];
  progress: SyncProgress | null;
  projects: { id: string; name: string; pending: number; issues: number }[];
  pending: number;
  issues: number;
}

function lastSynced(value?: string) {
  if (!value) return "Ready for your first sync";
  const elapsed = Math.max(0, Date.now() - Date.parse(value));
  if (!Number.isFinite(elapsed)) return "Waiting for sync status";
  if (elapsed < 60_000) return "Last synced just now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `Last synced ${minutes}m ago`;
  if (minutes < 1440) return `Last synced ${Math.floor(minutes / 60)}h ago`;
  return `Last synced ${Math.floor(minutes / 1440)}d ago`;
}

export function MenuBar() {
  const [state, setState] = useState<MenuBarSnapshot | null>(null);
  const [readError, setReadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const [requested, setRequested] = useState(false);
  const requestTime = useRef(0);
  const root = useRef<HTMLElement>(null);

  useEffect(() => {
    let stopped = false;
    let timer: number;
    const poll = async () => {
      try {
        const next = await invoke<MenuBarSnapshot>("menu_bar_snapshot");
        if (stopped) return;
        setState(next);
        setReadError("");
        setRequested(
          (current) =>
            current &&
            !next.progress &&
            (!next.sync?.lastSync ||
              Date.parse(next.sync.lastSync) < requestTime.current) &&
            Date.now() - requestTime.current < 15_000,
        );
      } catch (error) {
        if (!stopped) setReadError(String(error));
      } finally {
        if (!stopped) timer = window.setTimeout(() => void poll(), 1000);
      }
    };
    void poll();
    const focus = () => root.current?.focus();
    window.addEventListener("focus", focus);
    focus();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      window.removeEventListener("focus", focus);
    };
  }, []);

  async function act(command: string, args?: Record<string, unknown>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setActionError("");
    try {
      await invoke(command, args);
      if (command === "sync_now") {
        requestTime.current = Date.now();
        setRequested(true);
      }
      setState(await invoke<MenuBarSnapshot>("menu_bar_snapshot"));
    } catch (error) {
      setActionError(String(error));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }

  const open = () => void act("menu_bar_action", { action: "open" });
  const signedIn = Boolean(state?.user) && !state?.onboarding;
  const progress = signedIn && state?.running ? state.progress : null;
  const syncing = Boolean(progress) || requested;
  const offline = state?.sync?.online === false;
  const hasIssues = Boolean(state?.issues || state?.sync?.error);
  const title = !state
    ? "Checking sync status…"
    : !signedIn
      ? state.onboarding
        ? "Finish setting up Orka"
        : "Welcome to Orka"
      : syncing
        ? "Keeping you in sync"
        : !state.running
          ? "Sync is stopped"
          : offline
            ? "You’re offline"
            : hasIssues
              ? "A little attention needed"
              : state.pending
                ? "Changes ready to sync"
                : state.sync?.lastSync
                  ? "Everything is up to date"
                  : "Ready when you are";
  const detail = !state
    ? "Getting the latest from your Mac"
    : !signedIn
      ? "Open Orka to connect your projects."
      : (progress?.label ??
        (requested
          ? "Waiting for sync to start…"
          : !state.running
            ? "Open Orka to check your sync service."
            : offline
              ? "Your changes are safe on this Mac."
              : hasIssues
                ? "Open Orka to review sync issues."
                : lastSynced(state.sync?.lastSync)));
  const glyph = syncing
    ? SyncIcon
    : offline
      ? CloudOfflineIcon
      : hasIssues || (signedIn && !state?.running)
        ? AlertIcon
        : CheckIcon;
  const total = progress?.total;
  const completed =
    total && total > 0 && progress?.completed !== undefined
      ? Math.min(total, Math.max(0, progress.completed))
      : null;

  return (
    <main
      ref={root}
      tabIndex={-1}
      className="menu-bar-panel"
      aria-label="Orka menu bar"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          void act("menu_bar_action", { action: "close" });
        }
      }}
    >
      <header className="menu-bar-heading">
        <img
          src="/onboarding/orka-lockup.svg"
          width={86}
          height={21}
          alt="Orka"
        />
        <span className="menu-bar-caption">Your workspace, in sync</span>
      </header>

      <section className="menu-bar-status" aria-label="Sync overview">
        <span className="menu-bar-status-icon" aria-hidden="true">
          <Icon icon={glyph} className={syncing ? "menu-bar-spinning" : ""} />
        </span>
        <h1>{title}</h1>
        <p role="status">{detail}</p>
        {progress?.detail && (
          <p className="menu-bar-detail">{progress.detail}</p>
        )}
        {completed !== null && total && (
          <progress
            aria-label={progress?.label}
            max={total}
            value={completed}
            aria-valuetext={`${completed} of ${total} complete`}
          />
        )}
        <Button
          variant="primary"
          className="menu-bar-sync"
          disabled={
            !state ||
            busy ||
            Boolean(readError) ||
            (signedIn && (!state.running || syncing))
          }
          onClick={signedIn ? () => void act("sync_now") : open}
        >
          <Icon icon={signedIn ? SyncIcon : ArrowUpRightIcon} />
          {signedIn ? (syncing ? "Syncing…" : "Sync now") : "Open Orka"}
        </Button>
      </section>

      {signedIn && (
        <>
          <div className="menu-bar-counts">
            <div>
              <strong>{state?.projects.length ?? 0}</strong>
              <span>Projects</span>
            </div>
            <div>
              <strong>{state?.pending ?? 0}</strong>
              <span>Queued changes</span>
            </div>
            <div>
              <strong>{state?.issues ?? 0}</strong>
              <span>Sync issues</span>
            </div>
          </div>
          <section
            className="menu-bar-projects"
            tabIndex={0}
            aria-label="Connected projects"
          >
            <h2>Connected projects</h2>
            {state?.projects.length ? (
              <ul>
                {state.projects.map((project) => (
                  <li key={project.id}>
                    <Icon
                      icon={FileDirectoryIcon}
                      variant="secondary"
                      size="sm"
                    />
                    <span className="menu-bar-project-name">
                      {project.name}
                    </span>
                    <span className="menu-bar-project-state">
                      {project.issues
                        ? `${project.issues} issues`
                        : project.pending
                          ? `${project.pending} queued`
                          : syncing
                            ? "Syncing…"
                            : offline || !state.running
                              ? "Waiting"
                              : state.sync?.lastSync
                                ? "Up to date"
                                : "Ready"}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p>Connect a project in Orka to get started.</p>
            )}
          </section>
        </>
      )}

      {(actionError || readError) && (
        <p className="menu-bar-error" role="alert">
          {actionError || readError}
        </p>
      )}

      {signedIn && state && (
        <div className="menu-bar-background">
          <Icon icon={ClockIcon} variant="secondary" size="sm" />
          <span>
            {state.background
              ? "Available after you quit Orka"
              : "Keep syncing after you quit"}
          </span>
          {state.background ? (
            <span className="menu-bar-caption">Enabled</span>
          ) : (
            <Button
              variant="tertiary"
              size="sm"
              disabled={busy}
              onClick={() => void act("background_agent", { enabled: true })}
            >
              Enable
            </Button>
          )}
        </div>
      )}
      <footer className="menu-bar-footer">
        <Button variant="tertiary" size="sm" onClick={open} disabled={busy}>
          Open Orka <Icon icon={ArrowUpRightIcon} size="sm" />
        </Button>
        <Button
          variant="tertiary"
          size="sm"
          onClick={() => void act("menu_bar_action", { action: "quit" })}
          disabled={busy}
        >
          Quit Orka
        </Button>
      </footer>
    </main>
  );
}
