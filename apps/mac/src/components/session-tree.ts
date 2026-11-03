import type { ProjectResource } from "../types.js";

/** Preserve collection sort order among siblings, while keeping forks beside
 * their source. A filtered-out or missing parent leaves a visible root. */
export function sessionTree(resources: ProjectResource[]) {
  const byId = new Map(
    resources.map((resource) => [resource.resourceId, resource]),
  );
  const parents = new Map<string, string>();
  const children = new Map<string, ProjectResource[]>();
  for (const resource of resources) {
    const parent = byId.get(resource.fork?.parentId ?? "");
    if (
      resource.kind !== "session" ||
      parent?.kind !== "session" ||
      parent.projectId !== resource.projectId ||
      parent.sourceId !== resource.sourceId
    )
      continue;
    const seen = new Set([resource.resourceId]);
    let ancestor: ProjectResource | undefined = parent;
    while (ancestor && !seen.has(ancestor.resourceId)) {
      seen.add(ancestor.resourceId);
      ancestor = byId.get(ancestor.fork?.parentId ?? "");
    }
    if (ancestor) continue;
    parents.set(resource.resourceId, parent.resourceId);
    const siblings = children.get(parent.resourceId) ?? [];
    siblings.push(resource);
    children.set(parent.resourceId, siblings);
  }
  return {
    parents,
    children,
    roots: resources.filter((resource) => !parents.has(resource.resourceId)),
  };
}

export function sessionAncestors(
  id: string | undefined,
  parents: Map<string, string>,
) {
  const ancestors: string[] = [];
  while (id && parents.has(id)) {
    id = parents.get(id);
    if (id) ancestors.push(id);
  }
  return ancestors;
}
