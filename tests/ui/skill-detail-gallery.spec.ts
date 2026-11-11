import { test, expect, type Page } from "@playwright/test";
import {
  detail,
  rail,
  skillFixture,
  type SkillFixtureOptions,
} from "./fixtures/skill-detail.js";

// Review gallery: one screenshot per linked Figma state, in the order of the
// handoff boards. Assertions keep each capture honest about what is on screen.
const shots = ".scratch/skills-detail-redesign/screenshots";
const shot = (page: Page, name: string) =>
  page.screenshot({ path: `${shots}/${name}.png` });
const wide = { width: 1440, height: 900 };
const compact = { width: 900, height: 640 };

async function open(
  page: Page,
  viewport: { width: number; height: number },
  options: SkillFixtureOptions = {},
) {
  await page.setViewportSize(viewport);
  await skillFixture(page, options);
  return detail(page);
}

test("reader and file previews", async ({ page }) => {
  const view = await open(page, wide);
  await expect(
    view.getByRole("article", { name: "Rendered Markdown" }),
  ).toBeVisible();
  await shot(page, "01-reader-formatted");
  await view.getByRole("button", { name: "Markdown", exact: true }).click();
  await expect(
    view.getByRole("group", { name: "Markdown source" }),
  ).toBeVisible();
  await shot(page, "02-reader-raw-markdown");
  const files = rail(page).locator(".skill-file");
  await files.filter({ hasText: "scripts/candidates.sh" }).click();
  await expect(view.locator(".source-card-type")).toHaveText("Shell script");
  await shot(page, "03-reader-script");
  await files.filter({ hasText: "assets/platform-checks.csv" }).click();
  await expect(view.locator(".source-card-type")).toHaveText("CSV");
  await shot(page, "04-reader-csv");
  await files.filter({ hasText: "references/review-checklist.pdf" }).click();
  await expect(
    view.getByText("Use Open in editor to view this PDF."),
  ).toBeVisible();
  await shot(page, "05-reader-pdf");
  await files.filter({ hasText: "SKILL.md" }).click();
  // Reader mode resets with the file; the formatted view returns.
  await expect(
    view.getByRole("article", { name: "Rendered Markdown" }),
  ).toBeVisible();
});

test("file loading skeleton", async ({ page }) => {
  const view = await open(page, wide);
  await page.evaluate(() => {
    (window as any).slowInspect = "scripts/candidates.sh";
  });
  await rail(page)
    .locator(".skill-file")
    .filter({ hasText: "scripts/candidates.sh" })
    .click();
  await expect(
    view.getByRole("status").filter({ hasText: "Loading content…" }),
  ).toHaveCount(1);
  await page.waitForTimeout(400);
  await shot(page, "06-file-loading");
});

test("comparison states", async ({ page }) => {
  const view = await open(page, wide);
  await rail(page).locator(".skill-compare").click();
  await expect(view.locator(".diff-card")).toBeVisible();
  await shot(page, "07-compare-diff");
});

test("comparison without changes", async ({ page }) => {
  const view = await open(page, wide, { previous: "equal" });
  await rail(page).locator(".skill-compare").click();
  await expect(view.locator(".reader-state-title")).toHaveText("No changes");
  await shot(page, "08-compare-no-changes");
});

test("comparison without a cached previous version", async ({ page }) => {
  const view = await open(page, wide, { previous: "missing" });
  await rail(page).locator(".skill-compare").click();
  await expect(view.locator(".reader-state-title")).toHaveText(
    "Previous version unavailable",
  );
  await shot(page, "09-compare-previous-unavailable");
});

test("read failed", async ({ page }) => {
  const view = await open(page, wide, { inspectFailure: "always" });
  await expect(view.locator(".reader-state-title")).toHaveText(
    "Couldn’t load SKILL.md",
  );
  await shot(page, "10-file-read-failed");
});

test("offline and uncached", async ({ page }) => {
  const view = await open(page, wide, {
    inspectFailure: "always",
    offline: true,
  });
  await expect(view.locator(".reader-state-title")).toHaveText(
    "File unavailable offline",
  );
  await shot(page, "11-offline-uncached");
});

test("SKILL.md missing", async ({ page }) => {
  const view = await open(page, wide, {
    files: ["scripts/candidates.sh", "assets/platform-checks.csv"],
  });
  await expect(view.locator(".reader-state-title")).toHaveText(
    "SKILL.md is missing",
  );
  await shot(page, "12-skill-md-missing");
});

test("empty Markdown body", async ({ page }) => {
  const view = await open(page, wide, {
    skillContent:
      "---\nname: issue-investigate-followup\ndescription: Only metadata so far.\n---\n",
  });
  await expect(view.locator(".reader-state-title")).toHaveText(
    "No skill instructions",
  );
  await shot(page, "13-empty-markdown-body");
});

test("invalid metadata", async ({ page }) => {
  const view = await open(page, wide, {
    skillContent:
      "---\nname: [unclosed\ndescription: broken\n---\n# Issue follow-up\n\n- Review the issue report.\n",
  });
  await expect(view.locator(".skill-context")).toBeVisible();
  await shot(page, "14-invalid-metadata");
});

test("folder disconnected", async ({ page }) => {
  const view = await open(page, wide, { disconnected: true });
  await expect(view.locator(".skill-context")).toBeVisible();
  await shot(page, "15-folder-disconnected");
});

test("editor failure toast", async ({ page }) => {
  await open(page, wide, { editorFailure: true });
  await rail(page)
    .getByRole("button", { name: "Open in editor", exact: true })
    .click();
  await expect(page.locator("[data-orka-toast]")).toContainText(
    "Couldn’t open editor",
  );
  await shot(page, "16-editor-failure-toast");
});

test("both review entries with the blue dot", async ({ page }) => {
  await open(page, wide, { installation: "blocked", draft: "local" });
  await expect(rail(page).locator(".skill-action-dot")).toHaveCount(1);
  await shot(page, "17-both-actions-blue-dot");
});

test("outgoing entry only", async ({ page }) => {
  await open(page, wide, { installation: "modified", draft: "local" });
  await expect(
    rail(page).getByRole("button", { name: "Review local edits", exact: true }),
  ).toBeVisible();
  await shot(page, "17a-outgoing-entry-only");
});

test("outgoing review as suggest changes", async ({ page }) => {
  await open(page, wide, {
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
  await expect(dialog.locator(".diff-card")).toHaveCount(2);
  await shot(page, "18-outgoing-suggest-changes");
  await dialog
    .getByRole("button", { name: "Send for approval", exact: true })
    .click();
  await expect(detail(page).locator(".skill-status")).toHaveText(
    "Awaiting approval",
  );
  await shot(page, "19-suggestion-pending");
});

test("outgoing review failure", async ({ page }) => {
  await open(page, wide, {
    access: "suggest",
    role: "member",
    installation: "modified",
    draft: "local",
    submitFailure: "always",
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
  await shot(page, "20-suggestion-failed");
});

test("outgoing review as view only", async ({ page }) => {
  await open(page, wide, {
    access: "read",
    role: "member",
    installation: "modified",
    draft: "local",
  });
  await rail(page)
    .getByRole("button", { name: "Review local edits", exact: true })
    .click();
  await expect(
    page
      .getByRole("dialog", { name: "Review local edits", exact: true })
      .locator(".access-pill:not([skullet-covered])", { hasText: "View only" }),
  ).toBeVisible();
  await shot(page, "21-outgoing-view-only");
});

test("outgoing review as can edit", async ({ page }) => {
  await open(page, wide, {
    access: "publish",
    installation: "modified",
    draft: "local",
  });
  await rail(page)
    .getByRole("button", { name: "Review local edits", exact: true })
    .click();
  await expect(
    page
      .getByRole("dialog", { name: "Review local edits", exact: true })
      .locator(".access-pill:not([skullet-covered])"),
  ).toHaveText(/Can edit/);
  await shot(page, "22-outgoing-can-edit");
});

test("incoming review with one changed file", async ({ page }) => {
  await open(page, wide, { installation: "update" });
  await rail(page)
    .getByRole("button", { name: "Review local update", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Review local update",
    exact: true,
  });
  await expect(dialog.locator(".diff-card")).toHaveCount(1);
  await shot(page, "23-incoming-one-file");
});

test("incoming review with multiple changed files", async ({ page }) => {
  await open(page, wide, {
    installation: "blocked",
    draft: "local",
    applyHold: true,
  });
  await rail(page)
    .getByRole("button", { name: /^Review local update/ })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Review local update",
    exact: true,
  });
  await expect(dialog.locator(".diff-card")).toHaveCount(2);
  await shot(page, "24-incoming-multiple-files");
  await dialog
    .getByRole("button", { name: "Keep edits and install", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toHaveText("Installing…");
  await shot(page, "25-installing");
  await page.evaluate(() => (window as any).finishApply());
  await expect(dialog).toHaveCount(0);
});

test("incoming review with a stale preview", async ({ page }) => {
  await open(page, wide, { installation: "update", applyFailure: "stale" });
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
  await expect(dialog.getByRole("status")).toHaveText(
    "Files changed since this preview.",
  );
  await shot(page, "26-incoming-stale");
});

test("incoming preview unavailable", async ({ page }) => {
  await open(page, wide, { installation: "update", previewFailure: "once" });
  await rail(page)
    .getByRole("button", { name: "Review local update", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Review local update",
    exact: true,
  });
  await expect(dialog.locator(".reader-state-title")).toHaveText(
    "Preview unavailable",
  );
  await shot(page, "27-incoming-preview-unavailable");
});

test("incoming up to date", async ({ page }) => {
  await open(page, wide, { installation: "uptodate" });
  await rail(page)
    .getByRole("button", { name: "Review local update", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Review local update",
    exact: true,
  });
  await expect(dialog.locator(".reader-state-title")).toHaveText("Up to date");
  await shot(page, "28-incoming-up-to-date");
});

test("approved removal", async ({ page }) => {
  // Removed skills leave the index; Requests keeps the review reachable.
  await open(page, wide, { installation: "removal", open: false });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Members", exact: true }).click();
  await page.getByRole("button", { name: /Review pending requests/ }).click();
  await page
    .getByRole("button", { name: "Review update", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Review skill removal",
    exact: true,
  });
  await expect(dialog.locator(".diff-card-removed")).toHaveCount(4);
  await shot(page, "29-approved-removal");
});

test("compact reader and review", async ({ page }) => {
  const view = await open(page, compact, {
    installation: "blocked",
    draft: "local",
  });
  await expect(view).toHaveAttribute("data-layout", "compact");
  await shot(page, "30-compact-reader");
  await view.getByRole("button", { name: "Files, 4" }).click();
  await expect(
    page.getByRole("dialog", { name: "Files", exact: true }),
  ).toBeVisible();
  await shot(page, "31-compact-files-menu");
  await page.keyboard.press("Escape");
  await view.getByRole("button", { name: /^Review local update/ }).click();
  await expect(
    page
      .getByRole("dialog", { name: "Review local update", exact: true })
      .locator(".diff-card"),
  ).toHaveCount(2);
  await shot(page, "32-compact-review");
});
