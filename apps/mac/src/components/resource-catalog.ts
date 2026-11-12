import type { ProjectResource } from "../types.js";

/** A discovered local snapshot replaces only the matching shared base revision. */
export function resourceCatalog(
  shared: ProjectResource[],
  local: ProjectResource[],
): ProjectResource[] {
  const key = (resource: ProjectResource) =>
    JSON.stringify([resource.projectId, resource.resourceId]);
  const published = new Map(
    shared.map((resource) => [key(resource), resource]),
  );
  const resources = new Map(published);
  for (const resource of local) {
    const current = published.get(key(resource));
    if (!current && !resource.local) continue;
    if (
      current &&
      (current.deleted
        ? !resource.local
        : resource.local || current.revision > resource.revision)
    )
      continue;
    resources.set(key(resource), resource);
  }
  return [...resources.values()];
}
