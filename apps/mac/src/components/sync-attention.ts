import type {
  Activity,
  ReviewRequest,
  SessionConflict,
} from "@portable/protocol";
import type {
  Binding,
  LocalDraft,
  ProjectResource,
  Snapshot,
} from "../types.js";
import { visibleRequest } from "../lib/features.js";

export const bindingResourceId = (binding: Binding) =>
  binding.resourceId ?? binding.base?.resourceId;
export const bindingProjectId = (binding: Binding) =>
  binding.projectId ?? binding.base?.projectId;

function uniqueResourceId(ids: (string | undefined | null)[]) {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  return unique.length === 1 ? unique[0] : undefined;
}

export function latestProjectDrafts(drafts: LocalDraft[], projectId: string) {
  const latest = new Map<string, LocalDraft>();
  for (const draft of drafts) {
    if (draft.projectId !== projectId) continue;
    const previous = latest.get(draft.resource.resourceId);
    if (
      !previous ||
      (draft.updatedAt ?? draft.createdAt) >
        (previous.updatedAt ?? previous.createdAt)
    )
      latest.set(draft.resource.resourceId, draft);
  }
  return [...latest.values()];
}

export interface AttentionItem {
  key: string;
  title: string;
  resourceId?: string;
  kind?: ProjectResource["kind"];
  messages: string[];
  paths: string[];
  requests: ReviewRequest[];
  conflicts: SessionConflict[];
  uploads: Snapshot["outbox"];
  binding?: Binding;
  draft?: LocalDraft;
}

export interface ProjectAttention {
  items: AttentionItem[];
  outbox: Snapshot["outbox"];
  accountError?: string;
  waitingRequests: ReviewRequest[];
  historyRequests: ReviewRequest[];
  historyDrafts: LocalDraft[];
  activity: Activity[];
  accountIssues: Snapshot["errors"];
}

/** One attention item per resource, regardless of how many local records describe it. */
export function projectAttention(
  state: Snapshot,
  projectId: string,
): ProjectAttention {
  const resources = new Map(state.resources.map((r) => [r.resourceId, r]));
  const items = new Map<string, AttentionItem>();
  const outbox = state.outbox.filter((entry) => entry.project === projectId);
  const requests = (state.reviewRequests ?? []).filter(
    (request) => request.projectId === projectId && visibleRequest(request),
  );
  const allDrafts = (state.drafts ?? []).filter(
    (d) => d.projectId === projectId,
  );
  const knownResources = new Map(
    [
      ...allDrafts.map((draft) => draft.resource),
      ...state.resources.filter((resource) => resource.projectId === projectId),
    ].map((resource) => [resource.resourceId, resource]),
  );
  const errorResourceId = (source: string): string | undefined => {
    if (knownResources.has(source)) return source;
    const installation = `${projectId}:installation:`;
    if (source.startsWith(installation)) {
      const id = source.slice(installation.length);
      return knownResources.has(id) ? id : undefined;
    }
    const publication = `${projectId}:publish:`;
    if (source.startsWith(publication)) {
      const id = source.slice(publication.length);
      return uniqueResourceId([
        ...requests
          .filter((request) => request.id === id)
          .map((request) => request.resourceId),
        ...outbox
          .filter((upload) => upload.id === id)
          .map((upload) => upload.resourceId),
        ...allDrafts
          .filter((draft) =>
            [
              draft.id,
              draft.requestId,
              draft.request?.id,
              draft.submission?.id,
            ].includes(id),
          )
          .map(
            (draft) =>
              draft.submission?.resource?.resourceId ??
              draft.request?.resourceId ??
              draft.resource.resourceId,
          ),
      ]);
    }
    const prefix = `${projectId}:`;
    if (!source.startsWith(prefix)) return;
    const scan = /^(?:(?:source:)?([^:]+):)?scan:(.+)$/.exec(
      source.slice(prefix.length),
    );
    if (!scan) return;
    const [, sourceId, target] = scan;
    return uniqueResourceId(
      [...knownResources.values()]
        .filter((resource) => {
          if (resource.sourceId !== sourceId) return false;
          if (target.startsWith("skills/"))
            return (
              resource.kind === "skill" &&
              resource.logicalPath === target.slice("skills/".length)
            );
          if (target.startsWith("instructions/"))
            return (
              resource.kind === "memory" && resource.logicalPath === target
            );
          if (target.startsWith("plan:"))
            return (
              resource.kind === "plan" &&
              resource.logicalPath === target.slice("plan:".length)
            );
          if (resource.resourceId === target) return true;
          const path =
            target.startsWith("plans:") && resource.kind === "plan"
              ? target.slice("plans:".length)
              : target.startsWith("/") && resource.kind === "session"
                ? target
                : undefined;
          return (
            path !== undefined &&
            state.bindings.some(
              (binding) =>
                bindingProjectId(binding) === projectId &&
                bindingResourceId(binding) === resource.resourceId &&
                binding.paths?.includes(path),
            )
          );
        })
        .map((resource) => resource.resourceId),
    );
  };
  const latest = latestProjectDrafts(allDrafts, projectId);
  const activeDrafts = latestProjectDrafts(
    allDrafts.filter(
      (draft) =>
        !draft.automaticSharing && ["local", "stale"].includes(draft.status),
    ),
    projectId,
  );
  const item = (key: string, resourceId?: string, title?: string) => {
    const resource = resourceId
      ? (resources.get(resourceId) ?? knownResources.get(resourceId))
      : undefined;
    const existing = items.get(key);
    if (existing) return existing;
    const result: AttentionItem = {
      key,
      resourceId,
      title: resource?.title ?? title ?? "Sync issue",
      kind: resource?.kind,
      messages: [],
      paths: [],
      requests: [],
      conflicts: [],
      uploads: [],
    };
    items.set(key, result);
    return result;
  };
  for (const request of requests) {
    if (request.status !== "pending" || !request.canReview) continue;
    const key = request.resourceId ?? `request:${request.id}`;
    item(key, request.resourceId, request.title).requests.push(request);
  }
  for (const conflict of state.conflicts) {
    if (resources.get(conflict.resourceId)?.projectId !== projectId) continue;
    item(conflict.resourceId, conflict.resourceId).conflicts.push(conflict);
  }
  for (const binding of state.bindings) {
    const resourceId = bindingResourceId(binding);
    if (
      bindingProjectId(binding) !== projectId ||
      !resourceId ||
      !resources.has(resourceId) ||
      !["review_pending", "update_available", "locally_modified"].includes(
        binding.installationState ?? "",
      )
    )
      continue;
    const entry = item(resourceId, resourceId);
    entry.binding = binding;
    entry.paths.push(...(binding.paths ?? []));
  }
  for (const draft of activeDrafts) {
    const entry = item(
      draft.resource.resourceId,
      draft.resource.resourceId,
      draft.resource.title,
    );
    entry.draft = draft;
    entry.kind ??= draft.resource.kind;
  }
  for (const upload of outbox) {
    if (!upload.error) continue;
    const entry = item(
      upload.resourceId ?? `upload:${upload.id}`,
      upload.resourceId ?? undefined,
      upload.title ?? "Failed upload",
    );
    entry.kind ??= upload.kind ?? undefined;
    entry.uploads.push(upload);
    entry.messages.push(upload.error);
  }
  for (const error of state.errors) {
    const resourceId = errorResourceId(error.source);
    if (
      !resourceId &&
      error.source !== projectId &&
      !error.source.startsWith(projectId + ":")
    )
      continue;
    const entry = item(
      resourceId ?? `issue:${error.source}`,
      resourceId,
      resourceId
        ? undefined
        : error.source === projectId
          ? "Project sync"
          : error.source.slice(projectId.length + 1),
    );
    entry.messages.push(error.error);
  }
  for (const entry of items.values()) {
    entry.messages = [...new Set(entry.messages)];
    entry.paths = [...new Set(entry.paths)];
  }
  const accountError = state.sync?.error;
  const resourceError =
    state.sync?.online !== false &&
    accountError &&
    [
      ...state.errors.map((error) => error.error),
      ...state.outbox.map((upload) => upload.error),
    ].includes(accountError);
  return {
    items: [...items.values()],
    outbox,
    accountError: resourceError ? undefined : accountError,
    waitingRequests: requests.filter(
      (r) => r.status === "pending" && !r.canReview,
    ),
    historyRequests: requests.filter((r) => r.status !== "pending"),
    historyDrafts: allDrafts
      .filter(
        (draft) =>
          !activeDrafts.includes(draft) &&
          draft.status !== "proposed" &&
          (!latest.includes(draft) ||
            ["published", "approved", "dismissed", "rejected"].includes(
              draft.status,
            )),
      )
      .sort((a, b) =>
        (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt),
      ),
    accountIssues: state.errors.filter((error) =>
      error.source.startsWith("history:unattributed:"),
    ),
    activity: state.activity.filter(
      (activity) =>
        activity.notifyOwner === state.user &&
        resources.get(activity.copyId)?.projectId === projectId,
    ),
  };
}
