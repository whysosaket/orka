import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { KebabHorizontalIcon, PersonAddIcon } from "@primer/octicons-react";
import type { Project, ProjectMember, Snapshot } from "../../types.js";
import {
  governanceCall,
  type GovernanceCatalog,
} from "../project-permissions.js";
import { Button } from "../button.js";
import { IconButton } from "../icon-button.js";
import { PermissionSelect } from "../permission-select.js";
import { CopyLinkButton } from "../copy-link-button.js";
import { ActionPopover } from "../resource-actions.js";
import { Overlay } from "../overlay.js";
import { LoadingRegion } from "../loading-region.js";
import { ActivityIndicator } from "../activity-indicator.js";
import { SettingsHeading } from "./settings-shared.js";
import { useSettingsQuery } from "./use-settings-query.js";

const samples: ProjectMember[] = [
  {
    id: "sample-owner",
    name: "Morgan Taylor",
    email: "morgan@example.com",
    role: "owner",
  },
  {
    id: "sample-admin",
    name: "Alex Chen",
    email: "alex@example.com",
    role: "admin",
  },
  {
    id: "sample-member",
    name: "Jamie Rivera",
    email: "jamie@example.com",
    role: "member",
  },
];
const roleName = (role: string) =>
  role === "owner" ? "Owner" : role === "admin" ? "Admin" : "Member";
function MemberIdentity({
  member,
  user,
  userEmail,
}: {
  member: ProjectMember;
  user: string | null;
  userEmail?: string;
}) {
  // Older services omit email; null from a current service means none is known.
  const email =
    member.email === undefined && member.id === user
      ? userEmail?.trim()
      : member.email?.trim();
  const name =
    member.displayName?.trim() ||
    member.name?.trim() ||
    email ||
    `Member ${member.id.slice(0, 8)}`;
  const photo = member.avatarData ?? member.avatarUrl;
  return (
    <>
      <span className="settings-member-avatar">
        {photo ? (
          <img src={photo} alt="" width={40} height={40} loading="lazy" />
        ) : (
          name.slice(0, 1).toUpperCase()
        )}
      </span>
      <div className="settings-member-identity">
        <div className="settings-identity-name">
          <strong title={name}>{name}</strong>
          {member.id === user && (
            <span className="settings-device-label">You</span>
          )}
        </div>
        {email && <p title={email}>{email}</p>}
      </div>
    </>
  );
}
export function MemberRows({
  members,
  user,
  userEmail,
  owner,
  roleEditable = owner,
  admin,
  busy,
  onRole,
  onRemove,
  onTransfer,
}: {
  members: ProjectMember[];
  user: string | null;
  userEmail?: string;
  owner: boolean;
  roleEditable?: boolean;
  admin: boolean;
  busy: string;
  onRole: (id: string, role: string) => void;
  onRemove: (member: ProjectMember) => void;
  onTransfer: (member: ProjectMember) => void;
}) {
  const orderedMembers = [...members].sort(
    (a, b) => Number(b.id === user) - Number(a.id === user),
  );
  return (
    <ul className="settings-group settings-member-list">
      {orderedMembers.map((member) => (
        <li className="settings-member-row" key={member.id}>
          <MemberIdentity member={member} user={user} userEmail={userEmail} />
          {busy === member.id && <ActivityIndicator />}
          <div className="settings-member-controls">
            {roleEditable && member.role !== "owner" ? (
              <PermissionSelect
                label={`Role for ${member.name ?? member.id}`}
                value={member.role}
                options={[
                  { value: "admin", label: "Admin" },
                  { value: "member", label: "Member" },
                ]}
                disabled={Boolean(busy)}
                onChange={(role) => onRole(member.id, role)}
              />
            ) : (
              <span className="settings-member-role">
                {roleName(member.role)}
              </span>
            )}
            {((owner && member.role !== "owner") ||
              (admin && member.role === "member")) &&
              member.id !== user && (
                <ActionPopover
                  label={`Actions for ${member.name ?? member.id}`}
                  trigger={
                    <IconButton
                      icon={KebabHorizontalIcon}
                      variant="tertiary"
                      size="sm"
                      className="settings-member-menu"
                      disabled={Boolean(busy)}
                      aria-label={`Actions for ${member.name ?? member.id}`}
                    />
                  }
                >
                  <Button size="sm" onClick={() => onRemove(member)}>
                    Remove {roleName(member.role)}
                  </Button>
                  {roleEditable && (
                    <Button size="sm" onClick={() => onTransfer(member)}>
                      Transfer ownership
                    </Button>
                  )}
                </ActionPopover>
              )}
          </div>
        </li>
      ))}
    </ul>
  );
}
export function SettingsMembers({
  state,
  project,
  onReviews,
}: {
  state: Snapshot;
  project: Project;
  onReviews: () => void;
}) {
  const projectId = project.id;
  const call = useCallback(
    <T,>(action: string, input: Record<string, unknown> = {}) =>
      governanceCall<T>(action, { projectId, ...input }),
    [projectId],
  );
  const load = useCallback(async () => {
    const catalog = await call<GovernanceCatalog>("catalog");
    if (!Array.isArray(catalog.members))
      throw new Error("The service returned an invalid member list.");
    return { ...catalog, requests: catalog.requests ?? [] };
  }, [call]);
  const query = useSettingsQuery(load, null, project.policyRevision);
  const cachedMembers =
    state.governance?.find((entry) => entry.projectId === projectId)?.catalog
      .members ?? null;
  const members = query.data?.members ?? cachedMembers;
  const [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [invite, setInvite] = useState<string | null>(null),
    [confirmation, setConfirmation] = useState<{
      action: "remove-member" | "transfer-ownership";
      member: ProjectMember;
    } | null>(null);
  const active = useRef(true),
    locked = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const owner = project.role === "owner" && query.data?.owner === true;
  const admin =
    project.role === "admin" &&
    query.data?.role === "admin" &&
    Boolean(query.data.rolePolicies);
  const staleAuthority =
    /(?:403|409):/.test(error) && (query.loading || Boolean(query.error));
  async function mutate(
    id: string,
    action: () => Promise<unknown>,
    message: string,
  ) {
    if (locked.current || staleAuthority) return;
    locked.current = true;
    setBusy(id);
    setError("");
    setNotice("");
    try {
      await action();
      if (active.current) {
        setNotice(message);
        setConfirmation(null);
        await query.refresh();
      }
    } catch (error) {
      if (active.current) {
        setError(String(error));
        if (/(?:403|409):/.test(String(error))) {
          setConfirmation(null);
          await query.refresh();
        }
      }
    } finally {
      locked.current = false;
      if (active.current) setBusy("");
    }
  }
  async function createInvite() {
    if (locked.current || staleAuthority) return;
    locked.current = true;
    setBusy("invite");
    setError("");
    try {
      const result = await invoke<{ token: string; url?: string }>(
        "cloud_action",
        { action: "invite", input: { projectId } },
      );
      if (active.current)
        setInvite(result.url ?? `orka://join/${result.token}`);
    } catch (error) {
      if (active.current) setError(String(error));
    } finally {
      locked.current = false;
      if (active.current) setBusy("");
    }
  }
  return (
    <>
      <SettingsHeading
        title="Members"
        description="Manage project members and their roles."
        action={
          (owner || admin) && (
            <Button
              className="settings-add-member"
              disabled={Boolean(busy) || staleAuthority}
              onClick={() => void createInvite()}
            >
              {busy === "invite" ? (
                <ActivityIndicator />
              ) : (
                <PersonAddIcon size={16} />
              )}
              Add Member
            </Button>
          )
        }
      />
      <LoadingRegion
        id={`settings-members:${projectId}`}
        label="Loading members…"
        data={members}
        sample={samples}
        loading={!members && query.loading}
        empty={members?.length === 0}
        emptyMessage={
          <p>
            No members were returned. Refresh to check your access.{" "}
            <Button
              disabled={query.loading}
              onClick={() => void query.refresh()}
            >
              {query.loading ? "Refreshing…" : "Refresh"}
            </Button>
          </p>
        }
        error={
          !members && query.error ? (
            <p role="alert">
              Members are unavailable.{" "}
              <Button onClick={() => void query.refresh()}>Retry</Button>
            </p>
          ) : undefined
        }
      >
        {(visibleMembers) => (
          <MemberRows
            members={visibleMembers}
            user={state.user}
            userEmail={state.accountProfile?.email}
            owner={owner || (!members && project.role === "owner")}
            roleEditable={owner && Boolean(query.data?.rolePolicies)}
            admin={admin}
            busy={busy || (staleAuthority ? "refresh" : "")}
            onRole={(userId, role) =>
              void mutate(
                userId,
                () =>
                  call("member-role", {
                    userId,
                    role,
                    expectedPolicyRevision: query.data?.policyRevision,
                  }),
                "Role updated.",
              )
            }
            onRemove={(member) =>
              setConfirmation({ action: "remove-member", member })
            }
            onTransfer={(member) =>
              setConfirmation({ action: "transfer-ownership", member })
            }
          />
        )}
      </LoadingRegion>
      {query.error && members && (
        <p role="alert">
          Couldn’t refresh members.{" "}
          <Button onClick={() => void query.refresh()}>Retry</Button>
        </p>
      )}
      {query.extended && (
        <p>Still loading members. You can use the other settings.</p>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {(query.data?.requests.length ?? 0) > 0 && (
        <Button onClick={onReviews}>
          Review pending requests ({query.data!.requests.length})
        </Button>
      )}
      {invite && (
        <Overlay
          open
          title="Add Member"
          className="settings-confirm"
          onClose={() => setInvite(null)}
        >
          <h2>Add Member</h2>
          <p>
            This one-use join link expires after 24 hours. People join as
            Members; the Owner can promote them afterward.
          </p>
          <TextInvite value={invite} />
          <div className="settings-confirm-actions">
            <Button onClick={() => setInvite(null)}>Done</Button>
            <CopyLinkButton value={invite} onError={setError} />
          </div>
        </Overlay>
      )}
      {confirmation && (
        <Overlay
          open
          title={
            confirmation.action === "remove-member"
              ? "Remove member?"
              : "Transfer ownership?"
          }
          className="settings-confirm"
          onClose={() => {
            if (!busy) setConfirmation(null);
          }}
        >
          <h2>
            {confirmation.action === "remove-member"
              ? `Remove ${confirmation.member.name ?? "this member"}?`
              : `Transfer ownership to ${confirmation.member.name ?? "this member"}?`}
          </h2>
          <p>
            {confirmation.action === "remove-member"
              ? "Their access to shared content will end. Private local work stays on their Mac, and queued writes are checked again when they reconnect."
              : "They will become the Owner. You will become a Member with the project’s Member permissions."}
          </p>
          {error && <p role="alert">{error}</p>}
          <div className="settings-confirm-actions">
            <Button
              disabled={Boolean(busy)}
              onClick={() => setConfirmation(null)}
            >
              Stay
            </Button>
            <Button
              variant="primary"
              disabled={Boolean(busy)}
              onClick={() =>
                void mutate(
                  confirmation.member.id,
                  () =>
                    call(confirmation.action, {
                      userId: confirmation.member.id,
                      expectedPolicyRevision: query.data?.policyRevision,
                    }),
                  confirmation.action === "remove-member"
                    ? "Member removed."
                    : "Ownership transferred.",
                )
              }
            >
              {busy && <ActivityIndicator />}
              {confirmation.action === "remove-member"
                ? "Remove member"
                : "Transfer ownership"}
            </Button>
          </div>
        </Overlay>
      )}
    </>
  );
}
function TextInvite({ value }: { value: string }) {
  return (
    <textarea
      className="settings-invite"
      aria-label="Join link"
      value={value}
      readOnly
      rows={3}
    />
  );
}
