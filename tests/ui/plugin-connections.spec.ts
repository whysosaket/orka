import { expect, test, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { settingsCalls, settingsFixture } from "./fixtures/settings.js";
import { join } from "node:path";

async function capture(page: Page, state: string) {
  const directory = process.env.ORKA_CAPTURE_DIR;
  const helper = process.env.ORKA_CAPTURE_HELPER;
  if (!directory || !helper) return;
  const revision = process.env.ORKA_CAPTURE_REVISION ?? "";
  const side = process.env.ORKA_CAPTURE_SIDE ?? "";
  const { capturePage } = await import(helper);
  await capturePage(page, {
    path: join(
      directory,
      `desktop-${side}-${revision.slice(0, 12)}-${state}.png`,
    ),
    side,
    revision,
    surface: "desktop",
    state,
    fixture: "synthetic-settings-v1",
    theme: "desktop-dark",
    expectedVisible: [
      state === "consent" || state === "first-connection"
        ? ".plugin-authorization"
        : state === "startup"
          ? '.sidebar-bottom button[aria-label="Settings"]'
          : state === "reconnect-toast"
            ? "[data-orka-toast]"
            : ".settings-panel",
    ],
  });
}

const openConnection = async (page: Page) => {
  await page.evaluate(() => {
    (window as any).settingsControls.pluginRequestId = "fixture-request";
  });
  await page.getByRole("button", { name: "Connectors", exact: true }).click();
  await page
    .getByRole("button", { name: "Review request", exact: true })
    .click();
  return page.getByRole("dialog", {
    name: "Connect to Orka",
    exact: true,
  });
};

test("desktop consent shows the native identity and submits only its request ID", async ({
  page,
}, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await settingsFixture(page);
  await capture(page, "settings");
  const dialog = await openConnection(page);
  await expect(
    dialog.getByText("morgan@example.com", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText("Fixture Assistant", { exact: false }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("list", { name: "Requested permissions" }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("desktop-consent.png"),
    animations: "disabled",
  });
  await capture(page, "consent");
  await dialog
    .getByRole("button", { name: "Allow connection", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText("Connection approved");
  expect(
    (await settingsCalls(page)).find(
      ({ command, args }) =>
        command === "plugin_authorization" && args.operation === "approve",
    )?.args,
  ).toEqual({
    operation: "approve",
    input: {
      requestId: "fixture-request",
      scopes: ["orka.read", "orka.write", "orka.manage"],
    },
  });
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(
    (await settingsCalls(page)).filter(
      ({ command, args }) =>
        command === "plugin_authorization" && args.operation === "cancel",
    ),
  ).toHaveLength(0);
});

test("consent remains fixed while loading and fits a compact window", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 640 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await settingsFixture(page, { pluginDelay: 1200 });
  const dialog = await openConnection(page);
  await expect(dialog.getByRole("status")).toHaveText(
    "Checking connection request…",
  );
  const initial = await dialog.boundingBox();
  const initialActions = await dialog.locator("footer").boundingBox();
  await expect(
    dialog.getByRole("button", { name: "Allow connection", exact: true }),
  ).toBeEnabled();
  expect(await dialog.boundingBox()).toEqual(initial);
  expect(await dialog.locator("footer").boundingBox()).toEqual(initialActions);
  const heading = await dialog.locator("header").boundingBox();
  const close = await dialog
    .getByRole("button", { name: "Close connection" })
    .boundingBox();
  expect(close!.y - heading!.y).toBe(12);
  expect(
    await dialog
      .locator("header")
      .evaluate((element) => getComputedStyle(element).borderBottomWidth),
  ).toBe("1px");
  expect(
    await dialog
      .locator("footer")
      .evaluate((element) => getComputedStyle(element).borderTopWidth),
  ).toBe("1px");
  expect(
    await dialog
      .locator("h2:not(.sr-only)")
      .evaluate((element) => getComputedStyle(element).fontSize),
  ).toBe("20px");
  await expect(
    dialog.getByRole("button", { name: "Allow connection", exact: true }),
  ).toBeInViewport({ ratio: 1 });
  await dialog.getByRole("region", { name: "Connection details" }).focus();
  await page.keyboard.press("End");
  await expect(dialog.locator(".connector-consent-note")).toBeInViewport({
    ratio: 1,
  });
  expect(await dialog.locator("footer").boundingBox()).toEqual(initialActions);
  const accessibility = await new AxeBuilder({ page })
    .include(".plugin-authorization")
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(
    (await settingsCalls(page)).find(
      ({ command, args }) =>
        command === "plugin_authorization" && args.operation === "cancel",
    )?.args.input,
  ).toEqual({ requestId: "fixture-request" });
});

test("a verified first connection opens consent from Home", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await settingsFixture(page, {
    openSettings: false,
    pluginRequestId: "fixture-request",
    pluginFirstConnection: true,
    pluginClientName: "Codex",
    pluginRemembered: true,
  });
  const dialog = page.getByRole("dialog", { name: "Connect to Orka" });
  await expect(
    dialog.getByRole("heading", { name: "Codex", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Allow connection" }),
  ).toBeEnabled();
  await capture(page, "first-connection");
  expect(
    (await settingsCalls(page)).find(
      ({ command, args }) =>
        command === "plugin_authorization" && args.operation === "preview",
    )?.args.input,
  ).toEqual({ requestId: "fixture-request", automatic: true });
  await dialog.getByRole("button", { name: "Allow connection" }).click();
  await expect(dialog.getByRole("status")).toContainText("Connection approved");
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Settings", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator("[data-orka-toast]")).toHaveCount(0);
});

for (const previewBusy of [false, true]) {
  test(`automatic consent closes when the assistant leaves ${previewBusy ? "before preview" : "during review"}`, async ({
    page,
  }) => {
    await settingsFixture(page, {
      openSettings: false,
      pluginRequestId: "fixture-request",
      pluginFirstConnection: true,
      pluginError: previewBusy
        ? "A sync or project operation is in progress."
        : undefined,
    });
    const dialog = page.getByRole("dialog", { name: "Connect to Orka" });
    if (previewBusy)
      await expect(dialog.getByRole("alert")).toContainText(
        "A sync or project operation",
      );
    else
      await expect(
        dialog.getByRole("button", { name: "Allow connection" }),
      ).toBeEnabled();
    await page.evaluate(() => {
      (window as any).settingsControls.pluginRequestId = "";
    });
    await expect(dialog).toHaveCount(0);
    await expect(page.locator("[data-orka-toast]")).toHaveCount(0);
  });
}

test("a failed reconnect shows a quiet bottom-right toast with a Connectors action", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 640 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await settingsFixture(page, {
    openSettings: false,
    pluginClientName: "Claude Code",
    pluginRemembered: true,
  });
  const settings = page.getByRole("button", { name: "Settings", exact: true });
  await settings.focus();
  await expect(settings).toBeFocused();
  await expect(page.locator("[data-orka-toast]")).toHaveCount(0);
  await page.evaluate(() => {
    const controls = (window as any).settingsControls;
    controls.pluginRequestId = "fixture-request";
    controls.pluginReconnectNotice = "Claude Code";
  });
  const toast = page.locator("[data-orka-toast]");
  await expect(toast.getByRole("status")).toHaveText(
    "Claude Code couldn’t reconnect to Orka",
  );
  await expect(toast.getByRole("alert")).toHaveCount(0);
  await expect(settings).toBeFocused();
  await expect(
    page.getByRole("dialog", { name: "Connect to Orka" }),
  ).toHaveCount(0);
  await expect
    .poll(async () => {
      const bounds = await toast.boundingBox();
      return (
        bounds && [
          Math.round(bounds.x + bounds.width),
          Math.round(bounds.y + bounds.height),
        ]
      );
    })
    .toEqual([876, 616]);
  await capture(page, "reconnect-toast");
  await toast.getByRole("button", { name: "Connectors" }).click();
  const panel = page.locator('.settings-panel[data-section="connections"]');
  await expect(
    panel.getByRole("button", { name: "Review request" }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "Connect to Orka" }),
  ).toHaveCount(0);
});

test("requests stay in Settings and an expired request closes quietly", async ({
  page,
}) => {
  await settingsFixture(page, {
    openSettings: false,
    pluginRequestId: "fixture-request",
  });
  await expect(
    page.getByRole("button", { name: "Settings", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "Connect to Orka" }),
  ).toHaveCount(0);
  expect(
    (await settingsCalls(page)).filter(
      ({ command }) => command === "plugin_authorization",
    ),
  ).toHaveLength(0);
  await capture(page, "startup");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Connectors", exact: true }).click();
  const review = page.getByRole("button", {
    name: "Review request",
    exact: true,
  });
  await expect(review).toBeVisible();
  await capture(page, "pending");
  await review.click();
  const dialog = page.getByRole("dialog", { name: "Connect to Orka" });
  await expect(
    dialog.getByRole("button", { name: "Allow connection", exact: true }),
  ).toBeEnabled();
  await page.evaluate(() => {
    (window as any).settingsControls.pluginRequestId = "";
  });
  await dialog
    .getByRole("button", { name: "Allow connection", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  const panel = page.locator('.settings-panel[data-section="connections"]');
  await expect(panel.getByRole("status")).toHaveText("Not connected");
  await expect(panel.getByRole("alert")).toHaveCount(0);
});

test("a transient preview failure can retry a fresh native review", async ({
  page,
}) => {
  await settingsFixture(page, {
    pluginError: "Another Orka operation is in progress. Try again.",
  });
  const dialog = await openConnection(page);
  await expect(dialog.getByRole("alert")).toContainText(
    "Another Orka operation",
  );
  await expect(
    dialog.getByRole("button", { name: "Allow connection", exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => {
    (window as any).settingsControls.pluginError = "";
  });
  await dialog
    .getByRole("button", { name: "Retry connection", exact: true })
    .click();
  await expect(
    dialog.getByText("morgan@example.com", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Allow connection", exact: true }),
  ).toBeEnabled();
  expect(
    (await settingsCalls(page)).filter(
      ({ command, args }) =>
        command === "plugin_authorization" && args.operation === "preview",
    ),
  ).toHaveLength(2);
  expect(
    (await settingsCalls(page)).filter(
      ({ command, args }) =>
        command === "plugin_authorization" && args.operation === "approve",
    ),
  ).toHaveLength(0);
});

test("a changed workspace cannot approve the identity shown before the change", async ({
  page,
}) => {
  await settingsFixture(page);
  const dialog = await openConnection(page);
  await expect(
    dialog.getByRole("button", { name: "Allow connection", exact: true }),
  ).toBeEnabled();
  await page.evaluate(() => {
    (window as any).settingsState.user = "different-account";
    (window as any).settingsEmit("workspace-changed", null);
  });
  // The normal workspace refresh observes the switched identity.
  await expect(dialog).toHaveCount(0, { timeout: 15000 });
  expect(
    (await settingsCalls(page)).filter(
      ({ command, args }) =>
        command === "plugin_authorization" && args.operation === "approve",
    ),
  ).toHaveLength(0);
});

test("connections show reconnect instructions and refresh recorded approval", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 900, height: 640 });
  const settings = await settingsFixture(page, { noProjects: true });
  await settings
    .getByRole("button", { name: "Connectors", exact: true })
    .click();
  const panel = page.locator('.settings-panel[data-section="connections"]');
  await expect(panel.getByText("Not connected", { exact: true })).toBeVisible();
  await page.evaluate(() => {
    (window as any).settingsControls.pluginState = "reconnect_required";
  });
  await panel
    .getByRole("button", { name: "Check connection", exact: true })
    .click();
  await expect(panel.getByRole("status")).toHaveText(
    "Connection checked. Reconnect required",
  );
  await expect(
    panel.getByText(
      "Review new requests here. Orka remembers access for verified assistants on this Mac.",
      { exact: true },
    ),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("desktop-reconnect.png"),
    animations: "disabled",
  });
  await capture(page, "reconnect");
  await page.evaluate(() => {
    (window as any).settingsControls.pluginState = "linked";
  });
  await panel
    .getByRole("button", { name: "Check connection", exact: true })
    .click();
  await expect(panel.getByRole("status")).toHaveText(
    "Connection checked. Approved on this Mac",
  );
  expect(
    (
      await new AxeBuilder({ page })
        .include('.settings-panel[data-section="connections"]')
        .analyze()
    ).violations,
  ).toEqual([]);
});

test("connector installation instructions open the maintained guide and recover from browser failure", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 640 });
  const settings = await settingsFixture(page, { noProjects: true });
  await settings
    .getByRole("button", { name: "Connectors", exact: true })
    .click();
  const panel = page.locator('.settings-panel[data-section="connections"]');
  const setup = panel.getByRole("region", { name: "Connect or reconnect" });
  const instructions = setup.getByRole("button", {
    name: "Installation instructions",
    exact: true,
  });
  await expect(instructions).toHaveCSS("box-shadow", /inset/);
  await expect
    .poll(() =>
      setup.evaluate((card) => {
        const steps = card.querySelector("ol")!.getBoundingClientRect();
        const button = card.querySelector("button")!.getBoundingClientRect();
        return button.top - steps.bottom;
      }),
    )
    .toBeGreaterThanOrEqual(12);
  const url =
    "https://github.com/quaylabshq/orka/blob/main/plugins/orka/README.md#connect";
  await instructions.click();
  expect(
    (await settingsCalls(page)).find((call) => call.command === "open_web_link")
      ?.args,
  ).toEqual({ url });
  await page.evaluate(() => {
    const controls = (window as any).settingsControls;
    const internals = (window as any).__TAURI_INTERNALS__;
    const invoke = internals.invoke;
    controls.browserOpenError = true;
    internals.invoke = async (command: string, args: unknown) => {
      if (command === "open_web_link" && controls.browserOpenError)
        throw new Error("Cannot open your browser");
      return invoke(command, args);
    };
  });
  await instructions.click();
  await expect(panel.getByRole("alert")).toContainText(url);
  await expect(instructions).toBeEnabled();
  await page.evaluate(() => {
    (window as any).settingsControls.browserOpenError = false;
  });
  await instructions.click();
  await expect(panel.getByRole("alert")).toHaveCount(0);
});

test("Connectors keeps account details visible during recheck and reports retryable errors", async ({
  page,
}) => {
  const settings = await settingsFixture(page);
  await settings
    .getByRole("button", { name: "Connectors", exact: true })
    .click();
  const panel = page.locator('.settings-panel[data-section="connections"]');
  await expect(
    panel.getByText("morgan@example.com", { exact: true }),
  ).toBeVisible();
  const check = panel.getByRole("button", {
    name: "Check connection",
    exact: true,
  });
  const resting = await check.boundingBox();
  // Hover lays the shared state overlay over the resting fill.
  const overlay = await check.evaluate(
    (element) => getComputedStyle(element).boxShadow,
  );
  await check.hover();
  expect(await check.boundingBox()).toEqual(resting);
  await expect
    .poll(() =>
      check.evaluate((element) => getComputedStyle(element).boxShadow),
    )
    .not.toBe(overlay);
  await page.evaluate(() => {
    (window as any).settingsControls.pluginStatusDelay = 1200;
  });
  await panel
    .getByRole("button", { name: "Check connection", exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "Checking…", exact: true }),
  ).toBeDisabled();
  await expect(
    panel.getByText("morgan@example.com", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Check connection", exact: true }),
  ).toBeEnabled();
  await page.evaluate(() => {
    (window as any).settingsControls.pluginStatusError =
      "Service unavailable. Try again.";
  });
  await panel
    .getByRole("button", { name: "Check connection", exact: true })
    .click();
  await expect(panel.getByRole("alert")).toContainText("Service unavailable");
  await expect(
    panel.getByText("morgan@example.com", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Check connection", exact: true }),
  ).toBeEnabled();
});

test("manual checks acknowledge an unchanged connection and can repeat", async ({
  page,
}) => {
  const settings = await settingsFixture(page, { pluginStatusDelay: 250 });
  await settings
    .getByRole("button", { name: "Connectors", exact: true })
    .click();
  const panel = page.locator('.settings-panel[data-section="connections"]');
  await expect(panel.getByRole("status")).toHaveText("Not connected");
  const calls = () =>
    settingsCalls(page).then(
      (values) =>
        values.filter(({ command }) => command === "plugin_connection_status")
          .length,
    );
  const before = await calls();
  for (let check = 1; check <= 2; check++) {
    await panel
      .getByRole("button", { name: "Check connection", exact: true })
      .click();
    await expect(
      panel.getByRole("button", { name: "Checking…", exact: true }),
    ).toBeDisabled();
    await expect(panel.getByRole("status")).toHaveText(
      "Connection checked. Not connected",
    );
    expect(await calls()).toBe(before + check);
  }
});

test("hidden connectors still allow manual checks and refresh when visible again", async ({
  page,
}) => {
  const settings = await settingsFixture(page);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
  });
  await settings
    .getByRole("button", { name: "Connectors", exact: true })
    .click();
  const panel = page.locator('.settings-panel[data-section="connections"]');
  await expect(panel.getByRole("status")).toHaveText("Not connected");
  const before = (await settingsCalls(page)).filter(
    ({ command }) => command === "plugin_connection_status",
  ).length;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  expect(
    (await settingsCalls(page)).filter(
      ({ command }) => command === "plugin_connection_status",
    ),
  ).toHaveLength(before);
  await panel
    .getByRole("button", { name: "Check connection", exact: true })
    .click();
  await expect(panel.getByRole("status")).toHaveText(
    "Connection checked. Not connected",
  );
  await page.evaluate(() => {
    (window as any).settingsControls.pluginState = "linked";
    Object.defineProperty(document, "hidden", { value: false });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(panel.getByRole("status")).toContainText("Approved on this Mac");
});

test("a manual check joins a pending background check instead of overlapping it", async ({
  page,
}) => {
  const settings = await settingsFixture(page);
  await settings
    .getByRole("button", { name: "Connectors", exact: true })
    .click();
  const panel = page.locator('.settings-panel[data-section="connections"]');
  await expect(panel.getByRole("status")).toHaveText("Not connected");
  const calls = () =>
    settingsCalls(page).then(
      (values) =>
        values.filter(({ command }) => command === "plugin_connection_status")
          .length,
    );
  const before = await calls();
  await page.evaluate(() => {
    (window as any).settingsControls.pluginStatusDelay = 1000;
    window.dispatchEvent(new Event("focus"));
  });
  await expect.poll(calls).toBe(before + 1);
  await panel
    .getByRole("button", { name: "Check connection", exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "Checking…", exact: true }),
  ).toBeDisabled();
  await expect(panel.getByRole("status")).toHaveText(
    "Connection checked. Not connected",
  );
  expect(await calls()).toBe(before + 1);
});

test("checks discard an old service response before loading the new service", async ({
  page,
}) => {
  const settings = await settingsFixture(page);
  await settings
    .getByRole("button", { name: "Connectors", exact: true })
    .click();
  const panel = page.locator('.settings-panel[data-section="connections"]');
  await expect(panel.getByRole("status")).toHaveText("Not connected");
  await page.evaluate(() => {
    (window as any).settingsControls.pluginStatusDelay = 2000;
    window.dispatchEvent(new Event("focus"));
    (window as any).settingsState.config.apiUrl = "https://other.example";
    (window as any).settingsEmit("workspace-changed", null);
  });
  await expect(
    panel.getByText("https://other.example", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText("https://test.orka", { exact: true }),
  ).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "Check connection", exact: true }),
  ).toBeEnabled();
});

test("one assistant connection shows its active sessions and revokes them together", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 640 });
  const settings = await settingsFixture(page, {
    pluginClientName: "Codex",
    pluginSessionCount: 5,
  });
  await page.evaluate(() => {
    (window as any).settingsControls.pluginState = "linked";
  });
  await settings
    .getByRole("button", { name: "Connectors", exact: true })
    .click();
  const panel = page.locator('.settings-panel[data-section="connections"]');
  const connections = panel.getByRole("region", { name: "Connector sessions" });
  await expect(
    connections.getByRole("heading", { name: "Codex", exact: true }),
  ).toHaveCount(1);
  await expect(
    connections.getByText("5 active sessions", { exact: true }),
  ).toBeVisible();
  await expect(
    connections.getByRole("button", { name: "Revoke access" }),
  ).toHaveCount(1);
  await connections.getByRole("button", { name: "Revoke access" }).click();
  await expect(
    connections.getByText("Reconnect required", { exact: true }),
  ).toBeVisible();
  await expect(
    connections.getByText("5 active sessions", { exact: true }),
  ).toHaveCount(0);
  await expect(
    connections.getByRole("button", { name: "Revoke access" }),
  ).toHaveCount(0);
  await expect(panel.getByRole("status")).toHaveText("Reconnect required");
  expect(
    (await settingsCalls(page)).filter(
      ({ command, args }) =>
        command === "plugin_authorization" && args.operation === "revoke",
    ),
  ).toHaveLength(1);
});

test("an idle assistant approval stays revocable without claiming an active connection", async ({
  page,
}) => {
  const settings = await settingsFixture(page, {
    pluginClientName: "Codex",
    pluginRemembered: true,
  });
  await page.evaluate(() => {
    (window as any).settingsControls.pluginState = "idle";
  });
  await settings
    .getByRole("button", { name: "Connectors", exact: true })
    .click();
  const panel = page.locator('.settings-panel[data-section="connections"]');
  const connections = panel.getByRole("region", { name: "Connector sessions" });
  await expect(panel.getByRole("status")).toHaveText("Not connected");
  await expect(
    connections.getByText("No active sessions", { exact: true }),
  ).toBeVisible();
  await expect(
    connections.getByText("0 active sessions", { exact: true }),
  ).toHaveCount(0);
  await expect(
    connections.getByText("Access saved for next time"),
  ).toBeVisible();
  await expect(connections.getByText("Read · Write · Manage")).toBeVisible();
  await capture(page, "idle");
  await connections.getByRole("button", { name: "Revoke access" }).click();
  await expect(connections).toHaveCount(0);
  await expect(panel.getByRole("status")).toHaveText("Not connected");
});

test("long connector identities scroll inside consent without moving its actions", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 640 });
  await settingsFixture(page, {
    pluginClientName:
      "Fixture Assistant with a long organization and workspace name for account approval",
  });
  await page.evaluate(() => {
    (window as any).settingsProfile.displayName =
      "Morgan Taylor with a long readable account name";
    (window as any).settingsProfile.email =
      "morgan.taylor.with.a.long.account.name@example.com";
  });
  const dialog = await openConnection(page);
  await expect(
    dialog.getByRole("heading", { name: /^Fixture Assistant/ }),
  ).toBeVisible();
  const footer = await dialog.locator("footer").boundingBox();
  await dialog.locator(".connector-consent-note").scrollIntoViewIfNeeded();
  expect(await dialog.locator("footer").boundingBox()).toEqual(footer);
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await expect(
    dialog.getByRole("button", { name: "Allow connection", exact: true }),
  ).toBeInViewport({ ratio: 1 });
  expect(
    (await new AxeBuilder({ page }).include(".plugin-authorization").analyze())
      .violations,
  ).toEqual([]);
});

test("connector scopes can narrow consent and approved sessions can be revoked", async ({
  page,
}) => {
  await settingsFixture(page);
  const dialog = await openConnection(page);
  const checks = dialog.getByRole("checkbox");
  await expect(checks).toHaveCount(3);
  await expect(checks.nth(0)).toBeDisabled();
  const permission = dialog.locator(".connector-permission").first();
  const box = await permission.locator("input").boundingBox();
  const label = await permission.locator("span").boundingBox();
  expect(label!.x).toBeGreaterThan(box!.x + box!.width);
  expect(Math.abs(label!.y - box!.y)).toBeLessThan(4);
  await checks.nth(1).uncheck();
  await checks.nth(2).uncheck();
  await dialog
    .getByRole("button", { name: "Allow connection", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText("Connection approved");
  expect(
    (await settingsCalls(page)).find(
      ({ command, args }) =>
        command === "plugin_authorization" && args.operation === "approve",
    )?.args.input,
  ).toEqual({ requestId: "fixture-request", scopes: ["orka.read"] });
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  const panel = page.locator('.settings-panel[data-section="connections"]');
  await expect(
    panel.getByRole("button", { name: "Revoke access" }),
  ).toBeVisible();
  await capture(page, "sessions");
  await panel.getByRole("button", { name: "Revoke access" }).click();
  await expect(panel.getByRole("status")).toHaveText("Reconnect required");
  expect(
    (await settingsCalls(page)).find(
      ({ command, args }) =>
        command === "plugin_authorization" && args.operation === "revoke",
    )?.args.input,
  ).toEqual({ connectionId: "fixture-connection" });
});

test("legacy plugin links cannot create approval and Connectors opens without account parameters", async ({
  page,
}) => {
  await settingsFixture(page);
  await page.evaluate(() => {
    (window as any).settingsControls.pluginCallback =
      "orka://mcp/authorize?handoff=old&service=https://other.example";
  });
  await page.waitForTimeout(1300);
  await expect(
    page.getByRole("dialog", { name: "Connect to Orka", exact: true }),
  ).toHaveCount(0);
  expect(
    (await settingsCalls(page)).filter(
      ({ command }) => command === "plugin_authorization",
    ),
  ).toHaveLength(0);
  await page.evaluate(() => {
    (window as any).settingsControls.pluginCallback = "orka://connectors";
  });
  await expect(
    page.locator('.settings-panel[data-section="connections"]'),
  ).toBeVisible();
});
