import { test, expect, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import type { Snapshot, SyncProgress } from "../../apps/mac/src/types.js";

declare global {
  interface Window {
    syncProgressFixture: {
      progress: SyncProgress | null;
      sync: Snapshot["sync"];
      running: boolean;
      errors: Snapshot["errors"];
      calls: string[];
    };
  }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const fixture: Window["syncProgressFixture"] = {
      progress: null,
      sync: { online: true, lastSync: "2026-11-13T08:00:00Z" },
      running: true,
      errors: [],
      calls: [],
    };
    Object.assign(window, {
      syncProgressFixture: fixture,
      isTauri: true,
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        unregisterCallback: () => {},
        invoke: async (name: string) => {
          fixture.calls.push(name);
          if (name === "snapshot")
            return {
              user: "user",
              config: { apiUrl: "https://test.local", syncMinutes: 15 },
              projects: [
                { id: "one", name: "Orka", path: "/test/orka", role: "owner" },
              ],
              resources: [],
              bindings: [],
              conflicts: [],
              activity: [],
              outbox: [],
              errors: fixture.errors,
              sync: fixture.sync,
              syncProgress: fixture.progress,
              daemon: { running: fixture.running },
              devices: [],
              deviceId: "device",
              background: true,
            } satisfies Snapshot;
          if (name === "sync_progress")
            return { user: "user", progress: fixture.progress };
          if (name === "sync_now") {
            fixture.progress = { label: "Waiting for sync to start…" };
            return;
          }
          return {};
        },
      },
    });
  });
  await page.goto("/");
  await expect(page.locator(".workspace-header .sync-status")).toBeVisible();
});

async function setProgress(page: Page, progress: SyncProgress | null) {
  await page.evaluate((value) => {
    window.syncProgressFixture.progress = value;
  }, progress);
}

async function openSync(page: Page) {
  await page.locator(".workspace-header .sync-status").click();
  return page.getByRole("dialog", { name: "Sync status and notifications" });
}

test("Sync now shows queued and local file activity without an estimated bar", async ({
  page,
}) => {
  const dialog = await openSync(page);
  await dialog.getByRole("button", { name: "Sync now", exact: true }).click();
  const footer = dialog.locator(".sync-menu-progress");
  await expect(footer).toContainText("Waiting for sync to start…");
  await expect(dialog.getByRole("progressbar")).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Syncing…", exact: true }),
  ).toBeDisabled();
  await setProgress(page, {
    label: "Checking local files",
    detail: "Orka · .agents/skills/writing/SKILL.md",
    completed: 0,
    total: null,
  });
  await expect(footer).toContainText(".agents/skills/writing/SKILL.md");
  await expect(footer).not.toContainText("%");
  await expect(dialog.getByRole("progressbar")).toHaveCount(0);
  await expect(page.locator(".workspace-header .sync-status")).toContainText(
    "Syncing…",
  );
  expect(await page.evaluate(() => window.syncProgressFixture.calls)).toContain(
    "sync_now",
  );
});

test("known batches show live phase counts and survive closing the modal", async ({
  page,
}) => {
  await setProgress(page, {
    label: "Uploading changes",
    detail: "Orka · AGENTS.md",
    completed: 2,
    total: 8,
  });
  const dialog = await openSync(page);
  const bar = dialog.getByRole("progressbar", { name: "Uploading changes" });
  await expect(bar).toHaveAttribute("aria-valuenow", "2");
  await expect(bar).toHaveAttribute("aria-valuemax", "8");
  await expect(bar).toHaveAttribute("aria-valuetext", "2 of 8 complete (25%)");
  await expect(dialog.locator(".sync-menu-progress-count")).toHaveText(
    "2 of 8",
  );
  await page.keyboard.press("Escape");
  await expect(page.locator(".workspace-header .sync-status")).toBeFocused();
  await setProgress(page, {
    label: "Uploading changes",
    detail: "Orka · CLAUDE.md",
    completed: 5,
    total: 8,
  });
  await openSync(page);
  await expect(bar).toHaveAttribute("aria-valuenow", "5");
  await expect(dialog.locator(".sync-menu-progress")).toContainText(
    "CLAUDE.md",
  );
  await dialog.screenshot({ path: "artifacts/sync-progress.png" });
  await setProgress(page, {
    label: "Downloading updates",
    detail: "Orka · 30 updates received",
    completed: 30,
    total: null,
  });
  await expect(bar).toHaveCount(0);
  await expect(dialog.locator(".sync-menu-progress-count")).toHaveCount(0);
  await expect(dialog.locator(".sync-menu-progress")).toContainText(
    "30 updates received",
  );
});

test("unknown and empty totals never produce a progress bar", async ({
  page,
}) => {
  const dialog = await openSync(page);
  for (const total of [undefined, null, 0]) {
    await setProgress(page, {
      label: "Preparing sync",
      completed: 0,
      total,
    });
    await expect(dialog.locator(".sync-menu-progress")).toBeVisible();
    await expect(dialog.getByRole("progressbar")).toHaveCount(0);
  }
});

test("completion and failure clear active progress and allow another sync", async ({
  page,
}) => {
  const dialog = await openSync(page);
  const sync = dialog.getByRole("button", { name: "Sync now", exact: true });
  await sync.click();
  await expect(dialog.locator(".sync-menu-progress")).toBeVisible();
  await setProgress(page, null);
  await expect(dialog.locator(".sync-menu-progress")).toHaveCount(0);
  await expect(sync).toBeEnabled();
  await expect(page.locator(".workspace-header .sync-status")).toContainText(
    "Up to date",
  );
  await sync.click();
  await expect(dialog.locator(".sync-menu-progress")).toBeVisible();
  await page.evaluate(() => {
    window.syncProgressFixture.progress = null;
    window.syncProgressFixture.sync = {
      online: false,
      lastSync: "2026-11-13T08:00:00Z",
      error: "Cloud unavailable; local work stays queued",
    };
  });
  await expect(dialog.locator(".sync-menu-progress")).toHaveCount(0);
  await expect(dialog).toContainText(
    "Cloud unavailable; local work stays queued",
  );
  await expect(sync).toBeEnabled();
  await expect(page.locator(".workspace-header .sync-status")).toContainText(
    "Offline",
  );
});

test("stopped sync hides stale activity", async ({ page }) => {
  await page.evaluate(() => {
    window.syncProgressFixture.running = false;
    window.syncProgressFixture.progress = {
      label: "Uploading changes",
      completed: 1,
      total: 10,
    };
  });
  await expect(page.locator(".workspace-header .sync-status")).toContainText(
    "Stopped",
  );
  const dialog = await openSync(page);
  await expect(dialog.locator(".sync-menu-progress")).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Sync now", exact: true }),
  ).toBeDisabled();
});

for (const size of [
  { width: 1160, height: 800 },
  { width: 900, height: 640 },
]) {
  test(`progress footer stays visible below scrolling issues at ${size.width}`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const detail = `Orka · ${"WWWWWWWWWWWW/".repeat(60)}AGENTS.md`;
    await page.evaluate((detail) => {
      window.syncProgressFixture.progress = {
        label: "Applying updates on this Mac",
        detail,
        completed: 3,
        total: 12,
      };
      window.syncProgressFixture.errors = Array.from(
        { length: 24 },
        (_, i) => ({
          source: `one:file-${i}`,
          error: `File ${i} needs review before syncing`,
        }),
      );
    }, detail);
    const dialog = await openSync(page);
    await expect(dialog).toContainText("24 sync issues");
    const footer = dialog.locator(".sync-menu-progress");
    await expect(footer.locator(".sync-menu-progress-copy p")).toHaveAttribute(
      "title",
      detail,
    );
    const bounds = (await dialog.boundingBox())!;
    const progressBounds = (await footer.boundingBox())!;
    expect(progressBounds.y + progressBounds.height).toBeLessThanOrEqual(
      bounds.y + bounds.height,
    );
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(size.height - 11);
    expect(
      await dialog
        .locator(".sync-menu-feed")
        .evaluate((element) => element.scrollHeight > element.clientHeight),
    ).toBe(true);
    const firstIssue = dialog.getByText("File 0 needs review before syncing", {
      exact: true,
    });
    await expect(firstIssue).toBeInViewport({ ratio: 1 });
    const lastIssue = dialog.getByText("File 23 needs review before syncing", {
      exact: true,
    });
    await lastIssue.scrollIntoViewIfNeeded();
    await expect(lastIssue).toBeInViewport({ ratio: 1 });
    await expect(dialog.getByRole("progressbar")).toBeInViewport({ ratio: 1 });
    await expect(footer.locator(".sync-activity-icon svg")).toHaveCSS(
      "animation-name",
      "none",
    );
    const accessibility = await new AxeBuilder({ page })
      .include(".sync-menu")
      .analyze();
    expect(accessibility.violations).toEqual([]);
    await page.screenshot({
      path: `artifacts/sync-progress-${size.width}.png`,
    });
  });
}
