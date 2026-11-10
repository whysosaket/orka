import { expect, test } from "@playwright/test";
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
  await expect(review).toContainText("v0.3.1");
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
