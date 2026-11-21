import { expect, type Page } from "@playwright/test";

interface UpdateStatus {
  installedVersion: string;
  update?: { version: string; notes: string; sha256: string };
  updateAudience?: "early" | "public";
  release?: { version: string; notes: string; sha256: string };
  message?: string;
  supported?: boolean;
}

export async function settingsFixture(
  page: Page,
  options: {
    noProjects?: boolean;
    openSettings?: boolean;
    websiteRole?: "owner" | "admin" | "member";
    emailInvites?: boolean;
    pendingInvites?: { email: string; expiresAt: string }[];
    failEmailInvite?: boolean;
    /** Rejection for email invites, as the Tauri command reports it ("429: ..."). */
    emailInviteError?: string;
    /** Simulates a service without POST /v2/invites/revoke. */
    revokeMissing?: boolean;
    update?: UpdateStatus;
    updateError?: string;
    updateDelay?: number;
    updateInstallError?: string;
    updateInstallDelay?: number;
    pluginDelay?: number;
    pluginError?: string;
    pluginClientName?: string;
    pluginRequestId?: string;
    pluginFirstConnection?: boolean;
    pluginRemembered?: boolean;
    pluginStatusDelay?: number;
    pluginSessionCount?: number;
    role?: "owner" | "admin" | "member";
    queued?: boolean;
    pendingRequests?: boolean;
    interval?: number;
    devices?: "empty" | "unavailable";
    deviceRows?: {
      id: string;
      name: string;
      seen_at: string;
      hardwareFamily?: string | null;
    }[];
    localHardwareFamily?: string;
    noCachedDevices?: boolean;
    noProfile?: boolean;
    profileSupported?: boolean;
    missingPreferences?: boolean;
    failInitial?: boolean;
    cachedMembers?: boolean;
    olderService?: boolean;
    debug?: boolean;
    delay?: number;
    saveDelay?: number;
    failSharing?: boolean;
    failBackground?: boolean;
    failRename?: boolean;
    failSourceRemoval?: boolean;
    cancelPicker?: boolean;
    folderState?: "connected" | "reconnect" | "locate";
    sourceRows?: {
      id: string;
      name: string;
      path: string | null;
      folderState: "connected" | "reconnect" | "locate" | "repository-conflict";
      remoteKey?: string;
      removedAt?: string | null;
      queuedChanges?: number;
      gitRepository?: boolean;
      syncStartsAt?: string;
    }[];
    deletedProjects?: {
      id: string;
      name: string;
      role?: "owner" | "admin" | "member";
      deletedAt: string;
      purgeAfter?: string;
      lifecycleRevision?: number;
    }[];
    archivedProjects?: {
      id: string;
      name: string;
      role?: "owner" | "admin" | "member";
      archivedAt: string;
      lifecycleRevision?: number;
    }[];
    projectRestoreWindowDays?: number;
    restoreError?: string;
    failDeletionCapabilities?: boolean;
    policyFailure?: "drop" | "offline" | "conflict";
    legacy?: boolean;
    long?: boolean;
  } = {},
) {
  await page.addInitScript((options) => {
    const policies = {
      admin: {
        memory: "write",
        session: "write",
        plan: "write",
        skill: "write",
      },
      member: {
        memory: "read",
        session: "read",
        plan: "write",
        skill: "write",
      },
    };
    const members = [
      {
        id: "owner",
        name: options.long
          ? "Morgan Taylor with a very long display name for a compact workspace"
          : "Morgan Taylor",
        email: "morgan@example.com",
        role: "owner",
      },
      { id: "admin", name: "Alex Chen", role: "admin" },
      {
        id: "member",
        name: "Jamie Rivera",
        email: "jamie@example.com",
        role: "member",
      },
    ];
    const user: string = options.role ?? "owner";
    const off = {
      memory: false,
      session: false,
      plan: false,
      skill: false,
      env: false,
    };
    const profile = {
      displayName: "Morgan Taylor",
      jobRole: "Designer",
      email: "morgan@example.com",
      avatarData: null,
      avatarUrl: null,
      detailsSupported: options.profileSupported ?? true,
      revision: "profile-1",
    };
    const requests = options.pendingRequests
      ? [
          {
            id: "pending-review",
            projectId: "one",
            author: "member",
            type: "change",
            resourceId: "review-memory",
            title: "Memory awaiting review",
            status: "pending",
            baseRevision: 1,
            policyRevision: 1,
            previewHash: "review-preview",
            createdAt: "2026-11-03T12:00:00Z",
            canReview: true,
            unread: true,
          },
        ]
      : [];
    const projects = options.noProjects
      ? []
      : [
          {
            id: "one",
            name: options.long
              ? "Orka project with a long readable name"
              : "Orka",
            role: user,
            path: "/Projects/orka",
            sources: options.sourceRows ?? [
              {
                id: "source-one",
                name: "orka",
                path:
                  options.folderState === "locate" ? null : "/Projects/orka",
                folderState: options.folderState ?? "connected",
              },
            ],
            sharing: { ...off, memory: true, skill: true },
            lifecycleRevision: 1,
            policyRevision: 1,
            governed: true,
          },
          {
            id: "two",
            name: "Website",
            role: options.websiteRole ?? "member",
            path: null,
            sources: [
              {
                id: "source-two",
                name: "website",
                path: null,
                folderState: "locate" as const,
              },
            ],
            sharing: { ...off },
            lifecycleRevision: 1,
            policyRevision: 1,
            governed: true,
          },
        ];
    const deletedProjects = (options.deletedProjects ?? []) as any[];
    const archivedProjects = (options.archivedProjects ?? []) as any[];
    const state = {
      user,
      profile: "settings-test",
      accountProfile: options.noProfile ? null : profile,
      config: {
        apiUrl: "https://test.orka",
        mode: "cloud",
        syncMinutes: options.interval ?? 15,
        selfHostedUrl: "https://selfhost.orka",
      },
      projects,
      deletedProjects,
      archivedProjects,
      resources: [],
      bindings: [],
      conflicts: [],
      activity: [],
      reviewRequests: requests,
      outbox: options.queued
        ? [{ id: "queued", project: "one", error: "Offline" }]
        : [],
      errors: [],
      sync: { online: true },
      daemon: { running: true },
      devices:
        options.devices === "unavailable" || options.noCachedDevices
          ? null
          : (options.deviceRows ??
            (options.devices === "empty"
              ? []
              : [
                  {
                    id: "mac",
                    name: "Morgan’s MacBook Pro",
                    seen_at: "2026-11-03T12:00:00Z",
                    hardwareFamily: "laptop",
                  },
                  {
                    id: "other",
                    name: "Unknown hardware",
                    seen_at: "invalid",
                    hardwareFamily: "future-family",
                  },
                ])),
      deviceId: "mac",
      localHardwareFamily: options.localHardwareFamily,
      background: options.missingPreferences ? null : true,
    };
    const catalog = {
      owner: user === "owner",
      role: user,
      governed: true,
      policyRevision: 1,
      rolePolicies: options.legacy ? null : structuredClone(policies),
      members,
      ...(options.pendingInvites
        ? { pendingInvites: structuredClone(options.pendingInvites) }
        : {}),
      policy: {
        instructions: { mode: "suggest", create: "suggest", canShare: false },
        memory: { mode: "read", create: "hidden", canShare: false },
      },
      memberRules: [],
      resourceRules: [],
      resourceCount: 0,
      requests,
    };
    if (options.cachedMembers)
      Object.assign(state, {
        governance: [{ projectId: "one", catalog: { members, access: {} } }],
      });
    const calls: { command: string; args: any }[] = [];
    const operations = new Map<string, unknown>();
    let failedSharing = false,
      failedBackground = false,
      failedRename = false,
      policyFailed = false;
    const controls = {
      restoreError: options.restoreError ?? "",
      failDeletionCapabilities: options.failDeletionCapabilities ?? false,
      failRefresh: options.failInitial ?? false,
      failService: false,
      failSwitch: false,
      policyFailure: options.policyFailure ?? "",
      delay: options.delay ?? 0,
      update: options.update ?? { installedVersion: "0.3.0" },
      updateError: options.updateError ?? "",
      updateDelay: options.updateDelay ?? 0,
      pluginCallback: "",
      pluginRequestId: options.pluginRequestId ?? "",
      pluginFirstConnection: options.pluginFirstConnection ?? false,
      pluginReconnectNotice: "",
      pluginState: "not_linked",
      pluginError: options.pluginError ?? "",
      pluginStatusDelay: options.pluginStatusDelay ?? 0,
      pluginSessionCount: options.pluginSessionCount ?? 1,
      pluginStatusError: "",
    };
    const wait = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));
    const callbacks = new Map<number, (event: unknown) => void>();
    const events = new Map<string, number>();
    Object.assign(window, {
      __TAURI_EVENT_PLUGIN_INTERNALS__: {
        unregisterListener: (event: string) => events.delete(event),
      },
      settingsEmit: (event: string, payload: unknown) =>
        callbacks.get(events.get(event)!)?.({ event, payload }),
      settingsState: state,
      settingsCatalog: catalog,
      settingsProfile: profile,
      settingsCalls: calls,
      settingsControls: controls,
      isTauri: true,
      __TAURI_INTERNALS__: {
        transformCallback: (callback: (event: unknown) => void) => {
          const id = callbacks.size + 1;
          callbacks.set(id, callback);
          return id;
        },
        unregisterCallback: () => {},
        invoke: async (command: string, args: any = {}) => {
          if (command === "snapshot")
            return structuredClone({
              ...state,
              inactive: [...archivedProjects, ...deletedProjects],
            });
          if (command === "sync_progress")
            return { user: state.user, progress: null };
          calls.push({ command, args: structuredClone(args) });
          if (command === "profile_events") {
            const callback = controls.pluginCallback;
            controls.pluginCallback = "";
            return callback || null;
          }
          if (command === "plugin_connection_attention") {
            if (
              args.allowPrompt &&
              controls.pluginFirstConnection &&
              controls.pluginRequestId
            )
              return { requestId: controls.pluginRequestId };
            if (args.reportedNotice) {
              controls.pluginReconnectNotice = "";
              return null;
            }
            if (controls.pluginReconnectNotice) {
              return {
                reconnect: {
                  id: "fixture-connection",
                  name: controls.pluginReconnectNotice,
                },
              };
            }
            return null;
          }
          if (command === "plugin_connection_requests")
            return controls.pluginRequestId
              ? [{ requestId: controls.pluginRequestId }]
              : [];
          if (command === "plugin_authorization") {
            await wait(options.pluginDelay ?? 0);
            if (controls.pluginError) throw new Error(controls.pluginError);
            if (
              args.operation !== "revoke" &&
              args.input.requestId !== controls.pluginRequestId
            )
              return null;
            if (args.operation === "preview") {
              if (args.input.automatic) controls.pluginFirstConnection = false;
              return {
                requestId: "fixture-request",
                account: {
                  id: state.user,
                  email: profile.email,
                  displayName: profile.displayName,
                },
                serviceOrigin: state.config.apiUrl,
                client: {
                  id: "fixture-assistant",
                  name: options.pluginClientName ?? "Fixture Assistant",
                },
                scopes: ["orka.read", "orka.write", "orka.manage"],
                permissionDescriptions: [
                  "Read local and shared project context.",
                  "Share selected content, install skills, update memories and plans, and retry or repair synchronization.",
                  "Manage project permissions and review requests within your existing authority.",
                ],
                expiresAt: new Date(Date.now() + 60000).toISOString(),
                verified: options.pluginRemembered,
              };
            }
            if (args.operation === "approve") controls.pluginState = "linked";
            if (args.operation === "revoke")
              controls.pluginState =
                controls.pluginState === "idle"
                  ? "not_linked"
                  : "reconnect_required";
            controls.pluginRequestId = "";
            return {
              [args.operation === "approve" ? "approved" : "cancelled"]: true,
            };
          }
          if (command === "plugin_connection_status") {
            const result = {
              state: controls.pluginRequestId
                ? "pending"
                : controls.pluginState === "idle"
                  ? "not_linked"
                  : controls.pluginState,
              account: {
                id: state.user,
                email: profile.email,
                displayName: profile.displayName,
              },
              serviceOrigin: state.config.apiUrl,
              connections: controls.pluginRequestId
                ? [
                    {
                      id: "fixture-pending",
                      client: {
                        id: "fixture-assistant",
                        name: options.pluginClientName ?? "Fixture Assistant",
                      },
                      state: "pending",
                      requestId: controls.pluginRequestId,
                    },
                  ]
                : controls.pluginState === "not_linked"
                  ? []
                  : [
                      {
                        id: "fixture-connection",
                        client: {
                          id: "fixture-assistant",
                          name: options.pluginClientName ?? "Fixture Assistant",
                        },
                        scopes: ["orka.read", "orka.write", "orka.manage"],
                        state:
                          controls.pluginState === "linked"
                            ? "approved"
                            : controls.pluginState === "idle"
                              ? "idle"
                              : "reconnect_required",
                        connectedAt: null,
                        remembered: options.pluginRemembered,
                        sessionCount:
                          controls.pluginState === "idle"
                            ? 0
                            : controls.pluginSessionCount,
                      },
                    ],
              pendingCount: controls.pluginRequestId ? 1 : 0,
              reason:
                controls.pluginState === "reconnect_required"
                  ? "Your account or service changed. Reconnect your assistant."
                  : null,
              reconnectRequired: controls.pluginState === "reconnect_required",
            };
            await wait(controls.pluginStatusDelay);
            if (controls.pluginStatusError)
              throw new Error(controls.pluginStatusError);
            return result;
          }
          if (command === "update_status") {
            const update = structuredClone(controls.update);
            const error = controls.updateError;
            await wait(controls.updateDelay);
            if (error) throw error;
            return update;
          }
          if (command === "update_install") {
            await wait(options.updateInstallDelay ?? 0);
            if (options.updateInstallError) throw options.updateInstallError;
          }
          if (command === "plugin:event|listen") {
            events.set(args.event, args.handler);
            return args.handler;
          }
          if (command === "plugin:dialog|open")
            return options.cancelPicker ? null : "/Projects/website";
          if (command.startsWith("plugin:")) return null;
          if (command === "auth_capabilities") {
            if (controls.failService)
              throw new Error("This service is unavailable. Try again.");
            return { auth: { password: true, github: true, magicLink: true } };
          }
          if (command === "settings_command") {
            if (args.action === "capabilities")
              return options.olderService
                ? {}
                : {
                    rolePolicies: 1,
                    policyOperations: 1,
                    sourcesRemoval: 1,
                    sourceRemoteKey: 1,
                  };
            await wait(controls.delay);
            if (options.devices === "unavailable" || controls.failRefresh)
              throw new Error("Service unavailable");
            return structuredClone(
              options.noCachedDevices
                ? (options.deviceRows ?? [])
                : state.devices,
            );
          }
          if (command === "onboarding_command") {
            if (args.action === "profile") {
              await wait(controls.delay);
              if (controls.failRefresh) throw new Error("Profile unavailable");
              return { ...profile };
            }
            if (args.action === "save-settings-profile") {
              await wait(options.saveDelay ?? 0);
              if (!args.input.displayName.trim())
                throw new Error("Enter a name of up to 80 characters");
              if (args.input.expectedRevision !== profile.revision)
                throw new Error(
                  "409: Profile changed; review the latest values",
                );
              Object.assign(profile, args.input);
              profile.revision += "-saved";
              state.accountProfile = { ...profile };
              return { ...profile };
            }
            return {};
          }
          if (command === "governance_command") {
            if (args.action === "catalog") {
              const result = structuredClone(catalog);
              if (args.input.projectId === "two") {
                result.owner = false;
                result.role = "member";
                result.rolePolicies = structuredClone(policies);
                result.rolePolicies.member.memory = "none";
              }
              await wait(controls.delay);
              if (controls.failRefresh) throw new Error("Members unavailable");
              return result;
            }
            if (args.action === "role-policy")
              return {
                policies: structuredClone(catalog.rolePolicies),
                policyRevision: catalog.policyRevision,
              };
            if (args.action === "policy-operation")
              return operations.has(args.input.operationId)
                ? {
                    status: "committed",
                    ...(operations.get(args.input.operationId) as object),
                  }
                : { status: "not_found" };
            if (args.action === "save-role-policy") {
              const authorizedAtSubmission = catalog.role === "owner";
              await wait(options.saveDelay ?? 0);
              if (controls.policyFailure === "conflict" && !policyFailed) {
                policyFailed = true;
                catalog.policyRevision++;
                catalog.rolePolicies!.admin.skill = "read";
                throw new Error(
                  "409: Permissions changed; review latest values",
                );
              }
              if (controls.policyFailure === "offline") {
                throw new Error("Service unavailable");
              }
              if (!authorizedAtSubmission)
                throw new Error("403: Only the Owner can change role policies");
              const result = {
                operationId: args.input.operationId,
                policies: structuredClone(args.input.policies),
                policyRevision: catalog.policyRevision + 1,
              };
              if (!operations.has(args.input.operationId)) {
                catalog.rolePolicies = result.policies;
                catalog.policyRevision = result.policyRevision;
                operations.set(args.input.operationId, result);
              }
              if (controls.policyFailure === "drop" && !policyFailed) {
                policyFailed = true;
                throw new Error("Response lost");
              }
              return operations.get(args.input.operationId);
            }
            if (args.action === "migration-preview")
              return {
                migrationHash: "a".repeat(64),
                proposed: policies,
                policyRevision: catalog.policyRevision,
                previous: {
                  project: { governed: true, policy: catalog.policy },
                  members: [{ user_id: "member", role: "member" }],
                  memberRules: [],
                  resourceRules: [],
                  pending: [],
                },
              };
            if (args.action === "member-role") {
              members.find((member) => member.id === args.input.userId)!.role =
                args.input.role;
              catalog.policyRevision++;
              return { ok: true };
            }
            if (args.action === "remove-member") {
              catalog.members = catalog.members.filter(
                (member) => member.id !== args.input.userId,
              );
              catalog.policyRevision++;
              return { ok: true };
            }
            return {};
          }
          if (
            command === "cloud_action" &&
            args.action === "invite-capabilities"
          )
            return { email: options.emailInvites ?? false };
          if (
            command === "cloud_action" &&
            args.action === "invite" &&
            args.input?.email
          ) {
            if (options.failEmailInvite)
              throw new Error(
                "Invitation email could not be sent. Try again or use a joining link.",
              );
            if (options.emailInviteError) throw options.emailInviteError;
            catalog.pendingInvites = [
              ...(catalog.pendingInvites ?? []).filter(
                (invite) => invite.email !== args.input.email,
              ),
              {
                email: args.input.email,
                expiresAt: new Date(Date.now() + 86400000).toISOString(),
              },
            ];
            return { sent: true, email: args.input.email };
          }
          if (command === "cloud_action" && args.action === "revoke-invite") {
            if (options.revokeMissing) throw "404: Not found";
            catalog.pendingInvites = (catalog.pendingInvites ?? []).filter(
              (invite) => invite.email !== args.input.email,
            );
            return { email: args.input.email, revoked: 1 };
          }
          if (command === "cloud_action" && args.action === "invite")
            return {
              token: "join-once",
              url: "https://test.orka/join/join-once",
            };
          if (command === "project_command") {
            const restoreWindowDays = options.projectRestoreWindowDays ?? 7;
            if (args.action === "capabilities") {
              if (controls.failDeletionCapabilities) throw new Error("Offline");
              return {
                softDelete: options.olderService ? 0 : 1,
                projectRestoreWindowDays: restoreWindowDays,
              };
            }
            if (args.action === "list")
              return { supported: true, projects: structuredClone(projects) };
            const project = (projects.find(
              (project) => project.id === args.input.projectId,
            ) ??
              deletedProjects.find(
                (project) => project.id === args.input.projectId,
              ) ??
              archivedProjects.find(
                (project) => project.id === args.input.projectId,
              ))! as any;
            if (args.action === "delete" || args.action === "purge") {
              const deletedAt = "2026-01-01T00:00:00Z";
              const purgeAfter = new Date(
                Date.parse(deletedAt) + restoreWindowDays * 86400_000,
              ).toISOString();
              if (options.queued)
                throw new Error(
                  "Sync queued changes and finish pending ENV publications before deleting this project",
                );
              if (args.input.confirmation !== project.name)
                throw new Error("Type the project name to confirm deletion");
              if (args.action === "delete") {
                projects.splice(
                  projects.findIndex(
                    (item) => item.id === args.input.projectId,
                  ),
                  1,
                );
                deletedProjects.push({
                  ...project,
                  deletedAt,
                  purgeAfter,
                });
              } else {
                deletedProjects.splice(
                  deletedProjects.findIndex(
                    (item) => item.id === args.input.projectId,
                  ),
                  1,
                );
              }
              return {
                ok: true,
                purgeAfter: args.action === "delete" ? purgeAfter : null,
              };
            }
            if (args.action === "leave") {
              if (options.queued)
                throw new Error(
                  "Sync queued changes and finish pending ENV publications before leaving this project",
                );
              Object.assign(project, {
                revoked: true,
                detachedAt: "2026-01-01T00:00:00Z",
              });
              return { ok: true };
            }
            if (args.action === "archive") {
              archivedProjects.push({
                ...project,
                archivedAt: "2026-01-01T00:00:00Z",
                lifecycleRevision: (project.lifecycleRevision ?? 0) + 1,
              });
              projects.splice(
                projects.findIndex((item) => item.id === args.input.projectId),
                1,
              );
              return { ok: true };
            }
            if (args.action === "restore") {
              if (controls.restoreError) throw new Error(controls.restoreError);
              const bucket = deletedProjects.some(
                (item) => item.id === args.input.projectId,
              )
                ? deletedProjects
                : archivedProjects;
              const index = bucket.findIndex(
                (item) => item.id === args.input.projectId,
              );
              if (index >= 0) {
                const restored = bucket.splice(index, 1)[0];
                delete restored.deletedAt;
                delete restored.purgeAfter;
                delete restored.archivedAt;
                projects.push(restored as (typeof projects)[number]);
              }
              return { ok: true };
            }
            if (args.action === "rename") {
              if (options.failRename && !failedRename) {
                failedRename = true;
                throw new Error("Service unavailable. Try again.");
              }
              project.name = args.input.name;
              project.lifecycleRevision++;
            }
            if (args.action === "reset-source-remote") {
              const source = project.sources.find(
                (source: { id: string }) => source.id === args.input.sourceId,
              );
              if (!source) throw new Error("Source not found");
              Object.assign(source, {
                remoteKey: null,
                folderState: "connected",
              });
            }
            if (args.action === "remove-source") {
              if (options.failSourceRemoval)
                throw new Error("Service unavailable. Try again.");
              const source = project.sources.find(
                (source: { id: string }) => source.id === args.input.sourceId,
              )!;
              Object.assign(source, {
                removedAt: "2026-11-13T00:00:00Z",
                path: null,
              });
            }
            if (args.action === "local_name")
              Object.assign(project, { localName: args.input.name });
            if (args.action === "sharing") {
              if (options.failSharing && !failedSharing) {
                failedSharing = true;
                throw new Error("Service unavailable. Try again.");
              }
              project.sharing = args.input.sharing;
            }
          }
          if (command === "configure") state.config = args.config;
          if (command === "background_agent") {
            if (options.failBackground && !failedBackground) {
              failedBackground = true;
              throw new Error("Couldn’t change startup. Try again.");
            }
            state.background = args.enabled;
          }
          if (command === "connect_project_sources") {
            const project = projects.find((project) => project.id === args.id)!;
            project.path = args.paths[0];
            const source =
              project.sources.find((source) => source.id === args.sourceId) ??
              project.sources[0];
            source.path = args.paths[0];
            source.folderState = "connected";
          }
          if (command === "disconnect_project_source") {
            const project = projects.find((project) => project.id === args.id)!;
            project.sources.find(
              (source) => source.id === args.sourceId,
            )!.path = null;
            project.path = null;
          }
          if (command === "disconnect_project")
            projects.find((project) => project.id === args.id)!.path = null;
          if (command === "start_source_sync") {
            const project = projects.find((project) => project.id === args.id)!;
            const source = project.sources.find(
              (source) => source.id === args.sourceId,
            ) as { syncStartsAt?: string | null } | undefined;
            if (source) source.syncStartsAt = null;
          }
          if (command === "switch_service") {
            if (controls.failSwitch)
              throw new Error("Service changed during validation. Try again.");
            state.config = args.config;
            state.user = "";
          }
          if (command === "sign_out") state.user = "";
          return {};
        },
      },
    });
  }, options);
  await page.goto(options.debug ? "/?skullet-debug" : "/");
  const settings = page.getByRole("region", { name: "Settings", exact: true });
  if (options.openSettings === false) return settings;
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(settings).toBeVisible();
  // Project settings specs use General as their starting point.
  if (!options.noProjects)
    await settings
      .getByRole("button", { name: "General", exact: true })
      .click();
  return settings;
}
export const settingsCalls = (page: Page) =>
  page.evaluate(
    () => (window as any).settingsCalls as { command: string; args: any }[],
  );
