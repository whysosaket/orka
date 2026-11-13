import React from "react";

/** Mirrors collection rows without exposing sample content or focusable actions. */
export function CollectionSkeleton({ label }: { label: string }) {
  return (
    <div className="collection-skeleton" aria-hidden="true">
      <div className="collection-skeleton-label">
        <span className="loading-dot" />
        {label}
      </div>
      <div className="collection-skeleton-rows">
        {[68, 88, 54, 76, 62, 82].map((width, index) => (
          <div className="collection-skeleton-row" key={index}>
            <div className="collection-skeleton-title">
              <span style={{ width: `${width}%` }} />
              <span style={{ width: `${width / 2}%` }} />
            </div>
            <span className="collection-skeleton-source" />
            <span className="collection-skeleton-author" />
            <span className="collection-skeleton-date" />
          </div>
        ))}
      </div>
    </div>
  );
}
