import { ENV_ENABLED } from "../../apps/mac/src/lib/features.js";
import { test, expect, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

async function fixture(page: Page, names = ["desktop", "backend"]) {
  await page.addInitScript((names) => {
    const calls: { command: string; args: Record<string, unknown> }[] = [];
    const repositories = [
      { id: "desktop", name: names[0], path: "/local/desktop" },
      { id: "backend", name: names[1], path: "/different/backend" },
    ];
    const resources = repositories.flatMap((source) =>
      ["memory", "skill", "session", "plan"].map((kind) => ({
        resourceId: `${kind}-${source.id}`,
        sourceId: source.id,
        projectId: "project",
        kind,
        source: "shared",
        logicalPath: "instructions/AGENTS.md",
        title: `${source.id} ${kind === "memory" ? "instructions" : kind}`,
        global: kind === "skill",
        files: [
          {
            path: kind === "skill" ? "SKILL.md" : "content.md",
            hash: "h",
            size: 5,
            executable: false,
          },
        ],
        deleted: false,
        revision: 1,
        owner: "user",
        updatedBy: "user",
        updatedAt: "2026-10-21T10:00:00Z",
      })),
    );
    Object.assign(window, {
      sourceCalls: calls,
      isTauri: true,
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        unregisterCallback: () => {},
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          if (command === "snapshot")
            return {
              user: "user",
              config: { apiUrl: "https://test.orka", syncMinutes: 15 },
              projects: [
                {
                  id: "project",
                  name: "Product",
                  role: "owner",
                  sources: repositories,
                },
                {
                  id: "other",
                  name: "Another project",
                  role: "owner",
                  sources: [
                    { id: "other-source", name: "other", path: "/local/other" },
                  ],
                },
              ],
              resources,
              bindings: [],
              conflicts: [],
              activity: [],
              outbox: [{ id: "queued", project: "project", error: null }],
              errors: [],
              sync: { online: true },
              daemon: { running: true },
              devices: [],
              deviceId: "mac",
              background: true,
            };
          if (command === "sync_progress")
            return { user: "user", progress: null };
          calls.push({ command, args });
          if (command === "plugin:dialog|open")
            return (args.options as { multiple?: boolean })?.multiple
              ? ["/new/desktop", "/new/backend"]
              : "/new";
          if (command === "scan_project_folders")
            return [
              { name: "desktop", path: "/new/desktop" },
              { name: "backend", path: "/new/backend" },
            ];
          if (command === "cloud_action") return { id: "created" };
          if (command === "inspect_resource")
            return { content: "Skill description", previous: null, paths: [] };
          if (command === "session_display_title") return null;
          if (command === "session_messages")
            return { messages: [], total: 0, offset: 0 };
          if (command === "project_skill_usage") return { counts: {} };
          if (command === "env_command") {
            if (args.action === "capabilities")
              return { supported: true, enabled: true };
            if (args.action === "list")
              return {
                sets: repositories.map((source) => ({
                  setId: `env-${source.id}`,
                  projectId: "project",
                  sourceId: source.id,
                  name: `${source.id} environment`,
                  creator: "user",
                  approved: true,
                  revision: 1,
                  accessRevision: 1,
                  grants: ["user"],
                  updatedAt: "2026-10-21T10:00:00Z",
                })),
                pending: [],
                members: [],
                device: { id: "mac" },
              };
            if (args.action === "import")
              return {
                draftId: "draft",
                projectId: "project",
                sourceId: (args.input as { sourceId: string }).sourceId,
                setId: "new",
                keys: ["API_URL"],
                revision: null,
                manifest: null,
              };
          }
          if (command.startsWith("plugin:")) return null;
          return {};
        },
      },
    });
  }, names);
  await page.goto("/");
  await expect(
    page.getByRole("combobox", { name: "Select project", exact: true }),
  ).toBeVisible();
}

for (const viewport of [
  { width: 1160, height: 800 },
  { width: 900, height: 640 },
]) {
  test(`parent scan is reviewed before connecting folders at ${viewport.width}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await fixture(page);
    await page
      .getByRole("button", { name: "Add project", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByRole("textbox", { name: "Project name" })
      .fill("Product workspace");
    await dialog.getByRole("button", { name: "Scan parent folder" }).click();
    const desktop = dialog.getByRole("checkbox", {
      name: /desktop.*\/new\/desktop/,
    });
    const backend = dialog.getByRole("checkbox", {
      name: /backend.*\/new\/backend/,
    });
    await expect(desktop).not.toBeChecked();
    await expect(backend).not.toBeChecked();
    await desktop.check();
    await backend.check();
    expect(
      (await new AxeBuilder({ page }).include('[role="dialog"]').analyze())
        .violations,
    ).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`source-scan-${viewport.width}.png`),
    });
    await dialog
      .getByRole("button", { name: "Create project", exact: true })
      .click();
    await expect(dialog).toBeHidden();
    const calls = await page.evaluate(
      () =>
        (
          window as unknown as {
            sourceCalls: { command: string; args: unknown }[];
          }
        ).sourceCalls,
    );
    expect(
      calls.find((call) => call.command === "connect_project_sources")?.args,
    ).toEqual({ id: "created", paths: ["/new/desktop", "/new/backend"] });
  });
}

test("repository filters distinguish same-path resources and remain clearable", async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole("button", { name: /^Memories/ }).click();
  const filter = page.getByRole("combobox", {
    name: "Filter by repository",
    exact: true,
  });
  await expect(
    page.getByRole("button", { name: "desktop instructions", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "backend instructions", exact: true }),
  ).toBeVisible();
  await filter.click();
  await page.getByRole("option", { name: "backend", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "desktop instructions", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "backend instructions", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("searchbox", { name: "Search memories" })
    .fill("missing");
  await expect(filter).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(filter).toHaveText("All repositories");
  await expect(
    page.getByRole("button", { name: "desktop instructions", exact: true }),
  ).toBeVisible();
});

for (const viewport of [
  { width: 1160, height: 800 },
  { width: 900, height: 640 },
]) {
  test(`repository context stays in the header across collections at ${viewport.width}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const longName = "orka-desktop-with-a-very-long-repository-name";
    await fixture(page, [longName, "orka-api"]);
    const header = page.locator(".workspace-header");
    const filter = header.getByRole("combobox", {
      name: "Filter by repository",
    });
    await expect(filter).toHaveCount(0);
    for (const [tab, kind] of [
      ["Memories", "memory"],
      ["Skills", "skill"],
      ["Sessions", "session"],
      ["Plans", "plan"],
      ...(ENV_ENABLED ? [["ENVs", "env"]] : []),
    ]) {
      await page.getByRole("button", { name: new RegExp(`^${tab}`) }).click();
      await expect(filter).toBeVisible();
      await expect(
        page.getByRole("combobox", { name: /Filter.*repository/ }),
      ).toHaveCount(1);
      if (kind === "env") {
        await expect(page.locator(".env-list-item")).toHaveCount(2);
      } else if (kind === "skill") {
        const card = page.locator('[data-resource-id="skill-desktop"]');
        await expect(card.locator(".resource-repository")).toHaveAttribute(
          "title",
          longName,
        );
        await expect(card.locator(".skill-card-meta")).not.toContainText(
          longName,
        );
        await expect(card.locator(".skill-origin-badge")).toHaveText("Global");
      } else {
        await expect(
          page.getByRole("columnheader", { name: "Repository", exact: true }),
        ).toHaveCount(1);
        await expect(page.locator(".resource-table-repository")).toHaveCount(2);
        const columns = await page
          .locator("tbody tr")
          .first()
          .evaluate((row) => {
            const metadata = Array.from(row.querySelectorAll("td")).slice(0, 4);
            return metadata.map((cell) => ({
              width: cell.getBoundingClientRect().width,
              paddingLeft: getComputedStyle(cell).paddingLeft,
              paddingRight: getComputedStyle(cell).paddingRight,
              align: getComputedStyle(cell).textAlign,
            }));
          });
        expect(new Set(columns.map((column) => column.width)).size).toBe(1);
        expect(new Set(columns.map((column) => column.paddingLeft)).size).toBe(
          1,
        );
        expect(
          columns.every(
            (column) =>
              column.paddingLeft === column.paddingRight &&
              column.align === "left",
          ),
        ).toBe(true);
        const sourceFits = await page
          .locator("tbody tr")
          .first()
          .locator("td")
          .nth(1)
          .evaluate((cell) => {
            const pill = cell.querySelector(".resource-source-pill")!;
            return (
              pill.getBoundingClientRect().right <=
              cell.getBoundingClientRect().right -
                parseFloat(getComputedStyle(cell).paddingRight) +
                1
            );
          });
        expect(sourceFits).toBe(true);
      }
      await page.screenshot({
        path: testInfo.outputPath(`${kind}-${viewport.width}.png`),
      });
      const overflowing = await page
        .locator(".resource-repository")
        .filter({ hasText: longName })
        .first()
        .evaluate((el) => ({
          text: el.lastElementChild!.scrollWidth,
          width: el.lastElementChild!.clientWidth,
        }));
      expect(overflowing.text).toBeGreaterThan(overflowing.width);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
      ).toBe(false);
      expect(
        (await new AxeBuilder({ page }).include("main").analyze()).violations,
      ).toEqual([]);
    }
    const geometry = await header.evaluate((el) => {
      const filter = el.querySelector(".workspace-repository-filter")!,
        status = el.querySelector(".sync-status")!;
      return {
        filterHeight: filter.getBoundingClientRect().height,
        statusHeight: status.getBoundingClientRect().height,
        filterRadius: getComputedStyle(filter).borderRadius,
        statusRadius: getComputedStyle(status).borderRadius,
        filterRight: filter.getBoundingClientRect().right,
        statusLeft: status.getBoundingClientRect().left,
      };
    });
    expect(geometry.filterHeight).toBe(32);
    expect(geometry.statusHeight).toBe(32);
    expect(geometry.filterRadius).toBe(geometry.statusRadius);
    expect(geometry.filterRight).toBeLessThan(geometry.statusLeft);
    await expect(header.locator(".sync-status-label")).toHaveText("Pending");
    await expect(header.locator(".sync-status")).toHaveAttribute(
      "aria-label",
      "Changes pending",
    );
    await filter.click();
    await expect(
      page.getByRole("option", { name: longName, exact: true }),
    ).toHaveAttribute("title", longName);
    await page.screenshot({
      path: testInfo.outputPath(`repository-menu-${viewport.width}.png`),
    });
    expect(
      (await new AxeBuilder({ page }).include('[role="listbox"]').analyze())
        .violations,
    ).toEqual([]);
  });
}

test("one repository selection follows tabs, supports the keyboard, and resets on project changes", async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole("button", { name: /^Memories/ }).click();
  const filter = page.getByRole("combobox", { name: "Filter by repository" });
  await filter.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("option", { name: "All repositories", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("End");
  await expect(
    page.getByRole("option", { name: "backend", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(filter).toBeFocused();
  await expect(filter).toHaveText("backend");
  for (const [tab, selector] of [
    ["Memories", "tbody tr"],
    ["Skills", ".skill-card"],
    ["Sessions", "tbody tr"],
    ["Plans", "tbody tr"],
    ...(ENV_ENABLED ? [["ENVs", ".env-list-item"]] : []),
  ]) {
    await page.getByRole("button", { name: new RegExp(`^${tab}`) }).click();
    await expect(filter).toHaveText("backend");
    await expect(page.locator(selector)).toHaveCount(1);
    await expect(page.locator(selector)).toContainText("backend");
  }
  await page
    .getByRole("combobox", { name: "Select project", exact: true })
    .click();
  await page
    .getByRole("option", { name: "Another project", exact: true })
    .click();
  await expect(filter).toHaveCount(0);
  await page
    .getByRole("combobox", { name: "Select project", exact: true })
    .click();
  await page.getByRole("option", { name: "Product", exact: true }).click();
  await expect(filter).toHaveText("All repositories");
  await filter.click();
  await page.keyboard.press("Escape");
  await expect(filter).toBeFocused();
});

test("duplicate repository names stay distinguishable in the custom picker", async ({
  page,
}) => {
  await fixture(page, ["orka", "orka"]);
  await page.getByRole("button", { name: /^Memories/ }).click();
  const filter = page.getByRole("combobox", { name: "Filter by repository" });
  await filter.click();
  await expect(
    page.getByRole("option", { name: "orka · deskto", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("option", { name: "orka · backen", exact: true })
    .click();
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody tr")).toContainText("backend instructions");
});

test("Home can open a resource outside the previous repository selection", async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole("button", { name: /^Memories/ }).click();
  const filter = page.getByRole("combobox", { name: "Filter by repository" });
  await filter.click();
  await page.getByRole("option", { name: "backend", exact: true }).click();
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(filter).toHaveCount(0);
  await page.locator('[data-resource-id="memory-desktop"]').click();
  await expect(page.locator(".resource-detail h2").first()).toHaveText(
    "desktop instructions",
  );
  await expect(filter).toHaveText("All repositories");
});

test("ENV repository filtering keeps an unpublished draft and hides other set details", async ({
  page,
}) => {
  test.skip(!ENV_ENABLED, "ENV support is temporarily disabled");
  await fixture(page);
  await page.getByRole("button", { name: "ENVs", exact: true }).click();
  await page.getByRole("button", { name: /desktop environment/ }).click();
  await expect(page.locator(".env-detail h2")).toHaveText(
    "desktop environment",
  );
  const filter = page.getByRole("combobox", { name: "Filter by repository" });
  await filter.click();
  await page.getByRole("option", { name: "backend", exact: true }).click();
  await expect(page.locator(".env-detail h2")).toHaveText("Choose an ENV set");
  await page.getByRole("button", { name: "New ENV set", exact: true }).click();
  await expect(page.getByRole("dialog").getByLabel("Repository")).toHaveValue(
    "backend",
  );
  await page
    .getByLabel("ENV assignments", { exact: true })
    .fill("API_URL=https://example.test");
  await page.getByRole("button", { name: "Review keys", exact: true }).click();
  await expect(page.locator(".env-draft-item")).toContainText("backend");
  await filter.click();
  await page.getByRole("option", { name: "desktop", exact: true }).click();
  await expect(page.locator(".env-draft-item")).toContainText("backend");
  await expect(page.locator(".env-detail")).toContainText("API_URL");
  const commands = await page.evaluate(
    () =>
      (
        window as unknown as {
          sourceCalls: { command: string; args: { action?: string } }[];
        }
      ).sourceCalls,
  );
  expect(
    commands.filter(
      (c) => c.command === "env_command" && c.args.action === "discard",
    ),
  ).toHaveLength(0);
});
