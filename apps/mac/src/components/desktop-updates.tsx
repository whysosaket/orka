import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { DownloadIcon, XIcon } from "@primer/octicons-react";
import { Button } from "./button.js";
import { IconButton } from "./icon-button.js";
import { SettingsHeading } from "./settings/settings-shared.js";

interface UpdateStatus {
  installedVersion: string;
  update?: { version: string; notes: string };
  withdrawn?: boolean;
  message?: string;
}

export function useDesktopUpdates() {
  const [status, setStatus] = useState<UpdateStatus>();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [dismissed, setDismissed] = useState("");
  const pending = useRef(false);

  const check = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    setChecking(true);
    setError("");
    try {
      setStatus(await invoke<UpdateStatus>("update_status"));
    } catch {
      setStatus(undefined);
      setError("Couldn’t check for Orka updates. Try again.");
    } finally {
      pending.current = false;
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    void invoke("update_ready").catch(() => {});
    void check();
    const timer = window.setInterval(() => void check(), 4 * 60 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [check]);

  const review = async () => {
    setError("");
    try {
      await invoke("update_review");
    } catch {
      setError(
        "Couldn’t open Orka Recovery. Try opening it from Applications.",
      );
    }
  };
  const notice = status?.withdrawn
    ? `withdrawn-${status.installedVersion}-${status.update?.version ?? ""}`
    : (status?.update?.version ?? "");
  return {
    status,
    checking,
    error,
    check,
    review,
    showBanner: Boolean(notice && notice !== dismissed),
    dismiss: () => setDismissed(notice),
  };
}

type Updates = ReturnType<typeof useDesktopUpdates>;

export function UpdateBanner({
  updates,
  onReview,
}: {
  updates: Updates;
  onReview: () => void;
}) {
  if (!updates.showBanner || !updates.status) return null;
  const { update, withdrawn } = updates.status;
  return (
    <aside className="desktop-update-banner" aria-label="Orka update">
      <DownloadIcon aria-hidden="true" size={16} />
      <p>
        {withdrawn
          ? "This version of Orka has been withdrawn."
          : `Orka ${update?.version} is available.`}
      </p>
      <Button size="sm" onClick={onReview}>
        {update ? "Review update" : "Review recovery options"}
      </Button>
      <IconButton
        size="sm"
        aria-label="Dismiss update banner"
        icon={XIcon}
        onClick={updates.dismiss}
      />
    </aside>
  );
}

export function UpdatesSettings({ updates }: { updates: Updates }) {
  const { status, checking, error, check, review } = updates;
  return (
    <>
      <SettingsHeading
        title="Updates"
        description="Check for new versions of Orka for this Mac. You approve each installation."
        action={
          <Button disabled={checking} onClick={() => void check()}>
            {checking ? "Checking…" : "Check for updates"}
          </Button>
        }
      />
      {status?.installedVersion && (
        <p>Installed version {status.installedVersion}</p>
      )}
      {status?.withdrawn && (
        <p role="status">This version of Orka has been withdrawn.</p>
      )}
      {status?.update ? (
        <div className="desktop-update-release">
          <h3>Orka {status.update.version}</h3>
          {status.update.notes && <p>{status.update.notes}</p>}
          <Button variant="primary" onClick={() => void review()}>
            Review in Orka Recovery
          </Button>
        </div>
      ) : status?.withdrawn ? (
        <Button onClick={() => void review()}>Open Orka Recovery</Button>
      ) : status && !status.message && !checking ? (
        <p role="status">You’re up to date.</p>
      ) : null}
      {status?.message && <p role="status">{status.message}</p>}
      {error && <p role="alert">{error}</p>}
    </>
  );
}
