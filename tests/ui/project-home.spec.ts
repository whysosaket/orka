import { test, expect, type Page } from "@playwright/test";

async function homeFixture(page: Page) {
  await page.clock.install({ time: new Date("2026-10-20T12:00:00Z") });
  await page.addInitScript(() => {
    const resources = [
      {
        resourceId: "home-memory",
        kind: "memory",
        title: "Desktop interaction guidelines.md",
        updatedAt: "2026-10-20T11:00:00Z",
      },
      {
        resourceId: "home-skill",
        kind: "skill",
        title: "SKILL.md",
        updatedAt: "2026-10-20T10:00:00Z",
      },
      {
        resourceId: "home-session",
        kind: "session",
        title: "Imported session",
        updatedAt: "2026-10-20T09:00:00Z",
      },
      {
        resourceId: "home-plan",
        kind: "plan",
        title: "Desktop rollout plan",
        updatedAt: "2026-10-20T08:00:00Z",
      },
      {
        resourceId: "home-memory-2",
        kind: "memory",
        title: "Project sharing guidelines",
        updatedAt: "2026-10-20T07:00:00Z",
        updatedBy: "Mira",
      },
      {
        resourceId: "home-memory-3",
        kind: "memory",
        title: "Navigation decisions",
        updatedAt: "2026-10-20T06:00:00Z",
      },
      {
        resourceId: "home-memory-older",
        kind: "memory",
        title: "Older update",
        updatedAt: "2026-10-19T06:00:00Z",
      },
      {
        resourceId: "home-deleted",
        kind: "memory",
        title: "Deleted update",
        updatedAt: "2026-10-20T11:59:00Z",
        deleted: true,
      },
      {
        resourceId: "home-other-project",
        kind: "memory",
        title: "Other project update",
        updatedAt: "2026-10-20T11:59:00Z",
        projectId: "other",
      },
    ].map((resource) => ({
      projectId: "one",
      source: "codex",
      owner: "user",
      updatedBy: "user",
      deleted: false,
      revision: 1,
      ...resource,
      logicalPath: `codex/${resource.resourceId}`,
      files: [
        {
          path:
            resource.kind === "skill"
              ? "SKILL.md"
              : resource.kind === "session"
                ? "session.jsonl"
                : "content.md",
          hash: `hash-${resource.resourceId}`,
          size: 10,
        },
      ],
    }));
    const calls: { name: string; args?: Record<string, unknown> }[] = [];
    Object.assign(window, {
      invokeCalls: calls,
      isTauri: true,
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        unregisterCallback: () => {},
        invoke: async (name: string, args?: Record<string, unknown>) => {
          calls.push({ name, args });
          if (name === "snapshot")
            return {
              user: "user",
              governance: [
                {
                  projectId: "one",
                  catalog: {
                    access: {},
                    members: [{ id: "Mira", role: "member", name: "Mira" }],
                  },
                },
              ],
              config: { apiUrl: "https://test.local", syncMinutes: 15 },
              projects: [
                {
                  id: "one",
                  name: "OpenWhispr",
                  path: "/test/openwhispr",
                  role: "owner",
                },
                {
                  id: "empty",
                  name: "Empty project",
                  path: null,
                  role: "owner",
                },
              ],
              resources,
              bindings: [],
              conflicts: [],
              activity: [],
              outbox: [],
              errors: [],
              sync: { online: true },
              daemon: { running: true },
              devices: [],
              deviceId: "device",
              background: true,
            };
          if (name === "session_display_title")
            return "Polish project navigation";
          if (name === "session_messages")
            return {
              messages: [
                { index: 0, role: "user", text: "Session conversation" },
              ],
              total: 1,
              offset: 0,
            };
          if (name === "inspect_resource")
            return {
              content:
                args?.id === "home-skill"
                  ? "---\nname: Interface review\ndescription: Review the interface.\n---\n# Review checklist"
                  : "# Resource content",
              previous: null,
              conversation: null,
              paths: [],
            };
          if (name.startsWith("plugin:")) return null;
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

const updates = (page: Page) =>
  page.getByRole("list", { name: "Recently updated resources" });

test("Home shows the selected project's six latest resources and real update metadata", async ({
  page,
}) => {
  await homeFixture(page);
  const list = updates(page);
  await expect(list.getByRole("button")).toHaveCount(6);
  expect(
    await list
      .getByRole("button")
      .evaluateAll((rows) =>
        rows.map((row) => row.getAttribute("data-resource-id")),
      ),
  ).toEqual([
    "home-memory",
    "home-skill",
    "home-session",
    "home-plan",
    "home-memory-2",
    "home-memory-3",
  ]);
  await expect(list).toContainText("Interface review");
  await expect(list).toContainText("Polish project navigation");
  await expect(list).toContainText("Updated by you · 1 hour ago");
  await expect(list).toContainText("Updated by Mira · 5 hours ago");
  await expect(list).not.toContainText("Other project update");
  await expect(list).not.toContainText("Deleted update");
  await expect(list).not.toContainText("Older update");
  await expect(page.locator(".home-overview-totals")).toHaveCount(0);
  await expect(
    page.getByText("Needs your attention", { exact: true }),
  ).toHaveCount(0);
  const reads = await page.evaluate(() =>
    (window as any).invokeCalls
      .filter(
        (call: { name: string; args?: { id?: string } }) =>
          call.name === "inspect_resource",
      )
      .map((call: { args?: { id?: string } }) => call.args?.id),
  );
  expect(reads).toEqual(["home-skill"]);
});

test("recent memory, skill, session, and plan rows open their existing reading views", async ({
  page,
}) => {
  await homeFixture(page);
  for (const [id, collection] of [
    ["home-memory", "Memories"],
    ["home-skill", "Skills"],
    ["home-session", "Sessions"],
    ["home-plan", "Plans"],
  ]) {
    await updates(page).locator(`[data-resource-id="${id}"]`).click();
    await expect(page.locator(".workspace-header h1")).toHaveText(collection);
    await expect(
      page.getByRole("button", {
        name: `Back to ${collection}`,
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Home", exact: true }).click();
    await expect(updates(page)).toBeVisible();
  }
  await page.getByRole("button", { name: /^Skills/ }).click();
  await expect(page.locator(".workspace-header h1")).toHaveText("Skills");
});

test("Home keeps the unified recent list and fits the minimum window without total cards", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await homeFixture(page);
  await expect(updates(page)).toContainText("Interface review");
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator(".home-overview-totals")).toHaveCount(0);
  await expect(updates(page)).toBeVisible();
  await page.screenshot({ path: "artifacts/home-1440.png" });
  await page.setViewportSize({ width: 900, height: 640 });
  await page.clock.runFor(100);
  await expect(page.locator(".app")).toHaveCount(1);
  expect((await page.locator(".app").boundingBox())!.height).toBe(640);
  const home = page.locator(".project-home-overview");
  expect(
    await home.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await expect(page.locator(".home-overview-totals")).toHaveCount(0);
  await page.screenshot({ path: "artifacts/home-900.png" });
});

test("an empty project keeps folder connection available and shows an honest empty state", async ({
  page,
}) => {
  await homeFixture(page);
  await page
    .getByRole("combobox", { name: "Select project", exact: true })
    .click();
  await page
    .getByRole("option", { name: "Empty project", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "No updates yet", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".home-overview-totals")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Connect folder/i }),
  ).toBeVisible();
  await expect(updates(page)).toHaveCount(0);
});
