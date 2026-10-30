import { useCallback, useEffect, useRef, useState } from "react";
import type { EnvConnection } from "./use-env-connection.js";

/** Keeps revealed secrets scoped to one view and hides them on blur or expiry. */
export function useEnvReveal(
  context: string,
  { active, env, run }: EnvConnection,
) {
  const [revealed, setRevealed] = useState<{
    context: string;
    key: string;
    value: string;
  } | null>(null);
  const epoch = useRef(0);
  const clearRevealed = useCallback(() => {
    epoch.current += 1;
    setRevealed(null);
  }, []);

  useEffect(() => {
    clearRevealed();
    return () => {
      epoch.current += 1;
    };
  }, [context, clearRevealed]);
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState !== "visible") clearRevealed();
    };
    window.addEventListener("blur", clearRevealed);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("blur", clearRevealed);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [clearRevealed]);
  useEffect(() => {
    if (!revealed) return;
    const timer = window.setTimeout(clearRevealed, 30_000);
    return () => window.clearTimeout(timer);
  }, [revealed, clearRevealed]);

  const reveal = (draftId: string, key: string, displayKey = key) => {
    const hide = revealed?.key === displayKey;
    clearRevealed();
    if (hide) return;
    const current = epoch.current;
    void run("Revealing selected value…", async () => {
      const result = await env<{ value: string }>("reveal", { draftId, key });
      if (
        active.current &&
        current === epoch.current &&
        document.visibilityState === "visible"
      )
        setRevealed({ context, key: displayKey, value: result.value });
    });
  };

  return {
    revealed: revealed?.context === context ? revealed : null,
    clearRevealed,
    reveal,
  };
}
