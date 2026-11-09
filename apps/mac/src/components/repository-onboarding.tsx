import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Snapshot } from "../types.js";
import { Button } from "./button.js";
import { TextField } from "./text-field.js";
import { RepositoryConnections } from "./repository-connections.js";
import { defaultSharing, ProjectSharingChoices } from "./project-sharing.js";
import { parseProjectInvite, sameServiceUrl } from "./project-invite.js";

export function RepositoryOnboarding({
  state,
  refresh,
  onBack,
  onComplete,
}: {
  state: Snapshot;
  refresh: () => Promise<void>;
  onBack: () => void;
  onComplete: (id: string) => void;
}) {
  const [projectId, setProjectId] = useState(state.projects[0]?.id ?? "");
  const [mode, setMode] = useState<"create" | "join">("create");
  const [value, setValue] = useState("");
  const [sharing, setSharing] = useState(defaultSharing);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const project = state.projects.find((item) => item.id === projectId);
  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const invite = mode === "join" ? parseProjectInvite(value) : null;
      if (
        invite?.serviceUrl &&
        !sameServiceUrl(invite.serviceUrl, state.config?.apiUrl ?? "")
      )
        throw new Error(
          `Sign in to ${invite.serviceUrl} before joining this project.`,
        );
      const result = await invoke<{ id: string }>("cloud_action", {
        action: mode,
        input:
          mode === "create"
            ? { name: value.trim(), sharing }
            : { ...invite, sharing },
      });
      setProjectId(result.id);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="repository-onboarding">
      <h1>Connect repositories from GitHub</h1>
      <p>
        Create or join an Orka project, connect GitHub, then clone the
        repositories you need on this Mac.
      </p>
      {state.projects.length > 0 && (
        <label>
          Orka project
          <select
            aria-label="Orka project"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
          >
            <option value="">Create or join another project</option>
            {state.projects.map((item) => (
              <option value={item.id} key={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {!project && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="actions">
            <Button
              disabled={busy}
              aria-pressed={mode === "create"}
              onClick={() => {
                setMode("create");
                setValue("");
              }}
            >
              Create project
            </Button>
            <Button
              disabled={busy}
              aria-pressed={mode === "join"}
              onClick={() => {
                setMode("join");
                setValue("");
              }}
            >
              Join project
            </Button>
          </div>
          <TextField
            label={mode === "create" ? "Project name" : "Invite link or token"}
            value={value}
            maxLength={mode === "create" ? 100 : 2048}
            disabled={busy}
            onChange={(event) => setValue(event.target.value)}
            required
          />
          <ProjectSharingChoices
            value={sharing}
            disabled={busy}
            onChange={setSharing}
          />
          <Button
            type="submit"
            variant="primary"
            disabled={busy || !value.trim()}
          >
            {busy
              ? "Preparing project…"
              : mode === "create"
                ? "Create project and connect GitHub"
                : "Join project and connect GitHub"}
          </Button>
        </form>
      )}
      {project && (
        <RepositoryConnections
          key={project.id}
          project={project}
          state={state}
          refresh={refresh}
        />
      )}
      {error && <p role="alert">{error}</p>}
      <div className="actions">
        <Button disabled={busy} onClick={onBack}>
          Back to local projects
        </Button>
        {project && (
          <Button
            disabled={busy}
            variant="primary"
            onClick={() => onComplete(project.id)}
          >
            Continue to workspace
          </Button>
        )}
      </div>
    </main>
  );
}
