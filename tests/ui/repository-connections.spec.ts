import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

async function capture(page: Page, info: TestInfo, name: string) {
  await page.screenshot({
    path: info.outputPath(`${name}.png`),
    animations: "disabled",
  });
}

async function fixture(
  page: Page,
  access = "ready",
  enabled = true,
  onboarding = false,
) {
  await page.addInitScript(
    ({ access, enabled, onboarding }) => {
      const calls: {
        action: string;
        input: Record<string, unknown>;
        context: unknown;
      }[] = [];
      const repository = {
        id: "4242",
        fullName: "fixtures/private-repo",
        cloneUrl: "https://github.com/fixtures/private-repo.git",
        defaultBranch: "main",
        private: true,
        revision: 1,
      };
      const source = {
        id: "source",
        name: "private-repo",
        repository,
        repositoryRevision: 1,
        path: null as string | null,
      };
      const jobs: {
        id: string;
        projectId: string;
        sourceId: string;
        state: string;
        message: string;
        destination: string;
      }[] = [];
      let connected = true;
      let onboardingActive = onboarding;
      const requests = [
        {
          id: "request",
          projectId: "project",
          sourceId: "source",
          requester: "member",
          githubId: "102",
          githubLogin: "fixture-member",
          repositoryId: "4242",
          fullName: repository.fullName,
          reason: "Need repository access",
          status: "requested",
          revision: 1,
          note: "",
          createdAt: "2026-11-09T08:00:00Z",
          updatedAt: "2026-11-09T08:00:00Z",
          canReview: true,
        },
      ];
      Object.assign(window, {
        repositoryCalls: calls,
        isTauri: true,
        __TAURI_INTERNALS__: {
          transformCallback: () => 1,
          unregisterCallback: () => {},
          invoke: async (
            command: string,
            args: Record<string, unknown> = {},
          ) => {
            if (command === "snapshot")
              return {
                user: "user",
                config: { apiUrl: "https://test.orka", syncMinutes: 15 },
                projects: [
                  {
                    id: "project",
                    name: "Product",
                    role: "owner",
                    sources: [source],
                  },
                ],
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
                onboarding: onboarding
                  ? {
                      active: onboardingActive,
                      location: { ok: true },
                      draft: {
                        step: "discover",
                        projects: [],
                        selected: [],
                        folder: "",
                        sharing: {
                          memory: false,
                          skill: false,
                          session: false,
                          plan: false,
                          env: false,
                        },
                      },
                    }
                  : undefined,
              };
            if (command === "sync_progress")
              return { user: "user", progress: null };
            if (command === "repository_command") {
              const action = args.action as string,
                input = (args.input ?? {}) as Record<string, unknown>;
              calls.push({ action, input, context: args.context });
              if (action === "capabilities") return { enabled };
              if (action === "status")
                return {
                  connected,
                  identity: connected
                    ? { id: "101", login: "fixture-owner" }
                    : null,
                  installationUrl:
                    "https://github.com/apps/orka/installations/new",
                };
              if (action === "jobs") return jobs;
              if (action === "access") return { state: access };
              if (action === "default-directory") return "/local/Orka";
              if (action === "clone") {
                jobs.push({
                  id: "job",
                  projectId: "project",
                  sourceId: "source",
                  state: "cloning",
                  message: "Git transfer: 45%",
                  destination: `${input.directory}/${input.folderName}`,
                });
                return jobs[0];
              }
              if (action === "cancel-clone") {
                jobs[0].state = "canceled";
                jobs[0].message = "Clone canceled";
                return { ok: true };
              }
              if (action === "disconnect") {
                connected = false;
                return { connected: false };
              }
              if (action === "installations")
                return {
                  items: [{ id: "17", name: "fixtures" }],
                  nextPage: null,
                };
              if (action === "repositories")
                return { items: [repository], nextPage: 2 };
              if (action === "request-access") return { id: "request" };
              if (action === "requests")
                return { items: requests, nextOffset: null };
              if (action === "review") {
                requests[0].status = String(input.status);
                requests[0].revision++;
                requests[0].note = String(input.note);
                return { ok: true };
              }
              return {};
            }
            if (command === "plugin:dialog|open") return "/chosen/workspace";
            if (command === "project_skill_usage") return { counts: {} };
            if (command === "auth_capabilities")
              return {
                auth: { password: true },
                repositories: { github: enabled ? 1 : 0 },
              };
            if (command === "governance_command")
              return {
                governed: false,
                owner: true,
                policyRevision: 1,
                policy: {},
                access: {},
                members: [{ id: "user", name: "Fixture", role: "owner" }],
                memberRules: [],
                resourceCount: 0,
                requests: [],
              };
            if (command === "onboarding_command") {
              if (args.action === "complete") onboardingActive = false;
              return {
                displayName: "Fixture",
                jobRole: "Engineer",
                supported: true,
              };
            }
            return {};
          },
        },
      });
    },
    { access, enabled, onboarding },
  );
  await page.goto("/");
  if (onboarding) {
    await expect(
      page.getByRole("button", { name: "Connect a GitHub repository" }),
    ).toBeVisible();
    return;
  }
  await expect(
    page.getByRole("button", { name: "Connect repositories", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Connect repositories", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Settings", exact: true }),
  ).toBeVisible();
}

for (const width of [1160, 900])
  test(`private clone reviews destination, preserves context and supports cancellation at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 900 ? 640 : 800 });
    await fixture(page);
    const panel = page.getByRole("region", { name: "GitHub repositories" });
    await expect(
      panel.getByRole("button", { name: "Clone & connect", exact: true }),
    ).toBeDisabled();
    if (width === 1160)
      await capture(page, info, "github-connections-overview");
    await panel.getByRole("button", { name: "Check access" }).click();
    await panel
      .getByRole("button", { name: "Clone & connect", exact: true })
      .click();
    await expect(
      panel.getByRole("textbox", { name: "Workspace location" }),
    ).toHaveValue("/local/Orka");
    await panel
      .getByRole("button", { name: "Choose workspace folder" })
      .click();
    await panel
      .getByRole("textbox", { name: "Checkout folder name" })
      .fill("my-checkout");
    await expect(
      panel.getByText("Destination: /chosen/workspace/my-checkout"),
    ).toBeVisible();
    await capture(page, info, `github-clone-destination-${width}`);
    expect(
      await page.evaluate(() =>
        (
          window as unknown as { repositoryCalls: { action: string }[] }
        ).repositoryCalls.some((call) => call.action === "clone"),
      ),
    ).toBe(false);
    await panel
      .getByRole("button", { name: "Start clone", exact: true })
      .click();
    await expect(panel.getByText("Git transfer: 45%")).toBeVisible();
    await panel
      .getByRole("button", { name: "Cancel clone", exact: true })
      .scrollIntoViewIfNeeded();
    await capture(page, info, `github-clone-progress-${width}`);
    const clone = await page.evaluate(() =>
      (
        window as unknown as {
          repositoryCalls: {
            action: string;
            input: unknown;
            context: unknown;
          }[];
        }
      ).repositoryCalls.find((call) => call.action === "clone"),
    );
    expect(clone?.input).toEqual({
      projectId: "project",
      sourceId: "source",
      directory: "/chosen/workspace",
      folderName: "my-checkout",
    });
    expect(clone?.context).toEqual({
      user: "user",
      service: "https://test.orka",
    });
    await panel
      .getByRole("button", { name: "Cancel clone", exact: true })
      .click();
    await expect(
      panel.getByText("Clone canceled", { exact: true }),
    ).toBeVisible();
    const violations = (
      await new AxeBuilder({ page }).include(".settings-workspace").analyze()
    ).violations;
    expect(violations).toEqual([]);
    await expect(page.locator(".settings-workspace")).toHaveJSProperty(
      "scrollWidth",
      await page
        .locator(".settings-workspace")
        .evaluate((element) => element.clientWidth),
    );
  });

test("denied access offers distinct person and app requests without enabling clone", async ({
  page,
}, info) => {
  await fixture(page, "access_unavailable");
  const panel = page.getByRole("region", { name: "GitHub repositories" });
  await panel.getByRole("button", { name: "Check access" }).click();
  await expect(
    panel.getByRole("button", { name: "Clone & connect", exact: true }),
  ).toBeDisabled();
  await expect(
    panel.getByRole("button", { name: "Request app approval" }),
  ).toBeVisible();
  await panel
    .getByRole("button", { name: "Request repository access" })
    .click();
  await panel
    .getByRole("textbox", { name: "Reason for repository access" })
    .fill("Implement the assigned change");
  await capture(page, info, "github-request-access");
  await panel.getByRole("button", { name: "Send repository request" }).click();
  await expect(panel.getByText(/Request sent to project owners/)).toBeVisible();
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { repositoryCalls: { action: string }[] }
      ).repositoryCalls.some((call) => call.action === "clone"),
    ),
  ).toBe(false);
});

test("repository discovery supports source selection and pagination", async ({
  page,
}, info) => {
  await fixture(page);
  const panel = page.getByRole("region", { name: "GitHub repositories" });
  await panel.getByRole("button", { name: "Browse repositories" }).click();
  await panel
    .getByRole("combobox", { name: "GitHub account" })
    .selectOption("17");
  await expect(
    panel.getByRole("button", { name: "Add repository source" }),
  ).toBeVisible();
  await panel
    .getByRole("combobox", { name: "Destination source" })
    .selectOption("source");
  await capture(page, info, "github-repository-browser");
  await panel
    .getByRole("button", { name: "Link repository", exact: true })
    .click();
  await expect(panel.getByText(/Repository linked/)).toBeVisible();
  await panel.getByRole("button", { name: "Load more repositories" }).click();
  const actions = await page.evaluate(
    () =>
      (
        window as unknown as {
          repositoryCalls: { action: string; input: unknown }[];
        }
      ).repositoryCalls,
  );
  expect(actions.find((call) => call.action === "bind")?.input).toEqual({
    projectId: "project",
    sourceId: "source",
    repositoryId: "4242",
    expectedRevision: 1,
  });
  expect(
    actions.filter((call) => call.action === "repositories").at(-1)?.input,
  ).toEqual({ installationId: "17", page: 2 });
});

test("disabled integration retains Locate folder and hides GitHub controls", async ({
  page,
}) => {
  await fixture(page, "ready", false);
  await expect(
    page.getByRole("region", { name: "GitHub repositories" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Locate Folder for private-repo",
      exact: true,
    }),
  ).toBeVisible();
});

test("repository request reviews remain waiting on GitHub until access is verified", async ({
  page,
}, info) => {
  await fixture(page);
  const settings = page.getByRole("region", { name: "Settings", exact: true });
  await settings.getByRole("button", { name: "Members", exact: true }).click();
  const requests = page.getByRole("region", {
    name: "Repository access requests",
  });
  await expect(
    requests.getByText("Status: requested", { exact: true }),
  ).toBeVisible();
  await expect(
    requests.getByRole("button", { name: "Coordinate in GitHub" }),
  ).toBeDisabled();
  await requests
    .getByRole("textbox", { name: "Review note for fixture-member" })
    .fill("Repository administrator will add you to the team");
  await capture(page, info, "github-review-request");
  await requests.getByRole("button", { name: "Coordinate in GitHub" }).click();
  await expect(
    requests.getByText("Status: waiting on github", { exact: true }),
  ).toBeVisible();
  await expect(
    requests.getByRole("button", { name: /Approve|Grant access/ }),
  ).toHaveCount(0);
});

test("first-run GitHub setup can connect an existing project without locating a folder", async ({
  page,
}, info) => {
  await fixture(page, "ready", true, true);
  await page
    .getByRole("button", { name: "Connect a GitHub repository" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Connect repositories from GitHub" }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "GitHub repositories" }),
  ).toBeVisible();
  await capture(page, info, "github-onboarding");
  await page.getByRole("button", { name: "Continue to workspace" }).click();
  await expect(
    page.getByRole("button", { name: "Connect repositories", exact: true }),
  ).toBeVisible();
});
