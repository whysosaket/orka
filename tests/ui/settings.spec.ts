import { test, expect, type Page, type Locator } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

const exactButton = (scope: Page | Locator, name: string) =>
  scope.getByRole("button", { name, exact: true });

async function fixture(
  page: Page,
  options: {
    failSharing?: boolean;
    queued?: boolean;
    failBackground?: boolean;
    noProjects?: boolean;
    failRename?: boolean;
    failLocalName?: boolean;
    ownerLocalName?: string;
    sourceFolders?: boolean;
  } = {},
) {
  await page.addInitScript((options) => {
    const off = {
      memory: false,
      session: false,
      plan: false,
      skill: false,
      env: false,
    };
    const projects = options.noProjects
      ? []
      : [
          {
            id: "one",
            name: "Orka",
            localName: options.ownerLocalName ?? null,
            role: "owner",
            path: "/Projects/orka",
            ...(options.sourceFolders
              ? {
                  sources: [
                    { id: "source-one", name: "orka", path: "/Projects/orka" },
                  ],
                }
              : {}),
            sharing: { ...off, memory: true, skill: true },
          },
          {
            id: "two",
            name: "Website",
            role: "member",
            path: null,
            sharing: { ...off },
          },
        ];
    const state = {
      user: "11111111-1111-4111-8111-111111111111",
      config: {
        apiUrl: "https://test.orka",
        mode: "cloud",
        syncMinutes: 15,
        selfHostedUrl: "https://selfhost.orka",
      },
      projects,
      resources: [],
      bindings: [],
      conflicts: [],
      activity: [],
      outbox: options.queued
        ? [{ id: "queued", project: "one", error: "Offline" }]
        : [],
      errors: [],
      sync: { online: true },
      daemon: { running: true },
      devices: [
        {
          id: "mac",
          name: "Owner’s MacBook Pro",
          seen_at: "2026-10-18T12:00:00Z",
        },
        {
          id: "other",
          name: "Teammate’s MacBook Pro",
          seen_at: "2026-10-18T11:45:00Z",
        },
      ],
      deviceId: "mac",
      background: true,
    };
    const calls: { command: string; args: any }[] = [];
    let failedSharing = false;
    let failedBackground = false;
    let failedRename = false;
    let failedLocalName = false;
    Object.assign(window, {
      settingsCalls: calls,
      settingsState: state,
      isTauri: true,
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        unregisterCallback: () => {},
        invoke: async (command: string, args: any = {}) => {
          if (command === "snapshot") return structuredClone(state);
          if (command === "sync_progress")
            return { user: state.user, progress: null };
          calls.push({ command, args });
          if (command === "governance_command" && args.action === "catalog")
            return {
              governed: false,
              owner: false,
              policyRevision: 0,
              members: [],
              resourceCount: 0,
              requests: [],
            };
          if (command === "auth_capabilities")
            return { auth: { password: true, github: true, magicLink: true } };
          if (command === "plugin:dialog|open")
            return options.sourceFolders
              ? "/Projects/orka"
              : "/Projects/website";
          if (command.startsWith("plugin:")) return null;
          if (command === "project_command" && args.action === "local_name") {
            if (options.failLocalName && !failedLocalName) {
              failedLocalName = true;
              throw new Error("Could not save the local name. Try again.");
            }
            Object.assign(
              projects.find((p) => p.id === args.input.projectId)!,
              {
                localName: args.input.name,
              },
            );
          }
          if (command === "project_command" && args.action === "rename") {
            if (options.failRename && !failedRename) {
              failedRename = true;
              throw new Error("Service unavailable. Try again.");
            }
            const project = projects.find(
              (p) => p.id === args.input.projectId,
            )!;
            Object.assign(project, {
              name: args.input.name,
              lifecycleRevision: args.input.expectedRevision + 1,
            });
          }
          if (command === "project_command" && args.action === "sharing") {
            if (options.failSharing && !failedSharing) {
              failedSharing = true;
              throw new Error("Service unavailable. Try again.");
            }
            projects.find((p) => p.id === args.input.projectId)!.sharing =
              args.input.sharing;
          }
          if (command === "configure") state.config = args.config;
          if (command === "background_agent") {
            if (options.failBackground && !failedBackground) {
              failedBackground = true;
              throw new Error("Couldn’t change startup. Try again.");
            }
            state.background = args.enabled;
          }
          if (command === "connect_project_sources")
            projects.find((p) => p.id === args.id)!.path = args.paths[0];
          if (command === "disconnect_project") {
            projects.find((p) => p.id === args.id)!.path = null;
          }
          if (command === "switch_service") {
            state.config = args.config;
            state.user = "";
          }
          if (command === "sign_out") state.user = "";
          return {};
        },
      },
    });
  }, options);
  await page.goto("/");
  await exactButton(page, "Settings").click();
  return page.getByRole("dialog", { name: "Settings", exact: true });
}
const calls = (page: Page) =>
  page.evaluate(
    () => (window as any).settingsCalls as { command: string; args: any }[],
  );

test("a member's personal name survives owner changes and can follow the shared name again", async ({
  page,
}) => {
  const dialog = await fixture(page);
  await dialog.getByRole("combobox", { name: "Settings project" }).click();
  await page.getByRole("option", { name: "Website", exact: true }).click();
  const local = dialog.getByRole("textbox", {
    name: "Project name",
    exact: true,
  });
  await expect(dialog.getByRole("textbox")).toHaveCount(1);
  await local.fill("My website");
  await exactButton(dialog, "Save changes").click();
  await expect(exactButton(dialog, "Save changes")).toBeDisabled();
  await expect(
    dialog.getByRole("combobox", { name: "Settings project" }),
  ).toContainText("My website");
  await page.evaluate(() => {
    (window as any).settingsState.projects[1].name = "Owner renamed website";
  });
  await expect(local).toHaveValue("My website");
  await expect(exactButton(dialog, "Save changes")).toBeDisabled();
  await exactButton(dialog, "Use shared name").click();
  await expect(local).toHaveValue("Owner renamed website", { timeout: 10000 });
  await exactButton(dialog, "Save changes").click();
  await expect(exactButton(dialog, "Save changes")).toBeDisabled();
  await expect(exactButton(dialog, "Use shared name")).toHaveCount(0);
  const mutations = (await calls(page)).filter(
    (c) => c.command === "project_command",
  );
  expect(mutations.map((c) => c.args)).toEqual([
    { action: "local_name", input: { projectId: "two", name: "My website" } },
    { action: "local_name", input: { projectId: "two", name: null } },
  ]);
});

test("the owner's single name field renames globally and retains a failed edit for retry", async ({
  page,
}) => {
  const dialog = await fixture(page, {
    failRename: true,
    ownerLocalName: "Old owner alias",
  });
  const name = dialog.getByRole("textbox", {
    name: "Project name",
    exact: true,
  });
  await expect(dialog.getByRole("textbox")).toHaveCount(1);
  await expect(name).toHaveValue("Orka");
  await expect(exactButton(dialog, "Use shared name")).toHaveCount(0);
  await expect(
    dialog.getByRole("combobox", { name: "Settings project" }),
  ).toContainText("Orka");
  await name.fill("Team Orka");
  await exactButton(dialog, "Save changes").click();
  await expect(dialog.getByRole("alert")).toContainText("Service unavailable");
  await expect(name).toHaveValue("Team Orka");
  await exactButton(dialog, "Save changes").click();
  await expect(exactButton(dialog, "Save changes")).toBeDisabled();
  await expect(name).toHaveValue("Team Orka");
  await expect(
    dialog.getByRole("combobox", { name: "Settings project" }),
  ).toContainText("Team Orka");
  const mutations = (await calls(page)).filter(
    (c) => c.command === "project_command",
  );
  expect(mutations.map((c) => c.args.action)).toEqual(["rename", "rename"]);
  expect(mutations[1].args.input).toEqual(mutations[0].args.input);
  expect(mutations[1].args.input).toMatchObject({
    projectId: "one",
    name: "Team Orka",
    expectedRevision: 0,
  });
});

test("personal names validate, retain failed edits, and guard navigation", async ({
  page,
}) => {
  const dialog = await fixture(page, { failLocalName: true });
  await dialog.getByRole("combobox", { name: "Settings project" }).click();
  await page.getByRole("option", { name: "Website", exact: true }).click();
  const name = dialog.getByRole("textbox", {
    name: "Project name",
    exact: true,
  });
  await name.fill("   ");
  await exactButton(dialog, "Save changes").click();
  await expect(dialog.getByRole("alert")).toContainText("1 to 100 characters");
  expect(
    (await calls(page)).filter((c) => c.command === "project_command"),
  ).toHaveLength(0);
  await name.fill("Personal name");
  await exactButton(dialog, "Open Manage").click();
  const guard = page.getByRole("dialog", { name: "Save your changes?" });
  await expect(guard).toBeVisible();
  await exactButton(guard, "Keep editing").click();
  await exactButton(dialog, "Sharing").click();
  await exactButton(guard, "Save and continue").click();
  await expect(guard.getByRole("alert")).toContainText(
    "Could not save the local name",
  );
  await exactButton(guard, "Keep editing").click();
  await expect(name).toHaveValue("Personal name");
  await exactButton(dialog, "Discard").click();
  await expect(name).toHaveValue("Website");
  await name.fill("Saved name");
  await exactButton(dialog, "Save changes").click();
  await expect(exactButton(dialog, "Save changes")).toBeDisabled();
  await exactButton(dialog, "Close settings").click();
  await page
    .getByRole("combobox", { name: "Select project", exact: true })
    .click();
  await page.getByRole("option", { name: "Saved name", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "Select project", exact: true }),
  ).toContainText("Saved name");
});

for (const size of [
  { width: 1160, height: 800 },
  { width: 900, height: 640 },
]) {
  test(`settings layout, sections, focus, and accessibility at ${size.width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize(size);
    const dialog = await fixture(page);
    await expect(
      page.locator("agentation-toolbar, [data-agentation-portal]"),
    ).toHaveCount(0);
    await expect(
      dialog.getByRole("textbox", { name: "Project name", exact: true }),
    ).toHaveValue("Orka");
    const selector = dialog.getByRole("combobox", { name: "Settings project" });
    const selectorBox = (await selector.boundingBox())!;
    const generalBox = (await exactButton(dialog, "General").boundingBox())!;
    expect(selectorBox.y + selectorBox.height).toBeLessThan(generalBox.y);
    await page.screenshot({
      path: info.outputPath(`settings-general-${size.width}.png`),
    });
    expect(
      (await new AxeBuilder({ page }).include(".settings-modal").analyze())
        .violations,
    ).toEqual([]);
    for (const name of [
      "Source folders",
      "Sharing",
      "Sync & startup",
      "Connected Macs",
      "Account & service",
    ]) {
      await exactButton(dialog, name).click();
      await expect(
        dialog.getByRole("heading", { name, exact: true }),
      ).toBeVisible();
      expect(
        await dialog.evaluate(
          (node) =>
            node.scrollWidth <= node.clientWidth &&
            node.scrollHeight <= node.clientHeight,
        ),
      ).toBe(true);
      const violations = (
        await new AxeBuilder({ page }).include(".settings-modal").analyze()
      ).violations;
      expect(violations).toEqual([]);
      await page.screenshot({
        path: info.outputPath(
          `settings-${name.replaceAll(" ", "-")}-${size.width}.png`,
        ),
      });
    }
    await exactButton(dialog, "Sharing").click();
    await page.screenshot({
      path: info.outputPath(`settings-sharing-${size.width}.png`),
    });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(exactButton(page, "Settings")).toBeFocused();
  });
}

test("save and switch targets the original project, preserves background selection, and isolates drafts", async ({
  page,
}) => {
  const dialog = await fixture(page, { failSharing: true });
  await exactButton(dialog, "Sharing").click();
  await dialog.getByRole("switch", { name: "Plans", exact: true }).check();
  await dialog.getByRole("combobox", { name: "Settings project" }).click();
  await page.getByRole("option", { name: "Website", exact: true }).click();
  const guard = page.getByRole("dialog", { name: "Save your changes?" });
  await guard.getByRole("button", { name: "Keep editing" }).click();
  await expect(
    dialog.getByRole("switch", { name: "Plans", exact: true }),
  ).toBeChecked();
  await dialog.getByRole("combobox", { name: "Settings project" }).click();
  await page.getByRole("option", { name: "Website", exact: true }).click();
  await guard.getByRole("button", { name: "Save and continue" }).click();
  await expect(guard.getByRole("alert")).toContainText("Service unavailable");
  await guard.getByRole("button", { name: "Save and continue" }).click();
  await expect(guard).toBeHidden();
  await expect(
    dialog.getByRole("textbox", { name: "Project name", exact: true }),
  ).toHaveValue("Website");
  await exactButton(dialog, "Sharing").click();
  await expect(
    dialog.getByRole("switch", { name: "Plans", exact: true }),
  ).not.toBeChecked();
  await dialog.getByRole("button", { name: "Close settings" }).click();
  await expect(
    page.getByRole("combobox", { name: "Select project", exact: true }),
  ).toContainText("Orka");
  const mutations = (await calls(page)).filter(
    (c) => c.command === "project_command" && c.args.action === "sharing",
  );
  expect(mutations).toHaveLength(2);
  expect(
    mutations.every(
      (c) =>
        c.args.input.projectId === "one" && c.args.input.sharing.plan === true,
    ),
  ).toBe(true);
});

test("Escape closes the project menu before Settings and restores page interaction", async ({
  page,
}) => {
  const dialog = await fixture(page);
  const selector = dialog.getByRole("combobox", { name: "Settings project" });
  await selector.click();
  await expect(
    page.getByRole("option", { name: "Website", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("option", { name: "Website", exact: true }),
  ).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(selector).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await exactButton(page, "Settings").click();
  await expect(dialog).toBeVisible();
});

test("Escape and backdrop guard unsaved changes; discard never saves", async ({
  page,
}) => {
  const dialog = await fixture(page);
  await exactButton(dialog, "Sharing").click();
  await dialog.getByRole("switch", { name: "Sessions", exact: true }).focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("Escape");
  const guard = page.getByRole("dialog", { name: "Save your changes?" });
  await expect(guard).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(guard).toBeHidden();
  await expect(
    dialog.getByRole("switch", { name: "Sessions", exact: true }),
  ).toBeChecked();
  await page.mouse.click(5, 5, { button: "right" });
  await expect(guard).toBeHidden();
  await expect(dialog).toBeVisible();
  await page.mouse.click(5, 5);
  await guard.getByRole("button", { name: "Discard changes" }).click();
  await expect(dialog).toBeHidden();
  expect(
    (await calls(page)).filter(
      (c) => c.command === "project_command" && c.args.action === "sharing",
    ),
  ).toHaveLength(0);
});

test("sync validation and partial failure preserve only the unsaved startup change", async ({
  page,
}) => {
  const dialog = await fixture(page, { failBackground: true });
  await exactButton(dialog, "Sync & startup").click();
  const interval = dialog.getByRole("spinbutton", {
    name: "Sync every (minutes)",
  });
  await interval.fill("1.5");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog.getByRole("alert")).toContainText("whole number");
  expect(
    (await calls(page)).filter((c) => c.command === "configure"),
  ).toHaveLength(0);
  await interval.fill("30");
  await dialog
    .getByRole("checkbox", { name: /Run in the background/ })
    .uncheck();
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Couldn’t change startup",
  );
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog.getByRole("status")).toHaveText("Sync preferences saved");
  const commands = await calls(page);
  expect(commands.filter((c) => c.command === "configure")).toHaveLength(1);
  expect(commands.filter((c) => c.command === "background_agent")).toHaveLength(
    2,
  );
});

test("queued changes block disconnect and link to sync activity", async ({
  page,
}) => {
  const dialog = await fixture(page, { queued: true });
  await exactButton(dialog, "Source folders").click();
  await expect(exactButton(dialog, "Disconnect folder")).toBeDisabled();
  await dialog.getByRole("button", { name: "View sync activity" }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("dialog", { name: "Sync status and notifications" }),
  ).toBeVisible();
  expect(
    (await calls(page)).some((c) => c.command === "disconnect_project"),
  ).toBe(false);
});

test("folder mutations use the project selected inside settings", async ({
  page,
}) => {
  const dialog = await fixture(page);
  await dialog.getByRole("button", { name: "Manage folder" }).click();
  await exactButton(dialog, "Disconnect folder").click();
  await page
    .getByRole("dialog", { name: "Disconnect folder?" })
    .getByRole("button", { name: "Cancel" })
    .click();
  expect(
    (await calls(page)).some((c) => c.command === "disconnect_project"),
  ).toBe(false);
  await dialog.getByRole("combobox", { name: "Settings project" }).click();
  await page.getByRole("option", { name: "Website", exact: true }).click();
  await dialog.getByRole("button", { name: "Manage folder" }).click();
  await exactButton(dialog, "Connect folder").click();
  await expect(
    dialog.getByText("/Projects/website", { exact: true }),
  ).toBeVisible();
  expect(
    (await calls(page)).find((c) => c.command === "connect_project_sources")
      ?.args,
  ).toEqual({ id: "two", paths: ["/Projects/website"] });
});

for (const width of [1160, 900]) {
  test(`source folders reconnect queued changes at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 900 ? 640 : 800 });
    const dialog = await fixture(page, { sourceFolders: true, queued: true });
    await exactButton(dialog, "Source folders").click();
    await expect(exactButton(dialog, "Disconnect")).toBeDisabled();
    await page.screenshot({
      path: info.outputPath(`source-folders-${width}.png`),
    });
    await exactButton(dialog, "Reconnect folder").click();
    const commands = await calls(page);
    expect(
      commands.find((c) => c.command === "plugin:dialog|open")?.args.options,
    ).toMatchObject({ defaultPath: "/Projects/orka", multiple: false });
    expect(
      commands.find((c) => c.command === "connect_project_sources")?.args,
    ).toEqual({ id: "one", sourceId: "source-one", paths: ["/Projects/orka"] });
    expect(
      commands.some((c) => c.command === "disconnect_project_source"),
    ).toBe(false);
    expect(
      (await new AxeBuilder({ page }).include(".settings-modal").analyze())
        .violations,
    ).toEqual([]);
  });
}

test("service setup is staged, discarded safely, and reviewed before switching", async ({
  page,
}) => {
  const dialog = await fixture(page);
  await exactButton(dialog, "Account & service").click();
  await exactButton(dialog, "Change service").click();
  await exactButton(dialog, "Self-hosted").click();
  await dialog
    .getByRole("textbox", { name: "Self-hosted service URL" })
    .fill("https://new.orka");
  await exactButton(dialog, "General").click();
  await page
    .getByRole("dialog", { name: "Discard service setup?" })
    .getByRole("button", { name: "Discard changes" })
    .click();
  await exactButton(dialog, "Account & service").click();
  await exactButton(dialog, "Change service").click();
  await expect(exactButton(dialog, "Orka Cloud")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await exactButton(dialog, "Self-hosted").click();
  await dialog
    .getByRole("textbox", { name: "Self-hosted service URL" })
    .fill("https://new.orka");
  await exactButton(dialog, "Review change").click();
  expect((await calls(page)).some((c) => c.command === "switch_service")).toBe(
    false,
  );
  await dialog
    .getByRole("button", { name: "Switch service and sign in" })
    .click();
  await expect(dialog).toBeHidden();
  expect(
    (await calls(page)).find((c) => c.command === "switch_service")?.args.config
      .apiUrl,
  ).toBe("https://new.orka");
});

test("account and Mac settings remain available without projects", async ({
  page,
}) => {
  const dialog = await fixture(page, { noProjects: true });
  await expect(
    dialog.getByRole("combobox", { name: "Settings project" }),
  ).toBeDisabled();
  await expect(
    dialog.getByText("Create or join a project to manage its settings."),
  ).toBeVisible();
  await exactButton(dialog, "Sync & startup").click();
  await expect(dialog.getByRole("spinbutton")).toHaveValue("15");
});

test("browsing editable names does not pin a personal name or mutate projects", async ({
  page,
}) => {
  const dialog = await fixture(page);
  const name = dialog.getByRole("textbox", {
    name: "Project name",
    exact: true,
  });
  await expect(name).toHaveValue("Orka");
  await expect(name).toBeEditable();
  await page.evaluate(() => {
    (window as any).settingsState.projects[0].name = "All";
  });
  await expect(name).toHaveValue("All", { timeout: 10000 });
  await expect(
    dialog.getByRole("button", { name: "Save changes" }),
  ).toBeDisabled();
  await expect(dialog.getByRole("textbox")).toHaveCount(1);
  await dialog.getByRole("combobox", { name: "Settings project" }).click();
  await page.getByRole("option", { name: "Website", exact: true }).click();
  await expect(name).toHaveValue("Website");
  await expect(name).toBeEditable();
  await expect(dialog.getByRole("textbox")).toHaveCount(1);
  expect(
    (await calls(page)).filter(({ command }) => command === "project_command"),
  ).toEqual([]);
});

test("opens Manage for the project selected in Settings", async ({ page }) => {
  const dialog = await fixture(page);
  await dialog.getByRole("combobox", { name: "Settings project" }).click();
  await page.getByRole("option", { name: "Website", exact: true }).click();
  await exactButton(dialog, "Open Manage").click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".workspace-header h1")).toHaveText("Manage");
  await expect(
    page.getByRole("combobox", { name: "Select project" }),
  ).toContainText("Website");
});
