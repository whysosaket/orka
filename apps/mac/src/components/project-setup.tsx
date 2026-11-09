import { TextField } from "./text-field.js";
import { IconButton } from "./icon-button.js";
import { Button } from "./button.js";
import { Icon } from "./icon.js";
import React from "react";
import {
  AlertIcon,
  ArrowRightIcon,
  FileDirectoryIcon,
  PlusIcon,
  SignInIcon,
  XIcon,
} from "@primer/octicons-react";
import { Overlay } from "./overlay.js";
import { ProjectSharingChoices } from "./project-sharing.js";
import type { ProjectSharing } from "../types.js";
import { SourceFolders, type useSourceFolders } from "./source-folders.js";

export type ProjectSetupMode = "create" | "join";

export function ProjectSetupDialog({
  mode,
  value,
  busy,
  error,
  onChange,
  onClose,
  onSubmit,
  selection,
  run,
  sharing,
  onSharingChange,
  inviteService,
  serviceMismatch = false,
  onSwitchService,
  repositoryEnabled = false,
  sourceMode = "folder",
  onSourceMode,
}: {
  repositoryEnabled?: boolean;
  sourceMode?: "github" | "folder";
  onSourceMode?: (value: "github" | "folder") => void;
  mode: ProjectSetupMode;
  value: string;
  busy: boolean;
  error: string;
  onChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
  selection: ReturnType<typeof useSourceFolders>;
  run: (action: () => Promise<unknown>) => void;
  sharing: ProjectSharing;
  onSharingChange: (value: ProjectSharing) => void;
  inviteService?: string;
  serviceMismatch?: boolean;
  onSwitchService?: () => void;
}) {
  const creating = mode === "create";
  const title = creating ? "Create project" : "Join project";
  return (
    <Overlay
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      title={title}
      className="create-project-modal"
    >
      <form
        className="create-project-form"
        aria-busy={busy}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="create-project-heading">
          <h2>{title}</h2>
          <IconButton
            icon={XIcon}
            variant="tertiary"
            size="sm"
            aria-label={
              creating ? "Close create project" : "Close join project"
            }
            disabled={busy}
            onClick={onClose}
          />
        </div>
        <div className="create-project-fields">
          {creating ? (
            <>
              <TextField
                label="Project name"
                icon={FileDirectoryIcon}
                autoFocus
                required
                maxLength={128}
                autoComplete="off"
                spellCheck={false}
                value={value}
                disabled={busy}
                onChange={(event) => onChange(event.target.value)}
              />
              {repositoryEnabled && (
                <fieldset className="repository-source-choice">
                  <legend>Repository</legend>
                  <label>
                    <input
                      type="radio"
                      name="source-kind"
                      checked={sourceMode === "github"}
                      onChange={() => onSourceMode?.("github")}
                    />
                    GitHub repository
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="source-kind"
                      checked={sourceMode === "folder"}
                      onChange={() => onSourceMode?.("folder")}
                    />
                    Local folder
                  </label>
                </fieldset>
              )}
              {sourceMode === "github" ? (
                <p className="create-project-source-hint">
                  Choose an account and repository next.
                </p>
              ) : (
                <SourceFolders selection={selection} busy={busy} run={run} />
              )}
            </>
          ) : (
            <TextField
              label="Invite link or token"
              icon={SignInIcon}
              autoFocus
              required
              maxLength={2048}
              placeholder="https://…/join/…"
              autoComplete="off"
              spellCheck={false}
              value={value}
              disabled={busy}
              onChange={(event) => onChange(event.target.value)}
            />
          )}
          {!creating && inviteService && (
            <div className="project-invite-service" role="status">
              <p>Project service: {inviteService}</p>
              {serviceMismatch && (
                <>
                  <p>
                    Switch to this service and sign in to join. Your current
                    service’s projects stay saved.
                  </p>
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={onSwitchService}
                  >
                    Switch service and sign in
                  </Button>
                </>
              )}
            </div>
          )}
          <ProjectSharingChoices
            value={sharing}
            disabled={busy}
            onChange={onSharingChange}
          />
          {error && (
            <div className="setup-error" role="alert">
              <AlertIcon size={16} aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}
        </div>
        <div className="create-project-footer">
          <Button variant="tertiary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={busy || !value.trim() || serviceMismatch}
          >
            {busy ? (creating ? "Creating…" : "Joining…") : title}
          </Button>
        </div>
      </form>
    </Overlay>
  );
}

export function ProjectEmptyState({
  onCreate,
  onJoin,
}: {
  onCreate: () => void;
  onJoin: () => void;
}) {
  return (
    <section className="project-empty" aria-labelledby="project-empty-title">
      <div className="setup-symbol">
        <FileDirectoryIcon size={25} aria-hidden="true" />
      </div>
      <h2 id="project-empty-title">Start with a project</h2>
      <div className="actions">
        <Button onClick={onCreate} variant="primary" size="lg">
          <Icon icon={PlusIcon} />
          Add project
        </Button>
        <Button onClick={onJoin} variant="secondary" size="lg">
          <Icon icon={SignInIcon} />
          Join project
        </Button>
      </div>
    </section>
  );
}

export function FolderConnectionPrompt({
  projectName,
  busy,
  onConnect,
  repositories = false,
}: {
  projectName: string;
  busy: boolean;
  onConnect: () => void;
  repositories?: boolean;
}) {
  return (
    <section className="folder-connection" aria-label="Connect this Mac">
      <div className="connection-symbol">
        <FileDirectoryIcon size={18} aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <h2>Connect this Mac</h2>
        <p>
          {repositories ? (
            <>
              Clone or locate the repositories for{" "}
              <strong>{projectName}</strong> to sync files and open native
              sessions.
            </>
          ) : (
            <>
              Choose the local folder for <strong>{projectName}</strong> to sync
              files and open native sessions.
            </>
          )}
        </p>
      </div>
      <Button
        className="shrink-0"
        disabled={busy}
        onClick={onConnect}
        variant="primary"
        size="md"
      >
        {repositories ? "Connect repositories" : "Connect folder"}
        <Icon icon={ArrowRightIcon} />
      </Button>
    </section>
  );
}
