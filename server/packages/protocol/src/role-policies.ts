import { z } from "zod";

export const categoryAccess = z.enum(["none", "read", "add", "write"]);
export const roleCategories = ["memory", "session", "plan", "skill"] as const;
export const categoryPolicy = z
  .object({
    memory: categoryAccess,
    session: categoryAccess,
    plan: categoryAccess,
    skill: categoryAccess,
  })
  .strict();
export const rolePolicies = z
  .object({
    admin: categoryPolicy,
    member: categoryPolicy,
  })
  .strict();
export type RolePolicies = z.infer<typeof rolePolicies>;
export type CategoryAccess = z.infer<typeof categoryAccess>;
export const defaultRolePolicies: RolePolicies = {
  admin: { memory: "write", session: "write", plan: "write", skill: "write" },
  member: { memory: "read", session: "read", plan: "write", skill: "write" },
};
