import { test, expect, type Page } from "@playwright/test";
import type { FileManifestEntry } from "../../apps/mac/src/components/diff-model.js";
import {
  defaultProjectRules,
  type ClassRule,
  type ProjectRules,
} from "@portable/protocol";

// Saved policies are independent of the defaults for newly created projects.
const savedProjectRules: ProjectRules = {
  instructions: { mode: "suggest", create: "suggest", canShare: false },
  memory: { mode: "suggest", create: "suggest", canShare: false },
  skill: { mode: "suggest", create: "suggest", canShare: false },
  plan: { mode: "suggest", create: "suggest", canShare: false },
  session: { mode: "suggest", create: "suggest", canShare: false },
  env: defaultProjectRules.env,
};

async function fixture(
  page: Page,
  governed = true,
  removed = false,
  mode = "owner",
  envData = false,
  review: {
    before?: Record<string, string>;
    files?: Record<string, string>;
    baseRevision?: number;
    beforeManifest?: FileManifestEntry[];
    manifest?: FileManifestEntry[];
    sourceUnavailable?: boolean;
  } = {},
) {
  await page.addInitScript(
    ({ rules, governed, removed, mode, envData, review }) => {
      const isMember = mode === "member" || mode === "restricted";
      const instructions = mode === "instructions";
      const file = instructions ? "CLAUDE.md" : "SKILL.md";
      const resource = {
        resourceId: instructions ? "instructions" : "skill",
        projectId: "project",
        kind: instructions ? "memory" : "skill",
        source: "shared",
        logicalPath: instructions ? "instructions/CLAUDE.md" : "sample",
        title: instructions ? "Project instructions" : "Sample skill",
        revision: 2,
        owner: "owner",
        updatedBy: "owner",
        updatedAt: "2026-10-18T00:00:00Z",
        files: [{ path: file, hash: "fixture", size: 16, executable: false }],
        deleted: removed,
      };
      const localDraft = {
        id: "local-memory",
        projectId: "project",
        resource: {
          ...resource,
          kind: "memory",
          title: "Saved learning",
          files: Object.entries(
            review.files ?? { "content.md": "Saved learning\n" },
          ).map(([path, content]) => ({
            path,
            hash: "fixture",
            size: content.length,
            executable: false,
          })),
        },
        paths: [],
        status: "local",
        createdAt: "2026-10-18T00:00:00Z",
      };
      const project = {
        id: "project",
        name: "Team \u2014 project",
        path: "/synthetic/project",
        role: isMember ? "member" : "owner",
        governed,
        sharing: {
          memory: true,
          skill: true,
          session: true,
          plan: true,
          env: envData,
        },
      };
      const request = {
        id: "request",
        projectId: "project",
        author: "member",
        type: "change",
        resourceId: "skill",
        title: "Sample skill",
        status: "pending",
        baseRevision: 1,
        policyRevision: 1,
        previewHash: "reviewed-hash",
        createdAt: "2026-10-18T00:00:00Z",
        canReview: true,
        unread: true,
      };
      const envRequests = envData
        ? Array.from({ length: 7 }, (_, index) => ({
            ...request,
            id: `env-request-${index}`,
            type: "access",
            requestedClass: "env",
            title: "ENV sets access request",
          }))
        : [];
      const catalog = {
        owner: !isMember,
        governed,
        policyRevision: governed ? 1 : 0,
        policy: rules,
        access: Object.fromEntries(
          Object.entries(rules).map(([key, rule]) => [
            key,
            { ...rule, mode: mode === "restricted" ? "hidden" : rule.mode },
          ]),
        ),
        members: [
          {
            id: "owner",
            role: "owner",
            ...(mode === "names" ? { name: "Saket Rao" } : {}),
          },
          {
            id: "member",
            role: "member",
            ...(mode === "names" ? { name: "Mira Shah" } : {}),
          },
        ],
        memberRules:
          mode === "mixed" || mode === "partial"
            ? [
                {
                  userId: "member",
                  class: "instructions",
                  rule: {
                    mode: "read",
                    create: "hidden",
                    canShare: false,
                  } as ClassRule,
                },
              ]
            : ([] as { userId: string; class: string; rule: ClassRule }[]),
        resourceRules: [
          {
            resourceId: "skill",
            userId: "member",
            rule: { mode: "read", canShare: false },
          },
        ],
        resourceCount: 1,
        envSets: envData
          ? [{ resourceId: "env-set", title: "Private ENV set" }]
          : [],
        requests: [
          ...envRequests,
          ...(mode === "many"
            ? Array.from({ length: 12 }, (_, index) => ({
                ...request,
                id: `request-${index}`,
                title: `Request ${index + 1}`,
              }))
            : [request]),
        ],
      };
      const calls: { command: string; args: Record<string, unknown> }[] = [];
      Object.assign(window, {
        governanceCalls: calls,
        governanceStale: false,
        pendingEnvLink: null,
        governanceBump: () => {
          catalog.policyRevision++;
        },
        isTauri: true,
        __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
        __TAURI_INTERNALS__: {
          transformCallback: () => 1,
          unregisterCallback: () => {},
          invoke: async (
            command: string,
            args: { action?: string; input?: Record<string, unknown> } = {},
          ) => {
            if (command === "snapshot")
              return {
                user: isMember ? "member" : "owner",
                config: { apiUrl: "https://fixture.invalid", syncMinutes: 15 },
                projects:
                  mode === "multi-project"
                    ? [
                        project,
                        {
                          ...project,
                          id: "second",
                          name: "Second project",
                          path: "/synthetic/second",
                        },
                      ]
                    : [project],
                resources: mode === "restricted" ? [] : [resource],
                governance: [
                  { projectId: "project", catalog: { access: catalog.access } },
                ],
                bindings: [
                  {
                    base: { ...resource, revision: 1 },
                    installationState: "update_available",
                  },
                ],
                conflicts: [],
                activity: [],
                outbox: [],
                errors: [],
                sync: { online: true },
                daemon: { running: true },
                devices: [],
                deviceId: "fixture",
                background: true,
                drafts: mode.startsWith("draft-") ? [localDraft] : [],
                reviewRequests: [...envRequests, request],
              };
            if (command === "sync_progress")
              return { user: "owner", progress: null };
            calls.push({ command, args });
            if (command === "profile_events") {
              const w = window as any;
              const link = w.pendingEnvLink;
              w.pendingEnvLink = null;
              return link;
            }
            if (command === "plugin:deep-link|get_current" && envData)
              return ["orka://env/project/env-set"];
            if (command.startsWith("plugin:")) return null;
            if (command === "governance_command")
              switch (args.action) {
                case "logs":
                  if (mode === "paginated-logs")
                    return {
                      items: [
                        args.input?.before
                          ? {
                              id: "older-log",
                              at: "2026-10-18T00:00:00Z",
                              action: "member.joined",
                              actorName: "Mira Shah",
                            }
                          : {
                              id: "latest-log",
                              at: "2026-10-19T00:00:00Z",
                              action: "request.approved",
                              actorName: "Saket Rao",
                              subjectName: "Mira Shah",
                            },
                      ],
                      next: args.input?.before ? null : "older-logs",
                    };
                  return {
                    items:
                      envData && !args.input?.before
                        ? [
                            {
                              id: "env-log",
                              at: "2026-10-19T00:00:00Z",
                              action: "env.replaced",
                              actorName: "Owner",
                            },
                            {
                              id: "env-policy-log",
                              at: "2026-10-19T00:00:00Z",
                              action: "permissions.updated",
                              category: "env",
                              actorName: "Owner",
                            },
                          ]
                        : [
                            {
                              id: "1",
                              at: "2026-10-19T00:00:00Z",
                              action: "request.approved",
                              actorName: "Saket Rao",
                              subjectName: "Mira Shah",
                            },
                          ],
                    next: envData && !args.input?.before ? "next-page" : null,
                  };
                case "catalog":
                  if (mode === "held-catalog")
                    await new Promise<void>((resolve) => {
                      ((window as any).finishMemberLoads ??= []).push(resolve);
                    });
                  if (args.input?.projectId === "second")
                    return {
                      ...catalog,
                      requests: [
                        {
                          ...request,
                          id: "second-request",
                          projectId: "second",
                          title: "Second project request",
                        },
                      ],
                    };
                  return catalog;
                case "policy": {
                  const input = args.input!;
                  if (input.expectedPolicyRevision !== catalog.policyRevision)
                    throw new Error(
                      "Permissions changed; refresh and review again",
                    );
                  if (mode === "partial" && input.class === "memory")
                    throw new Error("Permissions changed during save");
                  if (input.userId) {
                    const existing = catalog.memberRules.find(
                      (item) =>
                        item.class === input.class &&
                        item.userId === input.userId,
                    );
                    if (existing) existing.rule = input.rule as ClassRule;
                    else
                      catalog.memberRules.push({
                        userId: String(input.userId),
                        class: String(input.class),
                        rule: input.rule as ClassRule,
                      });
                  } else
                    catalog.policy[input.class as keyof ProjectRules] =
                      input.rule as ClassRule;
                  catalog.policyRevision++;
                  return { policyRevision: catalog.policyRevision };
                }
                case "inherit":
                  catalog.memberRules = catalog.memberRules.filter(
                    (item) =>
                      !(
                        item.userId === args.input!.userId &&
                        item.class === args.input!.class
                      ),
                  );
                  catalog.policyRevision++;
                  return { policyRevision: catalog.policyRevision };
                case "request-access":
                  return { status: "pending" };
                case "draft":
                  return {
                    draft: localDraft,
                    files: review.files ?? { "content.md": "Saved learning\n" },
                    before: review.before,
                    baseRevision: review.baseRevision,
                    beforeManifest: review.beforeManifest,
                    manifest: review.manifest,
                    sourceUnavailable: review.sourceUnavailable,
                    related: [],
                    canPublish: mode === "draft-publisher",
                  };
                case "submit-draft":
                  if ((window as any).holdDraftSubmit)
                    await new Promise<void>((resolve) => {
                      (window as any).finishDraftSubmit = resolve;
                    });
                  if ((window as any).governanceStale)
                    throw new Error(
                      "The shared version changed. Review the changes again before publishing.",
                    );
                  return {
                    status: mode === "draft-publisher" ? "queued" : "pending",
                  };
                case "activate":
                  catalog.governed = true;
                  catalog.policy = args.input!.rules as ProjectRules;
                  catalog.policyRevision++;
                  project.governed = true;
                  return { governed: true };
                case "resource":
                  return {
                    access: { mode: "publish", canShare: true },
                    rules: [],
                  };
                case "request":
                  return {
                    request,
                    files: {
                      "SKILL.md": removed
                        ? "Previous version\n"
                        : "Reviewed candidate\n",
                    },
                    before: { "SKILL.md": "Previous version\n" },
                    content: { resource },
                  };
                case "read-notification":
                  request.unread = false;
                  return { ok: true };
                case "decide":
                  request.status = "stale";
                  return request;
                case "preview-install":
                  return {
                    token: "local-preview",
                    revision: 2,
                    dirty: true,
                    before: { [file]: "Local edits\n" },
                    after: removed
                      ? {}
                      : {
                          [file]: instructions
                            ? "Approved instructions\n"
                            : "Approved skill\n",
                        },
                  };
                case "apply-install":
                  if (
                    (window as unknown as { governanceStale: boolean })
                      .governanceStale
                  )
                    throw new Error(
                      "Local or shared files changed; review the update again",
                    );
                  return { status: "current" };
              }
            if (command === "inspect_resource")
              return { content: "# Sample skill\n", previous: null, paths: [] };
            return {};
          },
        },
      });
    },
    { rules: savedProjectRules, governed, removed, mode, envData, review },
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Members", exact: true }).click();
  await page.getByRole("button", { name: /Review pending requests/ }).click();
}

const management = (page: Page) =>
  page.getByRole("region", { name: "Manage", exact: true });

test("Settings Members opens activity logs, paginates, and returns to Members", async ({
  page,
}) => {
  await fixture(page, true, false, "paginated-logs");
  await management(page)
    .getByRole("button", { name: "Back to Members", exact: true })
    .click();
  const settings = page.getByRole("region", { name: "Settings", exact: true });
  await settings
    .getByRole("button", { name: "View logs", exact: true })
    .click();
  const logs = page.getByRole("region", { name: "Activity logs", exact: true });
  await expect(logs).toContainText("Saket Rao approved Mira Shah's request");
  await logs
    .getByRole("button", { name: "View more logs", exact: true })
    .click();
  await expect(logs).toContainText("Mira Shah joined the project");
  await expect(logs).toContainText("Saket Rao approved Mira Shah's request");
  await expect(
    logs.getByRole("button", { name: "View more logs", exact: true }),
  ).toHaveCount(0);
  expect(await calls(page, "logs")).toEqual([
    { projectId: "project", limit: 25 },
    { projectId: "project", limit: 25, before: "older-logs" },
  ]);
  await management(page)
    .getByRole("button", { name: "Back to Members", exact: true })
    .click();
  await expect(
    settings.getByRole("heading", { name: "Members", exact: true }),
  ).toBeVisible();
});

test("pending reviews remain reachable and expand without removing existing requests", async ({
  page,
}) => {
  await fixture(page, true, false, "many");
  const screen = management(page);
  await expect(
    screen.getByRole("heading", { name: "Pending reviews", exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByRole("button", { name: "Review request", exact: true }),
  ).toHaveCount(5);
  await screen
    .getByRole("button", { name: "View more requests", exact: true })
    .click();
  await expect(
    screen.getByRole("button", { name: "Review request", exact: true }),
  ).toHaveCount(10);
  await screen
    .getByRole("button", { name: "View more requests", exact: true })
    .click();
  await expect(
    screen.getByRole("button", { name: "Review request", exact: true }),
  ).toHaveCount(12);
  await expect(
    screen.getByRole("button", { name: "Requests", exact: true }),
  ).toHaveCount(0);
  await screen
    .getByRole("button", { name: "Back to Members", exact: true })
    .click();
  await expect(
    page
      .getByRole("region", { name: "Settings", exact: true })
      .getByRole("heading", { name: "Members", exact: true }),
  ).toBeVisible();
});

test("switching projects keeps pending reviews and returns to Settings Members", async ({
  page,
}) => {
  await fixture(page, true, false, "multi-project");
  const screen = management(page);
  for (const [projectName, requestTitle] of [
    ["Second project", "Second project request"],
    ["Team · project", "Sample skill"],
  ]) {
    await page
      .getByRole("combobox", { name: "Select project", exact: true })
      .click();
    await page.getByRole("option", { name: projectName, exact: true }).click();
    await expect(
      screen.getByRole("heading", { name: "Pending reviews", exact: true }),
    ).toBeVisible();
    await expect(screen).toContainText(requestTitle);
    await expect(
      screen.getByRole("button", {
        name: "Default member permissions",
        exact: true,
      }),
    ).toHaveCount(0);
  }
  await screen
    .getByRole("button", { name: "Back to Members", exact: true })
    .click();
  await expect(
    page
      .getByRole("region", { name: "Settings", exact: true })
      .getByRole("heading", { name: "Members", exact: true }),
  ).toBeVisible();
});

async function calls(page: Page, action: string) {
  return page.evaluate(
    (action) =>
      (
        window as unknown as {
          governanceCalls: {
            args: { action?: string; input?: Record<string, unknown> };
          }[];
        }
      ).governanceCalls
        .filter((item) => item.args.action === action)
        .map((item) => item.args.input),
    action,
  );
}
async function openUpdates(page: Page, name = "Review local update") {
  await management(page)
    .getByRole("button", { name: "Review update", exact: true })
    .click();
  return page.getByRole("dialog", { name, exact: true });
}

for (const publisher of [true, false]) {
  test(`local memory ${publisher ? "publishes directly" : "requests publisher approval"}`, async ({
    page,
  }) => {
    await fixture(
      page,
      true,
      false,
      publisher ? "draft-publisher" : "draft-suggester",
    );
    const local = management(page).getByRole("region", {
      name: "Local changes",
    });
    await local
      .getByRole("button", { name: "Review changes", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Review changes",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("File changes")).toContainText(
      "Saved learning",
    );
    await expect(dialog.locator(".diff-count--added")).toContainText("+1");
    await expect(
      dialog.getByRole("heading", { name: "content.md", exact: true }),
    ).toBeVisible();
    await dialog
      .getByRole("button", {
        name: publisher ? "Publish update" : "Send for approval",
        exact: true,
      })
      .click();
    expect(await calls(page, "submit-draft")).toEqual([
      {
        projectId: "project",
        id: "local-memory",
        reviewedFiles: [
          { path: "content.md", hash: "fixture", size: 15, executable: false },
        ],
      },
    ]);
  });
}
test("local review compares the accepted version with additions and removals in a bounded modal", async ({
  page,
}) => {
  await page.setViewportSize({ width: 820, height: 600 });
  await fixture(page, true, false, "draft-publisher", false, {
    baseRevision: 3,
    before: {
      "content.md": "Original learning\n",
      "removed.md": "Old learning\n",
    },
    files: { "content.md": "Saved learning\n", "added.md": "New learning\n" },
  });
  await management(page)
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Review changes",
    exact: true,
  });
  await expect(dialog.getByLabel("Compared versions")).toHaveText(
    "Version 3tocompared withThis Mac",
  );
  await expect(dialog.locator(".diff-card-path")).toHaveText([
    "content.md",
    "removed.md",
    "added.md",
  ]);
  await expect(
    dialog
      .getByRole("region", { name: "content.md changes", exact: true })
      .getByLabel("File changes"),
  ).toContainText("Original learning");
  await expect(
    dialog
      .getByRole("region", { name: "removed.md changes", exact: true })
      .getByLabel("File changes"),
  ).toContainText("Old learning");
  await expect(dialog.locator(".diff-card-removed")).toHaveText("Removed");
  await expect(
    dialog.getByRole("button", { name: "Publish update", exact: true }),
  ).toBeInViewport();
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(24);
  expect(bounds!.y).toBeGreaterThanOrEqual(24);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(576);
});

test("local review keeps a readable diff when modern renderer features are unavailable", async ({
  page,
}) => {
  const adapterRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/src/components/pierre-diff.tsx"))
      adapterRequests.push(request.url());
  });
  await page.addInitScript(() => {
    const supports = CSS.supports.bind(CSS);
    CSS.supports = ((...args: string[]) =>
      args.some((argument) => argument.includes("light-dark("))
        ? false
        : Reflect.apply(supports, CSS, args)) as typeof CSS.supports;
  });
  await fixture(page, true, false, "draft-publisher", false, {
    before: { "content.md": "Original learning\n" },
    baseRevision: 3,
  });
  await management(page)
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Review changes",
    exact: true,
  });
  const diff = dialog.getByRole("group", { name: "File changes", exact: true });
  await expect(diff).toContainText("Original learning");
  await expect(diff).toContainText("Saved learning");
  await expect(diff.getByLabel("Removed", { exact: true })).toHaveText("−");
  await expect(diff.getByLabel("Added", { exact: true })).toHaveText("+");
  await expect(dialog.locator("diffs-container")).toHaveCount(0);
  expect(adapterRequests).toEqual([]);
});

test("local review includes executable-only changes and distinguishes binary assets from literal text", async ({
  page,
}) => {
  await fixture(page, true, false, "draft-publisher", false, {
    before: { "run.sh": "echo hello\n", "image.bin": "Binary asset" },
    files: {
      "run.sh": "echo hello\n",
      "image.bin": "Binary asset",
      "literal.txt": "Binary asset",
    },
    beforeManifest: [
      { path: "run.sh", hash: "fixture", executable: false, binary: false },
      { path: "image.bin", hash: "binary", binary: true },
    ],
    manifest: [
      { path: "run.sh", hash: "fixture", executable: true, binary: false },
      { path: "image.bin", hash: "binary", binary: true },
      { path: "literal.txt", hash: "literal", binary: false },
    ],
    baseRevision: 3,
  });
  await management(page)
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Review changes",
    exact: true,
  });
  await expect(dialog.locator(".diff-card-path")).toHaveText([
    "run.sh",
    "literal.txt",
  ]);
  await expect(
    dialog.getByText("Executable permission added.", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog
      .getByRole("region", { name: "literal.txt changes", exact: true })
      .getByLabel("File changes"),
  ).toContainText("Binary asset");
  await expect(
    dialog.getByText("No file changes.", { exact: true }),
  ).toHaveCount(0);
});

test("a removed source keeps its saved preview readable and private", async ({
  page,
}) => {
  await fixture(page, true, false, "draft-publisher", false, {
    sourceUnavailable: true,
    baseRevision: 2,
    before: { "content.md": "Earlier learning\n" },
  });
  await management(page)
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Review changes",
    exact: true,
  });
  await expect(
    dialog.getByRole("status").filter({
      hasText: "This source is no longer available in this project.",
    }),
  ).toContainText("The saved changes remain private on this Mac.");
  await expect(
    dialog.getByRole("group", { name: "File changes", exact: true }),
  ).toContainText("Saved learning");
  await expect(
    dialog.getByRole("button", { name: "Publish update", exact: true }),
  ).toBeDisabled();
  expect(await calls(page, "submit-draft")).toEqual([]);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await calls(page, "dismiss")).toEqual([]);
});

test("closing local review restores focus without dismissing or publishing private changes", async ({
  page,
}) => {
  await fixture(page, true, false, "draft-publisher");
  const trigger = management(page).getByRole("button", {
    name: "Review changes",
    exact: true,
  });
  for (const close of ["Cancel", "Close review changes", "Escape"]) {
    await trigger.click();
    const dialog = page.getByRole("dialog", {
      name: "Review changes",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    if (close === "Escape") await page.keyboard.press("Escape");
    else await dialog.getByRole("button", { name: close, exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  }
  expect(await calls(page, "submit-draft")).toEqual([]);
  expect(await calls(page, "dismiss")).toEqual([]);
});

test("local publication failures remain visible beside the exact reviewed version", async ({
  page,
}) => {
  await fixture(page, true, false, "draft-publisher", false, {
    baseRevision: 3,
    before: { "content.md": "Original learning\n" },
  });
  await management(page)
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Review changes",
    exact: true,
  });
  await page.evaluate(() => {
    (window as any).governanceStale = true;
  });
  await dialog
    .getByRole("button", { name: "Publish update", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "The shared version changed. Review the changes again before publishing.",
  );
  await expect(dialog.getByLabel("Compared versions")).toContainText(
    "Version 3",
  );
  expect(await calls(page, "submit-draft")).toEqual([
    {
      projectId: "project",
      id: "local-memory",
      reviewedFiles: [
        { path: "content.md", hash: "fixture", size: 15, executable: false },
      ],
      reviewedRevision: 3,
    },
  ]);
});

test("an in-flight local publication keeps the review open and prevents duplicate submissions", async ({
  page,
}) => {
  await fixture(page, true, false, "draft-publisher");
  await management(page)
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Review changes",
    exact: true,
  });
  await page.evaluate(() => {
    (window as any).holdDraftSubmit = true;
  });
  await dialog
    .getByRole("button", { name: "Publish update", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: "Publish update", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  expect(await calls(page, "submit-draft")).toHaveLength(1);
  await page.evaluate(() => {
    (window as any).finishDraftSubmit();
  });
  await expect(dialog).toHaveCount(0);
});

for (const local of [false, true]) {
  test(`${local ? "local changes" : "pending requests"} show deletion diffs when tombstones retain file metadata`, async ({
    page,
  }) => {
    await fixture(
      page,
      true,
      true,
      local ? "draft-publisher" : "owner",
      false,
      { before: { "content.md": "Saved learning\n" }, baseRevision: 3 },
    );
    await management(page)
      .getByRole("button", {
        name: local ? "Review changes" : "Review request",
        exact: true,
      })
      .click();
    const review = local
      ? page.getByRole("dialog", { name: "Review changes", exact: true })
      : management(page);
    await expect(review.locator(".diff-card-removed")).toHaveText("Removed");
    await expect(
      review.getByRole("group", { name: "File changes", exact: true }),
    ).toContainText(local ? "Saved learning" : "Previous version");
    await expect(
      review.getByText("No file changes.", { exact: true }),
    ).toHaveCount(0);
    if (!local) {
      await review
        .getByRole("button", { name: "Approve request", exact: true })
        .click();
      expect(await calls(page, "decide")).toEqual([
        {
          projectId: "project",
          id: "request",
          previewHash: "reviewed-hash",
          expectedPolicyRevision: 1,
          decision: "approve",
        },
      ]);
    }
  });
}

test("request approval sends the exact reviewed hash and reports stale proposals", async ({
  page,
}) => {
  await fixture(page);
  const screen = management(page);
  await screen
    .getByRole("button", { name: "Review request", exact: true })
    .click();
  await expect(screen.getByLabel("File changes")).toContainText(
    "Reviewed candidate",
  );
  await screen
    .getByRole("button", { name: "Approve request", exact: true })
    .click();
  await expect(
    page.locator("[data-orka-toast]").getByRole("status"),
  ).toHaveText("Suggestion needs a fresh review");
  expect(await calls(page, "decide")).toEqual([
    {
      projectId: "project",
      id: "request",
      previewHash: "reviewed-hash",
      expectedPolicyRevision: 1,
      decision: "approve",
    },
  ]);
});

test("access requests start from resource pages and do not appear in management", async ({
  page,
}) => {
  await fixture(page, true, false, "member");
  await expect(
    management(page).getByRole("button", {
      name: "Request access",
      exact: true,
    }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Plans 0", exact: true }).click();
  await page
    .getByRole("button", { name: "Request editing access", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Request access",
    exact: true,
  });
  await expect(dialog).toContainText("for plans");
  await dialog
    .getByRole("button", { name: "Send request", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Access requested", exact: true }),
  ).toBeVisible();
  expect((await calls(page, "request-access"))[0]).toMatchObject({
    projectId: "project",
    class: "plan",
    mode: "publish",
  });
  expect((await calls(page, "request-access"))[0]).not.toHaveProperty(
    "resourceId",
  );
});

test("shared skill removals stay reviewable and preserve private edits", async ({
  page,
}) => {
  await fixture(page, true, true);
  const dialog = await openUpdates(page, "Review skill removal");
  await expect(dialog.getByRole("heading", { name: "SKILL.md" })).toBeVisible();
  await expect(dialog.locator(".diff-card-removed")).toHaveText("Removed");
  await dialog
    .getByRole("button", { name: "Keep edits and remove", exact: true })
    .click();
  expect((await calls(page, "apply-install"))[0]).toMatchObject({
    resourceId: "skill",
    token: "local-preview",
    preserveLocal: true,
  });
});

for (const removed of [false, true]) {
  test(`Requests keeps instruction ${removed ? "removal" : "updates"} reviewable`, async ({
    page,
  }) => {
    await fixture(page, true, removed, "instructions");
    const dialog = await openUpdates(page);
    await expect(dialog).toHaveClass(/governance-dialog/);
    await expect(
      dialog.getByRole("heading", {
        name: "Project instructions",
        exact: true,
      }),
    ).toBeVisible();
    expect(await calls(page, "preview-install")).toEqual([]);
    await dialog
      .getByRole("button", {
        name: removed ? "Review local removal" : "Review local update",
        exact: true,
      })
      .click();
    await expect(dialog.getByLabel("File changes")).toContainText(
      "Local edits",
    );
    await expect(
      dialog.getByText(
        "Your local edits will be saved privately on this Mac before installation.",
      ),
    ).toBeVisible();
    expect(await calls(page, "preview-install")).toEqual([
      { projectId: "project", resourceId: "instructions" },
    ]);
    await dialog
      .getByRole("button", {
        name: removed
          ? "Preserve edits and remove reviewed version"
          : "Preserve edits and install reviewed version",
        exact: true,
      })
      .click();
    expect(await calls(page, "apply-install")).toEqual([
      {
        projectId: "project",
        resourceId: "instructions",
        token: "local-preview",
        preserveLocal: true,
      },
    ]);
  });
}

test("local installation rejects changes made after reviewing the preview", async ({
  page,
}) => {
  await fixture(page);
  const dialog = await openUpdates(page);
  await expect(dialog.getByLabel("File changes")).toContainText("Local edits");
  await page.evaluate(() => {
    (window as unknown as { governanceStale: boolean }).governanceStale = true;
  });
  await dialog
    .getByRole("button", { name: "Keep edits and install", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toHaveText(
    "Files changed since this preview.",
  );
  await expect(
    dialog.getByRole("button", { name: "Review latest", exact: true }),
  ).toBeVisible();
});

test("a member with no shared access can request a collection from its empty page", async ({
  page,
}) => {
  await fixture(page, true, false, "restricted");
  await page.getByRole("button", { name: "Memories 0", exact: true }).click();
  await expect(
    page.getByText("Access to shared memories is restricted.", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Request access", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Request access",
    exact: true,
  });
  await expect(
    dialog.getByLabel("Requested permission", { exact: true }),
  ).toContainText("View only");
  await dialog
    .getByRole("button", { name: "Send request", exact: true })
    .click();
  expect((await calls(page, "request-access"))[0]).toMatchObject({
    class: "memory",
    mode: "read",
    projectId: "project",
  });
});
