import { fileURLToPath } from "node:url";
import { test, expect, type Page } from "@playwright/test";
import type { UsageWindow } from "./fixtures/skill-usage-cache.js";

async function fixture(page: Page) {
  await page.route("**/skill-usage-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><body><div id="root"></div><script type="module" src="/@fs/${fileURLToPath(new URL("./fixtures/skill-usage-cache.ts", import.meta.url))}"></script></body></html>`,
    }),
  );
  await page.goto("/skill-usage-fixture");
  await expect(
    page.getByRole("button", { name: "Skills", exact: true }),
  ).toBeVisible();
}

async function calls(page: Page) {
  return page.evaluate(
    () => (window as unknown as UsageWindow).usageFixture.calls,
  );
}

test("skill usage reuses recent project counts, expires naturally, and refreshes explicitly", async ({
  page,
}) => {
  await page.clock.install();
  await fixture(page);
  await page.getByRole("button", { name: "Skills", exact: true }).click();
  await expect(page.getByLabel("Count", { exact: true })).toHaveText("1");
  await page.getByRole("button", { name: "Project two" }).click();
  await expect(page.getByLabel("Count", { exact: true })).toHaveText("2");
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await page.getByRole("button", { name: "Project one" }).click();
  await page.getByRole("button", { name: "Skills", exact: true }).click();
  await expect(page.getByLabel("Count", { exact: true })).toHaveText("1");
  expect(await calls(page)).toEqual(["one", "two"]);
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await page.clock.runFor(30_100);
  await page.getByRole("button", { name: "Skills", exact: true }).click();
  await expect(page.getByLabel("Count", { exact: true })).toHaveText("3");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByLabel("Count", { exact: true })).toHaveText("4");
});

test("returning to pending usage reuses its request and preserves error recovery", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    (window as unknown as UsageWindow).usageFixture.deferred = true;
  });
  await page.getByRole("button", { name: "Skills", exact: true }).click();
  await expect.poll(() => calls(page)).toEqual(["one"]);
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await page.getByRole("button", { name: "Skills", exact: true }).click();
  expect(await calls(page)).toEqual(["one"]);
  await page.evaluate(() =>
    (window as unknown as UsageWindow).usageFixture.finish[0](),
  );
  await expect(page.getByLabel("Count", { exact: true })).toHaveText("1");
  await page.evaluate(() => {
    (window as unknown as UsageWindow).usageFixture.deferred = false;
    (window as unknown as UsageWindow).usageFixture.failed = true;
  });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByLabel("Error", { exact: true })).toContainText(
    "History unavailable",
  );
  await expect(page.getByLabel("Count", { exact: true })).toHaveText("1");
  await page.evaluate(() => {
    (window as unknown as UsageWindow).usageFixture.failed = false;
  });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByLabel("Count", { exact: true })).toHaveText("3");
  await expect(page.getByLabel("Error", { exact: true })).toBeEmpty();
});

for (const action of [
  "Change account",
  "Change service",
  "Change profile",
  "Change folders",
  "Change skills",
]) {
  test(`${action} invalidates usage and discards late results`, async ({
    page,
  }) => {
    await fixture(page);
    await page.evaluate(() => {
      (window as unknown as UsageWindow).usageFixture.deferred = true;
    });
    await page.getByRole("button", { name: "Skills", exact: true }).click();
    await expect.poll(() => calls(page)).toHaveLength(1);
    await page.getByRole("button", { name: action, exact: true }).click();
    await expect.poll(() => calls(page)).toHaveLength(2);
    await page.evaluate(() =>
      (window as unknown as UsageWindow).usageFixture.finish[0](),
    );
    await expect(page.getByLabel("Count", { exact: true })).toBeEmpty();
    await page.evaluate(() =>
      (window as unknown as UsageWindow).usageFixture.finish[1](),
    );
    await expect(page.getByLabel("Count", { exact: true })).toHaveText("2");
  });
}
