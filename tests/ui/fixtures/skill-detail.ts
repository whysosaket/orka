import { expect, type Page } from "@playwright/test";

/**
 * One governed project with a shared, multi-file skill. Options select the
 * installation binding, local draft, cached previous version, read failures,
 * connectivity, and governance outcomes the reader and review drawer handle.
 */
export type SkillFixtureOptions = {
  localFirstApproval?: boolean;
  access?: "publish" | "suggest" | "read";
  role?: "owner" | "member";
  installation?:
    "current" | "update" | "blocked" | "modified" | "removal" | "uptodate";
  draft?: "local" | "proposed" | "stale";
  previous?: "cached" | "missing" | "equal";
  files?: string[];
  skillContent?: string;
  previousContent?: string;
  inspectFailure?: "until-recovered" | "always" | "missing";
  offline?: boolean;
  disconnected?: boolean;
  editorFailure?: boolean;
  submitFailure?: "once" | "always";
  applyFailure?: "stale" | "error";
  /** Hold apply-install until window.finishApply() runs, to show Installing. */
  applyHold?: boolean;
  /** Stay on the Skills index instead of opening the skill. */
  open?: false;
  previewFailure?: "once";
};

const sharedSkill = [
  "---",
  "name: issue-investigate-followup",
  'description: "Act on an issue-investigate report for an OpenWhispr issue: find the pull requests that already address it, judge whether each can solve the root cause, then build on the best community PR when it is even directionally right, or open a draft PR of our own only when every candidate is wrong. Plans and implements with the code-quality skill, gates every push on CI-mirror checks, tests that fail on the base and a fresh independent review, then runs pr-review-test on the pushed PR to prove the fix landed."',
  "---",
  "# Issue follow-up",
  "",
  "- Review the issue report.",
  "- Inspect related pull requests.",
  "- Identify the best candidate to build on.",
  "",
  "## Verification",
  "",
  "- Run the checks on this Mac.",
  "- Include the test evidence in the follow-up.",
  "",
].join("\n");
const previousSkill = sharedSkill
  .replace("- Review the issue report.", "- Read the issue report.")
  .replace(
    "- Run the checks on this Mac.\n",
    "- Open the report.\n- Run the checks on this Mac.\n",
  );
const localSkill = sharedSkill
  .replace(
    "- Review the issue report.",
    "- Read the issue report and confirm the root cause.",
  )
  .replace(
    "- Run the checks on this Mac.",
    "- Run the checks on every supported platform.",
  );
const sharedScript = [
  "#!/usr/bin/env bash",
  "set -euo pipefail",
  "",
  'issue="${1:?Pass an issue number}"',
  "",
  "gh pr list \\",
  '  --search "is:open ${issue}" \\',
  "  --limit 10 \\",
  "  --json number,title,url",
  "",
].join("\n");
const localScript = sharedScript.replace("--limit 10", "--limit 20");
const sharedCsv =
  "platform,check,required\nmacOS,Run the test suite,yes\nWindows,Verify the affected behavior,yes\n";

/** One governed project with a shared, multi-file skill and recorded invokes. */
export async function skillFixture(
  page: Page,
  options: SkillFixtureOptions = {},
) {
  await page.addInitScript(
    ({
      options,
      sharedSkill,
      previousSkill,
      localSkill,
      sharedScript,
      localScript,
      sharedCsv,
    }) => {
      const access = options.access ?? "publish";
      const user = "user";
      const paths = options.files ?? [
        "SKILL.md",
        "scripts/candidates.sh",
        "assets/platform-checks.csv",
        "references/review-checklist.pdf",
      ];
      const skillContent = options.skillContent ?? sharedSkill;
      const sharedFiles: Record<string, string | null> = {
        "SKILL.md": skillContent,
        "scripts/candidates.sh": sharedScript,
        "assets/platform-checks.csv": sharedCsv,
        "references/review-checklist.pdf": null,
      };
      const localFiles: Record<string, string> = {
        "SKILL.md": localSkill,
        "scripts/candidates.sh": localScript,
        "assets/platform-checks.csv": sharedCsv,
        "references/review-checklist.pdf": "Binary asset",
      };
      const skill = {
        resourceId: "skill-a",
        projectId: "one",
        kind: "skill",
        source: options.localFirstApproval ? "local" : "shared",
        local: options.localFirstApproval || undefined,
        sharing: options.localFirstApproval ? "approval" : undefined,
        logicalPath: "skills/issue-investigate-followup",
        title: "issue-investigate-followup",
        files: paths.map((path) => ({
          path,
          hash: `hash-${path}`,
          size: 10,
          executable: false,
        })),
        deleted: options.installation === "removal",
        revision: options.localFirstApproval ? 0 : 3,
        hash: "resource-hash",
        owner: user,
        updatedBy: user,
        updatedAt: "2026-10-25T17:32:00Z",
        access: {
          mode: access,
          canShare: true,
          create: access,
          governed: true,
          policyRevision: 1,
        },
      };
      const installation = options.installation ?? "current";
      const binding = {
        base: {
          ...skill,
          revision:
            installation === "update" || installation === "blocked" ? 2 : 3,
        },
        paths: ["/test/orka/.agents/skills/issue-investigate-followup"],
        installationState:
          installation === "update" ||
          installation === "removal" ||
          installation === "uptodate"
            ? "update_available"
            : installation === "blocked" || installation === "modified"
              ? "locally_modified"
              : "current",
        availableRevision: 3,
      };
      const drafts = options.draft
        ? [
            {
              id: "draft-1",
              projectId: "one",
              resource: {
                ...skill,
                deleted: false,
                files: Object.keys(localFiles).map((path) => ({
                  path,
                  hash:
                    path === "references/review-checklist.pdf"
                      ? `hash-${path}`
                      : `local-${path}`,
                  size: 12,
                  executable: false,
                })),
              },
              status: options.draft,
              createdAt: "2026-10-26T09:00:00Z",
            },
          ]
        : [];
      // Removals are reviewed from Requests; a pending request opens that page.
      const requests =
        installation === "removal"
          ? [
              {
                id: "request-1",
                projectId: "one",
                author: user,
                type: "change",
                resourceId: skill.resourceId,
                title: skill.title,
                status: "pending",
                baseRevision: 2,
                policyRevision: 1,
                previewHash: "preview-hash",
                createdAt: "2026-10-26T09:00:00Z",
              },
            ]
          : [];
      const calls: { name: string; args?: Record<string, unknown> }[] = [];
      let submitFailures = 0;
      let previewFailures = 0;
      const pendingInspect: (() => void)[] = [];
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
        finishInspect: () =>
          pendingInspect.splice(0).forEach((resolve) => resolve()),
        isTauri: true,
        __TAURI_INTERNALS__: {
          transformCallback: () => 1,
          unregisterCallback: () => {},
          invoke: async (name: string, args?: Record<string, unknown>) => {
            calls.push({ name, args });
            if (name === "snapshot")
              return {
                user,
                config: { apiUrl: "https://test.local", syncMinutes: 15 },
                projects: [
                  {
                    id: "one",
                    name: "Orka",
                    path: options.disconnected ? null : "/test/orka",
                    role: options.role ?? "owner",
                    governed: true,
                  },
                ],
                resources: options.localFirstApproval ? [] : [skill],
                localSkills: options.localFirstApproval ? [skill] : [],
                bindings: options.localFirstApproval ? [] : [binding],
                drafts,
                governance: [
                  {
                    projectId: "one",
                    catalog: { access: { skill: skill.access }, members: [] },
                  },
                ],
                conflicts: [],
                activity: [],
                outbox: [],
                errors: [],
                sync: options.offline
                  ? { online: false, error: "Service unavailable" }
                  : { online: true },
                daemon: { running: true },
                devices: [],
                deviceId: "device",
                background: true,
                reviewRequests: requests,
              };
            if (name === "inspect_resource") {
              const file = String(args?.file);
              if (!paths.includes(file) || !(file in sharedFiles))
                throw new Error("File not found");
              if (file === (window as any).failInspect)
                throw new Error("Blob unavailable");
              if (
                file === "SKILL.md" &&
                options.inspectFailure &&
                (options.inspectFailure === "always" ||
                  !(window as any).inspectRecovered)
              )
                throw new Error(
                  options.inspectFailure === "missing"
                    ? "File not found"
                    : "Blob unavailable",
                );
              if (file === (window as any).slowInspect)
                await new Promise<void>((resolve) => {
                  pendingInspect.push(resolve);
                });
              const content = sharedFiles[file];
              return {
                content,
                previous:
                  file !== "SKILL.md" || content === null
                    ? content
                    : options.previous === "missing"
                      ? null
                      : options.previous === "equal"
                        ? content
                        : (options.previousContent ?? previousSkill),
                paths: ["/test/orka/.agents/skills/issue-investigate-followup"],
              };
            }
            if (name === "open_editor") {
              if (options.editorFailure) throw new Error("File unavailable");
              return {};
            }
            if (name === "governance_command") {
              const action = args?.action;
              const input = (args?.input ?? {}) as Record<string, unknown>;
              if (action === "catalog")
                return {
                  governed: true,
                  owner: options.role !== "member",
                  policyRevision: 1,
                  policy: {},
                  access: { skill: skill.access },
                  members: [],
                  memberRules: [],
                  resourceCount: 1,
                  requests,
                };
              if (action === "draft")
                return {
                  draft: drafts[0],
                  files: localFiles,
                  manifest: drafts[0].resource.files.map((file) => ({
                    ...file,
                    binary: file.path.endsWith(".pdf"),
                  })),
                  related: [],
                };
              if (action === "submit-draft") {
                if (
                  options.submitFailure &&
                  (options.submitFailure === "always" || submitFailures++ === 0)
                )
                  throw new Error("Service unavailable");
                if (input.publishIfAllowed === true) {
                  drafts[0].status = "local";
                  Object.assign(drafts[0], { automaticSharing: true });
                  return { id: "request-1", status: "queued" };
                }
                drafts[0].status = "proposed";
                return { id: "request-1", status: "pending" };
              }
              if (action === "refresh-draft") {
                drafts[0].status = "local";
                return drafts[0];
              }
              if (action === "preview-install") {
                if (options.previewFailure && previewFailures++ === 0)
                  throw new Error("Connect this resource's repository");
                const approved: Record<string, string> = {
                  "SKILL.md": skillContent,
                  "scripts/candidates.sh": sharedScript,
                  "assets/platform-checks.csv": sharedCsv,
                  "references/review-checklist.pdf": "Binary asset",
                };
                const before =
                  installation === "uptodate"
                    ? approved
                    : installation === "blocked" || installation === "modified"
                      ? localFiles
                      : { ...approved, "SKILL.md": previousSkill };
                return {
                  token: `preview-token-${previewFailures}`,
                  revision: 3,
                  dirty:
                    installation === "blocked" || installation === "modified",
                  before,
                  after: installation === "removal" ? {} : approved,
                  beforeManifest: Object.keys(before).map((path) => ({
                    path,
                    hash: path.endsWith(".pdf")
                      ? `hash-${path}`
                      : `before-${path}`,
                    binary: path.endsWith(".pdf"),
                  })),
                  afterManifest:
                    installation === "removal"
                      ? []
                      : Object.keys(approved).map((path) => ({
                          path,
                          hash: `hash-${path}`,
                          binary: path.endsWith(".pdf"),
                        })),
                  copies: [{ path: binding.paths[0], files: before }],
                };
              }
              if (action === "apply-install") {
                if (options.applyHold)
                  await new Promise<void>((resolve) => {
                    (window as any).finishApply = resolve;
                  });
                if (options.applyFailure === "stale")
                  throw new Error(
                    "Local or shared files changed; review the update again",
                  );
                if (options.applyFailure === "error")
                  throw new Error("Disk full");
                binding.installationState = "current";
                binding.base.revision = 3;
                (input as { applied?: boolean }).applied = true;
                return { status: "current" };
              }
              return {};
            }
            if (name === "plugin:dialog|save") return "/test/export/skill.zip";
            if (name.startsWith("plugin:")) return null;
            return {};
          },
        },
      });
    },
    {
      options,
      sharedSkill,
      previousSkill,
      localSkill,
      sharedScript,
      localScript,
      sharedCsv,
    },
  );
  await page.goto("/");
  await page.getByRole("button", { name: /^Skills/ }).click();
  if (options.open === false) return;
  await page.locator(".skill-card").first().click();
  await expect(
    page.getByRole("region", { name: "Skill details" }),
  ).toBeVisible();
}

export const calls = (page: Page, name: string) =>
  page.evaluate(
    (name) =>
      (window as any).invokeCalls
        .filter((call: { name: string }) => call.name === name)
        .map((call: { args: unknown }) => call.args),
    name,
  );
export const governanceCalls = (page: Page, action: string) =>
  page.evaluate(
    (action) =>
      (window as any).invokeCalls
        .filter(
          (call: { name: string; args?: { action?: string } }) =>
            call.name === "governance_command" && call.args?.action === action,
        )
        .map((call: { args: { input: unknown } }) => call.args.input),
    action,
  );
export const detail = (page: Page) =>
  page.getByRole("region", { name: "Skill details" });
export const rail = (page: Page) =>
  page.getByRole("complementary", { name: "Skill information" });
export const toast = (page: Page) =>
  page.locator("[data-orka-toast]").getByRole("status");
