import { useState } from "react";
import { KeyIcon } from "@primer/octicons-react";
import { SearchField } from "../search-field.js";
import type { EnvController } from "./use-environments.js";
import { repositoryLabel } from "../project-sources.js";
import { RepositoryLabel } from "../repository-label.js";
export function EnvSetList({
  c,
  repository,
}: {
  c: EnvController;
  repository: string;
}) {
  const [query, setQuery] = useState("");
  const sets =
    c.listing?.sets.filter(
      (set) =>
        set.name.toLowerCase().includes(query.toLowerCase()) &&
        (repository === "all" || set.sourceId === repository),
    ) ?? [];
  return (
    <aside className="env-list" aria-label="ENV sets">
      <div className="env-list-search">
        <SearchField
          size="sm"
          aria-label="Search ENV sets"
          placeholder="Search ENV sets…"
          value={query}
          onValueChange={setQuery}
        />
      </div>
      <div className="env-list-items">
        {c.hasUnpublishedChanges && !c.draft?.revision && (
          <div className="env-list-item env-draft-item" aria-current="true">
            <KeyIcon size={16} />
            <span>
              <strong>{c.name.trim() || "New ENV set"}</strong>
              <RepositoryLabel
                name={repositoryLabel(
                  c.project.sources ?? [],
                  c.draft?.sourceId ?? undefined,
                )}
              />
              <small>Unpublished draft · only on this Mac</small>
            </span>
          </div>
        )}
        {!c.listing && (
          <p className="env-muted">
            {c.busy ? "Loading ENV sets…" : "Refresh to load ENV sets."}
          </p>
        )}
        {c.listing && !sets.length && (
          <p className="env-muted">
            {query || repository !== "all"
              ? "No matching ENV sets."
              : "No shared ENV sets yet."}
          </p>
        )}
        {sets.map((set) => (
          <button
            className="env-list-item"
            aria-current={c.selected === set.setId ? "true" : undefined}
            disabled={Boolean(c.busy)}
            key={set.setId}
            onClick={() => c.select(set.setId)}
          >
            <KeyIcon size={16} />
            <span>
              <strong>{set.name}</strong>
              <RepositoryLabel
                name={repositoryLabel(c.project.sources ?? [], set.sourceId)}
              />
              <small>
                {c.hasUnpublishedChanges && c.selected === set.setId
                  ? "Unpublished changes"
                  : set.approved
                    ? set.trusted === false
                      ? "Approval response needed"
                      : `Version ${set.revision}`
                    : "Approval required"}{" "}
                · {set.grants.length}{" "}
                {set.grants.length === 1 ? "recipient" : "recipients"}
              </small>
              <small>
                {new Date(set.updatedAt).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                })}
              </small>
            </span>
          </button>
        ))}
      </div>
    </aside>
  );
}
