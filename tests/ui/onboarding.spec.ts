import { setSharingMode } from "./fixtures/sharing-mode.js";
import { test, expect, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

test.describe("Retina artwork", () => {
  test.use({ deviceScaleFactor: 2, viewport: { width: 1440, height: 900 } });

  test("keeps Figma geometry while rendering Retina artwork", async ({
    page,
    context,
  }, info) => {
    await fixture(page, { step: "select" });
    const illustration = page.locator(".onboarding-flow__illustration img");
    await expect(illustration).toHaveJSProperty("naturalWidth", 64);
    expect(
      await illustration.evaluate(
        (image: HTMLImageElement) => image.currentSrc,
      ),
    ).toContain("@2x.png");
    expect(await illustration.boundingBox()).toMatchObject({
      width: 64,
      height: 64,
    });
    await illustration.screenshot({
      path: info.outputPath("retina-folder.png"),
    });
    for (const tool of ["Claude Code", "Codex"]) {
      // Single-tool rows leave the complete badge visible for the reference crop.
      const image = page
        .getByRole("img", { name: tool, exact: true })
        .nth(tool === "Codex" ? 2 : 1);
      await expect(image).toHaveJSProperty("naturalWidth", 28);
      expect(
        await image.evaluate((element: HTMLImageElement) => element.currentSrc),
      ).toContain("@2x.png");
      const bounds = await image.boundingBox();
      expect(bounds).toMatchObject({ width: 28, height: 28 });
      await page.screenshot({
        clip: { x: bounds!.x, y: bounds!.y, width: 28, height: 28 },
        path: info.outputPath(
          tool === "Codex" ? "retina-codex.png" : "retina-claude.png",
        ),
      });
    }
    await page.screenshot({ path: info.outputPath("retina-selection.png") });
    await page.getByRole("button", { name: "Proceed", exact: true }).click();
    await expect(illustration).toHaveJSProperty("naturalWidth", 64);
    expect(
      await illustration.evaluate(
        (image: HTMLImageElement) => image.currentSrc,
      ),
    ).toContain("@2x.png");
    expect(await illustration.boundingBox()).toMatchObject({
      width: 64,
      height: 64,
    });
    await illustration.screenshot({ path: info.outputPath("retina-sync.png") });
    const invite = await context.newPage();
    await fixture(invite, { step: "invite", projectNames: ["Orka", "Nimbus"] });
    const people = invite.locator(".onboarding-flow__illustration img");
    await expect(people).toHaveJSProperty("naturalWidth", 64);
    expect(
      await people.evaluate((image: HTMLImageElement) => image.currentSrc),
    ).toContain("@2x.png");
    expect(await people.boundingBox()).toMatchObject({ width: 64, height: 64 });
    await people.screenshot({ path: info.outputPath("retina-invite.png") });
    await invite.close();
  });
});

const photo =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=";
async function fixture(
  page: Page,
  options: {
    step?: string;
    empty?: boolean;
    pauseSync?: boolean;
    failProfile?: boolean;
    legacyProfile?: boolean;
    blocked?: boolean;
    backgroundFailure?: boolean;
    backgroundError?: string;
    background?: boolean;
    connected?: boolean;
    location?: boolean;
    sample?: boolean;
    ambiguous?: boolean;
    suggestedMatch?: boolean;
    localExclusions?: boolean;
    destinationChanged?: boolean;
    legacyMatch?: boolean;
    pauseDiscovery?: boolean;
    clipboardFailure?: boolean;
    projectNames?: string[];
    reviewPending?: boolean;
    folder?: string;
    partialSync?: boolean;
    unconnectedProject?: boolean;
    pauseCheckpoints?: boolean;
    pauseInvites?: boolean;
    emailInvites?: boolean;
    repositoryEnabled?: boolean;
  } = {},
) {
  await page.addInitScript(
    ({ options }) => {
      const checkpointControls = {
        paused: options.pauseCheckpoints ?? false,
        fail: false,
        pending: [] as (() => void)[],
        release() {
          this.paused = false;
          this.pending.splice(0).forEach((resolve) => resolve());
        },
      };
      Object.assign(window, { checkpointControls });
      const inviteControls = {
        paused: options.pauseInvites ?? false,
        pending: [] as (() => void)[],
        release() {
          this.paused = false;
          this.pending.splice(0).forEach((resolve) => resolve());
        },
      };
      Object.assign(window, { inviteControls });
      const names = options.projectNames ?? [
        "Orka",
        "Nimbus",
        "Zephyr",
        "Quasar",
        "Nebula",
        "Pulsar",
        "Aether",
      ];
      const projects = (options.sample ? names.slice(0, 3) : names).map(
        (name, index) => ({
          name,
          lastActiveAt: names.length - index,
          path: `/Users/fixture/Developer/${name.toLowerCase()}`,
          displayPath: `~/Developer/${name.toLowerCase()}`,
          sources:
            index === 1
              ? ["claude"]
              : index > 2 && index < 6
                ? ["codex"]
                : ["claude", "codex"],
          readable: !(options.blocked && index === 2),
          ...(options.step === "invite"
            ? { projectId: `p-${index}`, status: "synced" }
            : {}),
          ...(options.partialSync && index < 2
            ? {
                projectId: `p-${index}`,
                status: index === 0 ? "synced" : "syncing",
              }
            : {}),
          ...(options.localExclusions && index > 0
            ? {
                issues:
                  index === 1
                    ? [
                        {
                          error: "Package contains symlink",
                          item: "design-review",
                        },
                      ]
                    : [
                        {
                          error: "Session exceeds 128 MB; source preserved",
                          item: "session.jsonl",
                        },
                      ],
              }
            : {}),
          ...(options.step === "offline" || options.step === "sync-error"
            ? {
                projectId: options.destinationChanged
                  ? undefined
                  : `p-${index}`,
                status: options.destinationChanged
                  ? "error"
                  : options.step === "offline"
                    ? index === 0
                      ? "synced"
                      : "error"
                    : index < (options.localExclusions ? 1 : 2)
                      ? "synced"
                      : "error",
                error: options.destinationChanged
                  ? "This folder’s connection changed. Review the destination before syncing."
                  : options.localExclusions && index > 0
                    ? index === 1
                      ? "Package contains symlink"
                      : "Session exceeds 128 MB; source preserved"
                    : options.step === "sync-error" && index === 2
                      ? "Connected folder unavailable"
                      : undefined,
              }
            : {}),
        }),
      );
      let draft = JSON.parse(
        sessionStorage.getItem("onboarding-draft") ?? "null",
      ) ?? {
        step: options.step ?? "profile",
        projects: options.step ? projects : [],
        selected:
          options.step && options.step !== "discover"
            ? projects.map((p) => p.path)
            : [],
        folder: options.folder ?? "",
        sharing: {
          memory: true,
          session: true,
          plan: true,
          skill: true,
          env: false,
        },
      };
      let profile = JSON.parse(
        sessionStorage.getItem("onboarding-profile") ?? "null",
      ) ?? {
        displayName: "Alex",
        jobRole: null,
        avatarUrl: null,
        avatarData: null,
        detailsSupported: !options.legacyProfile,
        supported: !options.legacyProfile,
      };
      let active = true;
      let background = options.background ?? false;
      let catalog: any[] =
        options.step === "invite"
          ? projects.map((project, index) => ({
              id: `p-${index}`,
              name: project.name,
              role: "owner",
              sources: [
                {
                  id: `source-${index}`,
                  name: project.name,
                  path: project.path,
                },
              ],
            }))
          : [];
      let invite = 0;
      const calls: { command: string; args: any }[] = [];
      const clipboard: string[] = [];
      let clipboardFailure = options.clipboardFailure;
      const pickers: any[] = [];
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: async (value: string) => {
            if (clipboardFailure) {
              clipboardFailure = false;
              throw new Error("Couldn’t copy the invite. Try again.");
            }
            clipboard.push(value);
          },
        },
        configurable: true,
      });
      Object.assign(window, {
        onboardingCalls: calls,
        onboardingClipboard: clipboard,
        onboardingPickers: pickers,
        isTauri: true,
        __TAURI_INTERNALS__: {
          transformCallback: () => 1,
          unregisterCallback: () => {},
          invoke: async (command: string, args: any = {}) => {
            if (command === "snapshot")
              return {
                user: "user",
                profile: "default",
                config: {
                  apiUrl: "https://cloud.example.test",
                  mode: "cloud",
                  cloudUrl: "https://cloud.example.test",
                  selfHostedUrl: "",
                  syncMinutes: 15,
                },
                projects: options.unconnectedProject
                  ? [
                      {
                        id: "unconnected",
                        name: "Unconnected project",
                        role: "owner",
                        sources: [],
                      },
                      ...catalog,
                    ]
                  : catalog,
                resources: [],
                drafts: options.reviewPending
                  ? catalog.map((project) => ({
                      id: `draft-${project.id}`,
                      projectId: project.id,
                      status: "local",
                      createdAt: "2026-11-13T10:00:00Z",
                      resource: {
                        resourceId: `memory-${project.id}`,
                        projectId: project.id,
                        kind: "memory",
                        source: "shared",
                        logicalPath: "instructions/AGENTS.md",
                        title: "Project instructions",
                        files: [],
                        revision: 0,
                        owner: "user",
                        updatedBy: "user",
                        updatedAt: "2026-11-13T10:00:00Z",
                        deleted: false,
                      },
                    }))
                  : [],
                bindings: [],
                conflicts: [],
                activity: [],
                outbox: [],
                errors: [],
                sync: null,
                daemon: null,
                devices: [],
                deviceId: "device",
                background,
                onboarding: {
                  active,
                  draft,
                  setup:
                    !active && (draft.deferred || draft.step === "syncing")
                      ? draft
                      : null,
                  location: {
                    ok: options.location !== false,
                    path: "/Applications/Orka.app",
                  },
                },
                accountProfile: profile,
              };
            if (command === "plugin:dialog|open") {
              pickers.push(args.options);
              const chosen =
                args.options?.defaultPath ?? "/Users/fixture/Developer/orka";
              return args.options?.multiple ? [chosen] : chosen;
            }
            if (command.startsWith("plugin:")) return null;
            calls.push({ command, args });
            if (command === "governance_command" && args.action === "catalog")
              return {
                governed: true,
                owner: true,
                policyRevision: 1,
                policy: {},
                access: {},
                members: [],
                memberRules: [],
                resourceCount: 0,
                requests: [],
              };
            if (
              command === "repository_command" &&
              args.action === "capabilities"
            )
              return { enabled: options.repositoryEnabled ?? false };
            if (command === "auth_capabilities")
              return {
                version: 1,
                auth: { github: true, magicLink: true, password: false },
              };
            if (command === "background_agent") {
              if (options.backgroundError && args.enabled)
                throw new Error(options.backgroundError);
              if (options.backgroundFailure && args.enabled)
                throw new Error(
                  "Enable Orka in macOS Login Items to start the sync service",
                );
              background = args.enabled;
              return {};
            }
            if (
              command === "cloud_action" &&
              args.action === "invite-capabilities"
            )
              return { email: options.emailInvites ?? false };
            if (command === "cloud_action" && args.action === "invite") {
              if (inviteControls.paused)
                await new Promise<void>((resolve) =>
                  inviteControls.pending.push(resolve),
                );
              if (args.input.email)
                return { sent: true, email: args.input.email };
              return {
                token: `token-${++invite}`,
                url: `https://cloud.example.test/join/token-${invite}`,
              };
            }
            if (command === "onboarding_command") {
              const { action, input } = args;
              if (action === "profile") return profile;
              if (action === "save-profile") {
                if (options.failProfile)
                  throw new Error("Couldn’t save your profile. Try again.");
                profile = { ...profile, ...input };
                sessionStorage.setItem(
                  "onboarding-profile",
                  JSON.stringify(profile),
                );
                return profile;
              }
              if (action === "checkpoint") {
                if (checkpointControls.paused)
                  await new Promise<void>((resolve) =>
                    checkpointControls.pending.push(resolve),
                  );
                if (checkpointControls.fail)
                  throw new Error("Couldn’t save your choices. Try again.");
                draft = input;
                sessionStorage.setItem(
                  "onboarding-draft",
                  JSON.stringify(draft),
                );
                return { ok: true };
              }
              if (action === "discover")
                return options.pauseDiscovery && !input.path
                  ? new Promise((resolve) => {
                      Object.assign(window, {
                        resolveDiscovery: () => resolve({ projects }),
                      });
                    })
                  : {
                      projects: input.path
                        ? [
                            {
                              ...(projects.find((p) => p.path === input.path) ??
                                projects[0]),
                              readable: true,
                            },
                          ]
                        : options.empty
                          ? []
                          : projects,
                    };
              if (action === "review")
                return {
                  ...(options.suggestedMatch || options.destinationChanged
                    ? {
                        catalog: [
                          {
                            id: "existing-1",
                            name: options.destinationChanged
                              ? "Team Orka"
                              : "Personal Orka",
                            role: "owner",
                          },
                        ],
                      }
                    : {}),
                  matches: options.legacyMatch
                    ? {
                        [projects[0].path]: {
                          requiresChoice: true,
                          projects: [
                            {
                              id: "legacy",
                              name: "Existing Orka",
                              role: "owner",
                              sourceId: null,
                              sources: [
                                { id: "frontend", name: "Frontend" },
                                { id: "backend", name: "Backend" },
                              ],
                            },
                          ],
                        },
                      }
                    : options.destinationChanged
                      ? {
                          [projects[0].path]: {
                            connectedId: "existing-1",
                            connectedName: "Team Orka",
                          },
                        }
                      : options.suggestedMatch
                        ? {
                            [projects[0].path]: {
                              suggestedId: "existing-1",
                            },
                          }
                        : options.ambiguous
                          ? {
                              [projects[0].path]: {
                                projects: [
                                  {
                                    id: "existing-1",
                                    name: "Personal Orka",
                                    role: "owner",
                                  },
                                  {
                                    id: "existing-2",
                                    name: "Team Orka",
                                    role: "member",
                                  },
                                ],
                              },
                            }
                          : {},
                  supported: true,
                };
              if (action === "batch-sync") {
                if (options.pauseSync) return new Promise(() => {});
                draft = {
                  ...draft,
                  step: "ready",
                  projects: draft.projects.map((p: any, index: number) => ({
                    ...p,
                    projectId: `p-${index}`,
                    status: "synced",
                    reviewPending: options.reviewPending ? 1 : 0,
                  })),
                };
                catalog = draft.projects.map((p: any) => ({
                  id: p.projectId,
                  name: p.name,
                  role: "owner",
                  sources: [
                    { id: p.projectId + "-source", name: p.name, path: p.path },
                  ],
                }));
                return draft;
              }
              if (action === "progress") return draft;
              if (action === "setup-status")
                return {
                  hooks: {
                    claude: {
                      installed: true,
                      ...(options.connected
                        ? { seenAt: "2026-10-23T00:00:00Z" }
                        : {}),
                    },
                    codex: {
                      installed: true,
                      ...(options.connected
                        ? { seenAt: "2026-10-23T00:00:00Z" }
                        : {}),
                    },
                  },
                  background: { enabled: background, running: background },
                };
              if (action === "app-location") return { ok: false };
              if (action === "folder-access") return { ok: true };
              if (action === "resume-setup") {
                draft.deferred = false;
                active = true;
                return { ok: true };
              }
              if (action === "complete") {
                draft.deferred = input.defer;
                active = false;
                return { ok: true };
              }
            }
            return {};
          },
        },
      });
    },
    { options },
  );
  await page.goto("/");
}
const calls = (page: Page) =>
  page.evaluate(
    () => (window as any).onboardingCalls as { command: string; args: any }[],
  );

async function watchButtonDisabling(page: Page) {
  await page.locator("body").waitFor();
  await page.evaluate(() => {
    const disabledButtons: string[] = [];
    new MutationObserver((records) => {
      for (const record of records) {
        const button = record.target as HTMLButtonElement;
        if (button.matches("button") && button.disabled)
          disabledButtons.push(button.textContent ?? "");
      }
    }).observe(document.querySelector(".onboarding-flow")!, {
      subtree: true,
      attributes: true,
      attributeFilter: ["disabled"],
    });
    Object.assign(window, { disabledButtons });
  });
}

test("project toggles stay responsive without flashing disabled buttons while choices save", async ({
  page,
}) => {
  await fixture(page, { step: "select", pauseCheckpoints: true });
  await watchButtonDisabling(page);
  await page.getByRole("checkbox").nth(0).uncheck();
  await page.getByRole("checkbox").nth(1).uncheck();
  await expect(
    page.getByText("5 of 7 selected", { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => (window as any).disabledButtons)).toEqual(
    [],
  );
  await expect(
    page.getByRole("button", { name: "Proceed", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Proceed", exact: true }).click();
  expect(
    (await calls(page)).some((call) => call.args.action === "review"),
  ).toBe(false);
  await page.evaluate(() => (window as any).checkpointControls.release());
  await expect(
    page.getByRole("heading", { name: "Sync Project", exact: true }),
  ).toBeVisible();
  const reviewed = (await calls(page)).find(
    (call) => call.args.action === "review",
  );
  expect(reviewed?.args.input.paths).toHaveLength(5);
  expect(reviewed?.args.input.paths).not.toContain(
    "/Users/fixture/Developer/orka",
  );
  expect(reviewed?.args.input.paths).not.toContain(
    "/Users/fixture/Developer/nimbus",
  );
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.reload();
  await expect(
    page.getByText("5 of 7 selected", { exact: true }),
  ).toBeVisible();
});

test("sharing toggles do not flash buttons and unsaved choices cannot start sync", async ({
  page,
}) => {
  await fixture(page, { step: "review", pauseCheckpoints: true });
  await watchButtonDisabling(page);
  await setSharingMode(
    page.getByRole("combobox", { name: "Sessions sharing", exact: true }),
    false,
  );
  await setSharingMode(
    page.getByRole("combobox", { name: "Memories sharing", exact: true }),
    false,
  );
  await setSharingMode(
    page.getByRole("combobox", { name: "Sessions sharing", exact: true }),
    true,
  );
  await expect(
    page.getByRole("combobox", { name: "Memories sharing", exact: true }),
  ).toContainText("Only when asked");
  expect(await page.evaluate(() => (window as any).disabledButtons)).toEqual(
    [],
  );
  await page
    .getByRole("button", { name: "Start Syncing", exact: true })
    .click();
  expect(
    (await calls(page)).some((call) => call.args.action === "batch-sync"),
  ).toBe(false);
  await page.evaluate(() => {
    (window as any).checkpointControls.fail = true;
    (window as any).checkpointControls.release();
  });
  await expect(page.getByRole("alert")).toContainText(
    "Couldn’t save your choices",
  );
  await expect(
    page.getByRole("button", { name: "Start Syncing", exact: true }),
  ).toBeEnabled();
  expect(
    (await calls(page)).some((call) => call.args.action === "batch-sync"),
  ).toBe(false);
  await page.evaluate(() => {
    (window as any).checkpointControls.fail = false;
  });
  await page
    .getByRole("button", { name: "Start Syncing", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Sync Complete", exact: true }),
  ).toBeVisible();
  const saved = (await calls(page))
    .filter((call) => call.args.action === "checkpoint")
    .at(-1);
  expect(saved?.args.input.sharing).toMatchObject({
    memory: false,
    session: true,
    plan: true,
    skill: true,
    env: false,
  });
});

test("pending memories keep owner review available after setup without claiming publication", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await fixture(page, {
    step: "select",
    projectNames: ["Orka"],
    reviewPending: true,
  });
  await page.getByRole("button", { name: "Proceed", exact: true }).click();
  await page
    .getByRole("button", { name: "Start Syncing", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Projects connected", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Sync Complete", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("pending-review-completion.png"),
  });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Not now", exact: true }).click();
  await page.getByRole("button", { name: "Open Orka", exact: true }).click();
  await page.getByRole("button", { name: /1 notification/ }).click();
  await expect(
    page.getByText("Local changes are ready for review.", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Changes on this Mac", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Review changes", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("pending-review-after-setup.png"),
  });
  expect(
    (await calls(page)).some(
      (call) =>
        call.command === "governance_command" &&
        ["publish", "submit-draft"].includes(call.args.action),
    ),
  ).toBe(false);
});

test("profile matches Figma and saves a job role and a bounded uploaded photo", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await fixture(page);
  await expect(
    page.getByRole("button", { name: "Setup Profile", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("combobox", { name: "Role", exact: true }),
  ).toHaveAttribute("aria-required", "true");
  await page.getByLabel("Your Name").press("Enter");
  await page.locator("form.onboarding-profile").dispatchEvent("submit");
  expect(
    (await calls(page)).filter((c) => c.args.action === "save-profile"),
  ).toHaveLength(0);
  await expect(
    page.getByRole("heading", { name: "Set up your profile" }),
  ).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const card = await page.locator(".onboarding-entry__card").boundingBox();
  expect(card).toMatchObject({ x: 480, y: 105, width: 480 });
  expect(card?.height).toBeCloseTo(514, 1);
  const avatar = await page
    .getByRole("button", { name: "Change profile photo" })
    .boundingBox();
  expect(avatar?.width).toBe(72);
  expect(avatar?.height).toBe(72);
  expect(
    (
      await page
        .getByRole("img", { name: "Profile photo", exact: true })
        .boundingBox()
    )?.width,
  ).toBe(72);
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("profile-1440.png"),
  });
  const audit = (await new AxeBuilder({ page }).analyze()).violations;
  // Match the requested Figma palette. Track this known placeholder contrast gap
  // explicitly so unrelated accessibility regressions still fail the check.
  expect(audit.map((violation) => violation.id)).toEqual(["color-contrast"]);
  expect(audit[0].nodes).toHaveLength(1);
  expect(audit[0].nodes[0].html).toContain("Select your role");
  await page.getByRole("combobox", { name: "Role", exact: true }).click();
  await page.getByRole("option", { name: "Designer", exact: true }).click();
  await page.getByLabel("Upload profile photo").setInputFiles({
    name: "avatar.png",
    mimeType: "image/png",
    buffer: Buffer.from(photo, "base64"),
  });
  await expect(
    page.getByRole("button", { name: "Setup Profile", exact: true }),
  ).toBeEnabled();
  const submit = page.getByRole("button", {
    name: "Setup Profile",
    exact: true,
  });
  await page.getByLabel("Your Name").fill("   ");
  await expect(submit).toBeDisabled();
  await expect(submit).toHaveCSS("background-image", "none");
  await page.getByLabel("Your Name").fill("Alex");
  await expect(submit).toBeEnabled();
  await expect(submit).toHaveCSS("background-image", /email-button-texture/);
  await page.screenshot({ path: info.outputPath("profile-active.png") });
  await page.setViewportSize({ width: 900, height: 640 });
  await expect(submit).toBeInViewport();
  await page.screenshot({ path: info.outputPath("profile-active-900.png") });
  await page
    .getByRole("button", { name: "Setup Profile", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Add Project", exact: true }),
  ).toBeVisible();
  const input = (await calls(page)).find(
    (c) =>
      c.command === "onboarding_command" && c.args.action === "save-profile",
  )?.args.input;
  expect(input).toMatchObject({
    displayName: "Alex",
    jobRole: "design",
    avatarUrl: null,
  });
  expect(input.role).toBeUndefined();
  expect(input.avatarData).toMatch(/^data:image\/png;base64,/);
  expect(input.avatarData.length).toBeLessThan(700000);
});

test("sync can continue inside Orka after dismissing the progress overlay", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await fixture(page, { step: "select", pauseSync: true });
  await page.getByRole("button", { name: "Proceed", exact: true }).click();
  await page
    .getByRole("button", { name: "Start Syncing", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("Syncing your projects");
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("sync-progress.png"),
  });
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("heading", { name: "Syncing your projects", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("0 of 7 projects synced", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("continue-sync.png"),
  });
  await page
    .getByRole("button", { name: "View sync progress", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Open Orka", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Syncing your projects", exact: true }),
  ).toHaveCount(0);
  expect(
    (await calls(page)).filter((c) => c.args.action === "batch-sync"),
  ).toHaveLength(1);
  expect(
    (await calls(page)).filter((c) => c.args.action === "complete"),
  ).toHaveLength(1);
});

test("a failed profile save preserves edits and does not advance", async ({
  page,
}) => {
  await fixture(page, { failProfile: true });
  await page.getByLabel("Your Name").fill("Pratham");
  await page.getByRole("combobox", { name: "Role", exact: true }).click();
  await page.getByRole("option", { name: "Designer", exact: true }).click();
  await page
    .getByRole("button", { name: "Setup Profile", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("Couldn’t save");
  await expect(page.getByLabel("Your Name")).toHaveValue("Pratham");
  await expect(
    page.getByRole("heading", { name: "Set up your profile" }),
  ).toBeVisible();
});

for (const size of [
  { width: 1160, height: 800 },
  { width: 900, height: 640 },
]) {
  test(`discovery groups source methods before the quiet exit at ${size.width}`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await fixture(page, { step: "discover", repositoryEnabled: true });
    const choices = page.locator(".onboarding-flow__discovery-actions");
    await expect(choices.getByRole("button")).toHaveText([
      "Find my projects",
      "Choose a folder instead",
      "Connect a GitHub repository",
      "Set up later",
    ]);
    const sources = choices.getByRole("group", {
      name: "Choose a project source",
    });
    await expect(sources.getByRole("button")).toHaveCount(2);
    await expect(choices.locator(".ui-button--primary")).toHaveText(
      "Find my projects",
    );
    const defer = choices.getByRole("button", {
      name: "Set up later",
      exact: true,
    });
    await expect(defer).toHaveClass(/ui-button--tertiary/);
    await expect(defer).toBeInViewport();
    await choices
      .getByRole("button", { name: "Find my projects", exact: true })
      .focus();
    await page.keyboard.press("Tab");
    await expect(
      sources.getByRole("button", { name: "Choose a folder instead" }),
    ).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(
      sources.getByRole("button", { name: "Connect a GitHub repository" }),
    ).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(defer).toBeFocused();
  });
}

for (const width of [1440, 900])
  test(`discovery selection stays accurate and uses native commands at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 900 ? 640 : 900 });
    await fixture(page, { step: "discover" });
    await page.evaluate(() => document.fonts.ready);
    await expect(
      page.getByRole("heading", { name: "Add Project" }),
    ).toBeVisible();
    if (width === 1440) {
      expect(
        await page.locator(".onboarding-flow__canvas").boundingBox(),
      ).toMatchObject({ x: 297, y: 0, width: 1143, height: 900 });
    }
    await page.screenshot({
      animations: "disabled",
      path: info.outputPath("discovery.png"),
    });
    await page
      .getByRole("button", { name: "Find my projects", exact: true })
      .click();
    await expect(
      page.getByText("0 of 7 selected", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Proceed", exact: true }),
    ).toBeDisabled();
    await page.getByRole("button", { name: "Select all", exact: true }).click();
    await expect(
      page.getByText("7 of 7 selected", { exact: true }),
    ).toBeVisible();
    const firstRow = await page
      .locator(".onboarding-flow__project")
      .first()
      .boundingBox();
    expect(firstRow?.height).toBe(65);
    const list = page.locator(".onboarding-flow__project-list");
    expect((await list.boundingBox())?.height).toBe(width === 900 ? 260 : 351);
    expect(
      await list.evaluate((element) => element.scrollHeight),
    ).toBeGreaterThan(await list.evaluate((element) => element.clientHeight));
    await page.getByRole("checkbox").last().scrollIntoViewIfNeeded();
    await expect(page.getByRole("checkbox").last()).toBeInViewport();
    await list.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect(
      page.locator(".onboarding-flow__tools img").first(),
    ).toHaveJSProperty("naturalWidth", 28);
    expect(
      (await page.locator(".onboarding-flow__tool").first().boundingBox())
        ?.width,
    ).toBe(24);
    expect(
      (await page.locator(".onboarding-flow__tools img").first().boundingBox())
        ?.width,
    ).toBe(28);
    await page.screenshot({
      animations: "disabled",
      path: info.outputPath("selection.png"),
    });
    await page
      .getByRole("button", { name: "Unselect all", exact: true })
      .click();
    await expect(
      page.getByText("0 of 7 selected", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Proceed", exact: true }),
    ).toBeDisabled();
    await expect(page.locator(".onboarding-flow__project").first()).toHaveCSS(
      "background-color",
      "rgb(18, 18, 18)",
    );
    await page.getByRole("checkbox").first().check();
    await expect(page.locator(".onboarding-flow__project").first()).toHaveCSS(
      "background-color",
      "rgb(24, 24, 24)",
    );
    await expect(
      page.getByText("1 of 7 selected", { exact: true }),
    ).toBeVisible();
    expect(
      (await calls(page)).some(
        (c) => c.command === "cloud_action" || c.args.action === "batch-sync",
      ),
    ).toBe(false);
    await page.getByRole("button", { name: "Proceed", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Sync Project", exact: true }),
    ).toBeVisible();
    expect(await page.getByRole("combobox", { name: /sharing$/ }).count()).toBe(
      4,
    );
    await expect(
      page.getByRole("button", { name: "Start Syncing", exact: true }),
    ).toBeEnabled();
    expect(
      (
        await page
          .locator(".onboarding-flow__sharing-row")
          .first()
          .boundingBox()
      )?.height,
    ).toBe(65);
    await expect(page.getByRole("switch", { name: "ENVs" })).toHaveCount(0);
    await page.screenshot({
      animations: "disabled",
      path: info.outputPath("sharing.png"),
    });
    await setSharingMode(
      page.getByRole("combobox", { name: "Sessions sharing", exact: true }),
      false,
    );
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(
      page.getByText("1 of 7 selected", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByText("1 of 7 selected", { exact: true }),
    ).toBeVisible();
    for (const projectNames of [["Orka"], ["Orka", "Nimbus"]]) {
      const shortList = await page.context().newPage();
      await shortList.setViewportSize({
        width,
        height: width === 900 ? 640 : 900,
      });
      await fixture(shortList, { step: "select", projectNames });
      await shortList
        .getByRole("button", { name: "Unselect all", exact: true })
        .click();
      const shortListContainer = shortList.locator(
        ".onboarding-flow__project-list",
      );
      // Rows retain their natural height, with just the container's two borders.
      expect((await shortListContainer.boundingBox())?.height).toBe(
        66 * projectNames.length + 1,
      );
      expect(
        await shortListContainer.evaluate((element) => element.scrollHeight),
      ).toBe(
        await shortListContainer.evaluate((element) => element.clientHeight),
      );
      await expect(
        shortList.getByRole("button", { name: "Proceed", exact: true }),
      ).toBeDisabled();
      await shortList.screenshot({
        path: info.outputPath(
          `selection-${projectNames.length}-unselected.png`,
        ),
        animations: "disabled",
      });
      await shortList.getByRole("checkbox").first().check();
      await expect(
        shortList.getByRole("button", { name: "Proceed", exact: true }),
      ).toBeEnabled();
      await shortList.screenshot({
        path: info.outputPath(`selection-${projectNames.length}-mixed.png`),
        animations: "disabled",
      });
      await shortList.close();
    }
  });

test("profile, projects, sync, background choice, and fresh one-use invites reach the workspace", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await fixture(page, { step: "select", unconnectedProject: true });
  await page.getByRole("button", { name: "Proceed", exact: true }).click();
  await setSharingMode(
    page.getByRole("combobox", { name: "Sessions sharing", exact: true }),
    false,
  );
  await page
    .getByRole("button", { name: "Start Syncing", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Sync Complete", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("sync-complete.png"),
  });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Keep projects synced");
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("background.png"),
  });
  await page.getByRole("button", { name: "Not now", exact: true }).click();
  expect(
    (await calls(page)).find((c) => c.command === "background_agent")?.args,
  ).toEqual({ enabled: false });
  const consent = (await calls(page))
    .filter((c) => c.args.action === "checkpoint")
    .find((c) => c.args.input.step === "syncing")?.args.input;
  expect(consent.reviewed).toBe(true);
  expect(consent.sharing).toMatchObject({ session: false, env: false });
  await expect(
    page.getByRole("heading", { name: "Invite teammates", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("invites.png"),
  });
  await page
    .getByRole("button", { name: "Invite teammate", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Copy joining link", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Link copied.");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).onboardingClipboard.length))
    .toBe(1);
  await page.getByRole("button", { name: "Open Orka", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Settings", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Select project", exact: true }),
  ).toContainText("Orka");
  await expect(
    page.getByRole("heading", { name: "Connect this Mac", exact: true }),
  ).toHaveCount(0);
  expect(
    (await calls(page)).filter((c) => c.args.action === "complete"),
  ).toHaveLength(1);
});

test("no detected projects can recover through the native folder picker", async ({
  page,
}) => {
  await fixture(page, { step: "discover", empty: true });
  await page
    .getByRole("button", { name: "Find my projects", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "No projects found", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Choose a folder", exact: true })
    .click();
  await expect(
    page.getByText("1 of 1 selected", { exact: true }),
  ).toBeVisible();
  expect(
    (await calls(page)).find(
      (c) => c.args.action === "discover" && c.args.input.path,
    )?.args.input.path,
  ).toBe("/Users/fixture/Developer/orka");
});

for (const width of [1440, 900]) {
  for (const [step, title] of [
    ["folder", "Connect a folder"],
    ["empty", "No projects found"],
    ["access-error", "Folder access needed"],
    ["partial-access", "Some folders need access"],
    ["background-off", "Background sync is off"],
    ["offline", "You’re offline"],
    ["sync-error", "One project needs access"],
  ]) {
    test(`${step} recovery fits ${width}px and retains its Figma layout`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: width === 900 ? 640 : 900 });
      await fixture(page, {
        step,
        sample: true,
        blocked: step === "partial-access",
        folder:
          step === "folder" || step === "access-error"
            ? "~/Documents/zephyr"
            : undefined,
      });
      await expect(
        page.getByRole("heading", { name: title, exact: true }),
      ).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      const bounds = await page
        .locator(".onboarding-flow__recovery")
        .boundingBox();
      expect(bounds?.width).toBeLessThanOrEqual(520);
      if (width === 1440)
        expect(bounds).toMatchObject({ x: 608.5, y: 100, width: 520 });
      const buttons = page.locator(".onboarding-flow__recovery button");
      for (const button of await buttons.all()) {
        const box = await button.boundingBox();
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        expect(box!.y + box!.height).toBeLessThanOrEqual(
          width === 900 ? 640 : 900,
        );
      }
      await page.screenshot({
        animations: "disabled",
        path: info.outputPath(`${step}-${width}.png`),
      });
      const audit = await new AxeBuilder({ page })
        .include(".onboarding-flow__canvas")
        .analyze();
      expect(audit.violations).toEqual([]);
    });
  }
}

test("live sync shows completed, active, and queued projects without claiming all are synced", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await fixture(page, { step: "syncing", sample: true, partialSync: true });
  await expect(
    page.getByRole("dialog", { name: "Syncing your projects", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByText("1 of 3 projects synced", { exact: true }),
  ).toBeVisible();
  const rows = page.locator(
    ".onboarding-flow__live-sync .onboarding-flow__sync-status > div",
  );
  await expect(rows).toHaveText([
    "OrkaSynced",
    "NimbusSyncing",
    "ZephyrQueued",
  ]);
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("partial-sync-reference.png"),
  });
  await page.getByRole("button", { name: "Open Orka", exact: true }).click();
  expect(
    (await calls(page)).some((call) => call.args.action === "batch-sync"),
  ).toBe(false);
});

test("folder access uses the native picker and leaves the readable selections intact", async ({
  page,
}) => {
  await fixture(page, { step: "discover", sample: true, blocked: true });
  await page
    .getByRole("button", { name: "Find my projects", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Some folders need access" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Give access", exact: true }).click();
  await expect(
    page.getByText("1 of 3 selected", { exact: true }),
  ).toBeVisible();
  const pickers = await page.evaluate(() => (window as any).onboardingPickers);
  expect(pickers[0]).toMatchObject({
    directory: true,
    defaultPath: "/Users/fixture/Developer/zephyr",
  });
  expect((await calls(page)).some((c) => c.args.action === "batch-sync")).toBe(
    false,
  );
});

test("a denied background service returns to the confirmation and skips directly to invites", async ({
  page,
}, info) => {
  await fixture(page, { step: "background", backgroundFailure: true });
  await page
    .getByRole("button", { name: "Enable background sync", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Background sync is off" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Open System Settings", exact: true })
    .click();
  expect(
    (await calls(page)).some(
      (c) => c.args.action === "open-settings" && c.args.input.kind === "login",
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: "Back to setup", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("Keep projects synced");
  await page.getByRole("button", { name: "Not now", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Invite teammates", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^Set up (Claude Code|Codex)$/ }),
  ).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("background-recovery-invites.png"),
  });
});

for (const step of ["finish-setup", "claude", "codex"])
  test(`saved ${step} continues to invites without tool setup`, async ({
    page,
  }) => {
    await fixture(page, { step });
    await expect(
      page.getByRole("heading", { name: "Invite teammates", exact: true }),
    ).toBeVisible();
    expect(
      (await calls(page)).some((c) => c.args.action === "setup-status"),
    ).toBe(false);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Invite teammates", exact: true }),
    ).toBeVisible();
  });

test("an uninstalled app explains the manual move and checks again without copying or relaunching", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await fixture(page, { location: false });
  await expect(
    page.getByRole("heading", { name: "Move Orka to Applications" }),
  ).toBeVisible();
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("location.png"),
  });
  await page
    .getByRole("button", { name: "Check location", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("Open the copy of Orka");
  expect(
    (await calls(page)).some((c) =>
      /move|relaunch|open-installed/.test(c.args.action ?? ""),
    ),
  ).toBe(false);
});

test("fetching uses the Figma progress overlay and can finish without a fake percentage", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await fixture(page, { step: "discover", pauseDiscovery: true });
  await page
    .getByRole("button", { name: "Find my projects", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "Fetching your projects",
  );
  const modal = await page.getByRole("dialog").boundingBox();
  expect(modal).toMatchObject({ x: 535, y: 133 });
  expect(modal?.width).toBe(370);
  expect(modal?.height).toBe(206);
  await expect(page.getByRole("progressbar")).not.toHaveAttribute(
    "aria-valuenow",
  );
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("fetching.png"),
  });
  await page.evaluate(() => (window as any).resolveDiscovery());
  await expect(
    page.getByText("0 of 7 selected", { exact: true }),
  ).toBeVisible();
});

test("ambiguous cloud matches require a project choice before sync", async ({
  page,
}, info) => {
  await fixture(page, { step: "select", ambiguous: true });
  await page.getByRole("button", { name: "Proceed", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Start Syncing", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("combobox", { name: "Connect Orka to project", exact: true })
    .click();
  await page
    .getByRole("option", { name: "Team Orka · Member", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Start Syncing", exact: true }),
  ).toBeEnabled();
  await setSharingMode(
    page.getByRole("combobox", { name: "Sessions sharing", exact: true }),
    false,
  );
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("button", { name: "Proceed", exact: true }).click();
  await expect(
    page.getByRole("combobox", {
      name: "Connect Orka to project",
      exact: true,
    }),
  ).toContainText("Team Orka · Member");
  await expect(
    page.getByRole("combobox", { name: "Sessions sharing", exact: true }),
  ).toContainText("Only when asked");
  await expect(
    page.getByRole("button", { name: "Start Syncing", exact: true }),
  ).toBeEnabled();
  const lastCheckpoint = (await calls(page))
    .filter((call) => call.args.action === "checkpoint")
    .at(-1);
  expect(
    lastCheckpoint?.args.input.choices["/Users/fixture/Developer/orka"],
  ).toBe("existing-2");
  expect(
    (await calls(page)).some((call) => call.args.action === "batch-sync"),
  ).toBe(false);
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("ambiguous-match.png"),
  });
});

for (const width of [1440, 900]) {
  test(`legacy projects require explicit project and repository choices at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 900 ? 640 : 900 });
    await fixture(page, {
      step: "select",
      legacyMatch: true,
      projectNames: ["Orka"],
    });
    await page.getByRole("button", { name: "Proceed", exact: true }).click();
    const start = page.getByRole("button", {
      name: "Start Syncing",
      exact: true,
    });
    const project = page.getByRole("combobox", {
      name: "Connect Orka to project",
      exact: true,
    });
    await expect(project).toContainText("Choose an Orka project");
    await expect(start).toBeDisabled();
    await project.click();
    await page
      .getByRole("option", { name: "Existing Orka · Owner", exact: true })
      .click();
    const source = page.getByRole("combobox", {
      name: "Repository for Orka",
      exact: true,
    });
    await expect(source).toContainText("Choose a repository");
    await expect(start).toBeDisabled();
    await source.click();
    await page.getByRole("option", { name: "Backend", exact: true }).click();
    await expect(start).toBeEnabled();
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await page.getByRole("button", { name: "Proceed", exact: true }).click();
    await expect(project).toContainText("Existing Orka · Owner");
    await expect(source).toContainText("Backend");
    await expect(start).toBeEnabled();
    const saved = (await calls(page))
      .filter((call) => call.args.action === "checkpoint")
      .at(-1)?.args.input;
    expect(saved.sourceChoices["/Users/fixture/Developer/orka"]).toBe(
      "backend",
    );
    await start.scrollIntoViewIfNeeded();
    const bounds = await start.boundingBox();
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(
      width === 900 ? 640 : 900,
    );
    await page.screenshot({
      path: info.outputPath("legacy-source-choice.png"),
    });
    await project.click();
    await page
      .getByRole("option", { name: "Create a separate project", exact: true })
      .click();
    await expect(source).toHaveCount(0);
    await expect(start).toBeEnabled();
    await project.click();
    await page
      .getByRole("option", { name: "Existing Orka · Owner", exact: true })
      .click();
    await expect(source).toContainText("Choose a repository");
    await expect(start).toBeDisabled();
    expect(
      (await calls(page)).some((call) => call.args.action === "batch-sync"),
    ).toBe(false);
  });
}

test("email invites are primary during onboarding", async ({ page }) => {
  await fixture(page, {
    step: "invite",
    emailInvites: true,
    projectNames: ["Orka"],
  });
  await page
    .getByRole("button", { name: "Invite teammate", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Invite member" });
  await expect(dialog.getByLabel("Email address")).toBeVisible();
  await dialog.getByLabel("Email address").fill("teammate@example.com");
  await dialog
    .getByRole("button", { name: "Send invitation", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText(
    "Invitation sent to teammate@example.com",
  );
  expect(
    (await calls(page)).filter((call) => call.args.action === "invite"),
  ).toHaveLength(1);
  expect(
    await page.evaluate(() => (window as any).onboardingClipboard),
  ).toEqual([]);
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Open Orka", exact: true }),
  ).toBeEnabled();
});

test("pending invitation blocks closing and duplicate submissions", async ({
  page,
}) => {
  await fixture(page, {
    step: "invite",
    pauseInvites: true,
    projectNames: ["Orka"],
  });
  await page
    .getByRole("button", { name: "Invite teammate", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Invite member" });
  const copy = dialog.getByRole("button", {
    name: "Copy joining link",
    exact: true,
  });
  await copy.click();
  await expect(dialog.locator("form")).toHaveAttribute("aria-busy", "true");
  await expect(
    dialog.getByRole("button", { name: "Done", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await dialog.locator('button[type="submit"]').dispatchEvent("click");
  expect(
    (await calls(page)).filter((call) => call.args.action === "invite"),
  ).toHaveLength(1);
  await page.evaluate(() => (window as any).inviteControls.release());
  await expect(dialog.getByRole("status")).toContainText("Link copied.");
});

test("clipboard failure retries the same invite instead of creating another", async ({
  page,
}) => {
  await fixture(page, {
    step: "invite",
    clipboardFailure: true,
    projectNames: ["Orka"],
  });
  await page
    .getByRole("button", { name: "Invite teammate", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Invite member" });
  await dialog
    .getByRole("button", { name: "Copy joining link", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("Couldn’t copy");
  await expect(dialog.getByLabel("Joining link")).toHaveValue(
    "https://cloud.example.test/join/token-1",
  );
  await dialog
    .getByRole("button", { name: "Copy joining link", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText("Link copied.");
  expect(
    (await calls(page)).filter((call) => call.args.action === "invite"),
  ).toHaveLength(1);
});

test("background registration succeeds directly into invites without tool setup", async ({
  page,
}) => {
  await fixture(page, { step: "background" });
  await page
    .getByRole("button", { name: "Enable background sync", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Invite teammates", exact: true }),
  ).toBeVisible();
  expect(
    (await calls(page)).find((c) => c.command === "background_agent")?.args,
  ).toEqual({ enabled: true });
});

test("a test-build restriction stays in the modal without blaming System Settings", async ({
  page,
}) => {
  await fixture(page, {
    step: "background",
    backgroundError:
      "Background sync can’t be enabled in this test build. Choose Not now to continue.",
  });
  await page
    .getByRole("button", { name: "Enable background sync", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "can’t be enabled in this test build",
  );
  await expect(
    page.getByRole("heading", { name: "Background sync is off" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Not now", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Invite teammates", exact: true }),
  ).toBeVisible();
});

test("first sync automatically offers background sync and skips it when already enabled", async ({
  page,
  context,
}) => {
  await fixture(page, { step: "ready" });
  await expect(
    page.getByRole("dialog", { name: "Keep projects synced" }),
  ).toBeVisible();
  const enabled = await context.newPage();
  await fixture(enabled, { step: "ready", background: true });
  await expect(
    enabled.getByRole("heading", { name: "Invite teammates", exact: true }),
  ).toBeVisible();
  await expect(enabled.getByRole("dialog")).toHaveCount(0);
  await enabled.close();
});

for (const width of [1440, 900])
  test(`background confirmation matches Figma at ${width}px`, async ({
    page,
  }, info) => {
    const height = width === 900 ? 640 : 900;
    await page.setViewportSize({ width, height });
    await fixture(page, { step: "background" });
    await page.evaluate(() => document.fonts.ready);
    const minTop = Math.min(102, Math.max(24, (height - 442) / 2));
    const modal = page.getByRole("dialog");
    await expect(modal).toBeVisible();
    expect(await modal.boundingBox()).toMatchObject({
      x: (width - 420) / 2,
      y: minTop,
      width: 420,
      height: 442,
    });
    await expect(modal).toHaveCSS("border-radius", "20px");
    await expect(modal).toHaveCSS(
      "border-top-color",
      "rgba(255, 255, 255, 0.08)",
    );
    await expect(modal.getByRole("heading")).toHaveCSS("font-size", "20px");
    await expect(
      modal.getByRole("button", {
        name: "Enable background sync",
        exact: true,
      }),
    ).toHaveCSS("background-color", "rgb(242, 238, 235)");
    const illustration = modal.locator(
      ".onboarding-flow__background-illustration",
    );
    await expect(illustration).toHaveJSProperty("naturalWidth", 836);
    await expect(illustration).toHaveJSProperty("naturalHeight", 464);
    expect(await illustration.boundingBox()).toMatchObject({
      width: 418,
      height: 232,
    });
    const buttons = await modal.getByRole("button").all();
    await expect(buttons[0]).toHaveText("Enable background sync");
    await expect(buttons[1]).toHaveText("Not now");
    for (const button of buttons)
      expect(await button.boundingBox()).toMatchObject({
        width: 372,
        height: 40,
      });
    await page.screenshot({ path: info.outputPath(`background-${width}.png`) });
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("heading", { name: "Invite teammates", exact: true }),
    ).toBeVisible();
  });

for (const width of [1440, 900])
  test(`the two-project invite layout matches Figma at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 640 });
    await fixture(page, { step: "invite", projectNames: ["Zephyr", "Quasar"] });
    await expect(
      page.getByRole("button", { name: "Invite teammate", exact: true }),
    ).toHaveCount(2);
    await expect(
      page.getByRole("button", { name: "Open Orka", exact: true }),
    ).toBeInViewport();
    await page.screenshot({
      animations: "disabled",
      path: info.outputPath(`invite-${width}.png`),
    });
  });

test("search keeps offscreen selections and a suggested destination requires confirmation", async ({
  page,
}) => {
  await fixture(page, { step: "discover", sample: true, suggestedMatch: true });
  await page.getByRole("button", { name: "Find my projects" }).click();
  await expect(page.getByText("0 of 3 selected")).toBeVisible();
  await page.getByRole("checkbox", { name: /Orka/ }).check();
  const search = page.getByRole("searchbox", { name: "Search projects" });
  await search.fill("~/Developer/nimbus");
  await expect(page.getByRole("checkbox")).toHaveCount(1);
  await page.getByRole("button", { name: "Select visible" }).click();
  await expect(page.getByText("2 of 3 selected")).toBeVisible();
  await page.getByRole("button", { name: "Unselect visible" }).click();
  await search.clear();
  await expect(page.getByRole("checkbox", { name: /Orka/ })).toBeChecked();
  await page.getByRole("button", { name: "Proceed", exact: true }).click();
  const start = page.getByRole("button", {
    name: "Start Syncing",
    exact: true,
  });
  await expect(start).toBeDisabled();
  await expect(page.getByText("~/Developer/orka")).toBeVisible();
  await page.getByRole("combobox", { name: "Connect Orka to project" }).click();
  await page
    .getByRole("option", { name: "Personal Orka · Suggested match" })
    .click();
  await expect(start).toBeEnabled();
  await page.getByRole("button", { name: "Set up later" }).click();
  await page.getByRole("button", { name: /Sync stopped/ }).click();
  await expect(page.getByText("Project setup saved")).toBeVisible();
  await page.getByRole("button", { name: "Resume setup" }).click();
  await expect(
    page.getByRole("combobox", { name: "Connect Orka to project" }),
  ).toContainText("Personal Orka");
  expect((await calls(page)).some((c) => c.args.action === "batch-sync")).toBe(
    false,
  );
});

test("the sync overlay exposes completion count and continues into the workspace", async ({
  page,
}) => {
  await fixture(page, { step: "syncing", sample: true, partialSync: true });
  const dialog = page.getByRole("dialog", { name: "Syncing your projects" });
  await expect(dialog.getByRole("status")).toContainText(
    "1 of 3 projects synced",
  );
  await dialog.getByRole("button", { name: "Open Orka" }).click();
  await page.getByRole("button", { name: /Sync stopped/ }).click();
  await expect(page.getByText("Initial project sync")).toBeVisible();
  await expect(page.getByText("1 of 3 projects synced")).toBeVisible();
});

test("local sync exclusions identify the resource and explain recovery", async ({
  page,
}) => {
  await fixture(page, {
    step: "sync-error",
    sample: true,
    localExclusions: true,
  });
  await expect(
    page.getByRole("heading", { name: "Some resources were kept local" }),
  ).toBeVisible();
  await expect(
    page.getByText("design-review ·", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("session.jsonl ·", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/replace the link with a regular file/i),
  ).toBeVisible();
  await expect(
    page.getByText(/start a new session for future work/i),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Scan again" })).toBeEnabled();
});

test("a changed connection prompts review before sync can resume", async ({
  page,
}, info) => {
  await fixture(page, {
    step: "sync-error",
    projectNames: ["Orka"],
    destinationChanged: true,
  });
  await expect(
    page.getByText("This folder’s connection changed", {
      exact: false,
    }),
  ).toBeVisible();
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("destination-review.png"),
  });
  await page.getByRole("button", { name: "Review destinations" }).click();
  await expect(page.getByText("Connected to Team Orka")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start Syncing" }),
  ).toBeEnabled();
});
