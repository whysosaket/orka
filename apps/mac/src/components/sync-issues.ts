import type { Snapshot } from "../types.js";

/** Groups one project's persistent sync errors by message, naming the affected items. */
export function groupSyncIssues(
  state: Pick<Snapshot, "errors" | "resources">,
  projectId: string,
  projectName?: string,
): Map<string, string[]> {
  const issues = new Map<string, string[]>();
  for (const issue of state.errors) {
    const affected = state.resources.find(
      (r) => r.projectId === projectId && r.resourceId === issue.source,
    );
    if (
      issue.source !== projectId &&
      !issue.source.startsWith(projectId + ":") &&
      !affected
    )
      continue;
    const sources = issues.get(issue.error) ?? [];
    sources.push(
      affected?.title ??
        (issue.source.split(":").slice(1).join(":") ||
          projectName ||
          issue.source),
    );
    issues.set(issue.error, sources);
  }
  return issues;
}

/** Distinct messages across grouped issues, the sync status, and failed uploads. */
export function countSyncIssues(
  issues: Map<string, string[]>,
  state: Pick<Snapshot, "sync" | "outbox">,
): number {
  return new Set([
    ...issues.keys(),
    ...(state.sync?.error ? [state.sync.error] : []),
    ...state.outbox.flatMap((item) => (item.error ? [item.error] : [])),
  ]).size;
}
