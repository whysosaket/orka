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
  await page.clock.runFor(60_100);
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

test("skill usage polls at the configured interval and stops polling on Home", async ({
  page,
}) => {
  await page.clock.install();
  await fixture(page);
  await page.getByRole("button", { name: "Skills", exact: true }).click();
  await expect(page.getByLabel("Count", { exact: true })).toHaveText("1");
  await page.clock.runFor(59_000);
  expect(await calls(page)).toEqual(["one"]);
  await page.evaluate(() => {
    (window as unknown as UsageWindow).usageFixture.deferred = true;
  });
  await page.clock.runFor(1500);
  await expect.poll(() => calls(page)).toEqual(["one", "one"]);
  await expect(page.getByLabel("Count", { exact: true })).toHaveText("1");
  await expect(page.getByLabel("Loading", { exact: true })).toHaveText("true");
  await page.evaluate(() =>
    (window as unknown as UsageWindow).usageFixture.finish[0](),
  );
  await expect(page.getByLabel("Count", { exact: true })).toHaveText("2");
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await page.clock.runFor(300_100);
  expect(await calls(page)).toEqual(["one", "one"]);
  await page.getByRole("button", { name: "Skills", exact: true }).click();
  await expect.poll(() => calls(page)).toHaveLength(3);
  await expect(page.getByLabel("Count", { exact: true })).toHaveText("2");
});

test("lengthening the interval reschedules without clearing cached counts or using the old timer", async ({
  page,
}) => {
  await page.clock.install();
  await fixture(page);
  await page.getByRole("button", { name: "Skills", exact: true }).click();
  await expect(page.getByLabel("Count", { exact: true })).toHaveText("1");
  await page.clock.runFor(30_000);
  await page
    .getByRole("button", { name: "Sync 5 minutes", exact: true })
    .click();
  await expect(page.getByLabel("Count", { exact: true })).toHaveText("1");
  await page.clock.runFor(269_000);
  expect(await calls(page)).toEqual(["one"]);
  await page.clock.runFor(1500);
  await expect(page.getByLabel("Count", { exact: true })).toHaveText("2");
  expect(await calls(page)).toEqual(["one", "one"]);
});

test("shortening the interval and explicit refresh retain counts and coalesce pending scans", async ({
  page,
}) => {
  await page.clock.install();
  await fixture(page);
  await page
    .getByRole("button", { name: "Sync 5 minutes", exact: true })
    .click();
  await page.getByRole("button", { name: "Skills", exact: true }).click();
  await expect(page.getByLabel("Count", { exact: true })).toHaveText("1");
  await page.evaluate(() => {
    const state = (window as unknown as UsageWindow).usageFixture;
    state.deferred = true;
    state.observedCounts = [];
  });
  await page.clock.runFor(61_000);
  expect(await calls(page)).toEqual(["one"]);
  await page
    .getByRole("button", { name: "Sync 1 minute", exact: true })
    .click();
  await expect.poll(() => calls(page)).toHaveLength(2);
  await expect(page.getByLabel("Count", { exact: true })).toHaveText("1");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page
    .getByRole("button", { name: "Sync 5 minutes", exact: true })
    .click();
  expect(await calls(page)).toHaveLength(2);
  await page.evaluate(() =>
    (window as unknown as UsageWindow).usageFixture.finish[0](),
  );
  await expect(page.getByLabel("Count", { exact: true })).toHaveText("2");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect.poll(() => calls(page)).toHaveLength(3);
  await expect(page.getByLabel("Count", { exact: true })).toHaveText("2");
  await page.evaluate(() =>
    (window as unknown as UsageWindow).usageFixture.finish[1](),
  );
  await expect(page.getByLabel("Count", { exact: true })).toHaveText("3");
  const observed = await page.evaluate(
    () => (window as unknown as UsageWindow).usageFixture.observedCounts,
  );
  expect(observed).not.toContain(null);
  expect(observed).not.toContain(0);
  expect(observed).toContain(3);
});

test("returning to visible refreshes overdue usage once and cleans up scheduling", async ({
  page,
}) => {
  await page.clock.install();
  await page.addInitScript(() => {
    const timers = new Set<number>();
    const set = window.setTimeout.bind(window) as (
      handler: TimerHandler,
      timeout?: number,
      ...args: unknown[]
    ) => number;
    const clear = window.clearTimeout.bind(window) as (id?: number) => void;
    Object.defineProperty(window, "setTimeout", {
      configurable: true,
      value: (handler: TimerHandler, timeout = 0, ...args: unknown[]) => {
        if (typeof handler !== "function" || timeout < 60_000)
          return set(handler, timeout, ...args);
        const id = set(() => {
          timers.delete(id);
          handler(...args);
        }, timeout);
        timers.add(id);
        return id;
      },
    });
    Object.defineProperty(window, "clearTimeout", {
      configurable: true,
      value: (id?: number) => {
        timers.delete(id ?? 0);
        clear(id);
      },
    });
    Object.assign(window, { usageTimers: timers });
  });
  const timerCount = () =>
    page.evaluate(
      () =>
        (window as unknown as { usageTimers: Set<number> }).usageTimers.size,
    );
  await fixture(page);
  await page.getByRole("button", { name: "Skills", exact: true }).click();
  await expect(page.getByLabel("Count", { exact: true })).toHaveText("1");
  await expect.poll(timerCount).toBe(1);
  await page.evaluate(() => {
    (window as unknown as UsageWindow).usageFixture.deferred = true;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.runFor(180_100);
  expect(await calls(page)).toHaveLength(1);
  await expect.poll(timerCount).toBe(1);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    for (let count = 0; count < 5; count++)
      document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => calls(page)).toHaveLength(2);
  await expect(page.getByLabel("Count", { exact: true })).toHaveText("1");
  await expect.poll(timerCount).toBe(0);
  await page
    .getByRole("button", { name: "Sync 5 minutes", exact: true })
    .click();
  await page.evaluate(() => {
    for (let count = 0; count < 5; count++)
      document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(await calls(page)).toHaveLength(2);
  await page.evaluate(() =>
    (window as unknown as UsageWindow).usageFixture.finish[0](),
  );
  await expect(page.getByLabel("Count", { exact: true })).toHaveText("2");
  await expect.poll(timerCount).toBe(1);
  await page.evaluate(() => {
    for (let count = 0; count < 5; count++)
      document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(timerCount).toBe(1);
  await page.clock.runFor(299_000);
  expect(await calls(page)).toHaveLength(2);
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect.poll(timerCount).toBe(0);
  await page.clock.runFor(300_100);
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  expect(await calls(page)).toHaveLength(2);
  await expect.poll(timerCount).toBe(0);
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
