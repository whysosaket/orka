import { test, expect } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { syncAttentionFixture } from "./fixtures/sync-attention.js";

test.beforeEach(async ({ page }) => {
  await syncAttentionFixture(page);
  await page.goto("/");
});

test("modal counts unique project resources and preserves completed activity in history", async ({
  page,
}) => {
  const status = page.locator(".workspace-header .sync-status");
  await expect(status).toHaveAttribute(
    "aria-label",
    "Needs attention, 3 notifications",
  );
  await status.click();
  const modal = page.getByRole("dialog", {
    name: "Sync status and notifications",
  });
  await expect(
    modal.getByRole("group", { name: "Writing guide", exact: true }),
  ).toHaveCount(1);
  await expect(
    modal.getByText(
      "Local skill edits preserved; resolve them before applying the shared update",
      { exact: true },
    ),
  ).toHaveCount(1);
  await expect(
    modal.getByRole("group", { name: "Writing guide", exact: true }),
  ).toContainText("Skill installation recovery pending");
  await expect(
    modal.getByRole("group", { name: "Writing guide", exact: true }),
  ).toContainText("Publication needs a fresh review");
  await expect(
    modal.getByRole("group", { name: "Release checklist", exact: true }),
  ).toContainText("409: Resource changed");
  await expect(
    modal.getByRole("button", { name: "Retry uploads" }),
  ).toHaveCount(0);
  await expect(
    modal.getByRole("button", { name: "Review conflict" }),
  ).toBeVisible();
  await expect(modal).not.toContainText("Docs access changed");
  await expect(
    modal.getByText("Project setup notes · approved"),
  ).not.toBeVisible();
  await modal.locator("summary").filter({ hasText: "History (" }).click();
  await expect(modal).toContainText("Project setup notes · approved");
  await expect(modal).toContainText("Earlier writing guide · superseded");
  await expect(modal.getByRole("button", { name: "View copy" })).toBeVisible();
  await expect(status).toHaveAttribute(
    "aria-label",
    "Needs attention, 3 notifications",
  );
  const accessibility = await new AxeBuilder({ page })
    .include(".sync-menu")
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await page.keyboard.press("Escape");
  await page.getByRole("combobox", { name: /Select project/ }).click();
  await page.getByRole("option", { name: "Docs", exact: true }).click();
  await expect(status).toHaveAttribute(
    "aria-label",
    "Needs attention, 1 notification",
  );
  await status.click();
  await expect(modal).toContainText("Docs access changed");
  await expect(modal).not.toContainText("Release checklist");
});

test("saved history previews keep the original bytes and expose no publication controls", async ({
  page,
}) => {
  await page.locator(".workspace-header .sync-status").click();
  const modal = page.getByRole("dialog", {
    name: "Sync status and notifications",
  });
  await modal.locator("summary").filter({ hasText: "History (" }).click();
  await modal.getByRole("button", { name: "Open request history" }).click();
  const management = page.getByRole("region", { name: "Manage", exact: true });
  await management.getByText("History (2)", { exact: true }).click();
  await management
    .getByRole("button", { name: "View saved change", exact: true })
    .click();
  const saved = page.getByRole("dialog", { name: "Saved change", exact: true });
  await expect(saved).toContainText("Preserved older instructions");
  for (const name of [
    "Publish update",
    "Send for approval",
    "Review latest and retry",
  ])
    await expect(saved.getByRole("button", { name, exact: true })).toHaveCount(
      0,
    );
  await saved.getByRole("button", { name: "Close", exact: true }).click();
  await management
    .getByRole("button", { name: "View request", exact: true })
    .filter({ hasText: "View request" })
    .last()
    .click();
  const request = page.getByRole("dialog", {
    name: "Request history",
    exact: true,
  });
  await expect(
    request.getByRole("button", { name: "Approve request", exact: true }),
  ).toHaveCount(0);
  await expect(
    request.getByRole("button", { name: "Reject", exact: true }),
  ).toHaveCount(0);
  const mutations = await page.evaluate(() =>
    window.attentionFixture.calls.filter(
      (call) =>
        call.name === "governance_command" &&
        ["submit-draft", "refresh-draft", "decide", "dismiss"].includes(
          String(call.args?.action),
        ),
    ),
  );
  expect(mutations).toEqual([]);
});
