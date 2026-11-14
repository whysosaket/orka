import React from "react";
import { PersonIcon } from "@primer/octicons-react";
import type { ProjectResource } from "../types.js";
import { useMemberLabel, useMemberPhoto } from "./member-names.js";
import { SourceLabel } from "./source-label.js";
import "./session-identity.css";

export function SessionIdentity({
  resource,
  user,
}: {
  resource: ProjectResource;
  user: string | null;
}) {
  const memberName = useMemberLabel(user);
  const author = memberName(resource.owner);
  const photo = useMemberPhoto(resource.owner);
  const tool =
    resource.source === "codex"
      ? "Codex"
      : resource.source === "claude"
        ? "Claude"
        : "Shared";
  const label = `${tool} · ${author}`;
  return (
    <span
      className="session-identity"
      role="img"
      aria-label={label}
      tabIndex={0}
    >
      <span className="session-identity-tool" aria-hidden="true">
        <SourceLabel source={resource.source} />
      </span>
      <span className="session-identity-avatar" aria-hidden="true">
        <PersonIcon size={16} />
        {photo && (
          <img
            key={photo}
            src={photo}
            alt=""
            width={28}
            height={28}
            loading="lazy"
            onError={(event) => {
              event.currentTarget.hidden = true;
            }}
          />
        )}
      </span>
      <span
        className="session-identity-tooltip"
        role="tooltip"
        aria-hidden="true"
      >
        {label}
      </span>
    </span>
  );
}
