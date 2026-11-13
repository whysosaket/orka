import { test, expect } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import {
  resourceLibraryFixture,
  type LibraryWindow,
} from "./fixtures/resource-library.js";

for (const width of [1160, 900]) {
  for (const { label, kind } of [
    { label: "Sessions", kind: "session" },
    { label: "Memories", kind: "memory" },
    { label: "Plans", kind: "plan" },
  ]) {
    test(`${label} loading fits at ${width}px and leaves navigation usable`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: width === 900 ? 640 : 800 });
      await resourceLibraryFixture(page, { emptyShared: true, defer: true });
      await page.getByRole("button", { name: new RegExp(`^${label}`) }).click();
      const collection = page.getByRole("region", {
        name: new RegExp(`^${label}$`, "i"),
      });
      const skeleton = collection.locator(".collection-skeleton");
      await expect(skeleton).toBeVisible();
      await expect(collection.locator(".loading-region")).toHaveAttribute(
        "aria-busy",
        "true",
      );
      await expect(collection.getByRole("status")).toHaveText(
        `Loading ${label.toLowerCase()}…`,
      );
      await expect(collection.getByRole("status")).toHaveClass("sr-only");
      await expect(skeleton).not.toContainText(/Loading/);
      await expect(collection.locator("[skullet-own]")).toHaveCSS(
        "mask-image",
        "linear-gradient(rgb(0, 0, 0) 35%, rgba(0, 0, 0, 0))",
      );
      await expect(collection.getByText(/Checking|Looking for/)).toHaveCount(0);
      await expect(skeleton.getByRole("button")).toHaveCount(0);
      await expect(
        collection.getByRole("group", { name: "Filter by ownership" }),
      ).toBeVisible();
      await expect(
        page.getByRole("combobox", { name: "Select project", exact: true }),
      ).toBeEnabled();
      expect(
        await skeleton.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      await expect(skeleton.locator(".collection-skeleton-rows")).toHaveCSS(
        "animation-name",
        "none",
      );
      await page.screenshot({
        path: info.outputPath(`${kind}-loading-${width}.png`),
      });
      if (kind === "session")
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual(
          [],
        );
      await page.evaluate(() =>
        (window as unknown as LibraryWindow).library.finishCatalog?.(),
      );
      await expect(
        page.getByRole("button", {
          name: `Private ${kind} notes`,
          exact: true,
        }),
      ).toBeVisible();
      await expect(skeleton).toHaveCount(0);
    });
  }
}

test("loading breathes softly, stops with reduced motion, and refresh retains real rows", async ({
  page,
}) => {
  await resourceLibraryFixture(page, { emptyShared: true, defer: true });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.getByRole("button", { name: /^Sessions/ }).click();
  const skeleton = page.locator(".collection-skeleton-rows");
  await expect(skeleton).toHaveCSS("animation-name", "loading-breathe");
  await expect(skeleton).toHaveCSS("animation-duration", "2.4s");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(skeleton).toHaveCSS("animation-name", "none");
  await page.evaluate(() =>
    (window as unknown as LibraryWindow).library.finishCatalog?.(),
  );
  const item = page.getByRole("button", {
    name: "Private session notes",
    exact: true,
  });
  await expect(item).toBeVisible();
  await page
    .getByRole("button", { name: "Refresh local items", exact: true })
    .click();
  await expect(item).toBeEnabled();
  await expect(skeleton).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("Refreshing sessions…");
  await item.click();
  await expect(page.getByLabel("Conversation", { exact: true })).toContainText(
    "Private session conversation",
  );
});
