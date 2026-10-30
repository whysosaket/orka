import { EnvConflictDialog } from "./conflict-dialog.js";
import { DeleteEnvDialog } from "./delete-dialog.js";
import { ApplyEnvDialog } from "./apply-dialog.js";
import { EnvAccessDialog } from "./access-dialog.js";
import { DeviceApprovalDialog } from "./device-dialog.js";
import { ApprovalCodeDialog } from "./code-dialog.js";
import { ImportEnvDialog } from "./import-dialog.js";
import { Button } from "../button.js";
import { XIcon } from "@primer/octicons-react";
import { IconButton } from "../icon-button.js";
import { Overlay } from "../overlay.js";
import type { EnvController } from "./use-environments.js";
import type { ReactNode } from "react";
function EnvDialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  className?: string;
}) {
  return (
    <Overlay open title={title} onClose={onClose} className="env-dialog">
      <header className="env-dialog-heading">
        <h2>{title}</h2>
        <IconButton
          icon={XIcon}
          aria-label="Close dialog"
          variant="tertiary"
          size="sm"
          onClick={onClose}
        />
      </header>
      {children}
    </Overlay>
  );
}
export function EnvDialogs({ c }: { c: EnvController }) {
  const { modal, close, busy, error } = c;
  if (!modal) return null;
  return (
    <EnvDialog
      title={
        {
          import: "Import environment variables",
          access: "Manage ENV access",
          approve: "Approve a teammate’s Mac",
          accept: "Unlock this Mac",
          code: "Device approval code",
          apply: "Apply selected ENV keys",
          delete: "Delete ENV set",
          conflict: "Review concurrent changes",
          publish: "Review publication",
          discard: "Discard unpublished changes?",
        }[modal]
      }
      onClose={close}
      wide={modal === "import" || modal === "conflict"}
      className="env-dialog"
    >
      {busy && <p role="status">{busy}</p>}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <ImportEnvDialog c={c} />
      <ApprovalCodeDialog c={c} />
      <DeviceApprovalDialog c={c} />
      <EnvAccessDialog c={c} />
      <ApplyEnvDialog c={c} />
      <DeleteEnvDialog c={c} />
      <EnvConflictDialog c={c} />
      {modal === "publish" && (
        <>
          <p>
            This replaces the shared key list for {c.selectedSet?.name}.
            Recipients will receive these changes the next time they pull.
          </p>
          <ul className="env-change-list" aria-label="Publication changes">
            {c.comparison
              .filter((key) => key.changed)
              .map((key) => (
                <li key={key.key}>
                  <code>{key.key}</code>
                  <span>
                    {!key.local
                      ? "Remove from shared set"
                      : !key.remote
                        ? "Add to shared set"
                        : "Update value"}
                  </span>
                </li>
              ))}
          </ul>
          {!c.comparison.some((key) => key.changed) && (
            <p>
              No key changes. This publication would create an identical
              version.
            </p>
          )}
          <p className="env-muted">
            Values stay masked. Local files are unchanged by publishing.
          </p>
          <div className="dialog-actions">
            {error && (
              <Button
                size="sm"
                disabled={Boolean(busy)}
                onClick={() => void c.reviewConflict(true)}
              >
                Refresh review
              </Button>
            )}
            <Button size="sm" disabled={Boolean(busy)} onClick={close}>
              Back to draft
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={
                Boolean(busy) || !c.comparison.some((key) => key.changed)
              }
              onClick={c.publish}
            >
              Publish version
            </Button>
          </div>
        </>
      )}
      {modal === "discard" && (
        <>
          <p>
            Your imported keys and selections have not been published.
            Continuing will discard this draft.
          </p>
          <div className="dialog-actions">
            <Button size="sm" onClick={close}>
              Keep editing
            </Button>
            <Button size="sm" variant="primary" onClick={c.confirmDiscard}>
              Discard and continue
            </Button>
          </div>
        </>
      )}
    </EnvDialog>
  );
}
