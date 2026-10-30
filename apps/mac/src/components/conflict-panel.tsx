import React from "react";
import { AlertIcon } from "@primer/octicons-react";
import type { SessionConflict } from "@portable/protocol";
import { Button } from "./button.js";
import type {
  SessionActionName,
  SessionVersion,
} from "./use-resource-actions.js";

/** One unresolved session conflict with its preview and resolution actions. */
export function ConflictPanel({
  conflict,
  deviceId,
  user,
  owner,
  busy,
  preview,
  onPreview,
  onResolve,
}: {
  conflict: SessionConflict;
  deviceId: string;
  user: string | null;
  /** The session owner; only they can keep or override. */
  owner: string;
  busy: boolean;
  /** The conflict being read, or empty for the shared version. */
  preview: string;
  onPreview: (conflictId: string) => void;
  onResolve: (
    action: SessionActionName,
    conflictId: string,
    selected: SessionVersion,
  ) => void;
}) {
  const local: SessionVersion =
    conflict.deviceId === deviceId ? "candidate" : "current";
  const remote: SessionVersion = local === "current" ? "candidate" : "current";
  const ownerOnly = busy || owner !== user;
  return (
    <div className="conflict">
      <strong>
        <AlertIcon size={16} aria-hidden="true" />
        Two session versions need a choice.
      </strong>
      <p>
        Open sessions stay untouched. Override applies after the session closes.
      </p>
      <div className="actions">
        <Button
          aria-pressed={!preview}
          onClick={() => onPreview("")}
          variant="secondary"
          size="sm"
        >
          View shared version
        </Button>
        <Button
          aria-pressed={preview === conflict.id}
          onClick={() => onPreview(conflict.id)}
          variant="secondary"
          size="sm"
        >
          View incoming version
        </Button>
        <Button
          disabled={ownerOnly}
          onClick={() => onResolve("keep", conflict.id, local)}
          variant="secondary"
          size="sm"
        >
          Keep local
        </Button>
        <Button
          disabled={ownerOnly}
          onClick={() => onResolve("override", conflict.id, remote)}
          variant="secondary"
          size="sm"
        >
          Override
        </Button>
        <Button
          disabled={busy || conflict.author !== user}
          onClick={() => onResolve("copy", conflict.id, local)}
          variant="tertiary"
          size="sm"
        >
          Create copy
        </Button>
      </div>
    </div>
  );
}
