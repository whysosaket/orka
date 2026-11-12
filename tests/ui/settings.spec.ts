import { test, expect, type Locator } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { AxeBuilder } from "@axe-core/playwright";
import { settingsFixture, settingsCalls } from "./fixtures/settings.js";
const button = (scope: Locator, name: string) =>
  scope.getByRole("button", { name, exact: true });
async function choose(scope: Locator, label: string, value: string) {
  await scope.getByRole("combobox", { name: label, exact: true }).click();
  await scope.page().getByRole("option", { name: value, exact: true }).click();
}

test("all six destinations and no-project account and Mac settings stay usable", async ({
  page,
}) => {
  const settings = await settingsFixture(page, { noProjects: true });
  await expect(
    settings
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("button"),
  ).toHaveCount(6);
  await expect(button(settings, "General")).toBeDisabled();
  await button(settings, "Profile").click();
  await expect(
    settings.getByRole("textbox", { name: "Display name", exact: true }),
  ).toHaveValue("Morgan Taylor");
  await expect(
    settings.getByRole("textbox", { name: "Email", exact: true }),
  ).not.toBeEditable();
  await button(settings, "Devices").click();
  await expect(
    settings.getByRole("list").getByText("This Mac", { exact: true }),
  ).toBeVisible();
  await button(settings, "Sync & startup").click();
  await expect(button(settings, "15 min")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("profile edits persist, empty name fails safely, and email is read-only", async ({
  page,
}) => {
  const settings = await settingsFixture(page);
  await button(settings, "Profile").click();
  const name = settings.getByRole("textbox", {
    name: "Display name",
    exact: true,
  });
  await name.fill("");
  await button(settings, "Save profile").click();
  await expect(settings.getByRole("alert")).toContainText("Enter a name");
  await name.fill("Morgan Updated");
  await settings
    .getByRole("textbox", { name: "Job role", exact: true })
    .fill("Admin");
  await button(settings, "Save profile").click();
  await expect(settings.getByText("Profile saved.")).toBeVisible();
  await expect(button(settings, "Save profile")).toBeDisabled();
  await button(settings, "Devices").click();
  await button(settings, "Profile").click();
  await expect(name).toHaveValue("Morgan Updated");
  expect(
    await page.evaluate(() => (window as any).settingsState.projects[0].role),
  ).toBe("owner");
});

test("avatar cancellation and corrupt or oversized uploads retain the previous profile", async ({
  page,
}) => {
  const settings = await settingsFixture(page);
  await button(settings, "Profile").click();
  const upload = settings.getByLabel("Upload profile photo");
  await upload.setInputFiles([]);
  await expect(button(settings, "Save profile")).toBeDisabled();
  await upload.setInputFiles({
    name: "corrupt.png",
    mimeType: "image/png",
    buffer: Buffer.from("not an image"),
  });
  await expect(settings.getByRole("alert")).toContainText("Couldn’t open");
  await upload.setInputFiles({
    name: "huge.png",
    mimeType: "image/png",
    buffer: Buffer.alloc(10 * 1024 * 1024 + 1),
  });
  await expect(settings.getByRole("alert")).toContainText("smaller than 10 MB");
  await upload.setInputFiles({
    name: "photo.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await expect(button(settings, "Save profile")).toBeEnabled();
  await button(settings, "Save profile").click();
  await expect(
    settings.getByText("Profile saved.", { exact: true }),
  ).toBeVisible();
  const saved = (await settingsCalls(page)).find(
    (call) => call.args.action === "save-settings-profile",
  );
  expect(saved?.args.input.avatarData).toMatch(/^data:image\/png;base64,/);
});

test("one General save retains failed sharing and acknowledges successful name changes", async ({
  page,
}) => {
  const settings = await settingsFixture(page, { failSharing: true });
  await settings
    .getByRole("textbox", { name: "Project name", exact: true })
    .fill("Orka renamed");
  await choose(settings, "Sessions sharing", "Share automatically");
  await button(settings, "Save changes").click();
  await expect(settings.getByRole("alert")).toContainText(
    "Project name saved.",
  );
  await expect(
    settings.getByRole("textbox", { name: "Project name", exact: true }),
  ).toHaveValue("Orka renamed");
  await expect(
    settings.getByRole("combobox", { name: "Sessions sharing", exact: true }),
  ).toContainText("Share automatically");
  await button(settings, "Save changes").click();
  await expect(button(settings, "Save changes")).toBeDisabled();
  expect(
    (await settingsCalls(page)).filter((call) => call.args.action === "rename"),
  ).toHaveLength(1);
});

test("source picker cancellation and disconnect confirmation preserve unrelated drafts", async ({
  page,
}) => {
  const settings = await settingsFixture(page, {
    cancelPicker: true,
    folderState: "reconnect",
  });
  const name = settings.getByRole("textbox", {
    name: "Project name",
    exact: true,
  });
  await name.fill("Draft name");
  await button(settings, "Reconnect orka folder").click();
  await expect(name).toHaveValue("Draft name");
  const picker = (await settingsCalls(page)).find(
    (call) => call.command === "plugin:dialog|open",
  );
  expect(picker?.args.options).toMatchObject({
    directory: true,
    multiple: false,
    defaultPath: "/Projects/orka",
  });
  await button(settings, "Disconnect orka folder").click();
  await page
    .getByRole("dialog", { name: "Disconnect folder?" })
    .getByRole("button", { name: "Stay", exact: true })
    .click();
  expect(
    (await settingsCalls(page)).some(
      (call) => call.command === "disconnect_project_source",
    ),
  ).toBe(false);
  await expect(button(settings, "Save changes")).toBeEnabled();
});

test("queued writes block disconnect while reconnect remains usable", async ({
  page,
}) => {
  const settings = await settingsFixture(page, {
    queued: true,
    folderState: "reconnect",
  });
  await expect(button(settings, "Disconnect orka folder")).toBeDisabled();
  await expect(button(settings, "Reconnect orka folder")).toBeEnabled();
  expect(
    (await settingsCalls(page)).some(
      (call) => call.command === "disconnect_project_source",
    ),
  ).toBe(false);
});

test("folder recovery states expose paths in name tooltips and reconnect the selected source", async ({
  page,
}, info) => {
  const connected =
    "orka-with-a-long-folder-name-that-must-still-fit-in-the-compact-row";
  const settings = await settingsFixture(page, {
    sourceRows: [
      {
        id: "connected",
        name: connected,
        path: "/Projects/orka",
        folderState: "connected",
      },
      {
        id: "missing",
        name: "orka-website",
        path: "/Moved/orka-website",
        folderState: "reconnect",
      },
      {
        id: "locate",
        name: "documentation",
        path: null,
        folderState: "locate",
      },
    ],
  });
  const folders = settings.getByRole("region", { name: "Source folders" });
  await expect(folders.getByText(connected, { exact: true })).toHaveAttribute(
    "title",
    "/Projects/orka",
  );
  await expect(
    folders.getByText("orka-website", { exact: true }),
  ).toHaveAttribute("title", "/Moved/orka-website");
  await expect(
    folders.getByText("/Projects/orka", { exact: true }),
  ).toHaveCount(0);
  await expect(
    folders.getByRole("button", {
      name: `Reconnect ${connected} folder`,
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(button(folders, "Reconnect orka-website folder")).toBeEnabled();
  await expect(
    button(folders, "Locate Folder for documentation"),
  ).toBeEnabled();
  await expect(folders.locator(".settings-add-folder-row")).toHaveCSS(
    "border-top-width",
    "1px",
  );
  await expect(
    button(folders, "Disconnect documentation folder"),
  ).toBeDisabled();
  for (const width of [1160, 900]) {
    await page.setViewportSize({ width, height: width === 900 ? 640 : 800 });
    await folders.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath(`folder-states-${width}.png`),
    });
  }
  await button(folders, "Reconnect orka-website folder").click();
  await expect(button(folders, "Reconnect orka-website folder")).toHaveCount(0);
  await button(folders, "Locate Folder for documentation").click();
  await expect(
    button(folders, "Disconnect documentation folder"),
  ).toBeEnabled();
  const connections = (await settingsCalls(page)).filter(
    (call) => call.command === "connect_project_sources",
  );
  expect(connections.map((call) => call.args)).toEqual([
    { id: "one", paths: ["/Projects/website"], sourceId: "missing" },
    { id: "one", paths: ["/Projects/website"], sourceId: "locate" },
  ]);
});

test("local names survive shared rename and Use shared name follows the latest name", async ({
  page,
}) => {
  const settings = await settingsFixture(page, { role: "member" });
  const name = settings.getByRole("textbox", {
    name: "Project name",
    exact: true,
  });
  await name.fill("My local project");
  await button(settings, "Save changes").click();
  await page.evaluate(() => {
    (window as any).settingsState.projects[0].name = "Owner renamed it";
  });
  await expect(name).toHaveValue("My local project");
  await button(settings, "Use shared name").click();
  await button(settings, "Save changes").click();
  await expect(name).toHaveValue("Owner renamed it");
  expect(
    (await settingsCalls(page)).filter((call) => call.args.action === "rename"),
  ).toHaveLength(0);
});

test("sync offers exactly three single-select presets with revert and partial failure recovery", async ({
  page,
}) => {
  const settings = await settingsFixture(page, { failBackground: true });
  await button(settings, "Sync & startup").click();
  const group = settings.getByRole("group", {
    name: "Sync interval",
    exact: true,
  });
  await expect(group.getByRole("button")).toHaveText([
    "1 min",
    "5 min",
    "15 min",
  ]);
  await button(settings, "5 min").click();
  await button(settings, "15 min").click();
  await expect(button(settings, "Save changes")).toBeDisabled();
  await button(settings, "5 min").click();
  await settings
    .getByRole("switch", { name: "Background sync", exact: true })
    .uncheck();
  await button(settings, "Save changes").click();
  await expect(settings.getByRole("alert")).toContainText(
    "Sync interval saved.",
  );
  await button(settings, "Save changes").click();
  await expect(button(settings, "Save changes")).toBeDisabled();
  expect(
    (await settingsCalls(page)).filter((call) => call.command === "configure"),
  ).toHaveLength(1);
});

test("changing only background sync preserves a legacy interval", async ({
  page,
}) => {
  const settings = await settingsFixture(page, { interval: 7 });
  await button(settings, "Sync & startup").click();
  await expect(
    settings.getByText(
      "Current interval: 7 minutes. Kept until you choose a preset.",
    ),
  ).toBeVisible();
  await settings
    .getByRole("switch", { name: "Background sync", exact: true })
    .uncheck();
  await button(settings, "Save changes").click();
  expect(
    (await settingsCalls(page)).filter((call) => call.command === "configure"),
  ).toHaveLength(0);
  expect(
    await page.evaluate(() => (window as any).settingsState.config.syncMinutes),
  ).toBe(7);
});

test("permission edit/revert, eight-field locking, and duplicate-click suppression", async ({
  page,
}) => {
  const settings = await settingsFixture(page, { saveDelay: 800 });
  await button(settings, "Permissions").click();
  await expect(settings.getByRole("combobox")).toHaveCount(8);
  await expect(button(settings, "Save changes")).toBeDisabled();
  await choose(settings, "Member Memories access", "Add only");
  await choose(settings, "Member Memories access", "Read only");
  await expect(button(settings, "Save changes")).toBeDisabled();
  await choose(settings, "Member Memories access", "Add only");
  await button(settings, "Save changes").evaluate(
    (element: HTMLButtonElement) => {
      element.click();
      element.click();
    },
  );
  await expect(button(settings, "Saving…")).toBeVisible();
  for (const selector of await settings.getByRole("combobox").all())
    await expect(selector).toBeDisabled();
  await expect(settings.getByText("Permissions saved.")).toBeVisible();
  await expect(button(settings, "Save changes")).toBeDisabled();
  expect(
    (await settingsCalls(page)).filter(
      (call) => call.args.action === "save-role-policy",
    ),
  ).toHaveLength(1);
});

test("lost policy response reconciles the original operation without another logical save", async ({
  page,
}) => {
  const settings = await settingsFixture(page, { policyFailure: "drop" });
  await button(settings, "Permissions").click();
  await choose(settings, "Member Memories access", "Add only");
  await button(settings, "Save changes").click();
  await expect(settings.getByText("Permissions saved.")).toBeVisible();
  const calls = await settingsCalls(page);
  const submitted = calls.find(
    (call) => call.args.action === "save-role-policy",
  )!;
  expect(
    calls.find((call) => call.args.action === "policy-operation")?.args.input
      .operationId,
  ).toBe(submitted.args.input.operationId);
  expect(
    calls.filter((call) => call.args.action === "save-role-policy"),
  ).toHaveLength(1);
});

test("a late permission refresh cannot replace a confirmed save or its revision", async ({
  page,
}) => {
  const settings = await settingsFixture(page);
  await button(settings, "Permissions").click();
  const memories = settings.getByRole("combobox", {
    name: "Member Memories access",
    exact: true,
  });
  await expect(memories).toHaveText("Read only");
  await page.evaluate(() => {
    const w = window as any;
    const invoke = w.__TAURI_INTERNALS__.invoke;
    let held = false;
    w.__TAURI_INTERNALS__.invoke = async (command: string, args: any = {}) => {
      const result = await invoke(command, args);
      if (
        command === "governance_command" &&
        args.action === "catalog" &&
        !held
      ) {
        held = true;
        await new Promise<void>((resolve) => {
          w.releasePermissionRefresh = resolve;
        });
      }
      return result;
    };
    w.settingsState.projects[0].policyRevision++;
  });
  await page.waitForFunction(() => (window as any).releasePermissionRefresh);
  await choose(settings, "Member Memories access", "Read and write");
  await button(settings, "Save changes").click();
  await expect(settings.getByText("Permissions saved.")).toBeVisible();
  await page.evaluate(async () => {
    (window as any).releasePermissionRefresh();
    // Let the released response and the resulting React render finish.
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  await expect(memories).toHaveText("Read and write");
  await expect(button(settings, "Save changes")).toBeDisabled();
  await choose(settings, "Member Sessions access", "Read and write");
  await button(settings, "Save changes").click();
  await expect(settings.getByText("Permissions saved.")).toBeVisible();
  const saves = (await settingsCalls(page)).filter(
    (call) => call.args.action === "save-role-policy",
  );
  expect(saves).toHaveLength(2);
  expect(saves[1].args.input.expectedPolicyRevision).toBe(
    saves[0].args.input.expectedPolicyRevision + 1,
  );
  expect(saves[1].args.input.policies.member.memory).toBe("write");
});

test("conflict review keeps unrelated newer values and requires an explicit resave", async ({
  page,
}) => {
  const settings = await settingsFixture(page, { policyFailure: "conflict" });
  await button(settings, "Permissions").click();
  await choose(settings, "Member Memories access", "Add only");
  await button(settings, "Save changes").click();
  const review = page.getByRole("dialog", {
    name: "Review latest permissions",
  });
  await expect(review).toBeVisible();
  await review.getByRole("button", { name: "Use reviewed values" }).click();
  await expect(
    settings.getByRole("combobox", {
      name: "Admin Skills access",
      exact: true,
    }),
  ).toContainText("Read only");
  await expect(
    settings.getByRole("combobox", {
      name: "Member Memories access",
      exact: true,
    }),
  ).toContainText("Add only");
  await button(settings, "Save changes").click();
  await expect(settings.getByText("Permissions saved.")).toBeVisible();
});

test("offline permission drafts do not auto-submit on reconnect", async ({
  page,
}) => {
  const settings = await settingsFixture(page);
  await button(settings, "Permissions").click();
  await choose(settings, "Member Memories access", "Add only");
  await page.evaluate(() => {
    (window as any).settingsState.sync.online = false;
  });
  await expect(button(settings, "Save changes")).toBeDisabled({
    timeout: 10000,
  });
  await page.evaluate(() => {
    (window as any).settingsState.sync.online = true;
  });
  await expect(button(settings, "Save changes")).toBeEnabled({
    timeout: 10000,
  });
  expect(
    (await settingsCalls(page)).filter(
      (call) => call.args.action === "save-role-policy",
    ),
  ).toHaveLength(0);
  await button(settings, "Save changes").click();
  await expect(settings.getByText("Permissions saved.")).toBeVisible();
});

test("Save Discard and Stay navigation protect drafts, including a failed Save", async ({
  page,
}) => {
  const settings = await settingsFixture(page, { failRename: true });
  const name = settings.getByRole("textbox", {
    name: "Project name",
    exact: true,
  });
  await name.fill("Keep this edit");
  await button(settings, "Devices").click();
  let guard = page.getByRole("dialog", { name: "Save your changes?" });
  await guard.getByRole("button", { name: "Stay", exact: true }).click();
  await expect(name).toHaveValue("Keep this edit");
  await button(settings, "Devices").click();
  guard = page.getByRole("dialog", { name: "Save your changes?" });
  await guard.getByRole("button", { name: "Save", exact: true }).click();
  await expect(guard.getByRole("alert")).toBeVisible();
  await expect(guard).toBeVisible();
  await guard.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    settings.getByRole("heading", { name: "Devices", exact: true }),
  ).toBeVisible();
  await button(settings, "General").click();
  await name.fill("Discard this");
  await button(settings, "Profile").click();
  await page
    .getByRole("dialog", { name: "Save your changes?" })
    .getByRole("button", { name: "Discard", exact: true })
    .click();
  await button(settings, "General").click();
  await expect(name).toHaveValue("Keep this edit");
});

test("loss of Owner access removes policy editing and Save without deleting local state", async ({
  page,
}) => {
  const settings = await settingsFixture(page);
  await button(settings, "Permissions").click();
  await choose(settings, "Member Memories access", "Add only");
  await page.evaluate(() => {
    const w = window as any;
    w.settingsState.projects[0].role = "member";
    w.settingsState.projects[0].policyRevision++;
    w.settingsCatalog.owner = false;
    w.settingsCatalog.role = "member";
  });
  await expect(button(settings, "Save changes")).toHaveCount(0, {
    timeout: 10000,
  });
  await expect(settings.getByRole("combobox")).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as any).settingsState.projects[0].path),
  ).toBe("/Projects/orka");
});

for (const state of ["empty", "unavailable"] as const)
  test(`devices distinguish ${state} and never infer a connection badge`, async ({
    page,
  }, info) => {
    const settings = await settingsFixture(page, { devices: state });
    await button(settings, "Devices").click();
    await expect(
      settings.getByText(
        state === "empty"
          ? "No Macs are registered to your account."
          : "Registered Macs are unavailable.",
        { exact: false },
      ),
    ).toBeVisible();
    await expect(settings.getByText(/^(Connected|Disconnected)$/)).toHaveCount(
      0,
    );
    await page.screenshot({ path: info.outputPath(`devices-${state}.png`) });
  });

test("members create a join link, promote explicitly, and confirm removal", async ({
  page,
}) => {
  const settings = await settingsFixture(page);
  await button(settings, "Members").click();
  const members = settings.getByRole("list");
  await expect(
    members.getByText("morgan@example.com", { exact: true }),
  ).toBeVisible();
  await expect(members.getByText("You", { exact: true })).toBeVisible();
  await button(settings, "Add Member").click();
  const invite = page.getByRole("dialog", { name: "Add Member", exact: true });
  await invite
    .getByRole("button", { name: "Copy joining link", exact: true })
    .click();
  await expect(
    invite.getByRole("textbox", { name: "Joining link" }),
  ).toHaveValue("https://test.orka/join/join-once");
  await invite.getByRole("button", { name: "Done", exact: true }).click();
  await choose(settings, "Role for Jamie Rivera", "Admin");
  await expect(settings.getByText("Role updated.")).toBeVisible();
  await button(settings, "Actions for Jamie Rivera").click();
  await page.getByRole("button", { name: "Remove Admin", exact: true }).click();
  const confirm = page.getByRole("dialog", {
    name: "Remove member?",
    exact: true,
  });
  await confirm.getByRole("button", { name: "Stay", exact: true }).click();
  await expect(
    members.getByText("Jamie Rivera", { exact: true }),
  ).toBeVisible();
});

for (const [width, height] of [
  [1440, 900],
  [1160, 800],
  [900, 640],
])
  test(`six settings layouts, keyboard access, long content, and Skullet geometry at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height });
    const settings = await settingsFixture(page, { long: true, delay: 500 });
    for (const section of [
      "General",
      "Profile",
      "Devices",
      "Sync & startup",
      "Members",
      "Permissions",
    ]) {
      await button(settings, section).click();
      await expect(
        settings.getByRole("heading", { name: section, exact: true }),
      ).toBeVisible();
      if (section === "Permissions")
        await expect(button(settings, "Save changes")).toBeDisabled();
      const initialPermissionGeometry =
        section === "Permissions"
          ? {
              title: await settings
                .getByRole("heading", { name: "Permissions", exact: true })
                .boundingBox(),
              owner: await settings
                .getByRole("region", { name: "Owner permissions", exact: true })
                .boundingBox(),
            }
          : null;
      if (section === "Members" || section === "Permissions") {
        await page.waitForTimeout(220);
        await page.screenshot({
          path: info.outputPath(
            `${section.toLowerCase()}-loading-${width}.png`,
          ),
        });
      }
      if (section === "Permissions")
        await expect(settings.getByRole("combobox")).toHaveCount(8);
      else if (section === "Members")
        await expect(
          settings
            .getByRole("list")
            .getByText("jamie@example.com", { exact: true }),
        ).toBeVisible();
      else if (section === "Devices")
        await expect(
          settings.getByRole("list").getByText("This Mac", { exact: true }),
        ).toBeVisible();
      await expect(settings.locator('[aria-hidden="true"][inert]')).toHaveCount(
        0,
      );
      if (initialPermissionGeometry) {
        const loadedTitle = await settings
          .getByRole("heading", { name: "Permissions", exact: true })
          .boundingBox();
        const loadedOwner = await settings
          .getByRole("region", { name: "Owner permissions", exact: true })
          .boundingBox();
        await writeFile(
          info.outputPath(`permissions-header-${width}.json`),
          JSON.stringify(
            {
              width,
              initial: initialPermissionGeometry,
              loaded: { title: loadedTitle, owner: loadedOwner },
            },
            null,
            2,
          ),
        );
        expect(loadedTitle!.y).toBeCloseTo(
          initialPermissionGeometry.title!.y,
          1,
        );
        expect(loadedOwner!.y).toBeCloseTo(
          initialPermissionGeometry.owner!.y,
          1,
        );
      }
      await page.screenshot({
        path: info.outputPath(
          `${section.toLowerCase().replaceAll(" ", "-")}-${width}.png`,
        ),
      });
      if (section === "Permissions") {
        const select = settings.getByRole("combobox").last();
        await select.focus();
        await page.keyboard.press("Space");
        const menu = page.getByRole("listbox");
        await expect(menu).toBeVisible();
        const popup = await menu.boundingBox();
        expect(popup!.x).toBeGreaterThanOrEqual(0);
        expect(popup!.y).toBeGreaterThanOrEqual(0);
        expect(popup!.x + popup!.width).toBeLessThanOrEqual(width);
        expect(popup!.y + popup!.height).toBeLessThanOrEqual(height);
        await page.screenshot({
          path: info.outputPath(`permission-menu-${width}.png`),
        });
        await page.keyboard.press("Escape");
        await expect(select).toBeFocused();
      }
      const bounds = await settings.boundingBox();
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
    }
    expect(
      (await new AxeBuilder({ page }).include(".settings-workspace").analyze())
        .violations,
    ).toEqual([]);
    const diagnostic = await settingsFixture(page, {
      long: true,
      delay: 500,
      debug: true,
    });
    for (const section of ["Members", "Permissions"]) {
      await button(diagnostic, section).click();
      await expect(
        diagnostic.getByRole("heading", { name: section, exact: true }),
      ).toBeVisible();
      await page.waitForTimeout(220);
      await page.screenshot({
        path: info.outputPath(
          `debug-${section.toLowerCase()}-loading-${width}.png`,
        ),
      });
      await expect(
        diagnostic.locator('[aria-hidden="true"][inert]'),
      ).toHaveCount(0);
      await page.screenshot({
        path: info.outputPath(`debug-${section.toLowerCase()}-${width}.png`),
      });
    }
  });

test("service validation, cancellation, and failed switching keep the current account", async ({
  page,
}) => {
  const settings = await settingsFixture(page);
  await button(settings, "Profile").click();
  await button(settings, "Move to self-hosted").click();
  await button(settings, "Self-hosted").click();
  const url = settings.getByRole("textbox", {
    name: "Self-hosted service URL",
    exact: true,
  });
  await url.fill("not a service");
  await expect(settings.getByRole("alert")).toContainText(
    "Enter a valid server address",
  );
  await expect(button(settings, "Review change")).toBeDisabled();
  await url.fill("https://other.orka");
  await button(settings, "Review change").click();
  await expect(
    settings.getByText("Existing projects and queued changes", {
      exact: false,
    }),
  ).toBeVisible();
  await button(settings, "Cancel").click();
  expect(
    (await settingsCalls(page)).filter(
      (call) => call.command === "switch_service",
    ),
  ).toHaveLength(0);
  await button(settings, "Move to self-hosted").click();
  await button(settings, "Self-hosted").click();
  await expect(url).toHaveValue("https://selfhost.orka");
  await button(settings, "Review change").click();
  await page.evaluate(() => {
    (window as any).settingsControls.failSwitch = true;
  });
  await button(settings, "Switch service and sign in").click();
  await expect(settings.getByRole("alert")).toContainText(
    "Service changed during validation",
  );
  expect(await page.evaluate(() => (window as any).settingsState.user)).toBe(
    "owner",
  );
  expect(
    await page.evaluate(() => (window as any).settingsState.config.apiUrl),
  ).toBe("https://test.orka");
});

test("profile drafts guard service setup and confirmed sign-out clears the Settings scope", async ({
  page,
}) => {
  const settings = await settingsFixture(page);
  await button(settings, "Profile").click();
  await settings
    .getByRole("textbox", { name: "Display name", exact: true })
    .fill("Unsaved name");
  await button(settings, "Move to self-hosted").click();
  const guard = page.getByRole("dialog", {
    name: "Save your changes?",
    exact: true,
  });
  await guard.getByRole("button", { name: "Stay", exact: true }).click();
  await expect(
    settings.getByRole("textbox", { name: "Display name", exact: true }),
  ).toHaveValue("Unsaved name");
  await button(settings, "Sign out").click();
  await guard.getByRole("button", { name: "Discard", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "Sign out?", exact: true });
  await confirm.getByRole("button", { name: "Stay", exact: true }).click();
  await button(settings, "Sign out").click();
  await confirm.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(settings).toHaveCount(0);
  await expect(
    page.getByRole("heading", {
      name: /^(Welcome back to|Get started with) Orka$/,
    }),
  ).toBeVisible();
});

test("delayed policy responses cannot grant Owner controls in a different project", async ({
  page,
}) => {
  const settings = await settingsFixture(page, { delay: 700 });
  await button(settings, "Permissions").click();
  await page
    .getByRole("combobox", { name: "Select project", exact: true })
    .click();
  await page.getByRole("option", { name: "Website", exact: true }).click();
  await expect(button(settings, "Save changes")).toHaveCount(0);
  await expect(
    settings.getByRole("heading", { name: "Permissions", exact: true }),
  ).toBeVisible();
  await expect(
    settings.getByRole("region", { name: "Member permissions" }),
  ).toContainText("No access");
  await expect(button(settings, "Save changes")).toHaveCount(0);
  await expect(settings.getByRole("combobox")).toHaveCount(0);
  await page.waitForTimeout(800);
  await expect(button(settings, "Save changes")).toHaveCount(0);
  expect(
    (await settingsCalls(page)).filter(
      (call) => call.args.action === "save-role-policy",
    ),
  ).toHaveLength(0);
});

test("migration exposes legacy suggestion rules and requires explicit acknowledgement", async ({
  page,
}) => {
  const settings = await settingsFixture(page, { legacy: true });
  await button(settings, "Permissions").click();
  await expect(button(settings, "Save changes")).toHaveCount(0);
  await button(settings, "Review access changes").click();
  const dialog = page.getByRole("dialog", {
    name: "Review role migration",
    exact: true,
  });
  await expect(dialog).toContainText("suggest / suggest");
  await expect(dialog).toContainText("instructions");
  const migrate = dialog.getByRole("button", {
    name: "Confirm migration",
    exact: true,
  });
  await expect(migrate).toBeDisabled();
  await dialog.getByRole("checkbox").check();
  await migrate.click();
  await expect(settings.getByText("Permissions saved.")).toBeVisible();
  const saved = (await settingsCalls(page)).filter(
    (call) => call.args.action === "save-role-policy",
  );
  expect(saved).toHaveLength(1);
  expect(saved[0].args.input.migrationHash).toBe("a".repeat(64));
});

for (const navigateAway of [false, true])
  test(`failed migration retries the original submission${navigateAway ? " after navigation" : " in place"}`, async ({
    page,
  }) => {
    const settings = await settingsFixture(page, {
      legacy: true,
      policyFailure: "offline",
    });
    await button(settings, "Permissions").click();
    await button(settings, "Review access changes").click();
    const migration = page.getByRole("dialog", {
      name: "Review role migration",
    });
    await migration.getByRole("checkbox").check();
    await migration.getByRole("button", { name: "Confirm migration" }).click();
    await expect(button(settings, "Retry save")).toBeEnabled();
    await expect(button(settings, "Review access changes")).toBeDisabled();

    if (navigateAway) {
      await button(settings, "Devices").click();
      await page
        .getByRole("dialog", { name: "Save your changes?", exact: true })
        .getByRole("button", { name: "Leave and check later", exact: true })
        .click();
      await button(settings, "Permissions").click();
      await expect(button(settings, "Review access changes")).toBeDisabled();
      await button(settings, "Check save").click();
      await expect(button(settings, "Retry save")).toBeEnabled();
    }
    await page.evaluate(() => {
      (window as any).settingsControls.policyFailure = "";
    });
    expect(
      (await settingsCalls(page)).filter(
        (call) => call.args.action === "save-role-policy",
      ),
    ).toHaveLength(1);
    await button(settings, "Retry save").click();
    await expect(settings.getByText("Permissions saved.")).toBeVisible();
    await expect(button(settings, "Review access changes")).toHaveCount(0);
    await expect(button(settings, "Save changes")).toBeDisabled();
    await expect(
      settings.getByRole("combobox", {
        name: "Member Memories access",
        exact: true,
      }),
    ).toBeEnabled();
    const saves = (await settingsCalls(page)).filter(
      (call) => call.args.action === "save-role-policy",
    );
    expect(saves).toHaveLength(2);
    expect(saves[0].args.input.migrationHash).toBe("a".repeat(64));
    expect(saves[1].args.input).toEqual(saves[0].args.input);
  });

test("slow loading stays inert, announces once, permits navigation, and ignores late results", async ({
  page,
}, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const settings = await settingsFixture(page, { delay: 9000 });
  await button(settings, "Members").click();
  await expect(settings.getByRole("status")).toHaveText("Loading members…");
  await expect(button(settings, "Add Member")).toHaveCount(0);
  await expect(settings.getByRole("listitem")).toHaveCount(0);
  await expect(settings.locator('[aria-hidden="true"][inert]')).not.toHaveCount(
    0,
  );
  await page.screenshot({
    path: info.outputPath("members-reduced-motion-loading.png"),
  });
  await expect(
    settings.getByText(
      "Still loading members. You can use the other settings.",
    ),
  ).toBeVisible({ timeout: 10000 });
  await button(settings, "General").click();
  await expect(
    settings.getByRole("textbox", { name: "Project name", exact: true }),
  ).toBeEditable();
  await page.waitForTimeout(1100);
  await expect(
    settings.getByRole("heading", { name: "General", exact: true }),
  ).toBeVisible();
  await expect(settings.getByRole("listitem")).toHaveCount(0);
});

test("initial errors end loading and Retry restores real rows", async ({
  page,
}, info) => {
  const settings = await settingsFixture(page, { failInitial: true });
  await button(settings, "Members").click();
  await expect(settings.getByRole("alert")).toContainText(
    "Members are unavailable",
  );
  await expect(settings.locator('[aria-busy="true"]')).toHaveCount(0);
  await expect(settings.getByRole("status")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("members-error-retry.png") });
  await page.evaluate(() => {
    (window as any).settingsControls.failRefresh = false;
  });
  await button(settings, "Retry").click();
  await expect(settings.getByRole("listitem")).toHaveCount(3);
  await expect(settings.getByRole("alert")).toHaveCount(0);
});

test("refresh failure retains confirmed members, focus, and editable role controls", async ({
  page,
}) => {
  const settings = await settingsFixture(page);
  await button(settings, "Members").click();
  await expect(settings.getByRole("listitem")).toHaveCount(3);
  const role = settings.getByRole("combobox", {
    name: "Role for Jamie Rivera",
    exact: true,
  });
  await role.focus();
  await page.evaluate(() => {
    const w = window as any;
    w.settingsControls.failRefresh = true;
    w.settingsState.projects[0].policyRevision++;
  });
  await expect(settings.getByRole("alert")).toContainText(
    "Couldn’t refresh members",
    { timeout: 10000 },
  );
  await expect(settings.getByRole("listitem")).toHaveCount(3);
  await expect(role).toBeFocused();
  await expect(settings.locator('[aria-busy="true"]')).toHaveCount(0);
  await page.evaluate(() => {
    const w = window as any;
    w.settingsControls.failRefresh = false;
    w.settingsCatalog.members[1].name = "Alex Updated";
  });
  await button(settings, "Retry").click();
  await expect(settings.getByRole("list")).toContainText("Alex Updated");
});

test("unknown background preference stays unavailable until the local snapshot confirms it", async ({
  page,
}) => {
  const settings = await settingsFixture(page, { missingPreferences: true });
  await button(settings, "Sync & startup").click();
  await expect(
    settings.getByRole("switch", { name: "Background sync", exact: true }),
  ).toHaveCount(0);
  await expect(button(settings, "15 min")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(button(settings, "Save changes")).toBeDisabled();
  await page.evaluate(() => {
    (window as any).settingsState.background = false;
  });
  await expect(
    settings.getByRole("switch", { name: "Background sync", exact: true }),
  ).not.toBeChecked({ timeout: 10000 });
  await expect(button(settings, "Save changes")).toBeDisabled();
});

test("an uncertain save stays locked across navigation and editing access loss", async ({
  page,
}) => {
  const settings = await settingsFixture(page, {
    policyFailure: "offline",
    saveDelay: 300,
  });
  await button(settings, "Permissions").click();
  await choose(settings, "Member Memories access", "Add only");
  await button(settings, "Save changes").click();
  await expect(button(settings, "Retry save")).toBeEnabled();
  for (const field of await settings.getByRole("combobox").all())
    await expect(field).toBeDisabled();
  await button(settings, "Devices").click();
  await page
    .getByRole("dialog", { name: "Save your changes?", exact: true })
    .getByRole("button", { name: "Leave and check later", exact: true })
    .click();
  await button(settings, "Permissions").click();
  await expect(button(settings, "Check save")).toBeEnabled();
  expect(
    (await settingsCalls(page)).filter(
      (call) => call.args.action === "save-role-policy",
    ),
  ).toHaveLength(1);
  await page.evaluate(() => {
    const w = window as any;
    w.settingsControls.policyFailure = "";
    w.settingsState.projects[0].role = "member";
    w.settingsState.projects[0].policyRevision++;
    w.settingsCatalog.owner = false;
    w.settingsCatalog.role = "member";
  });
  await expect(button(settings, "Save changes")).toHaveCount(0, {
    timeout: 10000,
  });
  await expect(button(settings, "Check save")).toHaveCount(0);
  await expect(settings.getByRole("combobox")).toHaveCount(0);
});

test("a successful response arriving after ownership loss cannot restore editing authority", async ({
  page,
}) => {
  const settings = await settingsFixture(page, { saveDelay: 4500 });
  await button(settings, "Permissions").click();
  await choose(settings, "Member Memories access", "Add only");
  await button(settings, "Save changes").click();
  await expect(button(settings, "Saving…")).toBeDisabled();
  await page.evaluate(() => {
    const w = window as any;
    w.settingsState.projects[0].role = "member";
    w.settingsState.projects[0].policyRevision++;
    w.settingsCatalog.owner = false;
    w.settingsCatalog.role = "member";
  });
  await expect(settings.getByRole("combobox")).toHaveCount(0, {
    timeout: 10000,
  });
  await page.waitForTimeout(4700);
  await expect(button(settings, "Save changes")).toHaveCount(0);
  await expect(settings.getByText("Permissions saved.")).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as any).settingsState.projects[0].path),
  ).toBe("/Projects/orka");
});

test("cached member identities stay readable while refresh fails and older services keep their rules", async ({
  page,
}) => {
  const settings = await settingsFixture(page, {
    cachedMembers: true,
    failInitial: true,
    olderService: true,
  });
  await button(settings, "Members").click();
  await expect(settings.getByRole("list")).toContainText("Jamie Rivera");
  await expect(settings.getByRole("alert")).toContainText(
    "Couldn’t refresh members",
  );
  await expect(settings.locator('[aria-busy="true"]')).toHaveCount(0);
  await page.evaluate(() => {
    (window as any).settingsControls.failRefresh = false;
  });
  await button(settings, "Permissions").click();
  await expect(
    settings.getByText("This service needs an update", { exact: false }),
  ).toBeVisible();
  await expect(button(settings, "Save changes")).toHaveCount(0);
  await expect(settings.getByRole("combobox")).toHaveCount(0);
});

test("a fast profile load reveals usable fields without holding them behind a skeleton", async ({
  page,
}, info) => {
  const settings = await settingsFixture(page, { noProfile: true, delay: 30 });
  await button(settings, "Profile").click();
  const name = settings.getByRole("textbox", {
    name: "Display name",
    exact: true,
  });
  await expect(name).toHaveValue("Morgan Taylor");
  await name.fill("Ready immediately");
  await expect(button(settings, "Save profile")).toBeEnabled();
  await page.screenshot({ path: info.outputPath("profile-fast-reveal.png") });
});

test("sign-out clears an uncertain policy operation before the same account returns", async ({
  page,
}) => {
  const settings = await settingsFixture(page, { policyFailure: "offline" });
  await button(settings, "Permissions").click();
  await choose(settings, "Member Memories access", "Add only");
  await button(settings, "Save changes").click();
  await expect(button(settings, "Retry save")).toBeEnabled();
  await button(settings, "Profile").click();
  await page
    .getByRole("dialog", { name: "Save your changes?", exact: true })
    .getByRole("button", { name: "Leave and check later", exact: true })
    .click();
  await button(settings, "Sign out").click();
  await page
    .getByRole("dialog", { name: "Sign out?", exact: true })
    .getByRole("button", { name: "Sign out", exact: true })
    .click();
  await expect(settings).toHaveCount(0);
  await page.evaluate(() => {
    (window as any).settingsState.user = "owner";
  });
  await page
    .getByRole("button", { name: "Settings", exact: true })
    .click({ timeout: 10000 });
  await button(settings, "Permissions").click();
  await expect(
    settings.getByRole("combobox", {
      name: "Member Memories access",
      exact: true,
    }),
  ).toContainText("Read only");
  await expect(button(settings, "Save changes")).toBeDisabled();
  await expect(button(settings, "Check save")).toHaveCount(0);
  expect(
    (await settingsCalls(page)).filter(
      (call) => call.args.action === "save-role-policy",
    ),
  ).toHaveLength(1);
});

for (const width of [1160, 900])
  test(`email invitation is primary in member settings at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 900 ? 640 : 800 });
    const settings = await settingsFixture(page, { emailInvites: true });
    await button(settings, "Members").click();
    await button(settings, "Add Member").click();
    const dialog = page.getByRole("dialog", {
      name: "Add Member",
      exact: true,
    });
    await expect(dialog.getByLabel("Email address")).toBeFocused();
    await expect(button(dialog, "Send invitation")).toBeDisabled();
    await dialog.getByLabel("Email address").fill("Person@Example.com");
    expect(
      (await new AxeBuilder({ page }).include('[role="dialog"]').analyze())
        .violations,
    ).toEqual([]);
    await button(dialog, "Send invitation").click();
    await expect(dialog.getByRole("status")).toContainText(
      "Invitation sent to person@example.com",
    );
    const invitations = (await settingsCalls(page)).filter(
      (c) => c.command === "cloud_action" && c.args.action === "invite",
    );
    expect(invitations).toHaveLength(1);
    expect(invitations[0].args.input.email).toBe("person@example.com");
    await button(dialog, "Done").click();
    const pending = settings.getByRole("region", {
      name: "Pending invitations",
      exact: true,
    });
    await expect(pending.getByText("person@example.com")).toBeVisible();
    await expect(pending.getByText("Pending", { exact: true })).toBeVisible();
  });

for (const role of ["owner", "admin"] as const)
  test(`${role} sees pending invitations separately from current members`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 900, height: 640 });
    const email = "teammate-with-a-long-email-address@example.com";
    const settings = await settingsFixture(page, {
      role,
      pendingInvites: [{ email, expiresAt: "2026-11-14T12:00:00Z" }],
    });
    await button(settings, "Members").click();
    const pending = settings.getByRole("region", {
      name: "Pending invitations",
      exact: true,
    });
    await expect(pending.getByText(email, { exact: true })).toBeVisible();
    await expect(pending.getByText("Pending", { exact: true })).toBeVisible();
    await expect(pending.getByText("Member", { exact: true })).toBeVisible();
    await expect(pending.locator("time")).toHaveAttribute(
      "datetime",
      "2026-11-14T12:00:00Z",
    );
    await expect(pending.getByRole("combobox")).toHaveCount(0);
    await expect(pending.getByRole("button")).toHaveCount(0);
    expect(
      (await new AxeBuilder({ page }).include(".settings-panel").analyze())
        .violations,
    ).toEqual([]);
    await page.screenshot({ path: info.outputPath(`pending-${role}.png`) });
    await button(settings, "Profile").click();
    await page.evaluate(() => {
      (window as any).settingsCatalog.pendingInvites = [];
    });
    await button(settings, "Members").click();
    await expect(pending).toHaveCount(0);
    await expect(
      settings.getByRole("list").getByText("Jamie Rivera", { exact: true }),
    ).toBeVisible();
  });

test("ordinary members do not render invitation recipients", async ({
  page,
}) => {
  const settings = await settingsFixture(page, {
    role: "member",
    pendingInvites: [
      { email: "private@example.com", expiresAt: "2026-11-14T12:00:00Z" },
    ],
  });
  await button(settings, "Members").click();
  await expect(
    settings.getByRole("list").getByText("Jamie Rivera", { exact: true }),
  ).toBeVisible();
  await expect(settings.getByText("private@example.com")).toHaveCount(0);
  await expect(button(settings, "Add Member")).toHaveCount(0);
});
test("failed email invitation preserves the address and offers a joining link", async ({
  page,
}) => {
  const settings = await settingsFixture(page, {
    emailInvites: true,
    failEmailInvite: true,
  });
  await button(settings, "Members").click();
  await button(settings, "Add Member").click();
  const dialog = page.getByRole("dialog", { name: "Add Member", exact: true });
  await dialog.getByLabel("Email address").fill("teammate@example.com");
  await button(dialog, "Send invitation").click();
  await expect(dialog.getByRole("alert")).toContainText("could not be sent");
  await expect(dialog.getByLabel("Email address")).toHaveValue(
    "teammate@example.com",
  );
  await button(dialog, "Use joining link").click();
  await button(dialog, "Copy joining link").click();
  await expect(dialog.getByLabel("Joining link")).toHaveValue(
    "https://test.orka/join/join-once",
  );
});
