import {
  activeSources,
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
import { ResourceMenuProvider } from "./components/resource-menu.js";
import {
  hasNativeTextMenu,
  type ItemMenuAction,
} from "./components/item-menu.js";
import { ENV_ENABLED } from "./lib/features.js";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Overlay } from "./components/overlay.js";
import { SettingsUpdates } from "./components/settings/settings-updates.js";
import type { Resource } from "@portable/protocol";
import type { ProjectPage, ProjectResource } from "./types.js";
import {
  MembersPage,
  type ManagementSection,
} from "./components/members-page.js";
import { RequestAccess } from "./components/request-access.js";
import { GovernanceDialog } from "./components/governance-dialog.js";
import { SkillReviewOverlay } from "./components/skill-review-overlay.js";
import { Icon } from "./components/icon.js";
import { ArrowLeftIcon } from "@primer/octicons-react";
import { Button } from "./components/button.js";
import { ProjectHome } from "./components/project-home.js";
import {
  ProjectNavigation,
  ProjectPicker,
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
import { projectAttention } from "./components/sync-attention.js";
import { useDeepLinks } from "./components/use-deep-links.js";
import { parseProjectInvite } from "./components/project-invite.js";
import { useIndexFilters } from "./components/use-index-filters.js";
import { useResourceView } from "./components/use-resource-view.js";
import {
  useSkillSummaries,
  skillSummaryKey,
} from "./components/use-skill-summaries.js";
import { useSessionTitles } from "./components/use-session-titles.js";
import { useLocalResources } from "./components/use-local-resources.js";
import { resourceCatalog } from "./components/resource-catalog.js";
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
  useEffect(() => {
    const menu = (event: MouseEvent) => {
      if (!event.defaultPrevented && !hasNativeTextMenu(event.target))
        event.preventDefault();
    };
    document.addEventListener("contextmenu", menu);
    return () => document.removeEventListener("contextmenu", menu);
  }, []);
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
  const account = useAccount(state.config, !state.user);
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
  const [comparison, setComparison] = useState("");
  // The resource whose reading view Back just closed; its index row takes focus.
  const [returnFocus, setReturnFocus] = useState("");
  const clearReturnFocus = useCallback(() => setReturnFocus(""), []);
  const [settings, setSettings] = useState<SettingsSection | null>(null);
  const [settingsProject, setSettingsProject] = useState<string | null>(null);
  useEffect(() => {
    if (!settings) setSettingsProject(null);
  }, [settings]);
  const settingsNavigation = useRef<SettingsNavigationHandle>(null);
  const leaveSettings = (action: () => void) => {
    if (settings && settingsNavigation.current)
      settingsNavigation.current.requestExit(() => {
        setSettings(null);
        action();
      });
    else action();
  };
  const openProjectSettings = (id: string, section: SettingsSection) => {
    if (settings && settingsNavigation.current) {
      settingsNavigation.current.requestProject(id, () => {
        setSettingsProject(id);
        requestAnimationFrame(() =>
          settingsNavigation.current?.requestSection(section),
        );
      });
    } else {
      setSettingsProject(id);
      setSettings(section);
    }
  };
  const openSettings = (section: SettingsSection) => {
    if (settingsNavigation.current)
      settingsNavigation.current.requestSection(section);
    else setSettings(section);
  };
  const manualUpdateCheck = useRef(() => {});
  manualUpdateCheck.current = () => {
    openSettings("updates");
    void updates.check(true);
  };
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen("check-for-updates", () => manualUpdateCheck.current())
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);
  const [syncOpen, setSyncOpen] = useState(false);
  const [managementSection, setManagementSection] =
    useState<Exclude<ManagementSection, "members">>("requests");
  const [governance, setGovernance] = useState<{
    resource: string;
    mode?: "incoming" | "outgoing";
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
    activeSources(repositorySetupProject?.sources).filter(
      (source) =>
        source.repository &&
        (!source.path || source.folderState === "reconnect"),
    ) ?? [];
  const alreadyConnectedRepositories = Boolean(
    activeSources(repositorySetupProject?.sources).some(
      (source) => source.repository,
    ) && unconnectedRepositories.length === 0,
  );
  useEffect(() => {
    if (alreadyConnectedRepositories) setRepositorySetup("");
  }, [alreadyConnectedRepositories]);
  const repositories = activeSources(selectedProject?.sources);
  const repository = repositories.some(
    (source) => source.id === index.repository,
  )
    ? index.repository
    : "all";
  const projectPath = selectedProject?.path;
  const localCatalog = useLocalResources({
    scope: workspaceScope,
    project: selectedProject,
    page: tab,
    user: state.user,
    serviceOrigin: state.config?.apiUrl,
    syncMinutes: state.config?.syncMinutes,
  });
  const catalogResources = useMemo<ProjectResource[]>(
    () =>
      resourceCatalog(state.resources, [
        ...(state.localSkills ?? []),
        ...localCatalog.resources,
      ]).map((item) => ({
        ...item,
        repositoryName: repositoryLabel(
          state.projects.find((project) => project.id === item.projectId)
            ?.sources ?? [],
          item.sourceId,
        ),
      })),
    [
      state.resources,
      state.localSkills,
      localCatalog.resources,
      state.projects,
    ],
  );
  const resources = useMemo(
    () =>
      catalogResources.filter(
        (r) => r.projectId === project && r.kind === tab && !r.deleted,
      ),
    [catalogResources, project, tab],
  );
  const sessionTitles = useSessionTitles(
    resources,
    tab === "session",
    workspaceScope,
  );
  const skillSummaries = useSkillSummaries(resources, workspaceScope);
  const skillUsage = useProjectSkillUsage(
    project,
    workspaceScope,
    resources,
    tab === "skill" &&
      Boolean(state.user && selectedProject) &&
      resources.length > 0,
    JSON.stringify([selectedProject?.path, selectedProject?.sources]),
    state.config?.syncMinutes,
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
  useEffect(() => {
    if (comparison && selected?.resourceId === comparison) {
      view.setChanges(true);
      setComparison("");
    }
  }, [comparison, selected?.resourceId, view]);
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
  const attention = useMemo(
    () => projectAttention(state, project),
    [state, project],
  );
  const updatesDialog =
    settings === "updates" && (!state.user || state.onboarding?.active) ? (
      <Overlay
        open
        onClose={() => setSettings(null)}
        title="Updates"
        className="settings-updates-dialog"
      >
        <div className="settings-panel" data-section="updates">
          <SettingsUpdates updates={updates} />
          <Button onClick={() => setSettings(null)}>Done</Button>
        </div>
      </Overlay>
    ) : null;
  if (!state.user)
    return (
      <>
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
        {updatesDialog}
      </>
    );
  if (state.onboarding?.active && setup.dialog !== "join")
    return (
      <>
        <Onboarding
          key={`${state.profile}:${state.user}:${state.config?.apiUrl}`}
          state={state}
          refresh={refresh}
          onComplete={setProject}
        />
        {updatesDialog}
      </>
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
  const governanceSkill =
    governance && !governance.env
      ? state.resources.find(
          (item) =>
            item.resourceId === governance.resource &&
            item.projectId === project &&
            item.kind === "skill",
        )
      : undefined;
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
    <ResourceMenuProvider
      key={workspaceScope}
      scope={JSON.stringify([workspaceScope, project])}
      state={state}
      resources={catalogResources}
      busy={busy}
      act={act}
      onOpen={(item, compare) =>
        leaveSettings(() => {
          setTab(item.kind);
          openResource(item.resourceId);
          if (compare) setComparison(item.resourceId);
        })
      }
      onReview={(item, mode) =>
        leaveSettings(() => setGovernance({ resource: item.resourceId, mode }))
      }
      onRefresh={async () => {
        await refresh();
        localCatalog.refresh();
      }}
      onNotice={setNotice}
      onError={setError}
    >
      <div
        className="app"
        data-detail-kind={!settings ? selected?.kind : undefined}
      >
        <motion.aside
          initial={false}
          animate={{ width: sidebarCollapsed ? 88 : 240 }}
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
          <div
            className="sidebar-window-controls"
            data-tauri-drag-region
            aria-hidden="true"
          />
          <ProjectNavigation
            collapsed={sidebarCollapsed}
            projects={state.projects}
            projectId={project}
            activeKind={settings ? null : tab}
            resources={catalogResources}
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
            {updates.status?.update && (
              <SidebarUpdate
                key={updates.status.update.sha256}
                updates={updates}
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
            <ProjectPicker
              projects={state.projects}
              projectId={project}
              collapsed={sidebarCollapsed}
              projectActions={(target) => {
                const settingsAction = (
                  id: string,
                  label: string,
                  section: SettingsSection,
                ): ItemMenuAction => ({
                  id,
                  label,
                  onSelect: () => openProjectSettings(target.id, section),
                });
                const actions: ItemMenuAction[] = [
                  {
                    id: "open",
                    label: "Open project",
                    onSelect: () =>
                      leaveSettings(() => {
                        setProject(target.id);
                        setResource("");
                        setEnvSet("");
                        setTab("home");
                      }),
                  },
                  {
                    id: "link",
                    label: "Copy project link",
                    onSelect: () =>
                      void act(
                        () =>
                          navigator.clipboard.writeText(
                            `orka://project/${target.id}`,
                          ),
                        {
                          successTitle: "Project link copied",
                          errorTitle: "Couldn’t copy project link",
                        },
                      ),
                  },
                  settingsAction("settings", "Project settings…", "general"),
                  settingsAction(
                    "rename",
                    target.role === "owner"
                      ? "Rename project…"
                      : "Rename on this Mac…",
                    "general",
                  ),
                  settingsAction("members", "Members…", "members"),
                  settingsAction("folders", "Source folders…", "folder"),
                ];
                if (target.role === "owner" || target.role === "admin")
                  actions.push(
                    settingsAction(
                      "permissions",
                      "Permissions…",
                      "permissions",
                    ),
                  );
                return actions;
              }}
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
            />
          </div>
        </motion.aside>
        <main>
          <WorkspaceHeader
            leading={
              !settings && selected?.kind === "skill" ? (
                <Button size="sm" variant="tertiary" onClick={closeDetail}>
                  <Icon icon={ArrowLeftIcon} /> Back to Skills
                </Button>
              ) : undefined
            }
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
                attention={attention}
                onReview={() => leaveSettings(() => openManagement("requests"))}
                busy={busy}
                actionError={error || refreshError}
                onDismissError={error ? () => setError("") : undefined}
                skillUsagePartial={skillUsage.usage?.partial}
                onSync={() =>
                  void act(() => invoke("sync_now"), {
                    successTitle: "Sync requested",
                    kind: "queued",
                    errorTitle: "Couldn’t request sync",
                  })
                }
                onRetry={() =>
                  void act(
                    () =>
                      invoke("retry_uploads", { projectId: project || null }),
                    {
                      successTitle: "Upload retry requested",
                      kind: "queued",
                      errorTitle: "Couldn’t retry uploads",
                    },
                  )
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
                    const kind = state.resources.find(
                      (r) => r.resourceId === id,
                    )?.kind;
                    if (kind) setTab(kind);
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
              updates={updates}
              initialProjectId={settingsProject ?? project}
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
              {!hasConnectedSource(selectedProject) &&
                selected?.kind !== "skill" && (
                  <FolderConnectionPrompt
                    projectName={projectLabel(selectedProject)}
                    busy={busy}
                    repositories={activeSources(selectedProject.sources).some(
                      (source) => source.repository,
                    )}
                    onConnect={() =>
                      activeSources(selectedProject.sources).some(
                        (source) => source.repository,
                      )
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
                    scope={workspaceScope}
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
                    skillSummary={skillSummaries[skillSummaryKey(selected)]}
                    project={selectedProject}
                    user={state.user}
                    deviceId={state.deviceId}
                    busy={busy}
                    conflicts={attention.items.flatMap(
                      (item) => item.conflicts,
                    )}
                    view={view}
                    act={act}
                    state={state}
                    offline={state.sync ? !state.sync.online : false}
                    onRefresh={refresh}
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
                      state.governance?.find(
                        (item) => item.projectId === project,
                      )?.catalog.access[tab]?.mode === "hidden",
                    )}
                    loading={sessionTitles.loading}
                    discovering={localCatalog.loading}
                    discoveryResult={localCatalog.result}
                    onRefreshLocal={localCatalog.refresh}
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
        {governance !== null && selectedProject && governanceSkill && (
          <SkillReviewOverlay
            key={`${project}:${governanceSkill.resourceId}`}
            mode={governance.mode ?? "incoming"}
            project={selectedProject}
            resource={governanceSkill}
            state={state}
            onClose={() => setGovernance(null)}
            onRefresh={refresh}
            onNotice={setNotice}
          />
        )}
        {governance !== null && selectedProject && !governanceSkill && (
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
    </ResourceMenuProvider>
  );
}
