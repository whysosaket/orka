import type { AccessMode } from "@portable/protocol";
import type {
  Binding,
  LocalDraft,
  Project,
  ProjectResource,
  Snapshot,
} from "../types.js";

/** Draft statuses that can still be sent or refreshed from this Mac. */
export const actionableDraftStatuses = ["local", "stale", "rejected"];

export interface SkillReviewState {
  binding?: Binding;
  /** Review local edits: a draft or local modification waits on this Mac. */
  outgoing: boolean;
  /** A suggestion for this skill is awaiting a publisher's decision. */
  pending: boolean;
  /** Review local update: an approved version or removal needs manual review. */
  incoming: boolean;
  /** Local edits block the approved incoming install (blue dot). */
  incomingBlocked: boolean;
}

type ReviewSnapshot = Pick<Snapshot, "bindings" | "drafts" | "governance">;

export function skillBinding(
  state: Pick<Snapshot, "bindings">,
  resource: Pick<ProjectResource, "resourceId">,
): Binding | undefined {
  return (state.bindings ?? []).find(
    (b) => b.base?.resourceId === resource.resourceId,
  );
}

export function skillDraft(
  state: Pick<Snapshot, "drafts">,
  resource: Pick<ProjectResource, "resourceId" | "projectId">,
): LocalDraft | undefined {
  const drafts = (state.drafts ?? []).filter(
    (draft) =>
      draft.projectId === resource.projectId &&
      draft.resource.resourceId === resource.resourceId &&
      !["dismissed", "published"].includes(draft.status),
  );
  return (
    drafts.find((draft) => actionableDraftStatuses.includes(draft.status)) ??
    drafts.find((draft) => draft.status === "proposed")
  );
}

/**
 * Which review entries the Skill info card shows. Both can coexist: outgoing
 * comes from local drafts, incoming from the installation binding alone.
 */
export function skillReviewState(
  resource: ProjectResource,
  state: ReviewSnapshot,
  project: Pick<Project, "governed">,
): SkillReviewState {
  const binding = skillBinding(state, resource);
  const none: SkillReviewState = {
    binding,
    outgoing: false,
    pending: false,
    incoming: false,
    incomingBlocked: false,
  };
  if (resource.local || !project.governed || resource.kind !== "skill")
    return none;
  const draft = skillDraft(state, resource);
  const installation = binding?.installationState ?? "current";
  const pending = draft?.status === "proposed";
  const actionable = Boolean(
    draft && actionableDraftStatuses.includes(draft.status),
  );
  const available = binding?.availableRevision;
  const installedRevision = binding?.base?.revision;
  const incoming =
    installation === "update_available" ||
    installation === "review_pending" ||
    (installation === "locally_modified" &&
      available !== undefined &&
      available !== installedRevision);
  return {
    binding,
    outgoing: !pending && (actionable || installation === "locally_modified"),
    pending,
    incoming,
    incomingBlocked: incoming && installation === "locally_modified",
  };
}

/** Effective skill access, preferring the per-resource grant the service sent. */
export function skillAccessMode(
  resource: Pick<ProjectResource, "access" | "projectId">,
  state: Pick<Snapshot, "governance">,
  project: Pick<Project, "role" | "governed">,
): AccessMode {
  if (resource.access?.mode) return resource.access.mode;
  const catalog = state.governance?.find(
    (entry) => entry.projectId === resource.projectId,
  )?.catalog.access.skill;
  if (catalog?.mode) return catalog.mode;
  return project.role === "owner" || !project.governed ? "publish" : "read";
}

export interface ReviewStatus {
  label: string;
  tone: "info" | "warning";
}

/** The title-card status for shared skills with review work outstanding. */
export function reviewStatus(review: SkillReviewState): ReviewStatus | null {
  if (review.pending) return { label: "Awaiting approval", tone: "warning" };
  if (review.incoming) return { label: "Review needed", tone: "info" };
  return null;
}
