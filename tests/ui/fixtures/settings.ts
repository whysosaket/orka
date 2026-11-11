import { expect, type Page } from "@playwright/test";
export async function settingsFixture(
  page: Page,
  options: {
    noProjects?: boolean;
    emailInvites?: boolean;
    failEmailInvite?: boolean;
    update?: {
      installedVersion: string;
      update?: { version: string; notes: string; sha256: string };
    };
    updateInstallError?: string;
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
    cancelPicker?: boolean;
    folderState?: "connected" | "reconnect" | "locate";
    sourceRows?: {
      id: string;
      name: string;
      path: string | null;
      folderState: "connected" | "reconnect" | "locate";
    }[];
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
            role: "member",
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
      failRefresh: options.failInitial ?? false,
      failService: false,
      failSwitch: false,
      policyFailure: options.policyFailure ?? "",
      delay: options.delay ?? 0,
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
          if (command === "snapshot") return structuredClone(state);
          if (command === "sync_progress")
            return { user: state.user, progress: null };
          calls.push({ command, args: structuredClone(args) });
          if (command === "update_status") return options.update;
          if (command === "update_install" && options.updateInstallError)
            throw options.updateInstallError;
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
                : { rolePolicies: 1, policyOperations: 1 };
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
            return { sent: true, email: args.input.email };
          }
          if (command === "cloud_action" && args.action === "invite")
            return {
              token: "join-once",
              url: "https://test.orka/join/join-once",
            };
          if (command === "project_command") {
            if (args.action === "list")
              return { supported: true, projects: structuredClone(projects) };
            const project = projects.find(
              (project) => project.id === args.input.projectId,
            )!;
            if (args.action === "rename") {
              if (options.failRename && !failedRename) {
                failedRename = true;
                throw new Error("Service unavailable. Try again.");
              }
              project.name = args.input.name;
              project.lifecycleRevision++;
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
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("region", { name: "Settings", exact: true });
  await expect(settings).toBeVisible();
  return settings;
}
export const settingsCalls = (page: Page) =>
  page.evaluate(
    () => (window as any).settingsCalls as { command: string; args: any }[],
  );
