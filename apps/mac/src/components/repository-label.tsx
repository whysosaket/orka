import { RepoIcon } from "@primer/octicons-react";

export function RepositoryLabel({ name }: { name?: string }) {
  if (!name) return null;
  return (
    <span
      className="resource-repository"
      title={name}
      aria-label={`Repository: ${name}`}
    >
      <RepoIcon size={14} aria-hidden="true" />
      <span>{name}</span>
    </span>
  );
}
