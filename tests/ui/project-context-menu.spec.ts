import { test, expect, type Page } from "@playwright/test";
import { settingsFixture, settingsCalls } from "./fixtures/settings.js";

async function projectMenu(page: Page, name: string) {
  await page
    .getByRole("combobox", { name: "Select project", exact: true })
    .click();
  await page
    .getByRole("option", { name, exact: true })
    .click({ button: "right" });
  return page.getByRole("menu", { name: `Actions for ${name}`, exact: true });
}

test("project option context menus target the clicked project without selecting it", async ({
  page,
}) => {
  await settingsFixture(page);
  const picker = page.getByRole("combobox", {
    name: "Select project",
    exact: true,
  });
  await picker.click();
  const website = page.getByRole("option", { name: "Website", exact: true });
  await website.click({ button: "right" });
  const menu = page.getByRole("menu", {
    name: "Actions for Website",
    exact: true,
  });
  await expect(menu).toBeVisible();
  await expect(picker).toContainText("Orka");
  await expect(
    menu.getByRole("menuitem", { name: "Rename on this Mac…", exact: true }),
  ).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "Rename project…", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(
    page.getByRole("listbox", { name: "Projects", exact: true }),
  ).toBeVisible();
  await expect(website).toBeFocused();
  await website.press("Shift+F10");
  await menu
    .getByRole("menuitem", { name: "Project settings…", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Project name", exact: true }),
  ).toHaveValue("Website");
  await expect(picker).toContainText("Orka");
});

test("source context and ellipsis menus share actions and bind native reveal to the chosen source", async ({
  page,
}) => {
  const settings = await settingsFixture(page, {
    sourceRows: [
      {
        id: "desktop",
        name: "desktop",
        path: "/Projects/desktop",
        folderState: "connected",
      },
      {
        id: "api",
        name: "api",
        path: "/Projects/api",
        folderState: "connected",
      },
    ],
  });
  await page.evaluate(() => {
    const host = window as unknown as {
      copiedPaths: string[];
      settingsCalls: { command: string; args: unknown }[];
      __TAURI_INTERNALS__: {
        invoke: (
          command: string,
          args?: Record<string, unknown>,
        ) => Promise<unknown>;
      };
    };
    const original = host.__TAURI_INTERNALS__.invoke;
    host.copiedPaths = [];
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (value: string) => {
          host.copiedPaths.push(value);
        },
      },
    });
    host.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
      if (command === "resource_command") {
        host.settingsCalls.push({ command, args });
        return { paths: ["/Projects/api"] };
      }
      return original(command, args);
    };
  });
  const row = settings.locator(".settings-folder-row").filter({
    has: page.locator(".settings-folder-name", { hasText: /^api$/ }),
  });
  const menu = page.getByRole("menu", { name: "Options for api", exact: true });
  await row.click({ button: "right" });
  const contextActions = await menu.getByRole("menuitem").allTextContents();
  await page.keyboard.press("Escape");
  await settings
    .getByRole("button", { name: "Options for api", exact: true })
    .click();
  expect(await menu.getByRole("menuitem").allTextContents()).toEqual(
    contextActions,
  );
  await menu
    .getByRole("menuitem", { name: "Show in Finder", exact: true })
    .click();
  await expect
    .poll(async () =>
      (await settingsCalls(page)).filter(
        (call) => call.command === "resource_command",
      ),
    )
    .toEqual([
      {
        command: "resource_command",
        args: {
          action: "reveal",
          input: {
            accountId: "owner",
            serviceOrigin: "https://test.orka",
            projectId: "one",
            sourceId: "api",
          },
        },
      },
    ]);
  await settings
    .getByRole("button", { name: "Options for api", exact: true })
    .click();
  await menu
    .getByRole("menuitem", { name: "Copy folder path", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { copiedPaths: string[] }).copiedPaths,
      ),
    )
    .toEqual(["/Projects/api"]);
  await expect(
    page.getByText("Folder path copied", { exact: true }),
  ).toBeVisible();
});

test("project context navigation preserves a settings draft until explicitly discarded", async ({
  page,
}) => {
  const settings = await settingsFixture(page);
  const name = settings.getByRole("textbox", {
    name: "Project name",
    exact: true,
  });
  await name.fill("Unsaved Orka name");
  const menu = await projectMenu(page, "Website");
  await menu
    .getByRole("menuitem", { name: "Project settings…", exact: true })
    .click();
  const guard = page.getByRole("dialog", {
    name: "Save your changes?",
    exact: true,
  });
  await expect(guard).toBeVisible();
  await guard.getByRole("button", { name: "Stay", exact: true }).click();
  await expect(name).toHaveValue("Unsaved Orka name");
  await expect(
    page.getByRole("combobox", { name: "Select project", exact: true }),
  ).toContainText("Orka");
  const retryMenu = await projectMenu(page, "Website");
  await retryMenu
    .getByRole("menuitem", { name: "Project settings…", exact: true })
    .click();
  await guard.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(name).toHaveValue("Website");
  expect(
    (await settingsCalls(page)).some((call) => call.args.action === "rename"),
  ).toBe(false);
});

test("saving before project context navigation writes the original project and opens the requested section", async ({
  page,
}) => {
  const settings = await settingsFixture(page);
  await settings
    .getByRole("combobox", { name: "Sessions sharing", exact: true })
    .click();
  await page
    .getByRole("option", { name: "Share automatically", exact: true })
    .click();
  const menu = await projectMenu(page, "Website");
  await menu.getByRole("menuitem", { name: "Members…", exact: true }).click();
  const guard = page.getByRole("dialog", {
    name: "Save your changes?",
    exact: true,
  });
  await guard.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    settings.getByRole("heading", { name: "Members", exact: true }),
  ).toBeVisible();
  expect(
    (await settingsCalls(page)).find((call) => call.args.action === "sharing")
      ?.args.input,
  ).toMatchObject({ projectId: "one", sharing: { session: true } });
  await settings.getByRole("button", { name: "General", exact: true }).click();
  await expect(
    settings.getByRole("textbox", { name: "Project name", exact: true }),
  ).toHaveValue("Website");
  await expect(
    page.getByRole("combobox", { name: "Select project", exact: true }),
  ).toContainText("Orka");
});

test("queued source changes disable disconnect through both menu entry points", async ({
  page,
}) => {
  const settings = await settingsFixture(page, { queued: true });
  const row = settings
    .locator(".settings-folder-row")
    .filter({ hasText: "orka" });
  const menu = page.getByRole("menu", {
    name: "Options for orka",
    exact: true,
  });
  await row.click({ button: "right" });
  await expect(
    menu.getByRole("menuitem", {
      name: "Disconnect folder on this Mac",
      exact: true,
    }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await settings
    .getByRole("button", { name: "Options for orka", exact: true })
    .click();
  await expect(
    menu.getByRole("menuitem", {
      name: "Disconnect folder on this Mac",
      exact: true,
    }),
  ).toBeDisabled();
  expect(
    (await settingsCalls(page)).filter(
      (call) => call.command === "disconnect_project_source",
    ),
  ).toHaveLength(0);
});

test("member context removal opens the existing confirmation without removing the member", async ({
  page,
}) => {
  const settings = await settingsFixture(page);
  await settings.getByRole("button", { name: "Members", exact: true }).click();
  const member = settings
    .locator(".settings-member-row")
    .filter({ hasText: "Jamie Rivera" });
  const menu = page.getByRole("menu", {
    name: "Actions for Jamie Rivera",
    exact: true,
  });
  await member.click({ button: "right" });
  const contextActions = await menu.getByRole("menuitem").allTextContents();
  await page.keyboard.press("Escape");
  await settings
    .getByRole("button", { name: "Actions for Jamie Rivera", exact: true })
    .click();
  expect(await menu.getByRole("menuitem").allTextContents()).toEqual(
    contextActions,
  );
  await menu
    .getByRole("menuitem", { name: "Remove Member", exact: true })
    .click();
  const confirmation = page.getByRole("dialog", {
    name: "Remove member?",
    exact: true,
  });
  await expect(confirmation).toBeVisible();
  expect(
    (await settingsCalls(page)).some(
      (call) => call.args.action === "remove-member",
    ),
  ).toBe(false);
  await confirmation.getByRole("button", { name: "Stay", exact: true }).click();
  await expect(member).toBeVisible();
});

test("member role cannot access owner context actions", async ({ page }) => {
  const settings = await settingsFixture(page, { role: "member" });
  await settings.getByRole("button", { name: "Members", exact: true }).click();
  const member = settings
    .locator(".settings-member-row")
    .filter({ hasText: "Jamie Rivera" });
  await expect(member).toHaveCount(1);
  await member.click({ button: "right" });
  await expect(
    page.getByRole("menuitem", {
      name: /Remove|Transfer ownership|Change role/,
    }),
  ).toHaveCount(0);
  await expect(
    settings.getByRole("button", {
      name: "Actions for Jamie Rivera",
      exact: true,
    }),
  ).toHaveCount(0);
});
