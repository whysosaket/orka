import { test, expect, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import {
  resourceLibraryFixture,
  type LibraryWindow,
} from "./fixtures/resource-library.js";
import { skillFixture } from "./fixtures/skill-detail.js";
import type { Snapshot, SyncProgress } from "../../apps/mac/src/types.js";

interface MenuControls {
  shareStatus: string;
  deleteStatus: string;
  deleteFailures: number;
  deferPreview: boolean;
  previewFailures: number;
  previewTitle?: string;
  previewNote?: string;
  projectName?: string;
  previewFiles?: { path: string; size: number }[];
  previewProgress?: (progress: SyncProgress) => void;
  previewProgresses: ((progress: SyncProgress) => void)[];
  finishPreview?: () => void;
  failPreview?: () => void;
  finishPreviews: (() => void)[];
  deferShare: boolean;
  shareProgress?: (progress: SyncProgress) => void;
  finishShare?: () => void;
  failShare?: () => void;
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

async function menuFixture(
  page: Page,
  options: Parameters<typeof resourceLibraryFixture>[1] = {},
) {
  await resourceLibraryFixture(page, options);
  await page.evaluate(() => {
    const host = window as unknown as MenuWindow;
    const controls: MenuControls = {
      shareStatus: "queued",
      deleteStatus: "deleted",
      deleteFailures: 0,
      deferPreview: false,
      previewFailures: 0,
      previewProgresses: [],
      finishPreviews: [],
      deferShare: false,
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
        const onProgress = args.onProgress as
          { onmessage: (value: SyncProgress) => void } | undefined;
        if (action.startsWith("preview-")) {
          controls.previewProgress = onProgress?.onmessage;
          if (onProgress) controls.previewProgresses.push(onProgress.onmessage);
          if (controls.previewFailures > 0) {
            controls.previewFailures -= 1;
            throw new Error("Local folder temporarily unavailable");
          }
          const files = controls.previewFiles ?? [
            { path: "content.md", size: 20 },
          ];
          const preview = {
            previewToken: `frozen-${action}-${input.resourceId}`,
            title: controls.previewTitle ?? `Reviewed ${input.resourceId}`,
            kind: input.resourceId.split("-")[0],
            files,
            totalBytes: files.reduce((total, file) => total + file.size, 0),
            paths: ["/synthetic/library/content.md"],
            note:
              controls.previewNote ??
              (action === "preview-delete"
                ? "This removes the shared snapshot and its installed copies through sync."
                : "Only this exact snapshot will be shared. Later changes stay private."),
          };
          if (controls.deferPreview)
            return new Promise((resolve, reject) => {
              controls.finishPreview = () => resolve(preview);
              controls.failPreview = () =>
                reject(
                  new Error(
                    "Local folder temporarily unavailable. Reconnect the source folder and try preparing this snapshot again.",
                  ),
                );
              controls.finishPreviews.push(controls.finishPreview);
            });
          return preview;
        }
        if (action === "share") {
          controls.shareProgress = onProgress?.onmessage;
          if (controls.deferShare)
            return new Promise((resolve, reject) => {
              controls.finishShare = () =>
                resolve({ status: controls.shareStatus });
              controls.failShare = () =>
                reject(
                  new Error(
                    "Connection interrupted while sharing. The reviewed snapshot is still available; retry when you are connected.",
                  ),
                );
            });
          return { status: controls.shareStatus };
        }
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
        snapshot.projects = snapshot.projects.map((project) => ({
          ...project,
          name: controls.projectName ?? project.name,
        }));
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
  await resourceRow(page, name).click({
    button: "right",
    position: { x: 8, y: 8 },
  });
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
  await expect(opener).toBeFocused();
  const more = row.getByRole("button", {
    name: "Actions for My shared plan",
    exact: true,
  });
  await more.click();
  expect(
    await page.getByRole("menu").getByRole("menuitem").allTextContents(),
  ).toEqual(actions);
  await page.keyboard.press("Escape");
  await expect(more).toBeFocused();
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

for (const width of [1160, 900]) {
  for (const withoutRepositories of [false, true]) {
    test(`collection action buttons fit padded rows at ${width}px ${withoutRepositories ? "without" : "with"} repositories`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 800 });
      await menuFixture(page, { emptyLocal: true, withoutRepositories });
      for (const label of ["Sessions", "Memories", "Plans"] as const) {
        await collection(page, label);
        const table = page.getByRole("table");
        await expect(
          table.getByRole("columnheader", { name: "Repository", exact: true }),
        ).toHaveCount(withoutRepositories ? 0 : 1);
        const buttons = table.getByRole("button", { name: /^Actions for / });
        await expect(buttons).toHaveCount(2);
        if (label === "Sessions")
          await page.screenshot({ path: testInfo.outputPath("sessions.png") });
        const bounds = await buttons.evaluateAll((buttons) =>
          buttons.map((button) => {
            const cell = button.closest("td")!;
            const box = button.getBoundingClientRect();
            const cellBox = cell.getBoundingClientRect();
            const style = getComputedStyle(cell);
            return {
              leftGap: box.left - cellBox.left,
              rightGap: cellBox.right - box.right,
              paddingLeft: parseFloat(style.paddingLeft),
              paddingRight: parseFloat(style.paddingRight),
              centerOffset: Math.abs(
                box.top + box.height / 2 - cellBox.top - cellBox.height / 2,
              ),
            };
          }),
        );
        for (const box of bounds) {
          expect(box.leftGap).toBeGreaterThanOrEqual(box.paddingLeft - 1);
          expect(box.rightGap).toBeGreaterThanOrEqual(box.paddingRight - 1);
          expect(box.centerOffset).toBeLessThanOrEqual(1);
        }
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await buttons.first().click();
        await expect(page.getByRole("menu")).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(buttons.first()).toBeFocused();
      }
    });
  }
}

test("Home keeps resource context menus without separate action buttons in a compact accessible window", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 900, height: 640 });
  await menuFixture(page, { emptyLocal: true });
  const home = page.getByRole("list", { name: "Recently updated resources" });
  await page.screenshot({ path: testInfo.outputPath("home.png") });
  await expect(home.getByRole("button", { name: /^Actions for / })).toHaveCount(
    0,
  );
  await expect(home.getByRole("button")).toHaveCount(6);
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
  const memory = home.locator('[data-resource-id="memory-own"]');
  await memory.focus();
  await memory.press("Shift+F10");
  expect(
    await page.getByRole("menu").getByRole("menuitem").allTextContents(),
  ).toEqual(memoryActions);
  await page.keyboard.press("Escape");
  await expect(memory).toBeFocused();
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

for (const viewport of [
  { width: 1160, height: 800 },
  { width: 900, height: 640 },
]) {
  test(`snapshot review groups files and reports actual preparation progress at ${viewport.width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await menuFixture(page);
    await page.evaluate(() => {
      const controls = (window as unknown as MenuWindow).resourceMenu;
      controls.deferPreview = true;
      controls.previewTitle =
        "Review the project navigation, session sharing and resource menus before the next release. Keep the existing workspace and sharing choices intact while checking long session titles.";
      controls.previewFiles = [{ path: "session.jsonl", size: 8_284_522 }];
    });
    await collection(page, "Sessions");
    await resourceMenu(
      page,
      "Private session notes",
      "Share snapshot with project…",
    );
    const dialog = page.getByRole("dialog", {
      name: "Share snapshot with project",
      exact: true,
    });
    const confirm = dialog.getByRole("button", {
      name: "Share this snapshot",
      exact: true,
    });
    const bar = dialog.getByRole("progressbar");
    await expect(confirm).toBeDisabled();
    await expect(bar).toHaveCount(1);
    await expect(bar).not.toHaveAttribute("aria-valuenow");
    await expect(bar.locator("span")).toHaveCSS("animation-name", "none");
    await page.evaluate(() => {
      (window as unknown as MenuWindow).resourceMenu.previewProgress?.({
        label: "Checking local files",
        detail: "session.jsonl",
      });
    });
    await expect(bar).toHaveAttribute("aria-label", "Checking local files");
    await expect(bar).not.toHaveAttribute("aria-valuenow");
    await expect(dialog.getByRole("status")).toContainText("session.jsonl");
    await page.screenshot({
      path: testInfo.outputPath(`snapshot-loading-${viewport.width}.png`),
    });
    await page.evaluate(() => {
      (window as unknown as MenuWindow).resourceMenu.previewProgress?.({
        label: "Checking local files",
        detail: "session.jsonl",
        completed: 3,
        total: null,
      });
    });
    await expect(bar).not.toHaveAttribute("aria-valuenow");
    await expect(dialog.getByRole("status")).toContainText("3 checked");
    await page.evaluate(() => {
      (window as unknown as MenuWindow).resourceMenu.previewProgress?.({
        label: "Freezing reviewed snapshot",
        detail: "session.jsonl",
        completed: 1,
        total: 2,
      });
    });
    await expect(bar).toHaveAttribute("aria-valuenow", "1");
    await expect(bar).toHaveAttribute("aria-valuemax", "2");
    await expect(bar.locator("span")).toHaveCSS(
      "width",
      await bar.evaluate((el) => `${el.clientWidth / 2}px`),
    );
    await page.evaluate(() =>
      (window as unknown as MenuWindow).resourceMenu.finishPreview?.(),
    );
    await expect(confirm).toBeEnabled();
    await expect(bar).toHaveCount(0);
    const files = dialog.getByRole("list", {
      name: "Snapshot files",
      exact: true,
    });
    await expect(files.getByRole("listitem")).toHaveCount(1);
    await expect(files).toContainText("session.jsonl");
    await expect(files).toContainText("8.3 MB");
    await expect(
      dialog.getByRole("region", { name: "Selected item", exact: true }),
    ).toContainText("Review the project navigation");
    await expect(dialog.locator("h2").last()).toHaveCSS("font-size", "20px");
    await expect(
      dialog.getByRole("region", { name: "Snapshot contents", exact: true }),
    ).toHaveCSS("border-top-width", "1px");
    expect(
      await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      (
        await new AxeBuilder({ page })
          .include(".resource-command-dialog")
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`snapshot-ready-${viewport.width}.png`),
    });
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(
      resourceRow(page, "Private session notes").getByRole("button", {
        name: "Private session notes",
        exact: true,
      }),
    ).toBeFocused();
  });
}

for (const viewport of [
  { width: 1160, height: 800 },
  { width: 900, height: 640 },
]) {
  for (const motion of ["reduce", "no-preference"] as const) {
    test(`snapshot review controls stay stationary through every state at ${viewport.width}px with ${motion} motion`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize(viewport);
      await menuFixture(page);
      await page.emulateMedia({ reducedMotion: motion });
      await page.evaluate(() => {
        const controls = (window as unknown as MenuWindow).resourceMenu;
        controls.deferPreview = true;
        controls.deferShare = true;
        controls.previewTitle =
          "A much longer reviewed session title that must remain inside its reserved title area without moving the project details, status area or footer buttons across review states.";
        controls.previewNote =
          "Only this exact snapshot will be shared. Later changes remain private. The local original and automatic sharing choices are preserved. "
            .repeat(5)
            .trim();
        controls.previewFiles = Array.from({ length: 18 }, (_, index) => ({
          path: `references/${"long-snapshot-filename-".repeat(6)}${index}.md`,
          size: 12_500 + index,
        }));
      });
      await collection(page, "Sessions");
      await resourceMenu(
        page,
        "Private session notes",
        "Share snapshot with project…",
      );
      const dialog = page.getByRole("dialog", {
        name: "Share snapshot with project",
        exact: true,
      });
      await page.evaluate(() => document.fonts.ready);
      const geometry = () =>
        dialog.evaluate((el) => {
          const selectors = [
            "h2[title]",
            ".resource-command-item",
            ".resource-command-destination",
            ".command-copy",
            ".resource-command-workspace",
            ".actions",
            ".resource-command-main-actions > button:first-child",
            ".resource-command-confirm",
          ];
          return [
            el,
            ...selectors.map((selector) => el.querySelector(selector)!),
          ].map((node) => {
            const rect = node.getBoundingClientRect();
            return [rect.x, rect.y, rect.width, rect.height].map(
              (value) => Math.round(value * 100) / 100,
            );
          });
        });
      const initial = await geometry();
      const stationary = async () => {
        await expect.poll(geometry).toEqual(initial);
      };
      const confirm = dialog.getByRole("button", {
        name: "Share this snapshot",
        exact: true,
      });
      await expect(confirm).toBeDisabled();
      await page.evaluate(() => {
        (window as unknown as MenuWindow).resourceMenu.projectName =
          "A long project name that must truncate within the destination row instead of increasing the modal height or moving any controls";
      });
      await expect(
        dialog.locator(".resource-command-destination dd").first(),
      ).toContainText("A long project name");
      await stationary();
      await expect(
        dialog.locator(".resource-command-destination dd").first(),
      ).toHaveAttribute("title", /A long project name/);
      await page.evaluate(() =>
        (window as unknown as MenuWindow).resourceMenu.previewProgress?.({
          label: "Checking local files",
          detail: "session.jsonl",
        }),
      );
      await expect(dialog.getByRole("progressbar")).toHaveAttribute(
        "aria-label",
        "Checking local files",
      );
      await stationary();
      await page.evaluate(() =>
        (window as unknown as MenuWindow).resourceMenu.failPreview?.(),
      );
      await expect(dialog.getByRole("alert")).toContainText(
        "Local folder temporarily unavailable",
      );
      await expect(dialog.getByRole("alert")).toBeInViewport({ ratio: 1 });
      await stationary();
      await dialog
        .getByRole("button", { name: "Try again", exact: true })
        .click();
      await expect(dialog.getByRole("progressbar")).toBeVisible();
      await expect(dialog.getByRole("progressbar")).toBeInViewport({
        ratio: 1,
      });
      await stationary();
      await page.evaluate(() =>
        (window as unknown as MenuWindow).resourceMenu.finishPreview?.(),
      );
      await expect(confirm).toBeEnabled();
      await stationary();
      const itemTitle = dialog.locator(".resource-command-item p");
      await expect(itemTitle).toHaveAttribute(
        "title",
        /A much longer reviewed session title/,
      );
      const filename = dialog.locator(".resource-command-filename").first();
      expect(
        await filename.evaluate((el) => el.scrollWidth > el.clientWidth),
      ).toBe(true);
      await expect(filename).toHaveAttribute(
        "title",
        /references\/long-snapshot-filename/,
      );
      const note = dialog.locator(".resource-command-note");
      const fullNote = await page.evaluate(
        () => (window as unknown as MenuWindow).resourceMenu.previewNote,
      );
      await expect(note).toHaveText(fullNote!);
      await expect(note).toHaveCSS("-webkit-line-clamp", "none");
      const details = dialog.getByRole("region", {
        name: "Review details",
        exact: true,
      });
      expect(
        await details.evaluate((el) => el.scrollHeight > el.clientHeight),
      ).toBe(true);
      await note.scrollIntoViewIfNeeded();
      await stationary();
      await confirm.click();
      await expect(
        dialog.getByRole("button", { name: "Working…", exact: true }),
      ).toBeDisabled();
      await expect(dialog.getByRole("progressbar")).toBeVisible();
      await expect(dialog.getByRole("progressbar")).toBeInViewport({
        ratio: 1,
      });
      await stationary();
      await page.evaluate(() =>
        (window as unknown as MenuWindow).resourceMenu.failShare?.(),
      );
      await expect(dialog.getByRole("alert")).toContainText(
        "Connection interrupted while sharing",
      );
      await expect(dialog.getByRole("alert")).toBeInViewport({ ratio: 1 });
      await expect(confirm).toBeEnabled();
      await stationary();
      await expect(note).toHaveText(fullNote!);
      if (motion === "reduce")
        await page.screenshot({
          path: testInfo.outputPath(
            `snapshot-error-stable-${viewport.width}.png`,
          ),
        });
      await confirm.click();
      await expect(
        dialog.getByRole("button", { name: "Working…", exact: true }),
      ).toBeDisabled();
      await stationary();
      await page.evaluate(() =>
        (window as unknown as MenuWindow).resourceMenu.finishShare?.(),
      );
      await expect(dialog).toHaveCount(0);
    });
  }
}

test("snapshot file review bounds long manifests in a compact window", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 900, height: 640 });
  await menuFixture(page);
  await page.evaluate(() => {
    const controls = (window as unknown as MenuWindow).resourceMenu;
    controls.previewTitle = "Complete project review package";
    controls.previewFiles = Array.from({ length: 18 }, (_, index) => ({
      path: `references/${"long-review-filename-".repeat(8)}${index}.md`,
      size: 12_500 + index,
    }));
  });
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
  const files = dialog.getByRole("list", {
    name: "Snapshot files",
    exact: true,
  });
  await expect(files.getByRole("listitem")).toHaveCount(18);
  expect(
    await files.evaluate(
      (el) => el.scrollHeight > el.clientHeight && el.clientHeight <= 200,
    ),
  ).toBe(true);
  await files.focus();
  await files.press("End");
  await expect
    .poll(() => files.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  await files.press("Home");
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  await expect(
    dialog.getByRole("button", { name: "Share this snapshot", exact: true }),
  ).toBeEnabled();
  expect(
    await dialog.evaluate((el) => {
      const confirm = el.querySelector(".actions button:last-child")!;
      return (
        confirm.getBoundingClientRect().bottom <=
        el.getBoundingClientRect().bottom - 20
      );
    }),
  ).toBe(true);
  expect(
    (
      await new AxeBuilder({ page })
        .include(".resource-command-dialog")
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("snapshot-files-900.png"),
  });
});

test("snapshot retry and submission ignore earlier progress channels", async ({
  page,
}) => {
  await menuFixture(page);
  await collection(page, "Memories");
  await page.evaluate(() => {
    (window as unknown as MenuWindow).resourceMenu.previewFailures = 1;
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
  await expect(dialog.getByRole("alert")).toContainText(
    "Local folder temporarily unavailable",
  );
  await page.evaluate(() => {
    const controls = (window as unknown as MenuWindow).resourceMenu;
    controls.deferPreview = true;
    controls.deferShare = true;
  });
  await dialog.getByRole("button", { name: "Try again", exact: true }).click();
  await page.evaluate(() => {
    const controls = (window as unknown as MenuWindow).resourceMenu;
    controls.previewProgresses[0]?.({
      label: "Stale failed preview",
      completed: 99,
      total: 100,
    });
    controls.previewProgress?.({
      label: "Checking fresh files",
      detail: "content.md",
    });
  });
  await expect(dialog.getByRole("progressbar")).toHaveAttribute(
    "aria-label",
    "Checking fresh files",
  );
  await expect(dialog).not.toContainText("Stale failed preview");
  await page.evaluate(() =>
    (window as unknown as MenuWindow).resourceMenu.finishPreview?.(),
  );
  const confirm = dialog.getByRole("button", {
    name: "Share this snapshot",
    exact: true,
  });
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(
    dialog.getByRole("button", { name: "Working…", exact: true }),
  ).toBeDisabled();
  await expect(dialog.getByRole("progressbar")).toHaveAttribute(
    "aria-label",
    "Sharing reviewed snapshot…",
  );
  await page.evaluate(() => {
    const controls = (window as unknown as MenuWindow).resourceMenu;
    controls.previewProgress?.({
      label: "Late finished preview",
      completed: 1,
      total: 1,
    });
  });
  await expect(dialog.getByRole("progressbar")).toHaveAttribute(
    "aria-label",
    "Sharing reviewed snapshot…",
  );
  await page.evaluate(() => {
    (window as unknown as MenuWindow).resourceMenu.shareProgress?.({
      label: "Uploading reviewed files",
      detail: "content.md",
      completed: 1,
      total: 2,
    });
  });
  await expect(dialog.getByRole("progressbar")).toHaveAttribute(
    "aria-valuenow",
    "1",
  );
  await expect(dialog.getByRole("progressbar")).toHaveAttribute(
    "aria-label",
    "Uploading reviewed files",
  );
  await page.evaluate(() =>
    (window as unknown as MenuWindow).resourceMenu.finishShare?.(),
  );
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByText("Snapshot sharing queued", { exact: true }),
  ).toBeVisible();
  expect(await resourceCalls(page, "share")).toHaveLength(1);
});

test("canceled snapshot preparation cannot update a reopened review", async ({
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
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await resourceMenu(
    page,
    "Private memory notes",
    "Share snapshot with project…",
  );
  await page.evaluate(() => {
    const controls = (window as unknown as MenuWindow).resourceMenu;
    controls.previewProgresses[0]?.({ label: "Canceled preview progress" });
    controls.finishPreviews[0]?.();
    controls.previewProgress?.({
      label: "Reading current snapshot",
      detail: "content.md",
    });
  });
  await expect(dialog.getByRole("progressbar")).toHaveAttribute(
    "aria-label",
    "Reading current snapshot",
  );
  await expect(dialog).not.toContainText("Canceled preview progress");
  const confirm = dialog.getByRole("button", {
    name: "Share this snapshot",
    exact: true,
  });
  await expect(confirm).toBeDisabled();
  await page.evaluate(() =>
    (window as unknown as MenuWindow).resourceMenu.finishPreview?.(),
  );
  await expect(confirm).toBeEnabled();
  expect(await resourceCalls(page, "share")).toEqual([]);
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
    "Local Only",
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
