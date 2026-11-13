import { activeSources, sourcePath } from "../project-sources.js";
import { useRef, useState } from "react";
import type { EnvMember } from "@portable/protocol";
import type { Project } from "../../types.js";
import {
  type Draft,
  type Preview,
  type Comparison,
  type ApprovalInfo,
} from "./api.js";
import { useEnvConnection } from "./use-env-connection.js";
import { useEnvReveal } from "./use-env-reveal.js";
import { useToasts } from "../toasts.js";
import { useMemberLabel } from "../member-names.js";

export function useEnvironments(
  project: Project,
  user: string,
  initialSet = "",
  repository = "all",
) {
  const { notify } = useToasts();
  const memberName = useMemberLabel(user);
  const connection = useEnvConnection(project.id);
  const {
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
  } = connection;
  const [selected, setSelected] = useState(initialSet);
  const [sourceId, setSourceId] = useState(
    activeSources(project.sources)[0]?.id ?? "",
  );
  const [draft, setDraft] = useState<Draft | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [grants, setGrants] = useState<string[]>([user]);
  const [removedDevices, setRemovedDevices] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [code, setCode] = useState("");
  const [outputCode, setOutputCode] = useState("");
  const [approvalInfo, setApprovalInfo] = useState<
    (ApprovalInfo & { code: string }) | null
  >(null);
  const [path, setPath] = useState(".env.local");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [remote, setRemote] = useState<Draft | null>(null);
  const [comparison, setComparison] = useState<Comparison[]>([]);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [modal, setModal] = useState<
    | "import"
    | "access"
    | "approve"
    | "accept"
    | "code"
    | "apply"
    | "delete"
    | "conflict"
    | "publish"
    | "discard"
    | null
  >(null);
  const [origin, setOrigin] = useState<"pulled" | "imported">("pulled");
  const { revealed, clearRevealed, reveal } = useEnvReveal(
    JSON.stringify([selected, draft?.draftId, modal, repository]),
    connection,
  );
  const pendingAction = useRef<(() => void) | null>(null);
  const hasUnpublishedChanges = Boolean(draft && origin === "imported");
  const selectedSet = listing?.sets.find((s) => s.setId === selected);
  const label = (id: string) =>
    listing?.members.find((m) => m.id === id)?.label ?? memberName(id);
  const close = () => {
    if (locked.current && modal !== "code") return;
    if ((modal === "conflict" || modal === "publish") && remote) {
      void env("discard", { draftId: remote.draftId }).catch(() => {});
      setRemote(null);
    }
    setModal(null);
    setText("");
    setCode("");
    setOutputCode("");
    setApprovalInfo(null);
    setPreview(null);
    setError("");
    pendingAction.current = null;
  };
  const guardDraft = (action: () => void) => {
    if (locked.current) return;
    if (hasUnpublishedChanges) {
      pendingAction.current = action;
      setModal("discard");
    } else action();
  };
  const confirmDiscard = () => {
    const action = pendingAction.current;
    pendingAction.current = null;
    setModal(null);
    action?.();
  };
  const replaceDraft = async (next: Draft) => {
    if (!active.current) {
      await env("discard", { draftId: next.draftId });
      return;
    }
    if (draft && draft.draftId !== next.draftId)
      await env("discard", { draftId: draft.draftId }).catch(() => {});
    setDraft(next);
    setChecked(next.keys);
    setName(next.manifest?.name ?? "");
    setGrants(next.manifest?.grants ?? [user]);
    clearRevealed();
    setPreview(null);
  };
  const pull = (id: string) =>
    guardDraft(() => {
      void run("Pulling encrypted ENV set…", async () => {
        const next = await env<Draft>("pull", {
          projectId: project.id,
          setId: id,
        });
        setOrigin("pulled");
        setSelected(id);
        await replaceDraft(next);
      });
    });
  const imported = async (input: Record<string, unknown>) => {
    const next = await env<Draft>("import", {
      projectId: project.id,
      ...(sourceId ? { sourceId } : {}),
      ...(draft?.revision ? { baseDraft: draft.draftId } : {}),
      ...input,
    });
    setOrigin("imported");
    await replaceDraft(next);
    setText("");
    setModal(null);
  };
  const published = async (
    result: {
      setId: string;
      approvalCode?: string | null;
    },
    message = "ENV set published",
  ) => {
    // A confirmed publication must not become an unpublished draft again if
    // the follow-up refresh fails.
    setDraft(null);
    setChecked([]);
    clearRevealed();
    setPreview(null);
    setOrigin("pulled");
    setSelected(result.setId);
    if (result.approvalCode) {
      setOutputCode(result.approvalCode);
      setModal("code");
    } else {
      setModal(null);
    }
    if (draft) await env("discard", { draftId: draft.draftId }).catch(() => {});
    try {
      await load();
      if (!result.approvalCode) setNotice(message);
    } catch {
      setError(
        "Publication succeeded. Refresh ENVs when connected to see the latest version.",
      );
      notify({
        title: "Published. Refresh to see it.",
        kind: "warning",
        action: {
          label: "Refresh",
          onClick: () => void run("Refreshing…", load),
        },
      });
    }
  };
  const toggle = (items: string[], id: string) =>
    items.includes(id) ? items.filter((i) => i !== id) : [...items, id];
  const members: EnvMember[] = [
    ...(listing?.members ?? []),
    ...(draft?.manifest?.grants ?? [])
      .filter((id) => !listing?.members.some((m) => m.id === id))
      .map((id) => ({
        id,
        label: `Former project member ${id.slice(0, 8)}`,
        devices: [],
      })),
  ];
  const reviewConflict = (publication = false) =>
    run("Comparing with the latest publication…", async () => {
      const next = await env<Draft>("pull", {
        projectId: project.id,
        setId: draft!.setId,
      });
      let result: { keys: Comparison[] };
      try {
        result = await env("compare", {
          draftId: draft!.draftId,
          remoteDraft: next.draftId,
          keys: checked,
        });
      } catch (error) {
        await env("discard", { draftId: next.draftId }).catch(() => {});
        throw error;
      }
      if (remote)
        await env("discard", { draftId: remote.draftId }).catch(() => {});
      setRemote(next);
      setComparison(result.keys);
      setChoices(
        Object.fromEntries(
          result.keys.filter((k) => !k.changed).map((k) => [k.key, "local"]),
        ),
      );
      setModal(
        publication && next.revision === draft!.revision
          ? "publish"
          : "conflict",
      );
    });

  const newSet = () =>
    guardDraft(() => {
      void run("Opening new ENV set…", async () => {
        if (draft) await env("discard", { draftId: draft.draftId });
        setDraft(null);
        setSelected("");
        setText("");
        setName("");
        setGrants([user]);
        const sources = activeSources(project.sources);
        setSourceId(
          sources.find((source) => source.id === repository)?.id ??
            sources[0]?.id ??
            "",
        );
        setModal("import");
      });
    });
  const select = (id: string) => {
    if (id === selected && hasUnpublishedChanges) return;
    guardDraft(() => {
      void run("Opening ENV set…", async () => {
        if (draft) await env("discard", { draftId: draft.draftId });
        setDraft(null);
        setChecked([]);
        setSelected(id);
        setPreview(null);
        clearRevealed();
      });
    });
  };
  const discard = () =>
    guardDraft(() => {
      void run("Discarding draft…", async () => {
        if (draft) await env("discard", { draftId: draft.draftId });
        setDraft(null);
        setChecked([]);
        setPreview(null);
        clearRevealed();
        setNotice("Local draft discarded.");
      });
    });
  const publish = () =>
    void run("Encrypting and publishing…", async () => {
      if (!draft) return;
      let result: { setId: string };
      try {
        result = await env("publish", {
          draftId: draft.draftId,
          name,
          grants,
          keys: checked,
        });
      } catch (error) {
        await load().catch(() => {});
        throw error;
      }
      if (remote) {
        await env("discard", { draftId: remote.draftId }).catch(() => {});
        setRemote(null);
      }
      await published(result);
      try {
        await replaceDraft(
          await env<Draft>("pull", {
            projectId: project.id,
            setId: result.setId,
          }),
        );
        setOrigin("pulled");
      } catch {
        setError(
          "Publication succeeded. Pull latest when connected to review or apply it.",
        );
        notify({
          title: "Published. Pull latest to continue.",
          kind: "warning",
          action: { label: "Pull latest", onClick: () => pull(result.setId) },
        });
      }
    });
  const reviewPublication = () => {
    if (draft?.revision) void reviewConflict(true);
    else publish();
  };
  const requestApproval = () =>
    void run("Creating approval request…", async () => {
      const result = await env<{ code: string }>("request", {
        projectId: project.id,
        setId: selected,
      });
      setOutputCode(result.code);
      setModal("code");
    });

  const cloneSet = () =>
    void run("Preparing replacement locally…", async () => {
      if (!draft) return;
      const replacement = await env<Draft>("clone-set", {
        draftId: draft.draftId,
      });
      const oldName = selectedSet?.name ?? "ENV set";
      await replaceDraft(replacement);
      setSelected("");
      setName(`${oldName} (replacement)`);
      setOrigin("imported");
      setNotice(
        "Review and publish this new encrypted set, then mark the old set replaced in its file permissions.",
      );
    });
  return {
    connected: Boolean(
      sourcePath(project, draft?.sourceId ?? selectedSet?.sourceId),
    ),
    sourceId,
    setSourceId,
    cloneSet,
    project,
    user,
    capability,
    setCapability,
    listing,
    selected,
    setSelected,
    draft,
    setDraft,
    checked,
    setChecked,
    name,
    setName,
    grants,
    setGrants,
    removedDevices,
    setRemovedDevices,
    text,
    setText,
    code,
    setCode,
    outputCode,
    setOutputCode,
    approvalInfo,
    setApprovalInfo,
    path,
    setPath,
    preview,
    setPreview,
    revealed,
    clearRevealed,
    remote,
    setRemote,
    comparison,
    choices,
    setChoices,
    modal,
    setModal,
    error,
    setError,
    setNotice,
    busy,
    active,
    selectedSet,
    label,
    load,
    run,
    close,
    replaceDraft,
    pull,
    imported,
    published,
    toggle,
    members,
    reviewConflict,
    env,
    origin,
    setOrigin,
    newSet,
    select,
    discard,
    publish,
    requestApproval,
    checkAvailability,
    reveal,
    hasUnpublishedChanges,
    confirmDiscard,
    reviewPublication,
  };
}
export type EnvController = ReturnType<typeof useEnvironments>;
