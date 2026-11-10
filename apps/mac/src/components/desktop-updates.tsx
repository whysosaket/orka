import { useEffect, useId, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import * as Popover from "@radix-ui/react-popover";
import { DownloadIcon } from "@primer/octicons-react";
import { Button } from "./button.js";

interface UpdateStatus {
  installedVersion: string;
  update?: { version: string; notes: string; sha256: string };
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
  installedVersion,
  collapsed,
}: {
  update: NonNullable<UpdateStatus["update"]>;
  installedVersion: string;
  collapsed: boolean;
}) {
  const title = useId();
  const pending = useRef(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState("");
  const install = async () => {
    if (pending.current) return;
    pending.current = true;
    setInstalling(true);
    setError("");
    try {
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
      pending.current = false;
      setInstalling(false);
    }
  };

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="navigation-action sidebar-update-trigger"
          aria-label="Update available"
          title={collapsed ? "Update available" : undefined}
        >
          <DownloadIcon
            className="navigation-action-icon"
            size={16}
            aria-hidden="true"
          />
          <span>Update available</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="sidebar-update-review"
          side={collapsed ? "right" : "top"}
          align={collapsed ? "end" : "start"}
          sideOffset={8}
          collisionPadding={12}
          aria-labelledby={title}
        >
          <h2 id={title}>Update Orka</h2>
          <div className="sidebar-update-versions">
            <strong>Orka {update.version}</strong>
            <span>Installed {installedVersion}</span>
          </div>
          {update.notes && (
            <p className="sidebar-update-notes">{update.notes}</p>
          )}
          {error && (
            <p className="sidebar-update-error" role="alert">
              {error}
            </p>
          )}
          {installing && (
            <p className="sidebar-update-status" role="status">
              Orka will restart when the update is ready.
            </p>
          )}
          <div className="sidebar-update-actions">
            <Button
              variant="primary"
              disabled={installing}
              onClick={() => void install()}
            >
              {installing ? "Preparing update…" : "Update and Restart"}
            </Button>
            <Popover.Close asChild>
              <Button variant="tertiary">
                {installing ? "Close" : "Later"}
              </Button>
            </Popover.Close>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
