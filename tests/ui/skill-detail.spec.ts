import { test, expect, type Locator } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import type {
  Inspection,
  LocalDraft,
  Snapshot,
} from "../../apps/mac/src/types.js";
import {
  calls,
  detail,
  governanceCalls,
  rail,
  skillFixture,
  toast,
} from "./fixtures/skill-detail.js";

type NativeFixture = {
  invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
};

async function backgroundChannels(line: Locator) {
  return line.evaluate((element) => {
    // Normalize rgb(), color-mix() and color(srgb) consistently across engines.
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d")!;
    context.fillStyle = getComputedStyle(element).backgroundColor;
    context.fillRect(0, 0, 1, 1);
    return Array.from(context.getImageData(0, 0, 1, 1).data);
  });
}

test("the wide reader shows frontmatter, facts, files, and header navigation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await skillFixture(page);
  const view = detail(page);
  await expect(view).toHaveAttribute("data-layout", "wide");
  await expect(
    page.getByRole("button", { name: "Back to Skills", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".workspace-header h1")).toHaveText("Skills");
  await expect(view.locator(".skill-title")).toHaveText(
    "issue-investigate-followup",
  );
  await expect(view.locator(".skill-description")).toContainText(
    "Act on an issue-investigate report",
  );
  const info = rail(page);
  await expect(info.getByRole("heading", { name: "Skill info" })).toBeVisible();
  await expect(info.locator(".skill-facts dt")).toHaveText([
    "Updated by",
    "Updated at",
    "Version",
  ]);
  await expect(info.locator(".skill-facts dd")).toHaveText([
    "You",
    /Oct 2\d at \d+:\d\d [AP]M/,
    "3",
  ]);
  for (const name of ["Copy skill link", "Export ZIP"]) {
    const button = info.getByRole("button", { name, exact: true });
    await expect(button).toBeVisible();
    await button.hover();
    await expect(page.locator(".skill-action-tooltip")).toHaveText(name);
    await page.keyboard.press("Escape");
    await expect(page.locator(".skill-action-tooltip")).toHaveCount(0);
  }
  await page.evaluate(() => document.fonts.ready);
  // The rail must not inherit padding or hover fill from collection cards.
  const card = info.locator(".skill-info");
  await expect(card).toHaveCSS("padding", "0px");
  await card.hover();
  await expect(card).toHaveCSS("background-color", "rgb(28, 28, 28)");
  expect(await card.boundingBox()).toEqual({
    x: 1096,
    y: 92,
    width: 308,
    height: 229,
  });
  await expect(info.locator('.skill-file[aria-current="true"]')).toHaveCSS(
    "background-color",
    "rgb(46, 46, 46)",
  );
  await expect(
    info.getByRole("button", { name: "View changes", exact: true }),
  ).toHaveCSS("background-color", "rgb(37, 37, 37)");
  await expect(info.getByRole("button", { name: /Review local/ })).toHaveCount(
    0,
  );
  await expect(info.locator(".skill-files-count")).toContainText("4");
  const files = info.locator(".skill-file");
  await expect(files).toHaveText([
    "SKILL.md",
    "scripts/candidates.sh",
    "assets/platform-checks.csv",
    "references/review-checklist.pdf",
  ]);
  await expect(files.first()).toHaveAttribute("aria-current", "true");
  await expect(
    view.getByRole("button", { name: "Formatted", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    view.getByRole("article", { name: "Rendered Markdown" }),
  ).toContainText("Issue follow-up");
  await expect(
    view.getByRole("article", { name: "Rendered Markdown" }),
  ).not.toContainText("name: issue");
  await info
    .getByRole("button", { name: "Copy skill link", exact: true })
    .click();
  expect(await page.evaluate(() => (window as any).copiedText)).toBe(
    "orka://project/one/skill-a",
  );
  await page.screenshot({ path: "artifacts/skill-detail-1440.png" });
  const accessibility = await new AxeBuilder({ page })
    .include(".app > main")
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await page
    .getByRole("button", { name: "Back to Skills", exact: true })
    .click();
  await expect(page.locator(".skill-card")).toBeVisible();
});

test("file selection reads each type and scopes the editor action", async ({
  page,
}) => {
  await skillFixture(page);
  const view = detail(page);
  const files = rail(page).locator(".skill-file");
  await files.filter({ hasText: "scripts/candidates.sh" }).click();
  const source = view.locator(".source-card");
  await expect(source.locator(".source-card-type")).toHaveText("Shell script");
  await expect(source.locator(".source-plain")).toContainText("gh pr list");
  await expect(view.getByRole("group", { name: "Markdown view" })).toHaveCount(
    0,
  );
  await files.filter({ hasText: "assets/platform-checks.csv" }).click();
  await expect(source.locator(".source-card-type")).toHaveText("CSV");
  await expect(source.locator(".source-plain")).toContainText(
    "platform,check,required",
  );
  await files.filter({ hasText: "references/review-checklist.pdf" }).click();
  await expect(source.locator(".source-card-type")).toHaveText("PDF");
  await expect(
    rail(page).getByRole("button", { name: "View changes", exact: true }),
  ).toBeDisabled();
  await expect(source.getByText("Preview unavailable")).toBeVisible();
  await expect(
    source.getByText("Use Open in editor to view this PDF."),
  ).toBeVisible();
  await rail(page)
    .getByRole("button", { name: "Open in editor", exact: true })
    .click();
  expect(await calls(page, "open_editor")).toEqual([
    { id: "skill-a", file: "references/review-checklist.pdf" },
  ]);
  await files.filter({ hasText: "SKILL.md" }).click();
  await expect(
    view.getByRole("article", { name: "Rendered Markdown" }),
  ).toBeVisible();
  await view.getByRole("button", { name: "Markdown", exact: true }).click();
  const lines = view.getByRole("group", { name: "Markdown source" });
  await expect(lines).toBeVisible();
  await expect(lines.locator(".source-line").first()).toContainText("---");
  await expect(lines.locator(".source-line").nth(1)).toContainText(
    "name: issue-investigate-followup",
  );
  await expect(lines.locator(".code-heading").first()).toHaveText(
    "Issue follow-up",
  );
  // Each file was read once; cached reads do not repeat while switching.
  const reads = (await calls(page, "inspect_resource")) as { file: string }[];
  expect(
    reads.filter((read) => read.file === "scripts/candidates.sh"),
  ).toHaveLength(1);
});

test("a late read for an earlier file cannot replace the selected file", async ({
  page,
}) => {
  await skillFixture(page);
  const view = detail(page);
  const files = rail(page).locator(".skill-file");
  await page.evaluate(() => {
    (window as any).slowInspect = "assets/platform-checks.csv";
  });
  await files.filter({ hasText: "assets/platform-checks.csv" }).click();
  await expect(
    view.getByRole("status").filter({ hasText: "Loading content…" }),
  ).toHaveCount(1);
  await files.filter({ hasText: "scripts/candidates.sh" }).click();
  await expect(
    view.locator(".source-plain", { hasText: "gh pr list" }),
  ).toBeVisible();
  await page.evaluate(() => (window as any).finishInspect());
  await page.waitForTimeout(150);
  await expect(
    view.locator(".source-plain", { hasText: "gh pr list" }),
  ).toBeVisible();
  await expect(view.getByText("platform,check,required")).toHaveCount(0);
  // Switching away cancelled the held read, so the next selection reads again.
  await page.evaluate(() => {
    (window as any).slowInspect = null;
  });
  await files.filter({ hasText: "assets/platform-checks.csv" }).click();
  await expect(
    view.locator(".source-plain", { hasText: "platform,check,required" }),
  ).toBeVisible();
});

test("view changes compares the selected file with its cached previous copy", async ({
  page,
}) => {
  await skillFixture(page);
  const view = detail(page);
  const compare = rail(page).locator(".skill-compare");
  await expect(compare).toHaveText("View changes");
  await compare.click();
  await expect(compare).toHaveText("Show content");
  await expect(compare).toHaveAttribute("aria-pressed", "true");
  const card = view.locator(".diff-card");
  await expect(card.getByRole("heading", { name: "SKILL.md" })).toBeVisible();
  await expect(card.locator(".diff-card-ranges")).toHaveText("Lines 7, 13");
  await expect(card.locator(".diff-count--removed")).toContainText("−2");
  await expect(card.locator(".diff-count--added")).toContainText("+1");
  const changes = card.getByRole("group", { name: "File changes" });
  const pierre = changes.locator("diffs-container");
  await expect(pierre.locator("[data-diff]")).toBeVisible();
  expect(await pierre.evaluate((element) => Boolean(element.shadowRoot))).toBe(
    true,
  );
  const removed = pierre.locator(
    '[data-line][data-line-type="change-deletion"]',
  );
  const added = pierre.locator('[data-line][data-line-type="change-addition"]');
  await expect(removed).toHaveText([
    /Read the issue report/,
    /Open the report/,
  ]);
  await expect(added).toHaveText([/Review the issue report/]);
  await expect(pierre.locator("[data-diff-span]")).toContainText([
    "Read",
    "Review",
  ]);
  const red = await backgroundChannels(removed.first());
  const green = await backgroundChannels(added.first());
  expect(red[3]).toBeGreaterThan(0);
  expect(red[0]).toBeGreaterThan(red[1]);
  expect(red[0]).toBeGreaterThan(red[2]);
  expect(green[3]).toBeGreaterThan(0);
  expect(green[1]).toBeGreaterThan(green[0]);
  expect(green[1]).toBeGreaterThan(green[2]);
  const heading = pierre.locator("[data-line]", {
    hasText: "# Issue follow-up",
  });
  await expect
    .poll(() =>
      heading
        .locator("span")
        .evaluateAll((tokens) =>
          tokens.map((token) => getComputedStyle(token).color),
        ),
    )
    .toContain("rgb(96, 165, 250)");
  await rail(page)
    .locator(".skill-file")
    .filter({ hasText: "scripts/candidates.sh" })
    .click();
  await expect(view.locator(".reader-state-title")).toHaveText("No changes");
  await rail(page)
    .locator(".skill-file")
    .filter({ hasText: "SKILL.md" })
    .click();
  await expect(card).toBeVisible();
  await compare.click();
  await expect(
    view.getByRole("article", { name: "Rendered Markdown" }),
  ).toBeVisible();
});

for (const key of ["Enter", "Space"] as const)
  test(`Pierre context controls reveal unchanged lines with ${key}`, async ({
    page,
  }) => {
    const before =
      Array.from({ length: 60 }, (_, index) => `Line ${index + 1}`).join("\n") +
      "\n";
    const after = before
      .replace("Line 18\n", "Changed line 18\n")
      .replace("Line 47\n", "Changed line 47\n");
    await skillFixture(page, { skillContent: after, previousContent: before });
    await rail(page)
      .getByRole("button", { name: "View changes", exact: true })
      .click();
    const pierre = detail(page).locator("diffs-container");
    const lines = pierre.locator("[data-line]");
    await expect(pierre.locator("[data-diff]")).toBeVisible();
    await expect(lines.filter({ hasText: /^Line 30\s*$/ })).toHaveCount(0);
    const countBefore = await lines.count();
    const expand = pierre.getByRole("button", { name: /Show 24.*lines/i });
    await expect(expand).toBeVisible();
    await expand.focus();
    await expect(expand).toBeFocused();
    await expand.press(key);
    await expect(lines.filter({ hasText: /^Line 30\s*$/ })).toBeVisible();
    expect(await lines.count()).toBeGreaterThan(countBefore);
    await expect(expand).toHaveCount(0);
  });

test("Pierre displays literal HTML source without creating executable elements", async ({
  page,
}) => {
  const imageSource =
    '<img src=x onerror="window.__diffSourceExecuted = true">';
  const scriptSource = "<script>window.__diffSourceExecuted = true</script>";
  await skillFixture(page, {
    previousContent: "# Literal source\n\nSafe text\n",
    skillContent: `# Literal source\n\n${imageSource}\n${scriptSource}\n`,
  });
  await rail(page)
    .getByRole("button", { name: "View changes", exact: true })
    .click();
  const pierre = detail(page).locator("diffs-container");
  const added = pierre.locator('[data-line][data-line-type="change-addition"]');
  await expect(added).toContainText([imageSource, scriptSource]);
  await expect(pierre.locator("script, img")).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as any).__diffSourceExecuted),
  ).toBeUndefined();
});

test("unsupported diff features keep the file and editor reachable", async ({
  page,
}) => {
  const adapterRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/src/components/pierre-diff.tsx"))
      adapterRequests.push(request.url());
  });
  await page.addInitScript(() => {
    const supports = CSS.supports.bind(CSS);
    CSS.supports = ((...args: string[]) =>
      args.some((argument) => argument.includes("light-dark("))
        ? false
        : Reflect.apply(supports, CSS, args)) as typeof CSS.supports;
  });
  await skillFixture(page);
  await rail(page)
    .getByRole("button", { name: "View changes", exact: true })
    .click();
  const card = detail(page).locator(".diff-card");
  await expect(
    card.getByRole("heading", { name: "SKILL.md", exact: true }),
  ).toBeVisible();
  await expect(card.locator(".diff-card-summary")).toHaveText(
    "Diff preview unavailable in this macOS webview. Use Open in editor to inspect the files.",
  );
  await expect(card.locator("diffs-container")).toHaveCount(0);
  // Unsupported WebViews must never parse the modern renderer's JS module.
  expect(adapterRequests).toEqual([]);
  await rail(page)
    .getByRole("button", { name: "Open in editor", exact: true })
    .click();
  expect(await calls(page, "open_editor")).toEqual([
    { id: "skill-a", file: "SKILL.md" },
  ]);
});

for (const [access, label, action, productionControls] of [
  ["read", "View only", null, false],
  ["publish", "Can edit", "Publish update", false],
  ["suggest", "Suggest changes", "Send for approval", false],
  ["read", "View only in production", null, true],
] as const)
  test(`review keyboard traversal includes real diff controls for ${label}`, async ({
    page,
  }) => {
    await skillFixture(page, {
      access,
      role: access === "publish" ? "owner" : "member",
      installation: "modified",
      draft: "local",
    });
    if (productionControls) {
      // Native production has no Agentation toolbar. This leaves Close as the
      // sole light-DOM button and reproduces Radix's shallow-traversal edge case.
      await page.addStyleTag({
        content: "[data-agentation-portal] { display: none !important; }",
      });
    }
    await rail(page)
      .getByRole("button", { name: "Review local edits", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Review local edits",
      exact: true,
    });
    const close = dialog.getByRole("button", {
      name: "Close review",
      exact: true,
    });
    await expect(dialog.locator(".diff-card-path")).toHaveText([
      "SKILL.md",
      "scripts/candidates.sh",
    ]);
    const controls = dialog.locator(
      'diffs-container [data-gutter] [data-expand-button][tabindex="0"]:visible',
    );
    await expect(controls.first()).toBeVisible();
    const count = await controls.count();
    expect(count).toBeGreaterThan(0);
    // Development builds place the feedback toolbar inside the active modal.
    // Include that real control when present; native production omits it.
    const feedback = dialog.getByRole("button", {
      name: "Start feedback mode",
      exact: true,
    });
    const hasFeedback = await feedback.isVisible();
    await expect(close).toBeFocused();
    // Use actual Tab events from the opening focus, never programmatic focus.
    for (let index = 0; index < count; index++) {
      await page.keyboard.press("Tab");
      await expect(controls.nth(index)).toBeFocused();
    }
    if (action) {
      await page.keyboard.press("Tab");
      await expect(
        dialog.getByRole("button", { name: action, exact: true }),
      ).toBeFocused();
    }
    if (hasFeedback) {
      await page.keyboard.press("Tab");
      await expect(feedback).toBeFocused();
    }
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    if (hasFeedback) {
      await expect(feedback).toBeFocused();
      await page.keyboard.press("Shift+Tab");
    }
    if (action) {
      await expect(
        dialog.getByRole("button", { name: action, exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Shift+Tab");
    }
    await expect(controls.last()).toBeFocused();
    for (let index = count - 2; index >= 0; index--) {
      await page.keyboard.press("Shift+Tab");
      await expect(controls.nth(index)).toBeFocused();
    }
    await page.keyboard.press("Shift+Tab");
    await expect(close).toBeFocused();
    const lines = dialog.locator("diffs-container [data-line]");
    const beforeExpansion = await lines.count();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect.poll(() => lines.count()).toBeGreaterThan(beforeExpansion);
    await expect(dialog).toBeVisible();
    expect(await governanceCalls(page, "submit-draft")).toEqual([]);
  });

for (const previous of ["missing", "equal"] as const) {
  test(`comparison reports a ${previous} previous version instead of a diff`, async ({
    page,
  }) => {
    await skillFixture(page, { previous });
    await rail(page)
      .getByRole("button", { name: "View changes", exact: true })
      .click();
    const state = detail(page).locator(".reader-state");
    if (previous === "missing") {
      await expect(state.locator(".reader-state-title")).toHaveText(
        "Previous version unavailable",
      );
      await expect(state).toContainText(
        "The previous version isn’t cached on this Mac.",
      );
      await expect(state.locator("img")).toHaveAttribute(
        "src",
        "/skill-states/previous-version-unavailable.png",
      );
    } else {
      await expect(state.locator(".reader-state-title")).toHaveText(
        "No changes",
      );
      await expect(state).toContainText(
        "This file matches its cached version.",
      );
      await expect(state.getByRole("button")).toHaveCount(0);
      await rail(page).getByRole("button", { name: "Show content" }).click();
      await expect(
        detail(page).getByRole("article", { name: "Rendered Markdown" }),
      ).toBeVisible();
    }
  });
}

test("read failures retry in place and offline reads explain the cache", async ({
  page,
}) => {
  await skillFixture(page, { inspectFailure: "until-recovered" });
  const view = detail(page);
  const failed = view.getByRole("alert");
  await expect(failed.locator(".reader-state-title")).toHaveText(
    "Couldn’t load SKILL.md",
  );
  await expect(view.locator(".skill-title")).toHaveText(
    "issue-investigate-followup",
  );
  await page.evaluate(() => {
    (window as any).inspectRecovered = true;
  });
  await failed.getByRole("button", { name: "Retry" }).click();
  await expect(
    view.getByRole("article", { name: "Rendered Markdown" }),
  ).toContainText("Issue follow-up");
  await rail(page)
    .getByRole("button", { name: "View changes", exact: true })
    .click();
  await expect(view.locator(".diff-card")).toBeVisible();
});

test("offline reads of uncached files explain the cache", async ({ page }) => {
  await skillFixture(page, { inspectFailure: "always", offline: true });
  const state = detail(page).locator(".reader-state");
  await expect(state.locator(".reader-state-title")).toHaveText(
    "File unavailable offline",
  );
  await expect(state).toContainText("Reconnect and sync to load this file.");
  await expect(state.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(
    rail(page).getByRole("button", { name: "Open in editor", exact: true }),
  ).toBeDisabled();
  await expect(
    rail(page).getByRole("button", { name: "View changes", exact: true }),
  ).toBeDisabled();
  // Other cached files still read.
  await rail(page)
    .locator(".skill-file")
    .filter({ hasText: "assets/platform-checks.csv" })
    .click();
  await expect(detail(page).locator(".source-plain")).toContainText(
    "platform,check,required",
  );
  await expect(
    rail(page).getByRole("button", { name: "Open in editor", exact: true }),
  ).toBeEnabled();
});

test("a missing SKILL.md keeps the other files reachable", async ({ page }) => {
  await skillFixture(page, {
    files: ["scripts/candidates.sh", "assets/platform-checks.csv"],
  });
  const view = detail(page);
  await expect(view.locator(".skill-title")).toHaveText(
    "issue-investigate-followup",
  );
  const state = view.locator(".reader-state");
  await expect(state.locator(".reader-state-title")).toHaveText(
    "SKILL.md is missing",
  );
  await expect(state).toContainText(
    "You can still open the other skill files.",
  );
  await expect(state.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(
    rail(page).getByRole("button", { name: "Open in editor", exact: true }),
  ).toBeDisabled();
  await expect(
    rail(page).getByRole("button", { name: "View changes", exact: true }),
  ).toBeDisabled();
  await expect(rail(page).locator(".skill-files-count")).toContainText("3");
  const missing = rail(page).getByRole("button", {
    name: "SKILL.md · Missing",
    exact: true,
  });
  await expect(missing).toHaveAttribute("aria-current", "true");
  await rail(page)
    .locator(".skill-file")
    .filter({ hasText: "scripts/candidates.sh" })
    .click();
  await expect(view.locator(".source-plain")).toContainText("gh pr list");
  await expect(
    rail(page).getByRole("button", { name: "Open in editor", exact: true }),
  ).toBeEnabled();
  await missing.click();
  await expect(state.locator(".reader-state-title")).toHaveText(
    "SKILL.md is missing",
  );
  await expect(
    rail(page).getByRole("button", { name: "Open in editor", exact: true }),
  ).toBeDisabled();
});

test("a listed file that cannot be found is marked missing and cannot open in editor", async ({
  page,
}) => {
  await skillFixture(page, { inspectFailure: "missing" });
  await expect(detail(page).locator(".reader-state-title")).toHaveText(
    "SKILL.md is missing",
  );
  await expect(
    rail(page).getByRole("button", { name: "SKILL.md · Missing", exact: true }),
  ).toHaveAttribute("aria-current", "true");
  await expect(
    rail(page).getByRole("button", { name: "Open in editor", exact: true }),
  ).toBeDisabled();
  await expect(
    rail(page).getByRole("button", { name: "View changes", exact: true }),
  ).toBeDisabled();
});

test("loading content keeps known metadata and disables content-dependent actions", async ({
  page,
}) => {
  await skillFixture(page, { open: false });
  await expect(page.locator(".skill-card-description")).toContainText(
    "Act on an issue-investigate report",
  );
  await page.evaluate(() => {
    (window as any).slowInspect = "SKILL.md";
  });
  await page.locator(".skill-card").first().click();
  const view = detail(page);
  await expect(view.locator(".skill-content-skeleton")).toBeVisible();
  await expect(view.locator(".skill-description")).toContainText(
    "Act on an issue-investigate report",
  );
  await expect(
    rail(page).getByRole("button", { name: "View changes", exact: true }),
  ).toBeDisabled();
  for (const name of ["Formatted", "Markdown"]) {
    await expect(
      view.getByRole("button", { name, exact: true }),
    ).toBeDisabled();
  }
  await expect(
    rail(page).getByRole("button", { name: "Open in editor", exact: true }),
  ).toBeEnabled();
  await page.evaluate(() => {
    (window as any).slowInspect = null;
    (window as any).finishInspect();
  });
  await expect(
    view.getByRole("article", { name: "Rendered Markdown" }),
  ).toBeVisible();
  await expect(
    rail(page).getByRole("button", { name: "View changes", exact: true }),
  ).toBeEnabled();
  await expect(
    view.getByRole("button", { name: "Markdown", exact: true }),
  ).toBeEnabled();
});

test("failed inspection preserves a summary already read in the collection", async ({
  page,
}) => {
  await skillFixture(page, { open: false });
  const summary = page.locator(".skill-card-description");
  await expect(summary).toContainText("Act on an issue-investigate report");
  const description = await summary.textContent();
  await page.evaluate(() => {
    (window as any).failInspect = "SKILL.md";
  });
  await page.locator(".skill-card").first().click();
  await expect(detail(page).locator(".reader-state-title")).toHaveText(
    "Couldn’t load SKILL.md",
  );
  await expect(detail(page).locator(".skill-description")).toHaveText(
    description!,
  );
});

test("a file that has never been read does not invent a description", async ({
  page,
}) => {
  await skillFixture(page, { inspectFailure: "always" });
  await expect(detail(page).locator(".reader-state-title")).toHaveText(
    "Couldn’t load SKILL.md",
  );
  await expect(detail(page).locator(".skill-description")).toHaveCount(0);
  await expect(detail(page).locator(".skill-title")).toHaveText(
    "issue-investigate-followup",
  );
});

test("first approval shows one pending pill and only local skill actions", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await skillFixture(page, {
    localFirstApproval: true,
    role: "member",
    access: "suggest",
  });
  const view = detail(page);
  const info = rail(page);
  await expect(view.locator(".skill-status")).toHaveText(["Awaiting approval"]);
  await expect(info.locator(".skill-facts dt")).toHaveText([
    "Updated by",
    "Updated at",
  ]);
  await expect(info.locator(".skill-info-note")).toHaveCount(0);
  await expect(info.locator(".resource-access-request")).toHaveCount(0);
  await expect(info.locator(".skill-actions").getByRole("button")).toHaveText([
    "Open in editor",
  ]);
  await expect(
    info.getByRole("button", { name: "More skill actions", exact: true }),
  ).toBeVisible();
  await expect(
    info.getByRole("button", {
      name: /View changes|Copy skill link|Export ZIP|Review changes/,
    }),
  ).toHaveCount(0);
  await info
    .getByRole("button", { name: "Open in editor", exact: true })
    .click();
  expect(await calls(page, "open_editor")).toEqual([
    { id: "skill-a", file: "SKILL.md" },
  ]);
});

test("metadata-only and invalid skill files fall back clearly", async ({
  page,
}) => {
  await skillFixture(page, {
    skillContent:
      "---\nname: Metadata only\ndescription: Nothing else yet.\n---\n",
  });
  const view = detail(page);
  await expect(view.locator(".skill-title")).toHaveText("Metadata only");
  await expect(view.locator(".reader-state-title")).toHaveText(
    "No skill instructions",
  );
  await expect(view.locator(".reader-state")).toContainText(
    "Only skill metadata is present.",
  );
});

test("invalid frontmatter shows the original file with a notice", async ({
  page,
}) => {
  const original =
    "---\nname: [unclosed\ndescription: broken\n---\n# Body\n\nText\n";
  await skillFixture(page, {
    skillContent: original,
  });
  const view = detail(page);
  await expect(view.locator(".skill-context")).toHaveText(
    "Couldn’t read skill metadata. Showing the original file.",
  );
  const source = view.getByRole("region", {
    name: "SKILL.md source",
    exact: true,
  });
  await expect(source).toBeVisible();
  expect(await source.locator("pre").textContent()).toBe(original);
  await expect(
    view.getByRole("button", { name: "Markdown", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    view.getByRole("button", { name: "Formatted", exact: true }),
  ).toBeDisabled();
});

test("a disconnected folder and editor failures stay recoverable", async ({
  page,
}) => {
  await skillFixture(page, { disconnected: true });
  await expect(detail(page).locator(".skill-context")).toHaveText([
    "Reconnect the project folder in Settings to open files in your editor.",
  ]);
  await expect(
    rail(page).getByRole("button", { name: "Open in editor", exact: true }),
  ).toBeDisabled();
});

test("editor failures surface a retryable toast", async ({ page }) => {
  await skillFixture(page, { editorFailure: true });
  await rail(page)
    .getByRole("button", { name: "Open in editor", exact: true })
    .click();
  await expect(page.locator("[data-orka-toast]")).toContainText(
    "Couldn’t open editor",
  );
  await page
    .locator("[data-orka-toast]")
    .getByRole("button", { name: "Try again" })
    .click();
  expect(await calls(page, "open_editor")).toHaveLength(2);
});

test("review entries follow bindings and drafts independently", async ({
  page,
}) => {
  await skillFixture(page, { installation: "update" });
  const info = rail(page);
  await expect(detail(page).locator(".skill-status")).toHaveText(
    "Review needed",
  );
  await expect(
    info.getByRole("button", { name: "Review local update", exact: true }),
  ).toBeVisible();
  await expect(
    info.getByRole("button", { name: "Review local edits", exact: true }),
  ).toHaveCount(0);
  await expect(info.locator(".skill-action-dot")).toHaveCount(0);
});

test("local drafts show the outgoing entry and pending drafts show their status", async ({
  page,
}) => {
  await skillFixture(page, { installation: "modified", draft: "local" });
  const info = rail(page);
  await expect(
    info.getByRole("button", { name: "Review local edits", exact: true }),
  ).toBeVisible();
  await expect(
    info.getByRole("button", { name: /Review local update/ }),
  ).toHaveCount(0);
  await expect(detail(page).locator(".skill-status")).toHaveCount(0);
});

test("pending suggestions hide the outgoing entry and announce approval", async ({
  page,
}) => {
  await skillFixture(page, {
    installation: "modified",
    draft: "proposed",
    access: "suggest",
    role: "member",
  });
  await expect(detail(page).locator(".skill-status")).toHaveText(
    "Awaiting approval",
  );
  await expect(
    rail(page).getByRole("button", { name: /Review local/ }),
  ).toHaveCount(0);
  await expect(
    detail(page).getByRole("button", {
      name: "Request editing access",
      exact: true,
    }),
  ).toHaveCount(0);
});

test("local edits that block an approved update show both entries and the blue dot", async ({
  page,
}) => {
  await skillFixture(page, { installation: "blocked", draft: "local" });
  const info = rail(page);
  const incoming = info.getByRole("button", { name: /^Review local update/ });
  await expect(incoming).toHaveAccessibleName(
    "Review local update. Local edits need install review",
  );
  await incoming.focus();
  await expect(page.locator(".skill-action-tooltip")).toHaveText(
    "Review local update",
  );
  await page.keyboard.press("Escape");
  await expect(info.locator(".skill-action-dot")).toHaveCount(1);
  await expect(
    info.getByRole("button", { name: "Review local edits", exact: true }),
  ).toBeVisible();
  await expect(detail(page).locator(".skill-status")).toHaveText(
    "Review needed",
  );
  await expect(info.locator(".skill-facts")).toContainText(
    "3 shared · 2 on this Mac",
  );
  const box = await incoming.boundingBox();
  expect(box?.width).toBe(32);
  expect(box?.height).toBe(32);
});

test("suggesting changes sends the exact reviewed draft for approval", async ({
  page,
}) => {
  await skillFixture(page, {
    access: "suggest",
    role: "member",
    installation: "modified",
    draft: "local",
  });
  await rail(page)
    .getByRole("button", { name: "Review local edits", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Review local edits",
    exact: true,
  });
  await expect(dialog.locator(".review-versions .version-pill")).toHaveText([
    "Version 3",
    "This Mac",
  ]);
  await expect(
    dialog.locator(".access-pill:not([skullet-covered])", {
      hasText: "Suggest changes",
    }),
  ).toBeVisible();
  const cards = dialog.locator(".diff-card");
  await expect(cards.locator(".diff-card-path")).toHaveText([
    "SKILL.md",
    "scripts/candidates.sh",
  ]);
  await expect(cards.first().locator(".diff-card-ranges")).toHaveText(
    "Lines 7, 13",
  );
  await expect(cards.nth(1).locator(".diff-card-ranges")).toHaveText("Line 8");
  await expect(
    dialog.getByRole("button", { name: "Publish update" }),
  ).toHaveCount(0);
  const reviewedFiles = await page.evaluate(
    async () =>
      (await (window as any).__TAURI_INTERNALS__.invoke("snapshot")).drafts[0]
        .resource.files,
  );
  await dialog
    .getByRole("button", { name: "Send for approval", exact: true })
    .click();
  expect(await governanceCalls(page, "submit-draft")).toEqual([
    { projectId: "one", id: "draft-1", reviewedFiles, reviewedRevision: 3 },
  ]);
  await expect(dialog).toHaveCount(0);
  await expect(toast(page)).toHaveText("Suggestion sent for review");
  await expect(detail(page).locator(".skill-status")).toHaveText(
    "Awaiting approval",
  );
  await expect(
    rail(page).getByRole("button", { name: "Review local edits", exact: true }),
  ).toHaveCount(0);
  await expect(
    rail(page).getByRole("button", { name: "Open in editor", exact: true }),
  ).toBeFocused();
});

test("a failed submission keeps the draft and diff and offers Try again", async ({
  page,
}) => {
  await skillFixture(page, {
    access: "suggest",
    role: "member",
    installation: "modified",
    draft: "local",
    submitFailure: "once",
  });
  await rail(page)
    .getByRole("button", { name: "Review local edits", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Review local edits",
    exact: true,
  });
  await dialog
    .getByRole("button", { name: "Send for approval", exact: true })
    .click();
  await expect(dialog.locator(".review-footer-note")).toHaveText(
    "Couldn’t send suggestion",
  );
  await expect(dialog.locator(".diff-card")).toHaveCount(2);
  // The narrow control sits under the development annotation button; activate it by keyboard.
  await dialog.getByRole("button", { name: "Try again", exact: true }).focus();
  await page.keyboard.press("Enter");
  expect(await governanceCalls(page, "submit-draft")).toHaveLength(2);
  await expect(dialog).toHaveCount(0);
});

test("view-only members can read local edits without a submit action", async ({
  page,
}) => {
  await skillFixture(page, {
    access: "read",
    role: "member",
    installation: "modified",
    draft: "local",
  });
  await rail(page)
    .getByRole("button", { name: "Review local edits", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Review local edits",
    exact: true,
  });
  await expect(
    dialog.locator(".access-pill:not([skullet-covered])"),
  ).toHaveText(/View only/);
  await expect(dialog.locator(".diff-card")).toHaveCount(2);
  await expect(
    dialog.getByRole("button", {
      name: /Send for approval|Try again|Review latest|Publish/,
    }),
  ).toHaveCount(0);
  await expect(dialog.locator(".review-footer")).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Close review", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(
    rail(page).getByRole("button", { name: "Review local edits", exact: true }),
  ).toBeFocused();
});

test("can-edit members queue the reviewed draft for publishing without claiming completion", async ({
  page,
}) => {
  await skillFixture(page, {
    access: "publish",
    installation: "modified",
    draft: "local",
  });
  await rail(page)
    .getByRole("button", { name: "Review local edits", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Review local edits",
    exact: true,
  });
  await expect(
    dialog.locator(".access-pill:not([skullet-covered])", {
      hasText: "Can edit",
    }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Publish update", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Send for approval" }),
  ).toHaveCount(0);
  const reviewedFiles = await page.evaluate(
    async () =>
      (await (window as any).__TAURI_INTERNALS__.invoke("snapshot")).drafts[0]
        .resource.files,
  );
  await dialog
    .getByRole("button", { name: "Publish update", exact: true })
    .click();
  expect(await governanceCalls(page, "submit-draft")).toEqual([
    {
      projectId: "one",
      id: "draft-1",
      reviewedFiles,
      reviewedRevision: 3,
      publishIfAllowed: true,
    },
  ]);
  await expect(dialog).toHaveCount(0);
  await expect(toast(page)).toHaveText("Update queued for publishing");
  await expect(toast(page)).not.toHaveText(/published/i);
});

for (const access of ["publish", "suggest"] as const) {
  test(`a changed outgoing draft requires a new review before ${access}`, async ({
    page,
  }) => {
    await skillFixture(page, {
      access,
      role: "member",
      installation: "modified",
      draft: "local",
    });
    await rail(page)
      .getByRole("button", { name: "Review local edits", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Review local edits",
      exact: true,
    });
    const action =
      access === "publish" ? "Publish update" : "Send for approval";
    await expect(
      dialog.getByRole("button", { name: action, exact: true }),
    ).toBeVisible();
    const freshFiles = await page.evaluate(async () => {
      const native = (window as any).__TAURI_INTERNALS__;
      const invoke = native.invoke;
      const updateDraft = (draft: any) => ({
        ...draft,
        resource: {
          ...draft.resource,
          files: draft.resource.files.map((file: any) =>
            file.path === "SKILL.md"
              ? { ...file, hash: "draft-edited-after-preview" }
              : file,
          ),
        },
      });
      const current = await invoke("snapshot");
      native.invoke = async (name: string, args: any) => {
        const result = await invoke(name, args);
        if (name === "snapshot")
          return { ...result, drafts: result.drafts.map(updateDraft) };
        if (name === "governance_command" && args?.action === "draft") {
          const draft = updateDraft(result.draft);
          return {
            ...result,
            draft,
            manifest: draft.resource.files,
            files: {
              ...result.files,
              "SKILL.md":
                result.files["SKILL.md"] +
                "\n- Added after the first review.\n",
            },
          };
        }
        return result;
      };
      return updateDraft(current.drafts[0]).resource.files;
    });
    await expect(
      dialog.getByRole("button", { name: "Review latest", exact: true }),
    ).toBeVisible({ timeout: 5000 });
    await expect(
      dialog.getByRole("button", { name: action, exact: true }),
    ).toHaveCount(0);
    expect(await governanceCalls(page, "submit-draft")).toHaveLength(0);
    expect(await governanceCalls(page, "draft")).toHaveLength(1);
    await dialog
      .getByRole("button", { name: "Review latest", exact: true })
      .click();
    await expect(
      dialog.getByText("Added after the first review.", { exact: false }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: action, exact: true }).click();
    expect(await governanceCalls(page, "submit-draft")).toEqual([
      {
        projectId: "one",
        id: "draft-1",
        reviewedFiles: freshFiles,
        reviewedRevision: 3,
        ...(access === "publish" ? { publishIfAllowed: true } : {}),
      },
    ]);
    await expect(dialog).toHaveCount(0);
  });
}

test("a native outgoing review guard failure returns to Review latest", async ({
  page,
}) => {
  await skillFixture(page, {
    access: "publish",
    installation: "modified",
    draft: "local",
  });
  await rail(page)
    .getByRole("button", { name: "Review local edits", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Review local edits",
    exact: true,
  });
  await page.evaluate(() => {
    const native = (window as any).__TAURI_INTERNALS__;
    const invoke = native.invoke;
    native.invoke = async (name: string, args: any) => {
      if (name === "governance_command" && args?.action === "submit-draft")
        throw new Error(
          "Local or shared files changed; review the update again",
        );
      return invoke(name, args);
    };
  });
  await dialog
    .getByRole("button", { name: "Publish update", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Review latest", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Publish update", exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByText("Files changed since this preview."),
  ).toBeVisible();
  expect(await governanceCalls(page, "refresh-draft")).toHaveLength(0);
  await dialog
    .getByRole("button", { name: "Review latest", exact: true })
    .click();
  expect(await governanceCalls(page, "refresh-draft")).toEqual([
    { projectId: "one", id: "draft-1" },
  ]);
  await expect(
    dialog.getByRole("button", { name: "Publish update", exact: true }),
  ).toBeVisible();
});

test("reviewing an incoming update installs it with the reviewed token", async ({
  page,
}) => {
  await skillFixture(page, { installation: "blocked", draft: "local" });
  await rail(page)
    .getByRole("button", { name: /^Review local update/ })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Review local update",
    exact: true,
  });
  await expect(dialog.locator(".review-versions .version-pill")).toHaveText([
    "This Mac",
    "Version 3",
  ]);
  await expect(
    dialog.getByRole("button", { name: "Keep edits and install", exact: true }),
  ).toHaveAccessibleDescription(
    "Your local edits will be saved privately on this Mac before installation.",
  );
  await expect(dialog.locator(".diff-card .diff-card-path")).toHaveText([
    "SKILL.md",
    "scripts/candidates.sh",
  ]);
  await expect(
    dialog.getByRole("group", { name: "File changes" }).first(),
  ).toContainText("confirm the root cause");
  expect(await governanceCalls(page, "preview-install")).toEqual([
    { projectId: "one", resourceId: "skill-a" },
  ]);
  await dialog
    .getByRole("button", { name: "Keep edits and install", exact: true })
    .click();
  expect(await governanceCalls(page, "apply-install")).toMatchObject([
    {
      projectId: "one",
      resourceId: "skill-a",
      token: "preview-token-0",
      preserveLocal: true,
    },
  ]);
  await expect(dialog).toHaveCount(0);
  await expect(toast(page)).toHaveText("Reviewed update installed");
});

test("a stale preview asks for a fresh review before installing", async ({
  page,
}) => {
  await skillFixture(page, { installation: "update", applyFailure: "stale" });
  await rail(page)
    .getByRole("button", { name: "Review local update", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Review local update",
    exact: true,
  });
  await dialog
    .getByRole("button", { name: "Install update", exact: true })
    .click();
  await expect(
    dialog
      .getByRole("status")
      .filter({ hasText: "Files changed since this preview." }),
  ).toHaveText("Files changed since this preview.");
  await expect(
    dialog.getByRole("button", { name: "Install update" }),
  ).toHaveCount(0);
  await dialog
    .getByRole("button", { name: "Review latest", exact: true })
    .click();
  expect(await governanceCalls(page, "preview-install")).toHaveLength(2);
  await expect(
    dialog.getByRole("button", { name: "Install update", exact: true }),
  ).toBeVisible();
});

test("review latest accepts a fresh binding snapshot at the same revision", async ({
  page,
}) => {
  await skillFixture(page, { installation: "update" });
  await rail(page)
    .getByRole("button", { name: "Review local update", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Review local update",
    exact: true,
  });
  await expect(
    dialog.getByRole("button", { name: "Install update", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    const native = (window as any).__TAURI_INTERNALS__;
    const invoke = native.invoke;
    native.invoke = async (name: string, args: unknown) => {
      const result = await invoke(name, args);
      if (name !== "snapshot") return result;
      return {
        ...result,
        bindings: result.bindings.map((binding: object) => ({
          ...binding,
          guards: ["local-files-changed"],
        })),
      };
    };
  });
  // The workspace's normal poll supplies the updated binding without changing
  // the shared resource revision or reopening the existing review.
  await expect(
    dialog.getByRole("button", { name: "Review latest", exact: true }),
  ).toBeVisible({ timeout: 5000 });
  expect(await governanceCalls(page, "preview-install")).toHaveLength(1);
  await dialog
    .getByRole("button", { name: "Review latest", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Install update", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText("Files changed since this preview."),
  ).toHaveCount(0);
  expect(await governanceCalls(page, "preview-install")).toHaveLength(2);
});

test("a binary-only incoming update remains installable and omits unchanged binaries", async ({
  page,
}) => {
  await skillFixture(page, { installation: "update" });
  await page.evaluate(() => {
    const native = (window as any).__TAURI_INTERNALS__;
    const invoke = native.invoke;
    native.invoke = async (name: string, args: any) => {
      const result = await invoke(name, args);
      if (name !== "governance_command" || args?.action !== "preview-install")
        return result;
      return {
        ...result,
        before: {
          "review.pdf": "Binary asset",
          "unchanged.pdf": "Binary asset",
        },
        after: {
          "review.pdf": "Binary asset",
          "unchanged.pdf": "Binary asset",
        },
        beforeManifest: [
          { path: "review.pdf", hash: "old", binary: true },
          { path: "unchanged.pdf", hash: "same", binary: true },
        ],
        afterManifest: [
          { path: "review.pdf", hash: "new", binary: true },
          { path: "unchanged.pdf", hash: "same", binary: true },
        ],
        copies: undefined,
      };
    };
  });
  await rail(page)
    .getByRole("button", { name: "Review local update", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Review local update",
    exact: true,
  });
  await expect(dialog.locator(".diff-card-path")).toHaveText(["review.pdf"]);
  await expect(dialog.locator(".diff-card-summary")).toHaveText(
    "No text preview for this file.",
  );
  await expect(
    dialog.locator(
      ".diff-card-ranges, .diff-lines, diffs-container, .diff-count--added, .diff-count--removed",
    ),
  ).toHaveCount(0);
  await expect(dialog.getByText("Up to date", { exact: true })).toHaveCount(0);
  await dialog
    .getByRole("button", { name: "Install update", exact: true })
    .click();
  expect(await governanceCalls(page, "apply-install")).toMatchObject([
    { token: "preview-token-0", preserveLocal: true },
  ]);
  await expect(dialog).toHaveCount(0);
});

test("preview failures retry and matching versions report up to date", async ({
  page,
}) => {
  await skillFixture(page, { installation: "update", previewFailure: "once" });
  await rail(page)
    .getByRole("button", { name: "Review local update", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Review local update",
    exact: true,
  });
  await expect(
    dialog.getByRole("alert").locator(".reader-state-title"),
  ).toHaveText("Preview unavailable");
  await expect(
    dialog.getByRole("button", { name: "Install update" }),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(dialog.locator(".diff-card")).toHaveCount(1);
});

test("an up-to-date preview needs no install action", async ({ page }) => {
  await skillFixture(page, { installation: "uptodate" });
  await rail(page)
    .getByRole("button", { name: "Review local update", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Review local update",
    exact: true,
  });
  await expect(dialog.locator(".reader-state-title")).toHaveText("Up to date");
  await expect(dialog).toContainText("This Mac has the approved version.");
  await expect(dialog.locator(".review-footer")).toHaveCount(0);
});

for (const primary of ["approved", "older", "missing"] as const) {
  test(`incoming review includes a divergent second copy when the first is ${primary}`, async ({
    page,
  }) => {
    const approved = { "SKILL.md": "Approved instructions\n" };
    const manifest = [{ path: "SKILL.md", hash: "approved", binary: false }];
    const first: Record<string, string> =
      primary === "missing"
        ? {}
        : {
            "SKILL.md":
              primary === "approved"
                ? approved["SKILL.md"]
                : "Older instructions\n",
          };
    const firstManifest =
      primary === "missing" ? [] : [{ ...manifest[0], hash: primary }];
    const second = { "SKILL.md": "Private Claude instructions\n" };
    await skillFixture(page, {
      installation: "blocked",
      preview: {
        dirty: true,
        before: primary === "missing" ? second : first,
        after: approved,
        beforeManifest:
          primary === "missing"
            ? [{ ...manifest[0], hash: "private" }]
            : firstManifest,
        afterManifest: manifest,
        copies: [
          {
            path: "/test/orka/.agents/skills/example",
            files: first,
            manifest: firstManifest,
          },
          {
            path: "/test/orka/.claude/skills/example",
            files: second,
            manifest: [{ ...manifest[0], hash: "private" }],
          },
        ],
      },
    });
    await rail(page)
      .getByRole("button", { name: /^Review local update/ })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Review local update",
      exact: true,
    });
    await expect(dialog.getByText("Up to date", { exact: true })).toHaveCount(
      0,
    );
    await expect(
      dialog.getByText("Local copy: /test/orka/.claude/skills/example", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("group", { name: "File changes" }).last(),
    ).toContainText("Private Claude instructions");
    await expect(dialog.locator(".diff-card-path")).toHaveCount(
      primary === "approved" ? 1 : 2,
    );
    await dialog
      .getByRole("button", { name: "Keep edits and install", exact: true })
      .click();
    expect(await governanceCalls(page, "apply-install")).toMatchObject([
      { token: "preview-token-0", preserveLocal: true },
    ]);
    await expect(dialog).toHaveCount(0);
  });
}

for (const access of ["publish", "suggest"] as const) {
  test(`an executable-only local edit can ${access}`, async ({ page }) => {
    await skillFixture(page, {
      access,
      installation: "modified",
      draft: "local",
      files: ["SKILL.md", "scripts/candidates.sh"],
    });
    await page.evaluate(() => {
      const native = (
        window as unknown as { __TAURI_INTERNALS__: NativeFixture }
      ).__TAURI_INTERNALS__;
      const invoke = native.invoke;
      native.invoke = async (name, args) => {
        const result = await invoke(name, args);
        if (name !== "governance_command" || args?.action !== "draft")
          return result;
        const detail = result as { draft: LocalDraft };
        const files: Record<string, string> = {};
        const manifest = [];
        for (const path of ["SKILL.md", "scripts/candidates.sh"]) {
          files[path] = (
            (await invoke("inspect_resource", {
              id: "skill-a",
              file: path,
              conflictId: null,
            })) as Inspection
          ).content!;
          manifest.push({
            path,
            hash: `hash-${path}`,
            size: 10,
            executable: path.endsWith(".sh"),
            binary: false,
          });
        }
        return {
          files,
          manifest,
          draft: {
            ...detail.draft,
            resource: { ...detail.draft.resource, files: manifest },
          },
        };
      };
    });
    await rail(page)
      .getByRole("button", { name: "Review local edits", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Review local edits",
      exact: true,
    });
    await expect(
      dialog.getByText("Executable permission added.", { exact: true }),
    ).toBeVisible();
    await expect(dialog.locator(".diff-card-path")).toHaveText([
      "scripts/candidates.sh",
    ]);
    await expect(
      dialog.locator(".diff-count--added, .diff-count--removed, .diff-lines"),
    ).toHaveCount(0);
    await dialog
      .getByRole("button", {
        name: access === "publish" ? "Publish update" : "Send for approval",
        exact: true,
      })
      .click();
    expect(await governanceCalls(page, "submit-draft")).toMatchObject([
      {
        id: "draft-1",
        reviewedFiles: expect.arrayContaining([
          expect.objectContaining({
            path: "scripts/candidates.sh",
            executable: true,
          }),
        ]),
      },
    ]);
    await expect(dialog).toHaveCount(0);
  });
}

test("a newer capture invalidates an open review and becomes the reviewed submission", async ({
  page,
}) => {
  await skillFixture(page, { installation: "modified", draft: "local" });
  await rail(page)
    .getByRole("button", { name: "Review local edits", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Review local edits",
    exact: true,
  });
  await expect(
    dialog.getByRole("button", { name: "Publish update", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    const native = (window as unknown as { __TAURI_INTERNALS__: NativeFixture })
      .__TAURI_INTERNALS__;
    const invoke = native.invoke;
    const newer = (older: LocalDraft): LocalDraft => ({
      ...older,
      id: "newest-capture",
      createdAt: "2026-10-27T09:00:00Z",
      resource: {
        ...older.resource,
        files: older.resource.files.map((file) => ({
          ...file,
          hash: `newest-${file.path}`,
        })),
      },
    });
    native.invoke = async (name, args) => {
      const result = await invoke(name, args);
      if (name === "snapshot") {
        const snapshot = result as Snapshot;
        return {
          ...snapshot,
          drafts: [...snapshot.drafts!, newer(snapshot.drafts![0])],
        };
      }
      if (name === "governance_command" && args?.action === "draft") {
        const detail = result as {
          draft: LocalDraft;
          files: Record<string, string>;
        };
        const draft = newer(detail.draft);
        return {
          ...detail,
          draft,
          manifest: draft.resource.files,
          files: {
            ...detail.files,
            "SKILL.md":
              detail.files["SKILL.md"] + "\n- Latest capture instructions.\n",
          },
        };
      }
      return result;
    };
  });
  await expect(
    dialog.getByRole("button", { name: "Review latest", exact: true }),
  ).toBeVisible({ timeout: 5000 });
  expect(await governanceCalls(page, "submit-draft")).toHaveLength(0);
  await dialog
    .getByRole("button", { name: "Review latest", exact: true })
    .click();
  await expect(
    dialog.getByRole("group", { name: "File changes" }).first(),
  ).toContainText("Latest capture instructions.");
  expect((await governanceCalls(page, "draft")).at(-1)).toMatchObject({
    id: "newest-capture",
  });
  await dialog
    .getByRole("button", { name: "Publish update", exact: true })
    .click();
  expect(await governanceCalls(page, "submit-draft")).toMatchObject([
    {
      id: "newest-capture",
      reviewedFiles: expect.arrayContaining([
        expect.objectContaining({ hash: "newest-SKILL.md" }),
      ]),
    },
  ]);
  await expect(dialog).toHaveCount(0);
});

test("compact windows fold the rail into the reader and keep the drawer usable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 640 });
  await skillFixture(page, { installation: "blocked", draft: "local" });
  const view = detail(page);
  await expect(view).toHaveAttribute("data-layout", "compact");
  await expect(view.locator(".skill-rail")).toHaveCount(0);
  await expect(view.locator(".skill-meta")).toContainText(
    /Updated by You · .* · Version 3/,
  );
  await expect(
    view.getByRole("button", { name: "Show more", exact: true }),
  ).toBeVisible();
  await view.getByRole("button", { name: "Show more", exact: true }).click();
  await expect(
    view.getByRole("button", { name: "Show less", exact: true }),
  ).toBeVisible();
  await view.getByRole("button", { name: "Files, 4" }).click();
  const menu = page.getByRole("dialog", { name: "Files", exact: true });
  await expect(menu.locator(".skill-file")).toHaveCount(4);
  await menu
    .locator(".skill-file")
    .filter({ hasText: "scripts/candidates.sh" })
    .click();
  await expect(menu).toHaveCount(0);
  await expect(view.locator(".source-plain")).toContainText("gh pr list");
  await page.screenshot({ path: "artifacts/skill-detail-900.png" });
  await view.getByRole("button", { name: /^Review local update/ }).click();
  const dialog = page.getByRole("dialog", {
    name: "Review local update",
    exact: true,
  });
  const box = await dialog.boundingBox();
  expect(box?.width).toBe(640);
  await expect(
    dialog.getByRole("button", { name: "Keep edits and install", exact: true }),
  ).toBeInViewport();
  await expect(dialog.locator(".review-heading h2")).toBeInViewport();
  await page.screenshot({ path: "artifacts/skill-review-900.png" });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(
    view.getByRole("button", { name: /^Review local update/ }),
  ).toBeFocused();
  await expect(view.locator(".source-plain")).toContainText("gh pr list");
});
