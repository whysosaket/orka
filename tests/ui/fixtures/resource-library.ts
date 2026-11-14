import { expect, type Page } from "@playwright/test";
import type { ProjectResource } from "../../../apps/mac/src/types.js";

export interface LibraryState {
  user: string;
  apiUrl: string;
  calls: { command: string; args: Record<string, unknown> }[];
  failCatalog: boolean;
  deferCatalog: boolean;
  finishCatalog?: () => void;
  finishCatalogs: (() => void)[];
  tail: number;
  syncMinutes: number;
}

export type LibraryWindow = Window & { library: LibraryState };

export async function resourceLibraryFixture(
  page: Page,
  options: {
    emptyShared?: boolean;
    emptyLocal?: boolean;
    defer?: boolean;
    restricted?: boolean;
    withoutRepositories?: boolean;
    teammateAvatar?: string;
  } = {},
) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript((options) => {
    const library: LibraryState = {
      user: "user",
      apiUrl: "https://library.example",
      calls: [],
      failCatalog: false,
      deferCatalog: options.defer ?? false,
      finishCatalogs: [],
      tail: 0,
      syncMinutes: 1,
    };
    const resource = (
      kind: "memory" | "session" | "plan",
      id: string,
      title: string,
      owner: string,
      extra: Partial<ProjectResource> = {},
    ): ProjectResource => ({
      resourceId: `${kind}-${id}`,
      projectId: "project",
      sourceId: "desktop",
      kind,
      source: "codex",
      logicalPath: `codex/${kind}-${id}`,
      title,
      files: [
        {
          path: kind === "session" ? "session.jsonl" : "content.md",
          hash: `${kind}-${id}`,
          size: 20,
          executable: false,
        },
      ],
      deleted: false,
      hash: `${kind}-${id}`,
      revision: 3,
      owner,
      updatedBy: owner,
      updatedAt: "2026-11-12T10:00:00Z",
      ...extra,
    });
    const shared = options.emptyShared
      ? []
      : (["memory", "session", "plan"] as const).flatMap((kind) => [
          resource(kind, "own", `My shared ${kind}`, "user", {
            updatedBy: "mira",
          }),
          resource(kind, "teammate", `Mira's ${kind}`, "mira", {
            updatedBy: "user",
            source: "claude",
          }),
        ]);
    const local = (kind: "memory" | "session" | "plan") =>
      options.emptyLocal
        ? []
        : [
            resource(kind, "local", `Private ${kind} notes`, "user", {
              local: true,
              revision: 0,
              files: [
                {
                  path: kind === "session" ? "session.jsonl" : "content.md",
                  hash: `private-${library.tail}`,
                  size: 20,
                  executable: false,
                },
              ],
            }),
            resource(kind, "backend", `Backend ${kind} notes`, "user", {
              local: true,
              revision: 0,
              sourceId: "backend",
              source: "claude",
            }),
            ...shared
              .filter((item) => item.kind === kind && item.owner === "user")
              .map((item) => ({
                ...item,
                localChanges: true,
                sharedRevision: item.revision,
              })),
          ];
    Object.assign(window, {
      library,
      isTauri: true,
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        unregisterCallback: () => {},
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          library.calls.push({ command, args });
          if (command === "snapshot")
            return {
              user: library.user,
              accountProfile: {
                displayName: "Alex",
                avatarData:
                  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='28' height='28'%3E%3Crect width='28' height='28' fill='%233c4862'/%3E%3Ccircle cx='14' cy='11' r='5' fill='%23c0cadc'/%3E%3Cellipse cx='14' cy='27' rx='10' ry='11' fill='%23c0cadc'/%3E%3C/svg%3E",
              },
              config: {
                apiUrl: library.apiUrl,
                syncMinutes: library.syncMinutes,
              },
              projects: [
                {
                  id: "project",
                  name: "Library",
                  role: options.restricted ? "member" : "owner",
                  governed: options.restricted,
                  sharing: {
                    memory: false,
                    session: false,
                    plan: false,
                    skill: false,
                    env: false,
                  },
                  path: options.withoutRepositories
                    ? "/synthetic/library/desktop"
                    : undefined,
                  sources: options.withoutRepositories
                    ? undefined
                    : [
                        {
                          id: "desktop",
                          name: "desktop",
                          path: "/synthetic/library/desktop",
                          folderState: "connected",
                        },
                        {
                          id: "backend",
                          name: "backend",
                          path: "/synthetic/library/backend",
                          folderState: "connected",
                        },
                      ],
                },
              ],
              resources: shared,
              governance: [
                {
                  projectId: "project",
                  catalog: {
                    access: options.restricted
                      ? {
                          memory: { mode: "hidden" },
                          session: { mode: "hidden" },
                          plan: { mode: "hidden" },
                        }
                      : {},
                    members: [
                      {
                        id: "mira",
                        role: "member",
                        name: "Mira",
                        avatarUrl: options.teammateAvatar,
                      },
                    ],
                  },
                },
              ],
              bindings: [],
              conflicts: [],
              activity: [],
              outbox: [],
              errors: [],
              sync: { online: false },
              daemon: { running: true },
              devices: [],
              deviceId: "mac",
              background: true,
            };
          if (command === "sync_progress")
            return { user: library.user, progress: null };
          if (command === "local_resource_catalog") {
            if (library.failCatalog)
              throw new Error("Local folder temporarily unavailable");
            const result = {
              resources: local(args.kind as "memory" | "session" | "plan"),
              errors: [],
            };
            if (library.deferCatalog)
              return new Promise((resolve) => {
                library.finishCatalog = () => resolve(result);
                library.finishCatalogs.push(library.finishCatalog);
              });
            return result;
          }
          if (command === "session_display_title") return null;
          if (command === "session_messages")
            return {
              messages: [
                {
                  index: 0,
                  role: "user",
                  text: `Private session conversation ${library.tail}`,
                },
              ],
              total: 1,
              offset: 0,
            };
          if (command === "inspect_resource")
            return {
              content:
                "# Private project notes\nLocal content remains readable offline.",
              previous: null,
              paths: ["/synthetic/library/content.md"],
            };
          if (command === "session_launch_options")
            return { options: [], default: null };
          if (command.startsWith("plugin:")) return null;
          return {};
        },
      },
    });
  }, options);
  await page.goto("/");
  await expect(
    page.getByRole("combobox", { name: "Select project", exact: true }),
  ).toBeVisible();
}
