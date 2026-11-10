import { test, expect, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

async function fixture(
  page: Page,
  signedIn = false,
  options: {
    fresh?: boolean;
    passwordOnly?: boolean;
    password?: boolean;
    emailCode?: boolean;
    failConfigure?: boolean;
    authDisabled?: boolean;
    deepLink?: string;
    keychain?: "locked" | "denied";
  } = {},
) {
  await page.addInitScript(
    ({ signedIn, options }) => {
      const saved = {
        apiUrl: "https://cloud.example.test",
        mode: "cloud",
        cloudUrl: "https://cloud.example.test",
        selfHostedUrl: "",
        syncMinutes: 15,
      };
      let config =
        JSON.parse(sessionStorage.getItem("fixture-config") ?? "null") ??
        (options.fresh ? null : saved);
      let user: string | null = signedIn ? "user" : null;
      let authLink: string | null = null;
      const calls: { command: string; args: Record<string, any> }[] = [];
      Object.assign(window, {
        authCalls: calls,
        deliverAuthLink: (link: string) => {
          authLink = link;
        },
        failConfigure: options.failConfigure,
        isTauri: true,
        __TAURI_INTERNALS__: {
          transformCallback: () => 1,
          unregisterCallback: () => {},
          invoke: async (command: string, args: Record<string, any> = {}) => {
            if (command === "snapshot")
              return {
                user,
                profile: "default",
                config,
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
                deviceId: "device",
                background: false,
              };
            if (command === "plugin:deep-link|get_current")
              return options.deepLink ? [options.deepLink] : [];
            if (command === "onboarding_command")
              return {
                displayName: "Test User",
                jobRole: "",
                email: "person@example.test",
              };
            if (command.startsWith("plugin:")) return null;
            calls.push({ command, args });
            if (command === "auth_capabilities") {
              if (args.apiUrl.includes("offline"))
                throw new Error("Cannot reach this service");
              return {
                version: 1,
                auth: {
                  github: !options.passwordOnly,
                  magicLink: !options.passwordOnly,
                  emailCode: options.emailCode,
                  password: options.password ?? true,
                  ...(options.authDisabled && {
                    github: false,
                    magicLink: false,
                    password: false,
                  }),
                },
              };
            }
            if (command === "pending_email_sign_in") {
              const pending = JSON.parse(
                sessionStorage.getItem("fixture-pending-sign-in") ?? "null",
              );
              return pending?.apiUrl === config?.apiUrl ? pending : null;
            }
            if (command === "begin_sign_in" && args.method === "magic-link")
              sessionStorage.setItem(
                "fixture-pending-sign-in",
                JSON.stringify({ email: args.email, apiUrl: config?.apiUrl }),
              );
            if (command === "cancel_sign_in")
              sessionStorage.removeItem("fixture-pending-sign-in");
            if (command === "configure") {
              if ((window as any).failConfigure)
                throw new Error("Could not save your connection");
              config = args.config;
              sessionStorage.setItem("fixture-config", JSON.stringify(config));
            }
            if (command === "switch_service") {
              config = args.config;
              user = null;
            }
            if (command === "profile_events") {
              const link = authLink;
              authLink = null;
              return link;
            }
            if (command === "complete_sign_in") {
              if (args.callback === null && options.emailCode) {
                if (args.code !== "123456")
                  throw new Error(
                    "Incorrect or expired code. Try again or resend email.",
                  );
              } else if (
                args.code !== null ||
                args.callback !==
                  "orka://auth/callback?code=11111111-1111-4111-8111-111111111111"
              )
                throw new Error("Sign-in link expired. Request a new link.");
              if (options.keychain)
                throw new Error(
                  options.keychain === "locked"
                    ? "Keychain unavailable: interaction not allowed"
                    : "Keychain unavailable: access denied",
                );
              sessionStorage.removeItem("fixture-pending-sign-in");
              user = "user";
            }
            if (command === "retry_sign_in_storage") {
              user = "user";
              return { signedIn: true };
            }
            if (command === "sign_in") user = "user";
            if (command === "sign_out") user = null;
            return {};
          },
        },
      });
    },
    { signedIn, options },
  );
  await page.goto("/");
}
const calls = (page: Page) =>
  page.evaluate(
    () =>
      (window as any).authCalls as {
        command: string;
        args: Record<string, any>;
      }[],
  );

async function followMagicLink(page: Page, expired = false) {
  await expect(
    page.getByRole("button", { name: "Use a code", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Email code")).toHaveCount(0);
  await page.evaluate((expired) => {
    (window as any).deliverAuthLink(
      `orka://auth/callback?code=${expired ? "22222222-2222-4222-8222-222222222222" : "11111111-1111-4111-8111-111111111111"}`,
    );
  }, expired);
}

async function openEmailSignIn(page: Page) {
  await expect(page.locator(".onboarding-entry__sign-in")).toBeEnabled();
  if (
    await page
      .getByRole("heading", { name: "Welcome back to Orka" })
      .isVisible()
  )
    return;
  await page.getByRole("button", { name: /^Sign In$/ }).click();
}

async function checkEntryAccessibility(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  // Pratham chose Figma's exact #626262 OR label on October 23, 2026.
  // Keep this single contrast exception visible; all other checks stay strict.
  const unexpected = violations.flatMap((violation) =>
    violation.nodes
      .filter(
        (node) =>
          !(
            violation.id === "color-contrast" &&
            node.target.length === 1 &&
            node.target[0] === ".onboarding-entry__divider > span"
          ),
      )
      .map((node) => ({ id: violation.id, node })),
  );
  expect(unexpected).toEqual([]);
  await expect(page.locator(".onboarding-entry__divider > span")).toHaveCSS(
    "color",
    "rgb(98, 98, 98)",
  );
}

test("Cloud entry matches the design geometry and uses local assets", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await fixture(page, false, { fresh: true, password: false });
  await expect(
    page.getByRole("button", { name: "Continue with GitHub" }),
  ).toBeEnabled();
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByLabel("Email", { exact: true })).toHaveCSS(
    "font-size",
    "16px",
  );
  await expect(
    page.locator(".onboarding-entry__field .ui-field__label"),
  ).toHaveCSS("color", "rgb(242, 242, 242)");
  const card = await page.locator(".onboarding-entry__card").boundingBox();
  expect(card?.x).toBeCloseTo(480, 0);
  expect(card?.y).toBeCloseTo(105, 0);
  expect(card?.width).toBe(480);
  expect(card?.height).toBeCloseTo(564, 1);
  const logo = await page
    .getByRole("img", { name: "Orka", exact: true })
    .boundingBox();
  expect(logo?.width).toBeCloseTo(102.731, 1);
  expect(logo?.height).toBeCloseTo(24, 1);
  const separator = await page
    .locator(".onboarding-entry__legal-separator img")
    .boundingBox();
  expect(separator?.width).toBeCloseTo(1, 1);
  expect(separator?.height).toBeCloseTo(16, 1);
  for (const image of await page.locator(".onboarding-entry img").all()) {
    await expect(image).toHaveJSProperty("complete", true);
    expect(
      await image.evaluate((img) => (img as HTMLImageElement).naturalWidth),
    ).toBeGreaterThan(0);
    expect(await image.getAttribute("src")).toMatch(/^\/onboarding\//);
  }
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("figma-empty-1440.png"),
  });
  await page.getByLabel("Email", { exact: true }).fill("alex@levinson.com");
  await expect(
    page.getByRole("button", { name: "Start for free" }),
  ).toBeEnabled();
  await page.getByLabel("Email", { exact: true }).blur();
  await expect(page.getByRole("button", { name: "Start for free" })).toHaveCSS(
    "background-color",
    "rgb(196, 134, 90)",
  );
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("figma-filled-1440.png"),
  });
  await page.getByRole("link", { name: "Terms Of Use", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await calls(page)).filter((c) => c.command === "open_legal_link")
          .length,
    )
    .toBe(1);
  expect(
    (await calls(page)).find((c) => c.command === "open_legal_link")?.args,
  ).toEqual({ document: "terms" });
  await page.getByLabel("Email", { exact: true }).clear();
  await openEmailSignIn(page);
  await expect(
    page.getByRole("heading", { name: "Welcome back to Orka" }),
  ).toBeFocused();
  const signInCard = await page
    .locator(".onboarding-entry__card")
    .boundingBox();
  expect(signInCard?.height).toBeCloseTo(564, 1);
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("sign-in-empty-1440.png"),
  });
  await page.getByLabel("Email", { exact: true }).fill("alex@levinson.com");
  await page.getByLabel("Email", { exact: true }).blur();
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toHaveCSS("background-color", "rgb(196, 134, 90)");
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("sign-in-filled-1440.png"),
  });
});

test("inbox and self-hosted screens match the current Figma geometry", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await fixture(page, false, { fresh: true, password: false });
  await expect(page.locator(".onboarding-entry__sign-in")).toBeEnabled();
  await page.getByRole("button", { name: "Connect to your server" }).click();
  await page.evaluate(() => document.fonts.ready);
  await expect(
    page.getByRole("button", { name: "Back", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Back", exact: true }),
  ).toHaveCSS("color", "rgb(242, 242, 242)");
  await expect(
    page.locator(".onboarding-entry__field .ui-field__control"),
  ).toHaveCSS("background-color", "rgb(28, 28, 28)");
  const server = await page.locator(".onboarding-entry__card").boundingBox();
  expect(server).toMatchObject({ x: 480, y: 105, width: 480 });
  expect(server?.height).toBeCloseTo(462, 1);
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("server-1440.png"),
  });
  await page.getByLabel("Server link").fill("https//invalid");
  await page
    .getByRole("button", { name: "Connect server", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Enter a valid server address",
  );
  const errorIcon = page.getByRole("alert").locator("img");
  await expect(errorIcon).toHaveJSProperty("complete", true);
  const errorIconBounds = await errorIcon.boundingBox();
  expect(errorIconBounds?.width).toBe(16);
  expect(errorIconBounds?.height).toBe(16);
  expect((await calls(page)).filter((c) => c.command === "configure")).toEqual(
    [],
  );
  await page.getByLabel("Server link").blur();
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("server-error-1440.png"),
  });
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByLabel("Email", { exact: true }).fill("name@company.com");
  await page.getByRole("button", { name: "Start for free" }).click();
  await expect(
    page.getByRole("heading", { name: "Check your inbox" }),
  ).toBeFocused();
  const inbox = await page.locator(".onboarding-entry__card").boundingBox();
  expect(inbox).toMatchObject({ x: 480, y: 105, width: 480 });
  expect(inbox?.height).toBeCloseTo(430.91, 1);
  const envelope = page.locator(".onboarding-entry__envelope img");
  await expect(envelope).toHaveJSProperty("complete", true);
  expect(
    await envelope.evaluate((img) => (img as HTMLImageElement).naturalWidth),
  ).toBeGreaterThan(0);
  const slot = await page.locator(".onboarding-entry__envelope").boundingBox();
  expect(slot?.width).toBeCloseTo(198.179, 1);
  expect(slot?.height).toBeCloseTo(140.91, 1);
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("inbox-1440.png"),
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("resend replaces an expired magic link and supports changing email", async ({
  page,
}) => {
  await fixture(page, false, { fresh: true });
  await page.getByLabel("Email", { exact: true }).fill("person@example.test");
  await page.getByRole("button", { name: "Start for free" }).click();
  await followMagicLink(page, true);
  await expect(page.getByRole("alert")).toContainText("expired");
  await page.getByRole("button", { name: "Resend email", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Check your inbox" }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByLabel("Email code")).toHaveCount(0);
  expect(
    (await calls(page)).filter((c) => c.command === "begin_sign_in"),
  ).toHaveLength(2);
  const cancelled = (await calls(page)).filter(
    (c) => c.command === "cancel_sign_in",
  ).length;
  await page.getByRole("button", { name: "Use a different email" }).click();
  await expect(page.getByLabel("Email", { exact: true })).toHaveValue(
    "person@example.test",
  );
  expect(
    (await calls(page)).filter((c) => c.command === "cancel_sign_in"),
  ).toHaveLength(cancelled + 1);
});

test("a server with disabled sign-in methods offers a usable way back", async ({
  page,
}) => {
  await fixture(page, false, { authDisabled: true });
  await expect(page.getByRole("status")).toContainText(
    "no sign-in methods enabled",
  );
  await expect(
    page.getByRole("button", { name: "Continue with GitHub" }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Email", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Connect to your server" }).click();
  await expect(page.getByLabel("Server link")).toBeVisible();
});

test("an unfinished self-hosted address cannot block returning to Cloud sign-in", async ({
  page,
}) => {
  await fixture(page, false, { fresh: true });
  await page.getByRole("button", { name: "Connect to your server" }).click();
  await page.getByLabel("Server link").fill("https//unfinished");
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByLabel("Email", { exact: true }).fill("person@example.test");
  await page.getByRole("button", { name: "Start for free" }).click();
  await expect(
    page.getByRole("heading", { name: "Check your inbox" }),
  ).toBeVisible();
  const config = (await calls(page)).find((c) => c.command === "configure")
    ?.args.config;
  expect(config).toMatchObject({ mode: "cloud", selfHostedUrl: "" });
  expect(
    (await calls(page)).filter((c) => c.command === "begin_sign_in"),
  ).toHaveLength(1);
});

test("Cloud entry retains the email and supports retry after a failed connection save", async ({
  page,
}) => {
  await fixture(page, false, { fresh: true, failConfigure: true });
  await page.getByLabel("Email", { exact: true }).fill("person@example.test");
  await expect(
    page.getByRole("button", { name: "Start for free" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Start for free" }).click();
  await expect(page.getByRole("alert")).toContainText("Could not save");
  await expect(
    page.getByRole("heading", { name: "Get started with Orka" }),
  ).toBeVisible();
  await expect(page.getByLabel("Email", { exact: true })).toHaveValue(
    "person@example.test",
  );
  expect((await calls(page)).some((c) => c.command === "begin_sign_in")).toBe(
    false,
  );
  await page.evaluate(() => {
    (window as any).failConfigure = false;
  });
  await page.getByRole("button", { name: "Start for free" }).click();
  await expect(
    page.getByRole("heading", { name: "Check your inbox" }),
  ).toBeVisible();
  expect(
    (await calls(page)).filter((c) => c.command === "begin_sign_in"),
  ).toHaveLength(1);
});

for (const width of [1160, 900]) {
  test(`browser invite survives sign-in and requires sharing review at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 900 ? 640 : 800 });
    const token = "ab".repeat(24);
    const deepLink = `orka://join/${token}?server=https%3A%2F%2Fcloud.example.test`;
    await fixture(page, false, { passwordOnly: true, deepLink });
    await expect(page.getByText(/Your invite is ready/)).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await openEmailSignIn(page);
    await page.getByLabel("Email", { exact: true }).fill("person@example.test");
    await page.getByLabel("Password", { exact: true }).fill("fixture-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Join project" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Invite link or token")).toHaveValue(
      deepLink,
    );
    await expect(
      dialog.getByRole("button", { name: "Join project", exact: true }),
    ).toBeEnabled();
    await expect(
      dialog.getByRole("combobox", { name: /sharing$/ }),
    ).toHaveCount(4);
    for (const category of ["Memories", "Plans", "Skills"])
      await expect(
        dialog.getByRole("combobox", { name: `${category} sharing` }),
      ).toContainText("Share automatically");
    await expect(
      dialog.getByRole("combobox", { name: "Sessions sharing" }),
    ).toContainText("Only when asked");
    expect(
      (await calls(page)).some((call) => call.command === "cloud_action"),
    ).toBe(false);
    await page.screenshot({
      path: info.outputPath(`browser-join-${width}.png`),
    });
    expect(
      (await new AxeBuilder({ page }).include('[role="dialog"]').analyze())
        .violations,
    ).toEqual([]);
  });
}

test("joining another service requires an explicit switch and keeps the invite through sign-in", async ({
  page,
}) => {
  const deepLink = `orka://join/${"ab".repeat(24)}?server=https%3A%2F%2Fprivate.example.test`;
  await fixture(page, true, { passwordOnly: true, deepLink });
  const dialog = page.getByRole("dialog", { name: "Join project" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Join project", exact: true }),
  ).toBeDisabled();
  expect(
    (await calls(page)).some((call) => call.command === "switch_service"),
  ).toBe(false);
  await dialog
    .getByRole("button", { name: "Switch service and sign in" })
    .click();
  await expect(page.getByText(/Your invite is ready/)).toBeVisible();
  expect(
    (await calls(page)).find((call) => call.command === "switch_service")?.args
      .config,
  ).toMatchObject({
    apiUrl: "https://private.example.test",
    mode: "self-hosted",
    cloudUrl: "https://cloud.example.test",
  });
  await openEmailSignIn(page);
  await page.getByLabel("Email", { exact: true }).fill("person@example.test");
  await page.getByLabel("Password", { exact: true }).fill("fixture-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(dialog.getByLabel("Invite link or token")).toHaveValue(deepLink);
  await expect(
    dialog.getByRole("button", { name: "Join project", exact: true }),
  ).toBeEnabled();
});

test("signed-out users can select the invite service or dismiss the pending invite", async ({
  page,
}) => {
  const deepLink = `orka://join/${"ab".repeat(24)}?server=https%3A%2F%2Fprivate.example.test`;
  await fixture(page, false, { fresh: true, passwordOnly: true, deepLink });
  await page.getByRole("button", { name: "Use invite service" }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome back to Orka" }),
  ).toBeVisible();
  expect(
    (await calls(page)).find((call) => call.command === "switch_service")?.args
      .config.apiUrl,
  ).toBe("https://private.example.test");
  await page.getByRole("button", { name: "Dismiss invite" }).click();
  await expect(page.getByText(/Your invite is ready/)).toHaveCount(0);
});

test("unreachable invite services keep the current account and invite available", async ({
  page,
}) => {
  const deepLink = `orka://join/${"ab".repeat(24)}?server=https%3A%2F%2Foffline.example.test`;
  await fixture(page, true, { passwordOnly: true, deepLink });
  const dialog = page.getByRole("dialog", { name: "Join project" });
  await dialog
    .getByRole("button", { name: "Switch service and sign in" })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Cannot reach this service",
  );
  await expect(dialog.getByLabel("Invite link or token")).toHaveValue(deepLink);
  expect(
    (await calls(page)).some(
      (call) =>
        call.command === "switch_service" || call.command === "cloud_action",
    ),
  ).toBe(false);
});

test("magic-link sign-in preserves a pending project invite", async ({
  page,
}) => {
  const deepLink = `orka://join/${"ab".repeat(24)}?server=https%3A%2F%2Fcloud.example.test`;
  await fixture(page, false, { deepLink });
  await openEmailSignIn(page);
  await page.getByLabel("Email", { exact: true }).fill("person@example.test");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await followMagicLink(page);
  await expect(
    page
      .getByRole("dialog", { name: "Join project" })
      .getByLabel("Invite link or token"),
  ).toHaveValue(deepLink);
  expect(
    (await calls(page)).some((call) => call.command === "cloud_action"),
  ).toBe(false);
});

for (const width of [1160, 900]) {
  test(`Figma Cloud entry and magic-link login at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 900 ? 640 : 800 });
    await fixture(page, false, { fresh: true });
    await expect(
      page.getByRole("heading", { name: "Get started with Orka" }),
    ).toBeVisible();
    await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Start for free" }),
    ).toBeDisabled();
    await expect(page.getByLabel("Cloud service URL")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Continue with GitHub" }),
    ).toBeEnabled();
    expect((await calls(page)).some((c) => c.command === "configure")).toBe(
      false,
    );
    await page.screenshot({
      animations: "disabled",
      path: info.outputPath("entry-empty.png"),
    });
    await checkEntryAccessibility(page);
    await page.getByLabel("Email", { exact: true }).fill("person@example.test");
    await expect(
      page.getByRole("button", { name: "Start for free" }),
    ).toBeEnabled();
    await page.screenshot({
      animations: "disabled",
      path: info.outputPath("entry-filled.png"),
    });
    await checkEntryAccessibility(page);
    await page.getByLabel("Email", { exact: true }).press("Enter");
    await expect(page.getByRole("status")).toHaveText(
      "We sent a sign-in link to person@example.test.",
    );
    await page.screenshot({
      animations: "disabled",
      path: info.outputPath("check-email.png"),
    });
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await followMagicLink(page, true);
    await expect(page.getByRole("alert")).toContainText("expired");
    await followMagicLink(page);
    await expect(
      page.getByRole("button", { name: "Settings", exact: true }),
    ).toBeVisible();
    const auth = (await calls(page)).filter((c) =>
      ["configure", "begin_sign_in", "complete_sign_in"].includes(c.command),
    );
    expect(auth[0].args.config.mode).toBe("cloud");
    expect(auth[0].args.config.apiUrl).toBe("https://api.tryorca.ai");
    expect(auth.find((c) => c.command === "begin_sign_in")).toEqual({
      command: "begin_sign_in",
      args: { method: "magic-link", email: "person@example.test" },
    });
  });
}

test("GitHub cancellation and password fallback retain a usable sign-in screen", async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole("button", { name: "Continue with GitHub" }).click();
  await expect(page.getByRole("status")).toContainText("your browser");
  expect(
    (await calls(page)).find((c) => c.command === "begin_sign_in")?.args,
  ).toEqual({ method: "github", email: null });
  await page.getByRole("button", { name: "Cancel sign-in" }).click();
  await openEmailSignIn(page);
  await page.getByRole("button", { name: "Use a password" }).click();
  await page.getByLabel("Email", { exact: true }).fill("person@example.test");
  await page.getByLabel("Password", { exact: true }).fill("fixture-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Settings", exact: true }),
  ).toBeVisible();
});

for (const width of [1160, 900]) {
  test(`Figma sign-in variant preserves email and authenticates at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 900 ? 640 : 800 });
    await fixture(page, false, { fresh: true, password: false });
    await openEmailSignIn(page);
    await expect(
      page.getByRole("heading", { name: "Welcome back to Orka" }),
    ).toBeFocused();
    await expect(
      page.getByRole("button", { name: "Continue with GitHub" }),
    ).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "Sign in", exact: true }),
    ).toBeDisabled();
    await page.screenshot({
      animations: "disabled",
      path: info.outputPath("sign-in-empty.png"),
    });
    await checkEntryAccessibility(page);
    await page.getByLabel("Email", { exact: true }).fill("person@example.test");
    await page.getByLabel("Email", { exact: true }).blur();
    await expect(
      page.getByRole("button", { name: "Sign in", exact: true }),
    ).toHaveCSS("background-color", "rgb(196, 134, 90)");
    await page.screenshot({
      animations: "disabled",
      path: info.outputPath("sign-in-filled.png"),
    });
    await checkEntryAccessibility(page);
    await page
      .getByRole("button", { name: "Get started", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Get started with Orka" }),
    ).toBeFocused();
    await expect(page.getByLabel("Email", { exact: true })).toHaveValue(
      "person@example.test",
    );
    await openEmailSignIn(page);
    await page.getByLabel("Email", { exact: true }).press("Enter");
    await expect(
      page.getByRole("heading", { name: "Check your inbox" }),
    ).toBeVisible();
    await followMagicLink(page);
    await expect(
      page.getByRole("button", { name: "Settings", exact: true }),
    ).toBeVisible();
    expect(
      (await calls(page)).find((c) => c.command === "begin_sign_in")?.args,
    ).toEqual({ method: "magic-link", email: "person@example.test" });
  });
}

test("switching to self-hosted requires a reachable service and signs out", async ({
  page,
}) => {
  await fixture(page, true);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("region", { name: "Settings", exact: true });
  await settings.getByRole("button", { name: "Profile", exact: true }).click();
  await settings
    .getByRole("button", { name: "Move to self-hosted", exact: true })
    .click();
  await settings
    .getByRole("button", { name: "Self-hosted", exact: true })
    .click();
  await settings
    .getByLabel("Self-hosted service URL")
    .fill("https://offline.example.test");
  await expect(settings.getByRole("alert")).toContainText("Cannot reach");
  await expect(
    settings.getByRole("button", { name: "Review change" }),
  ).toBeDisabled();
  await settings
    .getByLabel("Self-hosted service URL")
    .fill("https://private.example.test");
  await settings.getByRole("button", { name: "Review change" }).click();
  await settings
    .getByRole("button", { name: "Switch service and sign in" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Welcome back to Orka" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Change server" }).click();
  await expect(page.getByLabel("Server link")).toHaveValue(
    "https://private.example.test",
  );
  const change = (await calls(page)).find(
    (c) => c.command === "switch_service",
  );
  expect(change?.args.config).toMatchObject({
    mode: "self-hosted",
    apiUrl: "https://private.example.test",
    cloudUrl: "https://cloud.example.test",
  });
  await page.getByRole("button", { name: /^Sign In$/ }).click();
  await page.getByLabel("Email", { exact: true }).fill("person@example.test");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  expect(
    (await calls(page)).filter((c) => c.command === "configure").at(-1)?.args
      .config.apiUrl,
  ).toBe("https://cloud.example.test");
});

test("hosting validates before saving and resumes after restart; navigation keeps both URLs", async ({
  page,
}) => {
  await fixture(page, false, { fresh: true });
  await page.getByRole("button", { name: "Connect to your server" }).click();
  const next = page.getByRole("button", {
    name: "Connect server",
    exact: true,
  });
  await expect(next).toBeDisabled();
  await page.getByLabel("Server link").fill("https://private.example.test");
  await next.click();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Welcome back to Orka" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Change server" }).click();
  await expect(page.getByLabel("Server link")).toHaveValue(
    "https://private.example.test",
  );
  await page.getByRole("button", { name: /^Sign In$/ }).click();
  await page.getByRole("button", { name: "Connect to your server" }).click();
  await expect(page.getByLabel("Server link")).toHaveValue(
    "https://private.example.test",
  );
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome back to Orka" }),
  ).toBeVisible();
  expect(
    (await calls(page)).filter((c) => c.command === "begin_sign_in"),
  ).toEqual([]);
  expect(
    (await calls(page)).filter((c) => c.command === "configure"),
  ).toHaveLength(0);
});

test("failed or unreachable server connections preserve the saved service and can retry", async ({
  page,
}) => {
  await fixture(page, false, { fresh: true, failConfigure: true });
  await page.getByRole("button", { name: "Connect to your server" }).click();
  await page.getByLabel("Server link").fill("https://private.example.test");
  await page
    .getByRole("button", { name: "Connect server", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("Could not save");
  await expect(
    page.getByRole("heading", { name: "Log into your account" }),
  ).toBeVisible();
  await page.evaluate(() => {
    (window as any).failConfigure = false;
  });
  await page.getByLabel("Server link").fill("https://offline.example.test");
  await page
    .getByRole("button", { name: "Connect server", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Can’t reach your server", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Edit server address", exact: true })
    .click();
  expect(
    (await calls(page)).filter((c) => c.command === "configure"),
  ).toHaveLength(1);
  await page.getByLabel("Server link").fill("https://private.example.test");
  await page
    .getByRole("button", { name: "Connect server", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Continue with GitHub" }),
  ).toBeEnabled();
  expect(
    (await calls(page)).filter((c) => c.command === "configure").at(-1)?.args
      .config,
  ).toMatchObject({
    apiUrl: "https://private.example.test",
    mode: "self-hosted",
  });
});

test("Back cancels pending email login and keeps navigation usable", async ({
  page,
}) => {
  await fixture(page);
  await openEmailSignIn(page);
  await page.getByLabel("Email", { exact: true }).fill("person@example.test");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Check your inbox" }),
  ).toBeVisible();
  const before = (await calls(page)).filter(
    (c) => c.command === "cancel_sign_in",
  ).length;
  await page.getByRole("button", { name: "Use a different email" }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome back to Orka" }),
  ).toBeFocused();
  expect(
    (await calls(page)).filter((c) => c.command === "cancel_sign_in"),
  ).toHaveLength(before + 1);
  await expect(page.getByLabel("Email code")).toHaveCount(0);
  await expect(page.getByLabel("Email", { exact: true })).toHaveValue(
    "person@example.test",
  );
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeVisible();
});

test("password-only servers keep email login without advertising unsupported providers", async ({
  page,
}) => {
  await fixture(page, false, { passwordOnly: true });
  await openEmailSignIn(page);
  await expect(
    page.getByRole("button", { name: "Continue with GitHub" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Send magic link" }),
  ).toHaveCount(0);
  await page.getByLabel("Email", { exact: true }).fill("person@example.test");
  await page.getByLabel("Password", { exact: true }).fill("fixture-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Settings", exact: true }),
  ).toBeVisible();
});

for (const kind of ["locked", "denied"] as const)
  test(`Keychain ${kind} recovers without exchanging the magic link twice`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await fixture(page, false, { keychain: kind });
    await openEmailSignIn(page);
    await page
      .getByRole("textbox", { name: "Email", exact: true })
      .fill("pratham@example.test");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await followMagicLink(page);
    await expect(
      page.getByRole("heading", {
        name:
          kind === "locked" ? "Unlock your keychain" : "Can’t access Keychain",
        exact: true,
      }),
    ).toBeVisible();
    await page.screenshot({
      animations: "disabled",
      path: info.outputPath(`keychain-${kind}.png`),
    });
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Welcome back to Orka" }),
    ).toHaveCount(0);
    const history = await calls(page);
    expect(
      history.filter((c) => c.command === "complete_sign_in"),
    ).toHaveLength(1);
    expect(
      history.filter((c) => c.command === "retry_sign_in_storage"),
    ).toHaveLength(1);
  });

test("unreachable self-hosted recovery matches Figma and returns to the editable address", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await fixture(page, false, { fresh: true });
  await page
    .getByRole("button", { name: "Connect to your server", exact: true })
    .click();
  await page.getByLabel("Server link").fill("https://offline.example.test");
  await page
    .getByRole("button", { name: "Connect server", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Can’t reach your server", exact: true }),
  ).toBeVisible();
  const card = await page.locator(".onboarding-entry__card").boundingBox();
  expect(card).toMatchObject({ x: 480, y: 270, width: 480 });
  expect(card?.height).toBeCloseTo(360, 1);
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("server-unavailable.png"),
  });
  await page
    .getByRole("button", { name: "Edit server address", exact: true })
    .click();
  await expect(page.getByLabel("Server link")).toHaveValue(
    "https://offline.example.test",
  );
});

test("advertised email code fallback is keyboard usable and can recover from an invalid code", async ({
  page,
}) => {
  await fixture(page, false, { fresh: true, emailCode: true });
  await page.getByLabel("Email", { exact: true }).fill("alex@example.test");
  await page.getByRole("button", { name: "Start for free" }).click();
  await page.getByRole("button", { name: "Use email code" }).click();
  const code = page.getByLabel("Email code", { exact: true });
  await expect(code).toBeFocused();
  const verify = page.getByRole("button", { name: "Verify code" });
  await expect(verify).toBeDisabled();
  await code.fill("000000");
  await code.press("Enter");
  await expect(page.getByRole("alert")).toContainText(
    "Incorrect or expired code",
  );
  await code.fill("123 456");
  await expect(code).toHaveValue("123456");
  await code.press("Enter");
  await expect(
    page.getByRole("button", { name: "Settings", exact: true }),
  ).toBeVisible();
  expect(
    (await calls(page))
      .filter((call) => call.command === "complete_sign_in")
      .map((call) => call.args),
  ).toEqual([
    { callback: null, code: "000000" },
    { callback: null, code: "123456" },
  ]);
});

test("restores a pending email code after restarting the desktop window", async ({
  page,
}, info) => {
  await fixture(page, false, { fresh: true, emailCode: true });
  await page.getByLabel("Email", { exact: true }).fill("alex@example.test");
  await page.getByRole("button", { name: "Start for free" }).click();
  await expect(
    page.getByRole("button", { name: "Use email code" }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Use email code" }).click();
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("restart-email-code.png"),
  });
  await page.getByLabel("Email code", { exact: true }).fill("123456");
  await page.getByRole("button", { name: "Verify code" }).click();
  await expect(
    page.getByRole("button", { name: "Settings", exact: true }),
  ).toBeVisible();
  expect((await calls(page)).map((call) => call.command)).not.toContain(
    "begin_sign_in",
  );
});
