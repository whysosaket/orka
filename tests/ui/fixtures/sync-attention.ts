import type { Page } from "@playwright/test";
import type { Snapshot } from "../../../apps/mac/src/types.js";

declare global {
  interface Window {
    attentionFixture: {
      state: Snapshot;
      calls: { name: string; args?: Record<string, unknown> }[];
    };
  }
}

/** Matched synthetic notification state for regression and before/after captures. */
export async function syncAttentionFixture(page: Page) {
  await page.addInitScript(() => {
    const resource = (
      id: string,
      title: string,
      kind: "skill" | "plan" | "session",
      projectId = "one",
    ) => ({
      resourceId: id,
      projectId,
      kind,
      title,
      source: "codex" as const,
      logicalPath: `${kind}/${id}`,
      revision: 3,
      owner: "user",
      updatedBy: "user",
      updatedAt: "2026-11-13T10:00:00Z",
      deleted: false,
      hash: "shared-hash",
      files: [
        {
          path:
            kind === "skill"
              ? "SKILL.md"
              : kind === "session"
                ? "session.jsonl"
                : "content.md",
          hash: "shared-file",
          size: 30,
          executable: false,
        },
      ],
    });
    const skill = resource("skill", "Writing guide", "skill");
    const plan = resource("plan", "Release checklist", "plan");
    const session = resource("session", "Implementation session", "session");
    const copy = resource("copy", "Implementation session (copy)", "session");
    const request = (
      id: string,
      title: string,
      status: "pending" | "approved",
      canReview: boolean,
      resourceId: string,
    ) => ({
      id,
      title,
      status,
      canReview,
      resourceId,
      projectId: "one",
      author: "user",
      type: "change" as const,
      unread: true,
      baseRevision: 2,
      policyRevision: 1,
      previewHash: "preview",
      createdAt: "2026-11-12T10:00:00Z",
    });
    const fixture: Window["attentionFixture"] = {
      calls: [],
      state: {
        user: "user",
        config: { apiUrl: "https://fixture.invalid", syncMinutes: 15 },
        projects: [
          {
            id: "one",
            name: "Product",
            path: "/synthetic/product",
            role: "owner",
            governed: true,
          },
          { id: "two", name: "Docs", path: "/synthetic/docs", role: "owner" },
        ],
        resources: [
          skill,
          plan,
          session,
          copy,
          resource("foreign-plan", "Docs migration", "plan", "two"),
        ],
        bindings: [
          {
            resourceId: "skill",
            projectId: "one",
            installationState: "locally_modified",
            availableRevision: 3,
            paths: [
              "/synthetic/product/.agents/skills/writing",
              "/synthetic/product/.claude/skills/writing",
            ],
          },
        ],
        drafts: [
          {
            id: "local",
            projectId: "one",
            resource: {
              ...skill,
              files: [
                {
                  path: "SKILL.md",
                  hash: "local-file",
                  size: 30,
                  executable: false,
                },
              ],
            },
            status: "local",
            createdAt: "2026-11-13T11:00:00Z",
          },
          {
            id: "archived",
            projectId: "one",
            resource: {
              ...skill,
              title: "Earlier writing guide",
              files: [
                {
                  path: "SKILL.md",
                  hash: "archived-file",
                  size: 20,
                  executable: false,
                },
              ],
            },
            status: "dismissed",
            dismissalReason: "superseded",
            createdAt: "2026-11-10T10:00:00Z",
          },
        ],
        reviewRequests: [
          request("pending", "Writing guide", "pending", true, "skill"),
          request(
            "approved",
            "Project setup notes",
            "approved",
            true,
            "old-notes",
          ),
          request(
            "waiting",
            "Proposed team guide",
            "pending",
            false,
            "waiting-guide",
          ),
        ],
        errors: [
          {
            source: "skill",
            error:
              "Local skill edits preserved; resolve them before applying the shared update",
          },
          { source: "foreign-plan", error: "403: Docs access changed" },
        ],
        outbox: [
          {
            id: "plan-upload",
            project: "one",
            resourceId: "plan",
            title: plan.title,
            kind: "plan",
            error:
              "409: Resource changed; refresh and review the exact version again",
          },
          {
            id: "foreign-upload",
            project: "two",
            resourceId: "foreign-plan",
            title: "Docs migration",
            kind: "plan",
            error: "403: Docs access changed",
          },
        ],
        conflicts: [
          {
            id: "session-conflict",
            resourceId: "session",
            revision: 3,
            author: "teammate",
            deviceId: "other-device",
            candidate: {
              ...session,
              files: [
                {
                  path: "session.jsonl",
                  hash: "other-transcript",
                  size: 60,
                  executable: false,
                },
              ],
            },
          },
        ],
        activity: [
          {
            id: "copy-event",
            type: "session_copied",
            resourceId: "session",
            copyId: "copy",
            author: "teammate",
            notifyOwner: "user",
          },
        ],
        sync: { online: true, lastSync: "2026-11-13T12:00:00Z" },
        daemon: { running: true },
        devices: [],
        deviceId: "device",
        background: true,
      },
    };
    Object.assign(window, {
      attentionFixture: fixture,
      isTauri: true,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        unregisterCallback: () => {},
        invoke: async (name: string, args?: Record<string, unknown>) => {
          if (name === "snapshot") return fixture.state;
          if (name === "sync_progress") return { user: "user", progress: null };
          fixture.calls.push({ name, args });
          if (name.startsWith("plugin:")) return null;
          if (name === "governance_command") {
            const input = args?.input as Record<string, unknown> | undefined;
            if (args?.action === "catalog")
              return {
                owner: true,
                governed: true,
                policyRevision: 1,
                policy: {},
                access: {},
                members: [
                  { id: "user", role: "owner" },
                  { id: "teammate", role: "member" },
                ],
                memberRules: [],
                resourceRules: [],
                resourceCount: fixture.state.resources.length,
                requests:
                  fixture.state.reviewRequests?.filter(
                    (r) => r.projectId === input?.projectId,
                  ) ?? [],
              };
            if (args?.action === "draft") {
              const draft = fixture.state.drafts!.find(
                (d) => d.id === input?.id,
              )!;
              return {
                draft,
                files: {
                  "SKILL.md":
                    draft.id === "archived"
                      ? "# Preserved older instructions\n"
                      : "# Local instructions\n",
                },
                before: { "SKILL.md": "# Shared instructions\n" },
                related: [],
                canPublish: true,
                baseRevision: 3,
              };
            }
            if (args?.action === "request")
              return {
                request: fixture.state.reviewRequests!.find(
                  (r) => r.id === input?.id,
                ),
                files: { "SKILL.md": "# Reviewed instructions\n" },
                before: {},
              };
          }
          if (name === "inspect_resource")
            return {
              content:
                "---\nname: writing-guide\ndescription: Shared writing guidance\n---\n# Writing guide\n",
              previous: null,
              paths: [],
            };
          if (name === "skill_usage") return { items: [], partial: false };
          if (name === "session_display_title") return "Implementation session";
          if (name === "list_local_resources")
            return { items: [], nextOffset: null };
          return {};
        },
      },
    });
  });
}
