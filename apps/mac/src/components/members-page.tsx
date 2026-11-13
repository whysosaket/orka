import React, { useCallback, useEffect, useState } from "react";
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  KebabHorizontalIcon,
  PeopleIcon,
} from "@primer/octicons-react";
import { defaultProjectRules } from "@portable/protocol";
import { ENV_ENABLED } from "../lib/features.js";
import type { Project, Snapshot } from "../types.js";
import { ActionPopover } from "./resource-actions.js";
import { IconButton } from "./icon-button.js";
import { ProjectLogs } from "./project-logs.js";
import { Button } from "./button.js";
import { MemberPermissions } from "./member-permissions.js";
import { ProjectRequests } from "./project-requests.js";
import {
  governanceCall,
  accessNames,
  memberLabel,
  permissionSections,
  type GovernanceCatalog,
} from "./project-permissions.js";
import { projectLabel } from "./project-navigation.js";
import { useToastNotice } from "./toasts.js";
import { LoadingRegion } from "./loading-region.js";

function MemberIdentity({ name, role }: { name: string; role: string }) {
  return (
    <>
      <PeopleIcon size={16} aria-hidden="true" />
      <span>
        <strong>{name}</strong>
        <small>{role === "owner" ? "Owner" : "Member"}</small>
      </span>
      <span className="management-meta">
        {role === "owner" ? "Project owner" : "View permissions"}
      </span>
      <ChevronRightIcon size={16} aria-hidden="true" />
    </>
  );
}

function SampleMembers() {
  return (
    <section>
      <div className="management-heading">
        <div>
          <h3>Project members</h3>
          <p>Select a person to see their project permissions.</p>
        </div>
      </div>
      <div className="member-list">
        {["Project owner", "Team member", "Another member"].map(
          (name, index) => (
            <div className="member-list-entry" key={name}>
              <button type="button" className="member-row" disabled>
                <MemberIdentity
                  name={name}
                  role={index === 0 ? "owner" : "member"}
                />
              </button>
            </div>
          ),
        )}
      </div>
    </section>
  );
}

export type ManagementSection = "members" | "requests" | "logs";
export function MembersPage({
  project,
  state,
  section,
  onSection,
  onRefresh,
  onReviewFile,
}: {
  project: Project;
  state: Snapshot;
  section: ManagementSection;
  onSection: (section: ManagementSection) => void;
  onRefresh: () => Promise<void>;
  onReviewFile: (id: string) => void;
}) {
  const [catalog, setCatalog] = useState<GovernanceCatalog | null>(null);
  const [member, setMember] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const setMessage = useToastNotice();
  const [removing, setRemoving] = useState<string | null>(null);
  const call = useCallback(
    <T,>(action: string, input: Record<string, unknown> = {}) =>
      governanceCall<T>(action, { projectId: project.id, ...input }),
    [project.id],
  );
  const load = useCallback(async () => {
    setCatalog(await call<GovernanceCatalog>("catalog"));
  }, [call]);
  const refresh = async () => {
    await load();
    await onRefresh();
  };
  useEffect(() => {
    let active = true;
    void call<GovernanceCatalog>("catalog")
      .then((value) => {
        if (active) setCatalog(value);
      })
      .catch((e) => {
        if (active)
          setError(`Could not load members and permissions. ${String(e)}`);
      });
    return () => {
      active = false;
    };
  }, [call, project.policyRevision]);
  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const name = (id: string) => memberLabel(id, state.user, catalog?.members);
  const selected = catalog?.members.find((item) => item.id === member);
  return (
    <section className="members-page" aria-label="Manage">
      <div className="management-content">
        <div className="management-heading">
          <div>
            <h2>
              {section === "requests"
                ? "Pending reviews"
                : projectLabel(project)}
            </h2>
            <p>Review shared content and existing requests.</p>
          </div>
          <Button
            size="sm"
            variant="tertiary"
            disabled={busy}
            onClick={() => void run(load)}
          >
            Refresh
          </Button>
        </div>
        <div className="management-toolbar">
          {section === "requests" && (
            <Button size="sm" onClick={() => onSection("members")}>
              Back to Members
            </Button>
          )}
          {(section === "logs" ||
            (section === "members" && member !== null)) && (
            <Button
              size="sm"
              variant="secondary"
              className="management-back"
              onClick={() => {
                if (section === "logs") onSection("members");
                else {
                  setMember(null);
                  setRemoving(null);
                }
              }}
            >
              <ArrowLeftIcon size={16} aria-hidden="true" />
              Back to Members
            </Button>
          )}
        </div>
        {error && <p role="alert">{error}</p>}
        {removing && catalog && (
          <section
            className="permission-card"
            aria-label="Confirm member removal"
          >
            <h3>Remove {name(removing)}?</h3>
            <p>
              Their private local work stays on their Mac.
              {ENV_ENABLED && " ENV sets they created may need a replacement."}
            </p>
            <div className="actions">
              <Button
                className="management-danger"
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await call("remove-member", {
                      userId: removing,
                      expectedPolicyRevision: catalog.policyRevision,
                    });
                    if (member === removing) setMember(null);
                    setRemoving(null);
                    setMessage("Member removed from the project.");
                  })
                }
              >
                Confirm removal
              </Button>
              <Button
                variant="tertiary"
                disabled={busy}
                onClick={() => setRemoving(null)}
              >
                Cancel
              </Button>
            </div>
          </section>
        )}

        <LoadingRegion
          id={`management:${project.id}:${section}`}
          label="Loading members and permissions…"
          loading={!catalog && !error}
          error={
            !catalog && error ? (
              <p>
                If this service does not support member permissions, update the
                Orka service and try again.
              </p>
            ) : undefined
          }
        >
          {!catalog ? (
            section === "members" ? (
              <SampleMembers />
            ) : (
              <p>Loading project access…</p>
            )
          ) : (
            <>
              {!catalog.governed && (
                <section
                  className="permission-card"
                  aria-label="Enable project permissions"
                >
                  <h3>Set up permissions for this project</h3>
                  <p>
                    Enable access and change requests. Shared memory and skill
                    changes will need approval unless you allow editing.
                    Existing shared content and personal memory stay as they
                    are.
                  </p>
                  <details className="permission-activation-details">
                    <summary>What happens to existing work?</summary>
                    <p>
                      {catalog.resourceCount} shared items and{" "}
                      {
                        state.outbox.filter(
                          (item) => item.project === project.id,
                        ).length
                      }{" "}
                      queued changes on this Mac keep their content. Queued
                      changes are checked against permissions on reconnect.
                      Personal memory stays local and writable. Existing Macs
                      need an updated app.
                    </p>
                    <p>
                      Authorized skills install automatically when Skills
                      sharing is enabled on this Mac. Local edits are preserved.
                      Project instructions need local review before
                      installation.
                      {ENV_ENABLED &&
                        " ENV sets keep their encrypted recipient and trusted device requirements."}
                    </p>
                  </details>
                  {catalog.owner ? (
                    <Button
                      variant="primary"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await call("activate", {
                            expectedPolicyRevision: catalog.policyRevision,
                            rules: defaultProjectRules,
                          });
                        })
                      }
                    >
                      Enable project permissions
                    </Button>
                  ) : (
                    <p>A project owner can enable these controls.</p>
                  )}
                </section>
              )}
              {section === "logs" ? (
                <ProjectLogs call={call} />
              ) : section === "members" ? (
                <>
                  {member === null ? (
                    <section aria-label="Project members">
                      <div className="management-heading">
                        <div>
                          <h3>
                            {catalog.members.length}{" "}
                            {catalog.members.length === 1
                              ? "member"
                              : "members"}
                          </h3>
                          <p>
                            Select a person to see what they can view, add, or
                            edit.
                          </p>
                        </div>
                        {catalog.owner && catalog.governed && (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => setMember("")}
                          >
                            Default member permissions
                          </Button>
                        )}
                      </div>
                      <div className="member-list">
                        {catalog.members.map((item) => (
                          <div className="member-list-entry" key={item.id}>
                            <button
                              type="button"
                              className="member-row"
                              onClick={() => {
                                setMember(item.id);
                                setRemoving(null);
                              }}
                            >
                              <MemberIdentity
                                name={name(item.id)}
                                role={item.role}
                              />
                            </button>
                            {catalog.owner && item.role !== "owner" && (
                              <ActionPopover
                                label={`Actions for ${name(item.id)}`}
                                trigger={
                                  <IconButton
                                    icon={KebabHorizontalIcon}
                                    aria-label={`Manage ${name(item.id)}`}
                                    variant="tertiary"
                                    size="sm"
                                  />
                                }
                              >
                                <Button
                                  variant="tertiary"
                                  size="sm"
                                  onClick={() => setMember(item.id)}
                                >
                                  Edit permissions
                                </Button>
                                <Button
                                  className="management-danger"
                                  variant="tertiary"
                                  size="sm"
                                  disabled={busy}
                                  onClick={() => setRemoving(item.id)}
                                >
                                  Remove member
                                </Button>
                              </ActionPopover>
                            )}
                          </div>
                        ))}
                      </div>
                      <p className="management-note">
                        Names use account profiles, with email as a fallback.
                      </p>
                    </section>
                  ) : (
                    <section aria-label="Selected member">
                      {member && !selected ? (
                        <p>
                          This person is no longer a member of this project.
                        </p>
                      ) : selected?.role === "owner" ? (
                        <section className="permission-card">
                          <h3>{name(selected.id)}</h3>
                          <p>Owner</p>
                          <p>
                            Owners administer project members and shared
                            content.
                            {ENV_ENABLED &&
                              " ENV access still requires encryption and trusted device approval."}
                          </p>
                        </section>
                      ) : catalog.owner && catalog.governed ? (
                        <>
                          <MemberPermissions
                            key={member}
                            catalog={catalog}
                            member={member}
                            name={
                              member
                                ? name(member)
                                : "Default member permissions"
                            }
                            call={call}
                            onSaved={refresh}
                            disabled={busy}
                          />
                        </>
                      ) : (
                        <section className="permission-card">
                          <h3>
                            {member ? name(member) : "Member permissions"}
                          </h3>
                          <p>
                            {member === state.user
                              ? "Your shared project access. An owner can change these permissions."
                              : "A project owner manages this member's permissions."}
                          </p>
                          {member === state.user &&
                            catalog.governed &&
                            permissionSections.map((item) => (
                              <div className="governance-row" key={item.id}>
                                <span>{item.label}</span>
                                <span>
                                  {[
                                    ...new Set(
                                      item.classes.map(
                                        (category) =>
                                          accessNames[
                                            catalog.access[category]?.mode ??
                                              "hidden"
                                          ],
                                      ),
                                    ),
                                  ].join(" / ")}
                                </span>
                              </div>
                            ))}
                        </section>
                      )}
                    </section>
                  )}
                </>
              ) : catalog.governed ? (
                <ProjectRequests
                  project={project}
                  state={state}
                  catalog={catalog}
                  call={call}
                  run={run}
                  busy={busy}
                  error={error}
                  setMessage={setMessage}
                  onReviewFile={onReviewFile}
                />
              ) : (
                <p>
                  Enable project permissions to use access and change requests.
                </p>
              )}
            </>
          )}
        </LoadingRegion>
      </div>
    </section>
  );
}
