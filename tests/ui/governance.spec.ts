import { ENV_ENABLED } from "../../apps/mac/src/lib/features.js";
import { test, expect, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
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
) {
  await page.addInitScript(
    ({ rules, governed, removed, mode, envData }) => {
      const isMember = mode === "member" || mode === "restricted";
      const resource = {
        resourceId: "skill",
        projectId: "project",
        kind: "skill",
        source: "shared",
        logicalPath: "sample",
        title: "Sample skill",
        revision: 2,
        owner: "owner",
        updatedBy: "owner",
        updatedAt: "2026-10-18T00:00:00Z",
        files: [
          { path: "SKILL.md", hash: "fixture", size: 16, executable: false },
        ],
        deleted: removed,
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
                projects: [project],
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
                drafts: [],
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
                    files: { "SKILL.md": "Reviewed candidate\n" },
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
                    before: { "SKILL.md": "Local edits\n" },
                    after: removed ? {} : { "SKILL.md": "Approved skill\n" },
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
    { rules: savedProjectRules, governed, removed, mode, envData },
  );
  await page.goto("/");
  await page
    .getByRole("combobox", { name: "Select project", exact: true })
    .click();
  await page.getByRole("button", { name: "Manage", exact: true }).click();
}

const management = (page: Page) =>
  page.getByRole("region", { name: "Manage", exact: true });

test("member loading preserves management navigation and hides sample controls", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await fixture(page, true, false, "held-catalog");
  const screen = management(page);
  const loading = screen.locator(".loading-region");
  await expect(loading).toHaveAttribute("aria-busy", "true");
  await expect(
    screen.getByRole("button", { name: "Members", exact: true }),
  ).toBeEnabled();
  await expect(
    screen.getByRole("button", { name: "Requests", exact: true }),
  ).toBeEnabled();
  await expect(
    screen.getByRole("heading", { name: "Project members", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({ path: "artifacts/member-loading.png" });
  expect(
    (await new AxeBuilder({ page }).include(".members-page").analyze())
      .violations,
  ).toEqual([]);
  await page.evaluate(() =>
    (window as any).finishMemberLoads.forEach((finish: () => void) => finish()),
  );
  await expect(
    screen.getByRole("region", { name: "Project members" }),
  ).toBeVisible();
  await expect(loading).not.toHaveAttribute("aria-busy", "true");
});

for (const mode of ["owner", "member"]) {
  test(`disabled ENVs stay hidden with saved sharing, requests, logs and links for ${mode}`, async ({
    page,
  }, info) => {
    test.skip(ENV_ENABLED, "Checks the disabled product state");
    await fixture(page, true, false, mode, true);
    await expect(
      page.getByRole("button", { name: "ENVs", exact: true }),
    ).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(/\bENVs?\b/);
    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await expect(
      page.getByRole("button", { name: "ENVs", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Expand sidebar" }).click();
    await page.evaluate(() => {
      (window as any).pendingEnvLink = "orka://env/project/env-set";
    });
    await expect
      .poll(() => page.evaluate(() => (window as any).pendingEnvLink))
      .toBeNull();
    await expect(page.locator(".workspace-header h1")).toHaveText("Manage");
    const screen = management(page);
    await screen.getByRole("button", { name: "Requests", exact: true }).click();
    await expect(
      screen.getByRole("button", { name: "Review request", exact: true }),
    ).toHaveCount(1);
    await expect(
      screen.getByRole("button", { name: "View more requests", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: /notification/ }).click();
    await expect(
      page.getByRole("dialog", { name: "Sync status and notifications" }),
    ).not.toContainText("ENV");
    await page.keyboard.press("Escape");
    await screen
      .getByRole("button", { name: "View logs", exact: true })
      .click();
    const logs = screen.getByRole("region", {
      name: "Activity logs",
      exact: true,
    });
    await expect(logs).not.toContainText("ENV");
    await expect(logs.getByText("No activity recorded yet.")).toHaveCount(0);
    await logs.getByRole("button", { name: "View more logs" }).click();
    await expect(logs).toContainText("Saket Rao approved Mira Shah's request");
    await expect(
      logs.getByRole("button", { name: "View more logs" }),
    ).toHaveCount(0);
    await screen
      .getByRole("button", { name: "Back to Manage", exact: true })
      .click();
    await screen.getByRole("button", { name: "Members", exact: true }).click();
    await screen
      .getByRole("button", {
        name: mode === "owner" ? /Member member Member/ : /You Member/,
      })
      .click();
    await expect(screen).not.toContainText("ENV");
    await expect(
      screen.getByLabel("ENV sets access", { exact: true }),
    ).toHaveCount(0);
    await page.setViewportSize({ width: 900, height: 640 });
    expect(
      (await new AxeBuilder({ page }).include(".members-page").analyze())
        .violations,
    ).toEqual([]);
    await page.screenshot({
      path: info.outputPath(`env-disabled-${mode}-compact.png`),
    });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("dialog", {
      name: "Settings",
      exact: true,
    });
    await expect(settings).toContainText("4 of 4 categories enabled");
    await settings
      .getByRole("button", { name: "Sharing", exact: true })
      .click();
    await expect(settings.getByRole("switch")).toHaveCount(4);
    await expect(settings).not.toContainText("ENV");
    await settings
      .getByRole("button", { name: "Close settings", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Add project", exact: true })
      .click();
    const setup = page.getByRole("dialog", {
      name: "Create project",
      exact: true,
    });
    await expect(setup.getByRole("checkbox")).toHaveCount(4);
    await expect(setup).not.toContainText("ENV");
    expect(
      await page.evaluate(() =>
        (window as any).governanceCalls.filter(
          (call: any) => call.command === "env_command",
        ),
      ),
    ).toEqual([]);
    expect(await calls(page, "policy")).toEqual([]);
    expect(await calls(page, "request-access")).toEqual([]);
  });
}
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
async function chooseAccess(page: Page, category: string, label: string) {
  await management(page)
    .getByRole("combobox", { name: `${category} access`, exact: true })
    .click();
  await page.getByRole("option", { name: label, exact: true }).click();
}
async function openUpdates(page: Page) {
  await management(page)
    .getByRole("button", { name: "Requests", exact: true })
    .click();
  await management(page)
    .getByRole("button", { name: "Review update", exact: true })
    .click();
  return page.getByRole("dialog", {
    name: "Review local update",
    exact: true,
  });
}

test("sidebar management shows members without exposing the old draft form or resource browser", async ({
  page,
}, testInfo) => {
  await fixture(page);
  const screen = management(page);
  await expect(page.locator(".workspace-header h1")).toHaveText("Manage");
  await expect(screen.getByRole("button", { name: /You Owner/ })).toBeVisible();
  await expect(
    screen.getByRole("button", { name: /Member member Member/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Resource access", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Memory topic")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("\u2014");
  await page.screenshot({ path: testInfo.outputPath("members-wide.png") });
  await page.setViewportSize({ width: 900, height: 640 });
  await screen.getByRole("button", { name: /Member member Member/ }).click();
  for (const name of [
    "Memories",
    "Skills",
    "Plans",
    "Sessions",
    ...(ENV_ENABLED ? ["ENV sets"] : []),
  ])
    await expect(
      screen.getByRole("region", { name: `${name} permissions`, exact: true }),
    ).toBeVisible();
  await expect(
    screen.getByRole("heading", { name: "Instructions", exact: true }),
  ).toHaveCount(0);
  await expect(
    screen.getByRole("heading", { name: "Knowledge", exact: true }),
  ).toHaveCount(0);
  await expect(screen.getByRole("combobox")).toHaveCount(ENV_ENABLED ? 5 : 4);
  await expect(screen.getByRole("checkbox")).toHaveCount(ENV_ENABLED ? 9 : 8);
  await expect(screen.getByText("Individual file permissions")).toHaveCount(0);
  await expect(
    screen.getByText("Project membership", { exact: true }),
  ).toHaveCount(0);
  expect(
    (await new AxeBuilder({ page }).include(".members-page").analyze())
      .violations,
  ).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("member-permissions-compact.png"),
    fullPage: true,
  });
});

test("legacy activation keeps published content and private learning explicit", async ({
  page,
}) => {
  await fixture(page, false);
  const screen = management(page);
  await expect(
    screen.getByText(/Personal memory stays local and writable/),
  ).toBeVisible();
  await screen
    .getByRole("button", { name: "Enable project permissions" })
    .click();
  await screen
    .getByRole("button", { name: "Default member permissions" })
    .click();
  await expect(
    screen.getByLabel("Skills access", { exact: true }),
  ).toContainText("Can edit");
});

test("editing a member stages changes and explains suggestions before publishing", async ({
  page,
}) => {
  await fixture(page);
  const screen = management(page);
  await screen.getByRole("button", { name: /Member member Member/ }).click();
  await expect(
    screen.getByLabel("Skills access", { exact: true }),
  ).toContainText("Suggest changes");
  await chooseAccess(page, "Skills", "Can edit");
  expect(await calls(page, "policy")).toEqual([]);
  await screen
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await expect(
    screen.getByRole("region", { name: "Review permission changes" }),
  ).toContainText("Suggest changes → Can edit");
  await screen
    .getByRole("button", { name: "Save permissions", exact: true })
    .click();
  await expect(
    page.locator("[data-orka-toast]").getByRole("status"),
  ).toContainText("Permissions saved");
  expect(await calls(page, "policy")).toEqual([
    {
      projectId: "project",
      userId: "member",
      class: "skill",
      rule: { mode: "publish", create: "suggest", canShare: false },
      expectedPolicyRevision: 1,
    },
  ]);
  expect(await calls(page, "access")).toEqual([]);
});

test("grouped memories preserve different creation rules and use each returned revision", async ({
  page,
}) => {
  await fixture(page, true, false, "mixed");
  const screen = management(page);
  await screen.getByRole("button", { name: /Member member Member/ }).click();
  await expect(
    screen.getByLabel("Memories access", { exact: true }),
  ).toContainText("Different settings");
  await chooseAccess(page, "Memories", "Can edit");
  await screen
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await screen
    .getByRole("button", { name: "Save permissions", exact: true })
    .click();
  await expect(
    page.locator("[data-orka-toast]").getByRole("status"),
  ).toContainText("Permissions saved");
  expect(await calls(page, "policy")).toEqual([
    {
      projectId: "project",
      userId: "member",
      class: "instructions",
      rule: { mode: "publish", create: "hidden", canShare: false },
      expectedPolicyRevision: 1,
    },
    {
      projectId: "project",
      userId: "member",
      class: "memory",
      rule: { mode: "publish", create: "suggest", canShare: false },
      expectedPolicyRevision: 2,
    },
  ]);
});

test("a save interrupted by a permission change keeps remaining edits reviewable", async ({
  page,
}) => {
  await fixture(page, true, false, "partial");
  const screen = management(page);
  await screen.getByRole("button", { name: /Member member Member/ }).click();
  await chooseAccess(page, "Memories", "Can edit");
  await screen
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await screen
    .getByRole("button", { name: "Save permissions", exact: true })
    .click();
  await expect(screen.getByRole("alert")).toContainText(
    "Some permissions were saved",
  );
  await expect(
    screen.getByRole("button", { name: "Review changes", exact: true }),
  ).toBeEnabled();
  expect((await calls(page, "policy")).length).toBe(2);
});

test("members can inspect their access but cannot use owner controls", async ({
  page,
}) => {
  await fixture(page, true, false, "member");
  const screen = management(page);
  await expect(
    screen.getByRole("button", { name: "Default member permissions" }),
  ).toHaveCount(0);
  await screen.getByRole("button", { name: /You Member/ }).click();
  await expect(
    screen.getByText("Your shared project access.", { exact: false }),
  ).toBeVisible();
  await expect(
    screen.getByRole("button", { name: "Save permissions", exact: true }),
  ).toHaveCount(0);
  await expect(
    screen.getByRole("button", { name: "Remove member", exact: true }),
  ).toHaveCount(0);
  expect(await calls(page, "policy")).toEqual([]);
});

test("request approval sends the exact reviewed hash and reports stale proposals", async ({
  page,
}) => {
  await fixture(page);
  const screen = management(page);
  await screen.getByRole("button", { name: "Requests", exact: true }).click();
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
  await management(page)
    .getByRole("button", { name: "Requests", exact: true })
    .click();
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
  const dialog = await openUpdates(page);
  await dialog.getByRole("button", { name: "Review local removal" }).click();
  await expect(dialog.getByLabel("File changes")).toContainText("Local edits");
  await dialog
    .getByRole("button", { name: "Preserve edits and remove reviewed version" })
    .click();
  expect((await calls(page, "apply-install"))[0]).toMatchObject({
    resourceId: "skill",
    token: "local-preview",
    preserveLocal: true,
  });
});

test("local installation rejects changes made after reviewing the preview", async ({
  page,
}) => {
  await fixture(page);
  const dialog = await openUpdates(page);
  await dialog
    .getByRole("button", { name: "Review local update", exact: true })
    .click();
  await expect(dialog.getByLabel("File changes")).toContainText("Local edits");
  await page.evaluate(() => {
    (window as unknown as { governanceStale: boolean }).governanceStale = true;
  });
  await dialog
    .getByRole("button", {
      name: "Preserve edits and install reviewed version",
    })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "review the update again",
  );
});

test("permission changes after review require another review", async ({
  page,
}) => {
  await fixture(page);
  const screen = management(page);
  await screen
    .getByRole("button", { name: "Default member permissions", exact: true })
    .click();
  await chooseAccess(page, "Plans", "Can edit");
  await screen
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await page.evaluate(() =>
    (window as unknown as { governanceBump: () => void }).governanceBump(),
  );
  await screen.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(screen.getByRole("alert")).toContainText(
    "Permissions changed after this review",
  );
  await expect(
    screen.getByRole("button", { name: "Save permissions", exact: true }),
  ).toBeDisabled();
  expect(await calls(page, "policy")).toEqual([]);
});

test("resetting a member to defaults removes only that category override", async ({
  page,
}) => {
  await fixture(page, true, false, "mixed");
  const screen = management(page);
  await screen.getByRole("button", { name: /Member member Member/ }).click();
  await screen
    .getByRole("button", {
      name: "Use default",
      exact: true,
    })
    .click();
  await screen
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await screen
    .getByRole("button", { name: "Save permissions", exact: true })
    .click();
  await expect(
    page.locator("[data-orka-toast]").getByRole("status"),
  ).toContainText("Permissions saved");
  await expect(
    screen.getByLabel("Memories access", { exact: true }),
  ).toContainText("Suggest changes");
  expect(await calls(page, "inherit")).toEqual([
    {
      projectId: "project",
      userId: "member",
      class: "instructions",
      expectedPolicyRevision: 1,
    },
  ]);
  expect(await calls(page, "policy")).toEqual([]);
});

test("member names are visible and default permissions have a reachable scroll area", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 640 });
  await fixture(page, true, false, "names");
  const screen = management(page);
  await expect(
    screen.getByRole("button", { name: /Mira Shah Member/ }),
  ).toBeVisible();
  await expect(
    screen.getByRole("button", { name: /Saket Rao \(you\) Owner/ }),
  ).toBeVisible();
  await screen
    .getByRole("button", { name: "Default member permissions", exact: true })
    .click();
  const scrollable = await screen
    .locator(".management-content")
    .evaluate(
      (element) =>
        getComputedStyle(element).overflowY === "auto" &&
        element.scrollHeight > element.clientHeight,
    );
  expect(scrollable).toBe(true);
  await screen
    .getByLabel(`${ENV_ENABLED ? "ENV sets" : "Sessions"} access`, {
      exact: true,
    })
    .scrollIntoViewIfNeeded();
  await expect(
    screen.getByLabel(`${ENV_ENABLED ? "ENV sets" : "Sessions"} access`, {
      exact: true,
    }),
  ).toBeInViewport();
  await screen
    .getByRole("button", { name: "Review changes", exact: true })
    .scrollIntoViewIfNeeded();
  await expect(
    screen.getByRole("button", { name: "Review changes", exact: true }),
  ).toBeInViewport();
});

test("management uses compact cards and an owner-only member menu", async ({
  page,
}) => {
  await fixture(page, true, false, "names");
  await management(page)
    .getByRole("button", { name: "Manage Mira Shah", exact: true })
    .click();
  const menu = page.getByRole("dialog", { name: "Actions for Mira Shah" });
  await expect(
    menu.getByRole("button", { name: "Remove member", exact: true }),
  ).toHaveCSS("color", "rgb(241, 120, 120)");
  await menu
    .getByRole("button", { name: "Edit permissions", exact: true })
    .click();
  await expect(
    management(page).getByLabel("Memories access", { exact: true }),
  ).toBeVisible();
  await expect(
    management(page).getByText("New items", { exact: true }),
  ).toHaveCount(0);
  await expect(management(page).getByText(/manage sharing/i)).toHaveCount(0);
  const columns = () =>
    page
      .locator(".permission-grid")
      .evaluate(
        (node) => getComputedStyle(node).gridTemplateColumns.split(" ").length,
      );
  expect(await columns()).toBe(3);
  await page.setViewportSize({ width: 900, height: 640 });
  expect(await columns()).toBe(2);
  await management(page).getByLabel("Skills: can suggest new items").uncheck();
  await chooseAccess(page, "Skills", "View only");
  await management(page)
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await management(page)
    .getByRole("button", { name: "Save permissions", exact: true })
    .click();
  await expect(
    page.locator("[data-orka-toast]").getByRole("status"),
  ).toContainText("Permissions saved");
  expect((await calls(page, "policy"))[0]!.rule).toEqual({
    mode: "read",
    create: "hidden",
    canShare: false,
  });
});

test("requests expand five at a time and activity has its own page", async ({
  page,
}) => {
  await fixture(page, true, false, "many");
  const screen = management(page);
  await screen.getByRole("button", { name: "Requests", exact: true }).click();
  await expect(
    screen.getByRole("button", { name: "Review request", exact: true }),
  ).toHaveCount(5);
  await screen
    .getByRole("button", { name: "View more requests", exact: true })
    .click();
  await expect(
    screen.getByRole("button", { name: "Review request", exact: true }),
  ).toHaveCount(10);
  await screen.getByRole("button", { name: "View logs", exact: true }).click();
  await expect(
    screen.getByRole("region", { name: "Activity logs", exact: true }),
  ).toContainText("Saket Rao approved Mira Shah's request");
  await expect(
    screen.getByRole("button", { name: "Requests", exact: true }),
  ).toHaveCount(0);
  await screen
    .getByRole("button", { name: "Back to Manage", exact: true })
    .click();
  await expect(
    screen.getByRole("button", { name: "Requests", exact: true }),
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

test("new-item suggestions require approval independently of editing access", async ({
  page,
}) => {
  await fixture(page);
  const screen = management(page);
  await screen.getByRole("button", { name: /Member member Member/ }).click();
  const suggest = screen.getByLabel("Skills: can suggest new items", {
    exact: true,
  });
  const add = screen.getByLabel("Skills: can add new items", { exact: true });
  await expect(suggest).toBeChecked();
  await expect(add).not.toBeChecked();
  await chooseAccess(page, "Skills", "View only");
  await expect(suggest).toBeChecked();
  await add.check();
  await expect(suggest).not.toBeChecked();
  await suggest.check();
  await expect(add).not.toBeChecked();
  await screen
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await expect(
    screen.getByRole("region", { name: "Review permission changes" }),
  ).toContainText("Can suggest new items (approval required)");
  await screen
    .getByRole("button", { name: "Save permissions", exact: true })
    .click();
  await expect(
    page.locator("[data-orka-toast]").getByRole("status"),
  ).toContainText("Permissions saved");
  expect((await calls(page, "policy"))[0]).toMatchObject({
    class: "skill",
    rule: { mode: "read", create: "suggest", canShare: false },
  });
  await add.check();
  await screen
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await screen
    .getByRole("button", { name: "Save permissions", exact: true })
    .click();
  await expect(
    page.locator("[data-orka-toast]").getByRole("status"),
  ).toContainText("Permissions saved");
  expect((await calls(page, "policy"))[1]).toMatchObject({
    class: "skill",
    rule: { mode: "read", create: "publish", canShare: false },
    expectedPolicyRevision: 2,
  });
  await expect(
    screen.getByLabel("ENV sets: can suggest new items", { exact: true }),
  ).toHaveCount(0);
});
