import { remoteKey } from "./profiles.js";
import { appendManagementLog } from "./management-log.js";
import { z } from "zod";
import { uuid } from "@portable/protocol";
import { Store, HttpError, hash } from "./store.js";

const mutation = z
  .object({
    requestId: uuid,
    projectId: uuid,
    action: z.enum(["archive", "restore", "delete", "rename"]),
    expectedRevision: z.number().int().nonnegative(),
    confirmation: z.string().max(100).optional(),
    name: z.string().trim().min(1).max(100).optional(),
  })
  .strict()
  .refine(
    (input) => (input.action === "rename") === (input.name !== undefined),
    {
      message: "A name is required only when renaming a project",
    },
  );

export async function listProjects(
  store: Store,
  user: string,
  archived = false,
) {
  return (
    await store.pool.query(
      `select p.id,p.name,p.revision,m.role,p.remote_key as "remoteKey",p.last_sync_at as "lastSyncAt",p.archived_at as "archivedAt",
      p.lifecycle_revision as "lifecycleRevision",p.governed,p.policy_revision as "policyRevision",p.role_policies as "rolePolicies",p.source_model as "sourceModel",
      coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'name',s.name) order by s.name,s.id) from orka.project_sources s where s.project_id=p.id),'[]'::jsonb) as sources
     from orka.projects p join orka.members m on m.project_id=p.id
     where m.user_id=$1 and ($2 or p.archived_at is null) order by p.name`,
      [user, archived],
    )
  ).rows.map((r) => ({
    ...r,
    revision: Number(r.revision),
    lifecycleRevision: Number(r.lifecycleRevision),
    policyRevision: Number(r.policyRevision),
  }));
}

export async function cleanupProjectBlobs(store: Store) {
  for (const row of (
    await store.pool.query("select project_id from orka.project_blob_cleanup")
  ).rows) {
    try {
      await store.blobs.removeProject(row.project_id);
      await store.pool.query(
        "delete from orka.project_blob_cleanup where project_id=$1",
        [row.project_id],
      );
    } catch {
      // The project is already inaccessible. Keep the durable job for the next retry.
      console.error("project_blob_cleanup_pending");
    }
  }
}

export async function mutateProject(store: Store, user: string, raw: unknown) {
  if (
    typeof raw === "object" &&
    raw !== null &&
    "action" in raw &&
    raw.action === "set-remote"
  ) {
    const input = z
      .object({ action: z.literal("set-remote"), projectId: uuid, remoteKey })
      .strict()
      .parse(raw);
    return store.transaction(async (db) => {
      const project = (
        await db.query(
          "select id,remote_key from orka.projects where id=$1 for update",
          [input.projectId],
        )
      ).rows[0];
      const owner = await db.query(
        "select 1 from orka.members where project_id=$1 and user_id=$2 and role='owner'",
        [input.projectId, user],
      );
      if (!project || !owner.rowCount)
        throw new HttpError(403, "Only project owners can set the remote key");
      if (project.remote_key !== null)
        throw new HttpError(409, "Project remote key is already set");
      await db.query("update orka.projects set remote_key=$2 where id=$1", [
        input.projectId,
        input.remoteKey,
      ]);
      await appendManagementLog(
        db,
        input.projectId,
        { action: "project.remote_set", actor: user },
        true,
      );
      return { ok: true };
    });
  }
  const input = mutation.parse(raw);
  const result = await store.transaction(async (db) => {
    await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `project:${user}:${input.requestId}`,
    ]);
    const prior = (
      await db.query(
        "select request_hash,payload from orka.project_receipts where author=$1 and id=$2",
        [user, input.requestId],
      )
    ).rows[0];
    if (prior) {
      if (prior.request_hash !== hash(input))
        throw new HttpError(409, "Retry ID reused with different content");
      return prior.payload;
    }
    const project = (
      await db.query("select * from orka.projects where id=$1 for update", [
        input.projectId,
      ])
    ).rows[0];
    const owner = await db.query(
      "select 1 from orka.members where project_id=$1 and user_id=$2 and role='owner'",
      [input.projectId, user],
    );
    if (!project || !owner.rowCount)
      throw new HttpError(
        403,
        "Only project owners can rename, archive, restore, or delete cloud projects",
      );
    if (Number(project.lifecycle_revision) !== input.expectedRevision)
      throw new HttpError(409, "Project changed; refresh and review it again");
    if (input.action === "rename") {
      if (project.archived_at)
        throw new HttpError(409, "Restore the project before renaming it");
      await db.query(
        "update orka.projects set name=$2,lifecycle_revision=lifecycle_revision+1 where id=$1",
        [input.projectId, input.name],
      );
    } else if (input.action === "delete") {
      if (input.confirmation !== project.name)
        throw new HttpError(400, "Type the project name to confirm deletion");
      await db.query(
        "insert into orka.project_blob_cleanup values($1) on conflict do nothing",
        [input.projectId],
      );
      await db.query("delete from orka.projects where id=$1", [
        input.projectId,
      ]);
    } else {
      const archived = input.action === "archive";
      if (Boolean(project.archived_at) === archived)
        throw new HttpError(
          409,
          "Project changed; refresh and review it again",
        );
      await db.query(
        "update orka.projects set archived_at=case when $2 then now() else null end,lifecycle_revision=lifecycle_revision+1 where id=$1",
        [input.projectId, archived],
      );
      // Outstanding invites must not become usable again after restoration.
      if (archived)
        await db.query("delete from orka.invites where project_id=$1", [
          input.projectId,
        ]);
    }
    const receipt = {
      projectId: input.projectId,
      action: input.action,
      lifecycleRevision: input.expectedRevision + 1,
      ...(input.action === "rename" ? { name: input.name } : {}),
    };
    await db.query("insert into orka.project_receipts values($1,$2,$3,$4)", [
      user,
      input.requestId,
      hash(input),
      receipt,
    ]);
    return receipt;
  });
  if (input.action === "delete") await cleanupProjectBlobs(store);
  return result;
}
