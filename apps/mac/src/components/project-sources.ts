import type { Project } from "../types.js";

export function activeSources<T extends { removedAt?: string | null }>(
  sources: T[] | undefined,
) {
  return (sources ?? []).filter((source) => !source.removedAt);
}

export function sourcePath(project: Project, sourceId?: string | null) {
  if (!project.sources) return project.path;
  const sources = activeSources(project.sources);
  if (sourceId) return sources.find((source) => source.id === sourceId)?.path;
  return sources.length === 1 ? sources[0].path : undefined;
}

export function hasConnectedSource(project: Project) {
  return project.sources
    ? activeSources(project.sources).some((source) => source.path)
    : Boolean(project.path);
}

export function repositoryLabel(
  sources: { id: string; name: string }[],
  id?: string,
) {
  const source = sources.find((source) => source.id === id);
  if (!source) return undefined;
  return sources.filter((item) => item.name === source.name).length > 1
    ? `${source.name} · ${source.id.slice(0, 6)}`
    : source.name;
}
