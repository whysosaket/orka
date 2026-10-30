import { ENV_ENABLED } from "../../apps/mac/src/lib/features.js";
import { test, expect, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
test.skip(!ENV_ENABLED, "ENV support is temporarily disabled");

const emptySnapshot = {
  user: null,
  config: null,
  projects: [],
  resources: [],
  bindings: [],
  conflicts: [],
  activity: [],
  outbox: [],
  errors: [],
  sync: null,
  daemon: null,
  devices: [],
  deviceId: "",
  background: null,
};

async function fixture(page: Page, supported = true, mode = "normal") {
  await page.addInitScript(
    ({ snapshot, supported, mode }) => {
      const project = "11111111-1111-4111-8111-111111111111",
        user = "22222222-2222-4222-8222-222222222222",
        teammate = "33333333-3333-4333-8333-333333333333";
      const device = {
        id: "device",
        owner: user,
        name: "Test Mac",
        signingKey: "public",
        encryptionKey: "public",
      };
      const setId = "44444444-4444-4444-8444-444444444444";
      let published =
          mode === "needs-response" ||
          mode === "locked" ||
          mode === "governed-reader",
        ignored = false,
        nextDraft = 0;
      const sources = new Map<string, string>();
      let sharedKeys = ["API_KEY", "URL"];
      const calls: { action: string; input: Record<string, unknown> }[] = [];
      Object.assign(window, {
        envCalls: calls,
        isTauri: true,
        __TAURI_INTERNALS__: {
          transformCallback: () => 1,
          unregisterCallback: () => {},
          invoke: async (name: string, args: Record<string, unknown> = {}) => {
            if (name === "snapshot")
              return {
                ...snapshot,
                user,
                config: { apiUrl: "https://env.test", syncMinutes: 15 },
                projects: [
                  {
                    id:
                      mode === "slow" &&
                      calls.some((c) => c.action === "import")
                        ? "55555555-5555-4555-8555-555555555555"
                        : project,
                    name: "ENV project",
                    path: "/test/project",
                    role: "owner",
                    governed: mode === "governed-reader",
                  },
                ],
                daemon: { running: true },
                sync: { online: true },
                deviceId: "device",
              };
            if (name === "sync_progress") return { user, progress: null };
            if (name.startsWith("plugin:")) return null;
            if (name !== "env_command") return {};
            const action = String(args.action),
              input = args.input as Record<string, unknown>;
            calls.push({ action, input });
            const manifest = {
              format: 1,
              projectId: project,
              setId,
              name: "Development",
              creator: mode === "recipient" ? teammate : user,
              revision: 1,
              accessRevision: 1,
              grants: [user, teammate],
              devices: [device],
              approvals: [],
              authorDeviceId: "device",
              previousHash: "",
              ciphertextHash: "hash",
              deleted: false,
            };
            const draft = {
              draftId: "draft",
              projectId: project,
              setId,
              keys: ["API_KEY", "URL"],
              revision: published ? 1 : null,
              manifest: published ? manifest : null,
            };
            if (action === "capabilities") {
              if (
                mode === "offline" &&
                calls.filter((c) => c.action === "capabilities").length === 1
              )
                throw new Error(
                  "Connect to the service to check ENV availability",
                );
              return { supported, enabled: true };
            }
            if (action === "list")
              return {
                sets: published
                  ? [
                      {
                        ...manifest,
                        updatedAt: new Date().toISOString(),
                        updatedBy: user,
                        approved: mode !== "locked",
                        trusted: mode !== "needs-response" && mode !== "locked",
                        ...(mode === "governed-reader"
                          ? {
                              access: { mode: "read", canShare: false },
                              trusted: false,
                            }
                          : {}),
                      },
                    ]
                  : [],
                members: [
                  { id: user, label: "Owner", devices: [device] },
                  { id: teammate, label: "Teammate", devices: [] },
                ],
                device,
                pending:
                  mode === "pending"
                    ? [{ id: "retry-1", setId, name: "Development" }]
                    : [],
              };
            if (action === "import" || action === "pull") {
              if (mode === "publish-pull-failure" && action === "pull")
                throw new Error("ENV service unavailable");
              if (mode === "slow")
                await new Promise((r) => setTimeout(r, 4000));
              draft.draftId = `draft-${++nextDraft}`;
              if (action === "pull") draft.keys = sharedKeys;
              if (
                mode === "stale" &&
                action === "pull" &&
                calls.some(
                  (call) => call.action === "import" && call.input.baseDraft,
                )
              )
                draft.revision = 2;
              sources.set(
                draft.draftId,
                action === "import"
                  ? "UI_CANARY_SECRET"
                  : "UI_REMOTE_CANARY_SECRET",
              );
              return draft;
            }
            if (action === "publish") {
              published = true;
              sharedKeys = input.keys as string[];
              return { setId, revision: 1 };
            }
            if (action === "reveal")
              return { value: sources.get(String(input.draftId)) };
            if (action === "compare")
              return {
                keys: [
                  { key: "API_KEY", local: true, remote: true, changed: true },
                  { key: "URL", local: false, remote: true, changed: true },
                ],
              };
            if (action === "rebase")
              return {
                ...draft,
                draftId: `draft-${++nextDraft}`,
                keys: ["API_KEY"],
              };
            if (action === "preview") {
              if (mode === "held-preview") {
                await new Promise<void>((resolve) => {
                  Object.assign(window, { releaseEnvPreview: resolve });
                });
              }
              return {
                path: mode === "mismatched-preview" ? ".env.other" : input.path,
                ignored,
                keys: (input.keys as string[]).map((key) => ({
                  key,
                  change: "added",
                })),
              };
            }
            if (action === "exclude") {
              ignored = true;
              return {};
            }
            if (action === "request")
              return { code: "ORKA-ENV-REQUEST-1:public-code" };
            return {};
          },
        },
      });
    },
    { snapshot: emptySnapshot, supported, mode },
  );
  await page.goto("/");
  await page.getByRole("button", { name: "ENVs", exact: true }).click();
}

test("ENV keys stay masked and only selected keys and recipients reach publication", async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole("button", { name: "New ENV set" }).first().click();
  await page
    .getByLabel("ENV assignments")
    .fill("API_KEY=UI_CANARY_SECRET\nURL=https://example.test");
  await page.getByRole("button", { name: "Review keys" }).click();
  await page.getByLabel("ENV set name").fill("Development");
  await page
    .getByRole("checkbox", { name: "Teammate Needs to enable ENVs" })
    .check();
  await expect(page.locator("body")).not.toContainText("UI_CANARY_SECRET");
  await page.getByRole("button", { name: "Reveal API_KEY" }).click();
  await expect(page.locator(".env-value").first()).toContainText(
    "UI_CANARY_SECRET",
  );
  await page.getByRole("button", { name: "Hide API_KEY" }).click();
  await expect(page.locator("body")).not.toContainText("UI_CANARY_SECRET");
  await page.getByRole("checkbox", { name: "URL", exact: true }).uncheck();
  await page
    .getByRole("button", { name: "Publish ENV set", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Development", exact: true }),
  ).toBeVisible();
  const publication = await page.evaluate(() => {
    const calls = (
      window as unknown as {
        envCalls: { action: string; input: Record<string, unknown> }[];
      }
    ).envCalls;
    return calls.find((c) => c.action === "publish")?.input;
  });
  expect(publication?.keys).toEqual(["API_KEY"]);
  expect(publication?.grants).toContain("33333333-3333-4333-8333-333333333333");
  expect(JSON.stringify(publication)).not.toContain("UI_CANARY_SECRET");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: "artifacts/env-sharing.png", fullPage: true });
});

test("ENV local apply requires a reviewed preview and Git exclusion", async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole("button", { name: "New ENV set" }).first().click();
  await page
    .getByLabel("ENV assignments")
    .fill("API_KEY=UI_CANARY_SECRET\nURL=https://example.test");
  await page.getByRole("button", { name: "Review keys" }).click();
  await page.getByLabel("ENV set name").fill("Development");
  await page
    .getByRole("button", { name: "Publish ENV set", exact: true })
    .click();
  await page.getByRole("button", { name: "Apply to file" }).click();
  await page.getByRole("button", { name: "Preview changes" }).click();
  await expect(
    page.getByRole("button", { name: "Apply 2 keys" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Exclude this file locally" }).click();
  await expect(
    page.getByRole("button", { name: "Apply 2 keys" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Apply 2 keys" }).click();
  await expect(page.locator("[data-orka-toast] [role=status]")).toContainText(
    "ENV keys applied",
    { timeout: 12000 },
  );
  await expect(page.locator("body")).not.toContainText("UI_CANARY_SECRET");
});

test("older servers disable ENV sharing without affecting project navigation", async ({
  page,
}) => {
  await fixture(page, false);
  await expect(
    page.getByRole("heading", { name: "This service needs an update" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "New ENV set" })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "This service needs an update" }),
  ).toHaveCount(0);
});

test("concurrent ENV changes require choices and reveal each side only on request", async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole("button", { name: "New ENV set" }).first().click();
  await page
    .getByLabel("ENV assignments")
    .fill("API_KEY=UI_CANARY_SECRET\nURL=https://example.test");
  await page.getByRole("button", { name: "Review keys" }).click();
  await page.getByLabel("ENV set name").fill("Development");
  await page
    .getByRole("button", { name: "Publish ENV set", exact: true })
    .click();
  await page.getByRole("button", { name: "Import changes" }).click();
  await page
    .getByLabel("ENV assignments")
    .fill("API_KEY=UI_CANARY_SECRET\nURL=https://example.test");
  await page.getByRole("button", { name: "Review keys" }).click();
  await page.getByRole("checkbox", { name: "URL", exact: true }).uncheck();
  await page.getByRole("button", { name: "More resource actions" }).click();
  await page.getByRole("button", { name: "Compare latest" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).not.toContainText("CANARY_SECRET");
  await expect(
    dialog.getByRole("button", { name: "Use reviewed choices" }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "Reveal my draft API_KEY" }).click();
  await expect(dialog).toContainText("UI_CANARY_SECRET");
  await dialog
    .getByRole("button", { name: "Reveal latest shared API_KEY" })
    .click();
  await expect(dialog).toContainText("UI_REMOTE_CANARY_SECRET");
  await expect(dialog).not.toContainText("UI_CANARY_SECRET");
  await dialog.getByLabel("Version for API_KEY").selectOption("local");
  await expect(
    dialog.getByRole("button", { name: "Use reviewed choices" }),
  ).toBeDisabled();
  await expect(
    dialog.getByLabel("Version for URL").locator('option[value="local"]'),
  ).toHaveCount(0);
  await dialog.getByLabel("Version for URL").selectOption("omit");
  await dialog.getByRole("button", { name: "Use reviewed choices" }).click();
  await expect(page.locator("[data-orka-toast] [role=status]")).toContainText(
    "Reviewed draft ready",
  );
  await expect(
    page.getByRole("checkbox", { name: "URL", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("CANARY_SECRET");
  const resolution = await page.evaluate(() =>
    (
      window as unknown as {
        envCalls: { action: string; input: Record<string, unknown> }[];
      }
    ).envCalls.filter((c) => c.action === "rebase" || c.action === "compare"),
  );
  expect(resolution.map((c) => c.input.keys)).toEqual([
    ["API_KEY"],
    ["API_KEY"],
  ]);
});

for (const viewport of [
  { width: 1160, height: 800 },
  { width: 900, height: 640 },
]) {
  test(`ENV layout and keyboard at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await fixture(page);
    await page.getByRole("button", { name: "New ENV set" }).first().click();
    await page
      .getByLabel("ENV assignments")
      .fill("API_KEY=UI_CANARY_SECRET\nURL=https://example.test");
    await page.getByRole("button", { name: "Review keys" }).click();
    await page.getByLabel("ENV set name").fill("Development");
    await page
      .getByRole("button", { name: "Publish ENV set", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Apply to file" }),
    ).toBeEnabled();
    await expect(
      page.getByRole("heading", { name: "Development", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      await page
        .locator(".env-detail")
        .evaluate((e) => e.getBoundingClientRect().width),
    ).toBeLessThanOrEqual(870);
    expect(
      await page
        .locator(".env-value")
        .first()
        .evaluate((e) => getComputedStyle(e).fontFamily),
    ).toContain("Inter Variable");
    await page.screenshot({ path: `artifacts/env-${viewport.width}.png` });
    await page.getByRole("button", { name: "Reveal API_KEY" }).click();
    await expect(page.locator("body")).toContainText("UI_REMOTE_CANARY_SECRET");
    await page.getByRole("button", { name: "Apply to file" }).click();
    await expect(page.locator("body")).not.toContainText(
      "UI_REMOTE_CANARY_SECRET",
    );
    await page.getByRole("dialog").press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Apply to file" }),
    ).toBeFocused();
    await page.getByRole("button", { name: "Home", exact: true }).click();
    await expect(page.locator("body")).not.toContainText(
      "UI_REMOTE_CANARY_SECRET",
    );
    const cleared = await page.evaluate(() =>
      (window as any).envCalls.some((c: any) => c.action === "clear"),
    );
    expect(cleared).toBe(true);
  });
}

test("capability failures are retryable and distinct from empty", async ({
  page,
}) => {
  await fixture(page, true, "offline");
  await expect(page.getByRole("alert")).toContainText("Connect to the service");
  await expect(
    page.getByText("No shared ENV sets yet.", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Retry connection" }).click();
  await expect(
    page.getByText("No shared ENV sets yet.", { exact: true }),
  ).toBeVisible();
});
test("unconfirmed publication has scoped retry and discard actions", async ({
  page,
}) => {
  await fixture(page, true, "pending");
  await expect(
    page.getByText("Unconfirmed publication:", { exact: false }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Discard retry", exact: true })
    .click();
  expect(
    await page.evaluate(
      () =>
        (window as any).envCalls.find((c: any) => c.action === "discard").input,
    ),
  ).toEqual({ pendingId: "retry-1" });
});
async function publishedFixture(page: Page, mode = "normal") {
  await fixture(page, true, mode);
  await page.getByRole("button", { name: "New ENV set" }).first().click();
  await page.getByLabel("ENV assignments").fill("API_KEY=UI_CANARY_SECRET");
  await page.getByRole("button", { name: "Review keys" }).click();
  await page.getByLabel("ENV set name").fill("Development");
  await page
    .getByRole("button", { name: "Publish ENV set", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Apply to file" }),
  ).toBeEnabled();
}
test("reveal hides on blur, timeout and selection; collapsed rail keeps ENVs", async ({
  page,
}) => {
  await publishedFixture(page);
  await page.getByRole("button", { name: "Reveal API_KEY" }).click();
  await expect(page.locator("body")).toContainText("UI_REMOTE_CANARY_SECRET");
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(page.locator("body")).not.toContainText(
    "UI_REMOTE_CANARY_SECRET",
  );
  await page.clock.install();
  await page.getByRole("button", { name: "Reveal API_KEY" }).click();
  await expect(page.locator("body")).toContainText("UI_REMOTE_CANARY_SECRET");
  await page.clock.fastForward(30_001);
  await expect(page.locator("body")).not.toContainText(
    "UI_REMOTE_CANARY_SECRET",
  );
  await page.getByRole("button", { name: "Reveal API_KEY" }).click();
  await page.getByRole("checkbox", { name: "API_KEY", exact: true }).uncheck();
  await expect(page.locator("body")).not.toContainText(
    "UI_REMOTE_CANARY_SECRET",
  );
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(
    page.getByRole("button", { name: "ENVs", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Expand sidebar" }),
  ).toBeVisible();
});
test("project changes during import clear drafts and suppress stale results", async ({
  page,
}) => {
  await fixture(page, true, "slow");
  await page.getByRole("button", { name: "New ENV set" }).first().click();
  await page.getByLabel("ENV assignments").fill("API_KEY=UI_CANARY_SECRET");
  await page.getByRole("button", { name: "Review keys" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 10000 });
  await expect(
    page.getByText("No shared ENV sets yet.", { exact: true }),
  ).toBeVisible({ timeout: 10000 });
  await expect(page.getByLabel("ENV set name")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("UI_CANARY_SECRET");
  expect(
    await page.evaluate(() =>
      (window as any).envCalls.some((c: any) => c.action === "clear"),
    ),
  ).toBe(true);
});
test("recipient cannot change grants or delete a set", async ({ page }) => {
  await publishedFixture(page, "recipient");
  await page.getByRole("button", { name: "More resource actions" }).click();
  await expect(
    page.getByRole("button", { name: "Delete set", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Manage access" }).click();
  for (const checkbox of await page
    .getByRole("group", { name: "Recipients · everyone selected can publish" })
    .getByRole("checkbox")
    .all())
    await expect(checkbox).toBeDisabled();
});

test("approved set keeps response entry available before pull and after unlock", async ({
  page,
}) => {
  await publishedFixture(page);
  await page
    .getByRole("complementary", { name: "ENV sets" })
    .getByRole("button", { name: /Development/ })
    .click();
  await expect(
    page.getByText("This Mac approved", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Enter approval response", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Unlock this Mac" }),
  ).toBeVisible();
  await expect(page.getByLabel("Response code")).toBeFocused();
  await page.getByRole("dialog").press("Escape");
  await page.getByRole("button", { name: "Pull latest", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Apply to file" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "More resource actions" }).click();
  await page
    .getByRole("button", { name: "Enter approval response", exact: true })
    .click();
  await expect(page.getByLabel("Response code")).toBeVisible();
});

for (const mode of ["held-preview", "mismatched-preview"]) {
  test(`ENV destination stays bound to its reviewed preview: ${mode}`, async ({
    page,
  }) => {
    await fixture(page, true, mode);
    await page.getByRole("button", { name: "New ENV set" }).first().click();
    await page.getByLabel("ENV assignments").fill("API_KEY=UI_CANARY_SECRET");
    await page.getByRole("button", { name: "Review keys" }).click();
    await page.getByLabel("ENV set name").fill("Development");
    await page
      .getByRole("button", { name: "Publish ENV set", exact: true })
      .click();
    await page.getByRole("button", { name: "Apply to file" }).click();
    const destination = page.getByLabel("File inside this project");
    await page.getByRole("button", { name: "Preview changes" }).click();
    if (mode === "mismatched-preview") {
      await expect(
        page.getByRole("button", { name: "Preview changes" }),
      ).toBeEnabled();
      await expect(
        page.getByRole("button", { name: /^Apply \d+ keys$/ }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Exclude this file locally" }),
      ).toHaveCount(0);
      return;
    }
    const release = async () => {
      await expect
        .poll(() =>
          page.evaluate(() =>
            Boolean(
              (window as unknown as { releaseEnvPreview?: () => void })
                .releaseEnvPreview,
            ),
          ),
        )
        .toBe(true);
      await page.evaluate(() => {
        const w = window as unknown as { releaseEnvPreview?: () => void };
        w.releaseEnvPreview!();
        delete w.releaseEnvPreview;
      });
    };
    await expect(destination).toBeDisabled();
    await release();
    await expect(destination).toBeEnabled();
    await destination.fill(".env.production");
    await expect(
      page.getByRole("button", { name: /^Apply \d+ keys$/ }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Preview changes" }).click();
    await expect(destination).toBeDisabled();
    await release();
    await page
      .getByRole("button", { name: "Exclude this file locally" })
      .click();
    await expect(destination).toBeDisabled();
    await release();
    await page.getByRole("button", { name: "Apply 2 keys" }).click();
    await expect(page.locator("[data-orka-toast] [role=status]")).toContainText(
      "ENV keys applied",
      { timeout: 12000 },
    );
    const calls = await page.evaluate(
      () =>
        (
          window as unknown as {
            envCalls: { action: string; input: Record<string, unknown> }[];
          }
        ).envCalls,
    );
    expect(
      calls.filter((c) => c.action === "preview").map((c) => c.input.path),
    ).toEqual([".env.local", ".env.production", ".env.production"]);
    expect(calls.filter((c) => c.action === "apply")).toHaveLength(1);
  });
}

test("the ENV set search keeps its inset and divider", async ({ page }) => {
  await fixture(page);
  const search = page.locator(".env-list-search");
  await expect(
    search.getByRole("searchbox", { name: "Search ENV sets" }),
  ).toBeVisible();
  await expect(search).toHaveCSS("padding-top", "12px");
  await expect(search).toHaveCSS("padding-left", "12px");
  await expect(search).toHaveCSS("border-bottom-width", "1px");
  await expect(search).toHaveCSS("border-bottom-style", "solid");
});

test("device approval stays bound to the reviewed request", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    const w = window as any;
    const original = w.__TAURI_INTERNALS__.invoke;
    w.approvalReviewedCodes = [];
    w.approvalSubmittedCodes = [];
    w.__TAURI_INTERNALS__.invoke = async (name: string, args: any) => {
      if (name === "env_command" && args.action === "approval_info") {
        w.approvalReviewedCodes.push(args.input.code);
        await new Promise<void>((resolve) => {
          w.releaseApprovalInfo = resolve;
        });
        return {
          projectId: "11111111-1111-4111-8111-111111111111",
          setId: "44444444-4444-4444-8444-444444444444",
          device: {
            id: "mac-a",
            name: "Reviewed Mac A",
            owner: "33333333-3333-4333-8333-333333333333",
          },
        };
      }
      if (name === "env_command" && args.action === "approve") {
        w.approvalSubmittedCodes.push(args.input.code);
        return { setId: "44444444-4444-4444-8444-444444444444" };
      }
      return original(name, args);
    };
  });
  await page
    .getByRole("button", { name: "Approve a Mac", exact: true })
    .click();
  const code = page.getByRole("textbox", { name: "Request code", exact: true });
  await code.fill("request-code-A");
  await page
    .getByRole("button", { name: "Review device", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).releaseApprovalInfo))
    .toBe("function");
  await expect(code).toBeDisabled();
  await page.evaluate(() => (window as any).releaseApprovalInfo());
  await expect(page.locator(".env-approval-review")).toContainText(
    "Reviewed Mac A",
  );
  await expect(code).toBeEnabled();
  await code.fill("request-code-B");
  await expect(page.locator(".env-approval-review")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Approve this device", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Review device", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => (window as any).approvalReviewedCodes))
    .toEqual(["request-code-A", "request-code-B"]);
  await page.evaluate(() => (window as any).releaseApprovalInfo());
  await page
    .getByRole("button", { name: "Approve this device", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => (window as any).approvalSubmittedCodes))
    .toEqual(["request-code-B"]);
});

test("approved Macs without local trust are guided to enter the response", async ({
  page,
}) => {
  await fixture(page, true, "needs-response");
  await page
    .getByRole("complementary", { name: "ENV sets" })
    .getByRole("button", { name: /Development/ })
    .click();
  await expect(
    page.getByText(
      "Your Mac was approved, but it still needs the response code from the approving Mac before it can decrypt this set.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Pull latest", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Enter approval response", exact: true })
    .click();
  await expect(page.getByLabel("Response code")).toBeFocused();
});

test("governed ENV readers see pending trust separately from publishing access", async ({
  page,
}) => {
  await fixture(page, true, "governed-reader");
  await page
    .getByRole("complementary", { name: "ENV sets" })
    .getByRole("button", { name: /Development/ })
    .click();
  await expect(
    page.getByText("Awaiting trusted device", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/Local dotenv overrides remain writable/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Request publishing access",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Enter approval response", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Publish", exact: true }),
  ).toHaveCount(0);
});

test("request code dialog leads directly to entering the approval response", async ({
  page,
}) => {
  await fixture(page, true, "locked");
  await page
    .getByRole("complementary", { name: "ENV sets" })
    .getByRole("button", { name: /Development/ })
    .click();
  await page
    .getByRole("button", { name: "Request approval", exact: true })
    .click();
  await expect(page.getByLabel("Approval code", { exact: true })).toHaveValue(
    /^ORKA-ENV-REQUEST/,
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Enter approval response" })
    .click();
  await expect(page.getByLabel("Response code")).toBeFocused();
});

test("starting another set protects the unpublished draft and its selections", async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole("button", { name: "New ENV set" }).first().click();
  await page
    .getByLabel("ENV assignments")
    .fill("API_KEY=UI_CANARY_SECRET\nURL=https://example.test");
  await page.getByRole("button", { name: "Review keys" }).click();
  await page.getByLabel("ENV set name").fill("Unpublished work");
  await page.getByRole("checkbox", { name: "URL", exact: true }).uncheck();
  await page.getByRole("button", { name: "New ENV set" }).first().click();
  await expect(
    page.getByRole("dialog", { name: "Discard unpublished changes?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Keep editing" }).click();
  await expect(page.getByLabel("ENV set name")).toHaveValue("Unpublished work");
  await expect(
    page.getByRole("checkbox", { name: "URL", exact: true }),
  ).not.toBeChecked();
  expect(
    await page.evaluate(() =>
      (window as any).envCalls.filter((c: any) => c.action === "discard"),
    ),
  ).toHaveLength(0);
  await page.getByRole("button", { name: "New ENV set" }).first().click();
  await page.getByRole("button", { name: "Discard and continue" }).click();
  await expect(
    page.getByRole("dialog", { name: "Import environment variables" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      (window as any).envCalls.filter((c: any) => c.action === "discard"),
    ),
  ).toHaveLength(1);
});

for (const mode of ["normal", "stale"]) {
  test(`publication reviews changes and routes newer versions to conflict resolution: ${mode}`, async ({
    page,
  }) => {
    await publishedFixture(page, mode);
    await page
      .getByRole("button", { name: "Import changes", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toContainText(
      "Keys missing from this import will be removed",
    );
    await page.getByLabel("ENV assignments").fill("API_KEY=UI_CANARY_SECRET");
    await page.getByRole("button", { name: "Review keys" }).click();
    await page.getByRole("checkbox", { name: "URL", exact: true }).uncheck();
    await page
      .getByRole("button", { name: "Publish version", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    expect(
      await page.evaluate(() =>
        (window as any).envCalls.filter((c: any) => c.action === "publish"),
      ),
    ).toHaveLength(1);
    await expect(dialog).not.toContainText("CANARY_SECRET");
    if (mode === "stale") {
      await expect(dialog).toHaveAccessibleName("Review concurrent changes");
      await expect(
        dialog.getByRole("button", { name: "Use reviewed choices" }),
      ).toBeDisabled();
    } else {
      await expect(dialog).toHaveAccessibleName("Review publication");
      await expect(
        dialog.getByRole("list", { name: "Publication changes" }),
      ).toContainText("URLRemove from shared set");
      await expect(dialog).toContainText("Update value");
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.screenshot({ path: "artifacts/env-publication-review.png" });
      await dialog.getByRole("button", { name: "Back to draft" }).click();
      await expect(
        page.getByRole("checkbox", { name: "URL", exact: true }),
      ).not.toBeChecked();
      await page
        .getByRole("button", { name: "Publish version", exact: true })
        .click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Publish version", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "Apply to file" }),
      ).toBeEnabled();
      expect(
        await page.evaluate(() =>
          (window as any).envCalls.filter((c: any) => c.action === "publish"),
        ),
      ).toHaveLength(2);
    }
  });
}

test("a failed pull after confirmed publication cannot publish the old draft again", async ({
  page,
}) => {
  await fixture(page, true, "publish-pull-failure");
  await page.getByRole("button", { name: "New ENV set" }).first().click();
  await page.getByLabel("ENV assignments").fill("API_KEY=UI_CANARY_SECRET");
  await page.getByRole("button", { name: "Review keys" }).click();
  await page.getByLabel("ENV set name").fill("Development");
  await page
    .getByRole("button", { name: "Publish ENV set", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("Publication succeeded");
  await expect(
    page.getByRole("button", { name: "Publish ENV set", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Pull latest", exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(() =>
      (window as any).envCalls.filter((c: any) => c.action === "publish"),
    ),
  ).toHaveLength(1);
});
