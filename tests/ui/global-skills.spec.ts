import { test, expect, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

async function fixture(page: Page, mode = "normal") {
  await page.addInitScript((mode) => {
    const calls: { name: string; args?: Record<string, unknown> }[] = [];
    let scanCount = 0;
    let usageCount = 0;
    let projectUsageCount = 0;
    let added = false;
    let published = false;
    const imported = {
      resourceId: "codex",
      projectId: "one",
      kind: "skill",
      source: "shared",
      title: "review",
      logicalPath: "review",
      revision: 0,
      global: true,
      deleted: false,
      owner: "user",
      updatedBy: "user",
      updatedAt: "2026-10-21T00:00:00Z",
      files: [
        { path: "SKILL.md", hash: "codex", size: 100, executable: false },
      ],
    };
    const skills = [
      {
        id: "codex",
        name: "review",
        sources: ["codex"],
        markdown:
          "---\nname: Code review\ndescription: Review changes with supporting scripts and references.\n---\n# Review",
        fileCount: 3,
      },
      {
        id: "claude",
        name: "writing",
        sources: ["claude"],
        markdown:
          "---\nname: Writing guide\ndescription: Write clear product copy.\n---\n# Writing",
        fileCount: 1,
      },
      {
        id: "duplicate",
        name: "existing",
        sources: ["codex", "claude"],
        markdown: "# Existing skill",
        fileCount: 1,
        exists: true,
      },
      {
        id: "unsafe",
        name: "unsafe",
        sources: ["claude"],
        markdown: "",
        fileCount: 0,
        error: "Package contains symlink",
      },
      ...Array.from({ length: 20 }, (_, i) => ({
        id: `extra-${i}`,
        name: `extra-${i}`,
        sources: ["codex"],
        markdown: `---\nname: Extra skill ${i}\n---\n# Extra`,
        fileCount: 1,
      })),
    ].map((skill) => ({
      exists: false,
      error: null,
      ...skill,
      path: `/Users/test/.${skill.sources[0]}/skills/${skill.name}`,
    }));
    Object.assign(window, {
      invokeCalls: calls,
      isTauri: true,
      publishSkill: () => {
        published = true;
      },
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        unregisterCallback: () => {},
        invoke: async (name: string, args?: Record<string, unknown>) => {
          calls.push({ name, args });
          if (name === "snapshot")
            return {
              user: "user",
              config: { apiUrl: "https://test.local", syncMinutes: 15 },
              projects: [
                {
                  id: "one",
                  name: "Orka",
                  path: mode === "disconnected" ? null : "/test/orka",
                  role: "owner",
                  governed: mode === "governed" || mode === "approval",
                  ...(mode === "repositories"
                    ? {
                        sources: [
                          {
                            id: "desktop",
                            name: "desktop",
                            path: "/test/desktop",
                          },
                          {
                            id: "backend",
                            name: "backend",
                            path: "/test/backend",
                          },
                        ],
                      }
                    : {}),
                },
                ...(mode === "project-scope"
                  ? [
                      {
                        id: "two",
                        name: "Studio",
                        path: "/test/studio",
                        role: "owner",
                      },
                    ]
                  : []),
              ],
              resources:
                mode === "populated" || mode.startsWith("project-")
                  ? skills
                      .map((skill) => ({
                        resourceId: skill.id,
                        projectId: "one",
                        kind: "skill",
                        source: skill.sources[0],
                        title: skill.name,
                        logicalPath: skill.name,
                        revision: 1,
                        deleted: false,
                        owner: "user",
                        updatedBy: "user",
                        updatedAt: "2026-10-21T00:00:00Z",
                        files: [
                          {
                            path: "SKILL.md",
                            hash: skill.id,
                            size: 100,
                            executable: false,
                          },
                        ],
                      }))
                      .flatMap((skill) =>
                        mode === "project-scope"
                          ? [
                              skill,
                              {
                                ...skill,
                                projectId: "two",
                                resourceId: `two-${skill.resourceId}`,
                              },
                            ]
                          : [skill],
                      )
                  : mode === "local-deleted"
                    ? [{ ...imported, revision: 10, deleted: true, files: [] }]
                    : published
                      ? [{ ...imported, revision: 1 }]
                      : [],
              localSkills:
                (mode === "governed" && added) ||
                mode === "local" ||
                mode === "local-deleted" ||
                ["approval", "paused", "blocked"].includes(mode)
                  ? [
                      {
                        ...imported,
                        local: true,
                        sharing:
                          mode === "governed"
                            ? "queued"
                            : ["approval", "paused", "blocked"].includes(mode)
                              ? mode
                              : undefined,
                      },
                    ]
                  : [],
              drafts:
                mode === "governed" && added
                  ? [
                      {
                        id: "automatic-draft",
                        projectId: "one",
                        resource: imported,
                        status: "local",
                        automaticSharing: true,
                        createdAt: imported.updatedAt,
                      },
                    ]
                  : [],
              bindings: [],
              conflicts: [],
              activity: [],
              outbox: [],
              errors: [],
              sync: { online: false },
              daemon: { running: false },
              devices: [],
              deviceId: "device",
              background: false,
            };
          if (name === "scan_global_skills") {
            scanCount += 1;
            if (mode === "retry" && scanCount === 1)
              throw "Folder access failed";
            if (mode === "loading" && scanCount === 1)
              await new Promise<void>((resolve) => {
                (window as any).finishSkillScan = resolve;
              });
            if (mode === "held-scan")
              await new Promise<void>((resolve) => {
                (window as any).finishSkillScan = resolve;
              });
            return {
              skills:
                mode === "empty"
                  ? []
                  : skills.map((skill) => ({
                      ...skill,
                      exists: skill.exists || (added && skill.id === "codex"),
                    })),
              errors:
                mode === "partial"
                  ? [
                      "Cannot scan /Users/test/.claude/skills: permission denied",
                    ]
                  : [],
            };
          }
          if (name === "global_skill_usage") {
            usageCount += 1;
            const usage = {
              counts: Object.fromEntries(
                skills.map((skill) => [
                  skill.id,
                  skill.id === "claude" ? 12 : skill.id === "codex" ? 8 : 0,
                ]),
              ),
              partial: mode === "usage-partial",
            };
            if (mode === "usage-error" && usageCount === 1)
              throw "History unreadable";
            if (mode === "usage-loading")
              return new Promise((resolve) => {
                (window as any).resolveSkillUsage = () => resolve(usage);
              });
            return usage;
          }
          if (name === "project_skill_usage") {
            projectUsageCount += 1;
            const second = args?.projectId === "two";
            const usage = {
              counts: Object.fromEntries(
                skills.map((skill) => [
                  `${second ? "two-" : ""}${skill.id}`,
                  second
                    ? 2
                    : skill.id === "claude"
                      ? 12
                      : skill.id === "codex"
                        ? 8
                        : 0,
                ]),
              ),
              partial: mode === "project-partial",
            };
            if (mode === "project-error" && projectUsageCount === 1)
              throw "History unreadable";
            if (
              (mode === "project-loading" || mode === "project-scope") &&
              !second
            )
              return new Promise((resolve) => {
                (window as any).resolveProjectUsage = () => resolve(usage);
              });
            return usage;
          }
          if (name === "add_global_skill") {
            if (mode === "add-error") throw "Project folder is unavailable";
            if (mode === "add-wait")
              await new Promise<void>((resolve) => {
                (window as any).finishSkillImport = resolve;
              });
            await new Promise((resolve) => setTimeout(resolve, 100));
            added = true;
            return {
              resourceId: "imported",
              status: "queued",
            };
          }
          if (name === "add_global_skills") {
            if (mode === "add-wait")
              await new Promise<void>((resolve) => {
                (window as any).finishSkillImport = resolve;
              });
            added = true;
            return {
              results: (args?.skillIds as string[]).map((skillId) =>
                mode === "bulk-partial" && skillId === "claude"
                  ? { skillId, error: "Folder changed; scan again" }
                  : { skillId, result: { status: "queued" } },
              ),
            };
          }
          if (name === "inspect_resource")
            return {
              content:
                skills.find((skill) => skill.id === args?.id)?.markdown ??
                "# Skill",
              previous: null,
              paths: [],
            };
          if (name === "governance_command")
            return {
              owner: true,
              governed: true,
              policyRevision: 1,
              policy: {},
              access: {},
              members: [],
              memberRules: [],
              resourceCount: 0,
              requests: [],
            };
          if (name.startsWith("plugin:")) return null;
          return {};
        },
      },
    });
  }, mode);
  await page.goto("/");
  await page.getByRole("button", { name: /^Skills/ }).click();
}

for (const viewport of [
  { width: 1160, height: 800 },
  { width: 900, height: 640 },
]) {
  test(`floating skill import and accessible picker at ${viewport.width}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await fixture(page);
    const trigger = page.getByRole("button", {
      name: "Add global skills",
      exact: true,
    });
    await expect(trigger).toBeVisible();
    await expect(trigger).toHaveText("Add Global Skills");
    const before = await trigger.boundingBox();
    expect(before!.height).toBe(40);
    expect(before!.width).toBeGreaterThan(before!.height * 2);
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Add global skills" });
    await expect(
      dialog.getByRole("heading", { name: "Code review" }),
    ).toBeVisible();
    await expect(dialog).toHaveCSS("opacity", "1");
    await expect(
      dialog
        .getByRole("list", { name: "Global skills", exact: true })
        .getByText("3 files", { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Already in project: existing" }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole("button", { name: "Add to project: unsafe" }),
    ).toBeDisabled();
    const box = await dialog.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
    const sort = dialog.getByRole("button", {
      name: "Sort global skills Most used",
      exact: true,
    });
    const refresh = dialog.getByRole("button", {
      name: "Scan again",
      exact: true,
    });
    const search = dialog.locator(".ui-field__control");
    const [sortBox, refreshBox, searchBox] = await Promise.all([
      sort.boundingBox(),
      refresh.boundingBox(),
      search.boundingBox(),
    ]);
    expect(sortBox!.height).toBe(40);
    expect(sortBox!.height).toBe(refreshBox!.height);
    expect(sortBox!.height).toBe(searchBox!.height);
    expect(sortBox!.y).toBe(refreshBox!.y);
    expect(sortBox!.y).toBe(searchBox!.y);
    await sort.click();
    const menu = page.getByRole("menu", {
      name: "Sort global skills",
      exact: true,
    });
    await expect(menu).toBeVisible();
    await expect(page.locator(".index-sort-menu")).toHaveCSS("opacity", "1");
    await expect(
      menu.getByRole("menuitemradio", { name: "Most used", exact: true }),
    ).toHaveAttribute("aria-checked", "true");
    await expect(
      menu.getByRole("menuitemradio", { name: "Name", exact: true }),
    ).toBeVisible();
    expect(
      (await new AxeBuilder({ page }).include(".index-sort-menu").analyze())
        .violations,
    ).toEqual([]);
    await page.screenshot({
      path: `artifacts/global-skills-sort-${viewport.width}.png`,
    });
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(sort).toBeFocused();
    expect(
      (await new AxeBuilder({ page }).include('[role="dialog"]').analyze())
        .violations,
    ).toEqual([]);
    await dialog.getByRole("searchbox").fill("claude");
    await expect(
      dialog.getByRole("heading", { name: "Writing guide" }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("heading", { name: "Code review" }),
    ).toHaveCount(0);
    await dialog.getByRole("searchbox").fill("scripts");
    await expect(
      dialog.getByRole("heading", { name: "Code review" }),
    ).toBeVisible();
    await dialog
      .getByRole("button", { name: "Add to project: Code review" })
      .click();
    await expect(
      dialog.getByRole("button", { name: "Added: Code review" }),
    ).toBeDisabled();
    await expect(
      dialog.getByText(
        "Code review added. Sharing queued; approval is requested only if permissions require it.",
      ),
    ).toBeVisible();
    expect(
      await page.evaluate(() =>
        (window as any).invokeCalls.filter(
          (c: any) => c.name === "add_global_skill",
        ),
      ),
    ).toEqual([
      {
        name: "add_global_skill",
        args: { projectId: "one", skillId: "codex" },
      },
    ]);
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await expect(trigger).toBeFocused();
    expect(await trigger.boundingBox()).toEqual(before);
    await page.screenshot({
      path: `artifacts/global-skills-index-${viewport.width}.png`,
    });
    await trigger.click();
    await expect(
      dialog.getByRole("heading", { name: "Code review" }),
    ).toBeVisible();
    await expect(dialog).toHaveCSS("opacity", "1");
    await page.screenshot({
      path: `artifacts/global-skills-picker-${viewport.width}.png`,
    });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
}

test("scan errors can be retried and partial results keep healthy skills usable", async ({
  page,
}) => {
  await fixture(page, "retry");
  await page
    .getByRole("button", { name: "Add global skills", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Couldn’t scan global skills",
  );
  await page.getByRole("button", { name: "Scan again" }).click();
  await expect(
    page.getByRole("heading", { name: "Code review" }),
  ).toBeVisible();
  await fixture(page, "partial");
  await page
    .getByRole("button", { name: "Add global skills", exact: true })
    .click();
  await expect(page.getByText(/Cannot scan.*permission denied/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add to project: Code review" }),
  ).toBeEnabled();
});

for (const viewport of [
  { width: 1160, height: 800 },
  { width: 900, height: 640 },
]) {
  test(`local skill imports appear immediately and open before sharing at ${viewport.width}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await fixture(page, "governed");
    await page
      .getByRole("button", { name: "Add global skills", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Add to project: Code review", exact: true })
      .click();
    await expect(
      page.getByText(/Code review added. Sharing queued/),
    ).toBeVisible();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    const card = page.locator(".skill-card");
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("Code review");
    await expect(card).toContainText("Sharing queued");
    await expect(card.locator(".skill-origin-badge")).toHaveText("Global");
    await expect(card).toContainText("Detected in 8 chats");
    await expect(page.getByRole("button", { name: /^Skills/ })).toContainText(
      "1",
    );
    expect(
      (await new AxeBuilder({ page }).include(".resource-index").analyze())
        .violations,
    ).toEqual([]);
    await page.screenshot({
      path: `artifacts/local-skills-${viewport.width}.png`,
    });
    await card.click();
    await expect(
      page.getByRole("heading", { name: "Code review", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".detail-facts .skill-origin-badge")).toHaveText(
      "Global",
    );
    await expect(
      page.getByText(
        "This skill will share automatically when permissions allow. Sync retries while offline.",
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("article", { name: "Rendered Markdown" }),
    ).toContainText("Review");
    await expect(
      page.getByRole("button", { name: "Open in editor", exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "Review changes", exact: true }),
    ).toHaveCount(0);
    await page.evaluate(() => (window as any).publishSkill());
    await expect(
      page.getByText(
        "This skill will share automatically when permissions allow. Sync retries while offline.",
      ),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Back to Skills", exact: true })
      .click();
    await expect(card).toHaveCount(1);
    await expect(card).not.toContainText("Sharing queued");
    await expect(card.locator(".skill-origin-badge")).toHaveText("Global");
    expect(
      await page.evaluate(() =>
        (window as any).invokeCalls.filter(
          (call: any) =>
            call.name === "governance_command" &&
            ["submit-draft", "decide"].includes(call.args?.action),
        ),
      ),
    ).toHaveLength(0);
  });
}

test("local-only skills stay visible and a shared revision replaces the local card", async ({
  page,
}) => {
  await fixture(page, "local");
  const cards = page.locator(".skill-card");
  await expect(cards).toHaveCount(1);
  await expect(cards).toContainText("On this Mac");
  await cards.click();
  await expect(
    page.getByText("This skill is on this Mac and hasn’t been shared."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Review changes", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Back to Skills", exact: true })
    .click();
  await page.evaluate(() => (window as any).publishSkill());
  await expect(cards).toHaveCount(1);
  await expect(cards).not.toContainText("On this Mac");
  await expect(cards.locator(".skill-origin-badge")).toHaveText("Global");
});

test("a new local import remains visible over an older shared deletion", async ({
  page,
}) => {
  await fixture(page, "local-deleted");
  const card = page.locator(".skill-card");
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("Code review");
  await expect(card).toContainText("On this Mac");
  await expect(card.locator(".skill-origin-badge")).toHaveText("Global");
  await card.click();
  await expect(
    page.getByRole("article", { name: "Rendered Markdown" }),
  ).toContainText("Review");
});

test("disconnected projects scan but cannot add; empty and filtered empty scans stay clear", async ({
  page,
}) => {
  await fixture(page, "disconnected");
  await page
    .getByRole("button", { name: "Add global skills", exact: true })
    .click();
  await expect(
    page.getByText("Connect a project folder to add skills."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add to project: Code review" }),
  ).toBeDisabled();
  await page.getByRole("searchbox").fill("no such skill");
  await expect(page.getByText("No skills match your search.")).toBeVisible();
  await fixture(page, "empty");
  await page
    .getByRole("button", { name: "Add global skills", exact: true })
    .click();
  await expect(
    page.getByText("No global skills found in Codex or Claude."),
  ).toBeVisible();
});

test("failed adds retain the picker and remain retryable", async ({ page }) => {
  await fixture(page, "add-error");
  await page
    .getByRole("button", { name: "Add global skills", exact: true })
    .click();
  const add = page.getByRole("button", { name: "Add to project: Code review" });
  await add.click();
  await expect(page.getByRole("alert")).toContainText(
    "Project folder is unavailable",
  );
  await expect(add).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Added: Code review" }),
  ).toHaveCount(0);
});

test("skill imports explain the sync wait and finish the original request once", async ({
  page,
}) => {
  await fixture(page, "add-wait");
  await page
    .getByRole("button", { name: "Add global skills", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Add global skills",
    exact: true,
  });
  await dialog
    .getByRole("button", { name: "Add to project: Code review", exact: true })
    .click();
  await expect(
    dialog.getByText(
      "Adding Code review… This can wait for an active sync to finish.",
    ),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Close global skills", exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("button", {
      name: "Add to project: Code review",
      exact: true,
    }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await page.evaluate(() => (window as any).finishSkillImport());
  await expect(
    dialog.getByRole("button", { name: "Added: Code review", exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByText(
      "Adding Code review… This can wait for an active sync to finish.",
    ),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Close global skills", exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(() =>
      (window as any).invokeCalls.filter(
        (call: any) => call.name === "add_global_skill",
      ),
    ),
  ).toHaveLength(1);
});

test("the floating action stays pinned while the Skills collection scrolls", async ({
  page,
}) => {
  await fixture(page, "populated");
  const trigger = page.getByRole("button", {
    name: "Add global skills",
    exact: true,
  });
  await expect(page.locator(".skill-card")).toHaveCount(24);
  const before = await trigger.boundingBox();
  const list = page.locator(".resource-index-body");
  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  expect(await list.evaluate((element) => element.scrollTop)).toBeGreaterThan(
    0,
  );
  expect(await trigger.boundingBox()).toEqual(before);
  await trigger.click();
  await expect(
    page.getByRole("heading", { name: "Code review" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: /^Memories/ }).click();
  await expect(trigger).toHaveCount(0);
});

test("a loading scan can be closed and reopening starts a fresh scan", async ({
  page,
}) => {
  await fixture(page, "loading");
  const trigger = page.getByRole("button", {
    name: "Add global skills",
    exact: true,
  });
  await trigger.click();
  await expect(
    page.getByText("Scanning Codex and Claude global skills…"),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(
    page.getByRole("heading", { name: "Code review" }),
  ).toBeVisible();
  await page.evaluate(() => (window as any).finishSkillScan());
  expect(
    await page.evaluate(() =>
      (window as any).invokeCalls.filter(
        (c: any) => c.name === "add_global_skill",
      ),
    ),
  ).toHaveLength(0);
});

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`initial skill skeletons are inert and rescans retain content with ${reducedMotion} motion`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion });
    await page.setViewportSize({ width: 900, height: 640 });
    await fixture(page, "held-scan");
    await page
      .getByRole("button", { name: "Add global skills", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Add global skills" });
    const region = dialog.locator(".loading-region");
    await expect(region).toHaveAttribute("aria-busy", "true");
    await expect(
      dialog.getByRole("heading", { name: "Project review" }),
    ).toHaveCount(0);
    await expect(
      dialog.getByRole("list", { name: "Global skills" }),
    ).toHaveCount(0);
    await expect(
      dialog.getByRole("button", { name: "Close global skills" }),
    ).toBeEnabled();
    expect((await region.boundingBox())!.height).toBeGreaterThan(200);
    expect(
      (await new AxeBuilder({ page }).include(".global-skills-modal").analyze())
        .violations,
    ).toEqual([]);
    await page.screenshot({
      path: `artifacts/skill-loading-${reducedMotion}.png`,
    });
    await page.evaluate(() => (window as any).finishSkillScan());
    const heading = dialog.getByRole("heading", { name: "Code review" });
    await expect(heading).toBeVisible();
    await expect(region).not.toHaveAttribute("aria-busy", "true");
    const before = await heading.boundingBox();
    await dialog
      .getByRole("button", { name: "Scan again", exact: true })
      .click();
    await expect(dialog.locator(".global-skills-list")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    await expect(heading).toBeVisible();
    expect(await heading.boundingBox()).toEqual(before);
    await expect(region).not.toHaveAttribute("aria-busy", "true");
    await page.evaluate(() => (window as any).finishSkillScan());
    await expect(dialog.locator(".global-skills-list")).toHaveAttribute(
      "aria-busy",
      "false",
    );
  });
}

test("review is available only when permissions require approval", async ({
  page,
}) => {
  await fixture(page, "approval");
  const card = page.locator(".skill-card");
  await expect(card).toContainText("Awaiting approval");
  await card.click();
  await expect(
    page.getByText(
      "Project permissions require approval before this skill can be shared.",
    ),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Pending reviews", exact: true }),
  ).toBeVisible();
});

for (const mode of ["paused", "blocked"]) {
  test(`import sharing ${mode} has clear status`, async ({ page }) => {
    await fixture(page, mode);
    await expect(page.locator(".skill-card")).toContainText(
      mode === "paused" ? "Sharing paused" : "Sharing blocked",
    );
    await page.locator(".skill-card").click();
    await expect(
      page.getByText(
        mode === "paused"
          ? "Skills sharing is off on this Mac. The import will resume when sharing is enabled."
          : "This skill is on this Mac. Check the sync issue before retrying sharing.",
      ),
    ).toBeVisible();
  });
}

test("global skills rank by recorded usage and can be sorted by name", async ({
  page,
}) => {
  await fixture(page);
  await page
    .getByRole("button", { name: "Add global skills", exact: true })
    .click();
  await expect(page.getByText("Detected in 12 chats")).toBeVisible();
  const names = page.locator(".global-skill-row h3");
  await expect(names.first()).toHaveText("Writing guide");
  await page
    .getByRole("button", { name: "Sort global skills Most used", exact: true })
    .click();
  const menu = page.getByRole("menu", {
    name: "Sort global skills",
    exact: true,
  });
  await expect(
    menu.getByRole("menuitemradio", { name: "Most used", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    menu.getByRole("menuitemradio", { name: "Name", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Sort global skills Name", exact: true }),
  ).toBeFocused();
  await expect(names.first()).toHaveText("Code review");
  await page.getByRole("searchbox").fill("writing");
  await expect(names).toHaveCount(1);
  await expect(page.getByText("Detected in 12 chats")).toBeVisible();
});

test("skill imports stay usable while usage loads and unavailable usage can be retried", async ({
  page,
}) => {
  await fixture(page, "usage-loading");
  await page
    .getByRole("button", { name: "Add global skills", exact: true })
    .click();
  await expect(
    page.getByText("Checking usage in local chat history…"),
  ).toBeVisible();
  await expect(page.getByText("Detected in 0 chats")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Add to project: Code review" })
    .click();
  await expect(
    page.getByRole("button", { name: "Added: Code review" }),
  ).toBeDisabled();
  await page.evaluate(() => (window as any).resolveSkillUsage());
  await expect(page.getByText("Detected in 8 chats")).toBeVisible();
  await fixture(page, "usage-error");
  await page
    .getByRole("button", { name: "Add global skills", exact: true })
    .click();
  await expect(
    page.getByText("Usage unavailable. Skills can still be added."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add to project: Code review" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Retry usage" }).click();
  await expect(page.getByText("Detected in 8 chats")).toBeVisible();
});

for (const viewport of [
  { width: 1160, height: 800 },
  { width: 900, height: 640 },
]) {
  test(`main Skills show usage and preserve filters and sorting at ${viewport.width}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await fixture(page, "populated");
    const cards = page.locator(".skill-card");
    const names = cards.locator("strong");
    await expect(names.first()).toHaveText("Writing guide");
    await expect(cards.first()).toContainText("Detected in 12 chats");
    await expect(cards.nth(1)).toContainText("Detected in 8 chats");
    await expect(
      page.getByRole("button", { name: "Sort by Most used", exact: true }),
    ).toBeVisible();
    await page.getByRole("searchbox", { name: "Search skills" }).fill("review");
    await expect(names).toHaveText(["Code review"]);
    await cards.first().click();
    await page
      .getByRole("button", { name: "Back to Skills", exact: true })
      .click();
    await expect(cards.first()).toBeFocused();
    await expect(
      page.getByRole("searchbox", { name: "Search skills" }),
    ).toHaveValue("review");
    await page
      .getByRole("button", { name: "Clear search", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Sort by Most used", exact: true })
      .click();
    await page
      .getByRole("menuitemradio", { name: "Title", exact: true })
      .click();
    await expect(names.first()).toHaveText("Code review");
    await page
      .getByRole("button", { name: "Sort by Title", exact: true })
      .click();
    await page
      .getByRole("menuitemradio", { name: "Most used", exact: true })
      .click();
    const sources = page.getByRole("group", { name: "Filter by source" });
    await sources.getByRole("button", { name: "Codex", exact: true }).click();
    await expect(names.first()).toHaveText("Code review");
    await expect(cards.first()).toContainText("Detected in 8 chats");
    await sources.getByRole("button", { name: "All", exact: true }).click();
    await expect(names.first()).toHaveText("Writing guide");
    expect(
      (await new AxeBuilder({ page }).include(".resource-index").analyze())
        .violations,
    ).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      ),
    ).toBe(false);
    await page.screenshot({
      path: `artifacts/project-skill-usage-${viewport.width}.png`,
    });
    await page.getByRole("button", { name: /^Memories/ }).click();
    await page.getByRole("button", { name: /^Sessions/ }).click();
    await expect(
      page.getByRole("button", { name: "Sort by Most used", exact: true }),
    ).toHaveCount(0);
  });
}

test("main Skills remain browsable during usage loading, failures, and partial history", async ({
  page,
}) => {
  await fixture(page, "project-loading");
  await expect(page.getByText("Checking project skill usage…")).toBeVisible();
  await expect(page.locator(".skill-usage-count")).toHaveCount(0);
  await page.getByRole("searchbox", { name: "Search skills" }).fill("review");
  await expect(page.locator(".skill-card strong")).toHaveText(["Code review"]);
  await page.evaluate(() => (window as any).resolveProjectUsage());
  await expect(page.getByText("Detected in 8 chats")).toBeVisible();
  await fixture(page, "project-error");
  await expect(
    page.getByText("Skill usage unavailable. History unreadable"),
  ).toBeVisible();
  await expect(page.locator(".skill-card")).toHaveCount(24);
  await expect(page.locator(".skill-usage-count")).toHaveCount(0);
  await page.getByRole("button", { name: "Retry usage", exact: true }).click();
  await expect(page.locator(".skill-card").first()).toContainText(
    "Detected in 12 chats",
  );
  await page
    .getByRole("button", { name: "Refresh skill usage", exact: true })
    .click();
  await expect(
    page.getByText("Skill usage unavailable. History unreadable"),
  ).toHaveCount(0);
  await fixture(page, "project-partial");
  await expect(
    page.getByText(
      "Usage covers available local history; some records could not be read.",
    ),
  ).toBeVisible();
  await expect(page.locator(".skill-card").first()).toContainText(
    "Detected in 12 chats",
  );
});

test("late usage results cannot leak into another project's Skills", async ({
  page,
}) => {
  await fixture(page, "project-scope");
  await expect(page.getByText("Checking project skill usage…")).toBeVisible();
  await page.getByRole("combobox", { name: "Select project" }).click();
  await page.getByRole("option", { name: "Studio", exact: true }).click();
  await expect(page.locator(".skill-usage-count").first()).toHaveText(
    "Detected in 2 chats",
  );
  await page.evaluate(() => (window as any).resolveProjectUsage());
  await expect(page.locator(".skill-usage-count").first()).toHaveText(
    "Detected in 2 chats",
  );
  await expect(page.getByText("Detected in 12 chats")).toHaveCount(0);
});

test("bulk selection survives search and imports only eligible selected skills", async ({
  page,
}) => {
  await fixture(page);
  await page
    .getByRole("button", { name: "Add global skills", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Add global skills",
    exact: true,
  });
  await dialog
    .getByRole("checkbox", { name: "Select skill: Code review", exact: true })
    .check();
  await dialog.getByRole("searchbox").fill("Writing guide");
  await dialog
    .getByRole("checkbox", { name: "Select all visible", exact: true })
    .check();
  await expect(dialog.getByText("2 selected", { exact: true })).toBeVisible();
  await dialog.getByRole("searchbox").fill("");
  await expect(
    dialog.getByRole("checkbox", {
      name: "Select skill: existing",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("checkbox", { name: "Select skill: unsafe", exact: true }),
  ).toBeDisabled();
  expect(
    (await new AxeBuilder({ page }).include('[role="dialog"]').analyze())
      .violations,
  ).toEqual([]);
  await page.screenshot({ path: "artifacts/global-skills-bulk-selection.png" });
  await dialog
    .getByRole("button", { name: "Add selected (2)", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Added: Code review", exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: "Added: Writing guide", exact: true }),
  ).toBeDisabled();
  await expect(dialog.getByText("0 selected", { exact: true })).toBeVisible();
  const calls = await page.evaluate(() =>
    (window as any).invokeCalls.filter(
      (call: any) => call.name === "add_global_skills",
    ),
  );
  expect(calls).toHaveLength(1);
  expect(calls[0].args).toEqual({
    projectId: "one",
    skillIds: ["claude", "codex"],
  });
});

test("partial bulk failures preserve successful imports and leave failed skills selected for retry", async ({
  page,
}) => {
  await fixture(page, "bulk-partial");
  await page
    .getByRole("button", { name: "Add global skills", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Add global skills",
    exact: true,
  });
  for (const name of ["Code review", "Writing guide"])
    await dialog
      .getByRole("checkbox", { name: `Select skill: ${name}`, exact: true })
      .check();
  await dialog
    .getByRole("button", { name: "Add selected (2)", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Added: Code review", exact: true }),
  ).toBeDisabled();
  await expect(dialog.getByRole("alert")).toContainText(
    "Writing guide: Folder changed",
  );
  await expect(
    dialog.getByRole("checkbox", {
      name: "Select skill: Writing guide",
      exact: true,
    }),
  ).toBeChecked();
  await dialog
    .getByRole("button", { name: "Add selected (1)", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Added: Writing guide", exact: true }),
  ).toBeDisabled();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
});

test("bulk import locks selection and dismissal until the one batch finishes", async ({
  page,
}) => {
  await fixture(page, "add-wait");
  await page
    .getByRole("button", { name: "Add global skills", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Add global skills",
    exact: true,
  });
  await dialog.getByRole("searchbox").fill("guide");
  await dialog
    .getByRole("checkbox", { name: "Select all visible", exact: true })
    .check();
  await dialog.getByRole("searchbox").fill("review");
  await dialog
    .getByRole("checkbox", { name: "Select all visible", exact: true })
    .check();
  await dialog
    .getByRole("button", { name: "Add selected (2)", exact: true })
    .click();
  await expect(
    dialog.getByText(
      "Adding 2 skills… This can wait for an active sync to finish.",
    ),
  ).toBeVisible();
  await expect(
    dialog.getByRole("checkbox", { name: "Select all visible", exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: "Done", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await page.evaluate(() => (window as any).finishSkillImport());
  await expect(
    dialog.getByRole("button", { name: "Done", exact: true }),
  ).toBeEnabled();
});

test("changing repositories clears bulk selection and scopes installation to the chosen repository", async ({
  page,
}) => {
  await fixture(page, "repositories");
  await page
    .getByRole("button", { name: "Add global skills", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Add global skills",
    exact: true,
  });
  await dialog
    .getByRole("checkbox", { name: "Select skill: Code review", exact: true })
    .check();
  await dialog
    .getByRole("combobox", { name: "Install into repository", exact: true })
    .selectOption("backend");
  await expect(dialog.getByText("0 selected", { exact: true })).toBeVisible();
  for (const name of ["Code review", "Writing guide"])
    await dialog
      .getByRole("checkbox", { name: `Select skill: ${name}`, exact: true })
      .check();
  await dialog
    .getByRole("button", { name: "Add selected (2)", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Added: Code review", exact: true }),
  ).toBeDisabled();
  const calls = await page.evaluate(() =>
    (window as any).invokeCalls.filter(
      (call: any) => call.name === "add_global_skills",
    ),
  );
  expect(calls).toHaveLength(1);
  expect(calls[0].args).toEqual({
    projectId: "one",
    sourceId: "backend",
    skillIds: ["claude", "codex"],
  });
});
