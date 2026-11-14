import { expect, test, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { settingsCalls, settingsFixture } from "./fixtures/settings.js";

const available = {
  installedVersion: "0.3.0",
  update: {
    version: "0.3.1",
    sha256: "a".repeat(64),
    notes:
      "Fixes a startup crash and improves recovery after an unexpected exit.",
  },
};

const updateCalls = async (page: Page) =>
  (await settingsCalls(page)).filter(
    ({ command }) => command === "update_status",
  );

const emitMenuCheck = (page: Page) =>
  page.evaluate(() => (window as any).settingsEmit("check-for-updates", null));

const updatesPanel = (page: Page) =>
  page.locator('.settings-panel[data-section="updates"]');

test("the sidebar shows updates only when a release is available", async ({
  page,
}) => {
  await settingsFixture(page, {
    update: { installedVersion: "0.3.0" },
  });
  await expect
    .poll(async () =>
      (await settingsCalls(page)).some(
        ({ command }) => command === "update_status",
      ),
    )
    .toBe(true);
  await expect(
    page.getByRole("button", { name: "Update available" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Available update" }),
  ).toHaveCount(0);
});

test("the expanded sidebar shows the compact update card in Settings and across tabs", async ({
  page,
}, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const settings = await settingsFixture(page, { update: available });
  const sidebar = page.locator(".sidebar");
  const review = sidebar.getByRole("region", { name: "Available update" });
  await expect(settings).toBeVisible();
  await expect(review).toBeVisible();
  await expect(review.getByText("Orka v0.3.1", { exact: true })).toBeVisible();
  await expect(
    review.getByText("Hurray! An update is available."),
  ).toBeVisible();
  await expect(review).not.toContainText(available.update.notes);
  await expect(review).not.toContainText("Installed 0.3.0");
  await expect(
    sidebar.getByRole("button", { name: "Update available", exact: true }),
  ).toHaveCount(0);
  const panel = (await review.boundingBox())!;
  const rail = (await sidebar.boundingBox())!;
  expect(panel.x).toBeGreaterThanOrEqual(rail.x);
  expect(panel.x + panel.width).toBeLessThanOrEqual(rail.x + rail.width + 1);
  await page.screenshot({
    path: info.outputPath("settings-sidebar-update.png"),
    animations: "disabled",
  });

  await sidebar.getByRole("button", { name: "Home", exact: true }).click();
  await expect(review).toBeVisible();
  await sidebar.getByRole("button", { name: /^Memories(?: |$)/ }).click();
  await expect(
    page.getByRole("heading", { name: "Memories", exact: true }),
  ).toBeVisible();
  await expect(review).toBeVisible();
  await page.screenshot({
    path: info.outputPath("sidebar-update-review.png"),
    animations: "disabled",
  });

  const changelog = review.getByRole("link", { name: "View changelog" });
  await expect(changelog).toHaveAttribute(
    "href",
    "https://github.com/whysosaket/orka/releases/tag/v0.3.1",
  );
  await changelog.click();
  await expect
    .poll(
      async () =>
        (await settingsCalls(page)).find(
          ({ command }) => command === "open_update_changelog",
        )?.args,
    )
    .toEqual({ version: available.update.version });
  await review.getByRole("button", { name: "Close update" }).click();
  await expect(review).toHaveCount(0);
  expect(
    (await settingsCalls(page)).some(
      ({ command }) => command === "update_install",
    ),
  ).toBe(false);
});

test("the collapsed sidebar anchors the review beside its icon and shows installer errors", async ({
  page,
}, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await settingsFixture(page, {
    update: available,
    updateInstallError: "The download could not be verified.",
  });
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  const trigger = page.getByRole("button", { name: "Update available" });
  await trigger.click();
  const review = page.getByRole("dialog", { name: "Available update" });
  await expect(review).toHaveAttribute("data-side", "right");
  await page.screenshot({
    path: info.outputPath("sidebar-update-collapsed.png"),
    animations: "disabled",
  });
  await review.getByRole("button", { name: "Update and Restart" }).click();
  await expect(review.getByRole("alert")).toHaveText(
    "The download could not be verified.",
  );
  await expect(
    review.getByRole("button", { name: "Update and Restart" }),
  ).toBeEnabled();
  const installCalls = (await settingsCalls(page)).filter(
    ({ command }) => command === "update_install",
  );
  expect(installCalls).toEqual([
    {
      command: "update_install",
      args: {
        version: available.update.version,
        sha256: available.update.sha256,
      },
    },
  ]);
  await review.getByRole("button", { name: "Close update" }).click();
  await expect(review).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("an update shows download progress, verification, restart, and a retry after failure", async ({
  page,
}, info) => {
  await settingsFixture(page, {
    update: available,
    updateInstallDelay: 3000,
    updateInstallError:
      "Quit Orka and finish any running sync, then try again.",
  });
  const review = page.getByRole("region", { name: "Available update" });
  await review.getByRole("button", { name: "Update and Restart" }).click();
  await expect(review.getByRole("status")).toHaveText("Preparing update…");
  await expect(
    review.getByRole("button", { name: "Updating…" }),
  ).toBeDisabled();
  await expect(
    review.getByRole("button", { name: "Close update" }),
  ).toBeDisabled();
  const sendProgress = async (phase: string, downloadedBytes?: number) => {
    await page.evaluate(
      (payload) => {
        const emit = Reflect.get(window, "settingsEmit") as (
          event: string,
          payload: unknown,
        ) => void;
        emit("desktop-update-progress", payload);
      },
      { phase, downloadedBytes, totalBytes: 1000 },
    );
  };
  await sendProgress("downloading", 420);
  await expect(review.getByRole("status")).toHaveText("Downloading… 42%");
  await expect(review.getByRole("progressbar")).toHaveAttribute("value", "42");
  await page.screenshot({
    path: info.outputPath("update-download-progress.png"),
  });
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await page.getByRole("button", { name: "Update available" }).click();
  const popover = page.getByRole("dialog", { name: "Available update" });
  await expect(popover.getByRole("status")).toHaveText("Downloading… 42%");
  await sendProgress("verifying");
  await expect(popover.getByRole("status")).toHaveText("Verifying update…");
  await expect(popover.getByRole("progressbar")).not.toHaveAttribute("value");
  await sendProgress("restarting");
  await expect(popover.getByRole("status")).toHaveText("Restarting Orka…");
  await expect(popover.getByRole("alert")).toHaveText(
    "Quit Orka and finish any running sync, then try again.",
  );
  await expect(popover.getByRole("progressbar")).toHaveCount(0);
  await popover.getByRole("button", { name: "Update and Restart" }).click();
  await expect(popover.getByRole("status")).toHaveText("Preparing update…");
});

test("Updates works without a project and manually checks without restarting", async ({
  page,
}, info) => {
  const settings = await settingsFixture(page, { noProjects: true });
  await settings.getByRole("button", { name: "Updates", exact: true }).click();
  const panel = updatesPanel(page);
  await expect(panel.getByText("Version 0.3.0", { exact: true })).toBeVisible();
  await expect(
    panel.getByText("Orka is up to date", { exact: true }),
  ).toBeVisible();
  await expect(panel.getByText(/^Last checked/)).toBeVisible();
  await expect
    .poll(() => updateCalls(page).then((calls) => calls.length))
    .toBe(1);
  await page.evaluate(() => {
    (window as any).settingsControls.updateDelay = 1200;
  });
  await panel
    .getByRole("button", { name: "Check for Updates", exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "Checking…", exact: true }),
  ).toBeDisabled();
  await expect(
    panel.getByText("Checking for updates…", { exact: true }),
  ).toBeVisible();
  await emitMenuCheck(page);
  await expect
    .poll(() => updateCalls(page).then((calls) => calls.length))
    .toBe(2);
  await expect(
    panel.getByText("Orka is up to date", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Check for Updates", exact: true }),
  ).toBeEnabled();
  expect((await updateCalls(page)).map(({ args }) => args.manual)).toEqual([
    false,
    true,
  ]);
  expect(
    (await settingsCalls(page)).some(
      ({ command }) => command === "update_install",
    ),
  ).toBe(false);
  await page.screenshot({
    path: info.outputPath("settings-updates-current.png"),
    animations: "disabled",
  });
});

test("available release notes are collapsed, keyboard expandable, and link to the release", async ({
  page,
}, info) => {
  const settings = await settingsFixture(page, { update: available });
  await settings.getByRole("button", { name: "Updates", exact: true }).click();
  const panel = updatesPanel(page);
  await expect(
    panel.getByText("Orka 0.3.1 is available", { exact: true }),
  ).toBeVisible();
  await expect(panel.getByText("Version 0.3.0", { exact: true })).toBeVisible();
  const notes = panel.locator("details");
  await expect(notes).not.toHaveAttribute("open");
  await expect(
    panel.getByText(available.update.notes, { exact: true }),
  ).not.toBeVisible();
  await page.screenshot({
    path: info.outputPath("settings-updates-available.png"),
    animations: "disabled",
  });
  await notes.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(notes).toHaveAttribute("open", "");
  await expect(
    panel.getByText(available.update.notes, { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("settings-updates-notes.png"),
    animations: "disabled",
  });
  const changelog = panel.getByRole("link", {
    name: /changelog|release.*GitHub/i,
  });
  await expect(changelog).toHaveAttribute(
    "href",
    "https://github.com/whysosaket/orka/releases/tag/v0.3.1",
  );
  await changelog.click();
  await expect
    .poll(
      async () =>
        (await settingsCalls(page)).find(
          ({ command }) => command === "open_update_changelog",
        )?.args,
    )
    .toEqual({ version: "0.3.1" });
  await page.keyboard.press("Tab");
  await notes.locator("summary").focus();
  await page.keyboard.press("Space");
  await expect(notes).not.toHaveAttribute("open");
});

test("an installed release keeps its verified notes without offering an installation", async ({
  page,
}) => {
  const settings = await settingsFixture(page, {
    update: { installedVersion: "0.3.1", release: available.update },
  });
  await settings.getByRole("button", { name: "Updates", exact: true }).click();
  const panel = updatesPanel(page);
  await expect(
    panel.getByText("Orka is up to date", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Update and Restart", exact: true }),
  ).toHaveCount(0);
  await panel.locator("details summary").click();
  await expect(
    panel.getByText(available.update.notes, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Available update" }),
  ).toHaveCount(0);
});

for (const failure of ["native status", "bridge rejection"] as const)
  test(`a failed ${failure} check stays retryable and never reports up to date`, async ({
    page,
  }) => {
    const message =
      "Couldn’t verify the update feed. Try again when you’re online.";
    const settings = await settingsFixture(
      page,
      failure === "native status"
        ? { update: { installedVersion: "0.3.0", message } }
        : { updateError: message },
    );
    await settings
      .getByRole("button", { name: "Updates", exact: true })
      .click();
    const panel = updatesPanel(page);
    await expect(panel.getByRole("alert")).toContainText(message);
    await expect(
      panel.getByText("Orka is up to date", { exact: true }),
    ).toHaveCount(0);
    await page.evaluate((update) => {
      (window as any).settingsControls.update = update;
      (window as any).settingsControls.updateError = "";
    }, available);
    await panel
      .getByRole("button", { name: "Check for Updates", exact: true })
      .click();
    await expect(
      panel.getByText("Orka 0.3.1 is available", { exact: true }),
    ).toBeVisible();
    await expect(panel.getByRole("alert")).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "Available update" }),
    ).toBeVisible();
  });

test("unsupported builds explain why checking is unavailable", async ({
  page,
}) => {
  const message = "Updates are unavailable for this build.";
  const settings = await settingsFixture(page, {
    update: { installedVersion: "0.3.0", supported: false, message },
  });
  await settings.getByRole("button", { name: "Updates", exact: true }).click();
  const panel = updatesPanel(page);
  await expect(panel.getByText(message, { exact: true })).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Check for Updates", exact: true }),
  ).toBeDisabled();
  await expect(
    panel.getByText("Orka is up to date", { exact: true }),
  ).toHaveCount(0);
});

test("the app-menu action opens Updates and checks immediately from the workspace", async ({
  page,
}) => {
  await settingsFixture(page);
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Home", exact: true })
    .click();
  await expect(updatesPanel(page)).toHaveCount(0);
  await page.evaluate((update) => {
    (window as any).settingsControls.update = update;
  }, available);
  await emitMenuCheck(page);
  await expect(updatesPanel(page)).toBeVisible();
  await expect(
    updatesPanel(page).getByText("Orka 0.3.1 is available", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      updateCalls(page).then(
        (calls) => calls.filter(({ args }) => args.manual).length,
      ),
    )
    .toBe(1);
});

test("the app-menu action can check before signing in", async ({ page }) => {
  const settings = await settingsFixture(page, { update: available });
  await settings.getByRole("button", { name: "Profile", exact: true }).click();
  await settings.getByRole("button", { name: "Sign out", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Sign out?", exact: true })
    .getByRole("button", { name: "Sign out", exact: true })
    .click();
  await expect(settings).toHaveCount(0);
  await emitMenuCheck(page);
  const updates = page.getByRole("dialog", { name: "Updates", exact: true });
  await expect(updates).toBeVisible();
  await expect(
    updates.getByText("Version 0.3.0", { exact: true }),
  ).toBeVisible();
  await expect(
    updates.getByText("Orka 0.3.1 is available", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      updateCalls(page).then(
        (calls) => calls.filter(({ args }) => args.manual).length,
      ),
    )
    .toBe(1);
  await updates.getByRole("button", { name: "Done", exact: true }).click();
  await expect(updates).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).settingsState.user)).toBe(
    "",
  );
});

test("the app-menu check preserves Settings drafts through Stay and Discard", async ({
  page,
}) => {
  const settings = await settingsFixture(page);
  const name = settings.getByRole("textbox", {
    name: "Project name",
    exact: true,
  });
  await name.fill("Keep this project name");
  await emitMenuCheck(page);
  const guard = page.getByRole("dialog", {
    name: "Save your changes?",
    exact: true,
  });
  await expect(guard).toBeVisible();
  await guard.getByRole("button", { name: "Stay", exact: true }).click();
  await expect(name).toHaveValue("Keep this project name");
  await expect(updatesPanel(page)).toHaveCount(0);
  await emitMenuCheck(page);
  await guard.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(updatesPanel(page)).toBeVisible();
  await settings.getByRole("button", { name: "General", exact: true }).click();
  await expect(name).toHaveValue("Orka");
  expect(
    (await settingsCalls(page)).some(({ args }) => args.action === "rename"),
  ).toBe(false);
});

test("Settings and sidebar share installation progress across navigation", async ({
  page,
}) => {
  const settings = await settingsFixture(page, {
    update: available,
    updateInstallDelay: 8000,
  });
  await settings.getByRole("button", { name: "Updates", exact: true }).click();
  const panel = updatesPanel(page);
  await panel
    .getByRole("button", { name: "Update and Restart", exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "Updating…", exact: true }),
  ).toBeDisabled();
  await expect(
    panel.getByRole("button", { name: "Check for Updates", exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => {
    (window as any).settingsEmit("desktop-update-progress", {
      phase: "downloading",
      downloadedBytes: 420,
      totalBytes: 1000,
    });
  });
  await expect(
    panel.getByText("Downloading… 42%", { exact: true }),
  ).toBeVisible();
  await expect(panel.getByRole("progressbar")).toHaveAttribute("value", "42");
  await settings.getByRole("button", { name: "Devices", exact: true }).click();
  const review = page.getByRole("region", { name: "Available update" });
  await expect(review.getByRole("status")).toHaveText("Downloading… 42%");
  await expect(
    review.getByRole("button", { name: "Updating…", exact: true }),
  ).toBeDisabled();
  await settings.getByRole("button", { name: "Updates", exact: true }).click();
  await expect(panel.getByRole("progressbar")).toHaveAttribute("value", "42");
  expect(
    (await settingsCalls(page)).filter(
      ({ command }) => command === "update_install",
    ),
  ).toHaveLength(1);
});

test("automatic checks retain the four-hour cadence", async ({ page }) => {
  await page.clock.install();
  await settingsFixture(page);
  await expect
    .poll(() => updateCalls(page).then((calls) => calls.length))
    .toBe(1);
  await page.clock.fastForward(4 * 60 * 60 * 1000);
  await expect
    .poll(() => updateCalls(page).then((calls) => calls.length))
    .toBe(2);
  expect(
    (await updateCalls(page)).every(({ args }) => args.manual === false),
  ).toBe(true);
});

test("Updates and expanded notes fit a compact window with accessible controls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 960, height: 640 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const settings = await settingsFixture(page, { update: available });
  await settings.getByRole("button", { name: "Updates", exact: true }).click();
  const panel = updatesPanel(page);
  await panel.locator("details summary").click();
  await expect(
    panel.getByRole("button", { name: "Check for Updates", exact: true }),
  ).toBeInViewport({ ratio: 1 });
  const width = await panel.evaluate((element) => ({
    client: element.clientWidth,
    scroll: element.scrollWidth,
  }));
  expect(width.scroll).toBeLessThanOrEqual(width.client + 1);
  const accessibility = await new AxeBuilder({ page })
    .include('.settings-panel[data-section="updates"]')
    .analyze();
  expect(accessibility.violations).toEqual([]);
});
