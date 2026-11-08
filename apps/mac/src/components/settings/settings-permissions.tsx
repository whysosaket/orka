import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  BookIcon,
  CommentDiscussionIcon,
  TasklistIcon,
  ZapIcon,
  LockIcon,
} from "@primer/octicons-react";
import type { Project, Snapshot } from "../../types.js";
import {
  governanceCall,
  type GovernanceCatalog,
} from "../project-permissions.js";
import { Button } from "../button.js";
import { PermissionSelect } from "../permission-select.js";
import { ActivityIndicator } from "../activity-indicator.js";
import { Skeleton } from "skullet/react";
import { Overlay } from "../overlay.js";
import {
  SettingsHeading,
  settingsScope,
  type SettingsEditor,
} from "./settings-shared.js";
import { useSettingsQuery } from "./use-settings-query.js";
import {
  accessOptions,
  categories,
  categoryNames,
  defaultPolicies,
  permissionDrafts,
  policyComparison,
  type Access,
  type PolicyDraft,
  type PolicySubmission,
  type RolePolicies,
} from "./settings-permission-model.js";

const icons = {
  memory: BookIcon,
  session: CommentDiscussionIcon,
  plan: TasklistIcon,
  skill: ZapIcon,
};
type Migration = {
  migrationHash: string;
  policyRevision: number;
  proposed: RolePolicies;
  previous: {
    project: {
      governed: boolean;
      policy: Record<string, { mode: string; create: string }> | null;
    };
    members: { user_id: string; role: string }[];
    memberRules: {
      user_id: string;
      class: string;
      rule: { mode: string; create: string };
    }[];
    resourceRules: {
      user_id: string;
      resource_id: string;
      rule: { mode: string };
    }[];
    pending: { id: string; payload: { title: string; type: string } }[];
  };
};
type SaveResult = {
  policies: RolePolicies;
  policyRevision: number;
  operationId: string;
};
type Phase =
  | "idle"
  | "saving"
  | "checking"
  | "retry"
  | "saved"
  | "failed"
  | "loading-latest";
const nameOf = (value: Access) =>
  accessOptions.find((option) => option.value === value)?.label ?? value;

export function RoleTables({
  policies,
  editable,
  locked,
  onChange,
  pending = false,
  scope = "",
  unavailable = false,
}: {
  policies: RolePolicies | null;
  editable: boolean;
  locked: boolean;
  onChange: (value: RolePolicies) => void;
  pending?: boolean;
  scope?: string;
  unavailable?: boolean;
}) {
  return (
    <div className="settings-role-tables" aria-busy={pending || undefined}>
      <span className="sr-only" role={pending ? "status" : undefined}>
        {pending ? "Loading role permissions…" : ""}
      </span>
      {(["owner", "admin", "member"] as const).map((role) => (
        <section
          key={role}
          aria-label={`${role[0].toUpperCase() + role.slice(1)} permissions`}
        >
          <h3>{role[0].toUpperCase() + role.slice(1)}</h3>
          <table className="settings-group settings-policy-table">
            <tbody>
              {categories.map((category) => {
                const Icon = icons[category];
                return (
                  <tr key={category}>
                    <th scope="row">
                      <Icon size={16} aria-hidden="true" />
                      {categoryNames[category]}
                    </th>
                    <td>
                      {role === "owner" ? (
                        <span className="settings-fixed-access">
                          Full access
                          <LockIcon size={14} aria-hidden="true" />
                        </span>
                      ) : unavailable ? (
                        <span>Unavailable</span>
                      ) : (
                        <Skeleton
                          id={`${scope}:${role}:${category}`}
                          data={policies?.[role][category] ?? null}
                          sample={defaultPolicies[role][category]}
                          loading={pending}
                        >
                          {(value) =>
                            editable ? (
                              <PermissionSelect
                                label={`${role === "admin" ? "Admin" : "Member"} ${categoryNames[category]} access`}
                                value={value}
                                options={[...accessOptions]}
                                disabled={locked || pending}
                                onChange={(value) => {
                                  if (policies)
                                    onChange({
                                      ...policies,
                                      [role]: {
                                        ...policies[role],
                                        [category]: value,
                                      },
                                    });
                                }}
                              />
                            ) : (
                              <span className="settings-readonly-access">
                                {nameOf(value)}
                              </span>
                            )
                          }
                        </Skeleton>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}

export const SettingsPermissions = forwardRef<
  SettingsEditor,
  { state: Snapshot; project: Project }
>(function SettingsPermissions({ state, project }, ref) {
  const scope = settingsScope(state, project.id),
    user = state.user,
    service = state.config?.apiUrl,
    projectId = project.id;
  const call = useCallback(
    <T,>(action: string, input: Record<string, unknown> = {}) =>
      governanceCall<T>(action, { projectId, ...input }),
    [projectId],
  );
  const load = useCallback(async () => {
    const [catalog, capabilities] = await Promise.all([
      call<GovernanceCatalog>("catalog"),
      invoke<{ rolePolicies?: number; policyOperations?: number }>(
        "settings_command",
        { action: "capabilities", context: { user, service } },
      ),
    ]);
    return {
      catalog,
      supported:
        capabilities.rolePolicies === 1 && capabilities.policyOperations === 1,
    };
  }, [call, user, service]);
  const query = useSettingsQuery(load, null, project.policyRevision);
  const [record, setRecord] = useState<PolicyDraft | null>(
    () => permissionDrafts.get(scope) ?? null,
  );
  const [phase, setPhase] = useState<Phase>(
    record?.submission ? "retry" : "idle",
  );
  const [error, setError] = useState(""),
    [lost, setLost] = useState(false);
  const [migration, setMigration] = useState<Migration | null>(null),
    [migrationOpen, setMigrationOpen] = useState(false),
    [ack, setAck] = useState(false);
  const [conflict, setConflict] = useState<{
    latest: SaveResult;
    choices: Record<string, "draft" | "latest">;
  } | null>(null);
  const active = useRef(true),
    locked = useRef(false),
    current = useRef(record);
  current.current = record;
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, [scope]);
  useEffect(() => {
    if (record) permissionDrafts.set(scope, record);
  }, [scope, record]);
  useEffect(() => {
    const catalog = query.data?.catalog;
    if (
      catalog?.rolePolicies &&
      !current.current?.submission &&
      (!current.current ||
        JSON.stringify(current.current.draft) ===
          JSON.stringify(current.current.baseline))
    )
      setRecord({
        baseline: catalog.rolePolicies,
        draft: catalog.rolePolicies,
        revision: catalog.policyRevision,
      });
    if (catalog && !catalog.owner) setLost(true);
  }, [query.data]);
  const owner =
    project.role === "owner" && Boolean(query.data?.catalog.owner) && !lost;
  const supported = query.data?.supported === true;
  const checkingOwner =
    project.role === "owner" && !query.data && query.loading && !lost;
  const legacy = Boolean(query.data && !query.data.catalog.rolePolicies);
  const dirty = Boolean(
    record &&
    (record.submission ||
      JSON.stringify(record.draft) !== JSON.stringify(record.baseline)),
  );
  const lockedValues =
    phase === "saving" ||
    phase === "checking" ||
    phase === "loading-latest" ||
    Boolean(record?.needsReview) ||
    Boolean(record?.submission) ||
    Boolean(conflict);
  const online = state.sync?.online !== false;
  const authority = useRef(owner);
  authority.current = owner;
  const [verifiedMissing, setVerifiedMissing] = useState(false);
  useEffect(() => {
    if (query.error.includes("403:")) setLost(true);
  }, [query.error]);
  const applyResult = (result: SaveResult) => {
    if (query.data)
      query.confirm({
        ...query.data,
        catalog: {
          ...query.data.catalog,
          rolePolicies: result.policies,
          policyRevision: result.policyRevision,
        },
      });
    setRecord({
      baseline: result.policies,
      draft: result.policies,
      revision: result.policyRevision,
    });
    permissionDrafts.delete(scope);
    setPhase("saved");
    setError("");
    setMigration(null);
    setAck(false);
    setConflict(null);
  };
  async function reconcile(
    submission: PolicySubmission,
  ): Promise<true | string> {
    setPhase("checking");
    try {
      const result = await call<SaveResult & { status: string }>(
        "policy-operation",
        { operationId: submission.operationId },
      );
      if (!active.current || !authority.current)
        return "Your editing access changed. Your draft is kept for review.";
      if (result.status === "committed") {
        applyResult(result);
        return true;
      }
      setPhase("retry");
      setVerifiedMissing(true);
      const message =
        "The service has no confirmed result. Retry the original save to complete it safely.";
      setError(message);
      return message;
    } catch (error) {
      const message = `Couldn’t confirm the save. Check again before retrying. ${String(error)}`;
      if (active.current) {
        if (String(error).includes("403:")) setLost(true);
        setPhase("retry");
        setError(message);
      }
      return message;
    }
  }
  async function loadLatest() {
    setPhase("loading-latest");
    setError("");
    try {
      const latest = await call<{
        policies: RolePolicies | null;
        policyRevision: number;
      }>("role-policy");
      if (!active.current) return;
      if (!latest.policies) {
        setMigration(null);
        setAck(false);
        throw new Error(
          "The service has no current role policy. Review access changes again.",
        );
      }
      setConflict({
        latest: { ...latest, policies: latest.policies, operationId: "" },
        choices: {},
      });
    } catch (error) {
      if (active.current) {
        if (String(error).includes("403:")) setLost(true);
        setError(
          `Couldn’t load the latest permissions. Your draft is kept. ${String(error)}`,
        );
      }
    } finally {
      if (active.current) setPhase("failed");
    }
  }
  async function save(): Promise<true | string> {
    if (!dirty && !legacy) return true;
    if (
      locked.current ||
      !record ||
      !owner ||
      !supported ||
      !online ||
      conflict ||
      record.needsReview
    )
      return record?.needsReview
        ? "Review the latest permissions before saving. Stay on this page to load them again."
        : "Permissions cannot be saved right now. Check your connection and editing access.";
    if (legacy && !record.submission && (!migration || !ack)) {
      setMigrationOpen(true);
      return "Review the access changes before saving.";
    }
    locked.current = true;
    if (record.submission && !verifiedMissing) {
      try {
        return await reconcile(record.submission);
      } finally {
        locked.current = false;
      }
    }
    setVerifiedMissing(false);
    setError("");
    const submission = record.submission ?? {
      operationId: crypto.randomUUID(),
      expectedPolicyRevision: record.revision,
      policies: structuredClone(record.draft),
      ...(migration ? { migrationHash: migration.migrationHash } : {}),
    };
    setRecord({ ...record, submission });
    setPhase("saving");
    try {
      const result = await call<SaveResult>("save-role-policy", {
        ...submission,
      });
      if (!active.current || !authority.current)
        return "Your editing access changed. Your draft is kept for review.";
      applyResult(result);
      return true;
    } catch (error) {
      if (!active.current) return String(error);
      const message = String(error);
      if (message.includes("403:")) {
        setLost(true);
        setError("Your editing access changed. Your draft is kept for review.");
        setPhase("failed");
        return "Your editing access changed. Your draft is kept for review.";
      }
      if (message.includes("409:")) {
        setRecord({ ...record, submission: undefined, needsReview: true });
        await loadLatest();
        return "Permissions changed. Stay on this page to review the latest values before saving.";
      }
      if (/(?:400|422):/.test(message)) {
        setRecord({ ...record, submission: undefined });
        setPhase("failed");
        setError(message);
        return message;
      }
      return await reconcile(submission);
    } finally {
      locked.current = false;
    }
  }
  useImperativeHandle(ref, () => ({
    dirty,
    pendingSave: Boolean(record?.submission),
    draftText: () => JSON.stringify(record?.draft ?? {}, null, 2),
    save,
    discard: () => {
      if (record && !record.submission) {
        setRecord({
          ...record,
          draft: record.baseline,
          needsReview: undefined,
        });
        setConflict(null);
        permissionDrafts.delete(scope);
      }
      setError("");
    },
  }));
  async function reviewMigration() {
    if (locked.current || record?.submission) return;
    locked.current = true;
    setError("");
    try {
      const preview = await call<Migration>("migration-preview");
      if (active.current) {
        setMigration(preview);
        setRecord({
          baseline: preview.proposed,
          draft: preview.proposed,
          revision: preview.policyRevision,
        });
        setAck(false);
        setMigrationOpen(true);
      }
    } catch (error) {
      if (active.current) setError(String(error));
    } finally {
      locked.current = false;
    }
  }
  const comparison =
    record && conflict
      ? policyComparison(
          record.baseline,
          record.draft,
          conflict.latest.policies,
        )
      : [];
  return (
    <>
      <SettingsHeading
        title="Permissions"
        action={
          (checkingOwner ||
            (owner && supported && (!legacy || record?.submission))) && (
            <Button
              variant="primary"
              disabled={
                checkingOwner ||
                !owner ||
                !dirty ||
                !online ||
                phase === "saving" ||
                phase === "checking" ||
                phase === "loading-latest" ||
                Boolean(record?.needsReview) ||
                Boolean(conflict)
              }
              onClick={() => void save()}
            >
              {(phase === "saving" || phase === "checking") && (
                <ActivityIndicator />
              )}
              {phase === "saving"
                ? "Saving…"
                : phase === "checking"
                  ? "Checking…"
                  : record?.submission
                    ? verifiedMissing
                      ? "Retry save"
                      : "Check save"
                    : "Save changes"}
            </Button>
          )
        }
      />
      {query.data && !supported && (
        <p role="status">
          This service needs an update to support role policies and atomic
          saving. Existing access rules remain active.
        </p>
      )}
      {legacy && supported && (
        <div className="settings-notice">
          <p>
            Existing access rules are still active. The Owner must review the
            access diff before moving to role policies.
          </p>
          {owner && (
            <Button
              disabled={Boolean(record?.submission)}
              onClick={() => void reviewMigration()}
            >
              Review access changes
            </Button>
          )}
        </div>
      )}
      {(!legacy || migration) && (
        <RoleTables
          policies={record?.draft ?? query.data?.catalog.rolePolicies ?? null}
          editable={
            project.role === "owner" && (!query.data || (owner && supported))
          }
          locked={lockedValues || legacy}
          pending={!query.data && query.loading}
          scope={scope}
          unavailable={!query.data && !!query.error}
          onChange={(draft) => {
            if (record) {
              setRecord({ ...record, draft, submission: undefined });
              setPhase("idle");
              setError("");
            }
          }}
        />
      )}
      {!query.data && query.error && (
        <p role="alert">
          {query.error}{" "}
          <Button onClick={() => void query.refresh()}>Retry</Button>
        </p>
      )}
      {query.extended && (
        <p>Still loading permissions. You can use the other settings.</p>
      )}
      {query.error && query.data && (
        <p role="alert">
          Couldn’t refresh permissions.{" "}
          <Button onClick={() => void query.refresh()}>Retry</Button>
        </p>
      )}
      {!online && dirty && (
        <p role="status">
          You’re offline. Your draft is kept. Reconnect, then save manually.
        </p>
      )}
      {lost && (
        <p role="status">
          Your editing access changed. Permissions are read-only.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {record?.needsReview && !conflict && owner && (
        <Button
          disabled={!online || phase === "loading-latest"}
          onClick={() => void loadLatest()}
        >
          {phase === "loading-latest"
            ? "Loading latest permissions…"
            : "Retry loading latest"}
        </Button>
      )}
      {phase === "saved" && <p role="status">Permissions saved.</p>}
      {record?.submission && phase === "retry" && owner && (
        <Button
          disabled={!online}
          onClick={() => {
            if (!locked.current) {
              locked.current = true;
              void reconcile(record.submission!).finally(() => {
                locked.current = false;
              });
            }
          }}
        >
          Check save outcome
        </Button>
      )}
      {(query.data?.catalog.resourceRules?.length ?? 0) > 0 && (
        <details>
          <summary>
            Retained file and source restrictions (
            {query.data!.catalog.resourceRules!.length})
          </summary>
          <p>
            Category access is an upper limit. These existing restrictions
            continue to apply to the people listed.
          </p>
          <ul>
            {query.data!.catalog.resourceRules!.map((rule) => (
              <li key={`${rule.resourceId}:${rule.userId}`}>
                {query.data?.catalog.members.find(
                  (member) => member.id === rule.userId,
                )?.name ?? `Member ${rule.userId.slice(0, 8)}`}{" "}
                · {rule.resourceId} · {rule.rule.mode}
              </li>
            ))}
          </ul>
        </details>
      )}
      {migrationOpen && migration && (
        <Overlay
          open
          title="Review role migration"
          className="settings-migration"
          onClose={() => setMigrationOpen(false)}
        >
          <h2>Review role migration</h2>
          <p>
            Every current non-owner stays a Member. Personal category exceptions
            will be replaced by the Member policy. Restricted files and sources,
            ENV rules, pending reviews, private drafts, local files, and queued
            changes are retained. Queued writes are checked again by the
            service.
          </p>
          <table>
            <thead>
              <tr>
                <th>Person / category</th>
                <th>Current access / additions</th>
                <th>After migration</th>
              </tr>
            </thead>
            <tbody>
              {migration.previous.members
                .filter((member) => member.role !== "owner")
                .flatMap((member) =>
                  ["instructions", ...categories].map((category) => {
                    const rule =
                      migration.previous.memberRules.find(
                        (rule) =>
                          rule.user_id === member.user_id &&
                          rule.class === category,
                      )?.rule ?? migration.previous.project.policy?.[category];
                    const key =
                      category === "instructions"
                        ? "memory"
                        : (category as keyof RolePolicies["member"]);
                    return (
                      <tr key={`${member.user_id}:${category}`}>
                        <td>
                          {query.data?.catalog.members.find(
                            (person) => person.id === member.user_id,
                          )?.name ?? member.user_id}{" "}
                          / {category}
                        </td>
                        <td>
                          {migration.previous.project.governed
                            ? `${rule?.mode ?? "legacy"} / ${rule?.create ?? "legacy"}`
                            : "Full legacy access"}
                        </td>
                        <td>{nameOf(migration.proposed.member[key])}</td>
                      </tr>
                    );
                  }),
                )}
            </tbody>
          </table>
          <p>
            {migration.previous.resourceRules.length} file/source rules and{" "}
            {migration.previous.pending.length} pending reviews retained.
            “Suggest changes” is a review workflow; any change to direct
            publication is shown above.
          </p>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={ack}
              onChange={(event) => setAck(event.target.checked)}
            />
            I reviewed the access changes for every current Member.
          </label>
          <div className="settings-confirm-actions">
            <Button onClick={() => setMigrationOpen(false)}>Stay</Button>
            <Button
              variant="primary"
              disabled={!ack || phase === "saving"}
              onClick={() => {
                setMigrationOpen(false);
                void save();
              }}
            >
              Confirm migration
            </Button>
          </div>
        </Overlay>
      )}
      {conflict && record && (
        <Overlay
          open
          title="Review latest permissions"
          className="settings-migration"
          onClose={() => setConflict(null)}
        >
          <h2>Review latest permissions</h2>
          <p>
            Your draft is kept. Unedited values follow the latest policy. Choose
            which value to keep for each conflict.
          </p>
          <table>
            <thead>
              <tr>
                <th>Category</th>
                <th>Before</th>
                <th>Your draft</th>
                <th>Latest</th>
                <th>Resolution</th>
              </tr>
            </thead>
            <tbody>
              {comparison.map((cell) => (
                <tr key={`${cell.role}:${cell.category}`}>
                  <td>
                    {cell.role} / {categoryNames[cell.category]}
                  </td>
                  <td>{nameOf(cell.before)}</td>
                  <td>{nameOf(cell.draft)}</td>
                  <td>{nameOf(cell.latest)}</td>
                  <td>
                    {cell.conflict ? (
                      <PermissionSelect
                        label={`Resolve ${cell.role} ${categoryNames[cell.category]}`}
                        value={
                          conflict.choices[`${cell.role}:${cell.category}`] ??
                          ""
                        }
                        placeholder="Choose"
                        options={[
                          { value: "draft", label: "Keep my edit" },
                          { value: "latest", label: "Use latest" },
                        ]}
                        onChange={(value) =>
                          setConflict({
                            ...conflict,
                            choices: {
                              ...conflict.choices,
                              [`${cell.role}:${cell.category}`]: value as
                                "draft" | "latest",
                            },
                          })
                        }
                      />
                    ) : cell.edited ? (
                      "Keep my edit"
                    ) : (
                      "Use latest"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="settings-confirm-actions">
            <Button onClick={() => setConflict(null)}>Stay</Button>
            <Button
              variant="primary"
              disabled={comparison.some(
                (cell) =>
                  cell.conflict &&
                  !conflict.choices[`${cell.role}:${cell.category}`],
              )}
              onClick={() => {
                const draft = structuredClone(conflict.latest.policies);
                for (const cell of comparison)
                  if (
                    cell.edited &&
                    (!cell.conflict ||
                      conflict.choices[`${cell.role}:${cell.category}`] ===
                        "draft")
                  )
                    draft[cell.role][cell.category] = cell.draft;
                setRecord({
                  baseline: conflict.latest.policies,
                  draft,
                  revision: conflict.latest.policyRevision,
                });
                setConflict(null);
                setPhase("idle");
                setError("");
              }}
            >
              Use reviewed values
            </Button>
          </div>
        </Overlay>
      )}
    </>
  );
});
