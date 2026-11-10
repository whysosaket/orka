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
});

test("review stays in the sidebar across tabs and only approval starts installation", async ({
  page,
}, info) => {
  const settings = await settingsFixture(page, { update: available });
  const sidebar = page.locator(".sidebar");
  const trigger = sidebar.getByRole("button", { name: "Update available" });
  await expect(trigger).toBeVisible();
  await expect(
    settings.getByRole("button", { name: "Updates", exact: true }),
  ).toHaveCount(0);
  await sidebar.getByRole("button", { name: "Home", exact: true }).click();
  await expect(trigger).toBeVisible();
  await page.screenshot({
    path: info.outputPath("sidebar-update.png"),
    animations: "disabled",
  });
  await sidebar.getByRole("button", { name: /^Memories(?: |$)/ }).click();
  await trigger.click();
  const review = page.getByRole("dialog", { name: "Update Orka" });
  await expect(review).toContainText(available.update.notes);
  await expect(review).toContainText("Installed 0.3.0");
  await expect(review).toHaveAttribute("data-side", "top");
  const panel = (await review.boundingBox())!;
  const rail = (await sidebar.boundingBox())!;
  expect(panel.x).toBeGreaterThanOrEqual(rail.x);
  expect(panel.x + panel.width).toBeLessThanOrEqual(rail.x + rail.width + 1);
  await page.screenshot({
    path: info.outputPath("sidebar-update-review.png"),
    animations: "disabled",
  });
  await review.getByRole("button", { name: "Later" }).click();
  await expect(review).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(
    (await settingsCalls(page)).some(
      ({ command }) => command === "update_install",
    ),
  ).toBe(false);
  await trigger.click();
  await review.getByRole("button", { name: "Update and Restart" }).click();
  await expect
    .poll(async () =>
      (await settingsCalls(page)).filter(
        ({ command }) => command === "update_install",
      ),
    )
    .toEqual([
      {
        command: "update_install",
        args: {
          version: available.update.version,
          sha256: available.update.sha256,
        },
      },
    ]);
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
  const review = page.getByRole("dialog", { name: "Update Orka" });
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
});
