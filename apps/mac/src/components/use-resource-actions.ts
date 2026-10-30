import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import type { Resource } from "@portable/protocol";

/** Runs a native action with the shared busy and error handling, then refreshes. */
export type ActionFeedback = {
  errorTitle?: string;
  successTitle?: string;
  kind?: "success" | "queued";
  retryable?: boolean;
};
export type Run = (
  action: () => Promise<unknown>,
  feedback?: ActionFeedback,
) => Promise<void>;
export type SessionActionName = "copy" | "delete" | "keep" | "override";
export type SessionVersion = "current" | "candidate";
export type SessionTool = "claude" | "codex";
export type SessionDestination = "desktop" | "terminal" | "warp" | "iterm2";
export interface SessionLaunchOption {
  tool: SessionTool;
  destination: SessionDestination;
  label: string;
  available: boolean;
  reason: string | null;
  icon?: string | null;
}

export const sessionTool = (
  source: Resource["source"],
): SessionTool | undefined =>
  source === "claude" || source === "codex" ? source : undefined;
export type ResourceActionHandlers = ReturnType<typeof useResourceActions>;

/** The native commands behind the reading view's buttons and menu. */
export function useResourceActions({
  act,
  resource,
  user,
  onNotice,
  scope,
}: {
  act: Run;
  resource: Resource;
  user: string | null;
  onNotice: (message: string) => void;
  scope: string;
}) {
  const { resourceId: id, source, owner, title, kind } = resource;
  const commandKey = JSON.stringify([scope, id, resource.revision]);
  const [manualResume, setManualCommand] = useState<{
    key: string;
    command: string;
  } | null>(null);
  const [launchFailure, setLaunchFailure] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const manualCommand =
    manualResume?.key === commandKey ? manualResume.command : null;
  const launchError =
    launchFailure?.key === commandKey ? launchFailure.message : null;
  return useMemo(
    () => ({
      manualCommand,
      launchError,
      dismissManualCommand: () => setManualCommand(null),
      openEditor: (file: string) =>
        act(() => invoke("open_editor", { id, file }), {
          errorTitle: "Couldn’t open editor",
          retryable: true,
        }),
      resume: (target?: Pick<SessionLaunchOption, "tool" | "destination">) =>
        act(
          async () => {
            setLaunchFailure(null);
            const r = await invoke<{
              instruction?: string;
              manualCommand?: string;
            }>("resume_session", {
              id,
              tool: source,
              ...(target
                ? { tool: target.tool, destination: target.destination }
                : {}),
            }).catch((error: unknown) => {
              setLaunchFailure({ key: commandKey, message: String(error) });
              throw error;
            });
            if (r.manualCommand) {
              setManualCommand({ key: commandKey, command: r.manualCommand });
              return;
            }
            onNotice(
              r.instruction ??
                (owner === user
                  ? "Opened native session."
                  : "Opened native session. Your continuation will be saved as a copy."),
            );
          },
          { errorTitle: "Couldn’t open session" },
        ),
      exportZip: () =>
        act(
          async () => {
            const path = await save({
              defaultPath: `${title.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60)}.zip`,
              filters: [{ name: "ZIP", extensions: ["zip"] }],
            });
            if (path) {
              await invoke("export_bundle", { id, path });
              onNotice(kind === "session" ? "Download saved" : "Export saved");
            }
          },
          { errorTitle: "Couldn’t export ZIP", retryable: true },
        ),
      sessionAction: (
        action: SessionActionName,
        conflictId: string | null = null,
        selected: SessionVersion | null = null,
      ) =>
        act(
          async () => {
            await invoke("session_action", {
              id,
              action,
              conflictId,
              selected,
            });
            onNotice(
              action === "copy"
                ? "Session copy queued"
                : action === "delete"
                  ? "Session removal queued"
                  : "Conflict choice queued",
            );
          },
          {
            errorTitle:
              action === "copy"
                ? "Couldn’t queue session copy"
                : action === "delete"
                  ? "Couldn’t queue session removal"
                  : "Couldn’t queue conflict choice",
          },
        ),
    }),
    [
      act,
      id,
      source,
      owner,
      title,
      kind,
      user,
      onNotice,
      manualCommand,
      commandKey,
      launchError,
    ],
  );
}
