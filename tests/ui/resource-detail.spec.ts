import { test, expect, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

type Options = {
  forks?: number;
  appIcons?: Record<string, string | null>;
  launchOptions?: "missing-default" | "slow" | "error";
  disconnected?: boolean;
  cliOrigin?: boolean;
  noApps?: boolean;
  promptError?: boolean;
  savePath?: string | null;
  resumeError?: boolean;
  offline?: boolean;
  exportError?: boolean;
  manualResume?: boolean;
  sessionTitle?: string;
  deepLink?: string;
  slowSnapshot?: boolean;
  skillContent?: string;
  skillFailure?: "error" | "null content";
  memberCatalog?: "cached" | "fetch" | "unavailable";
  slowMemberCatalog?: boolean;
};

/** Two projects, a conflicted session, another owner's session, and recorded invokes. */
async function detailFixture(page: Page, options: Options = {}) {
  await page.addInitScript((options: Options) => {
    const user = options.memberCatalog
      ? "11111111-1111-4111-8111-111111111111"
      : "user";
    const teammate = options.memberCatalog
      ? "22222222-2222-4222-8222-222222222222"
      : "mira";
    const members = [
      { id: user, role: "owner", name: "Saket Rao" },
      { id: teammate, role: "member", name: "Mira Shah" },
    ];
    const resources = [
      {
        resourceId: "memory-a",
        projectId: "one",
        kind: "memory",
        title: "Design decisions",
      },
      {
        resourceId: "plan-codex",
        projectId: "one",
        kind: "plan",
        title: "Codex implementation plan",
        source: "codex",
      },
      {
        resourceId: "plan-claude",
        projectId: "one",
        kind: "plan",
        title: "Claude release plan",
        source: "claude",
      },
      {
        resourceId: "memory-b",
        projectId: "one",
        kind: "memory",
        title: "Architecture notes",
        source: "claude",
        owner: "mira",
        updatedBy: "mira",
        updatedAt: "2026-10-01T09:00:00Z",
      },
      {
        resourceId: "skill-e",
        projectId: "one",
        kind: "skill",
        title: "Review checklist",
        files: ["SKILL.md", "references/tokens.md"],
      },
      {
        resourceId: "session-c",
        projectId: "one",
        kind: "session",
        title: "Imported session",
      },
      {
        resourceId: "session-m",
        projectId: "one",
        kind: "session",
        title: "Imported session",
        source: "claude",
        owner: "mira",
        updatedBy: "mira",
        updatedAt: "2026-10-02T09:00:00Z",
      },
      {
        resourceId: "skill-b",
        projectId: "two",
        kind: "skill",
        title: "Writing guide",
      },
    ].map((r) => ({
      fork: undefined as
        | {
            parentId: string;
            nativeId: string;
            destination: string;
            createdAt: string;
          }
        | undefined,
      localForkId: undefined as string | undefined,
      source: "codex",
      updatedAt: "2026-10-04T10:00:00Z",
      deleted: false,
      revision: 1,
      ...r,
      owner: r.owner === "mira" ? teammate : user,
      updatedBy: r.updatedBy === "mira" ? teammate : user,
      logicalPath: `codex/${r.resourceId}`,
      files: (
        (r as { files?: string[] }).files ?? [
          r.kind === "skill"
            ? "SKILL.md"
            : r.kind === "session"
              ? "session.jsonl"
              : "content.md",
        ]
      ).map((path) => ({ path, hash: "hash", size: 10 })),
    }));
    const titles: Record<string, string> = {
      "session-c": options.sessionTitle ?? "Polish navigation",
      "session-m": "Shared planning",
    };
    const addFork = (parentId: string) => {
      const parent = resources.find((r) => r.resourceId === parentId)!;
      const id = `fork-${resources.filter((r) => r.fork).length + 1}`;
      const child = {
        ...parent,
        resourceId: id,
        revision: 0,
        localForkId: undefined,
        fork: {
          parentId,
          nativeId: `native-${id}`,
          destination: "desktop",
          createdAt: "2026-11-02T00:00:00Z",
        },
      };
      titles[id] = `Fork ${resources.filter((r) => r.fork).length + 1}`;
      resources.push(child);
      parent.localForkId = id;
      return child;
    };
    for (let n = 0; n < (options.forks ?? 0); n++) addFork("session-c");
    if ((options.forks ?? 0) > 1) addFork("fork-1");
    const calls: { name: string; args?: Record<string, unknown> }[] = [];
    let snapshots = 0;
    // Deterministic clipboard: record the text instead of relying on permissions.
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as any).copiedText = text;
        },
      },
    });
    Object.assign(window, {
      invokeCalls: calls,
      failedSkillReads: 0,
      isTauri: true,
      __TAURI_INTERNALS__: {
        transformCallback: (callback: unknown) => {
          (window as any).reviewDeepLink = callback;
          return 1;
        },
        unregisterCallback: () => {},
        invoke: async (name: string, args?: Record<string, unknown>) => {
          calls.push({ name, args });
          if (name === "snapshot") {
            if (options.slowSnapshot && snapshots++ === 0)
              await new Promise((resolve) => setTimeout(resolve, 300));
            return {
              user,
              governance:
                options.memberCatalog === "cached"
                  ? [{ projectId: "one", catalog: { access: {}, members } }]
                  : [],
              config: { apiUrl: "https://test.local", syncMinutes: 15 },
              projects: [
                {
                  id: "one",
                  name: "Orka",
                  path: options.disconnected ? null : "/test/orka",
                  role: "owner",
                },
                {
                  id: "two",
                  name: "Studio",
                  path: "/test/studio",
                  role: "owner",
                },
              ],
              resources: resources.map((resource) => ({ ...resource })),
              bindings: [],
              conflicts: [
                {
                  id: "conflict-1",
                  resourceId: "session-c",
                  author: teammate,
                  deviceId: "other-device",
                  candidate: resources.find(
                    (r) => r.resourceId === "session-c",
                  ),
                  revision: 1,
                },
              ],
              activity: options.memberCatalog
                ? [
                    {
                      id: "copy-notice",
                      resourceId: "session-c",
                      copyId: "session-m",
                      author: teammate,
                      notifyOwner: user,
                    },
                  ]
                : [],
              outbox: [],
              errors: [],
              sync: options.offline
                ? { online: false, error: "Service unavailable" }
                : { online: true },
              daemon: { running: true },
              devices: [],
              deviceId: "device",
              background: true,
            };
          }
          if (name === "governance_command" && args?.action === "catalog") {
            if (!options.memberCatalog) return {};
            if (options.memberCatalog === "unavailable")
              throw new Error("Offline");
            const projectId = (args.input as { projectId: string }).projectId;
            if (options.slowMemberCatalog && projectId === "one")
              await new Promise<void>((resolve) => {
                (window as any).finishMemberCatalog = resolve;
              });
            return {
              requests: [],
              members:
                projectId === "one"
                  ? members
                  : [{ id: user, role: "owner", name: "Studio account" }],
            };
          }
          if (name === "plugin:deep-link|get_current")
            return options.deepLink ? [options.deepLink] : null;
          if (name === "session_launch_options") {
            if (options.launchOptions === "error")
              throw new Error("App discovery unavailable");
            if (options.launchOptions === "slow")
              await new Promise<void>((resolve) => {
                (window as any).finishLaunchOptions = resolve;
              });
            const source =
              resources.find((r) => r.resourceId === args?.id)?.source ??
              "codex";
            const selected = resources.find((r) => r.resourceId === args?.id);
            if (options.noApps) return [];
            const tools = [source, source === "codex" ? "claude" : "codex"];
            const destinations = options.cliOrigin
              ? ["terminal", "warp", "iterm2", "desktop"]
              : ["desktop", "terminal", "warp", "iterm2"];
            const result = tools.flatMap((tool) =>
              destinations.map((destination) => ({
                tool,
                destination,
                label:
                  destination === "desktop"
                    ? tool === "claude"
                      ? "Claude Desktop"
                      : "Codex"
                    : destination === "terminal"
                      ? "Terminal"
                      : destination === "warp"
                        ? "Warp"
                        : "iTerm2",
                icon:
                  options.appIcons?.[
                    destination === "desktop" ? tool : destination
                  ] ?? null,
                available:
                  !options.disconnected &&
                  !(
                    options.launchOptions === "missing-default" &&
                    tool === source &&
                    destination === "desktop"
                  ),
                reason: options.disconnected
                  ? "Connect this session's repository on this Mac"
                  : options.launchOptions === "missing-default" &&
                      tool === source &&
                      destination === "desktop"
                    ? "Update the desktop resume integration"
                    : null,
                isDefault: false,
                mode:
                  tool === source
                    ? selected?.fork || selected?.localForkId
                      ? "resume"
                      : "fork"
                    : "handoff",
                forkAvailable: !options.disconnected,
              })),
            );
            const primary = result.find((option) => option.available);
            if (primary) primary.isDefault = true;
            return result;
          }
          if (name === "session_handoff_prompt") {
            if (options.promptError) throw new Error("Missing session history");
            return {
              text: "Continue the task from this conversation.\n\n## You\n\nOriginal request\n\n## Assistant\n\nComplete answer",
              revision: 1,
            };
          }
          if (name === "resume_session") {
            if (options.manualResume && args?.destination === "warp")
              return {
                opened: false,
                manualCommand:
                  "cd -- '/test/orka' && /usr/bin/env CODEX_HOME='/test/codex' '/test/bin/codex' resume 'exact-native-id'",
              };
            if (options.resumeError)
              throw new Error("Could not launch destination");
            const resource = resources.find((r) => r.resourceId === args?.id);
            if (
              options.forks !== undefined &&
              resource &&
              args?.tool === resource.source
            ) {
              const child =
                args?.fork || (!resource.fork && !resource.localForkId)
                  ? addFork(resource.resourceId)
                  : resource.fork
                    ? resource
                    : resources.find(
                        (r) => r.resourceId === resource.localForkId,
                      )!;
              return {
                opened: true,
                nativeId: child.fork?.nativeId,
                resourceId: child.resourceId,
                instruction: "Session opening requested.",
              };
            }
            return {
              opened: true,
              instruction:
                args?.tool !== resource?.source
                  ? `Opened ${args?.tool === "claude" ? "Claude" : "Codex"}'s new-session composer.`
                  : resource?.owner !== user
                    ? "Opened native session. Your continuation will be saved as a copy."
                    : "Opened native session.",
            };
          }
          if (name === "plugin:dialog|save") return options.savePath ?? null;
          if (name === "export_bundle" && options.exportError)
            throw new Error("Destination is not writable");
          if (name === "session_display_title")
            return titles[String(args?.id)] ?? null;
          if (name === "session_messages")
            return {
              messages: [
                { index: 0, role: "user", text: "Session conversation" },
                { index: 1, role: "assistant", text: "Done." },
              ],
              total: 2,
              offset: 0,
            };
          if (
            name === "inspect_resource" &&
            args?.file === "SKILL.md" &&
            options.skillFailure
          ) {
            (window as any).failedSkillReads += 1;
            if (options.skillFailure === "error")
              throw new Error("skill unavailable");
            return { content: null, previous: null, paths: [] };
          }
          if (name === "inspect_resource")
            return {
              content: String(args?.id).startsWith("plan-")
                ? "# Plan steps\n\n- [x] Design\n- [ ] Implement\n\nVerify the release."
                : args?.file === "SKILL.md"
                  ? (options.skillContent ??
                    "---\nname: Review checklist\ndescription: How we review.\n---\n# Preview\nSome content")
                  : "# Preview\nSome content",
              previous: "Old content",
              conversation: "Session conversation",
              paths: ["SKILL.md"],
            };
          if (name.startsWith("plugin:")) return null;
          return {};
        },
      },
    });
  }, options);
  await page.goto("/");
  await expect(
    page.getByRole("combobox", { name: "Select project", exact: true }),
  ).toBeVisible();
}

const heading = (page: Page) => page.locator(".workspace-header h1");
test("resource skeletons keep the reader header and navigation usable", async ({
  page,
}) => {
  await detailFixture(page);
  await page.evaluate(() => {
    const w = window as any;
    const original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (name: string, args: any) => {
      if (name === "inspect_resource" && args.id === "memory-a")
        await new Promise<void>((resolve) => {
          w.finishContentLoad = resolve;
        });
      return original(name, args);
    };
  });
  await page
    .getByRole("region", { name: "Recent Updates" })
    .getByRole("button", { name: /Design decisions/ })
    .click();
  const view = page.getByRole("region", { name: "Memory details" });
  const title = view.getByRole("heading", {
    name: "Design decisions",
    exact: true,
  });
  await expect(title).toBeVisible();
  const before = await title.boundingBox();
  await expect(view.locator(".loading-region")).toHaveAttribute(
    "aria-busy",
    "true",
  );
  await expect(
    view.getByRole("heading", { name: "Project notes", exact: true }),
  ).toHaveCount(0);
  // Safari 15 discards @scope rules. The app's fallback must hide the sample
  // while leaving its geometry and the measured skeleton bars intact.
  await page.evaluate(() => {
    for (const sheet of Array.from(document.styleSheets)) {
      for (let i = sheet.cssRules.length - 1; i >= 0; i--) {
        if (sheet.cssRules[i].cssText.startsWith("@scope")) sheet.deleteRule(i);
      }
    }
  });
  const sample = view.locator("[skullet-ghost] h1");
  await expect(sample).toHaveCSS("visibility", "hidden");
  expect((await sample.boundingBox())!.height).toBeGreaterThan(0);
  await expect(
    view.locator("[skullet-layer] [skullet-rect]").first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Back to Memories", exact: true }),
  ).toBeEnabled();
  await page.screenshot({ path: "artifacts/resource-loading.png" });
  await page.evaluate(() => (window as any).finishContentLoad());
  await expect(
    view.getByRole("heading", { name: "Preview", exact: true }),
  ).toBeVisible();
  await expect(view.locator(".loading-region")).not.toHaveAttribute(
    "aria-busy",
    "true",
  );
  expect(await title.boundingBox()).toEqual(before);
});

test("skeleton shapes never persist resource URLs or paths", async ({
  page,
}) => {
  await page.clock.install();
  await page.addInitScript(() => {
    localStorage.setItem("skullet:shapes", "old private layout");
    const writes: string[] = [];
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "skullet:shapes") writes.push(value);
      original.call(this, key, value);
    };
    Object.assign(window, { skeletonWrites: writes });
  });
  await detailFixture(page, {
    skillContent:
      "# Private resource\n\n[Internal document](https://private.example/design?access_token=test-secret)\n\n[Source](internal/private-project.md)",
  });
  await page.getByRole("button", { name: /^Skills/ }).click();
  await page.getByRole("button", { name: /Review checklist/ }).click();
  await expect(
    page
      .getByRole("article", { name: "Rendered Markdown" })
      .getByRole("link", { name: "Internal document" }),
  ).toBeVisible();
  // Include delayed saves from resizing/mutations as well as the initial save.
  await page.clock.runFor(1000);
  expect(
    await page.evaluate(() => localStorage.getItem("skullet:shapes")),
  ).toBe(null);
  expect(await page.evaluate(() => (window as any).skeletonWrites)).toEqual([]);
});

test("conversation skeletons give way to virtualized turns and paging preserves existing messages", async ({
  page,
}) => {
  // Exercise paging without a reveal animation changing the scroll range.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await detailFixture(page);
  await page.evaluate(() => {
    const w = window as any;
    const original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (name: string, args: any) => {
      if (name !== "session_messages") return original(name, args);
      await new Promise<void>((resolve) => {
        w.finishMessageLoad = resolve;
      });
      return {
        messages: Array.from({ length: 40 }, (_, index) => ({
          index: index + args.offset,
          role: index % 2 ? "assistant" : "user",
          text: `Message ${index + args.offset}`,
        })),
        offset: args.offset,
        total: 80,
      };
    };
  });
  await page.getByRole("button", { name: /^Sessions/ }).click();
  await page
    .getByRole("button", { name: "Polish navigation", exact: true })
    .click();
  const view = page.getByRole("region", { name: "Session details" });
  await expect(view.locator(".loading-region")).toHaveAttribute(
    "aria-busy",
    "true",
  );
  await expect(view.getByRole("article")).toHaveCount(0);
  await page.screenshot({ path: "artifacts/conversation-loading.png" });
  await page.evaluate(() => (window as any).finishMessageLoad());
  await expect(page.getByText("Message 0", { exact: true })).toBeVisible();
  await view.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(
    view.getByText("Loading messages…", { exact: true }),
  ).toBeVisible();
  await expect(view.locator(".loading-region")).not.toHaveAttribute(
    "aria-busy",
    "true",
  );
  await expect(view.getByText("Message 39", { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).finishMessageLoad());
  await view.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(page.getByText("Message 79", { exact: true })).toBeVisible();
});

const more = (page: Page) =>
  page.getByRole("button", { name: "More resource actions", exact: true });
const menu = (page: Page) =>
  page.getByRole("dialog", { name: "Resource actions", exact: true });
const calls = (page: Page, name: string) =>
  page.evaluate(
    (name) =>
      (window as any).invokeCalls
        .filter((call: { name: string }) => call.name === name)
        .map((call: { args: unknown }) => call.args),
    name,
  );

for (const [width, height, memberCatalog] of [
  [1160, 800, "cached"],
  [900, 640, "fetch"],
] as const)
  test(`member names appear across collection tabs at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await detailFixture(page, { memberCatalog });
    await expect(page.locator(".home-updates-list")).toContainText(
      "Updated by Mira Shah",
    );
    await expect(page.locator(".home-updates-list")).toContainText(
      "Updated by Saket Rao (you)",
    );
    for (const [collection, title, author] of [
      ["Memories", "Architecture notes", "Mira Shah"],
      ["Skills", "Review checklist", "Saket Rao (you)"],
      ["Sessions", "Shared planning", "Mira Shah"],
      ["Plans", "Claude release plan", "Saket Rao (you)"],
    ]) {
      await page
        .getByRole("button", { name: new RegExp(`^${collection} \\d`) })
        .click();
      if (collection !== "Skills") {
        const row = page.getByRole("row").filter({
          has: page.getByRole("button", { name: title, exact: true }),
        });
        await expect(row.locator(".resource-table-author")).toHaveText(author);
      }
      await page
        .getByRole("button", {
          name: collection === "Skills" ? new RegExp(`^${title}`) : title,
          exact: collection !== "Skills",
        })
        .click();
      await expect(page.locator(".fact-chip-author")).toHaveText(author);
      await expect(page.locator("body")).not.toContainText(
        "11111111-1111-4111-8111-111111111111",
      );
      await expect(page.locator("body")).not.toContainText(
        "22222222-2222-4222-8222-222222222222",
      );
    }
    await page.screenshot({ path: `artifacts/member-names-${width}.png` });
    await page.getByRole("button", { name: /notifications$/ }).click();
    await expect(
      page.getByRole("dialog", {
        name: "Sync status and notifications",
        exact: true,
      }),
    ).toContainText("Mira Shah continued your session as a copy.");
    await page.keyboard.press("Escape");
    if (memberCatalog === "cached")
      expect(await calls(page, "governance_command")).toEqual([]);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Members", exact: true }).click();
    await expect(
      page
        .getByRole("region", { name: "Settings", exact: true })
        .getByRole("list"),
    ).toContainText("Saket Rao");
  });

test("author sorting follows displayed member names", async ({ page }) => {
  await detailFixture(page, { memberCatalog: "cached" });
  await page.getByRole("button", { name: /^Memories \d/ }).click();
  await page
    .getByRole("button", { name: "Sort by Recently updated", exact: true })
    .click();
  await page
    .getByRole("menuitemradio", { name: "Author", exact: true })
    .click();
  await expect(page.locator(".resource-table-author")).toHaveText([
    "Mira Shah",
    "Saket Rao (you)",
  ]);
});

test("unavailable member names use readable fallbacks", async ({ page }) => {
  await detailFixture(page, { memberCatalog: "unavailable" });
  await page.getByRole("button", { name: /^Memories \d/ }).click();
  await expect(page.locator(".resource-table-author")).toHaveText([
    "You",
    "Member 22222222",
  ]);
  await expect(page.locator("body")).not.toContainText(
    "22222222-2222-4222-8222-222222222222",
  );
});

test("late member lookups cannot replace names in another project", async ({
  page,
}) => {
  await detailFixture(page, {
    memberCatalog: "fetch",
    slowMemberCatalog: true,
  });
  await page.waitForFunction(
    () => typeof (window as any).finishMemberCatalog === "function",
  );
  await page
    .getByRole("combobox", { name: "Select project", exact: true })
    .click();
  await page.getByRole("option", { name: "Studio", exact: true }).click();
  await expect(page.locator(".home-updates-list")).toContainText(
    "Updated by Studio account (you)",
  );
  await page.evaluate(() => (window as any).finishMemberCatalog());
  await expect(page.locator(".home-updates-list")).not.toContainText(
    "Saket Rao",
  );
  await expect(page.locator(".home-updates-list")).toContainText(
    "Studio account (you)",
  );
});

test("a conflict panel sits above the session content with its actions", async ({
  page,
}) => {
  await detailFixture(page);
  await page.getByRole("button", { name: /^Sessions/ }).click();
  await page
    .getByRole("button", { name: "Polish navigation", exact: true })
    .click();
  const conflict = page.locator(".conflict");
  await expect(conflict).toContainText("Two session versions need a choice.");
  const conversation = page.getByLabel("Conversation", { exact: true });
  await expect(conversation).toContainText("Session conversation");
  const [panel, content] = await Promise.all([
    conflict.boundingBox(),
    conversation.boundingBox(),
  ]);
  expect(panel!.y + panel!.height).toBeLessThanOrEqual(content!.y);
  const shared = conflict.getByRole("button", { name: "View shared version" });
  const incoming = conflict.getByRole("button", {
    name: "View incoming version",
  });
  await expect(shared).toHaveAttribute("aria-pressed", "true");
  await incoming.click();
  await expect(incoming).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(() => calls(page, "session_messages"))
    .toContainEqual(
      expect.objectContaining({ id: "session-c", conflictId: "conflict-1" }),
    );
  // The author of the incoming version is not this user, so only the owner actions stay enabled.
  await expect(
    conflict.getByRole("button", { name: "Create copy", exact: true }),
  ).toBeDisabled();
  await conflict
    .getByRole("button", { name: "Keep local", exact: true })
    .click();
  await conflict.getByRole("button", { name: "Override", exact: true }).click();
  await expect
    .poll(() => calls(page, "session_action"))
    .toEqual([
      {
        id: "session-c",
        action: "keep",
        conflictId: "conflict-1",
        selected: "current",
      },
      {
        id: "session-c",
        action: "override",
        conflictId: "conflict-1",
        selected: "candidate",
      },
    ]);
});

test("Plans supports both providers, source filters, Markdown, editor actions, and search", async ({
  page,
}) => {
  await detailFixture(page);
  await expect(page.getByRole("button", { name: /^Plans/ })).toBeVisible();
  await page.getByRole("button", { name: /^Plans/ }).click();
  await expect(heading(page)).toHaveText("Plans");
  const index = page.getByRole("region", { name: "plans", exact: true });
  await expect(
    index.getByRole("button", {
      name: "Codex implementation plan",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    index.getByRole("button", { name: "Claude release plan", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Codex", exact: true }).click();
  await expect(
    index.getByRole("button", { name: "Claude release plan", exact: true }),
  ).toHaveCount(0);
  await index
    .getByRole("button", { name: "Codex implementation plan", exact: true })
    .click();
  const detail = page.getByRole("region", { name: "Plan details" });
  await expect(
    detail.getByRole("heading", { name: "Plan steps" }),
  ).toBeVisible();
  await expect(detail.getByRole("checkbox", { name: "Design" })).toBeChecked();
  await page.screenshot({ path: test.info().outputPath("plans-reader.png") });
  await detail
    .getByRole("button", { name: "Open in editor", exact: true })
    .click();
  expect(await calls(page, "open_editor")).toContainEqual({
    id: "plan-codex",
    file: "content.md",
  });
  await detail.getByRole("button", { name: "More resource actions" }).click();
  await expect(
    page.getByRole("button", { name: "Export ZIP", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Copy link", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Show Markdown", exact: true })
    .click();
  await expect(detail.locator("pre.content")).toHaveText([/- \[x\] Design/]);
  await detail
    .getByRole("button", { name: "More resource actions", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Compare with previous revision" })
    .click();
  await expect(detail.getByLabel("File changes")).toHaveText([/Old content/]);
  await detail
    .getByRole("button", { name: "Back to Plans", exact: true })
    .click();
  await page.getByRole("button", { name: "Claude", exact: true }).click();
  await page
    .getByRole("searchbox", { name: "Search plans" })
    .fill("Claude release plan");
  await page
    .getByRole("group", { name: "Filter by source" })
    .getByRole("button", { name: "All", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Claude release plan", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Plan details" }).locator("h2").first(),
  ).toHaveText("Claude release plan");
  await expect(heading(page)).toHaveText("Plans");
  const axe = await new AxeBuilder({ page })
    .include(".resource-detail")
    .analyze();
  expect(axe.violations).toEqual([]);
});

test("another owner's session shows the copy note and hides Remove from history", async ({
  page,
}) => {
  await detailFixture(page);
  await page.getByRole("button", { name: /^Sessions/ }).click();
  await page
    .getByRole("button", { name: "Shared planning", exact: true })
    .click();
  const view = page.locator(".session-view");
  await expect(view.locator(".detail-note")).toHaveText(
    "Resuming saves your continuation as a copy.",
  );
  await expect(
    page.getByRole("button", {
      name: "Fork and open in Claude Desktop",
      exact: true,
    }),
  ).toBeVisible();
  await more(page).click();
  await expect(menu(page)).not.toContainText("Continue in Codex");
  await expect(menu(page)).toContainText("Create copy");
  await expect(menu(page)).not.toContainText("Export ZIP");
  await expect(menu(page)).not.toContainText("Remove from history");
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Choose how to open session" })
    .click();
  await expect(page.getByRole("menu", { name: "Open session" })).toContainText(
    "Continue in Codex",
  );
  await expect(page.getByRole("menu", { name: "Open session" })).toContainText(
    "Download session (.zip)…",
  );
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Back to Sessions", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Polish navigation", exact: true })
    .click();
  await expect(view.locator(".detail-note")).toHaveCount(0);
  await more(page).click();
  await expect(menu(page)).not.toContainText("Continue in Claude");
  await expect(menu(page)).toContainText("Remove from history");
});

test("ZIP export stays in More for skills and moves into the session launcher", async ({
  page,
}) => {
  await detailFixture(page);
  await page.getByRole("button", { name: /^Memories/ }).click();
  await page
    .getByRole("button", { name: "Design decisions", exact: true })
    .click();
  await more(page).click();
  await expect(menu(page)).toContainText("Copy link");
  await expect(menu(page)).toContainText("Show Markdown");
  await expect(menu(page)).not.toContainText("Export ZIP");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /^Skills/ }).click();
  await page.getByRole("button", { name: /Review checklist/ }).click();
  await more(page).click();
  await expect(menu(page)).toContainText("Export ZIP");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /^Sessions/ }).click();
  await page
    .getByRole("button", { name: "Polish navigation", exact: true })
    .click();
  await more(page).click();
  await expect(menu(page)).not.toContainText("Export ZIP");
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Choose how to open session" })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "Download session (.zip)…" }),
  ).toBeVisible();
});

test("Copy link in the resource menu keeps the menu open and confirms inline", async ({
  page,
}) => {
  await detailFixture(page);
  await page.getByRole("button", { name: /^Memories/ }).click();
  await page
    .getByRole("button", { name: "Design decisions", exact: true })
    .click();
  await more(page).click();
  const copy = menu(page).getByRole("button", {
    name: "Copy link",
    exact: true,
  });
  await copy.click();
  await expect(menu(page)).toBeVisible();
  await expect(copy).toHaveAttribute("data-copied", "true");
  await expect(menu(page).getByRole("status")).toHaveText("Link copied");
  expect(await page.evaluate(() => (window as any).copiedText)).toBe(
    "orka://project/one/memory-a",
  );
});

for (const size of [
  { width: 1160, height: 800 },
  { width: 900, height: 640 },
]) {
  test(`action popovers preserve selection, focus and reduced motion at ${size.width}`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await detailFixture(page);
    await page.getByRole("button", { name: /^Skills/ }).click();
    await page.evaluate(() => {
      (window as any).popoverExits = 0;
      document.addEventListener("animationend", (event) => {
        if (event.animationName === "popover-disappear")
          (window as any).popoverExits += 1;
      });
    });
    const sort = page.getByRole("button", { name: /^Sort by/ });
    const sortMenu = page.getByRole("dialog", { name: "Sort by", exact: true });
    await sort.click();
    await expect(sortMenu).toHaveCSS("animation-duration", "0.16s");
    await sortMenu.getByRole("menuitemradio", { name: "Title" }).click();
    await expect(sortMenu).toHaveCount(0);
    await expect(sort).toHaveAccessibleName("Sort by Title");
    await expect(sort).toBeFocused();
    expect(await page.evaluate(() => (window as any).popoverExits)).toBe(1);

    await page.getByRole("button", { name: /Review checklist/ }).click();
    const files = page.getByRole("button", { name: "2 files" });
    const filesMenu = page.getByRole("dialog", { name: "Files", exact: true });
    await files.click();
    await expect(filesMenu).toHaveCSS("animation-duration", "0.16s");
    await filesMenu
      .getByRole("button", { name: "references/tokens.md" })
      .click();
    await expect(filesMenu).toHaveCount(0);
    await expect(files).toBeFocused();
    await expect
      .poll(() => calls(page, "inspect_resource"))
      .toContainEqual(
        expect.objectContaining({ file: "references/tokens.md" }),
      );

    await more(page).press("Enter");
    await expect(menu(page)).toHaveCSS("animation-name", "none");
    await page.keyboard.press("Escape");
    await expect(menu(page)).toHaveCount(0);
    await expect(more(page)).toBeFocused();
    await more(page).click();
    await expect(menu(page)).toHaveCSS("animation-duration", "0.16s");
    // Escape remains instant even after a pointer opened the menu.
    const exits = await page.evaluate(() => (window as any).popoverExits);
    await page.keyboard.press("Escape");
    await expect(menu(page)).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).popoverExits)).toBe(exits);

    await page.emulateMedia({ reducedMotion: "reduce" });
    await more(page).click();
    await expect(menu(page)).toHaveCSS("animation-name", "none");
    await menu(page).getByRole("button", { name: "Show Markdown" }).click();
    await expect(menu(page)).toHaveCount(0);
    await expect(more(page)).toBeFocused();
    expect(await page.evaluate(() => (window as any).popoverExits)).toBe(exits);
  });
}

test("switching project clears the index filters", async ({ page }) => {
  await detailFixture(page);
  await page.getByRole("button", { name: /^Memories/ }).click();
  const search = page.getByRole("searchbox", { name: "Search memories" });
  const sources = page.getByRole("group", { name: "Filter by source" });
  await search.fill("archi");
  await sources.getByRole("button", { name: "Claude", exact: true }).click();
  await expect(page.getByText("1 memory", { exact: true })).toBeVisible();
  const selector = page.getByRole("combobox", { name: "Select project" });
  await selector.click();
  await page.getByRole("option", { name: "Studio" }).click();
  await expect(heading(page)).toHaveText("Memories");
  await selector.click();
  await page.getByRole("option", { name: "Orka" }).click();
  await expect(search).toHaveValue("");
  await expect(
    sources.getByRole("button", { name: "All", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("2 memories", { exact: true })).toHaveCount(0);
});

test("a project-only deep link shows that project's index instead of the open detail", async ({
  page,
}) => {
  await detailFixture(page);
  await page.getByRole("button", { name: /^Memories/ }).click();
  await page
    .getByRole("button", { name: "Design decisions", exact: true })
    .click();
  await expect(page.locator(".resource-detail--memory")).toBeVisible();
  await page.evaluate(() =>
    (window as any).reviewDeepLink({ payload: ["orka://project/two"] }),
  );
  await expect(
    page.getByRole("combobox", { name: "Select project" }),
  ).toContainText("Studio");
  await expect(page.locator(".resource-detail")).toHaveCount(0);
  await expect(page.locator(".resource-index")).toBeVisible();
  await expect(heading(page)).toHaveText("Memories");
});

test("Home recent rows and collection rows open the reading view", async ({
  page,
}, info) => {
  await detailFixture(page);
  for (const width of [1160, 900]) {
    await page.setViewportSize({ width, height: width === 900 ? 640 : 800 });
    await expect(
      page.getByRole("region", { name: "Project totals" }).locator("strong"),
    ).toHaveText(["2", "1", "2", "2"]);
    await page.screenshot({ path: info.outputPath(`home-${width}.png`) });
  }
  await page.setViewportSize({ width: 1160, height: 800 });
  await page
    .getByRole("region", { name: "Recent Updates" })
    .getByRole("button", { name: /Design decisions/ })
    .click();
  const view = page.locator(".resource-detail--memory");
  await expect(view.locator("h2").first()).toHaveText("Design decisions");
  await expect(heading(page)).toHaveText("Memories");
  await page
    .getByRole("button", { name: "Back to Memories", exact: true })
    .click();
  await page.getByRole("button", { name: /^Skills/ }).click();
  await page.getByRole("button", { name: /^Review checklist/ }).click();
  await expect(page.locator(".resource-detail--skill h2").first()).toHaveText(
    "Review checklist",
  );
  await expect(heading(page)).toHaveText("Skills");
  await expect(
    page.getByRole("button", { name: "Back to Skills", exact: true }),
  ).toBeVisible();
});

test("Back returns focus to the opened row, or to the search field when filtered out", async ({
  page,
}) => {
  await detailFixture(page);
  await page.getByRole("button", { name: /^Memories/ }).click();
  const row = page.getByRole("button", {
    name: "Design decisions",
    exact: true,
  });
  await row.focus();
  await page.keyboard.press("Enter");
  const back = page.getByRole("button", {
    name: "Back to Memories",
    exact: true,
  });
  await expect(back).toBeVisible();
  await back.focus();
  await page.keyboard.press("Enter");
  await expect(row).toBeFocused();
  // A deep link can open a memory while the index filters hide it.
  const search = page.getByRole("searchbox", { name: "Search memories" });
  await search.fill("archi");
  await expect(row).toHaveCount(0);
  await page.evaluate(() =>
    (window as any).reviewDeepLink({
      payload: ["orka://project/one/memory-a"],
    }),
  );
  await expect(page.locator(".resource-detail--memory h2").first()).toHaveText(
    "Design decisions",
  );
  await page
    .getByRole("button", { name: "Back to Memories", exact: true })
    .click();
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("archi");
});

test("the simplified skill reader keeps the document heading order", async ({
  page,
}) => {
  await detailFixture(page);
  await page.getByRole("button", { name: /^Skills/ }).click();
  await page.getByRole("button", { name: /Review checklist/ }).click();
  const view = page.locator(".resource-detail--skill");
  await expect(view).toContainText("Some content");
  await expect(view.locator(".detail-rail")).toHaveCount(0);
  const accessibility = await new AxeBuilder({ page })
    .include(".resource-detail--skill")
    .withRules(["heading-order"])
    .analyze();
  expect(accessibility.violations).toEqual([]);
});

test("the sidebar collapses and expands while a detail is open", async ({
  page,
}) => {
  await detailFixture(page);
  await page.getByRole("button", { name: /^Memories/ }).click();
  await page
    .getByRole("button", { name: "Design decisions", exact: true })
    .click();
  const sidebar = page.locator(".sidebar");
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(sidebar).toHaveClass(/sidebar-collapsed/);
  await expect(
    page.locator(".resource-detail--memory h2").first(),
  ).toBeVisible();
  await expect(page.locator(".resource-detail--memory")).toContainText(
    "Some content",
  );
  await page.getByRole("button", { name: "Expand sidebar" }).click();
  await expect(sidebar).not.toHaveClass(/sidebar-collapsed/);
});

test("a deep link that arrives before the first snapshot still opens the memory", async ({
  page,
}) => {
  await detailFixture(page, {
    deepLink: "orka://project/one/memory-a",
    slowSnapshot: true,
  });
  await expect(heading(page)).toHaveText("Memories");
  const view = page.locator(".resource-detail--memory");
  await expect(view.locator("h2").first()).toHaveText("Design decisions");
  await expect(view).toContainText("Some content");
});

for (const failure of ["error", "null content"] as const) {
  test(`skill summaries settle after ${failure} without repeated reads`, async ({
    page,
  }) => {
    await detailFixture(page, { skillFailure: failure });
    await page.getByRole("button", { name: /^Skills/ }).click();
    await expect
      .poll(() => page.evaluate(() => (window as any).failedSkillReads))
      .toBe(1);
    await page.getByRole("searchbox", { name: "Search skills" }).fill("review");
    await page.getByRole("button", { name: "Home", exact: true }).click();
    await page.getByRole("button", { name: /^Skills/ }).click();
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => (window as any).failedSkillReads)).toBe(1);
    await expect(page.locator(".skill-card")).toContainText("Review checklist");
  });
}

test("failed session pages wait for an explicit retry", async ({ page }) => {
  await detailFixture(page);
  await page.evaluate(() => {
    const w = window as any;
    const original = w.__TAURI_INTERNALS__.invoke;
    w.failedSessionReads = 0;
    w.__TAURI_INTERNALS__.invoke = async (name: string, args: any) => {
      if (name === "session_messages") {
        if (args.offset > 0 && w.failedSessionReads === 0) {
          w.failedSessionReads++;
          await new Promise((resolve) => setTimeout(resolve, 10));
          throw new Error("session page unavailable");
        }
        return {
          messages: Array.from({ length: 40 }, (_, index) => ({
            index: index + args.offset,
            role: index % 2 ? "assistant" : "user",
            text: `Message ${index + args.offset}`,
          })),
          offset: args.offset,
          total: 80,
        };
      }
      return original(name, args);
    };
  });
  await page.getByRole("button", { name: /^Sessions/ }).click();
  await page
    .getByRole("button", { name: "Polish navigation", exact: true })
    .click();
  await expect(page.getByText("Message 0", { exact: true })).toBeVisible();
  await page.locator(".session-view").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(page.getByRole("alert")).toContainText(
    "session page unavailable",
  );
  await expect(
    page.getByRole("button", { name: "Show more messages", exact: true }),
  ).toHaveCount(0);
  await page.waitForTimeout(200);
  await expect(page.getByRole("alert")).toContainText(
    "session page unavailable",
  );
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.locator(".session-view").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(page.getByText("Message 79", { exact: true })).toBeVisible();
});

test("skill search and sorting use the displayed frontmatter name", async ({
  page,
}) => {
  await detailFixture(page, {
    skillContent:
      "---\nname: Code audit\ndescription: How we review.\n---\n# Code audit",
  });
  await page.getByRole("button", { name: /^Skills/ }).click();
  await expect(page.locator(".skill-card")).toContainText("Code audit");
  await page.getByRole("searchbox").fill("Code audit");
  await expect(page.locator(".skill-card")).toHaveCount(1);
  await expect(page.locator(".skill-card")).toContainText("Code audit");
});

test("resuming a shared session uses the floating toast and keeps the reader layout in place", async ({
  page,
}) => {
  await detailFixture(page);
  await page.getByRole("button", { name: /^Sessions/ }).click();
  await page
    .getByRole("button", { name: "Shared planning", exact: true })
    .click();
  const header = page.locator(".workspace-header");
  const before = await header.boundingBox();
  const resume = page.getByRole("button", {
    name: "Fork and open in Claude Desktop",
    exact: true,
  });
  await resume.click();
  const toast = page.locator("[data-orka-toast]");
  await expect(toast.getByRole("status")).toHaveText(
    "Changes will save as a copy",
  );
  await expect(page.locator("main > .banner")).toHaveCount(0);
  expect(await header.boundingBox()).toEqual(before);
  await toast.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(toast).toHaveCount(0);
  await expect(resume).toBeFocused();
});

async function openSession(page: Page, title = "Polish navigation") {
  await page.getByRole("button", { name: /^Sessions/ }).click();
  await page.getByRole("button", { name: title, exact: true }).click();
}

async function chooseTerminal(page: Page, name: string) {
  await page.getByRole("combobox", { name: "Terminal application" }).click();
  await page.getByRole("option", { name, exact: true }).click();
}

test("fork groups expand, paginate, filter and restore focus on nested sessions", async ({
  page,
}) => {
  await detailFixture(page, { forks: 7 });
  await page.getByRole("button", { name: /^Sessions/ }).click();
  const expand = page.getByRole("button", {
    name: "Expand 7 forks of Polish navigation",
  });
  await expect(
    page.getByRole("button", { name: "Fork 1", exact: true }),
  ).toHaveCount(0);
  await expand.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", { name: "Fork 1", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Fork 7", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Show more forks of Polish navigation" })
    .click();
  await expect(
    page.getByRole("button", { name: "Fork 7", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Expand 1 fork of Fork 1" }).click();
  await page.getByRole("button", { name: "Fork 8", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Open in Codex", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Back to Sessions" }).click();
  await expect(
    page.getByRole("button", { name: "Fork 8", exact: true }),
  ).toBeFocused();
  await page
    .getByRole("button", { name: "Show more forks of Polish navigation" })
    .click();
  await page.getByRole("button", { name: "Fork 7", exact: true }).click();
  await page.getByRole("button", { name: "Back to Sessions" }).click();
  await expect(
    page.getByRole("button", { name: "Fork 7", exact: true }),
  ).toBeFocused();
  await page.getByRole("searchbox").fill("Fork 7");
  await expect(
    page.getByRole("button", { name: "Fork 7", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".resource-table tbody tr")).toHaveCount(1);
});

test("opening retains the existing fork and only the explicit action creates another", async ({
  page,
}) => {
  await detailFixture(page, { forks: 0, offline: true });
  await openSession(page);
  await page
    .getByRole("button", { name: "Fork and open in Codex", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Open in Codex", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Open in Codex", exact: true })
    .click();
  await page.getByRole("button", { name: "Back to Sessions" }).click();
  await page
    .getByRole("button", { name: "Expand 1 fork of Polish navigation" })
    .click();
  await page.getByRole("button", { name: "Fork 1", exact: true }).click();
  await page
    .getByRole("button", { name: "Open in Codex", exact: true })
    .click();
  await expect.poll(() => calls(page, "resume_session")).toHaveLength(3);
  expect((await calls(page, "resume_session")).at(-1)).toEqual({
    id: "fork-1",
    tool: "codex",
    destination: "desktop",
  });
  await page
    .getByRole("button", { name: "Choose how to open session" })
    .click();
  await page
    .getByRole("menuitem", {
      name: /^Fork and open in Codex Creates another session$/,
    })
    .click();
  await expect.poll(() => calls(page, "resume_session")).toHaveLength(4);
  expect((await calls(page, "resume_session")).at(-1)).toEqual({
    id: "fork-1",
    tool: "codex",
    destination: "desktop",
    fork: true,
  });
  await page.getByRole("button", { name: "Back to Sessions" }).click();
  await expect(
    page.getByRole("button", { name: "Expand 1 fork of Fork 1" }),
  ).toBeVisible();
});

test("explicit forks can use the selected terminal without changing the opening default", async ({
  page,
}) => {
  await detailFixture(page, { forks: 1 });
  await openSession(page);
  await page
    .getByRole("button", { name: "Choose how to open session" })
    .click();
  await chooseTerminal(page, "Warp");
  await page
    .getByRole("menuitem", {
      name: /^Fork and open in Codex CLI Creates another session in Warp$/,
    })
    .click();
  expect((await calls(page, "resume_session")).at(-1)).toEqual({
    id: "session-c",
    tool: "codex",
    destination: "warp",
    fork: true,
  });
  await expect(
    page.getByRole("button", { name: "Open in Codex", exact: true }),
  ).toBeEnabled();
});

for (const viewport of [
  { width: 1160, height: 800 },
  { width: 900, height: 640 },
]) {
  test(`expanded fork rows fit and remain accessible at ${viewport.width}×${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await detailFixture(page, { forks: 3 });
    await page.getByRole("button", { name: /^Sessions/ }).click();
    await page
      .getByRole("button", { name: "Expand 3 forks of Polish navigation" })
      .click();
    await page.getByRole("button", { name: "Expand 1 fork of Fork 1" }).click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const results = await new AxeBuilder({ page })
      .include(".resource-table")
      .analyze();
    expect(results.violations).toEqual([]);
    await page.screenshot({
      path: `artifacts/fork-list-${viewport.width}.png`,
    });
  });
}

for (const [title, tool, label] of [
  ["Polish navigation", "codex", "Codex"],
  ["Shared planning", "claude", "Claude Desktop"],
] as const) {
  test(`session launcher preserves the ${tool} default across every terminal destination`, async ({
    page,
  }) => {
    await detailFixture(page);
    await openSession(page, title);
    const primary = page.getByRole("button", {
      name: `Fork and open in ${label}`,
      exact: true,
    });
    await expect(primary).toBeEnabled();
    await expect(primary).toHaveText(`Fork and open in ${label}`);
    await primary.click();
    for (const [name, destination] of [
      ["Terminal", "terminal"],
      ["Warp", "warp"],
      ["iTerm2", "iterm2"],
    ]) {
      await page
        .getByRole("button", { name: "Choose how to open session" })
        .click();
      await chooseTerminal(page, name);
      await page
        .getByRole("menuitem", {
          name: new RegExp(
            `^Fork in ${tool === "claude" ? "Claude Code CLI" : "Codex CLI"} New fork in ${name}`,
          ),
        })
        .click();
      await expect(
        page.getByRole("menu", { name: "Open session" }),
      ).toHaveCount(0);
      await expect(primary).toBeEnabled();
      expect((await calls(page, "resume_session")).at(-1)).toEqual({
        id: tool === "codex" ? "session-c" : "session-m",
        tool,
        destination,
      });
    }
    await primary.click();
    await expect.poll(() => calls(page, "resume_session")).toHaveLength(5);
    expect((await calls(page, "resume_session")).at(-1)).toEqual({
      id: tool === "codex" ? "session-c" : "session-m",
      tool,
      destination: "desktop",
    });
  });
}

test("session destinations render icons provided by the local app discovery", async ({
  page,
}) => {
  const appIcons = Object.fromEntries(
    ["codex", "claude", "terminal", "warp", "iterm2"].map((app) => [
      app,
      `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><title>${app}</title><rect width="32" height="32" fill="white"/></svg>`)}`,
    ]),
  );
  await detailFixture(page, { appIcons });
  await openSession(page);
  const primary = page.getByRole("button", {
    name: "Fork and open in Codex",
    exact: true,
  });
  await expect(primary.locator("img")).toHaveAttribute("src", appIcons.codex);
  await page
    .getByRole("button", { name: "Choose how to open session" })
    .click();
  for (const [label, app] of [
    ["Fork in Codex Creates a new fork Default", "codex"],
    ["Fork in Codex CLI New fork in Terminal", "terminal"],
    [
      "Continue in Claude Code CLI… Starts immediately in Terminal with context",
      "terminal",
    ],
    ["Continue in Claude Desktop… New conversation with context", "claude"],
  ]) {
    const image = page
      .getByRole("menuitem", { name: label, exact: true })
      .locator("img");
    await expect(image).toHaveAttribute("src", appIcons[app]);
    await expect
      .poll(() =>
        image.evaluate((element: HTMLImageElement) => element.naturalWidth),
      )
      .toBe(32);
  }
  await chooseTerminal(page, "Warp");
  // An unreadable app icon must preserve the destination and its action.
  await page.evaluate(() => {
    const image = document.querySelector(
      '.session-launcher-popover button img[src*="warp"]',
    );
    image?.dispatchEvent(new Event("error"));
  });
  const warp = page.getByRole("menuitem", {
    name: "Fork in Codex CLI New fork in Warp",
    exact: true,
  });
  await expect(warp.locator("img")).toHaveCount(0);
  await warp.click();
  expect((await calls(page, "resume_session")).at(-1)).toEqual({
    id: "session-c",
    tool: "codex",
    destination: "warp",
  });
});

test("cross-provider continuation is labeled as new context and routes to the other desktop app", async ({
  page,
}) => {
  await detailFixture(page);
  for (const [title, tool, other] of [
    ["Polish navigation", "claude", "Claude Desktop"],
    ["Shared planning", "codex", "Codex"],
  ]) {
    await openSession(page, title);
    await page
      .getByRole("button", { name: "Choose how to open session" })
      .click();
    const handoff = page.getByRole("menuitem", {
      name: new RegExp(`^Continue in ${other}…`),
    });
    await expect(handoff).toContainText("New conversation with context");
    await handoff.click();
    await expect
      .poll(() => calls(page, "resume_session"))
      .toContainEqual({
        id: tool === "claude" ? "session-c" : "session-m",
        tool,
        destination: "desktop",
      });
    await page
      .getByRole("button", { name: "Back to Sessions", exact: true })
      .click();
  }
});

for (const savePath of [null, "/test/export/session.zip"]) {
  test(`session download ${savePath ? "saves the full bundle" : "cancels cleanly"} without a connected folder`, async ({
    page,
  }) => {
    await detailFixture(page, { disconnected: true, savePath });
    await openSession(page);
    await expect(
      page.getByRole("button", { name: "Fork and open in Codex", exact: true }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "Choose how to open session" })
      .click();
    await page
      .getByRole("menuitem", { name: "Download session (.zip)…" })
      .click();
    await expect.poll(() => calls(page, "plugin:dialog|save")).toHaveLength(1);
    await expect(
      page.getByRole("button", { name: "Choose how to open session" }),
    ).toBeEnabled();
    expect(await calls(page, "export_bundle")).toEqual(
      savePath ? [{ id: "session-c", path: savePath }] : [],
    );
    expect(await calls(page, "resume_session")).toEqual([]);
    if (savePath)
      await expect(page.getByRole("status")).toContainText("Download saved");
    else await expect(page.locator("[data-orka-toast]")).toHaveCount(0);
  });
}

test("missing default app leaves alternatives and download available", async ({
  page,
}) => {
  await detailFixture(page, { launchOptions: "missing-default" });
  await openSession(page);
  await expect(
    page.getByRole("button", {
      name: "Fork and open in Codex CLI",
      exact: true,
    }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Choose how to open session" })
    .click();
  await expect(
    page.getByRole("menuitem", { name: /Codex.*Update the desktop/ }),
  ).toBeDisabled();
  await expect(
    page.getByRole("menuitem", {
      name: /^Fork in Codex CLI New fork in Terminal/,
    }),
  ).toBeEnabled();
  await expect(
    page.getByRole("menuitem", { name: "Download session (.zip)…" }),
  ).toBeEnabled();
  await page.keyboard.press("Home");
  await expect(
    page.getByRole("menuitem", {
      name: /^Fork in Codex CLI New fork in Terminal/,
    }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Choose how to open session" }),
  ).toBeFocused();
});

test("opening the destination menu rechecks apps installed since the reader loaded", async ({
  page,
}) => {
  await detailFixture(page, { launchOptions: "missing-default" });
  await openSession(page);
  const primary = page.getByRole("button", {
    name: "Fork and open in Codex CLI",
    exact: true,
  });
  await expect(primary).toBeEnabled();
  await page.evaluate(() => {
    const w = window as any;
    const original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (name: string, args: unknown) => {
      const result = await original(name, args);
      return name === "session_launch_options"
        ? result.map((option: any, index: number) => ({
            ...option,
            isDefault: index === 0,
            available: true,
            reason: null,
          }))
        : result;
    };
  });
  await page
    .getByRole("button", { name: "Choose how to open session" })
    .click();
  await expect(
    page.getByRole("menuitem", {
      name: "Fork in Codex Creates a new fork Default",
      exact: true,
    }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Fork and open in Codex", exact: true }),
  ).toBeEnabled();
  expect(await calls(page, "resume_session")).toEqual([]);
});

test("a pending launch disables both controls and prevents repeated activation", async ({
  page,
}) => {
  await detailFixture(page);
  await page.evaluate(() => {
    const w = window as any;
    const original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (name: string, args: unknown) => {
      const result = await original(name, args);
      if (name === "resume_session")
        await new Promise<void>((resolve) => {
          w.finishResume = resolve;
        });
      return result;
    };
  });
  await openSession(page);
  const primary = page.getByRole("button", {
    name: "Fork and open in Codex",
    exact: true,
  });
  const trigger = page.getByRole("button", {
    name: "Choose how to open session",
  });
  await primary.click();
  await expect(primary).toBeDisabled();
  await expect(trigger).toBeDisabled();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Space");
  expect(await calls(page, "resume_session")).toHaveLength(1);
  expect(await calls(page, "export_bundle")).toEqual([]);
  await expect(page.locator("[data-orka-toast]")).toHaveCount(0);
  await page.evaluate(() => (window as any).finishResume());
  await expect(primary).toBeEnabled();
  await expect(trigger).toBeEnabled();
  await expect(page.getByRole("status")).toHaveText("Session opened");
});

test("download confirms success only after the ZIP write finishes", async ({
  page,
}) => {
  await detailFixture(page, { savePath: "/test/export/session.zip" });
  await page.evaluate(() => {
    const w = window as any;
    const original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (name: string, args: unknown) => {
      const result = await original(name, args);
      if (name === "export_bundle")
        await new Promise<void>((resolve) => {
          w.finishDownload = resolve;
        });
      return result;
    };
  });
  await openSession(page);
  const trigger = page.getByRole("button", {
    name: "Choose how to open session",
  });
  await trigger.click();
  await page
    .getByRole("menuitem", { name: "Download session (.zip)…" })
    .click();
  await expect.poll(() => calls(page, "export_bundle")).toHaveLength(1);
  await expect(trigger).toBeDisabled();
  await expect(page.locator("[data-orka-toast]")).toHaveCount(0);
  await page.evaluate(() => (window as any).finishDownload());
  await expect(page.getByRole("status")).toContainText("Download saved");
  await expect(trigger).toBeEnabled();
  expect(await calls(page, "resume_session")).toEqual([]);
});

test("a failed session download reports the write error without success", async ({
  page,
}) => {
  await detailFixture(page, {
    savePath: "/test/unwritable/session.zip",
    exportError: true,
  });
  await openSession(page);
  await page
    .getByRole("button", { name: "Choose how to open session" })
    .click();
  await page
    .getByRole("menuitem", { name: "Download session (.zip)…" })
    .click();
  await expect(page.getByRole("alert")).toContainText("Couldn’t export ZIP");
  await expect(
    page.getByRole("status").filter({ hasText: "Download saved" }),
  ).toHaveCount(0);
  expect(await calls(page, "export_bundle")).toEqual([
    { id: "session-c", path: "/test/unwritable/session.zip" },
  ]);
});

test("Warp falls back to a copyable command without claiming the session opened", async ({
  page,
}) => {
  await detailFixture(page, { manualResume: true });
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as any).copiedResumeCommand = text;
        },
      },
    }),
  );
  await openSession(page);
  await page
    .getByRole("button", { name: "Choose how to open session" })
    .click();
  await chooseTerminal(page, "Warp");
  await page
    .getByRole("menuitem", {
      name: "Fork in Codex CLI New fork in Warp",
      exact: true,
    })
    .click();
  const dialog = page.getByRole("dialog", { name: "Continue in Warp" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("textbox", { name: "Resume command" }),
  ).toHaveValue(/exact-native-id/);
  await expect(page.locator("[data-orka-toast]")).toHaveCount(0);
  await dialog
    .getByRole("button", { name: "Copy command", exact: true })
    .click();
  expect(
    await page.evaluate(() => (window as any).copiedResumeCommand),
  ).toContain("exact-native-id");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page
    .getByRole("button", { name: "Back to Sessions", exact: true })
    .click();
  await openSession(page, "Shared planning");
  await expect(
    page.getByRole("dialog", { name: "Continue in Warp" }),
  ).toHaveCount(0);
});

test("a failed launch gives an error without success or automatic retry", async ({
  page,
}) => {
  await detailFixture(page, { resumeError: true });
  await openSession(page);
  await page
    .getByRole("button", { name: "Fork and open in Codex", exact: true })
    .click();
  await expect(
    page.locator("[data-orka-toast]").getByRole("alert"),
  ).toContainText("Couldn’t open session");
  await expect(page.locator(".detail-launch-error")).toContainText(
    "Could not launch destination",
  );
  await expect(
    page
      .locator("[data-orka-toast]")
      .getByRole("button", { name: "Try again" }),
  ).toHaveCount(0);
  expect(await calls(page, "resume_session")).toHaveLength(1);
});

test("offline sync does not disable fork and open from cached session history", async ({
  page,
}) => {
  await detailFixture(page, { offline: true });
  await openSession(page);
  const primary = page.getByRole("button", {
    name: "Fork and open in Codex",
    exact: true,
  });
  await expect(primary).toBeEnabled();
  await primary.click();
  await expect
    .poll(() => calls(page, "resume_session"))
    .toEqual([{ id: "session-c", tool: "codex", destination: "desktop" }]);
  await expect(primary).toBeEnabled();
});

test("failed app discovery keeps download available and can be retried", async ({
  page,
}) => {
  await detailFixture(page, { launchOptions: "error" });
  await openSession(page);
  await page
    .getByRole("button", { name: "Choose how to open session" })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Couldn’t check available apps",
  );
  await expect(
    page.getByRole("menuitem", { name: "Download session (.zip)…" }),
  ).toBeEnabled();
  const before = (await calls(page, "session_launch_options")).length;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect
    .poll(async () => (await calls(page, "session_launch_options")).length)
    .toBeGreaterThan(before);
  await expect(page.getByRole("menu", { name: "Open session" })).toBeVisible();
});

test("late launch options cannot enable a different session", async ({
  page,
}) => {
  await detailFixture(page, { launchOptions: "slow" });
  await openSession(page);
  await expect
    .poll(() => calls(page, "session_launch_options"))
    .toHaveLength(1);
  await page
    .getByRole("button", { name: "Back to Sessions", exact: true })
    .click();
  await page.evaluate(() => (window as any).finishLaunchOptions());
  await openSession(page, "Shared planning");
  await expect(
    page.getByRole("button", {
      name: "Fork and open in Claude Desktop",
      exact: true,
    }),
  ).toBeDisabled();
  await expect
    .poll(() => calls(page, "session_launch_options"))
    .toHaveLength(2);
  await page.evaluate(() => (window as any).finishLaunchOptions());
  await expect(
    page.getByRole("button", {
      name: "Fork and open in Claude Desktop",
      exact: true,
    }),
  ).toBeEnabled();
});

for (const dimension of ["profile", "user", "service"] as const) {
  for (const pendingOptions of [true, false]) {
    test(`session ${pendingOptions ? "launch options" : "manual command"} cannot leak across ${dimension} changes`, async ({
      page,
    }) => {
      await page.clock.install();
      await detailFixture(page, { manualResume: !pendingOptions });
      await page.evaluate(
        ({ dimension, pendingOptions }) => {
          const w = window as any;
          const original = w.__TAURI_INTERNALS__.invoke;
          w.changedScope = false;
          w.pendingLaunchOptions = [];
          w.__TAURI_INTERNALS__.invoke = async (
            name: string,
            args: unknown,
          ) => {
            const result = await original(name, args);
            if (name === "snapshot" && w.changedScope) {
              if (dimension === "profile")
                return { ...result, profile: "another-profile" };
              if (dimension === "user")
                return { ...result, user: "another-user" };
              return {
                ...result,
                config: {
                  ...result.config,
                  apiUrl: "https://another-service.example",
                },
              };
            }
            if (name === "session_launch_options" && pendingOptions)
              return new Promise((resolve) => {
                w.pendingLaunchOptions.push(() => resolve(result));
              });
            return result;
          };
        },
        { dimension, pendingOptions },
      );
      await openSession(page);
      if (!pendingOptions) {
        await page
          .getByRole("button", { name: "Choose how to open session" })
          .click();
        await chooseTerminal(page, "Warp");
        await page
          .getByRole("menuitem", {
            name: "Fork in Codex CLI New fork in Warp",
            exact: true,
          })
          .click();
        await expect(
          page.getByRole("dialog", { name: "Continue in Warp" }),
        ).toBeVisible();
      } else {
        await expect
          .poll(() => calls(page, "session_launch_options"))
          .toHaveLength(1);
      }
      await page.evaluate(() => {
        (window as any).changedScope = true;
      });
      await page.clock.runFor(3100);
      await expect(
        page.getByRole("dialog", { name: "Continue in Warp" }),
      ).toHaveCount(0);
      const primary = page.getByRole("button", {
        name: "Fork and open in Codex",
        exact: true,
      });
      if (pendingOptions) {
        await expect
          .poll(() => calls(page, "session_launch_options"))
          .toHaveLength(2);
        await page.evaluate(() => (window as any).pendingLaunchOptions[0]());
        await page.clock.runFor(32);
        await expect(primary).toBeDisabled();
        await page.evaluate(() => (window as any).pendingLaunchOptions[1]());
      }
      await expect(primary).toBeEnabled();
      expect(await calls(page, "resume_session")).toHaveLength(
        pendingOptions ? 0 : 1,
      );
    });
  }
}

for (const [tool, sourceTitle, label] of [
  ["codex", "Polish navigation", "Codex"],
  ["claude", "Shared planning", "Claude Desktop"],
] as const) {
  for (const width of [1160, 900]) {
    test(`${tool} session launcher keyboard access, layout, and reduced motion at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: width === 900 ? 640 : 800 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      const title =
        width === 900
          ? "Implement a provider-agnostic session launcher and preserve teammate continuation behavior"
          : "Polish navigation";
      await detailFixture(page, { sessionTitle: title });
      await openSession(page, tool === "codex" ? title : sourceTitle);
      await expect(
        page.getByRole("button", {
          name: `Fork and open in ${label}`,
          exact: true,
        }),
      ).toHaveText(`Fork and open in ${label}`);
      const heading = page.locator(".detail-title");
      expect((await heading.boundingBox())!.width).toBeGreaterThanOrEqual(280);
      const trigger = page.getByRole("button", {
        name: "Choose how to open session",
      });
      await trigger.focus();
      await page.keyboard.press("Enter");
      const menu = page.getByRole("menu", { name: "Open session" });
      await expect(menu).toBeVisible();
      await page.keyboard.press("End");
      await expect(
        page.getByRole("menuitem", { name: "Download session (.zip)…" }),
      ).toBeFocused();
      await page.keyboard.press("Home");
      await expect(
        page.getByRole("menuitem", {
          name: `Fork in ${label} Creates a new fork Default`,
          exact: true,
        }),
      ).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(
        page.getByRole("menuitem", {
          name: new RegExp(
            `^Fork in ${tool === "claude" ? "Claude Code CLI" : "Codex CLI"} New fork in Terminal`,
          ),
        }),
      ).toBeFocused();
      const bounds = await menu.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(
        width === 900 ? 640 : 800,
      );
      const accessibility = await new AxeBuilder({ page })
        .include('[role="menu"]')
        .analyze();
      expect(accessibility.violations).toEqual([]);
      await page.screenshot({
        path: `artifacts/session-launcher-${tool}-${width}.png`,
      });
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
    });
  }
}

async function readerContent(page: Page, content: string) {
  await page.evaluate((content) => {
    const w = window as any;
    const original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (name: string, args: any) => {
      const value = await original(name, args);
      if (name === "inspect_resource" && args.id === "memory-a")
        return { ...value, content };
      if (name === "session_messages")
        return {
          ...value,
          total: 1,
          messages: [{ index: 0, role: "assistant", text: content }],
        };
      return value;
    };
  }, content);
}

async function openMemory(page: Page) {
  await page.getByRole("button", { name: /^Memories/ }).click();
  await page
    .getByRole("button", { name: "Design decisions", exact: true })
    .click();
}

for (const width of [1160, 900])
  test(`Mermaid renders in the existing reader at ${width}px and preserves source and diffs`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 900 ? 640 : 800 });
    const diagramRequests: string[] = [];
    page.on("request", (request) => {
      if (/node_modules.*mermaid|\/mermaid[^/]*\.js/.test(request.url()))
        diagramRequests.push(request.url());
    });
    // Apply the native app's existing policy; no wider permissions are needed.
    await page.route("**/", async (route) => {
      if (route.request().resourceType() !== "document")
        return route.continue();
      const response = await route.fetch();
      await route.fulfill({
        response,
        headers: {
          ...response.headers(),
          "content-security-policy":
            "default-src 'self'; connect-src ipc: http://ipc.localhost; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self'",
        },
      });
    });
    await detailFixture(page);
    await expect(page.getByRole("button", { name: /^Memories/ })).toBeVisible();
    expect(diagramRequests).toEqual([]);
    const source =
      "# Architecture\n\n```mermaid\nflowchart LR\n  A[Shared context] --> B[Native tools]\n```\n\n```js\nconst unchanged = true;\n```";
    await readerContent(page, source);
    await openMemory(page);
    const diagram = page.getByRole("img", { name: "Mermaid diagram" });
    await expect(diagram.locator("svg")).toBeVisible();
    await expect(diagram).toContainText("Shared context");
    await expect(page.locator("pre code.language-js")).toHaveText(
      "const unchanged = true;\n",
    );
    expect(diagramRequests.length).toBeGreaterThan(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(page.locator(".mermaid-measure")).toHaveCount(0);
    await page.screenshot({
      path: test.info().outputPath(`mermaid-${width}.png`),
    });
    const axe = await new AxeBuilder({ page })
      .include(".resource-detail")
      .analyze();
    expect(axe.violations).toEqual([]);
    await more(page).click();
    await page
      .getByRole("button", { name: "Show Markdown", exact: true })
      .click();
    await expect(diagram).toHaveCount(0);
    await expect(page.locator("pre.content")).toHaveText([source]);
    await page
      .getByRole("button", { name: "More resource actions", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Compare with previous revision" })
      .click();
    await expect(page.getByLabel("File changes")).toHaveText([/flowchart LR/]);
    await expect(diagram).toHaveCount(0);
  });

test("session conversations render Mermaid while transcripts stay literal and lazy", async ({
  page,
}) => {
  await detailFixture(page);
  await readerContent(
    page,
    "```mermaid\nsequenceDiagram\n  User->>Orka: Read shared context\n```",
  );
  await page.getByRole("button", { name: /^Sessions/ }).click();
  await page
    .getByRole("button", { name: "Polish navigation", exact: true })
    .click();
  await expect(
    page.locator(".session-turn .mermaid-diagram svg"),
  ).toBeVisible();
  expect(
    (await calls(page, "inspect_resource")).filter(
      (args: any) => args.id === "session-c",
    ),
  ).toEqual([]);
  await page.getByRole("button", { name: "Transcript", exact: true }).click();
  await expect(page.locator(".session-view pre.content")).toHaveText([
    /Some content/,
  ]);
  await expect(page.locator(".mermaid-diagram")).toHaveCount(0);
});

test("invalid Mermaid retains readable source without leaving error DOM behind", async ({
  page,
}) => {
  await detailFixture(page);
  await readerContent(page, "```mermaid\nflowchart LR\n  A[broken\n```");
  await openMemory(page);
  await expect(page.locator(".mermaid-status")).toHaveText(
    "Diagram unavailable. Showing source.",
  );
  await expect(page.locator("pre code.language-mermaid")).toContainText(
    "A[broken",
  );
  await expect(
    page.locator(".mermaid-diagram, .mermaid-measure, body > svg"),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Open in editor", exact: true }),
  ).toBeEnabled();
});

test("synced Mermaid cannot enable HTML or interactive links through directives", async ({
  page,
}) => {
  await detailFixture(page);
  await readerContent(
    page,
    '```mermaid\n%%{init: {"securityLevel": "loose", "flowchart": {"htmlLabels": true}}}%%\nflowchart LR\n  A[Shared context] --> B[Native tools]\n  click A "https://example.com"\n```',
  );
  await openMemory(page);
  await expect(page.locator(".mermaid-diagram svg")).toBeVisible();
  await expect(
    page.locator(
      ".mermaid-diagram a, .mermaid-diagram foreignObject, .mermaid-diagram script",
    ),
  ).toHaveCount(0);
});

test("resource reads work offline and reuse the current revision on return", async ({
  page,
  context,
}) => {
  await detailFixture(page);
  await openMemory(page);
  await expect(page.locator(".resource-detail")).toContainText("Some content");
  await page
    .getByRole("button", { name: "Back to Memories", exact: true })
    .click();
  // The reader chunk is loaded; the next, uncached native read must work offline.
  await context.setOffline(true);
  await page
    .getByRole("button", { name: "Architecture notes", exact: true })
    .click();
  await expect(page.locator(".resource-detail h2").first()).toHaveText(
    "Architecture notes",
  );
  await page
    .getByRole("button", { name: "Back to Memories", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Design decisions", exact: true })
    .click();
  await expect(page.locator(".resource-detail")).toContainText("Some content");
  expect(
    (await calls(page, "inspect_resource")).filter(
      (args: any) => args.id === "memory-a",
    ),
  ).toHaveLength(1);
});

test("a new revision refreshes the open resource instead of serving the cached version", async ({
  page,
}) => {
  await page.clock.install();
  await detailFixture(page);
  await page.evaluate(() => {
    const w = window as any;
    const original = w.__TAURI_INTERNALS__.invoke;
    w.readerRevision = 1;
    w.__TAURI_INTERNALS__.invoke = async (name: string, args: any) => {
      const value = await original(name, args);
      if (name === "snapshot")
        return {
          ...value,
          resources: value.resources.map((r: any) =>
            r.resourceId === "memory-a"
              ? { ...r, revision: w.readerRevision }
              : r,
          ),
        };
      if (name === "inspect_resource" && args.id === "memory-a")
        return { ...value, content: `Version ${w.readerRevision}` };
      return value;
    };
  });
  await openMemory(page);
  // A reveal can briefly contain both panes. Check the settled document list
  // atomically so the assertion retries until one current document remains.
  await expect(
    page.getByRole("article", { name: "Rendered Markdown" }),
  ).toHaveText(["Version 1"]);
  await page.evaluate(() => {
    (window as any).readerRevision = 2;
  });
  await page.clock.runFor(3100);
  await expect(
    page.getByRole("article", { name: "Rendered Markdown" }),
  ).toHaveText(["Version 2"]);
});

for (const dimension of ["profile", "user", "service"])
  test(`resource caches are cleared across ${dimension} changes`, async ({
    page,
  }) => {
    await page.clock.install();
    await detailFixture(page);
    await page.evaluate((dimension) => {
      const w = window as any;
      const original = w.__TAURI_INTERNALS__.invoke;
      w.changedScope = false;
      w.scopedReads = 0;
      w.__TAURI_INTERNALS__.invoke = async (name: string, args: any) => {
        const value = await original(name, args);
        if (name === "snapshot" && w.changedScope) {
          if (dimension === "profile")
            return { ...value, profile: "another-profile" };
          if (dimension === "user") return { ...value, user: "another-user" };
          return {
            ...value,
            config: {
              ...value.config,
              apiUrl: "https://another-service.local",
            },
          };
        }
        if (name === "inspect_resource" && args.id === "memory-a")
          return { ...value, content: `Scoped read ${++w.scopedReads}` };
        return value;
      };
    }, dimension);
    await openMemory(page);
    await expect(
      page.getByRole("article", { name: "Rendered Markdown" }),
    ).toHaveText(["Scoped read 1"]);
    await page.evaluate(() => {
      (window as any).changedScope = true;
    });
    await page.clock.runFor(3100);
    await expect(
      page.getByRole("article", { name: "Rendered Markdown" }),
    ).toHaveText(["Scoped read 2"]);
    await page.evaluate(() => {
      (window as any).changedScope = false;
    });
    await page.clock.runFor(3100);
    await expect(
      page.getByRole("article", { name: "Rendered Markdown" }),
    ).toHaveText(["Scoped read 3"]);
  });

test("reduced motion keeps navigation aligned and Settings keyboard focus intact", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await detailFixture(page);
  const memories = page.getByRole("button", { name: /^Memories/ });
  await memories.focus();
  await page.keyboard.press("Enter");
  const highlight = page.locator(".project-section-highlight");
  await expect
    .poll(async () => {
      const [marker, row] = await Promise.all([
        highlight.boundingBox(),
        memories.boundingBox(),
      ]);
      return Math.abs(marker!.y - row!.y);
    })
    .toBeLessThan(1);
  const settings = page.getByRole("button", { name: "Settings", exact: true });
  await settings.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("region", { name: "Settings", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCSS("opacity", "1");
  expect(
    await dialog.evaluate(
      (element) =>
        element
          .getAnimations()
          .filter((animation) => animation.playState === "running").length,
    ),
  ).toBe(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(settings).toBeFocused();
});

for (const [title, label, tool] of [
  ["Polish navigation", "Codex CLI", "codex"],
  ["Shared planning", "Claude Code CLI", "claude"],
] as const) {
  test(`CLI-origin ${tool} sessions default to their original CLI`, async ({
    page,
  }) => {
    await detailFixture(page, { cliOrigin: true });
    await openSession(page, title);
    await page
      .getByRole("button", { name: `Fork and open in ${label}`, exact: true })
      .click();
    expect((await calls(page, "resume_session")).at(-1)).toEqual({
      id: tool === "codex" ? "session-c" : "session-m",
      tool,
      destination: "terminal",
    });
    await page
      .getByRole("button", { name: "Choose how to open session" })
      .click();
    await expect(page.getByRole("menuitem").first()).toContainText(
      `Fork in ${label}New fork in TerminalDefault`,
    );
  });
}

test("cross-provider CLI continuation names immediate startup and uses the selected terminal", async ({
  page,
}) => {
  await detailFixture(page);
  await openSession(page);
  await page
    .getByRole("button", { name: "Choose how to open session" })
    .click();
  await chooseTerminal(page, "Warp");
  const cli = page.getByRole("menuitem", {
    name: /^Continue in Claude Code CLI/,
  });
  await expect(cli).toContainText("Starts immediately in Warp with context");
  await cli.click();
  expect((await calls(page, "resume_session")).at(-1)).toEqual({
    id: "session-c",
    tool: "claude",
    destination: "warp",
  });
});

test("copy session prompt works without apps or a connected folder and confirms inline", async ({
  page,
}) => {
  await detailFixture(page, { noApps: true, disconnected: true });
  await openSession(page);
  await page
    .getByRole("button", { name: "Choose how to open session" })
    .click();
  const copy = page.getByRole("menuitem", {
    name: /Copy session prompt/,
  });
  const before = await copy.evaluate((element) => element.clientWidth);
  await copy.click();
  await expect(copy).toHaveAttribute("data-copied", "true");
  expect(await page.evaluate(() => (window as any).copiedText)).toContain(
    "Original request",
  );
  expect(await page.evaluate(() => (window as any).copiedText)).toContain(
    "Complete answer",
  );
  await expect(page.getByRole("menu", { name: "Open session" })).toBeVisible();
  expect(await copy.evaluate((element) => element.clientWidth)).toBe(before);
  expect(
    (await new AxeBuilder({ page }).include('[role="menu"]').analyze())
      .violations,
  ).toEqual([]);
  expect(await calls(page, "resume_session")).toEqual([]);
});

for (const failure of ["history", "clipboard"] as const) {
  test(`copy session prompt reports ${failure} failure without copied feedback`, async ({
    page,
  }) => {
    await detailFixture(page, { promptError: failure === "history" });
    if (failure === "clipboard")
      await page.evaluate(() =>
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            writeText: async () => {
              throw new Error("Clipboard denied");
            },
          },
        }),
      );
    await openSession(page);
    await page
      .getByRole("button", { name: "Choose how to open session" })
      .click();
    const copy = page.getByRole("menuitem", {
      name: "Copy session prompt",
      exact: true,
    });
    await copy.click();
    await expect(copy).toHaveAttribute("data-copied", "false");
    await expect(page.locator(".session-launcher-copy-error")).toContainText(
      "Couldn’t copy session prompt",
    );
  });
}

test("a late prompt cannot copy context after selecting another session", async ({
  page,
}) => {
  await detailFixture(page);
  await page.evaluate(() => {
    const w = window as any;
    const original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (name: string, args: unknown) => {
      const result = await original(name, args);
      if (name === "session_handoff_prompt")
        await new Promise<void>((resolve) => {
          w.finishPrompt = resolve;
        });
      return result;
    };
  });
  await openSession(page);
  await page
    .getByRole("button", { name: "Choose how to open session" })
    .click();
  await page
    .getByRole("menuitem", { name: "Copy session prompt", exact: true })
    .click();
  await expect
    .poll(() => calls(page, "session_handoff_prompt"))
    .toHaveLength(1);
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Back to Sessions", exact: true })
    .click();
  await openSession(page, "Shared planning");
  await page.evaluate(() => (window as any).finishPrompt());
  await expect(
    page.getByRole("button", {
      name: "Fork and open in Claude Desktop",
      exact: true,
    }),
  ).toBeEnabled();
  expect(await page.evaluate(() => (window as any).copiedText)).toBeUndefined();
});
