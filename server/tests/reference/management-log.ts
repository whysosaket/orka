import type { PoolClient } from "pg";
import type { ManagementLog } from "@portable/protocol";

export async function appendManagementLog(
  db: PoolClient,
  projectId: string,
  event: Omit<ManagementLog, "id" | "at" | "actorName" | "subjectName">,
  projectWide = false,
  key?: string,
) {
  const ids = [event.actor, event.subject].filter(Boolean);
  const profiles = (
    await db.query(
      "select user_id,label from orka.env_profiles where user_id=any($1::uuid[])",
      [ids],
    )
  ).rows;
  const name = (id: string) =>
    profiles.find((profile) => profile.user_id === id)?.label ??
    `Member ${id.slice(0, 8)}`;
  const payload = {
    ...event,
    at: new Date().toISOString(),
    actorName: event.actor ? name(event.actor) : "Orka",
    ...(event.subject ? { subjectName: name(event.subject) } : {}),
  };
  await db.query(
    "insert into orka.management_logs(project_id,actor,subject,project_wide,dedupe_key,payload) values($1,$2,$3,$4,$5,$6) on conflict(project_id,dedupe_key) do nothing",
    [
      projectId,
      event.actor ?? null,
      event.subject ?? null,
      projectWide,
      key ?? null,
      payload,
    ],
  );
}
