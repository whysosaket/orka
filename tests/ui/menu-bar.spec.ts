import { test, expect } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import type { MenuBarSnapshot } from "../../apps/mac/src/components/menu-bar.js";

declare global {
  interface Window {
    menuBarFixture: {
      state: MenuBarSnapshot;
      calls: { name: string; args?: Record<string, unknown> }[];
      failure: string;
    };
  }
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 352 });
  await page.addInitScript(() => {
    const fixture: Window["menuBarFixture"] = {
      state: {
        user: "synthetic-user",
        onboarding: false,
        running: true,
        sync: { online: true, lastSync: new Date().toISOString() },
        progress: null,
        projectCount: 2,
        pending: 0,
        issues: 0,
      },
      calls: [],
      failure: "",
    };
    Object.assign(window, {
      menuBarFixture: fixture,
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        unregisterCallback: () => {},
        invoke: async (name: string, args?: Record<string, unknown>) => {
          fixture.calls.push({ name, args });
          if (name === "menu_bar_snapshot")
            return structuredClone(fixture.state);
          if (fixture.failure) throw fixture.failure;
          if (name === "sync_now")
            fixture.state.progress = { label: "Checking local files" };
          return null;
        },
      },
    });
  });
  await page.goto("/?menu-bar=1");
  await expect(
    page.getByRole("button", { name: "Sync now", exact: true }),
  ).toBeEnabled();
});

test("sync button owns the only moving icon and shows live phase counts below", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Sync now", exact: true }).click();
  const sync = page.getByRole("button", { name: "Syncing…" });
  await expect(sync).toBeDisabled();
  await expect(sync.locator(".menu-bar-spinning")).toHaveCount(1);
  await expect(page.getByRole("status")).toHaveText("Checking local files");
  await expect(page.getByRole("progressbar")).toHaveCount(0);
  await page.evaluate(() => {
    window.menuBarFixture.state.progress = {
      label: "Uploading changes",
      completed: 2,
      total: 8,
      detail: "Orka · AGENTS.md",
    };
  });
  await expect(page.getByRole("progressbar")).toHaveAttribute("value", "2");
  await expect(page.getByRole("progressbar")).toHaveAttribute("max", "8");
  await expect(page.getByText("2 of 8")).toBeVisible();
  await expect(page.getByText("Orka · AGENTS.md")).toBeVisible();
  await page.evaluate(() => {
    window.menuBarFixture.state.progress = null;
  });
  await expect(
    page.getByRole("button", { name: "Sync now", exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(
      () =>
        window.menuBarFixture.calls.filter((call) => call.name === "sync_now")
          .length,
    ),
  ).toBe(1);
});

test("opening, quitting and Escape use native lifecycle actions", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Open Orka", exact: true }).click();
  await page.getByRole("button", { name: "Quit Orka", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.menuBarFixture.calls
          .filter((call) => call.name === "menu_bar_action")
          .map((call) => call.args?.action),
      ),
    )
    .toEqual(["open", "quit", "close"]);
  expect(
    await page.evaluate(() =>
      window.menuBarFixture.calls.some((call) =>
        ["snapshot", "background_agent"].includes(call.name),
      ),
    ),
  ).toBe(false);
});

test("failed sync requests show an error and allow retry", async ({ page }) => {
  await page.evaluate(() => {
    window.menuBarFixture.failure = "Unable to request sync. Try again.";
  });
  const sync = page.getByRole("button", { name: "Sync now", exact: true });
  await sync.click();
  await expect(page.getByRole("alert")).toContainText("Unable to request sync");
  await expect(sync).toBeEnabled();
  await page.evaluate(() => {
    window.menuBarFixture.failure = "";
  });
  await sync.click();
  await expect(page.getByRole("button", { name: "Syncing…" })).toBeDisabled();
});

test("offline, stopped, signed out and setup states report actual availability", async ({
  page,
}) => {
  await page.evaluate(() => {
    window.menuBarFixture.state.sync = {
      online: false,
      error: "Network unavailable",
    };
  });
  await expect(page.getByRole("status")).toContainText("Offline");
  await expect(
    page.getByRole("button", { name: "Sync now", exact: true }),
  ).toBeEnabled();
  await page.evaluate(() => {
    window.menuBarFixture.state.running = false;
  });
  await expect(page.getByRole("status")).toContainText("Sync stopped");
  await expect(
    page.getByRole("button", { name: "Sync now", exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => {
    window.menuBarFixture.state.user = null;
  });
  await expect(page.getByRole("status")).toContainText("sign in");
  await expect(
    page.getByRole("button", { name: "Sync now", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".menu-bar-counts")).toHaveCount(0);
  await page.evaluate(() => {
    window.menuBarFixture.state.onboarding = true;
  });
  await expect(page.getByRole("status")).toContainText("finish setup");
});

test("compact list stays within its window and supports keyboard and reduced motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "Sync now", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Syncing…" })).toBeDisabled();
  const bounds = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
    footer: document.querySelector(".menu-bar-footer")!.getBoundingClientRect()
      .bottom,
    animation: getComputedStyle(document.querySelector(".menu-bar-spinning")!)
      .animationName,
  }));
  expect(bounds.width).toBe(360);
  expect(bounds.height).toBe(352);
  expect(bounds.footer).toBeLessThanOrEqual(352);
  expect(bounds.animation).toBe("none");
  await expect(page.getByRole("term")).toHaveText([
    "Projects",
    "Queued changes",
    "Sync issues",
  ]);
  await expect(page.getByRole("definition")).toHaveText(["2", "0", "0"]);
  await expect(
    page.getByText("Connected projects", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("Keep syncing after you quit")).toHaveCount(0);
  await expect(page.getByText("Your workspace, in sync")).toHaveCount(0);
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
});

test("menu bar overview visual evidence", async ({ page }) => {
  await page.evaluate(() => {
    window.menuBarFixture.state.pending = 3;
  });
  await expect(page.getByRole("definition")).toHaveText(["2", "3", "0"]);
  await page.screenshot({ path: "artifacts/menu-bar-overview.png" });
  await page.evaluate(() => {
    window.menuBarFixture.state.progress = {
      label: "Uploading changes",
      completed: 2,
      total: 8,
      detail: "Orka · AGENTS.md",
    };
  });
  await expect(page.getByRole("progressbar")).toBeVisible();
  await page.screenshot({ path: "artifacts/menu-bar-syncing.png" });
});
