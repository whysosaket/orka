import React, { useCallback, useEffect, useState } from "react";
import type { ManagementLog } from "@portable/protocol";
import { HistoryIcon } from "@primer/octicons-react";
import { Button } from "./button.js";
import { displayText } from "./resource-presentation.js";
import { visibleManagementLog } from "../lib/features.js";
import {
  accessNames,
  permissionSections,
  type ProjectCall,
} from "./project-permissions.js";

function description(entry: ManagementLog) {
  const actor = displayText(entry.actorName),
    subject = displayText(entry.subjectName ?? "a member");
  const category =
    permissionSections.find((section) =>
      section.classes.includes(entry.category!),
    )?.label ?? "project content";
  switch (entry.action) {
    case "request.created":
      return entry.requestType === "access"
        ? `${actor} requested ${entry.mode ? accessNames[entry.mode].toLowerCase() : "access"} for ${category.toLowerCase()}`
        : `${actor} submitted changes for review`;
    case "request.approved":
      return `${actor} approved ${subject}'s request`;
    case "request.rejected":
      return `${actor} rejected ${subject}'s request`;
    case "request.stale":
      return `${actor} reviewed ${subject}'s request; it needs to be refreshed`;
    case "request.recorded":
      return `Earlier ${entry.status ?? "pending"} request for ${subject} recorded${entry.actor !== entry.subject ? `; reviewed by ${actor}` : ""}`;
    case "permissions.updated":
      return `${actor} updated ${entry.subject ? `${subject}'s` : "default member"} access to ${category.toLowerCase()}${entry.mode ? `: ${accessNames[entry.mode]}` : ""}${entry.canAdd ? ", can add new items" : ""}`;
    case "permissions.reset":
      return `${actor} restored ${subject}'s project defaults`;
    case "permissions.enabled":
      return `${actor} enabled project permissions`;
    case "permissions.sharing_locked":
      return "Orka limited sharing management to project owners";
    case "member.removed":
      return `${actor} removed ${subject} from the project`;
    case "member.joined":
      return `${actor} joined the project`;
    case "project.created":
      return `${actor} created the project`;
    case "invite.created":
      return `${actor} created a member invitation`;
    case "access.granted":
      return `${actor} updated access for ${subject}`;
    case "env.replaced":
      return `${actor} replaced an ENV set`;
  }
}
export function ProjectLogs({ call }: { call: ProjectCall }) {
  const [items, setItems] = useState<ManagementLog[]>([]),
    [next, setNext] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const load = useCallback(
    async (before?: string) => {
      setBusy(true);
      setError("");
      try {
        const page = await call<{
          items: ManagementLog[];
          next: string | null;
        }>("logs", { limit: 25, ...(before ? { before } : {}) });
        const visible = page.items.filter(visibleManagementLog);
        setItems((current) =>
          before
            ? [
                ...current,
                ...visible.filter(
                  (item) =>
                    !current.some((existing) => existing.id === item.id),
                ),
              ]
            : visible,
        );
        setNext(page.next);
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [call],
  );
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <section className="management-logs" aria-label="Activity logs">
      <div className="management-heading">
        <div>
          <h3>Activity logs</h3>
          <p>
            Requests, decisions, and access changes saved to your project in the
            cloud.
          </p>
        </div>
        <Button
          size="sm"
          variant="tertiary"
          disabled={busy}
          onClick={() => void load()}
        >
          Refresh logs
        </Button>
      </div>
      {error && <p role="alert">{error}</p>}
      {!busy && !error && !next && items.length === 0 && (
        <p>No activity recorded yet.</p>
      )}
      <div className="management-log-list">
        {items.map((entry) => (
          <article key={entry.id} className="management-log-entry">
            <HistoryIcon size={16} aria-hidden="true" />
            <div>
              <p>{description(entry)}</p>
              <time dateTime={entry.at}>
                {new Date(entry.at).toLocaleString()}
                {entry.action === "request.recorded"
                  ? " · Historical record"
                  : ""}
              </time>
            </div>
          </article>
        ))}
      </div>
      {busy && <p role="status">Loading logs…</p>}
      {next && (
        <Button
          disabled={busy}
          size="sm"
          variant="secondary"
          onClick={() => void load(next)}
        >
          View more logs
        </Button>
      )}
    </section>
  );
}
