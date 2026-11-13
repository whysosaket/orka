import { expect, type Page } from "@playwright/test";

export interface MetadataState {
  held: boolean;
  failIds: string[];
  nullTitles: string[];
  finishes: Record<string, () => void>;
  calls: { command: string; id?: string }[];
}
export type MetadataWindow = Window & { metadata: MetadataState };

/** Real Home and Skills components with their native metadata reads held. */
export async function metadataLoadingFixture(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    const metadata: MetadataState = {
      held: true,
      failIds: [],
      nullTitles: [],
      finishes: {},
      calls: [],
    };
    const resources = Array.from({ length: 6 }, (_, index) => {
      const kind = index % 2 === 0 ? "skill" : "session";
      return {
        resourceId: `${kind}-${Math.floor(index / 2) + 1}`,
        projectId: "project",
        kind,
        source: index < 3 ? "codex" : "claude",
        title: `${kind === "skill" ? "Review skill" : "Project session"} ${Math.floor(index / 2) + 1}`,
        logicalPath: `${kind}/${index}`,
        revision: 1,
        deleted: false,
        owner: "user",
        updatedBy: "user",
        updatedAt: new Date(
          Date.UTC(2026, 10, 14, 10, 0, 0) - index * 60_000,
        ).toISOString(),
        files: [
          {
            path: kind === "skill" ? "SKILL.md" : "session.jsonl",
            hash: `${kind}-${index}`,
            size: 100,
            executable: false,
          },
        ],
      };
    });
    Object.assign(window, {
      metadata,
      isTauri: true,
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        unregisterCallback: () => {},
        invoke: async (command: string, args: { id?: string } = {}) => {
          metadata.calls.push({ command, id: args.id });
          if (command === "snapshot")
            return {
              user: "user",
              config: { apiUrl: "https://metadata.example", syncMinutes: 15 },
              projects: [
                {
                  id: "project",
                  name: "Interface",
                  path: "/synthetic/interface",
                  role: "owner",
                },
              ],
              resources,
              localSkills: [],
              governance: [
                { projectId: "project", catalog: { access: {}, members: [] } },
              ],
              bindings: [],
              conflicts: [],
              activity: [],
              outbox: [],
              errors: [],
              sync: { online: false },
              daemon: { running: false },
              devices: [],
              deviceId: "mac",
              background: false,
            };
          if (
            (command === "inspect_resource" ||
              command === "session_display_title") &&
            args.id
          ) {
            const id = args.id;
            const result =
              command === "session_display_title"
                ? `Session decisions ${id.at(-1)}`
                : {
                    content:
                      id === "skill-3"
                        ? "# Skill without description"
                        : `---\nname: Interface review ${id.at(-1)}\ndescription: Review spacing, typography, and interaction states.\n---\n# Review checklist`,
                    previous: null,
                    paths: [],
                  };
            if (metadata.held)
              return new Promise((resolve, reject) => {
                const earlier = metadata.finishes[id];
                metadata.finishes[id] = () => {
                  earlier?.();
                  if (metadata.failIds.includes(id))
                    reject(new Error("Metadata temporarily unavailable"));
                  else
                    resolve(
                      command === "session_display_title" &&
                        metadata.nullTitles.includes(id)
                        ? null
                        : result,
                    );
                };
              });
            return result;
          }
          if (command === "session_messages")
            return {
              messages: [
                {
                  index: 0,
                  role: "user",
                  text: "Review the actual project context.",
                },
              ],
              total: 1,
              offset: 0,
            };
          if (command === "local_resource_catalog")
            return { resources: [], errors: [] };
          if (command === "project_skill_usage")
            return { counts: {}, partial: false };
          if (command === "session_launch_options")
            return { options: [], default: null };
          if (command.startsWith("plugin:")) return null;
          return {};
        },
      },
    });
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Recent Updates", exact: true }),
  ).toBeVisible();
}
