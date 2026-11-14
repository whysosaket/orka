import React, { useEffect, useState } from "react";
import { PersonIcon } from "@primer/octicons-react";
import type { ProjectResource } from "../types.js";
import { useMemberLabel, useMemberPhoto } from "./member-names.js";
import { SourceLabel } from "./source-label.js";
import "./resource-identity.css";

export function ResourceIdentity({
  resource,
  user,
}: {
  resource: ProjectResource;
  user: string | null;
}) {
  const memberName = useMemberLabel(user);
  const stacked = resource.kind !== "memory";
  const author = memberName(stacked ? resource.owner : resource.updatedBy);
  const photo = useMemberPhoto(resource.owner);
  const tool =
    resource.source === "codex"
      ? "Codex"
      : resource.source === "claude"
        ? "Claude"
        : "Shared";
  const label = `${tool} · ${stacked ? author : `Updated by ${author}`}`;
  const [showLabel, setShowLabel] = useState(false);
  useEffect(() => {
    if (!showLabel) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowLabel(false);
    };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, [showLabel]);
  return (
    <span
      className="resource-identity"
      role="img"
      aria-label={label}
      tabIndex={0}
      onMouseEnter={() => setShowLabel(true)}
      onMouseLeave={(event) => {
        if (!event.currentTarget.contains(document.activeElement))
          setShowLabel(false);
      }}
      onFocus={() => setShowLabel(true)}
      onBlur={(event) => {
        if (!event.currentTarget.matches(":hover")) setShowLabel(false);
      }}
    >
      <span className="resource-identity-tool" aria-hidden="true">
        <SourceLabel source={resource.source} />
      </span>
      {stacked && (
        <span className="resource-identity-avatar" aria-hidden="true">
          <PersonIcon size={20} />
          {photo && (
            <img
              key={photo}
              src={photo}
              alt=""
              width={20}
              height={20}
              loading="lazy"
              onError={(event) => {
                event.currentTarget.hidden = true;
              }}
            />
          )}
        </span>
      )}
      {showLabel && (
        <span
          className="resource-identity-tooltip"
          role="tooltip"
          aria-hidden="true"
        >
          {label}
        </span>
      )}
    </span>
  );
}
