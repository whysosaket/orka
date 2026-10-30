import { test, expect, type Page } from "@playwright/test";
import { ENV_ENABLED } from "../../apps/mac/src/lib/features.js";

async function expectRemovedFeatures(page: Page) {
  await expect(
    page.getByRole("button", {
      name: /^(AI connections?|Continue with ChatGPT|Connect Claude|Chat|Activity|Suggest skills|Generate skills)$/i,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByText(/^(Suggested skills|Recommended skills|AI connections?)$/i),
  ).toHaveCount(0);
}

async function fixture(page: Page, noProject: boolean) {
  await page.clock.install();
  await page.addInitScript((noProject) => {
    const calls: string[] = [];
    let callback = 1;
    Object.assign(window, {
      isTauri: true,
      invokeCalls: calls,
      __TAURI_INTERNALS__: {
        transformCallback: () => callback++,
        unregisterCallback: () => {},
        invoke: async (command: string) => {
          calls.push(command);
          if (command === "snapshot")
            return {
              user: "user",
              deviceId: "mac",
              config: { apiUrl: "https://test.orka", syncMinutes: 15 },
              projects: noProject
                ? []
                : [
                    {
                      id: "project",
                      name: "Orka",
                      path: "/synthetic/project",
                      role: "owner",
                    },
                  ],
              resources: [],
              bindings: [],
              conflicts: [],
              activity: [],
              outbox: [],
              errors: [],
              devices: [],
              background: true,
              sync: { online: true },
              daemon: { running: true },
            };
          if (command === "sync_progress")
            return { user: "user", progress: null };
          if (command === "auth_capabilities")
            return {
              auth: { password: true, github: false, magicLink: false },
            };
          if (command.startsWith("plugin:")) return null;
          return {};
        },
      },
    });
  }, noProject);
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Settings", exact: true }),
  ).toBeVisible();
}

for (const noProject of [false, true]) {
  for (const viewport of [
    { width: 1160, height: 800 },
    { width: 900, height: 640 },
  ]) {
    test(`Suggested Skills, AI connections, Chat, and Activity are absent ${noProject ? "without" : "with"} a project at ${viewport.width}px`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize(viewport);
      await fixture(page, noProject);
      await expectRemovedFeatures(page);
      const navigation = page.getByRole("navigation", {
        name: noProject ? "Project resources" : "Orka resources",
      });
      await expect(navigation.getByRole("button")).toHaveText(
        ["Home", "Memories0", "Skills0", "Sessions0", "Plans0", "ENVs"].filter(
          (name) => ENV_ENABLED || name !== "ENVs",
        ),
      );
      if (noProject) {
        await expect(
          page.getByRole("heading", { name: "Your projects", exact: true }),
        ).toBeVisible();
        await expect(
          navigation.getByRole("button", { name: "Home" }),
        ).toBeDisabled();
      } else {
        for (const name of [
          "Memories",
          "Skills",
          "Sessions",
          "Plans",
          "ENVs",
          "Home",
        ].filter((name) => ENV_ENABLED || name !== "ENVs")) {
          await navigation
            .getByRole("button", { name: new RegExp(`^${name}`) })
            .click();
          await expectRemovedFeatures(page);
        }
      }
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      const dialog = page.getByRole("dialog", {
        name: "Settings",
        exact: true,
      });
      const sections = dialog.getByRole("navigation", {
        name: "Settings sections",
      });
      await expect(sections.getByRole("button")).toHaveText([
        "General",
        "Source folders",
        "Sharing",
        "Sync & startup",
        "Connected Macs",
        "Account & service",
      ]);
      for (const name of [
        "Connected Macs",
        "Sync & startup",
        "Account & service",
      ]) {
        await sections.getByRole("button", { name, exact: true }).click();
        await expect(
          dialog.getByRole("heading", { name, exact: true }),
        ).toBeVisible();
      }
      await expectRemovedFeatures(page);
      // Cross both former polling intervals: local status (2s) and reporting (60s).
      await page.clock.runFor(65_000);
      const calls = await page.evaluate(
        () => (window as unknown as { invokeCalls: string[] }).invokeCalls,
      );
      expect(calls.filter((command) => command.startsWith("ai_"))).toEqual([]);
      expect(calls).not.toContain("connect_project");
      expect(calls).not.toContain("disconnect_project");
      expect(
        calls.filter((command) => command === "snapshot").length,
      ).toBeGreaterThan(1);
      await page.screenshot({
        path: testInfo.outputPath("settings-without-ai.png"),
      });
      await dialog.getByRole("button", { name: "Close settings" }).click();
      await page.screenshot({
        path: testInfo.outputPath("dashboard-without-ai.png"),
      });
    });
  }
}
