import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { ProjectSharing } from "../types.js";
import type { ProjectSetupMode } from "./project-setup.js";
import { privateSharing } from "./project-sharing.js";
import { parseProjectInvite, sameServiceUrl } from "./project-invite.js";
import { useSourceFolders } from "./source-folders.js";

export async function connectProject(
  id: string,
  sourceId?: string,
  defaultPath?: string,
) {
  const path = await open({
    directory: true,
    multiple: !sourceId,
    title: "Connect source folders on this Mac",
    defaultPath,
  });
  const paths = typeof path === "string" ? [path] : (path ?? []);
  if (paths.length)
    await invoke("connect_project_sources", { id, paths, sourceId });
}

export function useProjectSetup(
  onProject: (id: string) => void,
  onError: (message: string) => void,
  apiUrl?: string,
) {
  const [dialog, setDialog] = useState<ProjectSetupMode | null>(null);
  const [input, setInput] = useState("");
  const selection = useSourceFolders();
  const [sharing, setSharing] = useState<ProjectSharing>(privateSharing);
  let inviteService: string | undefined;
  if (dialog === "join") {
    try {
      inviteService = parseProjectInvite(input).serviceUrl;
    } catch {
      // Partial input is validated when the form is submitted.
    }
  }
  const serviceMismatch = Boolean(
    inviteService && apiUrl && !sameServiceUrl(inviteService, apiUrl),
  );

  const show = (mode: ProjectSetupMode, value = "") => {
    onError("");
    setInput(value);
    selection.clear();
    setSharing(privateSharing);
    setDialog(mode);
  };
  const submit = async () => {
    if (!dialog) return;
    const invite = dialog === "join" ? parseProjectInvite(input) : null;
    if (
      invite?.serviceUrl &&
      (!apiUrl || !sameServiceUrl(invite.serviceUrl, apiUrl))
    )
      throw new Error(
        `Sign in to ${invite.serviceUrl} before joining this project.`,
      );
    const result = await invoke<{ id: string }>("cloud_action", {
      action: dialog,
      input:
        dialog === "create"
          ? { name: input.trim(), sharing }
          : { ...invite, sharing },
    });
    onProject(result.id);
    setDialog(null);
    setInput("");
    if (dialog === "create") {
      if (selection.folders.length)
        await invoke("connect_project_sources", {
          id: result.id,
          paths: selection.folders,
        });
      selection.clear();
    } else await connectProject(result.id);
  };

  return {
    dialog,
    input,
    setInput,
    selection,
    sharing,
    inviteService,
    serviceMismatch,
    setSharing,
    show,
    submit,
    close: () => setDialog(null),
  };
}
