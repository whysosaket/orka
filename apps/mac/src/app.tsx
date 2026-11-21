import {
  ArchiveIcon,
  ArrowLeftIcon,
  FolderIcon,
  FolderOpenIcon,
  LinkIcon,
  PencilIcon,
  RotateCcwIcon,
  SettingsIcon,
  ShieldUserIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react";
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
import type { ItemMenuAction } from "./components/item-menu.js";
import type { IconGlyph } from "./components/icons.js";
import { useWebViewMenuPolicy } from "./hooks/use-web-view-menu-policy.js";
import { ENV_ENABLED } from "./lib/features.js";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Overlay } from "./components/overlay.js";
import { SettingsUpdates } from "./components/settings/settings-updates.js";
import { SettingsPluginConnections } from "./components/settings/settings-plugin-connections.js";
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
import { Button } from "./components/button.js";
import { ProjectHome } from "./components/project-home.js";
import {
  ProjectNavigation,
  ProjectPicker,
  projectLabel,
} from "./components/project-navigation.js";
import { InactiveProject } from "./components/inactive-project.js";
import { inactiveReason } from "./components/project-inactive.js";
import {
  changeProjectArchive,
  SettingsDanger,
} from "./components/settings/settings-danger.js";
import {
  FolderConnectionPrompt,
  ProjectEmptyState,
  ProjectSetupDialog,
} from "./components/project-setup.js";
import { ResourceIndex } from "./components/resource-index.js";
import {
  ReviewsPage,
  type ReviewSelection,
  type ReviewsView,
} from "./components/reviews-page.js";
import { ReviewStepper } from "./components/review-stepper.js";
import { RepositoryConnections } from "./components/repository-connections.js";
import { useBackgroundRepositoryAccess } from "./components/use-repositories.js";
import { RepositoryFilter } from "./components/repository-filter.js";
import { GlobalSkillImport } from "./components/global-skill-import.js";
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
import {
  projectAttention,
  syncReviewItems,
  type SyncReviewItem,
} from "./components/sync-attention.js";
import { skillReviewState } from "./components/skill-review-state.js";
import { skillStatus, type SkillStatus } from "./components/skill-status.js";
import { useDeepLinks } from "./components/use-deep-links.js";
import { PluginAuthorization } from "./components/plugin-authorization.js";
import { parseProjectInvite } from "./components/project-invite.js";
import { useIndexFilters } from "./components/use-index-filters.js";
import { defaultIndexFilters } from "./components/index-toolbar.js";
import { useResourceView } from "./components/use-resource-view.js";
import {
  useSkillSummaries,
  skillSummaryKey,
} from "./components/use-skill-summaries.js";
import {
  useSessionTitleCache,
  useSessionTitles,
} from "./components/use-session-titles.js";
import { useLocalResources } from "./components/use-local-resources.js";
import { resourceCatalog } from "./components/resource-catalog.js";
import { useWorkspace } from "./components/use-workspace.js";
import {
  WorkspaceCache,
  WorkspaceCacheProvider,
} from "./components/workspace-cache.js";
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
  reviews: "reviews",
  memory: "memories",
  skill: "skills",
  session: "sessions",
  plan: "plans",
};

export function App() {
  useWebViewMenuPolicy();
  const workspace = useWorkspace();
  if (!workspace.hasSnapshot)
    return (
      <main className="app-startup" data-tauri-drag-region>
        <div className="app-startup__content">
          {workspace.refreshError ? (
            <>
              <p className="content-message" role="alert">
                Could not load Orka: {workspace.refreshError}
              </p>
              <Button onClick={() => void workspace.refresh().catch(() => {})}>
                Try again
              </Button>
            </>
          ) : (
            <p className="content-message" role="status">
              Loading…
            </p>
          )}
        </div>
      </main>
    );
  return (
    <WorkspaceCacheProvider state={workspace.state}>
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
    </WorkspaceCacheProvider>
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
    refreshQueue,
    queue,
    refreshError,
    errorFeedback,
    actionNotice,
  } = workspace;
  const { notify, queue: toasts } = useToasts();
  const toastShowing = toasts.length > 0;
  const workspaceScope = WorkspaceCache.scope(state);
  const updates = useDesktopUpdates(workspaceScope, state.user);
  const account = useAccount(state.config, !state.user);
  useBackgroundRepositoryAccess(state);
  const [repositorySetup, setRepositorySetup] = useState("");
  const setup = useProjectSetup(
    setProject,
    setError,
    state.config?.apiUrl,
    (id) => setRepositorySetup(id),
    state.projects,
    workspaceScope,
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
  const [connectorRequest, setConnectorRequest] = useState<{
    requestId: string;
    scope: string;
  } | null>(null);
  const closeConnectorRequest = useCallback(
    () => setConnectorRequest(null),
    [],
  );
  const [settingsProject, setSettingsProject] = useState<string | null>(null);
  useEffect(() => {
    if (!settings) setSettingsProject(null);
  }, [settings]);
  const settingsNavigation = useRef<SettingsNavigationHandle>(null);
  const projectPickerTrigger = useRef<HTMLButtonElement>(null);
  const [projectLifecycle, setProjectLifecycle] = useState<{
    id: string;
    scope: string;
    action: "archive" | "restore" | "delete";
  } | null>(null);
  const lifecycleTarget =
    projectLifecycle?.scope === workspaceScope
      ? (projectLifecycle.action === "restore"
          ? state.inactive
          : state.projects
        )?.find(
          (item) => item.id === projectLifecycle.id && item.role === "owner",
        )
      : undefined;
  useEffect(() => {
    if (!projectLifecycle) return;
    if (!lifecycleTarget) {
      setProjectLifecycle(null);
      return;
    }
    const { action } = projectLifecycle;
    if (action === "delete") return;
    setProjectLifecycle(null);
    if (action === "restore" && inactiveReason(lifecycleTarget) !== "archived")
      return;
    // A settings save can advance the revision before the requested action.
    void act(() => changeProjectArchive(lifecycleTarget, action), {
      successTitle:
        action === "archive" ? "Project archived" : "Project restored",
      errorTitle:
        action === "archive"
          ? "Couldn’t archive project"
          : "Couldn’t restore project",
    });
  }, [act, projectLifecycle, lifecycleTarget]);
  const deleteTarget =
    projectLifecycle?.action === "delete" ? lifecycleTarget : undefined;
  const leaveSettings = (
    action: () => void,
    onGuardCloseAutoFocus?: (accepted: boolean) => void,
  ) => {
    if (settings && settingsNavigation.current)
      settingsNavigation.current.requestExit(() => {
        setSettings(null);
        action();
      }, onGuardCloseAutoFocus);
    else action();
  };
  const requestProjectLifecycle = (
    id: string,
    action: NonNullable<typeof projectLifecycle>["action"],
  ) =>
    leaveSettings(
      () => setProjectLifecycle({ id, scope: workspaceScope, action }),
      (accepted) => {
        if (!accepted || action !== "delete")
          projectPickerTrigger.current?.focus();
      },
    );
  const openProjectSettings = (id: string, section: SettingsSection) => {
    if (section === "folder") projectPickerTrigger.current?.focus();
    if (settings && settingsNavigation.current) {
      settingsNavigation.current.requestProjectSection(
        id,
        section,
        (accepted) => {
          if (!accepted) projectPickerTrigger.current?.focus();
        },
      );
    } else {
      setSettingsProject(id);
      setSettings(section);
    }
  };
  const openSettings = useCallback((section: SettingsSection) => {
    if (settingsNavigation.current)
      settingsNavigation.current.requestSection(section);
    else setSettings(section);
  }, []);
  const canApproveConnector = Boolean(state.user);
  const activeConnectorRequest =
    connectorRequest?.scope === workspaceScope ? connectorRequest : null;
  useEffect(() => {
    if (busy || activeConnectorRequest) return;
    let stopped = false;
    let timer: number | undefined;
    const dialogOpen = () => !!document.querySelector('[role="dialog"]');
    const poll = async () => {
      try {
        if (document.hidden || !document.hasFocus() || dialogOpen()) return;
        const attention = await invoke<{
          requestId?: string;
          reconnect?: { id: string; name: string };
        } | null>("plugin_connection_attention", {
          allowPrompt: canApproveConnector,
        });
        if (stopped || document.hidden || !document.hasFocus() || !attention)
          return;
        if (attention.requestId && !dialogOpen()) {
          setConnectorRequest({
            requestId: attention.requestId,
            scope: workspaceScope,
          });
        } else if (attention.reconnect && !toastShowing) {
          const { id, name } = attention.reconnect;
          notify({
            title: `${name} couldn’t reconnect to Orka`,
            placement: "bottom-right",
            action: {
              label: "Connectors",
              onClick: () => openSettings("connections"),
            },
            onDisplay: () => {
              void invoke("plugin_connection_attention", {
                allowPrompt: false,
                reportedNotice: id,
              }).catch(() => {});
            },
          });
        }
      } catch {
        // Connector discovery can continue once the native broker is available.
      } finally {
        if (!stopped) timer = window.setTimeout(() => void poll(), 1000);
      }
    };
    void poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [
    activeConnectorRequest,
    busy,
    canApproveConnector,
    notify,
    openSettings,
    toastShowing,
    workspaceScope,
  ]);
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
  const syncStatusTrigger = useRef<HTMLButtonElement>(null);
  const projectScope = JSON.stringify([workspaceScope, project]);
  const [reviewsDestination, setReviewsDestination] = useState<{
    scope: string;
    view: ReviewsView;
    request: symbol;
  } | null>(null);
  useEffect(() => {
    setReviewsDestination((current) =>
      current && current.scope !== projectScope ? null : current,
    );
  }, [projectScope]);
  const consumeReviewsDestination = useCallback((request: symbol) => {
    setReviewsDestination((current) =>
      current?.request === request ? null : current,
    );
  }, []);
  const [reviewState, setReview] = useState<{
    scope: string;
    selection: ReviewSelection;
  } | null>(null);
  const [governance, setGovernance] = useState<{
    resource: string;
    mode?: "incoming" | "outgoing";
    env?: { title: string };
  } | null>(null);
  const openManagement = useCallback(
    (
      section: ManagementSection = "members",
      view: ReviewsView = "open",
      targetProject = project,
    ) => {
      if (section === "members") {
        if (settingsNavigation.current)
          settingsNavigation.current.requestSection("members");
        else setSettings("members");
        return;
      }
      setReviewsDestination(
        section === "requests"
          ? {
              scope: JSON.stringify([workspaceScope, targetProject]),
              view,
              request: Symbol(),
            }
          : null,
      );
      setSettings(null);
      setTab(section === "requests" ? "reviews" : "members");
      setReview(null);
      setResource("");
    },
    [project, workspaceScope],
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
  const index = useIndexFilters(projectScope);
  const inactiveProject = state.inactive?.find((item) => item.id === project);
  const selectedProject =
    state.projects.find((p) => p.id === project) ?? inactiveProject;
  // A review belongs to the project and tab it was opened in.
  const review =
    !settings &&
    !inactiveProject &&
    tab === "reviews" &&
    reviewState?.scope === projectScope
      ? reviewState.selection
      : null;
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
  const collectionFilters =
    tab === "home" || tab === "env" || tab === "members" || tab === "reviews"
      ? undefined
      : index.filters[tab];
  const collectionRepository = tab === "skill" ? "all" : repository;
  const filters = useMemo(
    () => ({
      ...defaultIndexFilters,
      ...collectionFilters,
      repository: collectionRepository,
    }),
    [collectionFilters, collectionRepository],
  );
  const projectPath = selectedProject?.path;
  const localCatalog = useLocalResources({
    scope: workspaceScope,
    project: inactiveProject ? undefined : selectedProject,
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
  const titleCache = useSessionTitleCache(workspaceScope);
  const sessionTitles = useSessionTitles(
    resources,
    tab === "session",
    titleCache,
  );
  const skillSummaries = useSkillSummaries(resources, workspaceScope);
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
      if (item.kind === "session" || item.kind === "skill") continue;
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
    workspaceScope,
    state.deviceId,
  );
  useEffect(() => {
    if (comparison && selected?.resourceId === comparison) {
      view.setChanges(true);
      setComparison("");
    }
  }, [comparison, selected?.resourceId, view]);
  const openDeepLink = (link: URL) => {
    if (link.hostname === "connectors") {
      openSettings("connections");
      return;
    }
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
        const sameProjectSkill =
          id === project &&
          catalogResources.some(
            (item) =>
              item.projectId === id &&
              item.resourceId === resourceId &&
              item.kind === "skill",
          );
        if (!sameProjectSkill) index.setRepository("all");
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
  };
  useDeepLinks(openDeepLink, !busy, busy || Boolean(setup.dialog));
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
  const skillStatusOf = useMemo(() => {
    const items = new Map(
      attention.items.map((item) => [item.resourceId ?? item.key, item]),
    );
    const cache = new Map<string, SkillStatus | null>();
    return (skill: ProjectResource) => {
      if (!cache.has(skill.resourceId))
        cache.set(
          skill.resourceId,
          skillStatus({
            resource: skill,
            conflicted: conflicted.has(skill.resourceId),
            attention: items.get(skill.resourceId),
            review: skillReviewState(skill, state, {
              governed: selectedProject?.governed,
            }),
          }),
        );
      return cache.get(skill.resourceId) ?? null;
    };
  }, [attention, conflicted, state, selectedProject?.governed]);
  const syncReviews = useMemo(
    () => syncReviewItems(state, project, attention),
    [state, project, attention],
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
  const connectorsDialog =
    settings === "connections" && (!state.user || state.onboarding?.active) ? (
      <Overlay
        open
        title="Connectors"
        onClose={() => setSettings(null)}
        className="settings-updates-dialog"
      >
        <div className="settings-panel" data-section="connections">
          <SettingsPluginConnections state={state} />
          <Button onClick={() => setSettings(null)}>Done</Button>
        </div>
      </Overlay>
    ) : null;
  const connectorDialog = activeConnectorRequest && (
    <PluginAuthorization
      key={activeConnectorRequest.requestId}
      automatic
      request={activeConnectorRequest}
      scope={workspaceScope}
      onClose={closeConnectorRequest}
    />
  );
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
        {connectorsDialog}
        {connectorDialog}
        <ToastViewport />
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
        {connectorsDialog}
        {connectorDialog}
        <ToastViewport />
      </>
    );
  const openResource = (id: string) => {
    const target = catalogResources.find((item) => item.resourceId === id);
    if (
      target?.kind !== "skill" &&
      repository !== "all" &&
      target?.sourceId !== repository
    )
      index.setRepository("all");
    setResource(id);
    view.setChanges(false);
  };
  const openSyncReview = ({ projectId, item }: SyncReviewItem) => {
    const targetProject = state.projects.find((p) => p.id === projectId);
    if (!targetProject) return;
    const target = catalogResources.find(
      (r) => r.resourceId === item.resourceId && r.projectId === projectId,
    );
    setProject(projectId);
    setGovernance(null);
    if (
      target?.kind === "skill" &&
      skillReviewState(target, state, targetProject).incoming
    ) {
      setGovernance({ resource: target.resourceId, mode: "incoming" });
    }
    if (target && !target.deleted && (target.kind === "skill" || !item.draft)) {
      setTab(target.kind);
      openResource(target.resourceId);
    } else {
      openManagement("requests", "open", projectId);
    }
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
        key={JSON.stringify([
          project,
          tab,
          selectedProject.governed,
          selectedProject.role,
        ])}
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
      scope={projectScope}
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
            pendingCounts={localCatalog.pendingCounts}
            reviewCount={
              selectedProject?.governed && !inactiveProject
                ? attention.items.reduce(
                    (count, item) => count + item.requests.length,
                    0,
                  )
                : undefined
            }
            onNavigate={(kind) =>
              leaveSettings(() => {
                setEnvSet("");
                setTab(kind);
                setReview(null);
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
              onSettings={() => openSettings("account")}
              onCreate={() => leaveSettings(() => setup.show("create"))}
              onJoin={() => leaveSettings(() => setup.show("join"))}
            />
            <ProjectPicker
              projects={[...state.projects, ...(state.inactive ?? [])]}
              projectId={project}
              collapsed={sidebarCollapsed}
              triggerRef={projectPickerTrigger}
              projectActions={(target) => {
                const open: ItemMenuAction = {
                  id: "open",
                  label: "Open project",
                  icon: FolderOpenIcon,
                  onSelect: () =>
                    leaveSettings(() => {
                      setProject(target.id);
                      setResource("");
                      setEnvSet("");
                      setTab("home");
                    }),
                };
                const archiveAction = (
                  action: "archive" | "restore",
                ): ItemMenuAction => ({
                  id: action,
                  label:
                    action === "archive"
                      ? "Archive project"
                      : "Restore project",
                  icon: action === "archive" ? ArchiveIcon : RotateCcwIcon,
                  separator: true,
                  disabled: busy,
                  onSelect: () => requestProjectLifecycle(target.id, action),
                });
                if (!state.projects.some((item) => item.id === target.id))
                  return target.role === "owner" &&
                    inactiveReason(target) === "archived"
                    ? [open, archiveAction("restore")]
                    : [open];
                const settingsAction = (
                  id: string,
                  label: string,
                  section: SettingsSection,
                  icon: IconGlyph,
                ): ItemMenuAction => ({
                  id,
                  label,
                  icon,
                  restoreFocus: section !== "folder",
                  onSelect: () => openProjectSettings(target.id, section),
                });
                const actions: ItemMenuAction[] = [
                  open,
                  {
                    id: "link",
                    label: "Copy project link",
                    icon: LinkIcon,
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
                  settingsAction(
                    "settings",
                    "Project settings…",
                    "general",
                    SettingsIcon,
                  ),
                  settingsAction(
                    "rename",
                    target.role === "owner"
                      ? "Rename project…"
                      : "Rename on this Mac…",
                    "general",
                    PencilIcon,
                  ),
                  settingsAction("members", "Members…", "members", UsersIcon),
                  settingsAction(
                    "folders",
                    "Source folders…",
                    "folder",
                    FolderIcon,
                  ),
                ];
                if (target.role === "owner" || target.role === "admin")
                  actions.push(
                    settingsAction(
                      "permissions",
                      "Permissions…",
                      "permissions",
                      ShieldUserIcon,
                    ),
                  );
                if (target.role === "owner")
                  actions.push(archiveAction("archive"), {
                    id: "delete",
                    label: "Delete project…",
                    icon: Trash2Icon,
                    danger: true,
                    disabled: busy,
                    restoreFocus: false,
                    onSelect: () =>
                      requestProjectLifecycle(target.id, "delete"),
                  });
                return actions;
              }}
              onProjectChange={(id) => {
                const change = () => {
                  setEnvSet("");
                  setProject(id);
                  setResource("");
                  setReview(null);
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
              review ? (
                <Button
                  size="sm"
                  variant="tertiary"
                  onClick={() => setReview(null)}
                >
                  <Icon icon={ArrowLeftIcon} /> Back to Reviews
                </Button>
              ) : !settings && selected ? (
                <Button size="sm" variant="tertiary" onClick={closeDetail}>
                  <Icon icon={ArrowLeftIcon} /> Back to {collectionLabel}
                </Button>
              ) : undefined
            }
            title={
              settings
                ? "Settings"
                : inactiveProject
                  ? projectLabel(inactiveProject)
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
            navigation={
              review && (
                <ReviewStepper
                  selection={review}
                  onChange={(selection) =>
                    setReview({ scope: projectScope, selection })
                  }
                />
              )
            }
            repositoryFilter={
              !settings &&
              selectedProject &&
              !inactiveProject &&
              repositories.length > 1 &&
              tab !== "home" &&
              // Skills filter by repository inside their own Filter menu.
              tab !== "skill" &&
              tab !== "reviews" &&
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
                triggerRef={syncStatusTrigger}
                open={syncOpen}
                onOpenChange={setSyncOpen}
                key={project}
                canConnect={Boolean(selectedProject)}
                state={state}
                attention={attention}
                projectId={project}
                reviews={syncReviews}
                onReviewItem={(review) =>
                  leaveSettings(() => openSyncReview(review))
                }
                queue={queue}
                onCancel={(projectId) =>
                  void act(
                    async () => {
                      await invoke("cancel_sync", { projectId });
                      await refreshQueue();
                    },
                    {
                      successTitle: "Cancellation requested",
                      kind: "queued",
                      errorTitle: "Couldn’t cancel sync",
                    },
                  )
                }
                onReview={() => leaveSettings(() => openManagement("requests"))}
                onOpenRequestHistory={() =>
                  leaveSettings(
                    () => openManagement("requests", "history"),
                    (accepted) => {
                      if (!accepted) syncStatusTrigger.current?.focus();
                    },
                  )
                }
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
                openManagement(section, "open", id);
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
          ) : inactiveProject ? (
            <InactiveProject
              key={inactiveProject.id}
              project={inactiveProject}
              busy={busy}
              run={(action, feedback) => run(action, true, feedback)}
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
                {tab === "reviews" ? (
                  <ReviewsPage
                    key={projectScope}
                    project={selectedProject}
                    scope={projectScope}
                    state={state}
                    review={review}
                    onReview={(selection) =>
                      setReview(selection && { scope: projectScope, selection })
                    }
                    destination={
                      reviewsDestination?.scope === projectScope
                        ? reviewsDestination
                        : undefined
                    }
                    onDestinationShown={consumeReviewsDestination}
                    onRefresh={refresh}
                    onReviewFile={(resource) => setGovernance({ resource })}
                  />
                ) : tab === "members" ? (
                  <MembersPage
                    key={project}
                    project={selectedProject}
                    state={state}
                    section="logs"
                    onSection={openManagement}
                    onRefresh={refresh}
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
                    titleCache={titleCache}
                    project={selectedProject}
                    user={state.user}
                    resources={catalogResources}
                    pendingCounts={localCatalog.pendingCounts}
                    onNavigate={(kind) => {
                      if (kind !== "skill") index.setRepository("all");
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
                    kind={tab}
                    resources={resources}
                    filters={filters}
                    onFilters={(next) => index.set(tab, next)}
                    user={state.user}
                    displayTitle={displayTitle}
                    duplicateTitles={duplicateTitles}
                    conflicted={conflicted}
                    skillStatus={skillStatusOf}
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
          {deleteTarget && (
            <SettingsDanger
              key={deleteTarget.id}
              project={deleteTarget}
              serviceUrl={state.config?.apiUrl}
              members={
                state.governance?.find(
                  (entry) => entry.projectId === deleteTarget.id,
                )?.catalog.members?.length ?? null
              }
              busy={busy}
              run={run}
              onComplete={() => setNotice("Project deleted")}
              standaloneDelete={{
                onClose: () => setProjectLifecycle(null),
                onCloseAutoFocus: (event) => {
                  event.preventDefault();
                  projectPickerTrigger.current?.focus();
                },
              }}
            />
          )}
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
            invite={setup.invite}
            busy={busy}
            waiting={setup.waiting}
            cancelling={setup.cancelling}
            onCancelWait={setup.cancelWait}
            connectingFolders={setup.connectingFolders}
            folderError={setup.folderError}
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
        {connectorDialog}
      </div>
    </ResourceMenuProvider>
  );
}
