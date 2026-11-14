import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface DesktopRelease {
  version: string;
  sha256: string;
  notes: string;
}

interface UpdateStatus {
  installedVersion: string;
  update?: DesktopRelease;
  release?: DesktopRelease;
  message?: string;
  supported?: boolean;
}

interface UpdateProgress {
  phase: "downloading" | "verifying" | "restarting";
  downloadedBytes?: number;
  totalBytes?: number;
}

export function useDesktopUpdates() {
  const [status, setStatus] = useState<UpdateStatus>();
  const [checking, setChecking] = useState(isTauri);
  const [checkedAt, setCheckedAt] = useState<Date>();
  const [error, setError] = useState("");
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<UpdateProgress>();
  const [actionError, setActionError] = useState("");
  const checkingRef = useRef(false);
  const installingRef = useRef(false);
  const active = useRef(true);

  const check = useCallback(async (manual = false) => {
    if (!isTauri() || checkingRef.current || installingRef.current) return;
    checkingRef.current = true;
    setChecking(true);
    setError("");
    try {
      const next = await invoke<UpdateStatus>("update_status", { manual });
      if (!active.current) return;
      if (next.message && next.supported !== false) {
        setError(next.message);
        setStatus((previous) => previous ?? next);
      } else {
        setStatus(next);
        if (next.supported !== false) setCheckedAt(new Date());
      }
    } catch (reason) {
      if (active.current)
        setError(
          typeof reason === "string"
            ? reason
            : "Couldn’t check for updates. Check your connection and try again.",
        );
    } finally {
      checkingRef.current = false;
      if (active.current) setChecking(false);
    }
  }, []);

  useEffect(() => {
    active.current = true;
    if (!isTauri()) {
      setStatus({
        installedVersion: "",
        supported: false,
        message: "Install the Orka desktop app to check for updates.",
      });
      return;
    }
    void invoke("update_ready").catch(() => {});
    void check();
    const timer = window.setInterval(() => void check(), 4 * 60 * 60 * 1000);
    return () => {
      active.current = false;
      window.clearInterval(timer);
    };
  }, [check]);

  const install = async () => {
    const update = status?.update;
    if (!update || installingRef.current || checkingRef.current) return;
    installingRef.current = true;
    setInstalling(true);
    setProgress(undefined);
    setActionError("");
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await listen<UpdateProgress>(
        "desktop-update-progress",
        ({ payload }) => {
          if (active.current) setProgress(payload);
        },
      );
      await invoke("update_install", {
        version: update.version,
        sha256: update.sha256,
      });
    } catch (reason) {
      if (active.current)
        setActionError(
          typeof reason === "string"
            ? reason
            : "Couldn’t install the update. Try again.",
        );
    } finally {
      unlisten?.();
      installingRef.current = false;
      if (active.current) setInstalling(false);
    }
  };

  const openChangelog = async (version: string) => {
    setActionError("");
    try {
      await invoke("open_update_changelog", { version });
    } catch {
      if (active.current)
        setActionError("Couldn’t open the changelog in your browser.");
    }
  };

  return {
    status,
    checking,
    checkedAt,
    error,
    check,
    installing,
    progress,
    actionError,
    install,
    openChangelog,
  };
}

export type DesktopUpdates = ReturnType<typeof useDesktopUpdates>;
