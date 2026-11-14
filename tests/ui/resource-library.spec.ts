import { test, expect } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { readFileSync } from "node:fs";
import {
  resourceLibraryFixture,
  type LibraryWindow,
} from "./fixtures/resource-library.js";

const kinds = [
  { kind: "memory", label: "Memories" },
  { kind: "session", label: "Sessions" },
  { kind: "plan", label: "Plans" },
] as const;

for (const width of [1160, 900]) {
  test(`session identities and quiet ownership tabs align at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await resourceLibraryFixture(page);
    await page.getByRole("button", { name: /^Sessions/ }).click();
    const table = page.getByRole("table");
    await expect(table.locator("tbody tr")).toHaveCount(4);
    const local = table.locator("tr").filter({
      has: page.getByRole("button", {
        name: "Private session notes",
        exact: true,
      }),
    });
    await expect(local).toContainText("Local Only");
    await expect(table).not.toContainText("On this Mac");
    await expect(
      table.locator(".resource-source-pill, .resource-table-author"),
    ).toHaveCount(0);
    const identity = local.getByRole("img", {
      name: "Codex · You",
      exact: true,
    });
    await expect(
      identity.locator(".session-identity-avatar img"),
    ).toBeVisible();
    const geometry = await local.evaluate((row) => {
      const tool = row.querySelector(".session-identity-tool")!;
      const avatar = row.querySelector(".session-identity-avatar")!;
      const toolBox = tool.getBoundingClientRect();
      const avatarBox = avatar.getBoundingClientRect();
      return {
        height: row.getBoundingClientRect().height,
        overlap: toolBox.right - avatarBox.left,
        toolLeft: toolBox.left < avatarBox.left,
        front: Number(getComputedStyle(tool).zIndex),
        cells: row.children.length,
      };
    });
    expect(geometry).toEqual({
      height: 56,
      overlap: 9,
      toolLeft: true,
      front: 1,
      cells: 5,
    });
    await identity.hover();
    await expect(identity.locator('[role="tooltip"]')).toHaveText(
      "Codex · You",
    );
    await expect(identity.locator('[role="tooltip"]')).toBeVisible();
    const tooltipBox = (await identity
      .locator('[role="tooltip"]')
      .boundingBox())!;
    await page.mouse.move(
      tooltipBox.x + tooltipBox.width / 2,
      tooltipBox.y + tooltipBox.height / 2,
      { steps: 60 },
    );
    await expect(identity.locator('[role="tooltip"]')).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(identity.locator('[role="tooltip"]')).toHaveCount(0);
    await page.mouse.move(0, 0);
    await local.locator(".resource-table-open").focus();
    await page.keyboard.press("Tab");
    await expect(identity).toBeFocused();
    await expect(identity.locator('[role="tooltip"]')).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(identity).toBeFocused();
    await expect(identity.locator('[role="tooltip"]')).toHaveCount(0);
    const teammate = table.getByRole("img", {
      name: "Claude · Mira",
      exact: true,
    });
    await expect(
      teammate.locator(".session-identity-avatar svg"),
    ).toBeVisible();
    const tabs = page.getByRole("group", { name: "Filter by ownership" });
    const all = tabs.getByRole("button", { name: "All sessions", exact: true });
    await expect(all).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    expect(
      await all.evaluate(
        (button) => getComputedStyle(button, "::after").height,
      ),
    ).toBe("2px");
    await tabs
      .getByRole("button", { name: "Shared with me", exact: true })
      .click();
    await expect(table.locator("tbody tr")).toHaveCount(1);
    await expect(teammate).toBeVisible();
    const results = await new AxeBuilder({ page })
      .include(".resource-index")
      .analyze();
    expect(results.violations).toEqual([]);
    await page.getByRole("button", { name: /^Memories/ }).click();
    await expect(
      tabs.getByRole("button", { name: "All memories", exact: true }),
    ).toBeVisible();
  });
}

test("GitHub teammate photos obey the packaged image policy and failures keep a profile icon", async ({
  page,
  baseURL,
}) => {
  const config = JSON.parse(
    readFileSync("apps/mac/src-tauri/tauri.conf.json", "utf8"),
  );
  const imagePolicy = config.app.security.csp
    .split(";")
    .find((directive: string) => directive.trim().startsWith("img-src"));
  const avatar = "https://avatars.githubusercontent.com/u/12345";
  let failAvatar = false;
  await page.route(avatar, async (route) => {
    if (failAvatar) await route.abort();
    else
      await route.fulfill({
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6rS8AAAAASUVORK5CYII=",
          "base64",
        ),
      });
  });
  await page.route(`${baseURL}/`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: {
        ...response.headers(),
        "Content-Security-Policy": imagePolicy,
      },
    });
  });
  await resourceLibraryFixture(page, { teammateAvatar: avatar });
  await page.getByRole("button", { name: /^Sessions/ }).click();
  const identity = page.getByRole("img", {
    name: "Claude · Mira",
    exact: true,
  });
  const photo = identity.locator(".session-identity-avatar img");
  await expect
    .poll(() => photo.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(1);
  await expect(photo).toBeVisible();
  failAvatar = true;
  await page.reload();
  await page.getByRole("button", { name: /^Sessions/ }).click();
  await expect(photo).toBeHidden();
  await expect(identity.locator(".session-identity-avatar svg")).toBeVisible();
});

for (const { kind, label } of kinds) {
  test(`${label} include private content with sharing off and filter by stable ownership`, async ({
    page,
  }) => {
    await resourceLibraryFixture(page);
    await page.getByRole("button", { name: new RegExp(`^${label}`) }).click();
    const ownership = page.getByRole("group", { name: "Filter by ownership" });
    const table = page.getByRole("table");
    await expect(
      ownership.getByRole("button", {
        name:
          kind === "plan"
            ? "All"
            : `All ${kind === "memory" ? "memories" : "sessions"}`,
        exact: true,
      }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      table.getByRole("button", { name: `Private ${kind} notes`, exact: true }),
    ).toBeVisible();
    await expect(table.locator("tbody tr")).toHaveCount(4);
    await ownership.getByRole("button", { name: "Mine", exact: true }).click();
    await expect(table.locator("tbody tr")).toHaveCount(3);
    await expect(table).toContainText(`My shared ${kind}`);
    await expect(table).not.toContainText(`Mira's ${kind}`);
    await ownership
      .getByRole("button", { name: "Shared with me", exact: true })
      .click();
    await expect(table.locator("tbody tr")).toHaveCount(1);
    await expect(table).toContainText(`Mira's ${kind}`);
    if (kind === "session")
      await expect(
        table.getByRole("img", { name: "Claude · Mira", exact: true }),
      ).toBeVisible();
    else await expect(table).toContainText("Owner: Mira");
    await table
      .getByRole("button", { name: `Mira's ${kind}`, exact: true })
      .click();
    await page
      .getByRole("button", { name: `Back to ${label}`, exact: true })
      .click();
    await expect(
      ownership.getByRole("button", { name: "Shared with me", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    const calls = await page.evaluate(
      () => (window as unknown as LibraryWindow).library.calls,
    );
    expect(
      calls.some((call) => call.command === "local_resource_catalog"),
    ).toBe(true);
    expect(
      calls.filter((call) =>
        /^(sync_now|cloud_action|session_action|set_project_sharing)$/.test(
          call.command,
        ),
      ),
    ).toEqual([]);
  });

  test(`${label} private detail remains readable offline without shared history actions`, async ({
    page,
  }) => {
    await resourceLibraryFixture(page);
    await page.getByRole("button", { name: new RegExp(`^${label}`) }).click();
    await page
      .getByRole("button", { name: `Private ${kind} notes`, exact: true })
      .click();
    if (kind === "session")
      await expect(
        page.getByLabel("Conversation", { exact: true }),
      ).toContainText("Private session conversation");
    else
      await expect(
        page.getByRole("article", { name: "Rendered Markdown" }),
      ).toContainText("Local content remains readable offline");
    await expect(
      page.getByRole("group", { name: "Resource facts" }),
    ).toContainText("On this Mac");
    await page
      .getByRole("button", { name: "More resource actions", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Copy link", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", {
        name: "Compare with previous revision",
        exact: true,
      }),
    ).toHaveCount(0);
  });
}

test("ownership composes with repository, provider, and search filters", async ({
  page,
}) => {
  await resourceLibraryFixture(page);
  await page.getByRole("button", { name: /^Sessions/ }).click();
  await page
    .getByRole("group", { name: "Filter by ownership" })
    .getByRole("button", { name: "Mine", exact: true })
    .click();
  await page.getByRole("combobox", { name: "Filter by repository" }).click();
  await page.getByRole("option", { name: "backend", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search sessions" }).fill("notes");
  const table = page.getByRole("table");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table).toContainText("Backend session notes");
  await page
    .getByRole("group", { name: "Filter by source" })
    .getByRole("button", { name: "Codex", exact: true })
    .click();
  await expect(
    page.getByText("No sessions match", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("group", { name: "Filter by ownership" }),
  ).toBeVisible();
});

test("ownership controls remain available in empty collections", async ({
  page,
}) => {
  await resourceLibraryFixture(page, { emptyShared: true, emptyLocal: true });
  await page.getByRole("button", { name: /^Sessions/ }).click();
  const ownership = page.getByRole("group", { name: "Filter by ownership" });
  await expect(ownership.getByRole("button")).toHaveCount(3);
  await ownership
    .getByRole("button", { name: "Shared with me", exact: true })
    .click();
  await expect(page.getByText(/No sessions.*shared with you/i)).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test("a pending local scan does not report an empty collection", async ({
  page,
}) => {
  await resourceLibraryFixture(page, { emptyShared: true, defer: true });
  await page.getByRole("button", { name: /^Sessions/ }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => typeof (window as unknown as LibraryWindow).library.finishCatalog,
      ),
    )
    .toBe("function");
  await expect(page.getByText("No sessions yet.", { exact: true })).toHaveCount(
    0,
  );
  await page.evaluate(() =>
    (window as unknown as LibraryWindow).library.finishCatalog?.(),
  );
  await expect(
    page.getByRole("button", { name: "Private session notes", exact: true }),
  ).toBeVisible();
});

test("refresh failures retain private entries and retry discovery without syncing", async ({
  page,
}) => {
  await resourceLibraryFixture(page);
  await page.getByRole("button", { name: /^Sessions/ }).click();
  const privateItem = page.getByRole("button", {
    name: "Private session notes",
    exact: true,
  });
  await expect(privateItem).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as LibraryWindow).library.failCatalog = true;
  });
  await page
    .getByRole("button", { name: "Refresh local items", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Local folder temporarily unavailable",
  );
  await expect(privateItem).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as LibraryWindow).library.failCatalog = false;
  });
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(privateItem).toBeVisible();
});

test("restricted shared access does not suppress independent local content", async ({
  page,
}) => {
  await resourceLibraryFixture(page, { emptyShared: true, restricted: true });
  await page.getByRole("button", { name: /^Memories/ }).click();
  await expect(
    page.getByRole("button", { name: "Private memory notes", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("group", { name: "Filter by ownership" })
    .getByRole("button", { name: "Shared with me", exact: true })
    .click();
  await expect(
    page.getByText("Access to shared memories is restricted.", { exact: true }),
  ).toBeVisible();
});

test("an account change discards a late private catalog response", async ({
  page,
}) => {
  await page.clock.install();
  await resourceLibraryFixture(page, { emptyShared: true, defer: true });
  await page.getByRole("button", { name: /^Sessions/ }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as LibraryWindow).library.finishCatalogs.length,
      ),
    )
    .toBe(1);
  await page.evaluate(() => {
    (window as unknown as LibraryWindow).library.user = "other-account";
  });
  await page.clock.runFor(3100);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as LibraryWindow).library.finishCatalogs.length,
      ),
    )
    .toBe(2);
  await page.evaluate(() =>
    (window as unknown as LibraryWindow).library.finishCatalogs[0](),
  );
  await expect(
    page.getByRole("button", { name: "Private session notes", exact: true }),
  ).toHaveCount(0);
});

test("new private session turns refresh without a published revision", async ({
  page,
}) => {
  await page.clock.install();
  await resourceLibraryFixture(page);
  await page.getByRole("button", { name: /^Sessions/ }).click();
  await page
    .getByRole("button", { name: "Private session notes", exact: true })
    .click();
  await expect(page.getByLabel("Conversation", { exact: true })).toContainText(
    "Private session conversation 0",
  );
  await page.evaluate(() => {
    (window as unknown as LibraryWindow).library.tail = 1;
  });
  await page.clock.runFor(60_100);
  await expect(page.getByLabel("Conversation", { exact: true })).toContainText(
    "Private session conversation 1",
  );
});

test("configured sync timing refreshes local-only rows without clearing collection counts", async ({
  page,
}) => {
  await page.clock.install();
  await resourceLibraryFixture(page);
  const sessions = page.getByRole("button", { name: /^Sessions/ });
  await sessions.click();
  const table = page.getByRole("table");
  await expect(table.locator("tbody tr")).toHaveCount(4);
  await expect(sessions).toContainText("4");
  const catalogs = () =>
    page.evaluate(() =>
      (window as unknown as LibraryWindow).library.calls.filter(
        (call) => call.command === "local_resource_catalog",
      ),
    );
  await page.evaluate(() => {
    (window as unknown as LibraryWindow).library.syncMinutes = 5;
  });
  await page.clock.runFor(63_100);
  expect(await catalogs()).toHaveLength(1);
  await page.evaluate(() => {
    const library = (window as unknown as LibraryWindow).library;
    library.deferCatalog = true;
    library.syncMinutes = 1;
  });
  await page.clock.runFor(3_100);
  await expect.poll(async () => (await catalogs()).length).toBe(2);
  await expect(table.locator("tbody tr")).toHaveCount(4);
  await expect(sessions).toContainText("4");
  await expect(
    page.getByRole("button", { name: "Private session notes", exact: true }),
  ).toBeEnabled();
  const calls = await page.evaluate(
    () => (window as unknown as LibraryWindow).library.calls,
  );
  expect(
    calls.filter((call) =>
      /^(sync_now|cloud_action|set_project_sharing)$/.test(call.command),
    ),
  ).toEqual([]);
  await page.evaluate(() =>
    (window as unknown as LibraryWindow).library.finishCatalog?.(),
  );
  await expect(table.locator("tbody tr")).toHaveCount(4);
  await expect(sessions).toContainText("4");
});
