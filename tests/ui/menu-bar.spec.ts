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
  await page.setViewportSize({ width: 380, height: 560 });
  await page.addInitScript(() => {
    const fixture: Window["menuBarFixture"] = {
      state: {
        user: "synthetic-user",
        onboarding: false,
        running: true,
        background: true,
        sync: { online: true, lastSync: new Date().toISOString() },
        progress: null,
        projects: [
          { id: "one", name: "Orka", pending: 0, issues: 0 },
          { id: "two", name: "Design system", pending: 0, issues: 0 },
        ],
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
          if (name === "background_agent")
            fixture.state.background = args?.enabled === true;
          return null;
        },
      },
    });
  });
  await page.goto("/?menu-bar=1");
  await expect(
    page.getByRole("heading", { name: "Everything is up to date" }),
  ).toBeVisible();
});

test("compact overview uses the native worker and keeps live phase counts", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Sync now", exact: true }).click();
  await expect(page.getByRole("button", { name: "Syncing…" })).toBeDisabled();
  await expect(page.getByRole("status")).toHaveText("Checking local files");
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
      window.menuBarFixture.calls.some((call) => call.name === "snapshot"),
    ),
  ).toBe(false);
});

test("background login remains opt in and errors stay actionable", async ({
  page,
}) => {
  await page.evaluate(() => {
    window.menuBarFixture.state.background = false;
    window.menuBarFixture.failure =
      "Enable Orka in macOS Login Items to start the sync service";
  });
  const enable = page.getByRole("button", { name: "Enable", exact: true });
  await enable.click();
  await expect(page.getByRole("alert")).toContainText("macOS Login Items");
  await expect(enable).toBeEnabled();
  await page.evaluate(() => {
    window.menuBarFixture.failure = "";
  });
  await enable.click();
  await expect(page.getByText("Enabled", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(() =>
      window.menuBarFixture.calls
        .filter((call) => call.name === "background_agent")
        .map((call) => call.args),
    ),
  ).toEqual([{ enabled: true }, { enabled: true }]);
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
  await expect(
    page.getByRole("heading", { name: "You’re offline" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sync now", exact: true }),
  ).toBeEnabled();
  await page.evaluate(() => {
    window.menuBarFixture.state.running = false;
  });
  await expect(
    page.getByRole("heading", { name: "Sync is stopped" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sync now", exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => {
    window.menuBarFixture.state.user = null;
  });
  await expect(
    page.getByRole("heading", { name: "Welcome to Orka" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sync now", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Connected projects" }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    window.menuBarFixture.state.onboarding = true;
  });
  await expect(
    page.getByRole("heading", { name: "Finish setting up Orka" }),
  ).toBeVisible();
});

test("panel stays within its window with long project names and keyboard access", async ({
  page,
}) => {
  await page.evaluate(() => {
    const state = window.menuBarFixture.state;
    state.projects = Array.from({ length: 20 }, (_, i) => ({
      id: `${i}`,
      name: `A very long synthetic project name ${i}`,
      pending: i,
      issues: 0,
    }));
    state.background = false;
  });
  await expect(page.getByRole("listitem")).toHaveCount(20);
  const bounds = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
    footer: document.querySelector(".menu-bar-footer")!.getBoundingClientRect()
      .bottom,
  }));
  expect(bounds).toEqual({ width: 380, height: 560, footer: 559 });
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "Sync now", exact: true }),
  ).toBeFocused();
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
});

test("menu bar overview visual evidence", async ({ page }) => {
  await page.evaluate(() => {
    const state = window.menuBarFixture.state;
    state.pending = 3;
    state.projects[1].pending = 3;
  });
  await expect(
    page.getByRole("heading", { name: "Changes ready to sync" }),
  ).toBeVisible();
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
