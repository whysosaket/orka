import React, { useEffect, useState } from "react";
import { XIcon } from "@primer/octicons-react";
import type { AccessMode, Resource } from "@portable/protocol";
import type { Project, Snapshot } from "../types.js";
import { Button } from "./button.js";
import { IconButton } from "./icon-button.js";
import { PermissionSelect } from "./permission-select.js";
import { Overlay } from "./overlay.js";
import {
  governanceCall,
  permissionSections,
  type GovernanceCatalog,
} from "./project-permissions.js";

export function RequestAccess({
  project,
  kind,
  state,
  onRefresh,
  className,
}: {
  project: Project;
  kind: Resource["kind"];
  state: Snapshot;
  onRefresh: () => Promise<void>;
  className?: string;
}) {
  const [access, setAccess] = useState<AccessMode[] | null>(null);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"read" | "suggest" | "publish">("read");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [submittedId, setSubmittedId] = useState<string | null>(null);
  const submitted = state.reviewRequests?.find(
    (request) => request.id === submittedId,
  );
  const sent = Boolean(
    submittedId && (!submitted || submitted.status === "pending"),
  );
  const category = permissionSections.find((section) => section.id === kind)!;
  const pending = (state.reviewRequests ?? []).some(
    (request) =>
      request.projectId === project.id &&
      request.author === state.user &&
      request.type === "access" &&
      request.status === "pending" &&
      request.requestedClass === kind,
  );
  useEffect(() => {
    if (!project.governed || project.role === "owner") return;
    let active = true;
    setAccess(null);
    const load = governanceCall<GovernanceCatalog>("catalog", {
      projectId: project.id,
    }).then((value) => category.classes.map((key) => value.access[key].mode));
    void load
      .then((value) => {
        if (active) setAccess(value);
      })
      .catch(() => {
        if (active) setAccess(["hidden"]);
      });
    return () => {
      active = false;
    };
  }, [
    project.id,
    project.governed,
    project.role,
    project.policyRevision,
    category,
  ]);
  if (
    !project.governed ||
    project.role === "owner" ||
    access?.every((value) => value === "publish")
  )
    return null;
  const needsRead = access?.some((value) => value === "hidden");
  const label = category.label.toLowerCase();
  return (
    <>
      <Button
        className={className}
        size="sm"
        variant="secondary"
        disabled={busy || pending || sent}
        onClick={() => {
          setMode(needsRead ? "read" : "publish");
          setRequestId(crypto.randomUUID());
          setError("");
          setOpen(true);
        }}
      >
        {pending || sent
          ? "Access requested"
          : needsRead || !access
            ? "Request access"
            : "Request editing access"}
      </Button>
      {open && (
        <Overlay
          open
          title="Request access"
          onClose={() => {
            if (!busy) setOpen(false);
          }}
          className="access-request-dialog"
        >
          <div className="actions">
            <h2>Request access</h2>
            <span className="spacer" />
            <IconButton
              icon={XIcon}
              aria-label="Close access request"
              variant="tertiary"
              size="sm"
              disabled={busy}
              onClick={() => setOpen(false)}
            />
          </div>
          <p>Choose what you need for {label}.</p>
          <label>
            Permission
            <PermissionSelect
              label="Requested permission"
              value={mode}
              disabled={busy}
              options={[
                { value: "read", label: "View only" },
                { value: "suggest", label: "Suggest changes" },
                { value: "publish", label: "Can edit" },
              ]}
              onChange={(value) => {
                setMode(value);
                setRequestId(crypto.randomUUID());
              }}
            />
          </label>
          <p>
            {mode === "read"
              ? "Read shared content."
              : mode === "suggest"
                ? "Read content and propose changes for approval."
                : "Update shared content and approve proposed changes."}
          </p>
          <p>
            A project owner can review this request. Decisions appear in Manage
            → Requests. Personal work stays writable.
          </p>
          {error && <p role="alert">{error}</p>}
          <div className="actions">
            <Button
              disabled={busy}
              onClick={() =>
                void (async () => {
                  setBusy(true);
                  setError("");
                  try {
                    await governanceCall("request-access", {
                      projectId: project.id,
                      id: requestId,
                      class: kind,
                      mode,
                    });
                    setSubmittedId(requestId);
                    setOpen(false);
                    await onRefresh();
                  } catch (e) {
                    setError(String(e));
                  } finally {
                    setBusy(false);
                  }
                })()
              }
            >
              {busy ? "Sending…" : "Send request"}
            </Button>
            <Button
              variant="tertiary"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
          </div>
        </Overlay>
      )}
    </>
  );
}
