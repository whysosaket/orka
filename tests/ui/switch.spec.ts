import { fileURLToPath } from "node:url";
import { test, expect, type Locator, type Page } from "@playwright/test";

async function fixture(page: Page) {
  await page.route("**/switch-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><body><div id="root"></div><script type="module" src="/@fs/${fileURLToPath(new URL("./fixtures/switch.ts", import.meta.url))}"></script></body></html>`,
    }),
  );
  await page.goto("/switch-fixture");
  await expect(
    page.getByRole("switch", { name: "Controlled", exact: true }),
  ).toBeVisible();
}

async function thumb(input: Locator) {
  return input.evaluate((el) => {
    const r = el.nextElementSibling!.firstElementChild!.getBoundingClientRect();
    const inputRect = el.getBoundingClientRect();
    return {
      x: Math.round((r.x - inputRect.x) * 10) / 10,
      width: Math.round(r.width * 10) / 10,
      height: Math.round(r.height * 10) / 10,
    };
  });
}

async function drag(page: Page, input: Locator, delta: number) {
  const box = (await input.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + delta, box.y + box.height / 2, {
    steps: 4,
  });
  await page.mouse.up();
}

test("drag commits exactly once; a short drag and a cancelled gesture preserve the saved state", async ({
  page,
}) => {
  await fixture(page);
  const input = page.getByRole("switch", { name: "Controlled", exact: true });
  await drag(page, input, 12);
  await expect(input).toBeChecked();
  await expect(page.getByLabel("Changes")).toHaveText("1");
  await drag(page, input, -4);
  await expect(input).toBeChecked();
  await expect(page.getByLabel("Changes")).toHaveText("1");
  await drag(page, input, -12);
  await expect(input).not.toBeChecked();
  await expect(page.getByLabel("Changes")).toHaveText("2");
  const box = (await input.boundingBox())!;
  await page.mouse.move(box.x + 10, box.y + 12);
  await page.mouse.down();
  await page.mouse.move(box.x + 25, box.y + 12);
  await input.dispatchEvent("pointercancel", {
    pointerId: 1,
    pointerType: "mouse",
  });
  await page.mouse.move(600, 200);
  await page.mouse.up();
  await expect(input).not.toBeChecked();
  await expect(page.getByLabel("Changes")).toHaveText("2");
  await page
    .getByText("Controlled", { exact: true })
    .click({ position: { x: 5, y: 5 } });
  await expect(input).toBeChecked();
  await expect(page.getByLabel("Changes")).toHaveText("3");
});

test("pointer feedback stays within the track, rapid reversals settle, and keyboard/Discard stay in sync", async ({
  page,
}) => {
  await fixture(page);
  const input = page.getByRole("switch", { name: "Controlled", exact: true });
  await input.hover();
  await expect
    .poll(() => thumb(input))
    .toEqual({ x: 2, width: 22, height: 20 });
  await page.mouse.down();
  await expect
    .poll(() => thumb(input))
    .toEqual({ x: 2, width: 24, height: 16 });
  await page.mouse.up();
  await expect(input).toBeChecked();
  await expect
    .poll(() => thumb(input))
    .toEqual({ x: 16, width: 22, height: 20 });
  await input.click();
  await input.click();
  await input.click();
  await expect(input).not.toBeChecked();
  await input.press("Space");
  await expect(input).toBeChecked();
  await expect
    .poll(() => thumb(input))
    .toEqual({ x: 18, width: 20, height: 20 });
  await expect(input).toBeFocused();
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(input).not.toBeChecked();
  await expect
    .poll(() => thumb(input))
    .toEqual({ x: 2, width: 20, height: 20 });
});

test("native labels, reset, forwarded focus and disabled fieldsets keep their behavior", async ({
  page,
}) => {
  await fixture(page);
  const input = page.getByRole("switch", { name: "Uncontrolled", exact: true });
  await expect(input).toBeChecked();
  await expect
    .poll(() => thumb(input))
    .toEqual({ x: 18, width: 20, height: 20 });
  await page
    .getByText("Uncontrolled", { exact: true })
    .click({ position: { x: 5, y: 5 } });
  await expect(input).not.toBeChecked();
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(input).toBeChecked();
  await expect
    .poll(() => thumb(input))
    .toEqual({ x: 18, width: 20, height: 20 });
  await page.getByRole("button", { name: "Focus input", exact: true }).click();
  await expect(input).toBeFocused();
  const disabled = page.getByRole("switch", { name: "Disabled", exact: true });
  await expect(disabled).toBeDisabled();
  await disabled.hover({ force: true });
  await expect
    .poll(() => thumb(disabled))
    .toEqual({ x: 18, width: 20, height: 20 });
  await page
    .getByRole("button", { name: "Toggle fieldset", exact: true })
    .click();
  await expect(disabled).toBeEnabled();
  await disabled.click();
  await expect(disabled).not.toBeChecked();
});

test("reduced motion snaps directly between states and has no hover/press deformation", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await fixture(page);
  const input = page.getByRole("switch", { name: "Controlled", exact: true });
  await input.hover();
  expect(await thumb(input)).toEqual({ x: 2, width: 20, height: 20 });
  await page.mouse.down();
  expect(await thumb(input)).toEqual({ x: 2, width: 20, height: 20 });
  await page.mouse.up();
  await expect(input).toBeChecked();
  expect(await thumb(input)).toEqual({ x: 18, width: 20, height: 20 });
  await input.press("Space");
  expect(await thumb(input)).toEqual({ x: 2, width: 20, height: 20 });
});
