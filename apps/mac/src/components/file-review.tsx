import React from "react";
import { ResourceContent } from "./resource-content.js";

export function FileReview({
  files,
  before = {},
}: {
  files: Record<string, string>;
  before?: Record<string, string>;
}) {
  return (
    <div className="governance-files">
      {[...new Set([...Object.keys(before), ...Object.keys(files)])].map(
        (path) => (
          <section key={path}>
            <h4>
              {path}
              {!(path in files) ? " · Removed" : ""}
            </h4>
            <ResourceContent
              inspection={{
                content: files[path] ?? "",
                previous: before[path] ?? "",
                paths: null,
              }}
              changes
              markdown={false}
              conversation={false}
            />
          </section>
        ),
      )}
    </div>
  );
}
