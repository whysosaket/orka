import { fileURLToPath } from "node:url";
import { test, expect, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { ENV_ENABLED } from "../../apps/mac/src/lib/features.js";

async function fixture(page: Page) {
  await page.clock.install();
  await page.route("**/toast-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en"><head><title>Orka toast preview</title></head><body><div id="root"></div><script type="module" src="/@fs/${fileURLToPath(new URL("./fixtures/toasts.ts", import.meta.url))}"></script></body></html>`,
    }),
  );
  await page.goto("/toast-fixture");
  await expect(
    page.getByRole("button", { name: "Show info", exact: true }),
  ).toBeVisible();
}
const toast = (page: Page) => page.locator("[data-orka-toast]");
const fill = (page: Page) =>
  page
    .locator(".toast-timer")
    .evaluate((node) => node.getBoundingClientRect().width);

test("disabled ENV notifications and draft actions never enter the toast queue", async ({
  page,
}) => {
  test.skip(ENV_ENABLED, "Checks the disabled product state");
  await fixture(page);
  await page
    .getByRole("button", { name: "Show ENV toast", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Show ENV draft notice", exact: true })
    .click();
  await expect(toast(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Show info", exact: true }).click();
  await expect(toast(page)).toHaveText("Changes will save as a copyDismiss");
  await page.clock.runFor(5500);
  await expect(toast(page)).toHaveCount(0);
});

test("matches Figma, floats bottom-center, fills for five seconds, then dismisses", async ({
  page,
}) => {
  await fixture(page);
  const before = await page.getByRole("heading").boundingBox();
  await page.getByRole("button", { name: "Show info", exact: true }).click();
  await expect(toast(page)).toHaveText("Changes will save as a copyDismiss");
  await page.clock.runFor(2500);
  const box = (await toast(page).boundingBox())!;
  const main = (await page.locator("main").boundingBox())!;
  expect(box.width).toBe(440);
  expect(box.height).toBe(50);
  expect(
    Math.abs(box.x + box.width / 2 - main.x - main.width / 2),
  ).toBeLessThan(1);
  expect(main.y + main.height - box.y - box.height).toBe(24);
  expect(await page.getByRole("heading").boundingBox()).toEqual(before);
  await expect(toast(page)).toHaveCSS("border-radius", "16px");
  await expect(toast(page)).toHaveCSS("background-color", "rgb(28, 28, 28)");
  await expect(page.locator(".toast-timer")).toHaveCSS(
    "background-color",
    "rgb(48, 48, 48)",
  );
  expect(await fill(page)).toBeGreaterThan(35);
  expect(await fill(page)).toBeLessThan(45);
  await page.screenshot({ path: "artifacts/toasts/timer-halfway.png" });
  await page.clock.runFor(2800);
  await expect(toast(page)).toHaveCount(0);
});

test("hover and keyboard focus pause the remaining time; Escape restores focus", async ({
  page,
}) => {
  await fixture(page);
  const origin = page.getByRole("button", { name: "Show info", exact: true });
  await origin.click();
  await page.clock.runFor(1000);
  await toast(page).hover();
  const paused = await fill(page);
  await page.clock.runFor(6000);
  await expect(toast(page)).toBeVisible();
  expect(Math.abs((await fill(page)) - paused)).toBeLessThan(1);
  await page.mouse.move(2, 2);
  await page.clock.runFor(1000);
  await page.keyboard.press("Alt+t");
  await expect(toast(page).getByRole("button")).toBeFocused();
  await page.clock.runFor(6000);
  await expect(toast(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await page.clock.runFor(400);
  await expect(toast(page)).toHaveCount(0);
  await expect(origin).toBeFocused();
});

test("queue is deduplicated and only the front toast uses its five-second window", async ({
  page,
}) => {
  await fixture(page);
  const show = page.getByRole("button", { name: "Show info", exact: true });
  await show.click();
  await show.click();
  await page.clock.runFor(3000);
  await page.getByRole("button", { name: "Queue next", exact: true }).click();
  await expect(page.locator(".toast-queued")).toHaveCount(1);
  await page.clock.runFor(2300);
  await expect(toast(page)).toContainText("Sync requested");
  expect(await fill(page)).toBeLessThan(10);
  await page.clock.runFor(5400);
  await expect(toast(page)).toHaveCount(0);
});

test("timeouts never run actions; a click runs exactly once", async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole("button", { name: "Show action", exact: true }).click();
  await page.clock.runFor(5400);
  await expect(page.getByLabel("Action count")).toHaveText("0");
  await page.getByRole("button", { name: "Show action", exact: true }).click();
  await toast(page).getByRole("button", { name: "Try again" }).dblclick();
  await expect(page.getByLabel("Action count")).toHaveText("1");
});

test("project changes clear feedback and reject an old asynchronous completion", async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole("button", { name: "Show info", exact: true }).click();
  await page
    .getByRole("button", { name: "Deferred toast", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Change project", exact: true })
    .click();
  await page.clock.runFor(1400);
  await expect(toast(page)).toHaveCount(0);
  await page
    .getByRole("button", { name: "Change project", exact: true })
    .click();
  await page.clock.runFor(400);
  await expect(toast(page)).toHaveCount(0);
});

test("modal toast remains at the workspace bottom and supports focus and dismissal", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await fixture(page);
  await page.getByRole("button", { name: "Open dialog", exact: true }).click();
  await page.clock.runFor(300);
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Save test preference" }).click();
  await expect(dialog.getByRole("status")).toHaveText("Sharing choices saved");
  await page.clock.runFor(300);
  const box = (await toast(page).boundingBox())!;
  const main = (await page.locator("main").boundingBox())!;
  expect(main.y + main.height - box.y - box.height).toBe(24);
  expect(box.x + box.width / 2).toBe(main.x + main.width / 2);
  await page.keyboard.press("Alt+t");
  await expect(toast(page).getByRole("button")).toBeFocused();
  await page.keyboard.press("Escape");
  await page.clock.runFor(400);
  await expect(toast(page)).toHaveCount(0);
  await expect(dialog).toBeVisible();
});

test("inactive app pauses the timer; compact reduced-motion feedback remains accessible", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 900, height: 640 });
  await fixture(page);
  await page.getByRole("button", { name: "Show info", exact: true }).click();
  await page.clock.runFor(1000);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.clock.runFor(6000);
  await expect(toast(page)).toBeVisible();
  const results = await new AxeBuilder({ page })
    .include(".orka-toast")
    .analyze();
  expect(results.violations).toEqual([]);
  await page.screenshot({
    path: "artifacts/toasts/compact-reduced-motion.png",
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.clock.runFor(4500);
  await expect(toast(page)).toHaveCount(0);
});
