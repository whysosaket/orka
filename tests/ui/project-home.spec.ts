import { test, expect, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

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
        sourceId: "backend",
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
      sourceId: "desktop",
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
                  sources: [
                    {
                      id: "desktop",
                      name: "Desktop",
                      path: "/test/openwhispr",
                    },
                    { id: "backend", name: "Backend", path: "/test/backend" },
                  ],
                },
                {
                  id: "empty",
                  name: "Empty project",
                  path: null,
                  role: "owner",
                },
              ],
              resources,
              localSkills: [
                {
                  ...resources[1],
                  resourceId: "home-local-skill",
                  logicalPath: "codex/local-skill",
                  title: "Local review skill",
                  local: true,
                  updatedAt: "2026-10-18T06:00:00Z",
                },
                { ...resources[1], local: true },
              ],
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
const totals = (page: Page) =>
  page.getByRole("region", { name: "Project totals" });

test("Home totals include the entire project and local skills, excluding deleted items and other projects", async ({
  page,
}) => {
  await homeFixture(page);
  for (const [label, count] of [
    ["memories", "4"],
    ["skills", "2"],
    ["sessions", "1"],
    ["plans", "1"],
  ]) {
    await expect(
      totals(page)
        .getByRole("button", {
          name: new RegExp(`^View ${label} [0-9]+$`, "i"),
        })
        .locator("strong"),
    ).toHaveText(count);
  }
});

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
  await expect(totals(page).getByRole("button")).toHaveCount(4);
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

test("each project total opens its collection instead of the previously selected detail", async ({
  page,
}) => {
  await homeFixture(page);
  for (const [label, collection] of [
    ["memories", "Memories"],
    ["skills", "Skills"],
    ["sessions", "Sessions"],
    ["plans", "Plans"],
  ]) {
    await updates(page).locator('[data-resource-id="home-memory"]').click();
    await page.getByRole("button", { name: "Home", exact: true }).click();
    await totals(page)
      .getByRole("button", { name: new RegExp(`^View ${label} [0-9]+$`, "i") })
      .click();
    await expect(page.locator(".workspace-header h1")).toHaveText(collection);
    await expect(
      page.getByRole("button", { name: `Back to ${collection}`, exact: true }),
    ).toHaveCount(0);
    await expect(page.locator(".resource-index")).toBeVisible();
    await page.getByRole("button", { name: "Home", exact: true }).click();
  }
});

test("project totals open all repositories after browsing a filtered collection", async ({
  page,
}) => {
  await homeFixture(page);
  await totals(page)
    .getByRole("button", { name: /^View Memories [0-9]+$/ })
    .click();
  const filter = page.getByRole("combobox", {
    name: "Filter by repository",
    exact: true,
  });
  await filter.click();
  await page.getByRole("option", { name: "Desktop", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Older update", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(
    totals(page)
      .getByRole("button", { name: /^View Memories [0-9]+$/ })
      .locator("strong"),
  ).toHaveText("4");
  await totals(page)
    .getByRole("button", { name: /^View Memories [0-9]+$/ })
    .click();
  await expect(filter).toContainText("All repositories");
  await expect(
    page.getByRole("button", { name: "Older update", exact: true }),
  ).toBeVisible();
});

test("project totals support keyboard navigation and have no accessibility violations", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await homeFixture(page);
  const memories = totals(page).getByRole("button", {
    name: /^View Memories [0-9]+$/,
  });
  await memories.focus();
  await expect(memories).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    totals(page).getByRole("button", { name: /^View Skills [0-9]+$/ }),
  ).toBeFocused();
  expect(
    (await new AxeBuilder({ page }).include(".project-home-overview").analyze())
      .violations,
  ).toEqual([]);
  await page.keyboard.press("Enter");
  await expect(page.locator(".workspace-header h1")).toHaveText("Skills");
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1160, height: 800 },
  { width: 900, height: 640 },
]) {
  test(`Home totals and recent updates fit at ${viewport.width} by ${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await homeFixture(page);
    await page.evaluate(() => document.fonts.ready);
    await expect(updates(page)).toContainText("Interface review");
    const cards = totals(page).getByRole("button");
    await expect(cards).toHaveCount(4);
    for (const card of await cards.all()) await expect(card).toBeInViewport();
    expect((await page.locator(".app").boundingBox())!.height).toBe(
      viewport.height,
    );
    const home = page.locator(".project-home-overview");
    expect(
      await home.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    const first = (await cards.nth(0).boundingBox())!;
    const third = (await cards.nth(2).boundingBox())!;
    if (viewport.width === 900) expect(third.y).toBeGreaterThan(first.y);
    else expect(third.y).toBe(first.y);
    await page.screenshot({ path: `artifacts/home-${viewport.width}.png` });
  });
}

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
  await expect(totals(page).locator("strong")).toHaveText(["0", "0", "0", "0"]);
  await expect(
    page.getByRole("button", { name: /Connect folder/i }),
  ).toBeVisible();
  await expect(updates(page)).toHaveCount(0);
  await totals(page)
    .getByRole("button", { name: /^View Plans [0-9]+$/ })
    .click();
  await expect(page.locator(".workspace-header h1")).toHaveText("Plans");
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Select project", exact: true })
    .click();
  await page.getByRole("option", { name: "OpenWhispr", exact: true }).click();
  await expect(totals(page).locator("strong")).toHaveText(["4", "2", "1", "1"]);
});
