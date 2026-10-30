import React, { useState } from "react";
import { useToastNotice } from "./toasts.js";
import type { ClassRule, ProjectRules } from "@portable/protocol";
import { PermissionSelect } from "./permission-select.js";
import { Button } from "./button.js";
import {
  accessNames,
  accessModes,
  memberRule,
  permissionSections,
  type GovernanceCatalog,
  type ProjectCall,
} from "./project-permissions.js";

type Category = keyof ProjectRules;
type Changes = Partial<Record<Category, ClassRule | null>>;
const same = (a: ClassRule, b: ClassRule) =>
  a.mode === b.mode && a.create === b.create && a.canShare === b.canShare;

export function MemberPermissions({
  catalog,
  member,
  name,
  call,
  onSaved,
  disabled,
}: {
  catalog: GovernanceCatalog;
  member: string;
  name: string;
  call: ProjectCall;
  onSaved: () => Promise<void>;
  disabled: boolean;
}) {
  const [changes, setChanges] = useState<Changes>({});
  const [reviewRevision, setReviewRevision] = useState<number | null>(null);
  const review = reviewRevision !== null;
  const reviewStale = review && reviewRevision !== catalog.policyRevision;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const setMessage = useToastNotice();
  const current = (category: Category) =>
    category in changes
      ? (changes[category] ?? catalog.policy[category])
      : memberRule(catalog, member, category);
  const edit = (classes: Category[], patch: Partial<ClassRule>) => {
    setReviewRevision(null);
    setMessage("");
    setChanges((previous) => {
      const next = { ...previous };
      for (const category of classes) {
        const value = {
          ...(category in previous
            ? (previous[category] ?? catalog.policy[category])
            : memberRule(catalog, member, category)),
          ...patch,
        };
        if (same(value, memberRule(catalog, member, category)))
          delete next[category];
        else next[category] = value;
      }
      return next;
    });
  };
  const save = async () => {
    if (reviewRevision === null || reviewStale) return;
    setBusy(true);
    setError("");
    setMessage("");
    let revision = reviewRevision;
    let saved = 0;
    try {
      for (const [category, rule] of Object.entries(changes)) {
        const result = await call<{ policyRevision: number }>(
          rule === null ? "inherit" : "policy",
          {
            class: category,
            ...(member ? { userId: member } : {}),
            ...(rule === null ? {} : { rule }),
            expectedPolicyRevision: revision,
          },
        );
        revision = result.policyRevision;
        saved++;
        setChanges((previous) => {
          const next = { ...previous };
          delete next[category as Category];
          return next;
        });
      }
      setMessage("Permissions saved.");
    } catch (e) {
      setError(
        `${saved ? "Some permissions were saved. " : ""}${String(e)} Review the current permissions before saving remaining changes.`,
      );
    } finally {
      setReviewRevision(null);
      try {
        await onSaved();
      } catch (e) {
        setError(`Could not refresh permissions: ${String(e)}`);
      }
      setBusy(false);
    }
  };
  const locked = busy || disabled;
  const dirty = Object.keys(changes).length > 0;
  return (
    <section className="member-permissions" aria-label={`${name} permissions`}>
      <div className="management-heading">
        <div>
          <h3>{name}</h3>
          <p>
            {member
              ? "Set access for each part of the project."
              : "Defaults apply to members without individual settings."}
          </p>
        </div>
      </div>
      <div className="permission-grid">
        {permissionSections.map((section) => {
          const rules = section.classes.map(current);
          const mode = rules.every((rule) => rule.mode === rules[0].mode)
            ? rules[0].mode
            : "mixed";
          const custom =
            member &&
            section.classes.some((category) =>
              catalog.memberRules.some(
                (rule) => rule.userId === member && rule.class === category,
              ),
            );
          const options = [
            ...(mode === "mixed"
              ? [
                  {
                    value: "mixed",
                    label: "Different settings",
                    disabled: true,
                  },
                ]
              : []),
            ...accessModes
              .filter((value) => section.id !== "env" || value !== "suggest")
              .map((value) => ({ value, label: accessNames[value] })),
            ...(section.id === "env" && mode === "suggest"
              ? [{ value: "suggest", label: "View only", disabled: true }]
              : []),
          ];
          return (
            <section
              className="permission-card"
              key={section.id}
              aria-label={`${section.label} permissions`}
            >
              <div className="permission-card-heading">
                <h4>{section.label}</h4>
                {member && (
                  <span className="management-meta">
                    {custom ? "Custom" : "Default"}
                  </span>
                )}
              </div>
              <PermissionSelect
                label={`${section.label} access`}
                value={mode}
                options={options}
                disabled={locked}
                onChange={(value) => {
                  const nextMode = value as ClassRule["mode"];
                  edit(section.classes, {
                    mode: nextMode,
                    canShare: false,
                    ...(nextMode === "hidden"
                      ? { create: "hidden" as const }
                      : {}),
                  });
                }}
              />
              {[
                ...(section.id === "env" ? [] : ["suggest" as const]),
                "publish" as const,
              ].map((creation) => {
                const label =
                  creation === "suggest"
                    ? "Can suggest new items"
                    : "Can add new items";
                const checked = rules.every((rule) => rule.create === creation);
                return (
                  <label className="check permission-add" key={creation}>
                    <input
                      type="checkbox"
                      aria-label={`${section.label}: ${label.toLowerCase()}`}
                      title={
                        creation === "suggest"
                          ? "New items need approval before they are shared."
                          : "New items can be shared without approval."
                      }
                      checked={checked}
                      ref={(input) => {
                        if (input)
                          input.indeterminate =
                            !checked &&
                            rules.some((rule) => rule.create === creation);
                      }}
                      disabled={
                        locked || rules.some((rule) => rule.mode === "hidden")
                      }
                      onChange={(event) =>
                        edit(section.classes, {
                          create: event.target.checked ? creation : "hidden",
                          canShare: false,
                        })
                      }
                    />
                    {label}
                  </label>
                );
              })}
              {custom && (
                <Button
                  size="sm"
                  variant="tertiary"
                  className="permission-reset"
                  disabled={locked}
                  onClick={() => {
                    setReviewRevision(null);
                    setChanges((previous) => {
                      const next = { ...previous };
                      for (const category of section.classes)
                        if (
                          catalog.memberRules.some(
                            (rule) =>
                              rule.userId === member && rule.class === category,
                          )
                        )
                          next[category] = null;
                      return next;
                    });
                  }}
                >
                  Use default
                </Button>
              )}
            </section>
          );
        })}
      </div>
      {error && <p role="alert">{error}</p>}
      {review && (
        <section
          className="permission-review"
          aria-label="Review permission changes"
        >
          <h4>Review changes for {name}</h4>
          <p>
            These changes affect shared project content. Local personal files
            stay writable.
          </p>
          {permissionSections
            .filter((section) =>
              section.classes.some((category) => category in changes),
            )
            .map((section) => (
              <div key={section.id}>
                <strong>{section.label}</strong>
                {section.classes
                  .filter((category) => category in changes)
                  .map((category) => (
                    <p key={category}>
                      {section.classes.length > 1
                        ? `${category === "instructions" ? "Project memory files" : "Learned memory"}: `
                        : ""}
                      {accessNames[memberRule(catalog, member, category).mode]}{" "}
                      → {accessNames[current(category).mode]} ·{" "}
                      {current(category).create === "publish"
                        ? "Can add new items"
                        : current(category).create === "suggest"
                          ? "Can suggest new items (approval required)"
                          : "Cannot add or suggest new items"}
                      {changes[category] === null
                        ? " · Use project default"
                        : ""}
                    </p>
                  ))}
              </div>
            ))}
          {reviewStale && (
            <p role="alert">
              Permissions changed after this review. Review changes again before
              saving.
            </p>
          )}
          <Button disabled={locked || reviewStale} onClick={() => void save()}>
            {busy ? "Saving…" : "Save permissions"}
          </Button>
        </section>
      )}
      <div className="actions">
        <Button
          disabled={locked || !dirty}
          onClick={() => setReviewRevision(catalog.policyRevision)}
          variant={review ? "tertiary" : "primary"}
        >
          Review changes
        </Button>
        {dirty && (
          <Button
            variant="tertiary"
            disabled={locked}
            onClick={() => {
              setChanges({});
              setReviewRevision(null);
              setError("");
            }}
          >
            Discard changes
          </Button>
        )}
      </div>
    </section>
  );
}
