import {
  hasConnectedSource,
  repositoryLabel,
} from "./components/project-sources.js";
import React, {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { motion, useReducedMotion } from "motion/react";
import { spring } from "./lib/springs.js";
import { ENV_ENABLED, visibleRequest } from "./lib/features.js";
import { invoke } from "@tauri-apps/api/core";
import type { Resource } from "@portable/protocol";
import type { ProjectPage, ProjectResource } from "./types.js";
import {
  MembersPage,
  type ManagementSection,
} from "./components/members-page.js";
import { RequestAccess } from "./components/request-access.js";
import { GovernanceDialog } from "./components/governance-dialog.js";
import { Button } from "./components/button.js";
import { ProjectHome } from "./components/project-home.js";
import {
  ProjectNavigation,
  projectLabel,
} from "./components/project-navigation.js";
import {
  FolderConnectionPrompt,
  ProjectEmptyState,
  ProjectSetupDialog,
} from "./components/project-setup.js";
import { ResourceIndex } from "./components/resource-index.js";
import { RepositoryConnections } from "./components/repository-connections.js";
import { useBackgroundRepositoryAccess } from "./components/use-repositories.js";
import { RepositoryFilter } from "./components/repository-filter.js";
import { GlobalSkillImport } from "./components/global-skill-import.js";
import { useProjectSkillUsage } from "./components/skill-usage.js";
import {
  resourceDisplayTitle,
  displayText,
  sessionFallbackTitle,
} from "./components/resource-presentation.js";
import {
  SettingsModal,
  type SettingsNavigationHandle,
} from "./components/settings/settings-modal.js";
import type { SettingsSection } from "./components/settings/settings-navigation.js";
import { SidebarQuickAccess } from "./components/sidebar-quick-access.js";
import { Onboarding } from "./components/onboarding/onboarding.js";
import { onboardingCommand } from "./components/onboarding/use-onboarding.js";
import { SignInForm } from "./components/sign-in-form.js";
import { SyncMenu } from "./components/sync-menu.js";
import {
  SidebarUpdate,
  useDesktopUpdates,
} from "./components/desktop-updates.js";
import { WorkspaceHeader } from "./components/workspace-header.js";
import { countSyncIssues, groupSyncIssues } from "./components/sync-issues.js";
import { useDeepLinks } from "./components/use-deep-links.js";
import { parseProjectInvite } from "./components/project-invite.js";
import { useIndexFilters } from "./components/use-index-filters.js";
import { useResourceView } from "./components/use-resource-view.js";
import {
  useSkillSummaries,
  skillSummaryKey,
} from "./components/use-skill-summaries.js";
import { useSessionTitles } from "./components/use-session-titles.js";
import { useWorkspace } from "./components/use-workspace.js";
import { useAccount } from "./components/use-account.js";
import { MemberNamesProvider } from "./components/member-names.js";
import { LoadingProvider } from "./components/loading-region.js";
import {
  connectProject,
  useProjectSetup,
} from "./components/use-project-setup.js";
import {
  ToastProvider,
  ToastViewport,
  useToastNavigation,
  useToastNotice,
  useToasts,
} from "./components/toasts.js";

const EnvPage = lazy(() =>
  import("./components/env/env-page.js").then(({ EnvPage }) => ({
    default: EnvPage,
  })),
);
const ResourceDetail = lazy(() =>
  import("./components/resource-detail.js").then(({ ResourceDetail }) => ({
    default: ResourceDetail,
  })),
);

const pageLabels: Record<ProjectPage, string> = {
  home: "home",
  env: "ENVs",
  members: "Manage",
  memory: "memories",
  skill: "skills",
  session: "sessions",
  plan: "plans",
};

export function App() {
  const workspace = useWorkspace();
  return (
    <LoadingProvider
      scope={JSON.stringify([
        workspace.state.profile,
        workspace.state.user,
        workspace.state.config?.apiUrl,
      ])}
    >
      <ToastProvider
        scope={JSON.stringify([
          workspace.state.profile,
          workspace.state.user,
          workspace.state.config?.apiUrl,
          workspace.project,
        ])}
      >
        <MemberNamesProvider
          state={workspace.state}
          projectId={workspace.project}
        >
          <WorkspaceApp workspace={workspace} />
        </MemberNamesProvider>
      </ToastProvider>
    </LoadingProvider>
  );
}

function WorkspaceApp({
  workspace,
}: {
  workspace: ReturnType<typeof useWorkspace>;
}) {
  const {
    state,
    project,
    setProject,
    error,
    setError,
    busy,
    act,
    run,
    refresh,
    refreshError,
    errorFeedback,
    actionNotice,
  } = workspace;
  const { notify } = useToasts();
  const updates = useDesktopUpdates();
  const account = useAccount(state.config);
  const workspaceScope = JSON.stringify([
    state.profile,
    state.user,
    state.config?.apiUrl,
  ]);
  useBackgroundRepositoryAccess(state);
  const [repositorySetup, setRepositorySetup] = useState("");
  const setup = useProjectSetup(
    setProject,
    setError,
    state.config?.apiUrl,
    (id) => setRepositorySetup(id),
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const reducedMotion = useReducedMotion();
  const [sidebarInstant, setSidebarInstant] = useState(false);
  const [tab, setTab] = useState<ProjectPage>("home");
  const [envSet, setEnvSet] = useState("");
  const [resource, setResource] = useState("");
  // The resource whose reading view Back just closed; its index row takes focus.
  const [returnFocus, setReturnFocus] = useState("");
  const clearReturnFocus = useCallback(() => setReturnFocus(""), []);
  const [settings, setSettings] = useState<SettingsSection | null>(null);
  const settingsNavigation = useRef<SettingsNavigationHandle>(null);
  const leaveSettings = (action: () => void) => {
    if (settings && settingsNavigation.current)
      settingsNavigation.current.requestExit(() => {
        setSettings(null);
        action();
      });
    else action();
  };
  const openSettings = (section: SettingsSection) => {
    if (settingsNavigation.current)
      settingsNavigation.current.requestSection(section);
    else setSettings(section);
  };
  const [syncOpen, setSyncOpen] = useState(false);
  const [managementSection, setManagementSection] =
    useState<Exclude<ManagementSection, "members">>("requests");
  const [governance, setGovernance] = useState<{
    resource: string;
    env?: { title: string };
  } | null>(null);
  const openManagement = useCallback(
    (section: ManagementSection = "members") => {
      if (section === "members") {
        if (settingsNavigation.current)
          settingsNavigation.current.requestSection("members");
        else setSettings("members");
        return;
      }
      setManagementSection(section);
      setSettings(null);
      setTab("members");
      setResource("");
    },
    [],
  );
  useToastNavigation(
    useCallback(
      (destination) => {
        if (destination === "env" && !ENV_ENABLED) return;
        const navigate = () => {
          setSettings(null);
          setGovernance(null);
          if (destination === "requests") openManagement("requests");
          else if (destination === "sync") setSyncOpen(true);
          else setTab("env");
        };
        if (settingsNavigation.current)
          settingsNavigation.current.requestExit(navigate);
        else navigate();
      },
      [openManagement],
    ),
  );
  const setNotice = useToastNotice();
  useEffect(() => {
    if (actionNotice) setNotice(actionNotice.title);
  }, [actionNotice, setNotice]);
  const index = useIndexFilters(JSON.stringify([workspaceScope, project]));
  const selectedProject = state.projects.find((p) => p.id === project);
  const repositorySetupProject = state.projects.find(
    (item) => item.id === repositorySetup,
  );
  const unconnectedRepositories =
    repositorySetupProject?.sources?.filter(
      (source) =>
        source.repository &&
        (!source.path || source.folderState === "reconnect"),
    ) ?? [];
  const alreadyConnectedRepositories = Boolean(
    repositorySetupProject?.sources?.some((source) => source.repository) &&
    unconnectedRepositories.length === 0,
  );
  useEffect(() => {
    if (alreadyConnectedRepositories) setRepositorySetup("");
  }, [alreadyConnectedRepositories]);
  const repositories = selectedProject?.sources ?? [];
  const repository = repositories.some(
    (source) => source.id === index.repository,
  )
    ? index.repository
    : "all";
  const projectPath = selectedProject?.path;
  const catalogResources = useMemo<ProjectResource[]>(() => {
    const sharedIds = new Set(
      state.resources
        .filter((item) => !item.deleted)
        .map((item) => item.resourceId),
    );
    return [
      ...state.resources,
      ...(state.localSkills ?? []).filter(
        (item) => !sharedIds.has(item.resourceId),
      ),
    ].map((item) => ({
      ...item,
      repositoryName: repositoryLabel(
        state.projects.find((project) => project.id === item.projectId)
          ?.sources ?? [],
        item.sourceId,
      ),
    }));
  }, [state.resources, state.localSkills, state.projects]);
  const resources = useMemo(
    () =>
      catalogResources.filter(
        (r) => r.projectId === project && r.kind === tab && !r.deleted,
      ),
    [catalogResources, project, tab],
  );
  const sessionTitles = useSessionTitles(resources, tab === "session");
  const skillSummaries = useSkillSummaries(resources);
  const skillUsage = useProjectSkillUsage(
    project,
    JSON.stringify([workspaceScope, projectPath]),
    resources,
    tab === "skill" &&
      Boolean(state.user && selectedProject) &&
      resources.length > 0,
  );
  const displayTitle = useCallback(
    (item: Resource) =>
      displayText(
        item.kind === "session"
          ? sessionFallbackTitle(
              sessionTitles.previews[item.resourceId]?.title || item.title,
            )
          : (item.kind === "skill" &&
              skillSummaries[skillSummaryKey(item)]?.name) ||
              resourceDisplayTitle(item.title, projectPath),
      ),
    [sessionTitles.previews, skillSummaries, projectPath],
  );
  const duplicateTitles = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of resources) {
      const title = displayTitle(item).toLocaleLowerCase();
      counts.set(title, (counts.get(title) ?? 0) + 1);
    }
    return new Set(
      [...counts].filter(([, count]) => count > 1).map(([title]) => title),
    );
  }, [resources, displayTitle]);
  const conflicted = useMemo(
    () => new Set(state.conflicts.map((c) => c.resourceId)),
    [state.conflicts],
  );
  const selected = catalogResources.find(
    (r) => r.resourceId === resource && r.projectId === project && !r.deleted,
  );
  const view = useResourceView(
    resource,
    state.user ? selected : undefined,
    state.conflicts,
    JSON.stringify([
      state.profile,
      state.user,
      state.config?.apiUrl,
      state.deviceId,
    ]),
  );
  useDeepLinks((link) => {
    if (link.hostname === "auth") {
      void act(() => account.complete(link.href));
      return;
    }
    const navigate = () => {
      if (link.hostname === "join") {
        try {
          parseProjectInvite(link.href);
          setup.show("join", link.href);
        } catch (error) {
          setError(String(error));
        }
      }
      if (link.hostname === "env") {
        if (!ENV_ENABLED) return;
        const [id, setId] = link.pathname.split("/").filter(Boolean);
        if (id) {
          index.setRepository("all");
          setProject(id);
          setTab("env");
          setEnvSet(setId ?? "");
          setResource("");
        }
      }
      if (link.hostname === "project") {
        const [id, resourceId] = link.pathname.split("/").filter(Boolean);
        index.setRepository("all");
        setProject(id);
        if (resourceId) setResource(resourceId);
        else {
          // A project-only link must not re-open a detail from the previous project.
          setResource("");
          view.setPreview("");
        }
      }
    };
    if (settingsNavigation.current)
      settingsNavigation.current.requestExit(() => {
        setSettings(null);
        navigate();
      });
    else navigate();
  }, !busy);
  const selectedKind = selected?.kind;
  useEffect(() => {
    if (selectedKind) setTab(selectedKind);
  }, [selectedKind]);
  useEffect(() => {
    if (!error || !state.user || setup.dialog) return;
    notify({
      title: errorFeedback?.errorTitle ?? "Couldn’t complete this action",
      kind: "error",
      action: errorFeedback?.retry
        ? {
            label: "Try again",
            onClick: () => void act(errorFeedback.retry!, errorFeedback),
          }
        : { label: "View details", onClick: () => setSyncOpen(true) },
    });
  }, [error, errorFeedback, state.user, setup.dialog, notify, act]);
  const conflicts = useMemo(
    () =>
      state.conflicts.filter((c) =>
        state.resources.some(
          (r) => r.resourceId === c.resourceId && r.projectId === project,
        ),
      ),
    [state.conflicts, state.resources, project],
  );
  const sessionNotifications = useMemo(
    () =>
      state.activity.filter(
        (item) =>
          item.notifyOwner === state.user &&
          state.resources.some(
            (r) => r.projectId === project && r.resourceId === item.copyId,
          ),
      ),
    [state.activity, state.resources, state.user, project],
  );
  const issues = useMemo(
    () =>
      groupSyncIssues(
        { errors: state.errors, resources: state.resources },
        project,
        selectedProject ? projectLabel(selectedProject) : undefined,
      ),
    [state.errors, state.resources, project, selectedProject],
  );
  if (!state.user)
    return (
      <SignInForm
        account={account}
        busy={busy}
        error={error || refreshError}
        act={act}
        invite={
          setup.dialog === "join"
            ? { serviceUrl: setup.inviteService, onCancel: setup.close }
            : undefined
        }
      />
    );
  if (state.onboarding?.active && setup.dialog !== "join")
    return (
      <Onboarding
        key={`${state.profile}:${state.user}:${state.config?.apiUrl}`}
        state={state}
        refresh={refresh}
        onComplete={setProject}
      />
    );
  const openResource = (id: string) => {
    if (
      repository !== "all" &&
      catalogResources.find((item) => item.resourceId === id)?.sourceId !==
        repository
    )
      index.setRepository("all");
    setResource(id);
    view.setChanges(false);
  };
  const closeDetail = () => {
    setReturnFocus(resource);
    setResource("");
    view.setPreview("");
  };
  const resourceLabel = pageLabels[tab];
  const collectionLabel =
    resourceLabel.charAt(0).toUpperCase() + resourceLabel.slice(1);
  const accessRequest =
    selectedProject &&
    (tab === "memory" ||
      tab === "skill" ||
      tab === "plan" ||
      tab === "session") ? (
      <RequestAccess
        key={`${project}:${tab}`}
        project={selectedProject}
        kind={tab}
        state={state}
        onRefresh={refresh}
        className="resource-access-request"
      />
    ) : undefined;
  return (
    <div className="app">
      <motion.aside
        initial={false}
        animate={{ width: sidebarCollapsed ? 64 : 240 }}
        transition={
          sidebarInstant || reducedMotion
            ? { duration: 0 }
            : sidebarCollapsed
              ? spring.slow.exit
              : spring.slow
        }
        className={`sidebar${sidebarCollapsed ? " sidebar-collapsed" : ""}`}
        data-motion={sidebarInstant ? "instant" : undefined}
      >
        <ProjectNavigation
          collapsed={sidebarCollapsed}
          projects={state.projects}
          projectId={project}
          activeKind={settings ? null : tab}
          resources={catalogResources}
          onProjectChange={(id) => {
            const change = () => {
              setEnvSet("");
              setProject(id);
              setResource("");
              setGovernance(null);
            };
            if (settings && settingsNavigation.current)
              settingsNavigation.current.requestProject(id, change);
            else change();
          }}
          onNavigate={(kind) =>
            leaveSettings(() => {
              setEnvSet("");
              setTab(kind);
              setResource("");
              if (kind === "members") openManagement();
            })
          }
        />
        <div className="sidebar-footer">
          {updates?.update && (
            <SidebarUpdate
              key={updates.update.sha256}
              update={updates.update}
              collapsed={sidebarCollapsed}
            />
          )}
          <SidebarQuickAccess
            settingsActive={Boolean(settings)}
            collapsed={sidebarCollapsed}
            onSettings={() => openSettings("general")}
            onCreate={() => leaveSettings(() => setup.show("create"))}
            onJoin={() => leaveSettings(() => setup.show("join"))}
          />
        </div>
      </motion.aside>
      <main>
        <WorkspaceHeader
          title={
            settings
              ? "Settings"
              : selectedProject
                ? collectionLabel
                : "Your projects"
          }
          instant={sidebarInstant}
          collapsed={sidebarCollapsed}
          onToggle={(instant) => {
            setSidebarInstant(instant);
            setSidebarCollapsed((current) => !current);
          }}
          repositoryFilter={
            selectedProject &&
            repositories.length > 1 &&
            tab !== "home" &&
            tab !== "members" ? (
              <RepositoryFilter
                key={`${workspaceScope}:${project}`}
                repositories={repositories}
                value={repository}
                onChange={(value) => {
                  index.setRepository(value);
                  setResource("");
                }}
              />
            ) : undefined
          }
          status={
            <SyncMenu
              placement="header"
              open={syncOpen}
              onOpenChange={setSyncOpen}
              key={project}
              canConnect={Boolean(selectedProject)}
              state={state}
              issues={issues}
              issueCount={countSyncIssues(issues, state)}
              conflicts={conflicts}
              notifications={sessionNotifications}
              reviewRequests={(state.reviewRequests ?? []).filter(
                (r) => r.projectId === project && r.unread && visibleRequest(r),
              )}
              localUpdates={
                state.bindings.filter(
                  (b) =>
                    b.base?.projectId === project &&
                    [
                      "review_pending",
                      "update_available",
                      "locally_modified",
                    ].includes(b.installationState ?? ""),
                ).length
              }
              privateDrafts={
                (state.drafts ?? []).filter(
                  (d) =>
                    d.projectId === project &&
                    d.status === "local" &&
                    !d.automaticSharing,
                ).length
              }
              onReview={() => leaveSettings(() => openManagement("requests"))}
              busy={busy}
              actionError={error || refreshError}
              onDismissError={error ? () => setError("") : undefined}
              onSync={() =>
                void act(() => invoke("sync_now"), {
                  successTitle: "Sync requested",
                  kind: "queued",
                  errorTitle: "Couldn’t request sync",
                })
              }
              onRetry={() =>
                void act(() => invoke("retry_uploads"), {
                  successTitle: "Upload retry requested",
                  kind: "queued",
                  errorTitle: "Couldn’t retry uploads",
                })
              }
              onResumeSetup={() =>
                void act(
                  () =>
                    onboardingCommand(
                      "resume-setup",
                      {},
                      { user: state.user, service: state.config?.apiUrl },
                    ),
                  { errorTitle: "Couldn’t reopen project setup" },
                )
              }
              onSettings={() => openSettings("sync")}
              onConnect={() => void act(() => connectProject(project))}
              onOpen={(id) =>
                leaveSettings(() => {
                  openResource(id);
                  setTab("session");
                })
              }
            />
          }
        />
        {settings ? (
          <SettingsModal
            ref={settingsNavigation}
            key={workspaceScope}
            state={state}
            initialProjectId={project}
            initialSection={settings}
            onSectionChange={setSettings}
            onManage={(id, section) => {
              setProject(id);
              setSettings(null);
              openManagement(section);
            }}
            busy={busy}
            run={run}
            onSyncActivity={(id) => {
              setProject(id);
              setResource("");
              setEnvSet("");
              setTab("home");
              setSettings(null);
              setSyncOpen(true);
            }}
            onSignedOut={() => {
              setSettings(null);
              setResource("");
              setEnvSet("");
              setTab("home");
            }}
            onClose={() => {
              setSettings(null);
              requestAnimationFrame(() =>
                document
                  .querySelector<HTMLButtonElement>(
                    '.sidebar-bottom button[aria-label="Settings"]',
                  )
                  ?.focus(),
              );
            }}
          />
        ) : !selectedProject ? (
          <ProjectEmptyState
            onCreate={() => leaveSettings(() => setup.show("create"))}
            onJoin={() => leaveSettings(() => setup.show("join"))}
          />
        ) : (
          <>
            {!hasConnectedSource(selectedProject) && (
              <FolderConnectionPrompt
                projectName={projectLabel(selectedProject)}
                busy={busy}
                repositories={selectedProject.sources?.some(
                  (source) => source.repository,
                )}
                onConnect={() =>
                  selectedProject.sources?.some((source) => source.repository)
                    ? openSettings("general")
                    : void act(() => connectProject(project))
                }
              />
            )}
            <Suspense
              fallback={
                <p className="content-message" role="status">
                  Loading…
                </p>
              }
            >
              {tab === "members" ? (
                <MembersPage
                  key={project}
                  project={selectedProject}
                  state={state}
                  section={managementSection}
                  onSection={openManagement}
                  onRefresh={refresh}
                  onReviewFile={(resource) => setGovernance({ resource })}
                />
              ) : tab === "env" ? (
                <EnvPage
                  onSettings={() => openSettings("sharing")}
                  onGovernance={(resource, title) =>
                    setGovernance({ resource, env: { title } })
                  }
                  key={`${state.user}:${project}:${envSet}`}
                  project={selectedProject}
                  user={state.user!}
                  initialSet={envSet}
                  repository={repository}
                />
              ) : tab === "home" ? (
                <ProjectHome
                  project={selectedProject}
                  user={state.user}
                  resources={catalogResources}
                  onNavigate={(kind) => {
                    index.setRepository("all");
                    setEnvSet("");
                    setTab(kind);
                    setResource("");
                  }}
                  onOpen={(item) => {
                    setTab(item.kind);
                    openResource(item.resourceId);
                  }}
                />
              ) : selected ? (
                <ResourceDetail
                  key={`${workspaceScope}:${selected.resourceId}`}
                  scope={workspaceScope}
                  accessRequest={accessRequest}
                  resource={selected}
                  displayTitle={displayTitle(selected)}
                  project={selectedProject}
                  user={state.user}
                  deviceId={state.deviceId}
                  busy={busy}
                  conflicts={conflicts}
                  view={view}
                  act={act}
                  onBack={closeDetail}
                  onGovernance={() =>
                    selected.local
                      ? openManagement("requests")
                      : setGovernance({ resource: selected.resourceId })
                  }
                  onNotice={setNotice}
                  onError={setError}
                />
              ) : (
                <ResourceIndex
                  key={`${workspaceScope}:${project}:${tab}`}
                  floatingAction={
                    tab === "skill" ? (
                      <GlobalSkillImport
                        key={`${workspaceScope}:${project}`}
                        project={selectedProject}
                        busy={busy}
                        run={run}
                        onReview={() => openManagement("requests")}
                      />
                    ) : undefined
                  }
                  accessRequest={accessRequest}
                  skillSummaries={skillSummaries}
                  skillUsage={tab === "skill" ? skillUsage : undefined}
                  kind={tab}
                  resources={resources}
                  filters={{ ...index.filters[tab], repository }}
                  onFilters={(next) => index.set(tab, next)}
                  user={state.user}
                  displayTitle={displayTitle}
                  duplicateTitles={duplicateTitles}
                  conflicted={conflicted}
                  connected={hasConnectedSource(selectedProject)}
                  noAccess={Boolean(
                    selectedProject.governed &&
                    selectedProject.role !== "owner" &&
                    state.governance?.find((item) => item.projectId === project)
                      ?.catalog.access[tab]?.mode === "hidden",
                  )}
                  loading={sessionTitles.loading}
                  status={
                    sessionTitles.unavailable && !sessionTitles.loading ? (
                      <div className="session-preview-status" role="status">
                        <span>Some session titles are unavailable.</span>
                        <Button
                          size="sm"
                          variant="tertiary"
                          onClick={sessionTitles.retry}
                        >
                          Retry
                        </Button>
                      </div>
                    ) : null
                  }
                  focusResource={returnFocus}
                  onFocusHandled={clearReturnFocus}
                  onOpen={openResource}
                />
              )}
            </Suspense>
          </>
        )}
        <ToastViewport />
      </main>
      {repositorySetupProject && !alreadyConnectedRepositories && (
        <RepositoryConnections
          key={`${workspaceScope}:${repositorySetup}`}
          project={repositorySetupProject}
          state={state}
          refresh={refresh}
          initiallyOpen
          dialogOnly
          initialSource={
            unconnectedRepositories.length === 1
              ? unconnectedRepositories[0]
              : undefined
          }
          onClose={() => setRepositorySetup("")}
          onConnecting={() => openSettings("general")}
        />
      )}
      {setup.dialog && (
        <ProjectSetupDialog
          mode={setup.dialog}
          repositoryEnabled={setup.repositoryEnabled}
          sourceMode={setup.sourceMode}
          onSourceMode={setup.setSourceMode}
          value={setup.input}
          selection={setup.selection}
          run={(action) => void act(action)}
          sharing={setup.sharing}
          onSharingChange={setup.setSharing}
          busy={busy}
          error={error}
          onChange={setup.setInput}
          onClose={setup.close}
          onSubmit={() => void act(setup.submit)}
          inviteService={setup.inviteService}
          serviceMismatch={setup.serviceMismatch}
          onSwitchService={() =>
            void act(() => account.switchService(setup.inviteService))
          }
        />
      )}
      {governance !== null && selectedProject && (
        <GovernanceDialog
          key={project}
          project={selectedProject}
          state={state}
          initialResource={governance.resource}
          initialEnv={governance.env}
          onClose={() => setGovernance(null)}
          onRefresh={refresh}
        />
      )}
    </div>
  );
}
