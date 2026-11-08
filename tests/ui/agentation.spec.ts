import { test, expect } from "@playwright/test";
import { settingsFixture } from "./fixtures/settings.js";

for (const width of [1160, 900])
  test(`Agentation annotates Settings and copies local feedback at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: async (value: string) => {
            (window as any).copiedFeedback = value;
          },
        },
      });
    });
    const settings = await settingsFixture(page);
    await page
      .getByRole("button", { name: "Start feedback mode", exact: true })
      .click();
    await settings
      .getByRole("heading", { name: "General", exact: true })
      .click();
    await page
      .getByPlaceholder("What should change?", { exact: true })
      .fill("Check this General heading.");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page
      .getByRole("button", { name: "Copy feedback", exact: true })
      .click();
    await expect
      .poll(() => page.evaluate(() => (window as any).copiedFeedback))
      .toContain("Check this General heading.");
    expect(await page.evaluate(() => (window as any).copiedFeedback)).toContain(
      "General",
    );
    await page.getByRole("button", { name: "Exit", exact: true }).click();
    await settings
      .getByRole("button", { name: "Profile", exact: true })
      .click();
    await expect(
      settings.getByRole("textbox", { name: "Display name", exact: true }),
    ).toBeEditable();
  });

test("Agentation can annotate and type feedback inside a Settings confirmation", async ({
  page,
}) => {
  const settings = await settingsFixture(page);
  await settings
    .getByRole("textbox", { name: "Project name", exact: true })
    .fill("Draft name");
  await settings.getByRole("button", { name: "Devices", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Save your changes?",
    exact: true,
  });
  await page
    .getByRole("button", { name: "Start feedback mode", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Discard", exact: true }).click();
  const feedback = page.getByPlaceholder("What should change?", {
    exact: true,
  });
  await feedback.fill("Clarify this discard action.");
  await expect(feedback).toBeFocused();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(dialog).toBeVisible();
  await page.getByRole("button", { name: "Exit", exact: true }).click();
  await dialog.getByRole("button", { name: "Stay", exact: true }).click();
  await expect(
    settings.getByRole("textbox", { name: "Project name", exact: true }),
  ).toHaveValue("Draft name");
});
