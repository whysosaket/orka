import { displayText } from "./resource-presentation.js";
import { invoke } from "@tauri-apps/api/core";
import { ENV_ENABLED } from "../lib/features.js";
import type { FileManifestEntry } from "./diff-model.js";
import type { ProjectMember } from "../types.js";
import type {
  AccessMode,
  AccessRule,
  ClassRule,
  EffectiveAccess,
  ProjectRules,
  ReviewRequest,
  RolePolicies,
} from "@portable/protocol";

export interface GovernanceCatalog {
  role?: "owner" | "admin" | "member";
  rolePolicies?: RolePolicies | null;
  governed: boolean;
  owner: boolean;
  policyRevision: number;
  policy: ProjectRules;
  access: Record<string, EffectiveAccess>;
  members: ProjectMember[];
  memberRules: { userId: string; class: keyof ProjectRules; rule: ClassRule }[];
  resourceRules?: { resourceId: string; userId: string; rule: AccessRule }[];
  resourceCount: number;
  requests: ReviewRequest[];
  envSets?: { resourceId: string; title: string }[];
}
export interface InstallPreview {
  token: string;
  revision: number;
  dirty: boolean;
  before: Record<string, string>;
  after: Record<string, string>;
  beforeManifest?: FileManifestEntry[];
  afterManifest?: FileManifestEntry[];
  copies?: { path: string; files: Record<string, string> }[];
}
export type ProjectCall = <T>(
  action: string,
  input?: Record<string, unknown>,
) => Promise<T>;
export const governanceCall = <T>(
  action: string,
  input: Record<string, unknown>,
) => invoke<T>("governance_command", { action, input });
export const accessModes: AccessMode[] = [
  "hidden",
  "read",
  "suggest",
  "publish",
];
export const accessNames: Record<AccessMode, string> = {
  hidden: "No access",
  read: "View only",
  suggest: "Suggest changes",
  publish: "Can edit",
};
const allPermissionSections: {
  id: string;
  label: string;
  classes: (keyof ProjectRules)[];
}[] = [
  {
    id: "memory",
    label: "Memories",
    classes: ["instructions", "memory"],
  },
  {
    id: "skill",
    label: "Skills",
    classes: ["skill"],
  },
  {
    id: "plan",
    label: "Plans",
    classes: ["plan"],
  },
  {
    id: "session",
    label: "Sessions",
    classes: ["session"],
  },
  {
    id: "env",
    label: "ENV sets",
    classes: ["env"],
  },
];
export const permissionSections = allPermissionSections.filter(
  (section) => ENV_ENABLED || section.id !== "env",
);
export const memberLabel = (
  id: string,
  user: string | null,
  members: GovernanceCatalog["members"] = [],
) => {
  const name = members.find((member) => member.id === id)?.name?.trim();
  return name
    ? `${displayText(name)}${id === user ? " (you)" : ""}`
    : id === user
      ? "You"
      : `Member ${id.slice(0, 8)}`;
};
export const memberRule = (
  catalog: GovernanceCatalog,
  member: string,
  category: keyof ProjectRules,
): ClassRule =>
  catalog.memberRules.find((r) => r.userId === member && r.class === category)
    ?.rule ?? catalog.policy[category];
