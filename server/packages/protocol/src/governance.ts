import { z } from "zod";

export const accessMode = z.enum(["hidden", "read", "suggest", "publish"]);
export type AccessMode = z.infer<typeof accessMode>;
export const accessRank: Record<AccessMode, number> = {
  hidden: 0,
  read: 1,
  suggest: 2,
  publish: 3,
};
export const policyClasses = [
  "instructions",
  "memory",
  "skill",
  "plan",
  "session",
  "env",
] as const;
export const policyClassSchema = z.enum(policyClasses);
export type PolicyClass = z.infer<typeof policyClassSchema>;
export function policyClass(resource: {
  kind: string;
  source?: string;
  logicalPath?: string;
}): PolicyClass {
  return resource.kind === "memory" &&
    resource.source === "shared" &&
    resource.logicalPath?.startsWith("instructions/")
    ? "instructions"
    : policyClassSchema.parse(resource.kind);
}
export const accessRule = z
  .object({ mode: accessMode, canShare: z.boolean().default(false) })
  .strict();
export type AccessRule = z.infer<typeof accessRule>;
export const classRule = accessRule
  .extend({ create: accessMode.exclude(["read"]) })
  .strict();
export type ClassRule = z.infer<typeof classRule>;
export const projectRules = z
  .object({
    instructions: classRule,
    memory: classRule,
    skill: classRule,
    plan: classRule,
    session: classRule,
    env: classRule,
  })
  .strict();
export type ProjectRules = z.infer<typeof projectRules>;
export const defaultProjectRules: ProjectRules = {
  instructions: { mode: "publish", canShare: false, create: "publish" },
  memory: { mode: "publish", canShare: false, create: "publish" },
  skill: { mode: "publish", canShare: false, create: "publish" },
  plan: { mode: "publish", canShare: false, create: "publish" },
  session: { mode: "publish", canShare: false, create: "publish" },
  env: { mode: "read", canShare: false, create: "suggest" },
};
export type EffectiveAccess = AccessRule & {
  create: AccessMode;
  governed: boolean;
  policyRevision: number;
};
export const memoryMetadata = z
  .object({
    topic: z.string().trim().min(1).max(160),
    scope: z
      .string()
      .max(512)
      .refine(
        (p) =>
          p === "" ||
          (!p.startsWith("/") &&
            !p.includes("\\") &&
            !Array.from(p).some(
              (c) =>
                c.charCodeAt(0) < 32 ||
                (c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159),
            ) &&
            p.split("/").every((v) => v !== "" && v !== "." && v !== "..")),
      ),
    provider: z.enum(["codex", "claude", "manual"]),
    supersedes: z.array(z.uuid()).max(20).default([]),
  })
  .strict();
export type MemoryMetadata = z.infer<typeof memoryMetadata>;
export type ReviewRequest = {
  id: string;
  projectId: string;
  author: string;
  type: "change" | "access";
  resourceId: string;
  title: string;
  status: "pending" | "approved" | "rejected" | "stale";
  baseRevision: number;
  policyRevision: number;
  previewHash: string;
  requestedMode?: AccessMode;
  requestedClass?: PolicyClass;
  createdAt: string;
  reviewer?: string;
  canReview?: boolean;
  unread?: boolean;
};
export type InstallationState =
  | "current"
  | "update_available"
  | "locally_modified"
  | "review_pending"
  | "access_removed";

export type ManagementLog = {
  id: string;
  at: string;
  actor?: string;
  actorName: string;
  subject?: string;
  subjectName?: string;
  action:
    | "project.remote_set"
    | "project.created"
    | "project.source_removed"
    | "invite.created"
    | "member.joined"
    | "member.removed"
    | "permissions.enabled"
    | "permissions.updated"
    | "permissions.reset"
    | "permissions.sharing_locked"
    | "access.granted"
    | "env.replaced"
    | "request.created"
    | "request.approved"
    | "request.rejected"
    | "request.stale"
    | "request.recorded";
  requestId?: string;
  sourceId?: string;
  requestType?: "change" | "access";
  status?: ReviewRequest["status"];
  category?: PolicyClass;
  mode?: AccessMode;
  canAdd?: boolean;
};
