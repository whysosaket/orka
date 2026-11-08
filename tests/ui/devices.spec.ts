import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { settingsFixture } from "./fixtures/settings.js";

const families = [
  "laptop",
  "all-in-one",
  "mac-mini",
  "mac-studio",
  "mac-pro",
  "generic",
];
const rows = families.map((hardwareFamily, index) => ({
  id: index === 0 ? "mac" : `fixture-${index}`,
  name: `Fixture ${hardwareFamily}`,
  seen_at: "2026-11-07T09:30:00Z",
  hardwareFamily,
}));
async function labelFixture(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    const label = document.createElement("aside");
    label.setAttribute("role", "note");
    label.textContent =
      "TEST FIXTURE · Six illustration categories · Sample devices";
    Object.assign(label.style, {
      position: "fixed",
      top: "16px",
      right: "144px",
      zIndex: "100",
      background: "#f2eeeb",
      color: "#141414",
      borderRadius: "6px",
      padding: "8px 12px",
      font: "12px/18px sans-serif",
      whiteSpace: "nowrap",
      pointerEvents: "none",
    });
    document.body.append(label);
  });
}

for (const [width, height] of [
  [1440, 900],
  [1160, 800],
  [900, 640],
]) {
  test(`device family coverage decodes six approved assets at 48 px, ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height });
    const settings = await settingsFixture(page, {
      deviceRows: rows,
      localHardwareFamily: "laptop",
    });
    await settings
      .getByRole("button", { name: "Devices", exact: true })
      .click();
    const devices = settings.getByRole("listitem");
    await expect(devices).toHaveCount(6);
    for (const [index, family] of families.entries()) {
      const image = devices.nth(index).locator("img");
      await image.scrollIntoViewIfNeeded();
      await expect(image).toHaveAttribute("src", `/devices/${family}.png`);
      const decoded = await image.evaluate(async (node: HTMLImageElement) => {
        await node.decode();
        const box = node.getBoundingClientRect();
        return {
          loaded: node.complete,
          naturalWidth: node.naturalWidth,
          naturalHeight: node.naturalHeight,
          width: box.width,
          height: box.height,
          alt: node.alt,
        };
      });
      expect(decoded).toEqual({
        loaded: true,
        naturalWidth: 128,
        naturalHeight: 128,
        width: 48,
        height: 48,
        alt: "",
      });
    }
    await expect(
      settings.getByRole("list").getByText("This Mac", { exact: true }),
    ).toHaveCount(1);
    await expect(settings.getByText(/^(Connected|Disconnected)$/)).toHaveCount(
      0,
    );
    const accessibility = await new AxeBuilder({ page })
      .include('section[aria-label="Settings"]')
      .analyze();
    expect(accessibility.violations).toEqual([]);
    await devices.first().scrollIntoViewIfNeeded();
    await labelFixture(page);
    await page.screenshot({
      path: info.outputPath(`devices-category-coverage-${width}.png`),
    });
  });
}

test("This Mac uses native family with an older service; misleading remote names remain Generic", async ({
  page,
}) => {
  const settings = await settingsFixture(page, {
    localHardwareFamily: "laptop",
    deviceRows: [
      { id: "mac", name: "Renamed Mac Pro", seen_at: "2026-11-07T09:30:00Z" },
      {
        id: "remote",
        name: "Misleading MacBook Air",
        seen_at: "2026-11-07T09:30:00Z",
      },
    ],
  });
  await settings.getByRole("button", { name: "Devices", exact: true }).click();
  const devices = settings.getByRole("listitem");
  await expect(devices.nth(0).locator("img")).toHaveAttribute(
    "src",
    "/devices/laptop.png",
  );
  await expect(devices.nth(1).locator("img")).toHaveAttribute(
    "src",
    "/devices/generic.png",
  );
  await expect(devices.nth(0)).toContainText("This Mac");
  await expect(devices.nth(1)).not.toContainText("This Mac");
});

test("new reported metadata updates its own device row while Settings stays open", async ({
  page,
}) => {
  const settings = await settingsFixture(page, {
    localHardwareFamily: "laptop",
    deviceRows: [
      { id: "mac", name: "Office", seen_at: "2026-11-07T09:30:00Z" },
      {
        id: "remote",
        name: "Renamed MacBook Pro",
        seen_at: "2026-11-07T09:30:00Z",
        hardwareFamily: "generic",
      },
    ],
  });
  await settings.getByRole("button", { name: "Devices", exact: true }).click();
  const devices = settings.getByRole("listitem");
  await expect(devices.nth(1).locator("img")).toHaveAttribute(
    "src",
    "/devices/generic.png",
  );
  await page.evaluate(() => {
    (window as any).settingsState.devices[1].hardwareFamily = "mac-mini";
  });
  await expect(devices.nth(1).locator("img")).toHaveAttribute(
    "src",
    "/devices/mac-mini.png",
    { timeout: 8000 },
  );
  await expect(devices.nth(0).locator("img")).toHaveAttribute(
    "src",
    "/devices/laptop.png",
  );
  await expect(devices).toHaveCount(2);
});

test("device loading keeps measured artwork geometry and reveals actual rows", async ({
  page,
}, info) => {
  const settings = await settingsFixture(page, {
    noCachedDevices: true,
    deviceRows: rows.slice(0, 2),
    delay: 1600,
  });
  await settings.getByRole("button", { name: "Devices", exact: true }).click();
  await expect(settings.locator('[aria-busy="true"]')).toBeVisible();
  await expect(settings.getByRole("listitem")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("devices-loading.png") });
  await expect(settings.getByRole("listitem")).toHaveCount(2);
  await expect(settings.locator('[aria-busy="true"]')).toHaveCount(0);
  const image = settings.getByRole("listitem").first().locator("img");
  const box = await image.boundingBox();
  expect(box?.width).toBe(48);
  expect(box?.height).toBe(48);
});

test("a missing illustration is an asset failure and never changes the hardware to Generic", async ({
  page,
}) => {
  await page.route("**/devices/mac-pro.png", (route) =>
    route.fulfill({ status: 404, body: "missing test asset" }),
  );
  const settings = await settingsFixture(page, {
    deviceRows: [
      {
        id: "remote",
        name: "Fixture Mac Pro",
        seen_at: "2026-11-07T09:30:00Z",
        hardwareFamily: "mac-pro",
      },
    ],
  });
  await settings.getByRole("button", { name: "Devices", exact: true }).click();
  const image = settings.getByRole("listitem").locator("img");
  await expect(image).toHaveAttribute("src", "/devices/mac-pro.png");
  await expect
    .poll(() => image.evaluate((node: HTMLImageElement) => node.complete))
    .toBe(true);
  expect(
    await image.evaluate((node: HTMLImageElement) => node.naturalWidth),
  ).toBe(0);
  await expect(settings.locator('img[src="/devices/generic.png"]')).toHaveCount(
    0,
  );
});
