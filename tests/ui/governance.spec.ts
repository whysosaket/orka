import { test, expect, type Page } from "@playwright/test";
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
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Members", exact: true }).click();
  await page.getByRole("button", { name: /Review pending requests/ }).click();
}

const management = (page: Page) =>
  page.getByRole("region", { name: "Manage", exact: true });

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
async function openUpdates(page: Page) {
  await management(page)
    .getByRole("button", { name: "Review update", exact: true })
    .click();
  return page.getByRole("dialog", { name: "Review local update", exact: true });
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
