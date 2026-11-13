import React from "react";
import { changedFiles, type FileComparisonMetadata } from "./diff-model.js";
import { FileDiffCard } from "./file-diff.js";
import { ResourceContent } from "./resource-content.js";

export function FileReview({
  files,
  before = {},
  beforeManifest,
  afterManifest,
}: {
  files: Record<string, string>;
  before?: Record<string, string>;
} & FileComparisonMetadata) {
  const changes = changedFiles(before, files, {
    beforeManifest,
    afterManifest,
  });
  return (
    <div className="governance-files">
      {changes.length === 0 && <p>No file changes.</p>}
      {changes.map((change) => (
        <FileDiffCard
          key={change.path}
          {...change}
          showRemovedContent
          fallback={
            <ResourceContent
              inspection={{
                content: change.after,
                previous: change.before,
                paths: null,
              }}
              changes
              markdown={false}
            />
          }
        />
      ))}
    </div>
  );
}
