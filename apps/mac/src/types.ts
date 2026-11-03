import type { Resource, SessionConflict, Activity } from "@portable/protocol";
import type { ReviewRequest, EffectiveAccess } from "@portable/protocol";
export type ProjectResource = Resource & {
  repositoryName?: string;
  local?: true;
  global?: boolean;
  sharing?: "queued" | "approval" | "paused" | "blocked";
  fork?: {
    parentId: string;
    nativeId: string | null;
    destination: "desktop" | "terminal" | "warp" | "iterm2";
    createdAt: string;
  };
  localForkId?: string;
};
export type ProjectPage = "home" | "env" | "members" | Resource["kind"];
export type ProjectSharing = Record<Resource["kind"] | "env", boolean>;
export interface ProjectMember {
  id: string;
  role: string;
  name?: string;
}
export interface Project {
  id: string;
  name: string;
  localName?: string | null;
  path?: string | null;
  sources?: { id: string; name: string; path?: string | null }[];
  role: "owner" | "member";
  sharing?: ProjectSharing | null;
  governed?: boolean;
  policyRevision?: number;
  lifecycleRevision?: number;
}
export interface Binding {
  base: Resource;
  nativeId?: string;
  paths?: string[];
  needsCopy?: boolean;
  installationState?: string;
  availableRevision?: number;
}
export type ServiceMode = "cloud" | "self-hosted";
export interface Snapshot {
  onboarding?: import("./components/onboarding/model.js").OnboardingInfo;
  accountProfile?:
    import("./components/onboarding/model.js").AccountProfile | null;
  localSkills?: ProjectResource[];
  drafts?: LocalDraft[];
  reviewRequests?: ReviewRequest[];
  governance?: {
    projectId: string;
    catalog: {
      access: Record<string, EffectiveAccess>;
      members?: ProjectMember[];
    };
  }[];
  profile?: string;
  user: string | null;
  config: {
    apiUrl: string;
    syncMinutes: number;
    mode?: ServiceMode;
    cloudUrl?: string;
    selfHostedUrl?: string;
  } | null;
  projects: Project[];
  resources: ProjectResource[];
  bindings: Binding[];
  conflicts: SessionConflict[];
  activity: Activity[];
  outbox: { id: string; project: string; error: string | null }[];
  errors: { source: string; error: string }[];
  sync: { online: boolean; lastSync?: string; error?: string } | null;
  daemon: { running: boolean; heartbeat?: string; error?: string } | null;
  devices: { id: string; name: string; seen_at: string }[] | null;
  deviceId: string;
  background: boolean | null;
}
export interface LocalDraft {
  id: string;
  projectId: string;
  resource: Resource;
  status: string;
  automaticSharing?: boolean;
  createdAt: string;
  request?: ReviewRequest;
}
export interface Inspection {
  conversation?: string | null;
  content: string | null;
  previous: string | null;
  paths: string[] | null;
}
export interface SessionMessage {
  index: number;
  role: "user" | "assistant";
  text: string;
}
export interface SessionPage {
  messages: SessionMessage[];
  total: number;
  offset: number;
  removed?: boolean;
}
