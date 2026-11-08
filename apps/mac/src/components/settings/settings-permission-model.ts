import {
  categoryAccess,
  roleCategories as categories,
  defaultRolePolicies as defaultPolicies,
  type CategoryAccess as Access,
  type RolePolicies,
} from "@portable/protocol";

export { categories, defaultPolicies };
export type { Access, RolePolicies };
export type Category = (typeof categories)[number];
const accessLabels: Record<Access, string> = {
  none: "No access",
  read: "Read only",
  add: "Add only",
  write: "Read and write",
};
export const accessOptions = categoryAccess.options.map((value) => ({
  value,
  label: accessLabels[value],
}));
export const categoryNames: Record<Category, string> = {
  memory: "Memories",
  session: "Sessions",
  plan: "Plans",
  skill: "Skills",
};
export interface PolicySubmission {
  operationId: string;
  expectedPolicyRevision: number;
  policies: RolePolicies;
  migrationHash?: string;
}
export interface PolicyDraft {
  baseline: RolePolicies;
  draft: RolePolicies;
  revision: number;
  submission?: PolicySubmission;
  needsReview?: boolean;
}
export const permissionDrafts = new Map<string, PolicyDraft>();
export const clearPermissionDrafts = () => permissionDrafts.clear();

/** Rebase only edits the person actually made. Conflicting cells require a choice. */
export function policyComparison(
  baseline: RolePolicies,
  draft: RolePolicies,
  latest: RolePolicies,
) {
  return (["admin", "member"] as const).flatMap((role) =>
    categories.map((category) => ({
      role,
      category,
      before: baseline[role][category],
      draft: draft[role][category],
      latest: latest[role][category],
      edited: draft[role][category] !== baseline[role][category],
      conflict:
        draft[role][category] !== baseline[role][category] &&
        latest[role][category] !== baseline[role][category] &&
        draft[role][category] !== latest[role][category],
    })),
  );
}
