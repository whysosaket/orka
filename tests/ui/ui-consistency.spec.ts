import { test, expect } from "@playwright/test";
import { settingsFixture } from "./fixtures/settings.js";

test("invitation modes stay grouped and link rules appear once after copying", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async () => {} },
    });
  });
  const settings = await settingsFixture(page, { emailInvites: true });
  await settings.getByRole("button", { name: "Members", exact: true }).click();
  await settings
    .getByRole("button", { name: "Add Member", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Add Member", exact: true });
  const modes = dialog.getByRole("group", {
    name: "Invitation method",
    exact: true,
  });
  await expect(
    modes.getByRole("button", { name: "Email", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await dialog
    .getByRole("textbox", { name: "Email address", exact: true })
    .fill("teammate@example.com");
  await modes.getByRole("button", { name: "Link", exact: true }).click();
  await dialog
    .getByRole("button", { name: "Copy joining link", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toHaveText("Link copied.");
  await expect(dialog.getByText(/24 hours/)).toHaveCount(1);
  await expect(
    modes.getByRole("button", { name: "Link", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await modes.getByRole("button", { name: "Email", exact: true }).click();
  await expect(
    dialog.getByRole("textbox", { name: "Email address", exact: true }),
  ).toHaveValue("teammate@example.com");
});
