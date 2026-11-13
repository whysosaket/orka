import { ENV_ENABLED } from "../../apps/mac/src/lib/features.js";
import { test, expect } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const calls: { name: string; args?: Record<string, unknown> }[] = [];
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (text: string) => {
          copied.push(text);
        },
      },
    });
    const resources = [
      {
        resourceId: "memory-a",
        projectId: "one",
        kind: "memory",
        title: "Design decisions",
        deleted: false,
      },
      {
        resourceId: "skill-b",
        projectId: "two",
        kind: "skill",
        title: "Writing guide",
        deleted: false,
      },
      {
        resourceId: "session-c",
        projectId: "one",
        kind: "session",
        title: "Imported session",
        deleted: false,
      },
      {
        resourceId: "deleted",
        projectId: "one",
        kind: "memory",
        title: "Removed item",
        deleted: true,
      },
    ].map((r) => ({
      ...r,
      source: "codex",
      logicalPath: `codex/${r.resourceId}`,
      files: [
        {
          path:
            r.kind === "skill"
              ? "SKILL.md"
              : r.kind === "session"
                ? "session.jsonl"
                : "content.md",
          hash: "hash",
          size: 10,
        },
      ],
      revision: 1,
      owner: "user",
      updatedBy: "user",
      updatedAt: "2026-10-04T10:00:00Z",
    }));
    Object.assign(window, {
      invokeCalls: calls,
      copied,
      isTauri: true,
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        unregisterCallback: () => {},
        invoke: async (name: string, args?: Record<string, unknown>) => {
          calls.push({ name, args });
          if (name === "snapshot")
            return {
              user: "user",
              config: { apiUrl: "https://test.local", syncMinutes: 15 },
              projects: [
                { id: "one", name: "Orka", path: "/test/orka", role: "owner" },
                {
                  id: "two",
                  name: "Studio",
                  path: "/test/studio",
                  role: "member",
                },
              ],
              resources,
              bindings: [],
              conflicts: [],
              activity: [],
              outbox: [],
              errors: [],
              sync: { online: true, lastSync: "2026-10-20T12:00:00Z" },
              daemon: { running: true },
              devices: [],
              deviceId: "device",
              background: true,
            };
          if (name === "session_display_title") return "Polish navigation";
          if (name === "governance_command" && args?.action === "catalog")
            return {
              owner: true,
              governed: false,
              policyRevision: 0,
              policy: {},
              access: {},
              members: [{ id: "user", role: "owner" }],
              memberRules: [],
              resourceRules: [],
              resourceCount: resources.length,
              requests: [],
            };
          if (name === "inspect_resource")
            return {
              content: "# Preview\nSome content",
              previous: null,
              paths: ["SKILL.md"],
            };
          if (name === "plugin:dialog|open") return "/test/new-folder";
          if (name === "cloud_action" && args?.action === "invite")
            return { token: "test-invite" };
          if (name.startsWith("plugin:")) return null;
          return {};
        },
      },
    });
  });
  await page.goto("/");
  await expect(
    page.getByRole("combobox", { name: "Select project", exact: true }),
  ).toBeVisible();
});

test("global search is absent from shortcuts and the project menu", async ({
  page,
}) => {
  for (const shortcut of ["Meta+k", "Control+k"]) {
    await page.keyboard.press(shortcut);
    await expect(page.getByRole("dialog", { name: "Search Orka" })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("combobox", { name: "Search Orka" }),
    ).toHaveCount(0);
  }
  await page
    .getByRole("combobox", { name: "Select project", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Search Orka", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /^Memories/ }).click();
  await expect(
    page.getByRole("searchbox", { name: "Search memories" }),
  ).toBeVisible();
});

for (const size of [
  { width: 1160, height: 800 },
  { width: 900, height: 640 },
]) {
  test(`compact header at ${size.width}`, async ({ page }) => {
    await page.setViewportSize(size);
    await expect(page.locator(".sidebar .sync-status")).toHaveCount(0);
    await expect(page.locator(".workspace-header .sync-status")).toBeVisible();
    await expect(page.locator(".workspace-header")).toHaveCSS("height", "52px");
    await expect(page.locator(".sidebar")).toHaveCSS("width", "240px");
    for (const section of ["Skills", "Sessions"]) {
      await page
        .getByRole("button", { name: new RegExp(`^${section}`) })
        .click();
      const frame = await page.locator(".workspace-header").boundingBox();
      const sync = await page
        .locator(".workspace-header .sync-status")
        .boundingBox();
      expect(sync!.x + sync!.width).toBeLessThanOrEqual(
        frame!.x + frame!.width,
      );
    }
    await page
      .getByRole("combobox", { name: "Select project", exact: true })
      .click();
    const selector = (await page.locator(".project-selector").boundingBox())!;
    const menu = (await page.locator(".project-menu").boundingBox())!;
    expect(selector.y + selector.height).toBe(size.height - 20);
    expect(menu.y + menu.height).toBeLessThan(selector.y);
    await expect(page.locator(".project-menu")).toHaveAttribute(
      "data-side",
      "top",
    );
    await expect(
      page.getByRole("button", { name: "Invite member", exact: true }),
    ).toHaveCount(0);
  });
}

test("Figma shell geometry, fluid gap selection, collapse reversal and keyboard navigation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const project = page.getByRole("combobox", {
    name: "Select project",
    exact: true,
  });
  const selector = (await project.boundingBox())!;
  expect(selector).toMatchObject({ x: 12, y: 842, width: 216, height: 38 });
  const controls = (await page
    .locator(".sidebar-window-controls")
    .boundingBox())!;
  expect(controls).toMatchObject({ x: 12, y: 16, width: 216, height: 38 });
  await expect(page.locator(".sidebar-window-controls")).toHaveAttribute(
    "data-tauri-drag-region",
    "true",
  );
  const header = (await page.locator(".workspace-header").boundingBox())!;
  expect(header).toMatchObject({ x: 248, y: 8, height: 52 });
  const nav = page.getByRole("navigation", { name: "Orka resources" });
  await expect(nav.getByRole("button")).toHaveText([
    "Home",
    "Memories1",
    "Skills0",
    "Sessions1",
    "Plans0",
    ...(ENV_ENABLED ? ["ENVs"] : []),
  ]);
  const boxes = await nav.getByRole("button").evaluateAll((buttons) =>
    buttons.map((button) => {
      const { x, y, width, height } = button.getBoundingClientRect();
      return { x, y, width, height };
    }),
  );
  boxes.forEach((box, index) =>
    expect(box).toMatchObject({
      x: 12,
      y: 74 + index * 44,
      width: 216,
      height: 36,
    }),
  );
  // The official hover system routes a click in the 8px gap to its nearest row.
  const skill = boxes[2];
  await page.mouse.move(skill.x + 30, skill.y - 1);
  const hover = nav.locator('[data-slot="fluid-hover-highlight"]');
  await expect(hover).toHaveCount(1);
  await expect
    .poll(async () => Math.round((await hover.boundingBox())!.y))
    .toBe(skill.y);
  await page.mouse.click(skill.x + 30, skill.y - 1);
  await expect(nav.getByRole("button", { name: /^Skills/ })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.mouse.move(400, 400);
  await expect(hover).toHaveCount(0);
  const memory = nav.getByRole("button", { name: /^Memories/ });
  await memory.focus();
  await memory.press("Enter");
  await expect(memory).toHaveAttribute("aria-current", "page");
  await expect
    .poll(async () =>
      Math.round(
        (await nav.locator(".project-section-highlight").boundingBox())!.y,
      ),
    )
    .toBe(boxes[1].y);
  await page
    .getByRole("button", { name: "Collapse sidebar", exact: true })
    .click();
  // Reverse before the spring has settled, then check the final geometry.
  await page
    .getByRole("button", { name: "Expand sidebar", exact: true })
    .click();
  await expect(page.locator(".sidebar")).toHaveCSS("width", "240px");
  const toggle = page.getByRole("button", {
    name: "Collapse sidebar",
    exact: true,
  });
  await toggle.focus();
  await toggle.press("Enter");
  await expect(page.locator(".sidebar")).toHaveCSS("width", "80px");
  await expect(
    page.getByRole("button", { name: "Settings", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "artifacts/sidebar-collapsed.png" });
  await page
    .getByRole("combobox", { name: "Select project: Orka", exact: true })
    .click();
  await expect(
    page.getByRole("option", { name: "Studio", exact: true }),
  ).toBeVisible();
  const collapsedSelector = (await page
    .locator(".project-selector")
    .boundingBox())!;
  const collapsedMenu = (await page.locator(".project-menu").boundingBox())!;
  expect(collapsedMenu.y + collapsedMenu.height).toBeLessThan(
    collapsedSelector.y,
  );
  await page.keyboard.press("Escape");
  const expand = page.getByRole("button", {
    name: "Expand sidebar",
    exact: true,
  });
  await expand.focus();
  await expand.press("Enter");
  await expect(page.locator(".sidebar")).toHaveCSS("width", "240px");
});

test("project menu keeps project selection, keyboard navigation and focus intact", async ({
  page,
}) => {
  const project = page.getByRole("combobox", {
    name: "Select project",
    exact: true,
  });
  await project.focus();
  await project.press("ArrowDown");
  await expect(
    page.getByRole("option", { name: "Orka", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("s");
  await expect(
    page.getByRole("option", { name: "Studio", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(project).toContainText("Studio");
  await expect(project).toBeFocused();
  await project.click();
  await expect(
    page.getByRole("button", { name: "Invite member", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  await expect(project).toContainText("Orka");
  await project.click();
  const accessibility = await new AxeBuilder({ page })
    .include(".project-menu")
    .analyze();
  expect(accessibility.violations).toEqual([]);
  for (const name of [
    "Manage source folders",
    "Copy project link",
    "Manage",
    "Invite member",
  ]) {
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(
      0,
    );
  }
  await page.keyboard.press("Escape");
  await expect(project).toBeFocused();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Settings", exact: true }),
  ).toBeVisible();
  const sync = page.locator(".workspace-header .sync-status");
  await expect(sync).toContainText("Up to date");
  await sync.click();
  await expect(
    page.getByRole("dialog", { name: "Sync status and notifications" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sync).toBeFocused();
});

test("reduced motion keeps shell controls and project selection usable", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await page
    .getByRole("button", { name: "Collapse sidebar", exact: true })
    .click();
  await expect(page.locator(".sidebar")).toHaveCSS("width", "80px");
  await page
    .getByRole("combobox", { name: "Select project: Orka", exact: true })
    .click();
  await page.getByRole("option", { name: "Studio", exact: true }).click();
  await page
    .getByRole("button", { name: "Expand sidebar", exact: true })
    .click();
  await expect(page.locator(".sidebar")).toHaveCSS("width", "240px");
  await expect(
    page.getByRole("combobox", { name: "Select project", exact: true }),
  ).toContainText("Studio");
  const accessibility = await new AxeBuilder({ page })
    .include(".sidebar")
    .include(".workspace-header")
    .analyze();
  expect(accessibility.violations).toEqual([]);
});

test("a long project menu scrolls and keeps keyboard focus within the viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 640 });
  await page.evaluate(() => {
    const w = window as any;
    const original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (name: string, args: any) => {
      const value = await original(name, args);
      return name === "snapshot"
        ? {
            ...value,
            projects: [
              ...value.projects,
              ...Array.from({ length: 30 }, (_, index) => ({
                id: `extra-${index}`,
                name: `Project ${index}`,
                path: null,
                role: "member",
              })),
            ],
          }
        : value;
    };
  });
  await page.locator(".workspace-header .sync-status").click();
  await page.getByRole("button", { name: "Sync now", exact: true }).click();
  await page.keyboard.press("Escape");
  const project = page.getByRole("combobox", {
    name: "Select project",
    exact: true,
  });
  await project.click();
  await expect(page.getByRole("option")).toHaveCount(32);
  const menu = page.locator(".project-menu");
  const bounds = (await menu.boundingBox())!;
  expect(bounds.y).toBeGreaterThanOrEqual(12);
  expect(bounds.y + bounds.height).toBeLessThan(
    (await project.boundingBox())!.y,
  );
  const list = page.getByRole("listbox", { name: "Projects", exact: true });
  expect(
    await list.evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    ),
  ).toBe(true);
  await page.keyboard.press("End");
  await expect(
    page.getByRole("option", { name: "Project 29", exact: true }),
  ).toBeFocused();
  await page.screenshot({ path: "artifacts/project-menu-900.png" });
  await page.keyboard.press("Escape");
  await expect(project).toBeFocused();
});
