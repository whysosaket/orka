import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Project, Snapshot } from "../types.js";

export interface GitHubStatus {
  connected: boolean;
  identity: { id: string; login: string } | null;
  installationUrl: string;
}
interface Authorization {
  id: string;
  userCode: string;
  verificationUrl: string;
  interval: number;
  expiresIn: number;
}
export interface CloneJob {
  id: string;
  projectId: string;
  sourceId: string;
  state: string;
  message: string;
  destination: string;
  folderIdentity?: string;
}
export interface RepositoryAccess {
  state:
    | "ready"
    | "not_connected"
    | "reconnect"
    | "access_unavailable"
    | "unavailable";
  checkedAt?: string;
}
export function useRepositoryCommand(state: Snapshot) {
  const user = state.user,
    service = state.config?.apiUrl;
  return useCallback(
    <T>(action: string, input: unknown = {}) =>
      invoke<T>("repository_command", {
        action,
        input,
        context: { user, service },
      }),
    [user, service],
  );
}

export function useBackgroundRepositoryAccess(state: Snapshot) {
  const call = useRepositoryCommand(state);
  const targets = JSON.stringify(
    state.projects.flatMap((project) =>
      (project.sources ?? [])
        .filter((source) => source.repository)
        .map((source) => ({
          projectId: project.id,
          sourceId: source.id,
          repositoryId: source.repository?.id,
          bindingRevision: source.repository?.revision,
        })),
    ),
  );
  useEffect(() => {
    if (!state.user || targets === "[]") return;
    let canceled = false;
    const check = async () => {
      try {
        const caps = await call<{ enabled: boolean }>("capabilities");
        if (!caps.enabled || canceled) return;
        for (const target of JSON.parse(targets) as {
          projectId: string;
          sourceId: string;
        }[]) {
          if (canceled) return;
          await call("access-status", target).catch(() => {});
        }
      } catch {
        /* An unavailable service must not interrupt the workspace. */
      }
    };
    void check();
    const timer = setInterval(() => void check(), 24 * 60 * 60 * 1000);
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    return () => {
      canceled = true;
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [call, targets, state.user]);
}

export function useRepositories(
  project: Project,
  state: Snapshot,
  refresh: () => Promise<unknown>,
) {
  const call = useRepositoryCommand(state);
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState<GitHubStatus | null>(null);
  const [authorization, setAuthorization] = useState<Authorization | null>(
    null,
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [access, setAccess] = useState<Record<string, RepositoryAccess>>({});
  const [jobs, setJobs] = useState<CloneJob[]>([]);
  const [accessVersion, setAccessVersion] = useState(0);
  const locked = useRef(false);
  const alive = useRef(true);
  const refreshWorkspace = useEffectEvent(refresh);
  const currentBinding = useEffectEvent((sourceId: string) =>
    project.sources?.find((source) => source.id === sourceId),
  );
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const run = async (operation: () => Promise<unknown>) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (e) {
      if (alive.current) setError(String(e));
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  };
  useEffect(() => {
    let canceled = false;
    void call<{ enabled: boolean }>("capabilities")
      .then(async (caps) => {
        if (!caps.enabled || canceled) return;
        setEnabled(true);
        try {
          const value = await call<GitHubStatus>("status");
          if (!canceled) setStatus(value);
        } catch (error) {
          if (!canceled) setError(String(error));
        }
      })
      .catch(() => {});
    return () => {
      canceled = true;
    };
  }, [call]);
  const bindings = JSON.stringify(
    (project.sources ?? [])
      .filter((source) => source.repository)
      .map((source) => ({
        sourceId: source.id,
        repositoryId: source.repository!.id,
        revision: source.repository!.revision,
      })),
  );
  const latestAccess = useEffectEvent(() => access);
  useEffect(() => {
    if (!enabled) return;
    let canceled = false;
    const check = async (returned = false) => {
      for (const binding of JSON.parse(bindings) as {
        sourceId: string;
        repositoryId: string;
        revision: number;
      }[]) {
        if (canceled) return;
        const previous = latestAccess()[binding.sourceId];
        try {
          const value = await call<RepositoryAccess>("access-status", {
            projectId: project.id,
            sourceId: binding.sourceId,
            repositoryId: binding.repositoryId,
            bindingRevision: binding.revision,
            force: returned && previous?.state !== "ready",
          });
          if (!canceled)
            setAccess((values) => ({ ...values, [binding.sourceId]: value }));
        } catch {
          if (!canceled)
            setAccess((values) => ({
              ...values,
              [binding.sourceId]: { state: "unavailable" },
            }));
        }
      }
    };
    void check();
    const onFocus = () => void check(true);
    const timer = setInterval(() => void check(), 24 * 60 * 60 * 1000);
    window.addEventListener("focus", onFocus);
    return () => {
      canceled = true;
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [enabled, call, bindings, project.id, accessVersion]);
  useEffect(() => {
    if (!authorization) return;
    let canceled = false,
      timer: ReturnType<typeof setTimeout>;
    const expires = Date.now() + authorization.expiresIn * 1000;
    const poll = async () => {
      try {
        if (Date.now() >= expires)
          throw new Error("GitHub authorization expired. Connect again.");
        const result = await call<{
          connected?: boolean;
          interval?: number;
          error?: string;
        }>("poll", { id: authorization.id });
        if (canceled) return;
        if (result.error) throw new Error(result.error);
        if (result.connected) {
          setAuthorization(null);
          const value = await call<GitHubStatus>("status");
          if (!canceled) {
            setStatus(value);
            setAccess({});
            setAccessVersion((v) => v + 1);
          }
        } else
          timer = setTimeout(
            () => void poll(),
            Math.max(5, result.interval ?? authorization.interval) * 1000,
          );
      } catch (e) {
        if (!canceled) {
          setError(String(e));
          setAuthorization(null);
        }
      }
    };
    timer = setTimeout(() => void poll(), authorization.interval * 1000);
    return () => {
      canceled = true;
      clearTimeout(timer);
    };
  }, [authorization, call]);
  const activeJobs = jobs.some((job) =>
    ["queued", "cloning", "connecting"].includes(job.state),
  );
  useEffect(() => {
    if (!enabled) return;
    let canceled = false,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const values = (await call<CloneJob[]>("jobs")).filter(
          (job) => job.projectId === project.id,
        );
        if (canceled) return;
        if (
          activeJobs &&
          !values.some((job) =>
            ["queued", "cloning", "connecting"].includes(job.state),
          )
        ) {
          await refreshWorkspace();
          for (const job of values.filter(
            (value) => value.state === "failed",
          )) {
            try {
              const source = currentBinding(job.sourceId);
              const value = await call<RepositoryAccess>("access-status", {
                projectId: project.id,
                sourceId: job.sourceId,
                repositoryId: source?.repository?.id,
                bindingRevision: source?.repository?.revision,
                force: true,
              });
              if (!canceled)
                setAccess((previous) => ({
                  ...previous,
                  [job.sourceId]: value,
                }));
            } catch {
              if (!canceled)
                setAccess((previous) => ({
                  ...previous,
                  [job.sourceId]: { state: "unavailable" },
                }));
            }
          }
        }
        if (canceled) return;
        setJobs(values);
        if (
          !canceled &&
          values.some((job) =>
            ["queued", "cloning", "connecting"].includes(job.state),
          )
        )
          timer = setTimeout(() => void poll(), 1000);
      } catch (e) {
        if (!canceled) setError(String(e));
      }
    };
    void poll();
    return () => {
      canceled = true;
      clearTimeout(timer);
    };
  }, [enabled, call, project.id, activeJobs]);
  const openGitHub = (url: string) => call("open-github", { url });
  const connectGitHub = async () => {
    const value = await call<Authorization>("begin");
    setAuthorization(value);
    await openGitHub(value.verificationUrl);
  };
  const disconnectGitHub = async () => {
    await call("disconnect");
    setStatus(await call<GitHubStatus>("status"));
    setAccess({});
    setAccessVersion((v) => v + 1);
  };
  const startClone = async (
    sourceId: string,
    directory: string,
    folderName: string,
  ) => {
    const job = await call<CloneJob>("clone", {
      projectId: project.id,
      sourceId,
      directory,
      folderName,
    });
    setJobs((values) => [
      job,
      ...values.filter((value) => value.id !== job.id),
    ]);
    await refresh();
  };
  return {
    call,
    enabled,
    status,
    authorization,
    busy,
    error,
    access,
    jobs,
    run,
    connectGitHub,
    disconnectGitHub,
    openGitHub,
    startClone,
    refresh,
    reloadStatus: async () => {
      const value = await call<GitHubStatus>("status");
      if (alive.current) setStatus(value);
    },
    cancelAuthorization: async () => {
      if (authorization)
        await call("cancel-authorization", { id: authorization.id });
      setAuthorization(null);
    },
    recheck: async (sourceId: string) => {
      const source = project.sources?.find((source) => source.id === sourceId);
      const value = await call<RepositoryAccess>("access-status", {
        projectId: project.id,
        sourceId,
        repositoryId: source?.repository?.id,
        bindingRevision: source?.repository?.revision,
        force: true,
      });
      setAccess((values) => ({ ...values, [sourceId]: value }));
    },
  };
}
export type RepositoryController = ReturnType<typeof useRepositories>;
