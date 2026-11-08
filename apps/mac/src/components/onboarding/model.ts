import type { ProjectSharing } from "../../types.js";
import { defaultSharing } from "../project-sharing.js";
export { defaultSharing } from "../project-sharing.js";
export type OnboardingStep =
  | "location"
  | "profile"
  | "discover"
  | "scanning"
  | "empty"
  | "access-error"
  | "folder"
  | "partial-access"
  | "select"
  | "review"
  | "syncing"
  | "retrying"
  | "ready"
  | "offline"
  | "sync-error"
  | "background"
  | "background-off"
  | "finish-setup"
  | "invite"
  | "claude"
  | "codex";
export interface AccountProfile {
  displayName: string;
  jobRole?: string | null;
  avatarUrl?: string | null;
  avatarData?: string | null;
  avatarPreview?: string | null;
  supported?: boolean;
  detailsSupported?: boolean;
  pending?: boolean;
  offline?: boolean;
}
export interface DiscoveredProject {
  path: string;
  displayPath: string;
  name: string;
  sources: ("claude" | "codex")[];
  readable?: boolean;
  alreadyConnected?: boolean;
  projectId?: string;
  status?:
    | "creating"
    | "connecting"
    | "scanning"
    | "syncing"
    | "synced"
    | "error"
    | "skipped";
  error?: string;
  conflicts?: number;
  reviewPending?: number;
}
export interface ProjectMatch {
  id: string;
  name: string;
  role: "owner" | "member";
  lastSyncAt?: string;
  sourceId?: string | null;
  sources?: { id: string; name: string }[];
}
export interface OnboardingDraft {
  step: OnboardingStep;
  projects: DiscoveredProject[];
  selected: string[];
  folder: string;
  sharing: ProjectSharing;
  choices?: Record<string, string>;
  sourceChoices?: Record<string, string>;
  matches?: Record<
    string,
    { remoteKey?: string; projects: ProjectMatch[]; requiresChoice?: boolean }
  >;
  reviewed?: boolean;
  completedAt?: string;
}
export interface OnboardingInfo {
  active: boolean;
  draft?: OnboardingDraft | null;
  location?: { ok: boolean; path: string; reason?: string };
}
export const initialDraft: OnboardingDraft = {
  step: "profile",
  projects: [],
  selected: [],
  folder: "",
  sharing: defaultSharing,
};
export const frameForStep: Record<OnboardingStep, string> = {
  location: "716:3798",
  profile: "706:4670",
  discover: "704:4613",
  scanning: "707:5488",
  empty: "714:3292",
  "access-error": "714:3048",
  folder: "714:2949",
  "partial-access": "714:3167",
  select: "706:5279",
  review: "706:5085",
  syncing: "708:5763",
  retrying: "708:5763",
  ready: "708:5870",
  offline: "715:3270",
  "sync-error": "715:3418",
  background: "734:6308",
  "background-off": "716:3249",
  "finish-setup": "716:3036",
  invite: "709:5983",
  claude: "716:3402",
  codex: "716:3526",
};
