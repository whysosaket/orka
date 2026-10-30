import {
  ClockIcon,
  GitCommitIcon,
  KeyIcon,
  PeopleIcon,
  PersonIcon,
  ShieldCheckIcon,
} from "@primer/octicons-react";
import { governanceCall } from "../project-permissions.js";
import { Button } from "../button.js";
import { TextField } from "../text-field.js";
import { ResourceActions } from "../resource-actions.js";
import { CopyLinkButton } from "../copy-link-button.js";
import { Recipients } from "./recipients.js";
import { EnvKeyList } from "./env-key-list.js";
import type { EnvController } from "./use-environments.js";
import { RepositoryLabel } from "../repository-label.js";
import { repositoryLabel } from "../project-sources.js";

export function EnvDetail({
  c,
  repository,
  onGovernance,
}: {
  c: EnvController;
  repository: string;
  onGovernance?: (id: string, title: string) => void;
}) {
  const { draft, selectedSet: set, busy, origin } = c;
  const matchesRepository =
    repository === "all" || (draft?.sourceId ?? set?.sourceId) === repository;
  const disabled = Boolean(busy);
  const canPublish =
    !c.project.governed ||
    ((!set
      ? (c.listing?.canCreate ?? c.project.role === "owner")
      : set.access?.mode === "publish") &&
      !set?.disabled);
  const needsResponse = set?.approved && set.trusted === false && !draft;
  const enterResponse = () => {
    c.setCode("");
    c.setModal("accept");
  };
  const apply = () => {
    c.setPreview(null);
    c.setModal("apply");
  };
  return (
    <div className="env-detail-scroll">
      <article className="env-detail" aria-label="ENV set details">
        {(set || draft) && (matchesRepository || c.hasUnpublishedChanges) ? (
          <>
            <div className="env-summary">
              <div className="env-title-row">
                <h2>{set?.name ?? "New ENV set"}</h2>
                <div className="env-actions">
                  {set && !set.approved ? (
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={disabled}
                      onClick={c.requestApproval}
                    >
                      Request approval
                    </Button>
                  ) : needsResponse ? (
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={disabled}
                      onClick={enterResponse}
                    >
                      Enter approval response
                    </Button>
                  ) : draft ? (
                    origin === "imported" ? (
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={
                          disabled ||
                          !canPublish ||
                          !c.checked.length ||
                          (!draft.revision && !c.name.trim())
                        }
                        onClick={c.reviewPublication}
                      >
                        Publish {draft.revision ? "version" : "ENV set"}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={disabled || !c.checked.length || !c.connected}
                        onClick={apply}
                      >
                        Apply to file
                      </Button>
                    )
                  ) : (
                    set && (
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={disabled}
                        onClick={() => void c.pull(set.setId)}
                      >
                        Pull latest
                      </Button>
                    )
                  )}
                  {draft && origin === "pulled" && (
                    <Button
                      size="sm"
                      disabled={disabled}
                      onClick={() => {
                        c.setText("");
                        c.setModal("import");
                      }}
                    >
                      Import changes
                    </Button>
                  )}
                  {set &&
                    c.project.governed &&
                    !canPublish &&
                    !set.disabled && (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={disabled}
                        onClick={() =>
                          void c.run(
                            "Requesting publishing access…",
                            async () => {
                              await governanceCall("request-access", {
                                projectId: c.project.id,
                                id: crypto.randomUUID(),
                                class: "env",
                                mode: "publish",
                              });
                              c.setNotice(
                                "Publishing access requested. Your local ENV files remain writable.",
                              );
                            },
                          )
                        }
                      >
                        Request publishing access
                      </Button>
                    )}
                  <ResourceActions>
                    {set &&
                      c.project.role === "owner" &&
                      c.project.governed &&
                      onGovernance && (
                        <Button
                          size="sm"
                          variant="tertiary"
                          disabled={disabled}
                          onClick={() => onGovernance(set.setId, set.name)}
                        >
                          Replace ENV set
                        </Button>
                      )}
                    {set && (
                      <div data-keep-open>
                        <CopyLinkButton
                          value={`orka://env/${c.project.id}/${set.setId}`}
                          label="Copy set link"
                          disabled={disabled}
                          onError={c.setError}
                        />
                      </div>
                    )}
                    {draft && (
                      <>
                        {c.project.governed && draft.revision && (
                          <Button
                            size="sm"
                            variant="tertiary"
                            disabled={disabled}
                            onClick={c.cloneSet}
                          >
                            Prepare replacement set
                          </Button>
                        )}
                        {origin === "imported" && (
                          <Button
                            size="sm"
                            variant="tertiary"
                            disabled={disabled}
                            onClick={() => {
                              c.setText("");
                              c.setModal("import");
                            }}
                          >
                            Import changes
                          </Button>
                        )}
                        {set && (
                          <Button
                            size="sm"
                            variant="tertiary"
                            disabled={disabled || c.hasUnpublishedChanges}
                            onClick={enterResponse}
                          >
                            Enter approval response
                          </Button>
                        )}
                        {set?.approved && (
                          <Button
                            size="sm"
                            variant="tertiary"
                            disabled={disabled}
                            onClick={() => void c.pull(set.setId)}
                          >
                            Pull latest
                          </Button>
                        )}
                        {draft.revision && (
                          <>
                            <Button
                              size="sm"
                              variant="tertiary"
                              disabled={disabled}
                              onClick={() => void c.reviewConflict()}
                            >
                              Compare latest
                            </Button>
                            {origin === "imported" && (
                              <Button
                                size="sm"
                                variant="tertiary"
                                disabled={
                                  disabled ||
                                  Boolean(set?.disabled) ||
                                  !c.checked.length ||
                                  !c.connected
                                }
                                onClick={apply}
                              >
                                Apply selected keys…
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="tertiary"
                              disabled={
                                disabled ||
                                !canPublish ||
                                (c.project.governed &&
                                  !set?.access?.canShare) ||
                                c.hasUnpublishedChanges
                              }
                              title={
                                c.hasUnpublishedChanges
                                  ? "Publish or discard your draft before changing access"
                                  : undefined
                              }
                              onClick={() => {
                                c.setGrants(draft.manifest!.grants);
                                c.setRemovedDevices([]);
                                c.setModal("access");
                              }}
                            >
                              Manage access
                            </Button>
                          </>
                        )}
                        {draft.manifest?.creator === c.user && (
                          <Button
                            size="sm"
                            variant="tertiary"
                            disabled={disabled || !canPublish}
                            onClick={() => c.setModal("delete")}
                          >
                            Delete set
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="tertiary"
                          disabled={disabled}
                          onClick={c.discard}
                        >
                          Discard draft
                        </Button>
                      </>
                    )}
                  </ResourceActions>
                </div>
              </div>
              <RepositoryLabel
                name={repositoryLabel(
                  c.project.sources ?? [],
                  draft?.sourceId ?? set?.sourceId,
                )}
              />
              {c.project.governed &&
                set &&
                (!set.approved || set.trusted === false) && (
                  <p className="env-content" role="status">
                    Awaiting trusted device
                  </p>
                )}
              {c.project.governed && (
                <p className="env-content">
                  {set?.disabled
                    ? set.replacementId
                      ? "This ENV set was replaced. Open the replacement set."
                      : "This set needs a new creator. An approved device can prepare a replacement; an owner must grant creation permission before publication."
                    : canPublish
                      ? "You can publish shared versions. Device approval and encrypted recipient rules also apply."
                      : "Shared versions are read only for you. Local dotenv overrides remain writable. Ask an owner for creation permission when publishing a new set."}
                </p>
              )}
              <div className="env-next-step">
                <p>
                  {c.hasUnpublishedChanges
                    ? draft?.revision
                      ? "These changes are only on this Mac. Publishing replaces the shared key list; review additions, changes, and removals before confirming."
                      : "Name this set, select the keys to share, and choose recipients below. Nothing is shared until you publish."
                    : draft
                      ? "Select keys, then preview and apply them to a local file."
                      : needsResponse
                        ? "Your Mac was approved, but it still needs the response code from the approving Mac before it can decrypt this set."
                        : set?.approved
                          ? "Pull latest decrypts a temporary copy for review. Applying to a local file is a separate step."
                          : "Exchange approval codes with the set’s creator or your own trusted Mac. You only need to do this once per Mac for this set."}
                </p>
              </div>
              <div className="env-meta">
                {(!draft || c.hasUnpublishedChanges) && (
                  <span>
                    <ShieldCheckIcon size={14} />
                    {c.hasUnpublishedChanges
                      ? "Unpublished draft"
                      : needsResponse
                        ? "Approval response needed"
                        : set
                          ? set.approved
                            ? "This Mac approved"
                            : "Approval required"
                          : "Local draft"}
                  </span>
                )}
                {set && (
                  <>
                    <span>
                      <GitCommitIcon size={14} />
                      {draft?.revision
                        ? `Reviewing version ${draft.revision}`
                        : `Version ${set.revision}`}
                    </span>
                    <span>
                      <PeopleIcon size={14} />
                      {set.grants.length}{" "}
                      {set.grants.length === 1 ? "recipient" : "recipients"}
                    </span>
                    <span>
                      <PersonIcon size={14} />
                      {c.label(set.updatedBy)}
                    </span>
                    <span title="Last published">
                      <ClockIcon size={14} />
                      {new Date(set.updatedAt).toLocaleString()}
                    </span>
                  </>
                )}
              </div>
            </div>
            {set && !set.approved && (
              <div className="env-content">
                <Button size="sm" disabled={disabled} onClick={enterResponse}>
                  Enter approval response
                </Button>
              </div>
            )}
            {set?.approved && !draft && !needsResponse && (
              <div className="env-empty">
                <p>
                  Just approved on another Mac? Enter its response here to
                  finish unlocking this set.
                </p>
                <Button size="sm" disabled={disabled} onClick={enterResponse}>
                  Enter approval response
                </Button>
              </div>
            )}
            {draft && (
              <div className="env-content">
                {c.hasUnpublishedChanges && (
                  <p className="env-muted">
                    This draft is temporary. Publish it before leaving ENVs to
                    keep your changes.
                  </p>
                )}
                {!draft.revision && (
                  <TextField
                    label="ENV set name"
                    value={c.name}
                    maxLength={100}
                    placeholder="Development"
                    onChange={(e) => c.setName(e.target.value)}
                  />
                )}
                {set && draft.revision && draft.revision < set.revision ? (
                  <div className="env-status">
                    A newer version is available.
                    <Button
                      size="sm"
                      disabled={disabled}
                      onClick={() => void c.reviewConflict()}
                    >
                      Review latest
                    </Button>
                  </div>
                ) : null}
                <EnvKeyList c={c} />
                {origin === "imported" &&
                  draft.revision &&
                  c.checked.length < draft.keys.length && (
                    <p className="env-muted">
                      Publishing shares only the selected keys. Unselected keys
                      will be omitted from the next version.
                    </p>
                  )}
                {!draft.revision ? (
                  <>
                    <Recipients c={c} editable />
                  </>
                ) : (
                  <section
                    className="env-sharing-info"
                    aria-label="Sharing status"
                  >
                    <h3>
                      Shared with{" "}
                      {draft.manifest?.grants.map(c.label).join(", ")}
                    </h3>
                    <p>
                      {c.project.governed
                        ? "Publishing follows each member’s resource permission. New recipients may be awaiting a trusted device."
                        : "All recipients can publish updates. New Macs need approval before they can read this set."}
                    </p>
                    {draft.manifest?.grants.some(
                      (id) =>
                        !draft.manifest!.devices.some(
                          (device) => device.owner === id,
                        ),
                    ) && (
                      <p>
                        Waiting for a Mac to be approved:{" "}
                        {draft.manifest.grants
                          .filter(
                            (id) =>
                              !draft.manifest!.devices.some(
                                (device) => device.owner === id,
                              ),
                          )
                          .map(c.label)
                          .join(", ")}
                        . Share the link, then ask them to open the set and
                        request approval.
                      </p>
                    )}
                  </section>
                )}
                {draft.revision && !c.connected && (
                  <p className="env-muted">
                    Connect this project’s local folder in Settings to apply
                    keys.
                  </p>
                )}
              </div>
            )}
          </>
        ) : (
          <div className="env-empty">
            <KeyIcon size={24} />
            <h2>
              {c.listing?.sets.length
                ? "Choose an ENV set"
                : "Share your project’s environment"}
            </h2>
            <p>
              {c.listing?.sets.length
                ? "Review a shared set, approve this Mac, then pull the keys you need."
                : "Import an ENV file, choose the keys to share, and select your teammates. Values stay encrypted between Macs."}
            </p>
            {c.listing && !c.listing.sets.length && (
              <Button
                size="sm"
                variant="primary"
                disabled={disabled}
                onClick={c.newSet}
              >
                New ENV set
              </Button>
            )}
          </div>
        )}
      </article>
    </div>
  );
}
