import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { Snapshot } from "../../types.js";
import {
  destinationCandidates,
  initialDraft,
  type AccountProfile,
  type DiscoveredProject,
  type OnboardingDraft,
  type OnboardingStep,
} from "./model.js";
export const onboardingCommand = <T>(
  action: string,
  input: unknown = {},
  context?: { user: string | null; service?: string },
) =>
  invoke<T>("onboarding_command", { action, input, context: context ?? null });

export function useOnboarding(
  state: Snapshot,
  refresh: () => Promise<void>,
  onComplete: (projectId: string) => void,
) {
  const scope = useRef({ user: state.user, service: state.config?.apiUrl });
  const command = useCallback(
    <T>(action: string, input: unknown = {}) =>
      onboardingCommand<T>(action, input, scope.current),
    [],
  );
  const [draft, setDraft] = useState<OnboardingDraft>(() => {
    const saved = state.onboarding?.draft;
    const step =
      state.onboarding?.location?.ok === false
        ? "location"
        : saved?.step === "scanning"
          ? "discover"
          : ["finish-setup", "claude", "codex"].includes(saved?.step ?? "")
            ? "invite"
            : (saved?.step ?? "profile");
    return { ...initialDraft, ...saved, step };
  });
  const [profile, setProfile] = useState<AccountProfile | null>(
    state.accountProfile ?? null,
  );
  const [profileReady, setProfileReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const [copyingInvite, setCopyingInvite] = useState("");
  const current = useRef(draft);
  current.current = draft;
  const active = useRef(true);
  const locked = useRef(false);
  const choiceWrites = useRef(Promise.resolve());
  const choicesDirty = useRef(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const pendingInvites = useRef(new Map<string, string>());
  const inviteInFlight = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      clearTimeout(copyTimer.current);
    };
  }, []);
  const checkpoint = async (patch: Partial<OnboardingDraft>) => {
    if (!active.current)
      throw new Error("Account or service changed. Reopen onboarding.");
    const next = { ...current.current, ...patch };
    await command("checkpoint", next);
    if (active.current) {
      current.current = next;
      setDraft(next);
    }
    return next;
  };
  const updateChoices = (
    patch: (
      draft: OnboardingDraft,
    ) => Partial<
      Pick<
        OnboardingDraft,
        "selected" | "sharing" | "choices" | "sourceChoices"
      >
    >,
  ) => {
    if (locked.current || !active.current) return;
    const next = { ...current.current, ...patch(current.current) };
    current.current = next;
    setDraft(next);
    setError("");
    choicesDirty.current = true;
    // Keep quick edits responsive and persist them in the same order as clicks.
    choiceWrites.current = choiceWrites.current.then(async () => {
      if (!active.current) return;
      try {
        await command("checkpoint", next);
        if (current.current === next) choicesDirty.current = false;
      } catch (e) {
        if (active.current && current.current === next)
          setError(String(e).replace(/^Error:\s*/, ""));
      }
    });
  };
  const run = async (task: () => Promise<unknown>) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      await choiceWrites.current;
      if (!active.current) return;
      // Retry a failed choice save before any action can use stale preferences.
      if (choicesDirty.current) {
        await checkpoint({});
        choicesDirty.current = false;
      }
      setError("");
      await task();
    } catch (e) {
      if (active.current) setError(String(e).replace(/^Error:\s*/, ""));
    } finally {
      locked.current = false;
      if (active.current) setBusy(false);
    }
  };
  useEffect(() => {
    if (draft.step !== "profile") return;
    let live = true;
    void command<AccountProfile>("profile")
      .then((value) => {
        if (live) {
          setProfile(value);
          setProfileReady(true);
        }
      })
      .catch((e) => {
        if (live) {
          setError(String(e));
          setProfileReady(true);
        }
      });
    return () => {
      live = false;
    };
  }, [draft.step, command]);
  useEffect(() => {
    if (!["syncing", "retrying"].includes(draft.step)) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const saved = await command<OnboardingDraft>("progress");
        if (live && saved?.step) {
          current.current = saved;
          setDraft(saved);
        }
      } catch (e) {
        if (live) setError(String(e));
      } finally {
        if (live) timer = setTimeout(() => void poll(), 800);
      }
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [draft.step, command]);
  const go = (step: OnboardingStep) => void run(() => checkpoint({ step }));
  const find = async (paths?: string[], append = false) => {
    const before = current.current;
    setDraft({ ...before, step: "scanning" });
    try {
      const results = paths
        ? await Promise.all(
            paths.map((path) =>
              command<{ projects: DiscoveredProject[] }>("discover", {
                path,
              }),
            ),
          )
        : [await command<{ projects: DiscoveredProject[] }>("discover")];
      const projects = [
        ...new Map(
          [
            ...(append ? before.projects : []),
            ...results.flatMap((r) => r.projects),
          ].map((p) => [p.path, p]),
        ).values(),
      ];
      projects.sort(
        (a, b) =>
          (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0) ||
          (b.pendingChanges ?? 0) - (a.pendingChanges ?? 0) ||
          a.name.localeCompare(b.name) ||
          a.path.localeCompare(b.path),
      );
      const picked = new Set(
        results.flatMap((result) =>
          result.projects.length === 1 ? [result.projects[0].path] : [],
        ),
      );
      const selected = projects
        .filter(
          (p) =>
            p.readable !== false &&
            (before.selected.includes(p.path) ||
              (paths &&
                picked.has(p.path) &&
                !before.projects.some(
                  (old) => old.path === p.path && old.readable !== false,
                ))),
        )
        .map((p) => p.path);
      await checkpoint({
        projects,
        selected,
        folder: paths?.[0] ?? "",
        step: projects.some((p) => p.readable === false)
          ? "partial-access"
          : projects.length
            ? "select"
            : "empty",
        reviewed: false,
      });
    } catch (e) {
      try {
        await checkpoint({ step: "access-error", folder: paths?.[0] ?? "" });
      } catch {
        if (active.current)
          setDraft({
            ...before,
            step: "access-error",
            folder: paths?.[0] ?? "",
          });
      }
      throw e;
    }
  };
  const chooseFolder = (append = false, defaultPath?: string) =>
    void run(async () => {
      const result = await open({
        directory: true,
        multiple: true,
        title: "Choose project folders",
        defaultPath,
      });
      const paths = typeof result === "string" ? [result] : (result ?? []);
      if (paths.length) await find(paths, append);
    });
  const proceed = () =>
    void run(async () => {
      const selected = current.current.selected;
      if (!selected.length) throw new Error("Choose at least one project.");
      const review = await command<
        Pick<OnboardingDraft, "catalog" | "matches">
      >("review", { paths: selected });
      const choices = Object.fromEntries(
        Object.entries(review.matches ?? {}).flatMap(([path, match]) => {
          const previous = current.current.choices?.[path];
          const sameRemote =
            current.current.matches?.[path]?.remoteKey === match.remoteKey;
          const stillAvailable =
            previous === "new" ||
            destinationCandidates(review, path).some(
              (project) => project.id === previous,
            );
          const choice =
            match.connectedId ??
            (sameRemote && stillAvailable ? previous : undefined);
          return choice ? [[path, choice]] : [];
        }),
      );
      await checkpoint({
        step: "review",
        matches: review.matches,
        catalog: review.catalog,
        choices,
        sourceChoices: Object.fromEntries(
          Object.entries(current.current.sourceChoices ?? {}).filter(
            ([path, source]) => {
              if (review.matches?.[path]?.connectedId) return false;
              const project = destinationCandidates(review, path).find(
                (project) => project.id === choices[path],
              );
              return project?.sources?.some(
                (candidate) => candidate.id === source,
              );
            },
          ),
        ),
        reviewed: false,
      });
    });
  const sync = (retry = false) =>
    void run(async () => {
      if (!retry) {
        await checkpoint({
          step: "syncing",
          reviewed: true,
          sharing: { ...current.current.sharing, env: false },
        });
      } else await checkpoint({ step: "retrying" });
      void command<OnboardingDraft>("batch-sync", { retry })
        .then(async (next) => {
          if (active.current) {
            current.current = next;
            setDraft(next);
            await refresh();
          }
        })
        .catch((e) => {
          if (active.current) setError(String(e));
        });
    });
  const complete = (projectId?: string, defer = false) =>
    void run(async () => {
      await command("complete", { defer });
      if (!active.current) return;
      const connected = current.current.projects.find(
        (project) =>
          project.projectId && current.current.selected.includes(project.path),
      );
      if (projectId || connected?.projectId)
        onComplete(projectId ?? connected!.projectId!);
      await refresh();
    });
  const invite = async (projectId: string) => {
    if (
      inviteInFlight.current ||
      locked.current ||
      !active.current ||
      current.current.step !== "invite"
    )
      return;
    inviteInFlight.current = true;
    setCopyingInvite(projectId);
    setError("");
    try {
      let url = pendingInvites.current.get(projectId);
      if (!url) {
        const result = await invoke<{ token: string; url?: string }>(
          "cloud_action",
          { action: "invite", input: { projectId } },
        );
        url = result.url ?? `orka://join/${result.token}`;
        pendingInvites.current.set(projectId, url);
      }
      if (!active.current || current.current.step !== "invite") return;
      await navigator.clipboard.writeText(url);
      pendingInvites.current.delete(projectId);
      if (active.current && current.current.step === "invite") {
        setCopied(projectId);
        clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(() => setCopied(""), 2000);
      }
    } catch (e) {
      if (active.current && current.current.step === "invite")
        setError(String(e).replace(/^Error:\s*/, ""));
    } finally {
      inviteInFlight.current = false;
      if (active.current) setCopyingInvite("");
    }
  };
  const background = (enabled: boolean) =>
    void run(async () => {
      try {
        await invoke("background_agent", { enabled });
      } catch (e) {
        if (!enabled) throw e;
        // Only a macOS registration denial belongs in Login Items recovery.
        // A test-build restriction or other failure must keep its real error.
        if (String(e).includes("Enable Orka in macOS Login Items")) {
          await checkpoint({ step: "background-off" });
          return;
        }
        throw e;
      }
      await checkpoint({ step: "invite" });
      await refresh();
    });
  return {
    draft,
    profile,
    profileReady,
    busy,
    error,
    copied,
    copyingInvite,
    go,
    setProjectChoice: (path: string, id: string) =>
      updateChoices((value) => ({
        choices: { ...value.choices, [path]: id },
        sourceChoices: { ...value.sourceChoices, [path]: "" },
      })),
    setSourceChoice: (path: string, id: string) =>
      updateChoices((value) => ({
        sourceChoices: { ...value.sourceChoices, [path]: id },
      })),
    setSharing: (
      kind: keyof Omit<OnboardingDraft["sharing"], "env">,
      enabled: boolean,
    ) =>
      updateChoices((value) => ({
        sharing: { ...value.sharing, [kind]: enabled, env: false },
      })),
    find: () => void run(() => find()),
    chooseFolder,
    retryFolder: () =>
      void run(() =>
        find(current.current.folder ? [current.current.folder] : undefined),
      ),
    restoreFolder: (path: string) =>
      void run(async () => {
        const chosen = await open({
          directory: true,
          multiple: false,
          defaultPath: path,
          title: "Give Orka access to this project folder",
        });
        if (!chosen) return;
        await command("folder-access", {
          path: chosen,
          expectedPath: path,
        });
        await checkpoint({ step: "retrying" });
        void command<OnboardingDraft>("batch-sync", { retry: true })
          .then((next) => {
            if (active.current) {
              current.current = next;
              setDraft(next);
            }
          })
          .catch((e) => {
            if (active.current) setError(String(e));
          });
      }),
    proceed,
    sync,
    complete: () => complete(),
    defer: () => complete(undefined, true),
    completeProject: (id: string) => complete(id),
    invite,
    background,
    saveProfile: (input: AccountProfile) =>
      void run(async () => {
        if (!input.jobRole?.trim())
          throw new Error("Select your role to continue.");
        const value = await command<AccountProfile>("save-profile", input);
        setProfile(value);
        await checkpoint({ step: "discover" });
        await refresh();
      }),
    toggle: (path: string) =>
      updateChoices((value) => ({
        selected: value.selected.includes(path)
          ? value.selected.filter((p) => p !== path)
          : [...value.selected, path],
      })),
    toggleVisible: (paths: string[]) =>
      updateChoices((value) => {
        const selected = new Set(value.selected);
        if (paths.every((path) => selected.has(path))) {
          for (const path of paths) selected.delete(path);
        } else {
          for (const path of paths) selected.add(path);
        }
        return { selected: [...selected] };
      }),
    openSettings: () =>
      void run(() =>
        command("open-settings", {
          kind: draft.step === "access-error" ? "privacy" : "login",
        }),
      ),
    checkLocation: () =>
      void run(async () => {
        const location = await command<{ ok: boolean }>("app-location");
        if (location.ok) await checkpoint({ step: "profile" });
        else
          throw new Error(
            "Open the copy of Orka in Applications, then check again.",
          );
      }),
  };
}
