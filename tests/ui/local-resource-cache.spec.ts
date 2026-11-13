import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import type { CatalogWindow } from "./fixtures/local-resource-cache.js";

async function fixture(page: Page) {
  await page.route("**/local-catalog-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><body><div id="root"></div><script type="module" src="/@fs/${fileURLToPath(new URL("./fixtures/local-resource-cache.ts", import.meta.url))}"></script></body></html>`,
    }),
  );
  await page.goto("/local-catalog-fixture");
  await expect(
    page.getByRole("button", { name: "session", exact: true }),
  ).toBeVisible();
}
const calls = (page: Page) =>
  page.evaluate(
    () => (window as unknown as CatalogWindow).catalogFixture.calls,
  );
const rows = (page: Page) => page.getByLabel("Rows", { exact: true });
const select = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true }).click();
const defer = (page: Page) =>
  page.evaluate(() => {
    (window as unknown as CatalogWindow).catalogFixture.deferred = true;
  });
const finish = (page: Page, index: number) =>
  page.evaluate((index) => {
    (window as unknown as CatalogWindow).catalogFixture.finish[index]();
  }, index);

test("project and collection navigation reuse fresh catalogs", async ({
  page,
}) => {
  await fixture(page);
  await select(page, "session");
  await expect(rows(page)).toHaveText("one session user 1");
  await select(page, "home");
  await select(page, "session");
  await select(page, "Project two");
  await expect(rows(page)).toHaveText("two session user 2");
  await select(page, "Project one");
  await expect(rows(page)).toHaveText("one session user 1");
  await select(page, "memory");
  await expect(rows(page)).toContainText("one memory user 3");
  await select(page, "session");
  expect(await calls(page)).toHaveLength(3);
  await expect(page.getByLabel("Loading", { exact: true })).toHaveText("false");
});

test("navigation reuses in-flight discovery and isolates out-of-order project results", async ({
  page,
}) => {
  await fixture(page);
  await defer(page);
  await select(page, "session");
  await expect.poll(async () => (await calls(page)).length).toBe(1);
  await select(page, "Project two");
  await expect.poll(async () => (await calls(page)).length).toBe(2);
  await select(page, "Project one");
  expect(await calls(page)).toHaveLength(2);
  await finish(page, 1);
  await expect(rows(page)).toHaveText("");
  await finish(page, 0);
  await expect(rows(page)).toHaveText("one session user 1");
  await select(page, "Project two");
  await expect(rows(page)).toHaveText("two session user 2");
  expect(await calls(page)).toHaveLength(2);
});

test("periodic and explicit refresh retain cached rows and do not overlap on navigation", async ({
  page,
}) => {
  await page.clock.install();
  await fixture(page);
  await select(page, "session");
  await expect(rows(page)).toHaveText("one session user 1");
  await defer(page);
  await page.clock.runFor(60_100);
  await expect.poll(async () => (await calls(page)).length).toBe(2);
  await expect(rows(page)).toHaveText("one session user 1");
  await expect(page.getByLabel("Loading", { exact: true })).toHaveText("true");
  await select(page, "home");
  await select(page, "session");
  expect(await calls(page)).toHaveLength(2);
  await finish(page, 0);
  await expect(rows(page)).toHaveText("one session user 2");
  await select(page, "Refresh");
  await expect.poll(async () => (await calls(page)).length).toBe(3);
  await expect(rows(page)).toHaveText("one session user 2");
  await finish(page, 1);
  await expect(rows(page)).toHaveText("one session user 3");
});

for (const change of ["account", "service", "profile", "folder", "sources"])
  test(`changing ${change} invalidates the catalog and ignores late results`, async ({
    page,
  }) => {
    await fixture(page);
    await defer(page);
    await select(page, "session");
    await expect.poll(async () => (await calls(page)).length).toBe(1);
    await select(page, `Change ${change}`);
    await expect.poll(async () => (await calls(page)).length).toBe(2);
    await finish(page, 0);
    await expect(rows(page)).toHaveText("");
    await expect(page.getByLabel("Loading", { exact: true })).toHaveText(
      "true",
    );
    await finish(page, 1);
    await expect(rows(page)).toHaveText(
      `one session ${change === "account" ? "other" : "user"} 2`,
    );
  });

test("returning to a stale catalog refreshes in the background while retaining rows", async ({
  page,
}) => {
  await page.clock.install();
  await fixture(page);
  await select(page, "session");
  await expect(rows(page)).toHaveText("one session user 1");
  await select(page, "home");
  await defer(page);
  await page.clock.runFor(61_000);
  expect(await calls(page)).toHaveLength(1);
  await select(page, "session");
  await expect.poll(async () => (await calls(page)).length).toBe(2);
  await expect(rows(page)).toHaveText("one session user 1");
  await expect(page.getByLabel("Loading", { exact: true })).toHaveText("true");
  await finish(page, 0);
  await expect(rows(page)).toHaveText("one session user 2");
});

test("hidden windows defer periodic discovery until visible", async ({
  page,
}) => {
  await page.clock.install();
  await fixture(page);
  await select(page, "session");
  await expect(rows(page)).toHaveText("one session user 1");
  await defer(page);
  await page.evaluate(() =>
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    }),
  );
  await page.clock.runFor(90_100);
  expect(await calls(page)).toHaveLength(1);
  await expect(rows(page)).toHaveText("one session user 1");
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(async () => (await calls(page)).length).toBe(2);
  await expect(rows(page)).toHaveText("one session user 1");
  await finish(page, 0);
  await expect(rows(page)).toHaveText("one session user 2");
  await defer(page);
  await page.clock.runFor(59_000);
  expect(await calls(page)).toHaveLength(2);
  await page.clock.runFor(1_100);
  await expect.poll(async () => (await calls(page)).length).toBe(3);
  await expect(rows(page)).toHaveText("one session user 2");
});

test("sync interval changes reschedule discovery without clearing cached rows", async ({
  page,
}) => {
  await page.clock.install();
  await fixture(page);
  await select(page, "session");
  await expect(rows(page)).toHaveText("one session user 1");
  await select(page, "Sync every five minutes");
  await page.clock.runFor(60_100);
  expect(await calls(page)).toHaveLength(1);
  await select(page, "home");
  await select(page, "session");
  await expect(rows(page)).toHaveText("one session user 1");
  expect(await calls(page)).toHaveLength(1);
  await defer(page);
  await select(page, "Sync every minute");
  await expect.poll(async () => (await calls(page)).length).toBe(2);
  await expect(rows(page)).toHaveText("one session user 1");
  await select(page, "Sync every five minutes");
  expect(await calls(page)).toHaveLength(2);
  await finish(page, 0);
  await expect(rows(page)).toHaveText("one session user 2");
  await page.clock.runFor(60_100);
  expect(await calls(page)).toHaveLength(2);
  await select(page, "Refresh");
  await expect.poll(async () => (await calls(page)).length).toBe(3);
  await expect(rows(page)).toHaveText("one session user 2");
  await finish(page, 1);
  await expect(rows(page)).toHaveText("one session user 3");
});
