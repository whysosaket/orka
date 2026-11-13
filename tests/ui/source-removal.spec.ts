import { test, expect } from "@playwright/test";
import { settingsFixture, settingsCalls } from "./fixtures/settings.js";

test("owner removes a source after review while retaining its historical metadata", async ({
  page,
}, info) => {
  const settings = await settingsFixture(page, {
    sourceRows: [
      {
        id: "source",
        name: "desktop",
        path: "/Projects/desktop",
        folderState: "connected",
      },
      {
        id: "other",
        name: "api",
        path: "/Projects/api",
        folderState: "connected",
      },
    ],
  });
  const name = settings.getByRole("textbox", {
    name: "Project name",
    exact: true,
  });
  await name.fill("Unsaved project name");
  await settings
    .getByRole("button", { name: "Options for desktop", exact: true })
    .click();
  await page.screenshot({
    path: info.outputPath("source-options-after.png"),
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: "Remove source folder", exact: true })
    .click();
  const confirmation = page.getByRole("dialog", {
    name: "Remove source folder?",
    exact: true,
  });
  await expect(confirmation).toContainText("Remove desktop from the project?");
  await expect(confirmation).toContainText(
    "Local files and previously shared content are kept.",
  );
  await page.screenshot({
    path: info.outputPath("source-removal-after.png"),
    animations: "disabled",
  });
  await confirmation.getByRole("button", { name: "Stay", exact: true }).click();
  expect(
    (await settingsCalls(page)).some(
      (call) => call.args.action === "remove-source",
    ),
  ).toBe(false);
  await settings
    .getByRole("button", { name: "Options for desktop", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Remove source folder", exact: true })
    .click();
  await confirmation
    .getByRole("button", { name: "Remove source folder", exact: true })
    .click();
  await expect(
    settings.getByRole("button", { name: "Options for desktop", exact: true }),
  ).toHaveCount(0);
  await expect(
    settings.getByRole("button", { name: "Options for api", exact: true }),
  ).toBeVisible();
  await expect(name).toHaveValue("Unsaved project name");
  expect(
    (await settingsCalls(page)).find(
      (call) => call.args.action === "remove-source",
    )?.args.input,
  ).toEqual({ projectId: "one", sourceId: "source" });
  const source = await page.evaluate(
    () =>
      (
        window as unknown as {
          settingsState: {
            projects: {
              sources: {
                id: string;
                name: string;
                removedAt?: string;
                path: string | null;
              }[];
            }[];
          };
        }
      ).settingsState.projects[0].sources[0],
  );
  expect(source).toMatchObject({ id: "source", name: "desktop", path: null });
  expect(source.removedAt).toBeTruthy();
});

test("source removal failure keeps the source and retry visible", async ({
  page,
}) => {
  const settings = await settingsFixture(page, { failSourceRemoval: true });
  await settings
    .getByRole("button", { name: "Options for orka", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Remove source folder", exact: true })
    .click();
  const confirmation = page.getByRole("dialog", {
    name: "Remove source folder?",
    exact: true,
  });
  await confirmation
    .getByRole("button", { name: "Remove source folder", exact: true })
    .click();
  await expect(confirmation.getByRole("alert")).toContainText(
    "Service unavailable",
  );
  await expect(
    confirmation.getByRole("button", {
      name: "Remove source folder",
      exact: true,
    }),
  ).toBeEnabled();
  await confirmation.getByRole("button", { name: "Stay", exact: true }).click();
  await expect(
    settings.getByRole("button", { name: "Options for orka", exact: true }),
  ).toBeVisible();
});

test("members can disconnect stale folders and cannot remove project sources", async ({
  page,
}) => {
  const settings = await settingsFixture(page, {
    role: "member",
    folderState: "reconnect",
  });
  await settings
    .getByRole("button", { name: "Options for orka", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Remove source folder", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Disconnect folder on this Mac", exact: true })
    .click();
  const confirmation = page.getByRole("dialog", {
    name: "Disconnect folder?",
    exact: true,
  });
  await confirmation
    .getByRole("button", { name: "Disconnect folder", exact: true })
    .click();
  await expect(
    settings.getByRole("button", {
      name: "Locate Folder for orka",
      exact: true,
    }),
  ).toBeVisible();
  expect(
    (await settingsCalls(page)).find(
      (call) => call.command === "disconnect_project_source",
    )?.args,
  ).toEqual({ id: "one", sourceId: "source-one" });
});

test("queued changes prevent removal and disconnected removed sources remain hidden", async ({
  page,
}) => {
  const settings = await settingsFixture(page, {
    queued: true,
    sourceRows: [
      {
        id: "source",
        name: "desktop",
        path: "/Projects/desktop",
        folderState: "connected",
      },
      {
        id: "removed",
        name: "old-api",
        path: null,
        folderState: "locate",
        removedAt: "2026-11-13T00:00:00Z",
      },
    ],
  });
  await expect(settings.getByText("old-api", { exact: true })).toHaveCount(0);
  await settings
    .getByRole("button", { name: "Options for desktop", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Remove source folder", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", {
      name: "Disconnect folder on this Mac",
      exact: true,
    }),
  ).toBeDisabled();
  expect(
    (await settingsCalls(page)).some(
      (call) => call.args.action === "remove-source",
    ),
  ).toBe(false);
});

test("older services keep folder disconnection without offering unsupported removal", async ({
  page,
}) => {
  const settings = await settingsFixture(page, { olderService: true });
  await settings
    .getByRole("button", { name: "Options for orka", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Remove source folder", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Disconnect folder on this Mac",
      exact: true,
    }),
  ).toBeEnabled();
});
