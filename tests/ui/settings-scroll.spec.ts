import { test, expect } from "@playwright/test";
import { settingsFixture } from "./fixtures/settings.js";

for (const [width, height] of [
  [1160, 768],
  [900, 640],
])
  test(`permissions keep role spacing and scroll to the last control at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height });
    const settings = await settingsFixture(page);
    await settings
      .getByRole("button", { name: "Permissions", exact: true })
      .click();
    const last = settings.getByRole("combobox", {
      name: "Member Skills access",
      exact: true,
    });
    await expect(last).toBeEnabled();
    const owner = await settings
      .getByRole("region", { name: "Owner permissions" })
      .boundingBox();
    const admin = await settings
      .getByRole("region", { name: "Admin permissions" })
      .boundingBox();
    const member = await settings
      .getByRole("region", { name: "Member permissions" })
      .boundingBox();
    expect(admin!.y - owner!.y - owner!.height).toBeCloseTo(24, 0);
    expect(member!.y - admin!.y - admin!.height).toBeCloseTo(24, 0);
    await expect(last).not.toBeInViewport();
    const scrollArea = settings.locator(".settings-role-tables");
    const bounds = await scrollArea.boundingBox();
    await page.mouse.move(bounds!.x + 30, bounds!.y + 40);
    await page.mouse.wheel(0, 1200);
    await expect(last).toBeInViewport({ ratio: 1 });
    await expect(
      settings.getByRole("button", { name: "Save changes", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await last.click();
    await expect(page.getByRole("listbox")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(last).toBeFocused();
    await page.screenshot({
      path: info.outputPath(`permissions-scrolled-${width}.png`),
    });
  });

test("expanded retained restrictions remain reachable in compact Settings", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 640 });
  const settings = await settingsFixture(page);
  await page.evaluate(() => {
    (window as any).settingsCatalog.resourceRules = Array.from(
      { length: 30 },
      (_, index) => ({
        resourceId: `restricted-file-${index}`,
        userId: "member",
        rule: { mode: "hidden", create: "hidden" },
      }),
    );
  });
  await settings
    .getByRole("button", { name: "Permissions", exact: true })
    .click();
  await settings
    .getByText("Retained file and source restrictions (30)")
    .click();
  const last = settings
    .getByRole("listitem")
    .filter({ hasText: "restricted-file-29" });
  const panel = settings.locator(".settings-panel");
  const bounds = await panel.boundingBox();
  await page.mouse.move(bounds!.x + 10, bounds!.y + 40);
  await expect(async () => {
    await page.mouse.wheel(0, 900);
    await expect(last).toBeInViewport({ ratio: 1, timeout: 100 });
  }).toPass({ timeout: 10000 });
  expect(await panel.evaluate((element) => element.scrollTop)).toBeGreaterThan(
    0,
  );
  await expect(last).toBeInViewport({ ratio: 1 });
});
