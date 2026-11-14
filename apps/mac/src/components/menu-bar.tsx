import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowUpRightIcon, SyncIcon } from "@primer/octicons-react";
import type { Snapshot, SyncProgress } from "../types.js";
import { Button } from "./button.js";
import { Icon } from "./icon.js";
import "./menu-bar.css";

export interface MenuBarSnapshot {
  user: string | null;
  onboarding: boolean;
  running: boolean;
  sync: Snapshot["sync"];
  progress: SyncProgress | null;
  projectCount: number;
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
  const syncing = Boolean(progress) || (signedIn && requested);
  const detail = !state
    ? "Checking sync status…"
    : !signedIn
      ? state.onboarding
        ? "Open Orka to finish setup."
        : "Open Orka to sign in."
      : (progress?.label ??
        (requested
          ? "Waiting for sync to start…"
          : !state.running
            ? "Sync stopped. Open Orka to check."
            : state.sync?.online === false
              ? "Offline. Changes stay on this Mac."
              : state.issues || state.sync?.error
                ? "Open Orka to review sync issues."
                : lastSynced(state.sync?.lastSync)));
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
        <h1>
          <img
            src="/onboarding/orka-lockup.svg"
            width={72}
            height={17}
            alt="Orka"
          />
        </h1>
      </header>
      <section className="menu-bar-status" aria-label="Sync overview">
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
          <Icon
            icon={signedIn ? SyncIcon : ArrowUpRightIcon}
            className={syncing ? "menu-bar-spinning" : ""}
          />
          {signedIn ? (syncing ? "Syncing…" : "Sync now") : "Open Orka"}
        </Button>
        <div className="menu-bar-progress">
          <div className="menu-bar-progress-label">
            <p role="status">{detail}</p>
            {completed !== null && total && (
              <span>
                {completed} of {total}
              </span>
            )}
          </div>
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
        </div>
      </section>
      {signedIn && (
        <dl className="menu-bar-counts" aria-label="Workspace overview">
          <div>
            <dt>Projects</dt>
            <dd>{state?.projectCount ?? 0}</dd>
          </div>
          <div>
            <dt>Queued changes</dt>
            <dd>{state?.pending ?? 0}</dd>
          </div>
          <div>
            <dt>Sync issues</dt>
            <dd>{state?.issues ?? 0}</dd>
          </div>
        </dl>
      )}
      {(actionError || readError) && (
        <p className="menu-bar-error" role="alert" tabIndex={0}>
          {actionError || readError}
        </p>
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
