import { useEffect, useRef, useState, type MouseEvent } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import * as Popover from "@radix-ui/react-popover";
import { DownloadIcon, XIcon } from "@primer/octicons-react";
import { Button } from "./button.js";
import { IconButton } from "./icon-button.js";

interface UpdateStatus {
  update?: { version: string; sha256: string };
}

interface UpdateProgress {
  phase: "downloading" | "verifying" | "restarting";
  downloadedBytes?: number;
  totalBytes?: number;
}

export function useDesktopUpdates() {
  const [status, setStatus] = useState<UpdateStatus>();

  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    const check = async () => {
      const next = await invoke<UpdateStatus>("update_status").catch(
        () => undefined,
      );
      if (active) setStatus(next);
    };
    void invoke("update_ready").catch(() => {});
    void check();
    const timer = window.setInterval(() => void check(), 4 * 60 * 60 * 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  return status;
}

export function SidebarUpdate({
  update,
  collapsed,
}: {
  update: NonNullable<UpdateStatus["update"]>;
  collapsed: boolean;
}) {
  const [dismissed, setDismissed] = useState(false);
  const pending = useRef(false);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<UpdateProgress>();
  const [error, setError] = useState("");
  const install = async () => {
    if (pending.current) return;
    pending.current = true;
    setInstalling(true);
    setProgress(undefined);
    setError("");
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await listen<UpdateProgress>(
        "desktop-update-progress",
        ({ payload }) => setProgress(payload),
      );
      await invoke("update_install", {
        version: update.version,
        sha256: update.sha256,
      });
    } catch (reason) {
      setError(
        typeof reason === "string"
          ? reason
          : "Couldn’t install the update. Try again.",
      );
    } finally {
      unlisten?.();
      pending.current = false;
      setInstalling(false);
    }
  };

  const percent =
    progress?.phase === "downloading" && progress.totalBytes
      ? Math.min(
          100,
          Math.floor(
            ((progress.downloadedBytes ?? 0) / progress.totalBytes) * 100,
          ),
        )
      : undefined;
  const progressLabel =
    progress?.phase === "downloading"
      ? `Downloading… ${percent ?? 0}%`
      : progress?.phase === "verifying"
        ? "Verifying update…"
        : progress?.phase === "restarting"
          ? "Restarting Orka…"
          : "Preparing update…";

  const changelog = `https://github.com/whysosaket/orka/releases/tag/v${encodeURIComponent(update.version)}`;
  const openChangelog = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!isTauri()) return;
    event.preventDefault();
    setError("");
    void invoke("open_update_changelog", { version: update.version }).catch(
      () => setError("Couldn’t open the changelog in your browser."),
    );
  };
  const close = (
    <IconButton
      icon={XIcon}
      size="sm"
      variant="tertiary"
      aria-label="Close update"
      disabled={installing}
      onClick={
        collapsed
          ? undefined
          : (event) => {
              event.currentTarget
                .closest(".sidebar-footer")
                ?.querySelector<HTMLButtonElement>(".sidebar-bottom button")
                ?.focus();
              setDismissed(true);
            }
      }
    />
  );
  const card = (
    <>
      <div className="sidebar-update-header">
        <strong>Orka v{update.version}</strong>
        {collapsed ? <Popover.Close asChild>{close}</Popover.Close> : close}
      </div>
      <p>Hurray! An update is available.</p>
      {error && <p role="alert">{error}</p>}
      {installing && (
        <div className="sidebar-update-progress">
          <p role="status">{progressLabel}</p>
          <progress aria-label="Update progress" max={100} value={percent} />
        </div>
      )}
      <Button
        variant="primary"
        size="sm"
        disabled={installing}
        onClick={() => void install()}
      >
        {installing ? "Updating…" : "Update and Restart"}
      </Button>
      <a
        className="sidebar-update-changelog"
        href={changelog}
        target="_blank"
        rel="noopener noreferrer"
        onClick={openChangelog}
      >
        View changelog
      </a>
    </>
  );

  if (!collapsed) {
    return dismissed ? null : (
      <section className="sidebar-update-review" aria-label="Available update">
        {card}
      </section>
    );
  }

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="navigation-action sidebar-update-trigger"
          aria-label="Update available"
          title="Update available"
        >
          <DownloadIcon
            className="navigation-action-icon"
            size={16}
            aria-hidden="true"
          />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="sidebar-update-review sidebar-update-popover"
          side="right"
          align="end"
          sideOffset={8}
          collisionPadding={12}
          aria-label="Available update"
        >
          {card}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
