import React, { useEffect, useEffectEvent, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Button } from "../button.js";
import { Icon } from "../icon.js";
import {
  ArrowRightIcon,
  CheckIcon,
  CopyIcon,
  FileDirectoryIcon,
} from "@primer/octicons-react";
import { Switch } from "../switch.js";
import { PermissionSelect } from "../permission-select.js";
import { OnboardingError, onboardingAsset } from "../onboarding-auth-layout.js";
import type { Snapshot } from "../../types.js";
import { AuthRecovery } from "../auth-recovery.js";
import { ProfileStep } from "./profile-step.js";
import { RecoveryStep } from "./recovery-step.js";
import { frameForStep, type OnboardingStep } from "./model.js";
import { useOnboarding } from "./use-onboarding.js";
import "./onboarding.css";

const descriptions = {
  memory: ["Memories", "Project instructions and knowledge your AI builds on."],
  session: ["Sessions", "Full conversations from Claude Code and Codex."],
  plan: ["Plans", "Plan files and plans captured from your conversations."],
  skill: ["Skills", "Reusable AI instructions and their supporting files."],
};
export function Onboarding({
  state,
  refresh,
  onComplete,
}: {
  state: Snapshot;
  refresh: () => Promise<void>;
  onComplete: (projectId: string) => void;
}) {
  const flow = useOnboarding(state, refresh, onComplete);
  const { draft, busy, error } = flow;
  const step = draft.step;
  const [showProgress, setShowProgress] = useState(true);
  const title = useRef<HTMLHeadingElement>(null);
  const continueAfterSync = useEffectEvent(() =>
    flow.go(state.background ? "invite" : "background"),
  );
  useEffect(() => {
    title.current?.focus();
    setShowProgress(true);
  }, [step]);
  useEffect(() => {
    if (step !== "ready" || !showProgress) return;
    const timer = setTimeout(() => {
      setShowProgress(false);
      continueAfterSync();
    }, 1500);
    return () => clearTimeout(timer);
  }, [step, showProgress]);
  const projects = draft.projects.filter((p) =>
    draft.selected.includes(p.path),
  );
  const syncing = step === "syncing" || step === "retrying";
  const progressOpen =
    step === "scanning" ||
    (syncing && showProgress) ||
    (step === "ready" && showProgress);
  const matches = Object.entries(draft.matches ?? {}).filter(
    ([path, match]) =>
      draft.selected.includes(path) && match.projects.length > 0,
  );
  const needsChoice = matches.some(([path, match]) => {
    const choice = draft.choices?.[path];
    if ((match.requiresChoice || match.projects.length > 1) && !choice)
      return true;
    const project = match.projects.find((project) => project.id === choice);
    return Boolean(
      (project?.sources?.length ?? 0) > 1 &&
      !(draft.sourceChoices?.[path] || project?.sourceId),
    );
  });
  const synced = projects.filter(
    (project) => project.status === "synced",
  ).length;
  const reviewPending = projects.some(
    (project) => (project.reviewPending ?? 0) > 0,
  );
  const stage = [
    "discover",
    "scanning",
    "select",
    "empty",
    "access-error",
    "folder",
    "partial-access",
  ].includes(step)
    ? 1
    : step === "invite"
      ? 3
      : 2;
  const go = (next: OnboardingStep) => flow.go(next);
  if (step === "profile")
    return (
      <ProfileStep
        profile={flow.profile}
        ready={flow.profileReady}
        busy={busy}
        error={error}
        onSave={flow.saveProfile}
      />
    );
  if (step === "location")
    return (
      <AuthRecovery
        kind="location"
        busy={busy}
        error={error}
        headingRef={title}
        onRetry={flow.checkLocation}
        onBack={() => {}}
      />
    );
  const avatar =
    flow.profile?.avatarData ??
    flow.profile?.avatarPreview ??
    state.accountProfile?.avatarData ??
    state.accountProfile?.avatarPreview ??
    onboardingAsset("profile-placeholder.png");
  const header = (
    heading: string,
    description: string,
    asset: string = "project-folder.png",
    progress = false,
  ) => (
    <div className="onboarding-flow__heading-group">
      {progress && (
        <div
          className="onboarding-flow__steps-progress"
          aria-label="Project setup"
        >
          <span />
          <span />
        </div>
      )}
      <div className="onboarding-flow__heading">
        <div
          className={`onboarding-flow__illustration${asset === "project-folder.png" ? " onboarding-flow__illustration--folder" : ""}`}
          aria-hidden="true"
        >
          <img
            src={onboardingAsset(asset)}
            srcSet={`${onboardingAsset(asset.replace(".png", "@2x.png"))} 2x`}
            alt=""
          />
        </div>
        <div className="onboarding-flow__copy">
          <h1 ref={title} tabIndex={-1}>
            {heading}
          </h1>
          <p>{description}</p>
        </div>
      </div>
    </div>
  );
  const actions = (
    back: () => void,
    primary: React.ReactNode,
    onPrimary: () => void,
    disabled = false,
  ) => (
    <div className="onboarding-flow__actions">
      <Button disabled={busy || syncing} onClick={back}>
        Back
      </Button>
      <Button variant="primary" disabled={busy || disabled} onClick={onPrimary}>
        {primary}
      </Button>
    </div>
  );
  const syncChoices = (
    <>
      {step === "review" &&
        matches.map(([path, match]) => {
          const project = match.projects.find(
            (project) => project.id === draft.choices?.[path],
          );
          const projectChoice =
            match.requiresChoice || match.projects.length > 1;
          const sources = project?.sources ?? [];
          const sourceChoice = sources.length > 1;
          if (!projectChoice && !sourceChoice) return null;
          const name =
            draft.projects.find((project) => project.path === path)?.name ??
            "folder";
          return (
            <div className="onboarding-flow__match" key={path}>
              <p>{name}</p>
              {projectChoice && (
                <PermissionSelect
                  label={`Connect ${name} to project`}
                  placeholder="Choose an Orka project"
                  value={draft.choices?.[path] ?? ""}
                  disabled={busy}
                  options={[
                    ...match.projects.map((project) => ({
                      value: project.id,
                      label: `${project.name}${project.lastSyncAt ? ` · Synced ${new Date(project.lastSyncAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ` · ${project.role === "owner" ? "Owner" : "Member"}`}`,
                    })),
                    { value: "new", label: "Create a separate project" },
                  ]}
                  onChange={(id) => flow.setProjectChoice(path, id)}
                />
              )}
              {sourceChoice && (
                <PermissionSelect
                  label={`Repository for ${name}`}
                  placeholder="Choose a repository"
                  value={draft.sourceChoices?.[path] || project?.sourceId || ""}
                  disabled={busy}
                  options={sources.map((source) => ({
                    value: source.id,
                    label: source.name,
                  }))}
                  onChange={(id) => flow.setSourceChoice(path, id)}
                />
              )}
            </div>
          );
        })}
      <div className="onboarding-flow__sharing-list">
        {(
          Object.entries(descriptions) as [
            keyof typeof descriptions,
            string[],
          ][]
        ).map(([kind, [name, description]]) => (
          <label className="onboarding-flow__sharing-row" key={kind}>
            <img
              src={onboardingAsset(`sync-${kind}.svg`)}
              width={16}
              height={16}
              alt=""
            />
            <span>
              <strong>{name}</strong>
              <small>{description}</small>
            </span>
            <Switch
              aria-label={name}
              checked={draft.sharing[kind]}
              disabled={
                busy || syncing || step === "ready" || step === "background"
              }
              onChange={(event) => flow.setSharing(kind, event.target.checked)}
            />
          </label>
        ))}
      </div>
      {actions(
        () => go("select"),
        syncing ? "Syncing…" : step === "review" ? "Start Syncing" : "Continue",
        () =>
          step === "review"
            ? flow.sync()
            : go(state.background ? "invite" : "background"),
        syncing || needsChoice,
      )}
    </>
  );
  return (
    <main
      className={`onboarding-flow${step === "discover" || step === "scanning" ? " onboarding-flow--first-discovery" : ""}${progressOpen ? " onboarding-flow--progress-visible" : ""}`}
      data-figma-frame={frameForStep[step]}
      data-tauri-drag-region
    >
      <div className="onboarding-flow__backdrop" aria-hidden="true">
        <img src={onboardingAsset("background.svg")} alt="" />
      </div>
      <aside className="onboarding-flow__sidebar">
        <ol aria-label="Onboarding steps">
          {["Add your projects", "Sync projects", "Invite Teammates"].map(
            (label, index) => (
              <li
                key={label}
                aria-current={stage === index + 1 ? "step" : undefined}
              >
                <span>{String(index + 1).padStart(2, "0")}</span>
                <span>{label}</span>
              </li>
            ),
          )}
        </ol>
        <span className="onboarding-flow__avatar">
          <img src={avatar} alt="Your profile photo" width={40} height={40} />
        </span>
      </aside>
      <section
        className={`onboarding-flow__canvas${stage === 1 ? " onboarding-flow__canvas--discovery" : ""}`}
      >
        {(step === "discover" || step === "scanning" || step === "select") && (
          <>
            {header(
              "Add Project",
              "Orka looks for projects you’ve used with Claude Code and Codex. You’ll choose which ones to connect.",
              "project-folder.png",
              true,
            )}
            {step !== "select" ? (
              <div className="onboarding-flow__discovery-actions">
                <Button variant="primary" disabled={busy} onClick={flow.find}>
                  <Icon icon={FileDirectoryIcon} />
                  Find my projects
                </Button>
                <Button disabled={busy} onClick={() => go("folder")}>
                  Choose a folder instead
                </Button>
              </div>
            ) : (
              <div className="onboarding-flow__selection">
                <div className="onboarding-flow__selection-toolbar">
                  <span aria-live="polite">
                    {draft.selected.length} of {draft.projects.length} selected
                  </span>
                  <Button size="sm" disabled={busy} onClick={flow.toggleAll}>
                    {draft.projects
                      .filter((p) => p.readable !== false)
                      .every((p) => draft.selected.includes(p.path))
                      ? "Unselect all"
                      : "Select all"}
                  </Button>
                </div>
                <div className="onboarding-flow__project-list">
                  {draft.projects.map((project) => (
                    <label
                      className="onboarding-flow__project"
                      key={project.path}
                    >
                      <input
                        type="checkbox"
                        checked={draft.selected.includes(project.path)}
                        disabled={busy || project.readable === false}
                        onChange={() => flow.toggle(project.path)}
                      />
                      <span className="onboarding-flow__project-details">
                        <strong>{project.name}</strong>
                        <small title={project.path}>
                          {project.displayPath}
                        </small>
                      </span>
                      <span className="onboarding-flow__tools">
                        {project.sources.map((tool) => (
                          <span className="onboarding-flow__tool" key={tool}>
                            <img
                              src={onboardingAsset(`tool-${tool}.png`)}
                              srcSet={`${onboardingAsset(`tool-${tool}@2x.png`)} 2x`}
                              width={28}
                              height={28}
                              alt={tool === "claude" ? "Claude Code" : "Codex"}
                            />
                          </span>
                        ))}
                      </span>
                      {project.readable === false && <span>Needs access</span>}
                    </label>
                  ))}
                </div>
                <div className="onboarding-flow__actions">
                  <Button
                    disabled={busy}
                    onClick={() => flow.chooseFolder(true)}
                  >
                    Add more
                  </Button>
                  <Button
                    variant="primary"
                    disabled={busy || !draft.selected.length}
                    onClick={flow.proceed}
                  >
                    Proceed
                    <Icon icon={ArrowRightIcon} />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
        {syncing && !showProgress && (
          <div
            className="onboarding-flow__recovery onboarding-flow__live-sync"
            data-figma-frame="715:3596"
          >
            <div className="onboarding-flow__copy">
              <h1 ref={title} tabIndex={-1}>
                Syncing your projects
              </h1>
              <p>You can explore Orka while the remaining projects sync.</p>
            </div>
            <div className="onboarding-flow__sync-status" aria-live="polite">
              {projects.map((project) => (
                <div key={project.path}>
                  <strong>{project.name}</strong>
                  <span>
                    {project.status === "synced"
                      ? "Synced"
                      : project.status === "error"
                        ? "Needs attention"
                        : project.status
                          ? "Syncing"
                          : "Queued"}
                  </span>
                </div>
              ))}
            </div>
            <div className="onboarding-flow__project-progress">
              <progress
                aria-label="Projects synced"
                value={synced}
                max={projects.length || 1}
              />
              <span>
                {synced} of {projects.length} projects synced
              </span>
            </div>
            <p className="onboarding-flow__keep-open">
              Keep Orka open until syncing finishes.
            </p>
            <div className="onboarding-flow__recovery-actions">
              <Button onClick={() => setShowProgress(true)}>
                View sync progress
              </Button>
              <Button variant="primary" disabled={busy} onClick={flow.complete}>
                Continue to Orka
              </Button>
            </div>
          </div>
        )}
        {(step === "review" ||
          (syncing && showProgress) ||
          step === "ready" ||
          step === "background") && (
          <>
            {header(
              "Sync Project",
              "Choose what to sync across your selected projects.",
              "sync-folders.png",
            )}
            <div className="onboarding-flow__sync">{syncChoices}</div>
          </>
        )}
        <RecoveryStep flow={flow} headingRef={title} />
        {step === "invite" && (
          <>
            {header(
              "Invite teammates",
              "Create an invite for each teammate you want to add. You can also do this later.",
              "invite-teammates.png",
            )}
            <div className="onboarding-flow__invitations">
              {projects
                .filter((p) =>
                  state.projects.some(
                    (actual) =>
                      actual.id === p.projectId && actual.role === "owner",
                  ),
                )
                .map((project) => (
                  <div
                    className="onboarding-flow__invite-row"
                    key={project.path}
                  >
                    <img
                      src={onboardingAsset("invite-folder.svg")}
                      width={16}
                      height={16}
                      alt=""
                    />
                    <span className="onboarding-flow__project-details">
                      <strong>{project.name}</strong>
                      <small title={project.path}>{project.displayPath}</small>
                    </span>
                    <Button
                      size="sm"
                      disabled={busy}
                      aria-disabled={busy || Boolean(flow.copyingInvite)}
                      aria-busy={flow.copyingInvite === project.projectId}
                      title="Create a one-use invite that expires in 24 hours"
                      onClick={() => {
                        if (project.projectId)
                          void flow.invite(project.projectId);
                      }}
                    >
                      <Icon
                        icon={
                          flow.copied === project.projectId
                            ? CheckIcon
                            : CopyIcon
                        }
                        size="sm"
                      />
                      {flow.copied === project.projectId
                        ? "Copied"
                        : "Copy invite"}
                    </Button>
                  </div>
                ))}
              {actions(() => go("ready"), "Go to Dashboard", flow.complete)}
            </div>
          </>
        )}
        <div className="onboarding-flow__error">
          <OnboardingError>
            {step === "background" ? "" : error}
          </OnboardingError>
        </div>
      </section>
      <Dialog.Root
        open={progressOpen}
        onOpenChange={(open) => {
          if (!open && step !== "scanning") setShowProgress(false);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="onboarding-flow__overlay onboarding-flow__overlay--progress" />
          <Dialog.Content
            className={`onboarding-flow__progress-modal${step === "ready" ? " onboarding-flow__progress-modal--complete" : ""}`}
            aria-describedby={undefined}
            onEscapeKeyDown={(event) => {
              if (step === "scanning") event.preventDefault();
            }}
            onPointerDownOutside={(event) => event.preventDefault()}
          >
            {step === "ready" ? (
              <div className="onboarding-flow__success-icon">
                <img
                  src={onboardingAsset("sync-complete.svg")}
                  width={24}
                  height={24}
                  alt=""
                />
              </div>
            ) : (
              <div
                className={`onboarding-flow__loading-blocks${syncing ? " onboarding-flow__loading-blocks--syncing" : ""}`}
                aria-hidden="true"
              >
                <span />
                <span />
                <span />
              </div>
            )}
            <div className="onboarding-flow__progress-content">
              <div
                className={`onboarding-flow__progress-bar${step !== "ready" ? " onboarding-flow__progress-bar--indeterminate" : ""}`}
                role="progressbar"
                aria-label={
                  step === "scanning" ? "Finding projects" : "Syncing projects"
                }
                aria-valuenow={step === "ready" ? 100 : undefined}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <span />
              </div>
              <Dialog.Title asChild>
                <h2>
                  {step === "scanning"
                    ? "Fetching your projects"
                    : step === "ready"
                      ? reviewPending
                        ? "Projects connected"
                        : "Sync Complete"
                      : "Syncing your projects"}
                </h2>
              </Dialog.Title>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root
        open={step === "background"}
        onOpenChange={(open) => {
          if (!open) flow.background(false);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="onboarding-flow__overlay onboarding-flow__overlay--background" />
          <Dialog.Content
            className="onboarding-flow__background-modal"
            onPointerDownOutside={(e) => e.preventDefault()}
            onEscapeKeyDown={(e) => {
              if (busy) e.preventDefault();
            }}
          >
            <img
              className="onboarding-flow__background-illustration"
              src={onboardingAsset("background-sync-illustration@2x.png")}
              width={418}
              height={232}
              alt=""
              aria-hidden="true"
            />
            <div className="onboarding-flow__background-body">
              <div>
                <Dialog.Title>Keep projects synced</Dialog.Title>
                <Dialog.Description>
                  Sync changes even when Orka isn’t open.
                </Dialog.Description>
              </div>
              <div className="onboarding-flow__background-actions">
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => flow.background(true)}
                >
                  Enable background sync
                </Button>
                <Button disabled={busy} onClick={() => flow.background(false)}>
                  Not now
                </Button>
              </div>
              <OnboardingError>{error}</OnboardingError>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </main>
  );
}
