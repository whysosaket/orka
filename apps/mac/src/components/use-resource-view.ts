import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { QueryClient, useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import type { Resource, SessionConflict } from "@portable/protocol";
import type { Inspection } from "../types.js";

export interface ResourceView {
  /** The inspected file: SKILL.md for skills, otherwise the first file. */
  file: string;
  setFile: Dispatch<SetStateAction<string>>;
  inspection: Inspection | null;
  inspectionError: string;
  retryInspection: () => void;
  /** The conflict version being read; empty for the shared version. */
  preview: string;
  setPreview: Dispatch<SetStateAction<string>>;
  fullTranscript: boolean;
  setFullTranscript: Dispatch<SetStateAction<boolean>>;
  /** Literal line diff against the previous revision. */
  changes: boolean;
  setChanges: Dispatch<SetStateAction<boolean>>;
  rawMarkdown: boolean;
  setRawMarkdown: Dispatch<SetStateAction<boolean>>;
  canRenderMarkdown: boolean;
}

/**
 * Reading state for the selected resource and the native inspection that
 * matches it. Sessions only inspect the raw transcript in transcript mode.
 */
export function useResourceView(
  resourceId: string,
  resource: Resource | undefined,
  conflicts: SessionConflict[],
  scope: string,
): ResourceView {
  // A private, memory-only cache for this pilot. Scope is part of every key,
  // and account/service/profile changes remove the previous scope's contents.
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            networkMode: "always", // Local IPC reads must also work offline.
            retry: false,
            refetchOnWindowFocus: false,
            refetchOnReconnect: false,
            staleTime: 30_000,
            gcTime: 5 * 60_000,
          },
        },
      }),
  );
  useEffect(() => {
    client.mount();
    return () => {
      client.unmount();
      client.clear();
    };
  }, [client]);
  useEffect(() => {
    client.removeQueries({ predicate: (query) => query.queryKey[1] !== scope });
  }, [client, scope]);
  const [file, setFile] = useState("");
  const [selection, setSelection] = useState("");
  const [preview, setPreview] = useState("");
  const [fullTranscript, setFullTranscript] = useState(false);
  const [changes, setChanges] = useState(false);
  const [rawMarkdown, setRawMarkdown] = useState(false);
  const loaded = Boolean(resource);
  const defaultFile =
    resource?.kind === "skill" ? "SKILL.md" : (resource?.files[0]?.path ?? "");
  const id = resource?.resourceId;
  const kind = resource?.kind;
  const selectionKey = JSON.stringify([scope, resourceId, loaded, defaultFile]);
  useEffect(() => {
    setRawMarkdown(false);
  }, [resourceId, file, preview]);
  // Reset on selection, and again when the resource arrives after its id did
  // (a deep link handled before the first snapshot).
  useEffect(() => {
    setFile(defaultFile);
    setSelection(selectionKey);
    setChanges(false);
    setFullTranscript(false);
    setPreview("");
  }, [selectionKey, defaultFile]);
  useEffect(() => {
    if (preview && !conflicts.some((c) => c.id === preview)) setPreview("");
  }, [conflicts, preview]);
  const conflict = conflicts.find((item) => item.id === preview);
  const enabled = Boolean(
    selection === selectionKey &&
    id &&
    file &&
    (!preview || conflict) &&
    (kind !== "session" || fullTranscript),
  );
  const inspection = useQuery(
    {
      queryKey: [
        "resource-inspection",
        scope,
        resource?.projectId,
        id,
        resource?.revision,
        file,
        resource?.files.find((item) => item.path === file)?.hash,
        preview,
        conflict?.revision,
        conflict?.candidate.files,
      ],
      enabled,
      queryFn: async ({ signal }) => {
        const result = await invoke<Inspection>("inspect_resource", {
          id,
          file,
          conflictId: preview || null,
        });
        // Native IPC itself cannot be aborted. Consuming the signal lets Query
        // discard a response after selection or scope changes.
        if (signal.aborted) throw new Error("Resource inspection canceled");
        return result;
      },
    },
    client,
  );
  return {
    file,
    setFile,
    inspection: enabled ? (inspection.data ?? null) : null,
    inspectionError:
      enabled && inspection.error ? String(inspection.error) : "",
    retryInspection: () => {
      if (enabled) void inspection.refetch();
    },
    preview,
    setPreview,
    fullTranscript,
    setFullTranscript,
    changes,
    setChanges,
    rawMarkdown,
    setRawMarkdown,
    canRenderMarkdown:
      resource?.kind !== "session" && /\.(md|markdown|mdown)$/i.test(file),
  };
}
