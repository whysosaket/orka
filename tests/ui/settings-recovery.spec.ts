import { test, expect, type Locator } from "@playwright/test";
import { settingsFixture, settingsCalls } from "./fixtures/settings.js";

const button = (scope: Locator, name: string) =>
  scope.getByRole("button", { name, exact: true });
async function choose(scope: Locator, name: string, value: string) {
  await scope.getByRole("combobox", { name, exact: true }).click();
  await scope.page().getByRole("option", { name: value, exact: true }).click();
}

for (const section of ["General", "Profile"])
  test(`header requests navigation protects unsaved ${section} edits`, async ({
    page,
  }) => {
    const settings = await settingsFixture(page, { pendingRequests: true });
    await button(settings, section).click();
    const name = settings.getByRole("textbox", {
      name: section === "General" ? "Project name" : "Display name",
      exact: true,
    });
    const openRequests = async () => {
      await page
        .getByRole("button", {
          name: "Needs attention, 1 notification",
          exact: true,
        })
        .click();
      await page
        .getByRole("button", { name: "Review changes", exact: true })
        .click();
    };
    const returnToSection = async () => {
      await page
        .getByRole("button", { name: "Back to Members", exact: true })
        .click();
      await button(settings, section).click();
    };
    const dialog = page.getByRole("dialog", {
      name: "Save your changes?",
      exact: true,
    });
    await name.fill("Saved from header navigation");
    await openRequests();
    await expect(dialog).toBeVisible();
    await button(dialog, "Stay").click();
    await expect(name).toHaveValue("Saved from header navigation");
    await openRequests();
    await button(dialog, "Save").click();
    await expect(
      page.getByRole("heading", { name: "Pending reviews", exact: true }),
    ).toBeVisible();
    await returnToSection();
    await expect(name).toHaveValue("Saved from header navigation");
    await name.fill("Discarded from header navigation");
    await openRequests();
    await button(dialog, "Discard").click();
    await returnToSection();
    await expect(name).toHaveValue("Saved from header navigation");
    expect(
      (await settingsCalls(page)).filter(
        (call) =>
          call.args.action ===
          (section === "General" ? "rename" : "save-settings-profile"),
      ),
    ).toHaveLength(1);
  });

for (const section of ["Profile", "Permissions"])
  test(`G1: ${section} save failure is visible in the navigation dialog`, async ({
    page,
  }) => {
    const settings = await settingsFixture(page, { policyFailure: "offline" });
    await button(settings, section).click();
    if (section === "Profile")
      await settings
        .getByRole("textbox", { name: "Display name", exact: true })
        .fill("");
    else await choose(settings, "Member Memories access", "Add only");
    await button(settings, "Devices").click();
    const dialog = page.getByRole("dialog", { name: "Save your changes?" });
    await button(dialog, "Save").click();
    await expect(dialog.getByRole("alert")).toContainText(
      section === "Profile" ? "Enter a name" : "no confirmed result",
    );
    await expect(button(dialog, "Stay")).toBeEnabled();
    await button(dialog, "Stay").click();
    await expect(
      settings.getByRole("heading", { name: section, exact: true }),
    ).toBeVisible();
  });

for (const section of ["Profile", "Permissions"])
  test(`G2: ${section} navigation save locks conflicting actions until completion`, async ({
    page,
  }) => {
    const settings = await settingsFixture(page, { saveDelay: 1200 });
    await button(settings, section).click();
    if (section === "Profile")
      await settings
        .getByRole("textbox", { name: "Display name", exact: true })
        .fill("Updated name");
    else await choose(settings, "Member Memories access", "Add only");
    await button(settings, "Devices").click();
    const dialog = page.getByRole("dialog", { name: "Save your changes?" });
    await button(dialog, "Save").click();
    await expect(button(dialog, "Stay")).toBeDisabled();
    await expect(button(dialog, "Discard")).toBeDisabled();
    await expect(button(dialog, "Save")).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await expect(
      settings.getByRole("heading", { name: "Devices", exact: true }),
    ).toBeVisible();
    const action =
      section === "Profile" ? "save-settings-profile" : "save-role-policy";
    expect(
      (await settingsCalls(page)).filter((call) => call.args.action === action),
    ).toHaveLength(1);
  });

test("G3: an empty member list can refresh in place", async ({ page }) => {
  const settings = await settingsFixture(page);
  await page.evaluate(() => {
    (window as any).settingsCatalog.members = [];
  });
  await button(settings, "Members").click();
  await expect(
    settings.getByText("No members were returned.", { exact: false }),
  ).toBeVisible();
  await page.evaluate(() => {
    (window as any).settingsCatalog.members = [
      { id: "owner", name: "Restored member", role: "owner" },
    ];
  });
  await button(settings, "Refresh").click();
  await expect(
    settings.getByText("Restored member", { exact: true }),
  ).toBeVisible();
});

test("G4: a failed service check retries the unchanged URL", async ({
  page,
}) => {
  const settings = await settingsFixture(page);
  await button(settings, "Profile").click();
  await button(settings, "Move to self-hosted").click();
  await page.evaluate(() => {
    (window as any).settingsControls.failService = true;
  });
  await button(settings, "Self-hosted").click();
  const url = settings.getByRole("textbox", {
    name: "Self-hosted service URL",
    exact: true,
  });
  await url.fill("https://retry.orka");
  await expect(button(settings, "Check again")).toBeVisible();
  await expect(button(settings, "Review change")).toBeDisabled();
  await page.evaluate(() => {
    (window as any).settingsControls.failService = false;
  });
  await button(settings, "Check again").click();
  await expect(button(settings, "Review change")).toBeEnabled();
  await expect(url).toHaveValue("https://retry.orka");
});

test("G5: unsupported profiles are read-only before editing", async ({
  page,
}) => {
  const settings = await settingsFixture(page, { profileSupported: false });
  await button(settings, "Profile").click();
  await expect(
    settings.getByText("This service does not support profile edits yet.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    settings.getByRole("textbox", { name: "Display name", exact: true }),
  ).toBeDisabled();
  await expect(
    settings.getByRole("textbox", { name: "Job role", exact: true }),
  ).toBeDisabled();
  await expect(button(settings, "Change profile photo")).toBeDisabled();
  await expect(button(settings, "Save profile")).toBeDisabled();
  expect(
    (await settingsCalls(page)).filter(
      (call) => call.args.action === "save-settings-profile",
    ),
  ).toHaveLength(0);
});

test("G6: project rename conflict reviews and retries with the latest revision", async ({
  page,
}) => {
  const settings = await settingsFixture(page);
  await page.evaluate(() => {
    const w = window as any,
      original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (
        command === "project_command" &&
        args.action === "rename" &&
        args.input.expectedRevision === 1
      ) {
        w.settingsCalls.push({ command, args });
        Object.assign(w.settingsState.projects[0], {
          name: "Renamed elsewhere",
          lifecycleRevision: 2,
        });
        throw new Error("409: Project changed");
      }
      return original(command, args);
    };
  });
  await settings
    .getByRole("textbox", { name: "Project name", exact: true })
    .fill("My draft");
  await button(settings, "Save changes").click();
  await button(settings, "Load latest name").click();
  await expect(settings.getByText("Latest: Renamed elsewhere")).toBeVisible();
  await button(settings, "Keep my edit").click();
  await button(settings, "Save changes").click();
  await expect(settings.getByText("Changes saved.")).toBeVisible();
  const saves = (await settingsCalls(page)).filter(
    (call) => call.args.action === "rename",
  );
  expect(saves.map((call) => call.args.input.expectedRevision)).toEqual([1, 2]);
  expect(saves[1].args.input.requestId).not.toBe(saves[0].args.input.requestId);
});

for (const code of [403, 409])
  test(`G7: member ${code} refreshes authority and blocks stale retries if refresh fails`, async ({
    page,
  }) => {
    const settings = await settingsFixture(page);
    await button(settings, "Members").click();
    await page.evaluate((code) => {
      const w = window as any,
        original = w.__TAURI_INTERNALS__.invoke;
      w.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
        if (command === "governance_command" && args.action === "member-role") {
          w.settingsCalls.push({ command, args });
          w.settingsControls.failRefresh = true;
          w.settingsCatalog.policyRevision = 2;
          if (code === 403) {
            w.settingsCatalog.owner = false;
            w.settingsCatalog.role = "member";
          }
          throw new Error(`${code}: Membership changed`);
        }
        return original(command, args);
      };
    }, code);
    await choose(settings, "Role for Jamie Rivera", "Admin");
    await expect(
      settings.getByText("Couldn’t refresh members.", { exact: false }),
    ).toBeVisible();
    await expect(
      settings.getByRole("combobox", {
        name: "Role for Jamie Rivera",
        exact: true,
      }),
    ).toBeDisabled();
    await page.evaluate(() => {
      (window as any).settingsControls.failRefresh = false;
    });
    await button(settings, "Retry").click();
    if (code === 403) {
      await expect(
        settings.getByRole("combobox", {
          name: "Role for Jamie Rivera",
          exact: true,
        }),
      ).toHaveCount(0);
      await expect(button(settings, "Add Member")).toHaveCount(0);
    } else
      await expect(
        settings.getByRole("combobox", {
          name: "Role for Jamie Rivera",
          exact: true,
        }),
      ).toBeEnabled();
    expect(
      (await settingsCalls(page)).filter(
        (call) => call.args.action === "member-role",
      ),
    ).toHaveLength(1);
  });

test("G8: failed conflict lookup retries without resubmitting the stale policy", async ({
  page,
}) => {
  const settings = await settingsFixture(page, { policyFailure: "conflict" });
  await button(settings, "Permissions").click();
  await choose(settings, "Member Memories access", "Add only");
  await page.evaluate(() => {
    const w = window as any,
      original = w.__TAURI_INTERNALS__.invoke;
    w.settingsControls.failLatest = true;
    w.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (
        command === "governance_command" &&
        args.action === "role-policy" &&
        w.settingsControls.failLatest
      )
        throw new Error("Offline");
      return original(command, args);
    };
  });
  await button(settings, "Save changes").click();
  await expect(settings.getByRole("alert")).toContainText(
    "Couldn’t load the latest permissions",
  );
  await expect(button(settings, "Save changes")).toBeDisabled();
  await page.evaluate(() => {
    (window as any).settingsControls.failLatest = false;
  });
  await button(settings, "Retry loading latest").click();
  const review = page.getByRole("dialog", {
    name: "Review latest permissions",
  });
  await button(review, "Use reviewed values").click();
  expect(
    (await settingsCalls(page)).filter(
      (call) => call.args.action === "save-role-policy",
    ),
  ).toHaveLength(1);
  await button(settings, "Save changes").click();
  await expect(settings.getByText("Permissions saved.")).toBeVisible();
});

test("C1: native quit and reload guard drafts and honor Stay or Discard", async ({
  page,
}) => {
  const settings = await settingsFixture(page);
  const name = settings.getByRole("textbox", {
    name: "Project name",
    exact: true,
  });
  await name.fill("Unsaved name");
  expect(
    await page.evaluate(
      () =>
        !window.dispatchEvent(new Event("beforeunload", { cancelable: true })),
    ),
  ).toBe(true);
  await page.evaluate(() =>
    (window as any).settingsEmit("settings-close-requested", "quit"),
  );
  const dialog = page.getByRole("dialog", { name: "Save your changes?" });
  await button(dialog, "Stay").click();
  await expect(name).toHaveValue("Unsaved name");
  expect(
    (await settingsCalls(page)).filter(
      (call) => call.command === "finish_settings_close",
    ),
  ).toHaveLength(0);
  await page.evaluate(() =>
    (window as any).settingsEmit("settings-close-requested", "quit"),
  );
  await button(dialog, "Discard").click();
  await expect
    .poll(async () =>
      (await settingsCalls(page))
        .filter((call) => call.command === "finish_settings_close")
        .map((call) => call.args.quit),
    )
    .toEqual([true]);
});

test("C2: uncertain save offers Leave and check later and keeps its operation", async ({
  page,
}) => {
  const settings = await settingsFixture(page, { policyFailure: "offline" });
  await button(settings, "Permissions").click();
  await choose(settings, "Member Memories access", "Add only");
  await button(settings, "Save changes").click();
  await expect(button(settings, "Retry save")).toBeVisible();
  await button(settings, "Devices").click();
  const dialog = page.getByRole("dialog", { name: "Save your changes?" });
  await expect(button(dialog, "Discard")).toHaveCount(0);
  await button(dialog, "Leave and check later").click();
  await button(settings, "Permissions").click();
  await expect(button(settings, "Check save")).toBeVisible();
  expect(
    (await settingsCalls(page)).filter(
      (call) => call.args.action === "save-role-policy",
    ),
  ).toHaveLength(1);
});

test("C3: removed project keeps a copyable draft without switching its Settings editor", async ({
  page,
}) => {
  const settings = await settingsFixture(page);
  await settings
    .getByRole("textbox", { name: "Project name", exact: true })
    .fill("Keep this draft");
  await page.evaluate(() => {
    (window as any).settingsState.projects.shift();
  });
  await expect(settings.getByRole("alert")).toContainText(
    "Access to Orka is no longer available",
    { timeout: 6000 },
  );
  const draft = settings.getByRole("textbox", {
    name: "Settings draft to copy",
    exact: true,
  });
  await expect(draft).toHaveValue(/Keep this draft/);
  await expect(draft).toHaveAttribute("readonly", "");
  await expect(button(settings, "Save changes")).toBeDisabled();
  await draft.focus();
  await expect(draft).toBeFocused();
});

test("C4: profile comparison retains local edits and merges unedited shared values", async ({
  page,
}) => {
  const settings = await settingsFixture(page);
  await button(settings, "Profile").click();
  await settings
    .getByRole("textbox", { name: "Display name", exact: true })
    .fill("My edit");
  await page.evaluate(() => {
    Object.assign((window as any).settingsProfile, {
      displayName: "Remote edit",
      jobRole: "Engineer",
      revision: "profile-2",
    });
  });
  await button(settings, "Save profile").click();
  const review = page.getByRole("dialog", { name: "Review latest profile" });
  await expect(button(review, "Use reviewed values")).toBeDisabled();
  await choose(review, "Resolve Display name", "Keep my edit");
  await button(review, "Use reviewed values").click();
  await expect(
    settings.getByRole("textbox", { name: "Job role", exact: true }),
  ).toHaveValue("Engineer");
  expect(
    (await settingsCalls(page)).filter(
      (call) => call.args.action === "save-settings-profile",
    ),
  ).toHaveLength(0);
  await button(settings, "Save profile").click();
  await expect(settings.getByText("Profile saved.")).toBeVisible();
  const saved = (await settingsCalls(page)).find(
    (call) => call.args.action === "save-settings-profile",
  )!;
  expect(saved.args.input).toMatchObject({
    displayName: "My edit",
    jobRole: "Engineer",
    expectedRevision: "profile-2",
  });
});
