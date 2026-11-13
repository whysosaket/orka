import React, { useEffect, useEffectEvent, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Button } from "../button.js";
import { TextField } from "../text-field.js";
import { Icon } from "../icon.js";
import {
  ArrowRightIcon,
  PersonAddIcon,
  FileDirectoryIcon,
} from "@primer/octicons-react";
import { PermissionSelect } from "../permission-select.js";
import { SharingModeSelect } from "../project-sharing.js";
import { OnboardingError, onboardingAsset } from "../onboarding-auth-layout.js";
import type { Snapshot } from "../../types.js";
import { AuthRecovery } from "../auth-recovery.js";
import { ProfileStep } from "./profile-step.js";
import { RecoveryStep } from "./recovery-step.js";
import {
  destinationCandidates,
  frameForStep,
  suggestedSource,
  type OnboardingStep,
} from "./model.js";
import { useOnboarding } from "./use-onboarding.js";
import { ProjectInviteDialog } from "../project-invite-dialog.js";
import "./onboarding.css";
import { RepositoryOnboarding } from "../repository-onboarding.js";
import { useRepositoryCommand } from "../repository-connections.js";

const descriptions = {
  memory: ["Memories", "Project instructions and knowledge."],
  session: ["Sessions", "Codex and Claude conversations."],
  plan: ["Plans", "Saved files and conversation plans."],
  skill: ["Skills", "Reusable instructions and files."],
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
  const repositoryCall = useRepositoryCommand(state);
  const [repositoryEnabled, setRepositoryEnabled] = useState(false);
  const [githubSetup, setGithubSetup] = useState(false);
  useEffect(() => {
    let canceled = false;
    void repositoryCall<{ enabled: boolean }>("capabilities")
      .then((value) => {
        if (!canceled) setRepositoryEnabled(value.enabled);
      })
      .catch(() => {});
    return () => {
      canceled = true;
    };
  }, [repositoryCall]);
  const [showProgress, setShowProgress] = useState(true);
  const [inviteProject, setInviteProject] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [search, setSearch] = useState("");
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
  const query = search.trim().toLowerCase();
  const visibleProjects = draft.projects.filter((p) =>
    [p.name, p.path, p.displayPath].some((value) =>
      value?.toLowerCase().includes(query),
    ),
  );
  const visiblePaths = visibleProjects
    .filter((p) => p.readable !== false)
    .map((p) => p.path);
  const needsChoice = projects.some(({ path, name }) => {
    if (draft.matches?.[path]?.connectedId) return false;
    const candidates = destinationCandidates(draft, path);
    const choice = draft.choices?.[path];
    if (candidates.length && !choice) return true;
    const project = candidates.find((p) => p.id === choice);
    return Boolean(
      (project?.sources?.filter((source) => !source.removedAt).length ?? 0) >
        1 && !(draft.sourceChoices?.[path] || suggestedSource(project, name)),
    );
  });
  const synced = projects.filter(
    (project) => project.status === "synced",
  ).length;
  const syncStage = projects.some(
    (p) => p.status === "connecting" || p.status === "creating",
  )
    ? "Connecting project folders"
    : projects.some((p) => p.status === "scanning")
      ? "Checking local resources"
      : "Syncing selected resources";
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
  if (githubSetup && repositoryEnabled)
    return (
      <RepositoryOnboarding
        state={state}
        refresh={refresh}
        onBack={() => setGithubSetup(false)}
        onComplete={flow.completeProject}
      />
    );
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
      {step === "review" && (
        <div
          className="onboarding-flow__destinations"
          aria-label="Project destinations"
        >
          {projects.map(({ path, displayPath, name }) => {
            const match = draft.matches?.[path];
            const choice = draft.choices?.[path] ?? "";
            const candidates = destinationCandidates(draft, path);
            const project = candidates.find((p) => p.id === choice);
            const suggestion = candidates.find(
              (p) => p.id === match?.suggestedId,
            );
            const destinations = suggestion
              ? [suggestion, ...candidates.filter((p) => p !== suggestion)]
              : candidates;
            const sources = (project?.sources ?? []).filter(
              (source) => !source.removedAt,
            );
            return (
              <div className="onboarding-flow__match" key={path}>
                <div className="onboarding-flow__project-details">
                  <strong>{name}</strong>
                  <small title={path}>{displayPath}</small>
                </div>
                {match?.connectedId || !destinations.length ? (
                  <p>
                    {match?.connectedId
                      ? `Connected to ${project?.name ?? match.connectedName ?? "an existing project"}`
                      : `Create a project named ${name}`}
                  </p>
                ) : (
                  <PermissionSelect
                    label={`Connect ${name} to project`}
                    placeholder="Choose an Orka project"
                    value={choice}
                    disabled={busy}
                    options={[
                      ...destinations.map((p) => ({
                        value: p.id,
                        label:
                          p.id === match?.suggestedId
                            ? `${p.name} · Suggested match`
                            : `${p.name} · ${p.role === "owner" ? "Owner" : "Member"}`,
                      })),
                      { value: "new", label: "Create a separate project" },
                    ]}
                    onChange={(id) => flow.setProjectChoice(path, id)}
                  />
                )}
                {sources.length > 1 && !match?.connectedId && (
                  <PermissionSelect
                    label={`Repository for ${name}`}
                    placeholder="Choose a repository"
                    value={
                      draft.sourceChoices?.[path] ||
                      suggestedSource(project, name) ||
                      ""
                    }
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
        </div>
      )}
      <div className="onboarding-flow__sharing-list">
        {(
          Object.entries(descriptions) as [
            keyof typeof descriptions,
            string[],
          ][]
        ).map(([kind, [name, description]]) => (
          <div className="onboarding-flow__sharing-row" key={kind}>
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
            <SharingModeSelect
              label={name}
              enabled={draft.sharing[kind]}
              disabled={
                busy || syncing || step === "ready" || step === "background"
              }
              onChange={(enabled) => flow.setSharing(kind, enabled)}
            />
          </div>
        ))}
      </div>
      {needsChoice && step === "review" && (
        <p className="onboarding-flow__setup-note">
          Choose a destination and repository where required to start syncing.
        </p>
      )}
      {actions(
        () => go("select"),
        syncing ? "Syncing…" : step === "review" ? "Start Syncing" : "Continue",
        () =>
          step === "review"
            ? flow.sync()
            : go(state.background ? "invite" : "background"),
        syncing || needsChoice,
      )}
      {step === "review" && (
        <Button variant="tertiary" disabled={busy} onClick={flow.defer}>
          Set up later
        </Button>
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
                <Button
                  variant="tertiary"
                  disabled={busy || step === "scanning"}
                  onClick={flow.defer}
                >
                  Set up later
                </Button>
                {repositoryEnabled && (
                  <Button disabled={busy} onClick={() => setGithubSetup(true)}>
                    Connect a GitHub repository
                  </Button>
                )}
              </div>
            ) : (
              <div className="onboarding-flow__selection">
                <TextField
                  type="search"
                  aria-label="Search projects"
                  placeholder="Search by project name or folder"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
                <div className="onboarding-flow__selection-toolbar">
                  <span aria-live="polite">
                    {draft.selected.length} of {draft.projects.length} selected
                  </span>
                  <Button
                    size="sm"
                    disabled={busy || !visiblePaths.length}
                    onClick={() => flow.toggleVisible(visiblePaths)}
                  >
                    {visiblePaths.length > 0 &&
                    visiblePaths.every((path) => draft.selected.includes(path))
                      ? query
                        ? "Unselect visible"
                        : "Unselect all"
                      : query
                        ? "Select visible"
                        : "Select all"}
                  </Button>
                </div>
                <div className="onboarding-flow__project-list">
                  {visibleProjects.length === 0 && (
                    <p className="onboarding-flow__no-results">
                      No projects match this search.
                    </p>
                  )}
                  {visibleProjects.map((project) => (
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
                <Button variant="tertiary" disabled={busy} onClick={flow.defer}>
                  Set up later
                </Button>
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
              Keep Orka open until syncing finishes. You can follow progress in
              Sync.
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
                      title="Invite a teammate by email or joining link"
                      onClick={() => {
                        if (project.projectId)
                          setInviteProject({
                            id: project.projectId,
                            name: project.name,
                          });
                      }}
                    >
                      <Icon icon={PersonAddIcon} size="sm" />
                      Invite teammate
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
                className={`onboarding-flow__progress-bar${step === "scanning" ? " onboarding-flow__progress-bar--indeterminate" : ""}`}
                role="progressbar"
                aria-label={
                  step === "scanning" ? "Finding projects" : "Syncing projects"
                }
                aria-valuenow={step === "scanning" ? undefined : synced}
                aria-valuemin={0}
                aria-valuemax={
                  step === "scanning" ? undefined : projects.length || 1
                }
              >
                <span
                  style={
                    syncing
                      ? { width: `${(100 * synced) / (projects.length || 1)}%` }
                      : undefined
                  }
                />
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
              {syncing && (
                <p className="onboarding-flow__setup-note" role="status">
                  {syncStage} · {synced} of {projects.length} projects synced
                </p>
              )}
            </div>
            {syncing && (
              <div className="onboarding-flow__progress-actions">
                <Button onClick={() => setShowProgress(false)}>
                  View details
                </Button>
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={flow.complete}
                >
                  Continue to Orka
                </Button>
              </div>
            )}
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
      {step === "invite" && inviteProject && (
        <ProjectInviteDialog
          key={`${state.user}:${state.config?.apiUrl}:${inviteProject.id}`}
          projectId={inviteProject.id}
          projectName={inviteProject.name}
          onClose={() => setInviteProject(null)}
        />
      )}
    </main>
  );
}
