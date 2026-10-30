import { useCallback, useEffect, useRef, useState } from "react";
import { envCommand, type Listing } from "./api.js";
import { useToastNotice } from "../toasts.js";

type Capability = { supported: boolean; enabled: boolean };

/** Owns native request lifetime, operation locking, and catalog refresh. */
export function useEnvConnection(projectId: string) {
  const [capability, setCapability] = useState<Capability | null>(null);
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState("");
  const setNotice = useToastNotice();
  const [busy, setBusy] = useState("");
  const active = useRef(true);
  const generation = useRef(0);
  const locked = useRef(false);

  const env = useCallback(
    async <T>(
      action: string,
      input: Record<string, unknown> = {},
    ): Promise<T> => {
      const current = generation.current;
      if (!active.current) throw new Error("ENV view changed");
      const result = await envCommand<T>(action, input);
      if (!active.current || current !== generation.current)
        throw new Error("ENV view changed");
      return result;
    },
    [],
  );
  const load = useCallback(async () => {
    setListing(await env<Listing>("list", { projectId }));
  }, [env, projectId]);
  const run = useCallback(
    async (label: string, fn: () => Promise<void>) => {
      if (locked.current || !active.current) return;
      const current = generation.current;
      locked.current = true;
      setBusy(label);
      setError("");
      setNotice("");
      try {
        await fn();
      } catch (error) {
        if (active.current && current === generation.current)
          setError(String(error));
      } finally {
        if (current === generation.current) {
          locked.current = false;
          if (active.current) setBusy("");
        }
      }
    },
    [setNotice],
  );
  const checkAvailability = useCallback(
    () =>
      run("Checking ENV availability…", async () => {
        const result = await env<Capability>("capabilities");
        setCapability(result);
        if (result.supported && result.enabled) await load();
      }),
    [env, load, run],
  );

  useEffect(() => {
    active.current = true;
    void checkAvailability();
    return () => {
      active.current = false;
      generation.current += 1;
      locked.current = false;
      // Native commands are queued so cleanup precedes the next view's requests.
      void envCommand("clear").catch(() => {});
    };
  }, [checkAvailability]);
  useEffect(() => {
    if (!capability?.supported || !capability.enabled) return;
    let stopped = false;
    let timer: number;
    const poll = async () => {
      try {
        if (document.visibilityState === "visible" && !locked.current)
          await load();
      } catch {
        if (!stopped)
          setError(
            "Connect to refresh ENVs. Your applied files remain available.",
          );
      } finally {
        if (!stopped) timer = window.setTimeout(() => void poll(), 30_000);
      }
    };
    timer = window.setTimeout(() => void poll(), 30_000);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [capability?.supported, capability?.enabled, load]);

  return {
    capability,
    setCapability,
    listing,
    error,
    setError,
    setNotice,
    busy,
    active,
    locked,
    env,
    run,
    load,
    checkAvailability,
  };
}

export type EnvConnection = ReturnType<typeof useEnvConnection>;
