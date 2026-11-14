import { useState, type MouseEvent } from "react";
import { isTauri } from "@tauri-apps/api/core";
import * as Popover from "@radix-ui/react-popover";
import { DownloadIcon, XIcon } from "@primer/octicons-react";
import { Button } from "./button.js";
import { IconButton } from "./icon-button.js";

export { useDesktopUpdates } from "./use-desktop-updates.js";
import type { DesktopUpdates } from "./use-desktop-updates.js";

export function UpdateInstallation({ updates }: { updates: DesktopUpdates }) {
  const { installing, progress, actionError } = updates;
  const percent =
    progress?.phase === "downloading" && progress.totalBytes
      ? Math.min(
          100,
          Math.floor(
            ((progress.downloadedBytes ?? 0) / progress.totalBytes) * 100,
          ),
        )
      : undefined;
  const label =
    progress?.phase === "downloading"
      ? `Downloading… ${percent ?? 0}%`
      : progress?.phase === "verifying"
        ? "Verifying update…"
        : progress?.phase === "restarting"
          ? "Restarting Orka…"
          : "Preparing update…";
  return (
    <>
      {actionError && <p role="alert">{actionError}</p>}
      {installing && (
        <div className="sidebar-update-progress">
          <p role="status">{label}</p>
          <progress aria-label="Update progress" max={100} value={percent} />
        </div>
      )}
      <Button
        variant="primary"
        size="sm"
        disabled={installing || updates.checking}
        onClick={() => void updates.install()}
      >
        {installing ? "Updating…" : "Update and Restart"}
      </Button>
    </>
  );
}

export function UpdateChangelog({
  version,
  updates,
}: {
  version: string;
  updates: DesktopUpdates;
}) {
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!isTauri()) return;
    event.preventDefault();
    void updates.openChangelog(version);
  };
  return (
    <a
      className="sidebar-update-changelog"
      href={`https://github.com/whysosaket/orka/releases/tag/v${encodeURIComponent(version)}`}
      target="_blank"
      rel="noopener noreferrer"
      onClick={open}
    >
      View changelog
    </a>
  );
}

export function SidebarUpdate({
  updates,
  collapsed,
}: {
  updates: DesktopUpdates;
  collapsed: boolean;
}) {
  const [dismissed, setDismissed] = useState(false);
  const update = updates.status?.update;
  if (!update) return null;
  const { installing } = updates;
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
      <UpdateInstallation updates={updates} />
      <UpdateChangelog version={update.version} updates={updates} />
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
