import type { RefObject, ReactNode } from "react";
import { Button } from "../button.js";
import type { useOnboarding } from "./use-onboarding.js";

export function RecoveryStep({
  flow,
  headingRef,
}: {
  flow: ReturnType<typeof useOnboarding>;
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  const { draft, busy } = flow;
  const step = draft.step;
  const selected = draft.projects.filter((p) =>
    draft.selected.includes(p.path),
  );
  const heading = (title: string, description?: string) => (
    <div className="onboarding-flow__copy">
      <h1 ref={headingRef} tabIndex={-1}>
        {title}
      </h1>
      {description && <p>{description}</p>}
    </div>
  );
  const actions = (secondary: ReactNode, primary: ReactNode) => (
    <div className="onboarding-flow__recovery-actions">
      {secondary}
      {primary}
    </div>
  );
  const back = (
    <Button disabled={busy} onClick={() => flow.go("background")}>
      Back to setup
    </Button>
  );
  let content: ReactNode;
  if (["folder", "empty", "access-error"].includes(step)) {
    content = (
      <>
        {heading(
          step === "folder"
            ? "Connect a folder"
            : step === "empty"
              ? "No projects found"
              : "Folder access needed",
          step === "folder"
            ? "Choose your project folder. Nothing uploads until you start syncing."
            : step === "empty"
              ? "Choose a folder, or run Claude Code or Codex in a project and search again."
              : "Allow Orka in System Settings → Privacy & Security → Files & Folders.",
        )}
        {step !== "empty" && draft.folder && (
          <p className="onboarding-flow__folder-path">{draft.folder}</p>
        )}
        {actions(
          <Button
            disabled={busy}
            onClick={
              step === "folder"
                ? () => flow.go("discover")
                : step === "access-error"
                  ? flow.retryFolder
                  : flow.find
            }
          >
            {step === "folder"
              ? "Back"
              : step === "empty"
                ? "Search again"
                : "Try again"}
          </Button>,
          <Button
            variant="primary"
            disabled={busy}
            onClick={
              step === "access-error"
                ? flow.openSettings
                : () => flow.chooseFolder()
            }
          >
            {step === "access-error"
              ? "Open System Settings"
              : step === "folder"
                ? "Choose folder"
                : "Choose a folder"}
          </Button>,
        )}
        {step === "access-error" && (
          <Button
            variant="tertiary"
            disabled={busy}
            onClick={() => flow.chooseFolder()}
          >
            Choose another folder
          </Button>
        )}
      </>
    );
  } else if (step === "partial-access") {
    content = (
      <>
        {heading(
          "Some folders need access",
          "Connect the readable projects now, or give access to the remaining folder.",
        )}
        <div className="onboarding-flow__sync-status">
          {draft.projects.map((project) => (
            <div key={project.path}>
              <div className="onboarding-flow__status-details">
                <strong>{project.name}</strong>
                <small>{project.displayPath}</small>
              </div>
              {project.readable === false ? (
                <Button
                  disabled={busy}
                  onClick={() => flow.chooseFolder(true, project.path)}
                >
                  Give access
                </Button>
              ) : (
                <span>Ready</span>
              )}
            </div>
          ))}
        </div>
        {actions(
          <Button disabled={busy} onClick={() => flow.chooseFolder(true)}>
            Choose another folder
          </Button>,
          <Button
            variant="primary"
            disabled={busy || !draft.selected.length}
            onClick={flow.proceed}
          >
            Continue with {draft.selected.length}{" "}
            {draft.selected.length === 1 ? "project" : "projects"}
          </Button>,
        )}
      </>
    );
  } else if (step === "offline" || step === "sync-error") {
    const failed = selected.filter((p) => p.status !== "synced");
    const folderErrors =
      failed.length > 0 &&
      failed.every((p) =>
        /folder|couldn.t read|can.t read|permission denied|operation not permitted/i.test(
          p.error ?? "",
        ),
      );
    content = (
      <>
        {heading(
          step === "offline"
            ? "You’re offline"
            : folderErrors
              ? failed.length === 1
                ? "One project needs access"
                : "Some projects need access"
              : "Some projects need another try",
          step === "offline"
            ? "Your progress is saved. Reconnect to finish syncing."
            : folderErrors
              ? "Your other projects have synced. Allow folder access to finish."
              : "Your progress is saved. Retry the remaining projects.",
        )}
        <div className="onboarding-flow__sync-status" aria-live="polite">
          {selected.map((project) => (
            <div key={project.path}>
              <div className="onboarding-flow__status-details">
                <strong>{project.name}</strong>
                {step !== "offline" && project.status === "error" && (
                  <small>
                    {folderErrors
                      ? `Orka can’t read ${project.displayPath}`
                      : project.error}
                  </small>
                )}
              </div>
              {project.status === "synced" ? (
                <span>{step === "offline" ? "Saved" : "Synced"}</span>
              ) : step === "offline" ? (
                <span>Paused</span>
              ) : folderErrors ? (
                <Button
                  disabled={busy}
                  onClick={() => flow.restoreFolder(project.path)}
                >
                  Give access
                </Button>
              ) : (
                <span>Needs attention</span>
              )}
            </div>
          ))}
        </div>
        {actions(
          <Button disabled={busy} onClick={flow.complete}>
            {step === "offline" ? "Continue to Orka" : "Continue"}
          </Button>,
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => flow.sync(true)}
          >
            {step === "offline" || failed.length !== 1
              ? "Try again"
              : "Retry this project"}
          </Button>,
        )}
      </>
    );
  } else if (step === "background-off") {
    content = (
      <>
        {heading(
          "Background sync is off",
          "Turn on Orka in System Settings → General → Login Items & Extensions.",
        )}
        {actions(
          back,
          <Button variant="primary" disabled={busy} onClick={flow.openSettings}>
            Open System Settings
          </Button>,
        )}
      </>
    );
  } else return null;
  return <div className="onboarding-flow__recovery">{content}</div>;
}
