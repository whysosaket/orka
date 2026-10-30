import type { Project } from "../types.js";

export function sourcePath(project: Project, sourceId?: string | null) {
  if (!project.sources) return project.path;
  if (sourceId)
    return project.sources.find((source) => source.id === sourceId)?.path;
  return project.sources.length === 1 ? project.sources[0].path : undefined;
}

export function hasConnectedSource(project: Project) {
  return Boolean(
    project.sources?.some((source) => source.path) || project.path,
  );
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
