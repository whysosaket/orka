import { test, expect, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import {
  resourceLibraryFixture,
  type LibraryWindow,
} from "./fixtures/resource-library.js";
import { skillFixture } from "./fixtures/skill-detail.js";
import type { Snapshot } from "../../apps/mac/src/types.js";

interface MenuControls {
  shareStatus: string;
  deleteStatus: string;
  deleteFailures: number;
  deferPreview: boolean;
  finishPreview?: () => void;
  resourceVersion: number;
  deleted: string[];
}
type MenuWindow = LibraryWindow & {
  resourceMenu: MenuControls;
  __TAURI_INTERNALS__: {
    invoke: (
      command: string,
      args?: Record<string, unknown>,
    ) => Promise<unknown>;
  };
};

async function menuFixture(page: Page, options: { emptyLocal?: boolean } = {}) {
  await resourceLibraryFixture(page, options);
  await page.evaluate(() => {
    const host = window as unknown as MenuWindow;
    const controls: MenuControls = {
      shareStatus: "queued",
      deleteStatus: "deleted",
      deleteFailures: 0,
      deferPreview: false,
      resourceVersion: 0,
      deleted: [],
    };
    host.resourceMenu = controls;
    const original = host.__TAURI_INTERNALS__.invoke;
    host.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
      if (command === "resource_command") {
        host.library.calls.push({ command, args });
        const input = args.input as {
          resourceId: string;
          previewToken?: string;
        };
        const action = String(args.action);
        if (action.startsWith("preview-")) {
          const preview = {
            previewToken: `frozen-${action}-${input.resourceId}`,
            title: `Reviewed ${input.resourceId}`,
            kind: input.resourceId.split("-")[0],
            files: [{ path: "content.md", size: 20 }],
            totalBytes: 20,
            paths: ["/synthetic/library/content.md"],
            note:
              action === "preview-delete"
                ? "This removes the shared snapshot and its installed copies through sync."
                : "Only this exact snapshot will be shared. Later changes stay private.",
          };
          if (controls.deferPreview)
            return new Promise((resolve) => {
              controls.finishPreview = () => resolve(preview);
            });
          return preview;
        }
        if (action === "share") return { status: controls.shareStatus };
        if (action === "delete") {
          if (controls.deleteFailures > 0) {
            controls.deleteFailures -= 1;
            throw new Error("Offline: deletion was not completed.");
          }
          if (controls.deleteStatus === "deleted")
            controls.deleted.push(input.resourceId);
          return { status: controls.deleteStatus };
        }
        return { paths: ["/synthetic/library/content.md"] };
      }
      const result = await original(command, args);
      if (command === "snapshot") {
        const snapshot = result as Snapshot;
        snapshot.resources = snapshot.resources.map((resource) => ({
          ...resource,
          deleted: controls.deleted.includes(resource.resourceId),
          hash: controls.resourceVersion
            ? resource.hash + ":" + controls.resourceVersion
            : resource.hash,
        }));
      }
      return result;
    };
  });
}

async function collection(
  page: Page,
  label: "Memories" | "Sessions" | "Plans",
) {
  await page.getByRole("button", { name: new RegExp("^" + label) }).click();
  await expect(page.getByRole("table")).toBeVisible();
}

function resourceRow(page: Page, name: string) {
  return page
    .getByRole("table")
    .locator("tbody tr")
    .filter({
      has: page.getByRole("button", { name, exact: true }),
    });
}

async function resourceMenu(page: Page, name: string, action?: string) {
  await resourceRow(page, name).click({ button: "right" });
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  if (action)
    await menu.getByRole("menuitem", { name: action, exact: true }).click();
  return menu;
}

const resourceCalls = (page: Page, action: string) =>
  page.evaluate(
    (action) =>
      (window as unknown as MenuWindow).library.calls.filter(
        (call) =>
          call.command === "resource_command" && call.args.action === action,
      ),
    action,
  );

test("resource row right-click and ellipsis share actions without opening, with keyboard dismissal", async ({
  page,
}) => {
  await menuFixture(page, { emptyLocal: true });
  await collection(page, "Plans");
  const row = resourceRow(page, "My shared plan");
  const opener = row.getByRole("button", {
    name: "My shared plan",
    exact: true,
  });
  const menu = await resourceMenu(page, "My shared plan");
  const actions = await menu.getByRole("menuitem").allTextContents();
  await expect(
    page.getByRole("region", { name: "Plan details", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await row
    .getByRole("button", { name: "Actions for My shared plan", exact: true })
    .click();
  expect(
    await page.getByRole("menu").getByRole("menuitem").allTextContents(),
  ).toEqual(actions);
  await page.keyboard.press("Escape");
  await opener.focus();
  await opener.press("Shift+F10");
  await expect(
    page.getByRole("menuitem", { name: "Open", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    page.getByRole("menuitem", { name: "Open in editor", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(opener).toBeFocused();
});

test("Home inherits each resource menu and fits a compact accessible window", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 640 });
  await menuFixture(page, { emptyLocal: true });
  const home = page.getByRole("list", { name: "Recently updated resources" });
  await home
    .locator('[data-resource-id="memory-own"]')
    .click({ button: "right" });
  const memoryActions = await page
    .getByRole("menu")
    .getByRole("menuitem")
    .allTextContents();
  await expect(
    page.getByRole("menuitem", { name: "Copy content", exact: true }),
  ).toBeVisible();
  const menuBounds = await page.getByRole("menu").boundingBox();
  expect(menuBounds).not.toBeNull();
  expect(menuBounds!.x).toBeGreaterThanOrEqual(0);
  expect(menuBounds!.y + menuBounds!.height).toBeLessThanOrEqual(640);
  await page.keyboard.press("Escape");
  await home
    .locator('[data-resource-id="session-own"]')
    .click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Continue or fork in…", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Delete update", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await collection(page, "Memories");
  await resourceMenu(page, "My shared memory");
  expect(
    await page.getByRole("menu").getByRole("menuitem").allTextContents(),
  ).toEqual(memoryActions);
  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);
});

test("local and teammate sessions expose useful actions without mutation of another owner's history", async ({
  page,
}) => {
  await menuFixture(page);
  await collection(page, "Sessions");
  await resourceMenu(page, "Private session notes");
  await expect(
    page.getByRole("menuitem", {
      name: "Share snapshot with project…",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Copy link", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("menuitem", { name: "Remove from history…", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await resourceMenu(page, "Mira's session");
  await expect(
    page.getByRole("menuitem", { name: "Create copy", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Copy link", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: /Share snapshot|Remove from history/ }),
  ).toHaveCount(0);
});

test("snapshot sharing requires review and submits the exact frozen token without changing category sharing", async ({
  page,
}) => {
  await menuFixture(page);
  await collection(page, "Memories");
  await resourceMenu(
    page,
    "Private memory notes",
    "Share snapshot with project…",
  );
  const dialog = page.getByRole("dialog", {
    name: "Share snapshot with project",
    exact: true,
  });
  await expect(dialog).toContainText("Reviewed memory-local");
  await expect(dialog).toContainText("Library");
  await expect(dialog).toContainText("content.md");
  await expect(dialog).toContainText(
    "local original and automatic sharing settings stay unchanged",
  );
  expect(await resourceCalls(page, "share")).toEqual([]);
  await dialog
    .getByRole("button", { name: "Share this snapshot", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByText("Snapshot sharing queued", { exact: true }),
  ).toBeVisible();
  expect((await resourceCalls(page, "share"))[0]?.args.input).toEqual({
    accountId: "user",
    serviceOrigin: "https://library.example",
    projectId: "project",
    resourceId: "memory-local",
    previewToken: "frozen-preview-share-memory-local",
  });
  const calls = await page.evaluate(
    () => (window as unknown as MenuWindow).library.calls,
  );
  expect(
    calls.filter(
      (call) =>
        call.command === "project_command" || call.command === "configure",
    ),
  ).toEqual([]);
});

for (const [status, notice] of [
  ["approval_required", "Snapshot sent for approval"],
  ["conflict", "Snapshot needs conflict review"],
]) {
  test(`${status} share receipt is not reported as publication`, async ({
    page,
  }) => {
    await menuFixture(page);
    await collection(page, "Memories");
    await page.evaluate((status) => {
      (window as unknown as MenuWindow).resourceMenu.shareStatus = status;
    }, status);
    await resourceMenu(
      page,
      "Private memory notes",
      "Share snapshot with project…",
    );
    const dialog = page.getByRole("dialog", {
      name: "Share snapshot with project",
      exact: true,
    });
    await dialog
      .getByRole("button", { name: "Share this snapshot", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText(notice, { exact: true })).toBeVisible();
    await expect(
      page.getByText("Snapshot shared", { exact: true }),
    ).toHaveCount(0);
    expect(await resourceCalls(page, "share")).toHaveLength(1);
  });
}

test("shared deletion retries a network failure with the same reviewed token before acknowledged success", async ({
  page,
}) => {
  await menuFixture(page, { emptyLocal: true });
  await collection(page, "Plans");
  await page.evaluate(() => {
    const controls = (window as unknown as MenuWindow).resourceMenu;
    controls.deleteFailures = 1;
  });
  await resourceMenu(page, "My shared plan", "Delete shared plan…");
  const dialog = page.getByRole("dialog", {
    name: "Delete shared plan",
    exact: true,
  });
  await expect(dialog).toContainText("installed copies through sync");
  expect(await resourceCalls(page, "delete")).toEqual([]);
  const confirm = dialog.getByRole("button", {
    name: "Confirm deletion",
    exact: true,
  });
  await confirm.click();
  await expect(dialog.getByRole("alert")).toContainText(
    "deletion was not completed",
  );
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(dialog).toHaveCount(0);
  await expect(resourceRow(page, "My shared plan")).toHaveCount(0);
  const deletes = await resourceCalls(page, "delete");
  expect(deletes).toHaveLength(2);
  expect(
    new Set(
      deletes.map(
        (call) => (call.args.input as { previewToken: string }).previewToken,
      ),
    ),
  ).toEqual(new Set(["frozen-preview-delete-plan-own"]));
});

test("removing shared history from Home refreshes a cached collection for newly discovered local sessions", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2026-11-14T10:00:00Z"));
  await menuFixture(page, { emptyLocal: true });
  await page.evaluate(async () => {
    const host = window as unknown as MenuWindow;
    const original = host.__TAURI_INTERNALS__.invoke;
    const snapshot = (await original("snapshot")) as Snapshot;
    const shared = snapshot.resources.find(
      (resource) => resource.resourceId === "session-own",
    )!;
    host.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
      const result = await original(command, args);
      if (
        command === "local_resource_catalog" &&
        args.kind === "session" &&
        host.resourceMenu.deleted.includes(shared.resourceId)
      )
        return {
          resources: [
            {
              ...shared,
              resourceId: "session-retained",
              title: "New private session notes",
              local: true,
              revision: 0,
            },
          ],
          errors: [],
        };
      return result;
    };
  });
  const scans = () =>
    page.evaluate(
      () =>
        (window as unknown as MenuWindow).library.calls.filter(
          (call) =>
            call.command === "local_resource_catalog" &&
            call.args.kind === "session",
        ).length,
    );
  const home = page.getByRole("button", { name: "Home", exact: true });
  await collection(page, "Sessions");
  await expect(resourceRow(page, "My shared session")).toBeVisible();
  expect(await scans()).toBe(1);
  await home.click();
  await collection(page, "Sessions");
  expect(await scans()).toBe(1);
  await home.click();
  await page
    .getByRole("list", { name: "Recently updated resources" })
    .locator('[data-resource-id="session-own"]')
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Remove from history…", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Remove from history",
    exact: true,
  });
  await dialog
    .getByRole("button", { name: "Confirm deletion", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await collection(page, "Sessions");
  await expect.poll(scans).toBe(2);
  await expect(resourceRow(page, "New private session notes")).toContainText(
    "On this Mac",
  );
  await expect(resourceRow(page, "My shared session")).toHaveCount(0);
  expect(await resourceCalls(page, "delete")).toHaveLength(1);
});

test("a changed shared resource invalidates an open deletion review", async ({
  page,
}) => {
  await menuFixture(page, { emptyLocal: true });
  await collection(page, "Plans");
  await resourceMenu(page, "My shared plan", "Delete shared plan…");
  const dialog = page.getByRole("dialog", {
    name: "Delete shared plan",
    exact: true,
  });
  await expect(
    dialog.getByRole("button", { name: "Confirm deletion", exact: true }),
  ).toBeEnabled();
  await page.evaluate(() => {
    (window as unknown as MenuWindow).resourceMenu.resourceVersion += 1;
  });
  await expect(dialog.getByRole("alert")).toContainText(
    "This item or account changed",
  );
  await expect(
    dialog.getByRole("button", { name: "Confirm deletion", exact: true }),
  ).toBeDisabled();
  expect(await resourceCalls(page, "delete")).toEqual([]);
});

test("a late snapshot preview cannot be submitted after changing accounts", async ({
  page,
}) => {
  await menuFixture(page);
  await collection(page, "Memories");
  await page.evaluate(() => {
    (window as unknown as MenuWindow).resourceMenu.deferPreview = true;
  });
  await resourceMenu(
    page,
    "Private memory notes",
    "Share snapshot with project…",
  );
  const dialog = page.getByRole("dialog", {
    name: "Share snapshot with project",
    exact: true,
  });
  await expect(
    dialog.getByRole("button", { name: "Share this snapshot", exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => {
    (window as unknown as MenuWindow).library.user = "another-user";
  });
  await expect(dialog).toHaveCount(0);
  await page.evaluate(() => {
    (window as unknown as MenuWindow).resourceMenu.finishPreview?.();
  });
  await expect(dialog).toHaveCount(0);
  expect(await resourceCalls(page, "share")).toEqual([]);
});

test("app chrome suppresses webview menus while text fields and selected resource text keep native editing", async ({
  page,
}) => {
  await menuFixture(page, { emptyLocal: true });
  await collection(page, "Memories");
  const allowed = (target: HTMLElement) =>
    target.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    );
  expect(await page.locator("main").evaluate(allowed)).toBe(false);
  expect(
    await page
      .getByRole("searchbox", { name: "Search memories", exact: true })
      .evaluate(allowed),
  ).toBe(true);
  const text = resourceRow(page, "My shared memory").getByRole("button", {
    name: "My shared memory",
    exact: true,
  });
  expect(
    await text.evaluate((target) => {
      const selection = window.getSelection()!;
      const range = document.createRange();
      range.selectNodeContents(target);
      selection.removeAllRanges();
      selection.addRange(range);
      return target.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
      );
    }),
  ).toBe(true);
  await expect(page.getByRole("menu")).toHaveCount(0);
  await text.focus();
  await text.press("Shift+F10");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await text.click();
  await page
    .getByRole("region", { name: "Memory details", exact: true })
    .evaluate((element) => {
      const link = document.createElement("a");
      link.href = "https://example.com/notes";
      link.textContent = "Read linked notes";
      element.append(link);
      const input = document.createElement("input");
      input.setAttribute("aria-label", "Local note text");
      element.append(input);
    });
  for (const target of [
    page.getByRole("link", { name: "Read linked notes" }),
    page.getByRole("textbox", { name: "Local note text" }),
  ]) {
    await target.focus();
    await target.press("Shift+F10");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(target).toBeFocused();
  }
});

test("read-only shared skills retain copy and export but omit sharing and deletion", async ({
  page,
}) => {
  await skillFixture(page, { role: "member", access: "read", open: false });
  await page.locator(".skill-card").click({ button: "right" });
  const menu = page.getByRole("menu");
  await expect(
    menu.getByRole("menuitem", { name: "Copy link", exact: true }),
  ).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "Export ZIP…", exact: true }),
  ).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: /Delete shared skill|Share snapshot/ }),
  ).toHaveCount(0);
});
