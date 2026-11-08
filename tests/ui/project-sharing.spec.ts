import { setSharingMode } from "./fixtures/sharing-mode.js";
import { ENV_ENABLED } from "../../apps/mac/src/lib/features.js";
import { test, expect, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import type { Project, ProjectSharing } from "../../apps/mac/src/types.js";

const off: ProjectSharing = {
  memory: false,
  session: false,
  plan: false,
  skill: false,
  env: false,
};
const automaticDefault = { ...off, memory: true, plan: true, skill: true };
const inviteToken = "ab".repeat(24);

async function fixture(page: Page, failCreate = false, browserInvites = true) {
  await page.addInitScript(
    ({ off, failCreate, browserInvites, inviteToken }) => {
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: async (text: string) => {
            Object.assign(window, { copiedInvite: text });
          },
        },
      });
      const projects: Project[] = [
        {
          id: "project",
          name: "Existing project",
          path: "/test/existing",
          role: "owner",
          sharing: { ...off },
        },
      ];
      type Args = {
        action?: string;
        input?: { name?: string; sharing: ProjectSharing; projectId: string };
        id?: string;
        path?: string;
        paths?: string[];
      };
      const calls: { command: string; args: Args }[] = [];
      let failed = false;
      Object.assign(window, {
        sharingCalls: calls,
        isTauri: true,
        __TAURI_INTERNALS__: {
          transformCallback: () => 1,
          unregisterCallback: () => {},
          invoke: async (command: string, args: Args = {}) => {
            if (command === "snapshot")
              return {
                user: "user",
                config: { apiUrl: "https://test.orka", syncMinutes: 15 },
                projects,
                resources: [],
                bindings: [],
                conflicts: [],
                activity: [],
                outbox: [],
                errors: [],
                sync: { online: true },
                daemon: { running: true },
                devices: [],
                deviceId: "mac",
                background: true,
              };
            if (command === "sync_progress")
              return { user: "user", progress: null };
            calls.push({ command, args });
            if (command === "plugin:dialog|open") return "/test/new-project";
            if (command.startsWith("plugin:")) return null;
            if (command === "cloud_action") {
              if (args.action === "invite")
                return {
                  token: inviteToken,
                  ...(browserInvites
                    ? { url: `https://test.orka/join/${inviteToken}` }
                    : {}),
                };
              if (failCreate && !failed) {
                failed = true;
                throw new Error("Cloud unavailable; try again");
              }
              const next: Project = {
                id: "new-project",
                name: args.input!.name ?? "Joined project",
                path: null,
                role: "owner",
                sharing: { ...args.input!.sharing },
              };
              projects.push(next);
              return { id: next.id };
            }
            if (command === "connect_project_sources")
              projects.find((p) => p.id === args.id)!.sources = args.paths!.map(
                (path, index) => ({
                  id: `source-${index}`,
                  name: path.split("/").at(-1)!,
                  path,
                }),
              );
            if (command === "project_command")
              projects.find((p) => p.id === args.input!.projectId)!.sharing = {
                ...args.input!.sharing,
              };
            if (command === "env_command") {
              if (args.action === "capabilities")
                return { enabled: false, supported: true };
              return {};
            }
            return {};
          },
        },
      });
    },
    { off, failCreate, browserInvites, inviteToken },
  );
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Add project", exact: true }),
  ).toBeVisible();
}

const calls = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          sharingCalls: { command: string; args: Record<string, unknown> }[];
        }
      ).sharingCalls,
  );

for (const size of [
  { width: 1160, height: 800 },
  { width: 900, height: 640 },
]) {
  test(`add project defaults to automatic context and selective sessions with keyboard selection at ${size.width}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(size);
    await fixture(page);
    await page
      .getByRole("button", { name: "Add project", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Create project" });
    await expect(
      dialog.getByRole("combobox", { name: /sharing$/ }),
    ).toHaveCount(4);
    for (const label of ["Memories", "Sessions", "Plans", "Skills"]) {
      await expect(
        dialog.getByRole("combobox", { name: label + " sharing", exact: true }),
      ).toContainText(
        label === "Sessions" ? "Only when asked" : "Share automatically",
      );
    }
    await dialog
      .getByRole("textbox", { name: "Project name" })
      .fill("My workspace");
    const memory = dialog.getByRole("combobox", {
      name: "Memories sharing",
      exact: true,
    });
    await memory.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("option", { name: "Share automatically", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(
      page.getByRole("option", { name: "Only when asked", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(memory).toContainText("Only when asked");
    await setSharingMode(memory, true);
    await setSharingMode(
      dialog.getByRole("combobox", { name: "Plans sharing", exact: true }),
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath(`sharing-${size.width}.png`),
    });
    const violations = (
      await new AxeBuilder({ page }).include('[role="dialog"]').analyze()
    ).violations;
    expect(violations).toEqual([]);
    await dialog
      .getByRole("button", { name: "Create project", exact: true })
      .click();
    await expect(dialog).toBeHidden();
    expect(
      (await calls(page)).find((c) => c.command === "cloud_action")?.args,
    ).toEqual({
      action: "create",
      input: {
        name: "My workspace",
        sharing: automaticDefault,
      },
    });
    expect((await calls(page)).some((c) => c.command === "env_command")).toBe(
      false,
    );
  });
}

test("cancel creates nothing and reopening resets choices", async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole("button", { name: "Add project", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await setSharingMode(
    dialog.getByRole("combobox", { name: "Skills sharing", exact: true }),
    false,
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect((await calls(page)).some((c) => c.command === "cloud_action")).toBe(
    false,
  );
  await page.getByRole("button", { name: "Add project", exact: true }).click();
  await expect(
    dialog.getByRole("combobox", { name: "Skills sharing", exact: true }),
  ).toContainText("Share automatically");
});

test("saving no categories and connecting a folder carries private defaults", async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole("button", { name: "Add project", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("textbox", { name: "Project name" })
    .fill("Private project");
  await dialog
    .getByRole("button", { name: "Add folders", exact: true })
    .click();
  await expect(
    dialog.getByRole("checkbox", { name: /new-project/ }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  const mutations = (await calls(page)).filter((c) =>
    ["cloud_action", "connect_project_sources"].includes(c.command),
  );
  expect(mutations).toEqual([
    {
      command: "cloud_action",
      args: {
        action: "create",
        input: { name: "Private project", sharing: automaticDefault },
      },
    },
    {
      command: "connect_project_sources",
      args: { id: "new-project", paths: ["/test/new-project"] },
    },
  ]);
});

test("failed creation retains selections for retry", async ({ page }) => {
  await fixture(page, true);
  await page.getByRole("button", { name: "Add project", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("textbox", { name: "Project name" })
    .fill("Retry project");
  await setSharingMode(
    dialog.getByRole("combobox", { name: "Skills sharing", exact: true }),
    true,
  );
  await dialog
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("Cloud unavailable");
  await expect(
    dialog.getByRole("combobox", { name: "Skills sharing", exact: true }),
  ).toContainText("Share automatically");
  await dialog
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await expect(dialog).toBeHidden();
});

test("join carries explicit sharing choices before connecting a folder", async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole("button", { name: "Join project", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("textbox", { name: "Invite link or token" })
    .fill(`orka://join/${inviteToken}`);
  await expect(
    dialog.getByRole("combobox", { name: "Sessions sharing", exact: true }),
  ).toContainText("Only when asked");
  await setSharingMode(
    dialog.getByRole("combobox", { name: "Sessions sharing", exact: true }),
    true,
  );
  await dialog
    .getByRole("button", { name: "Join project", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  expect(
    (await calls(page)).find((c) => c.command === "cloud_action")?.args,
  ).toEqual({
    action: "join",
    input: {
      token: inviteToken,
      sharing: { ...automaticDefault, session: true },
    },
  });
});

test("browser invites are parsed and bound to the selected service", async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole("button", { name: "Join project", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Join project" });
  await dialog
    .getByLabel("Invite link or token")
    .fill(`https://test.orka/join/${inviteToken}`);
  await dialog
    .getByRole("button", { name: "Join project", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  expect(
    (await calls(page)).find((call) => call.command === "cloud_action")?.args,
  ).toEqual({
    action: "join",
    input: {
      token: inviteToken,
      serviceUrl: "https://test.orka",
      sharing: automaticDefault,
    },
  });
});

test("invalid and mismatched invites never send a join request", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 900, height: 640 });
  await fixture(page);
  await page.getByRole("button", { name: "Join project", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Join project" });
  await dialog.getByLabel("Invite link or token").fill("not-an-invite");
  await dialog
    .getByRole("button", { name: "Join project", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("valid Orka invite");
  await dialog
    .getByLabel("Invite link or token")
    .fill(`https://other.example/join/${inviteToken}`);
  await expect(
    dialog.getByRole("button", { name: "Join project", exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: "Switch service and sign in" }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("invite-service-mismatch.png"),
  });
  expect(
    (await new AxeBuilder({ page }).include('[role="dialog"]').analyze())
      .violations,
  ).toEqual([]);
  expect(
    (await calls(page)).some((call) => call.command === "cloud_action"),
  ).toBe(false);
});

for (const browserInvites of [true, false]) {
  test(`copy invite uses ${browserInvites ? "browser URL" : "legacy desktop fallback"}`, async ({
    page,
  }) => {
    await fixture(page, false, browserInvites);
    await page
      .getByRole("combobox", { name: "Select project", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Invite member", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { copiedInvite?: string }).copiedInvite,
        ),
      )
      .toBe(
        browserInvites
          ? `https://test.orka/join/${inviteToken}`
          : `orka://join/${inviteToken}`,
      );
  });
}

test("ENVs require project opt-in even when global setup is available", async ({
  page,
}) => {
  test.skip(!ENV_ENABLED, "ENV support is temporarily disabled");
  await fixture(page);
  await page.getByRole("button", { name: "ENVs", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "ENV sharing is off for this project" }),
  ).toBeVisible();
  expect((await calls(page)).some((c) => c.command === "env_command")).toBe(
    false,
  );
  await page.getByRole("button", { name: "Open sharing settings" }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("switch", { name: "ENVs", exact: true }).check();
  await settings.getByRole("button", { name: "Save changes" }).click();
  await expect(
    settings.getByText("Sharing choices saved", { exact: true }),
  ).toBeVisible();
  expect(
    (await calls(page)).find(
      (c) => c.command === "project_command" && c.args.action === "sharing",
    )?.args,
  ).toEqual({
    action: "sharing",
    input: { projectId: "project", sharing: { ...off, env: true } },
  });
  await settings.getByRole("button", { name: "Close settings" }).click();
  await expect(
    page.getByRole("heading", { name: "Enable ENVs on this Mac" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await settings.getByRole("button", { name: "Sharing", exact: true }).click();
  await expect(
    settings.getByRole("switch", { name: "ENVs", exact: true }),
  ).toBeChecked();
});
