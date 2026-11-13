import {
  test,
  expect,
  type Page,
  type TestInfo,
  type Locator,
} from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

interface Call {
  action: string;
  input: Record<string, unknown>;
  context: unknown;
}
declare global {
  interface Window {
    repositoryCalls: Call[];
    repositoryControl: {
      access: (value: string) => void;
      fail: (value: boolean) => void;
      complete: () => void;
      install: () => void;
      revokeClone: () => void;
    };
  }
}
async function capture(page: Page, info: TestInfo, name: string) {
  await page.screenshot({
    path: info.outputPath(`${name}.png`),
    animations: "disabled",
  });
}
async function fixture(
  page: Page,
  options: {
    access?: string;
    enabled?: boolean;
    onboarding?: boolean;
    connected?: boolean;
    github?: boolean;
    unbound?: boolean;
    empty?: boolean;
    accounts?: number;
    pagination?: boolean;
    interrupted?: boolean;
    pending?: boolean;
    cloneFailsOnce?: boolean;
    failed?: boolean;
    statusFailsOnce?: boolean;
    multiple?: boolean;
    reconnect?: boolean;
    delayedAuthStatus?: boolean;
    pollFailsOnce?: boolean;
    pollDeclined?: boolean;
    localMatch?: boolean;
    matchingFailsOnce?: boolean;
  } = {},
) {
  await page.addInitScript((options) => {
    const repository = {
      id: "4242",
      fullName: "fixtures/private-repo",
      cloneUrl: "https://github.com/fixtures/private-repo.git",
      defaultBranch: "main",
      private: true,
      revision: 1,
    };
    const available = {
      ...repository,
      id: "8484",
      fullName: "fixtures/web-app",
      cloneUrl: "https://github.com/fixtures/web-app.git",
    };
    type Source = {
      id: string;
      name: string;
      repository?: typeof repository;
      repositoryRevision?: number;
      path: string | null;
      folderState: "connected" | "reconnect" | "locate";
    };
    const source: Source = {
      id: "source",
      name: "private-repo",
      repository: options.unbound ? undefined : repository,
      repositoryRevision: options.unbound ? 0 : 1,
      path:
        options.connected || options.reconnect
          ? "/Projects/private-repo"
          : null,
      folderState: options.reconnect
        ? "reconnect"
        : options.connected
          ? "connected"
          : "locate",
    };
    const off = {
      memory: false,
      session: false,
      skill: false,
      plan: false,
      env: false,
    };
    const projects = [
      {
        id: "project",
        name: "Product",
        role: "owner",
        sources: options.empty
          ? []
          : options.multiple
            ? [
                source,
                {
                  ...source,
                  id: "source-two",
                  name: "service",
                  repository: {
                    ...repository,
                    id: "9696",
                    fullName: "fixtures/service",
                  },
                },
              ]
            : [source],
        sharing: off,
      },
    ];
    const jobs: {
      id: string;
      projectId: string;
      sourceId: string;
      state: string;
      message: string;
      destination: string;
      folderIdentity?: string;
    }[] = options.interrupted
      ? [
          {
            id: "job",
            projectId: "project",
            sourceId: "source",
            state: "interrupted",
            message: "Clone complete; connecting was interrupted",
            destination: "/local/Orka/private-repo",
            folderIdentity: "safe-checkout",
          },
        ]
      : [];
    let pollAttempts = 0;
    let matchingAttempts = 0;
    let cloneAttempts = 0,
      statusAttempts = 0,
      accountsInstalled = options.accounts !== 0;
    let access = options.access ?? "ready",
      failure = options.failed ?? false,
      connected = options.github ?? true,
      onboardingActive = options.onboarding ?? false;
    const requests = [
      {
        id: "request",
        projectId: "project",
        sourceId: "source",
        requester: options.pending ? "user" : "member",
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
      repositoryCalls: [],
      repositoryControl: {
        revokeClone: () => {
          jobs[0].state = "failed";
          jobs[0].message = "GitHub access revoked";
          access = "access_unavailable";
        },
        install: () => {
          accountsInstalled = true;
        },
        access: (value: string) => {
          access = value;
        },
        fail: (value: boolean) => {
          failure = value;
        },
        complete: () => {
          for (const job of jobs) {
            job.state = "connected";
            job.message = "Repository connected";
            const item = projects
              .flatMap((project) => project.sources)
              .find((source) => source.id === job.sourceId);
            if (item) {
              item.path = job.destination;
              item.folderState = "connected";
            }
          }
        },
      },
      isTauri: true,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        unregisterCallback: () => {},
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          if (command === "snapshot")
            return structuredClone({
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
              onboarding: options.onboarding
                ? {
                    active: onboardingActive,
                    location: { ok: true },
                    draft: {
                      step: "discover",
                      projects: [],
                      selected: [],
                      folder: "",
                      sharing: off,
                    },
                  }
                : undefined,
            });
          if (command === "sync_progress")
            return { user: "user", progress: null };
          if (command === "repository_command") {
            const action = args.action as string,
              input = (args.input ?? {}) as Record<string, unknown>;
            window.repositoryCalls.push({
              action,
              input,
              context: args.context,
            });
            if (action === "capabilities")
              return { enabled: options.enabled ?? true };
            if (action === "status") {
              if (options.statusFailsOnce && statusAttempts++ === 0)
                throw new Error("GitHub status unavailable");
              if (options.delayedAuthStatus && connected)
                await new Promise((resolve) => setTimeout(resolve, 120));
              return {
                connected,
                identity: connected
                  ? { id: "101", login: "fixture-owner" }
                  : null,
                installationUrl:
                  "https://github.com/apps/orka/installations/new",
              };
            }
            if (action === "access-status") {
              if (failure) throw new Error("Service unavailable");
              return {
                state: connected ? access : "not_connected",
                checkedAt: "2026-11-09T08:00:00Z",
              };
            }
            if (action === "begin")
              return {
                id: "authorization",
                userCode: "ABCD-EFGH",
                verificationUrl: "https://github.com/login/device",
                interval: 5,
                expiresIn: 900,
              };
            if (action === "poll") {
              if (options.pollFailsOnce && pollAttempts++ === 0)
                throw new Error("Temporary network failure");
              if (options.pollDeclined) return { error: "access_denied" };
              connected = true;
              return { connected: true };
            }
            if (action === "disconnect") {
              connected = false;
              return { ok: true };
            }
            if (action === "matching-source") {
              if (options.matchingFailsOnce && matchingAttempts++ === 0)
                throw new Error(
                  "More than one connected folder matches this repository",
                );
              return options.localMatch ? { sourceId: "source" } : null;
            }
            if (action === "jobs") return structuredClone(jobs);
            if (action === "default-directory") return "/local/Orka";
            if (action === "installations")
              return {
                items: !accountsInstalled
                  ? []
                  : options.accounts === 2
                    ? [
                        { id: "17", name: "fixtures" },
                        { id: "18", name: "team" },
                      ]
                    : [{ id: "17", name: "fixtures" }],
                nextPage: null,
              };
            if (action === "repositories")
              return {
                items: [
                  input.installationId === "18"
                    ? { ...available, fullName: "team/web-app" }
                    : available,
                  ...(options.matchingFailsOnce
                    ? [
                        {
                          ...available,
                          id: "9999",
                          fullName: "fixtures/another-app",
                        },
                      ]
                    : []),
                ],
                nextPage: options.pagination && input.page === 1 ? 2 : null,
              };
            if (action === "add-source") {
              const project = projects.find(
                (project) => project.id === input.projectId,
              )!;
              project.sources.push({
                id: "added",
                name: "web-app",
                repository: available,
                repositoryRevision: 1,
                path: null,
                folderState: "locate",
              });
              return { sourceId: "added", repository: available, revision: 1 };
            }
            if (action === "bind") {
              const item = projects
                .flatMap((project) => project.sources)
                .find((source) => source.id === input.sourceId)!;
              item.repository = available;
              item.repositoryRevision = 1;
              return { ok: true };
            }
            if (action === "unlink") {
              delete source.repository;
              source.repositoryRevision = 2;
              return { ok: true };
            }
            if (action === "clone") {
              if (options.cloneFailsOnce && cloneAttempts++ === 0)
                throw new Error("Destination already exists");
              const job = {
                id: "job",
                projectId: String(input.projectId),
                sourceId: String(input.sourceId),
                state: "cloning",
                message: "Git transfer: 45%",
                destination: `${input.directory}/${input.folderName}`,
              };
              jobs.unshift(job);
              return structuredClone(job);
            }
            if (action === "cancel-clone") {
              jobs[0].state = "canceled";
              jobs[0].message = "Clone canceled";
              return { ok: true };
            }
            if (action === "retry-connect") {
              window.repositoryControl.complete();
              return { ok: true };
            }
            if (action === "request-access") {
              requests[0].requester = "user";
              return { id: "request" };
            }
            if (action === "requests")
              return { items: requests, nextOffset: null };
            if (action === "review") {
              requests[0].status = String(input.status);
              requests[0].revision++;
              return { ok: true };
            }
            return {};
          }
          if (command === "cloud_action") {
            if (args.action === "join") {
              projects[0].role = "member";
              return { id: "project", repositorySetup: true };
            }
            projects.push({
              id: "created",
              name: String((args.input as { name: string }).name ?? "Joined"),
              role: "owner",
              sources: [],
              sharing: off,
            });
            return { id: "created", repositorySetup: true };
          }
          if (command === "plugin:dialog|open") return "/chosen/workspace";
          if (command === "connect_project_sources") {
            source.path = "/chosen/workspace";
            source.folderState = "connected";
            return {};
          }
          if (command === "project_skill_usage") return { counts: {} };
          if (command === "auth_capabilities")
            return {
              auth: { password: true },
              repositories: { github: options.enabled === false ? 0 : 1 },
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
  }, options);
  await page.goto("/");
  if (options.onboarding) return;
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("region", { name: "Settings", exact: true })
    .getByRole("button", { name: "General", exact: true })
    .click();
}
const panel = (page: Page) =>
  page.getByRole("region", { name: "Project repositories" });
const picker = (page: Page) =>
  page.getByRole("dialog", { name: "Connect repository", exact: true });
const calls = (page: Page) => page.evaluate(() => window.repositoryCalls);
async function choose(page: Page, control: Locator, value: string) {
  await control.click();
  const labels: Record<string, string> = {
    "8484": "fixtures/web-app · Private",
    "9999": "fixtures/another-app · Private",
    "17": "fixtures",
    "18": "team",
  };
  await page.getByRole("option", { name: labels[value], exact: true }).click();
}

for (const width of [1160, 900])
  test(`automatic access and one connect action at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 900 ? 640 : 800 });
    await fixture(page);
    await expect(
      panel(page).getByRole("img", { name: "GitHub access verified" }),
    ).toBeVisible();
    await expect(
      panel(page).getByRole("button", { name: "Check access", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", {
        name: /Reconnect GitHub|Disconnect GitHub|Configure GitHub access|Browse repositories/,
      }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Locate Folder for private-repo" }),
    ).toHaveCount(0);
    await capture(page, info, `repositories-after-${width}`);
    await panel(page)
      .getByRole("button", { name: "Connect", exact: true })
      .click();
    await expect(
      picker(page).getByText("/local/Orka/private-repo", { exact: false }),
    ).toBeVisible();
    await expect(
      picker(page).getByRole("textbox", { name: "Checkout folder name" }),
    ).not.toBeVisible();
    expect(
      (await calls(page)).filter((call) => call.action === "clone"),
    ).toHaveLength(0);
    const heading = await picker(page)
      .locator(".repository-dialog-heading h2")
      .boundingBox();
    const close = await picker(page)
      .getByRole("button", { name: "Close repository connection" })
      .boundingBox();
    expect(heading).not.toBeNull();
    expect(close).not.toBeNull();
    expect(
      Math.abs(heading!.y + heading!.height / 2 - close!.y - close!.height / 2),
    ).toBeLessThanOrEqual(1);
    await capture(page, info, `destination-after-${width}`);
    await picker(page)
      .getByRole("button", { name: "Connect repository", exact: true })
      .click();
    await expect(picker(page)).toHaveCount(0);
    await expect(panel(page).getByText("Git transfer: 45%")).toBeVisible();
    await capture(page, info, `progress-after-${width}`);
    const clone = (await calls(page)).find((call) => call.action === "clone");
    expect(clone?.input).toEqual({
      projectId: "project",
      sourceId: "source",
      directory: "/local/Orka",
      folderName: "private-repo",
    });
    expect(clone?.context).toEqual({
      user: "user",
      service: "https://test.orka",
    });
    await panel(page)
      .getByRole("button", { name: "Cancel clone for private-repo" })
      .click();
    await expect(panel(page).getByText("Clone canceled")).toBeVisible();
    expect(
      (await new AxeBuilder({ page }).include(".settings-workspace").analyze())
        .violations,
    ).toEqual([]);
    expect(
      await page
        .locator(".settings-workspace")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
  });

for (const width of [1160, 900])
  test(`discovery is account, repository, and one connect action at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 900 ? 640 : 800 });
    await fixture(page);
    await panel(page)
      .getByRole("button", { name: "Connect repository", exact: true })
      .click();
    await expect(
      picker(page).getByRole("combobox", { name: "GitHub account" }),
    ).toHaveText("fixtures");
    await choose(
      page,
      picker(page).getByRole("combobox", { name: "Repository", exact: true }),
      "8484",
    );
    await expect(picker(page).getByRole("combobox")).toHaveCount(2);
    await expect(
      picker(page).getByRole("button", {
        name: /Disconnect GitHub|Connect another GitHub account|Manage GitHub access/,
      }),
    ).not.toBeVisible();
    const primary = picker(page).getByRole("button", {
      name: "Connect repository",
      exact: true,
    });
    const secondary = picker(page).getByRole("button", {
      name: "Use Local Folder",
      exact: true,
    });
    const primaryBox = await primary.boundingBox();
    const secondaryBox = await secondary.boundingBox();
    expect(primaryBox).not.toBeNull();
    expect(secondaryBox).not.toBeNull();
    expect(Math.abs(primaryBox!.y - secondaryBox!.y)).toBeLessThanOrEqual(1);
    expect(secondaryBox!.x + secondaryBox!.width).toBeLessThan(primaryBox!.x);
    await capture(page, info, `discovery-after-${width}`);
    expect(
      (await new AxeBuilder({ page }).include('[role="dialog"]').analyze())
        .violations,
    ).toEqual([]);
    await picker(page)
      .getByRole("button", { name: "Connect repository", exact: true })
      .click();
    await expect(picker(page)).toHaveCount(0);
    const operations = await calls(page);
    expect(
      operations.find((call) => call.action === "add-source")?.input,
    ).toEqual({ projectId: "project", repositoryId: "8484" });
    expect(operations.find((call) => call.action === "clone")?.input).toEqual({
      projectId: "project",
      sourceId: "added",
      directory: "/local/Orka",
      folderName: "web-app",
    });
  });

test("a failed clone retains its repository binding for retry", async ({
  page,
}) => {
  await fixture(page, { cloneFailsOnce: true });
  await panel(page)
    .getByRole("button", { name: "Connect repository", exact: true })
    .click();
  await choose(
    page,
    picker(page).getByRole("combobox", { name: "Repository", exact: true }),
    "8484",
  );
  await picker(page)
    .getByRole("button", { name: "Connect repository", exact: true })
    .click();
  await expect(picker(page).getByRole("alert")).toContainText(
    "Destination already exists",
  );
  await picker(page).getByText("Change location", { exact: true }).click();
  await picker(page)
    .getByRole("textbox", { name: "Checkout folder name" })
    .fill("web-app-new");
  await picker(page)
    .getByRole("button", { name: "Connect repository", exact: true })
    .click();
  await expect(picker(page)).toHaveCount(0);
  expect(
    (await calls(page)).filter((call) => call.action === "add-source"),
  ).toHaveLength(1);
  expect(
    (await calls(page)).filter((call) => call.action === "clone").at(-1)?.input,
  ).toMatchObject({ sourceId: "added", folderName: "web-app-new" });
});

test("location overrides are available only when requested", async ({
  page,
}) => {
  await fixture(page);
  await panel(page)
    .getByRole("button", { name: "Connect", exact: true })
    .click();
  await picker(page).getByText("Change location", { exact: true }).click();
  await picker(page)
    .getByRole("button", { name: "Choose folder", exact: true })
    .click();
  await picker(page)
    .getByRole("textbox", { name: "Checkout folder name" })
    .fill("my-checkout");
  await picker(page)
    .getByRole("button", { name: "Connect repository", exact: true })
    .click();
  expect(
    (await calls(page)).find((call) => call.action === "clone")?.input,
  ).toMatchObject({
    directory: "/chosen/workspace",
    folderName: "my-checkout",
  });
});

test("connected checkouts have no clone form or connect button", async ({
  page,
}, info) => {
  await fixture(page, { connected: true });
  await expect(panel(page).getByText("Connected on this Mac")).toBeVisible();
  await expect(
    panel(page).getByRole("button", { name: "Connect", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Checkout folder name" }),
  ).toHaveCount(0);
  await capture(page, info, "connected-after");
  expect((await calls(page)).some((call) => call.action === "clone")).toBe(
    false,
  );
});

test("missing access has one request action and contextual app help", async ({
  page,
}, info) => {
  await fixture(page, { access: "access_unavailable" });
  await expect(
    panel(page).getByRole("img", { name: "GitHub access required" }),
  ).toBeVisible();
  await expect(
    panel(page).getByRole("button", { name: "Connect", exact: true }),
  ).toHaveCount(0);
  await panel(page)
    .getByRole("button", { name: "Request access", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Request repository access",
  });
  await dialog
    .getByRole("textbox", { name: "Reason for repository access" })
    .fill("Implement the assigned change");
  await expect(
    dialog.getByRole("button", { name: "Manage GitHub access" }),
  ).not.toBeVisible();
  await capture(page, info, "access-after");
  await dialog
    .getByRole("button", { name: "Send request", exact: true })
    .click();
  await expect(
    panel(page).getByRole("button", { name: "Request sent" }),
  ).toBeDisabled();
  expect((await calls(page)).some((call) => call.action === "clone")).toBe(
    false,
  );
  await page.evaluate(() => {
    window.repositoryControl.access("ready");
    window.dispatchEvent(new Event("focus"));
  });
  await expect(
    panel(page).getByRole("img", { name: "GitHub access verified" }),
  ).toBeVisible();
  await expect(
    panel(page).getByRole("button", { name: "Connect", exact: true }),
  ).toBeEnabled();
});

test("a clone authorization failure replaces a cached green tick with request access", async ({
  page,
}) => {
  await fixture(page);
  await panel(page)
    .getByRole("button", { name: "Connect", exact: true })
    .click();
  await picker(page)
    .getByRole("button", { name: "Connect repository", exact: true })
    .click();
  await expect(panel(page).getByText("Git transfer: 45%")).toBeVisible();
  await page.evaluate(() => window.repositoryControl.revokeClone());
  await expect(
    panel(page).getByRole("button", { name: "Request access", exact: true }),
  ).toBeVisible();
  await expect(
    panel(page).getByRole("img", { name: "GitHub access verified" }),
  ).toHaveCount(0);
  expect(
    (await calls(page)).some(
      (call) => call.action === "access-status" && call.input.force === true,
    ),
  ).toBe(true);
});

test("an existing pending request is restored", async ({ page }) => {
  await fixture(page, { access: "access_unavailable", pending: true });
  await expect(
    panel(page).getByRole("button", { name: "Request sent" }),
  ).toBeDisabled();
});

test("an unavailable check never shows a green status and offers a compact retry", async ({
  page,
}) => {
  await fixture(page, { failed: true });
  await expect(
    panel(page).getByRole("img", { name: "Could not check GitHub access" }),
  ).toBeVisible();
  await page.evaluate(() => window.repositoryControl.fail(false));
  await panel(page)
    .getByRole("button", { name: "Retry access check for private-repo" })
    .click();
  await expect(
    panel(page).getByRole("img", { name: "GitHub access verified" }),
  ).toBeVisible();
});

test("accounts and paginated repository discovery retain simple selection", async ({
  page,
}) => {
  await fixture(page, { accounts: 2, pagination: true });
  await panel(page)
    .getByRole("button", { name: "Connect repository", exact: true })
    .click();
  await choose(
    page,
    picker(page).getByRole("combobox", { name: "GitHub account" }),
    "18",
  );
  await picker(page)
    .getByRole("combobox", { name: "Repository", exact: true })
    .click();
  await expect(page.getByRole("option", { name: /team\/web-app/ })).toHaveCount(
    1,
  );
  await page.keyboard.press("Escape");
  await picker(page).getByRole("button", { name: "More repositories" }).click();
  expect(
    (await calls(page)).filter((call) => call.action === "repositories").at(-1)
      ?.input,
  ).toEqual({ installationId: "18", page: 2 });
  await picker(page)
    .getByRole("combobox", { name: "Repository", exact: true })
    .click();
  await expect(page.getByRole("option", { name: /team\/web-app/ })).toHaveCount(
    1,
  );
  await page.keyboard.press("Escape");
});

test("existing local folders can be linked without cloning again", async ({
  page,
}) => {
  await fixture(page, { connected: true, unbound: true });
  await panel(page)
    .getByRole("button", { name: "Options for private-repo" })
    .click();
  await page.getByRole("menuitem", { name: "Link GitHub repository" }).click();
  await choose(
    page,
    picker(page).getByRole("combobox", { name: "Repository", exact: true }),
    "8484",
  );
  await expect(
    picker(page).getByText("Change location", { exact: true }),
  ).toHaveCount(0);
  await picker(page)
    .getByRole("button", { name: "Connect repository", exact: true })
    .click();
  const operations = await calls(page);
  expect(operations.find((call) => call.action === "bind")?.input).toEqual({
    projectId: "project",
    sourceId: "source",
    repositoryId: "8484",
    expectedRevision: 0,
  });
  expect(operations.some((call) => call.action === "clone")).toBe(false);
});

test("account controls and unlinking are tucked into explicit menus", async ({
  page,
}) => {
  await fixture(page, { connected: true });
  await expect(
    page.getByRole("menuitem", { name: "Remove GitHub link" }),
  ).toHaveCount(0);
  await panel(page)
    .getByRole("button", { name: "Options for private-repo" })
    .click();
  await page.getByRole("menuitem", { name: "Remove GitHub link" }).click();
  await expect(
    panel(page).getByRole("img", { name: "GitHub access verified" }),
  ).toHaveCount(0);
  await expect(
    panel(page).getByText("private-repo", { exact: true }),
  ).toBeVisible();
  expect(
    (await calls(page)).find((call) => call.action === "unlink")?.input,
  ).toMatchObject({ expectedRevision: 1 });
  await panel(page)
    .getByRole("button", { name: "Connect repository", exact: true })
    .click();
  await picker(page)
    .getByRole("button", { name: /GitHub account options/ })
    .click();
  await expect(
    page.getByRole("button", { name: "Disconnect GitHub", exact: true }),
  ).toBeVisible();
});

test("a saved checkout needing reconnection is reused without cloning", async ({
  page,
}) => {
  await fixture(page, { reconnect: true });
  await panel(page)
    .getByRole("button", { name: "Reconnect", exact: true })
    .click();
  await expect(panel(page).getByText("Connected on this Mac")).toBeVisible();
  expect((await calls(page)).some((call) => call.action === "clone")).toBe(
    false,
  );
});

test("authorization waits for access and offers a request when the repository is denied", async ({
  page,
}) => {
  await fixture(page, { github: false, access: "access_unavailable" });
  await panel(page)
    .getByRole("button", { name: "Connect GitHub", exact: true })
    .click();
  await picker(page)
    .getByRole("button", { name: "Connect GitHub", exact: true })
    .click();
  await expect(
    picker(page).getByRole("button", { name: "Request access", exact: true }),
  ).toBeVisible({ timeout: 10000 });
  await expect(
    picker(page).getByRole("button", {
      name: "Connect repository",
      exact: true,
    }),
  ).toHaveCount(0);
  await picker(page)
    .getByRole("button", { name: "Request access", exact: true })
    .click();
  await expect(
    page
      .getByRole("dialog", { name: "Request repository access" })
      .getByRole("textbox", { name: "Reason for repository access" }),
  ).toBeVisible();
  expect((await calls(page)).some((call) => call.action === "clone")).toBe(
    false,
  );
});

test("GitHub authorization is shown only when needed and can be canceled", async ({
  page,
}) => {
  await fixture(page, { github: false });
  await panel(page)
    .getByRole("button", { name: "Connect GitHub", exact: true })
    .click();
  await picker(page)
    .getByRole("button", { name: "Connect GitHub", exact: true })
    .click();
  await expect(picker(page).getByText("ABCD-EFGH")).toBeVisible();
  await expect(
    picker(page).getByRole("button", {
      name: "I’ve authorized GitHub",
      exact: true,
    }),
  ).toHaveClass(/ui-button--primary/);
  const surface = await picker(page).evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  await expect(
    picker(page).getByRole("button", { name: "Open GitHub", exact: true }),
  ).not.toHaveCSS("background-color", surface);
  await picker(page)
    .getByRole("button", { name: "Close repository connection" })
    .click();
  await expect(picker(page)).toHaveCount(0);
  expect(
    (await calls(page)).some((call) => call.action === "cancel-authorization"),
  ).toBe(true);
});

test("a temporary GitHub status failure retries without asking for consent again", async ({
  page,
}) => {
  await fixture(page, { statusFailsOnce: true });
  await panel(page)
    .getByRole("button", { name: "Connect GitHub", exact: true })
    .click();
  await picker(page)
    .getByRole("button", { name: "Retry", exact: true })
    .click();
  await expect(
    picker(page).getByRole("button", {
      name: "Connect repository",
      exact: true,
    }),
  ).toBeEnabled();
  expect((await calls(page)).some((call) => call.action === "begin")).toBe(
    false,
  );
});

test("missing repositories refresh automatically after GitHub approval", async ({
  page,
}) => {
  await fixture(page, { accounts: 0 });
  await panel(page)
    .getByRole("button", { name: "Connect repository", exact: true })
    .click();
  await picker(page)
    .getByRole("button", { name: "Manage GitHub access", exact: true })
    .click();
  await page.evaluate(() => {
    window.repositoryControl.install();
    window.dispatchEvent(new Event("focus"));
  });
  await expect(
    picker(page).getByRole("combobox", { name: "GitHub account" }),
  ).toHaveText("fixtures");
  await picker(page)
    .getByRole("combobox", { name: "Repository", exact: true })
    .click();
  await expect(
    page.getByRole("option", { name: /fixtures\/web-app/ }),
  ).toHaveCount(1);
  await page.keyboard.press("Escape");
});

test("project creation moves directly into repository selection", async ({
  page,
}, info) => {
  await fixture(page);
  await page.getByRole("button", { name: "Add project", exact: true }).click();
  const create = page.getByRole("dialog", {
    name: "Create project",
    exact: true,
  });
  await expect(
    create
      .getByRole("group", { name: "Repository source" })
      .getByRole("button", { name: "GitHub repository", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await create
    .getByRole("textbox", { name: "Project name", exact: true })
    .fill("New product");
  await create
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await expect(
    picker(page).getByRole("combobox", { name: "GitHub account" }),
  ).toHaveText("fixtures");
  await choose(
    page,
    picker(page).getByRole("combobox", { name: "Repository", exact: true }),
    "8484",
  );
  await capture(page, info, "project-setup-after");
});

test("joining a multi-repository project connects its existing sources", async ({
  page,
}) => {
  await fixture(page, { multiple: true });
  await page.getByRole("button", { name: "Join project", exact: true }).click();
  const join = page.getByRole("dialog", { name: "Join project", exact: true });
  await join
    .getByRole("textbox", { name: "Invite link or token" })
    .fill("a".repeat(48));
  await join.getByRole("button", { name: "Join project", exact: true }).click();
  const setup = page.getByRole("dialog", {
    name: "Connect project repositories",
    exact: true,
  });
  await expect(
    setup.getByRole("button", { name: "Connect", exact: true }),
  ).toHaveCount(2);
  await expect(
    setup.getByRole("button", { name: "Connect repository", exact: true }),
  ).toHaveCount(0);
  await setup
    .getByRole("button", { name: "Connect", exact: true })
    .first()
    .click();
  await expect(picker(page).getByRole("combobox")).toHaveCount(0);
  await expect(
    picker(page).getByRole("button", {
      name: "Connect repository",
      exact: true,
    }),
  ).toBeEnabled();
});

test("interrupted completed checkouts offer finish connecting without another clone", async ({
  page,
}) => {
  await fixture(page, { interrupted: true });
  await panel(page).getByRole("button", { name: "Finish connecting" }).click();
  await expect(panel(page).getByText("Connected on this Mac")).toBeVisible();
  expect((await calls(page)).some((call) => call.action === "clone")).toBe(
    false,
  );
});

test("disabled integration keeps ordinary local folder setup", async ({
  page,
}) => {
  await fixture(page, { enabled: false });
  await expect(panel(page)).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Locate Folder for private-repo" }),
  ).toBeVisible();
});

for (const size of [
  { width: 1160, height: 800 },
  { width: 900, height: 640 },
]) {
  test(`first-run repository setup keeps its shell and picker at ${size.width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize(size);
    await fixture(page, { onboarding: true, empty: true });
    await page
      .getByRole("button", { name: "Connect a GitHub repository" })
      .click();
    await expect(picker(page)).toBeVisible();
    await expect(
      picker(page).getByRole("combobox", { name: "GitHub account" }),
    ).toHaveText("fixtures");
    await expect(
      picker(page).getByRole("combobox", { name: "Repository", exact: true }),
    ).toBeVisible();
    await picker(page)
      .getByRole("button", { name: "Close repository connection" })
      .click();
    await expect(page.getByRole("main")).toHaveCount(1);
    await expect(
      page.getByRole("list", { name: "Onboarding steps" }),
    ).toBeVisible();
    await expect(
      page.locator('.onboarding-flow__sidebar li[aria-current="step"]'),
    ).toContainText("Add your projects");
    await expect(
      page.locator(".onboarding-flow__steps-progress"),
    ).toBeVisible();
    await expect(
      page.locator(".onboarding-flow__illustration img"),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Connect a repository", exact: true }),
    ).toBeVisible();
    const setup = page.getByRole("region", { name: "Repository setup" });
    const canvas = await page.locator(".onboarding-flow__canvas").boundingBox();
    const setupBounds = await setup.boundingBox();
    expect(
      Math.abs(
        setupBounds!.x +
          setupBounds!.width / 2 -
          (canvas!.x + canvas!.width / 2),
      ),
    ).toBeLessThan(1);
    await expect(
      setup.getByRole("button", { name: "Open Orka", exact: true }),
    ).toBeInViewport();
    await page.screenshot({
      path: info.outputPath(`repository-shell-${size.width}.png`),
    });
    await setup
      .getByRole("combobox", { name: "Orka project" })
      .selectOption("");
    await expect(
      setup.getByRole("textbox", { name: "Project name", exact: true }),
    ).toBeVisible();
    await expect(setup.getByRole("combobox", { name: /sharing$/ })).toHaveCount(
      4,
    );
    await setup.getByRole("button", { name: "Back", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Add Project", exact: true }),
    ).toBeFocused();
    await page
      .getByRole("button", { name: "Connect a GitHub repository" })
      .click();
    await picker(page)
      .getByRole("button", { name: "Close repository connection" })
      .click();
    await page.getByRole("button", { name: "Open Orka", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Settings", exact: true }),
    ).toBeVisible();
  });
}

test("request review still records coordination without granting GitHub access", async ({
  page,
}) => {
  await fixture(page);
  await page
    .getByRole("region", { name: "Settings", exact: true })
    .getByRole("button", { name: "Members", exact: true })
    .click();
  const requests = page.getByRole("region", {
    name: "Repository access requests",
  });
  await expect(
    requests.getByRole("button", { name: "Update request", exact: true }),
  ).toBeDisabled();
  await expect(
    requests.getByText("Required when updating the request.", { exact: true }),
  ).toBeVisible();
  await requests
    .getByRole("textbox", { name: "Review note for fixture-member" })
    .fill("Administrator will add you to the team");
  const before = (await calls(page)).filter(
    (call) => call.action === "open-github",
  ).length;
  await requests
    .getByRole("button", { name: "Update request", exact: true })
    .click();
  await expect(
    requests.getByText("Status: Waiting on GitHub", { exact: true }),
  ).toBeVisible();
  expect(
    (await calls(page)).filter((call) => call.action === "open-github"),
  ).toHaveLength(before);
  await requests
    .getByRole("combobox", {
      name: "Request status for fixture-member",
      exact: true,
    })
    .click();
  await page
    .getByRole("option", { name: "Invitation sent", exact: true })
    .click();
  await requests
    .getByRole("button", { name: "Update request", exact: true })
    .click();
  expect(
    (await calls(page)).filter((call) => call.action === "review").at(-1)
      ?.input,
  ).toMatchObject({
    status: "invitation_pending",
    note: "Administrator will add you to the team",
  });
  await expect(
    requests.getByRole("button", { name: /Approve|Grant access/ }),
  ).toHaveCount(0);
});

test("one authorization updates the account after a delayed status response", async ({
  page,
}) => {
  await fixture(page, { github: false, delayedAuthStatus: true });
  await panel(page)
    .getByRole("button", { name: "Connect GitHub", exact: true })
    .click();
  await picker(page)
    .getByRole("button", { name: "Connect GitHub", exact: true })
    .click();
  await expect(
    picker(page).getByText("@fixture-owner", { exact: true }),
  ).toBeVisible({ timeout: 10000 });
  expect(
    (await calls(page)).filter((call) => call.action === "begin"),
  ).toHaveLength(1);
});

test("a temporary polling failure retains the same authorization and recovers", async ({
  page,
}) => {
  await fixture(page, {
    github: false,
    pollFailsOnce: true,
    delayedAuthStatus: true,
  });
  await panel(page)
    .getByRole("button", { name: "Connect GitHub", exact: true })
    .click();
  await picker(page)
    .getByRole("button", { name: "Connect GitHub", exact: true })
    .click();
  await expect(picker(page).getByRole("alert")).toContainText(
    "Temporary network failure",
    { timeout: 10000 },
  );
  await expect(picker(page).getByText("ABCD-EFGH")).toBeVisible();
  await expect(
    picker(page).getByText("GitHub connected", { exact: true }),
  ).toBeVisible({ timeout: 10000 });
  expect(
    (await calls(page)).filter((call) => call.action === "begin"),
  ).toHaveLength(1);
});

test("first authorization opens repository access and refreshes on return", async ({
  page,
}) => {
  await fixture(page, { github: false, accounts: 0 });
  await panel(page)
    .getByRole("button", { name: "Connect GitHub", exact: true })
    .click();
  await picker(page)
    .getByRole("button", { name: "Connect GitHub", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await calls(page)).filter(
          (call) =>
            call.action === "open-github" &&
            String(call.input.url).endsWith("/installations/new"),
        ).length,
      { timeout: 10000 },
    )
    .toBe(1);
  await expect(
    picker(page).getByText(
      "Choose repository access on GitHub, then return to Orka.",
    ),
  ).toBeVisible();
  await page.evaluate(() => {
    window.repositoryControl.install();
    window.dispatchEvent(new Event("focus"));
  });
  await expect(
    picker(page).getByText(
      "Choose repository access on GitHub, then return to Orka.",
    ),
  ).toHaveCount(0);
  expect(
    (await calls(page)).filter((call) => call.action === "begin"),
  ).toHaveLength(1);
});

test("discovery reuses an existing matching local checkout", async ({
  page,
}) => {
  await fixture(page, { connected: true, unbound: true, localMatch: true });
  await panel(page)
    .getByRole("button", { name: "Connect repository", exact: true })
    .click();
  await choose(
    page,
    picker(page).getByRole("combobox", { name: "Repository", exact: true }),
    "8484",
  );
  await expect(
    picker(page).getByText(
      "Your existing folder will be linked to GitHub. No clone is needed.",
    ),
  ).toBeVisible();
  await picker(page)
    .getByRole("button", { name: "Connect repository", exact: true })
    .click();
  await expect(picker(page)).toHaveCount(0);
  const operations = await calls(page);
  expect(
    operations.find((call) => call.action === "bind")?.input,
  ).toMatchObject({ sourceId: "source", repositoryId: "8484" });
  expect(
    operations.filter((call) => ["clone", "add-source"].includes(call.action)),
  ).toHaveLength(0);
});

test("choosing another repository clears a previous folder-matching error", async ({
  page,
}) => {
  await fixture(page, { matchingFailsOnce: true });
  await panel(page)
    .getByRole("button", { name: "Connect repository", exact: true })
    .click();
  const repository = picker(page).getByRole("combobox", {
    name: "Repository",
    exact: true,
  });
  await choose(page, repository, "8484");
  await expect(picker(page).getByRole("alert")).toContainText(
    "More than one connected folder",
  );
  await expect(
    picker(page).getByRole("button", {
      name: "Connect repository",
      exact: true,
    }),
  ).toBeDisabled();
  await choose(page, repository, "9999");
  await expect(picker(page).getByRole("alert")).toHaveCount(0);
  await expect(
    picker(page).getByRole("button", {
      name: "Connect repository",
      exact: true,
    }),
  ).toBeEnabled();
});

test("repository menus support keyboard selection and return focus", async ({
  page,
}) => {
  await fixture(page, { accounts: 2 });
  await panel(page)
    .getByRole("button", { name: "Connect repository", exact: true })
    .click();
  const account = picker(page).getByRole("combobox", {
    name: "GitHub account",
  });
  await expect(account).toHaveText("fixtures");
  await account.focus();
  await page.keyboard.press("ArrowDown");
  await expect(
    page.getByRole("option", { name: "fixtures", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("End");
  await expect(
    page.getByRole("option", { name: "team", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(account).toHaveText("team");
  await expect(account).toBeFocused();
  const repository = picker(page).getByRole("combobox", {
    name: "Repository",
    exact: true,
  });
  await repository.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("option", { name: "team/web-app · Private", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(repository).toBeFocused();
});

test("linked source context and ellipsis menus share actions and open the correct GitHub repository", async ({
  page,
}) => {
  await fixture(page, { connected: true });
  const source = panel(page).locator(".repository-card-row");
  await source.click({ button: "right" });
  const menu = page.getByRole("menu", {
    name: "Options for private-repo",
    exact: true,
  });
  const contextActions = await menu.getByRole("menuitem").allTextContents();
  await expect(
    menu.getByRole("menuitem", { name: "Show in Finder", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await panel(page)
    .getByRole("button", { name: "Options for private-repo", exact: true })
    .click();
  expect(await menu.getByRole("menuitem").allTextContents()).toEqual(
    contextActions,
  );
  await menu
    .getByRole("menuitem", { name: "Open repository on GitHub", exact: true })
    .click();
  expect(
    (await calls(page)).find((call) => call.action === "open-github")?.input,
  ).toEqual({ url: "https://github.com/fixtures/private-repo" });
});
