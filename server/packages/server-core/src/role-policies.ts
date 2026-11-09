import { z } from "zod";
import type { PoolClient } from "pg";
import {
  rolePolicies,
  defaultRolePolicies,
  uuid,
  type ReviewRequest,
} from "@portable/protocol";
import { Store, hash, HttpError } from "./store.js";
import { appendManagementLog } from "./management-log.js";

const scope = z.object({ projectId: uuid });
const versioned = scope.extend({
  expectedPolicyRevision: z.number().int().nonnegative(),
});

/** Only exact proposals that were pending in the confirmed migration diff qualify. */
export async function preservedReview(db: PoolClient, request: ReviewRequest) {
  return Boolean(
    (
      await db.query(
        "select 1 from orka.policy_migrations where project_id=$1 and previous->'pending' @> $2::jsonb",
        [
          request.projectId,
          JSON.stringify([
            {
              id: request.id,
              payload: {
                author: request.author,
                previewHash: request.previewHash,
                type: "change",
                policyRevision: request.policyRevision - 1,
              },
            },
          ]),
        ],
      )
    ).rowCount,
  );
}

async function legacySnapshot(db: PoolClient, projectId: string) {
  const project = (
    await db.query(
      "select governed,policy,policy_revision from orka.projects where id=$1",
      [projectId],
    )
  ).rows[0];
  const members = (
    await db.query(
      "select user_id,role from orka.members where project_id=$1 order by user_id",
      [projectId],
    )
  ).rows;
  const memberRules = (
    await db.query(
      "select user_id,class,rule from orka.member_policy where project_id=$1 order by user_id,class",
      [projectId],
    )
  ).rows;
  const resourceRules = (
    await db.query(
      "select user_id,resource_id,rule from orka.resource_access where project_id=$1 order by user_id,resource_id",
      [projectId],
    )
  ).rows;
  const pending = (
    await db.query(
      "select id,payload from orka.review_requests where project_id=$1 and payload->>'status'='pending' order by id",
      [projectId],
    )
  ).rows;
  return { project, members, memberRules, resourceRules, pending };
}

/** Runs inside the governance transaction, with the project row locked. */
export async function rolePolicyAction(
  store: Store,
  db: PoolClient,
  user: string,
  action: string,
  input: unknown,
) {
  const { projectId } = scope.passthrough().parse(input);
  const p = await store.permissions.project(db, projectId, user);
  if (action === "role-policy") {
    scope.strict().parse(input);
    return {
      policies: p.rolePolicies,
      policyRevision: p.policyRevision,
      role: p.role,
      owner: p.owner,
    };
  }
  if (action === "migration-preview") {
    scope.strict().parse(input);
    if (!p.owner)
      throw new HttpError(403, "Only the Owner can review migration");
    if (p.rolePolicies)
      throw new HttpError(409, "This project already uses role policies");
    const previous = await legacySnapshot(db, projectId);
    return {
      previous,
      migrationHash: hash(previous),
      proposed: defaultRolePolicies,
      retainedRestrictions: previous.resourceRules.filter(
        (r) => r.rule.mode !== "publish",
      ),
      policyRevision: p.policyRevision,
    };
  }
  if (action === "policy-operation") {
    const v = scope.extend({ operationId: uuid }).strict().parse(input);
    if (!p.owner)
      throw new HttpError(403, "Only the Owner can reconcile policy saves");
    const row = (
      await db.query(
        "select author,result from orka.policy_operations where project_id=$1 and operation_id=$2",
        [projectId, v.operationId],
      )
    ).rows[0];
    if (row && row.author !== user)
      throw new HttpError(403, "Operation access denied");
    return row
      ? { status: "committed", ...row.result }
      : { status: "not_found" };
  }
  if (action === "save-role-policy") {
    const v = versioned
      .extend({
        operationId: uuid,
        policies: rolePolicies,
        migrationHash: z.string().length(64).optional(),
      })
      .strict()
      .parse(input);
    if (!p.owner)
      throw new HttpError(403, "Only the Owner can change role policies");
    const prior = (
      await db.query(
        "select author,request_hash,result from orka.policy_operations where project_id=$1 and operation_id=$2",
        [projectId, v.operationId],
      )
    ).rows[0];
    if (prior) {
      if (prior.author !== user || prior.request_hash !== hash(v))
        throw new HttpError(409, "Operation ID reused with different choices");
      return prior.result;
    }
    if (v.expectedPolicyRevision !== p.policyRevision)
      throw new HttpError(409, "Permissions changed; review the latest values");
    if (!p.rolePolicies) {
      const previous = await legacySnapshot(db, projectId);
      if (!v.migrationHash || v.migrationHash !== hash(previous))
        throw new HttpError(
          409,
          "Review and confirm the current migration diff first",
        );
      await db.query(
        "insert into orka.policy_migrations(project_id,author,previous) values($1,$2,$3)",
        [projectId, user, previous],
      );
      await db.query(
        "delete from orka.member_policy where project_id=$1 and class <> 'env'",
        [projectId],
      );
      await db.query(
        "update orka.review_requests set payload=jsonb_set(payload,'{policyRevision}',to_jsonb($2::bigint)) where project_id=$1 and payload->>'status'='pending' and payload->>'type'='change' and (payload->>'policyRevision')::bigint=$3",
        [projectId, p.policyRevision + 1, p.policyRevision],
      );
    } else if (v.migrationHash)
      throw new HttpError(
        409,
        "Migration already completed; refresh permissions",
      );
    await db.query(
      "update orka.projects set governed=true,role_policies=$2,policy_revision=policy_revision+1 where id=$1",
      [projectId, v.policies],
    );
    const result = {
      operationId: v.operationId,
      policies: v.policies,
      policyRevision: p.policyRevision + 1,
    };
    await db.query(
      "insert into orka.policy_operations values($1,$2,$3,$4,$5)",
      [projectId, v.operationId, user, hash(v), result],
    );
    await appendManagementLog(
      db,
      projectId,
      { action: "permissions.updated", actor: user },
      true,
    );
    return result;
  }
  if (
    action === "member-role" ||
    action === "transfer-ownership" ||
    action === "leave-project"
  ) {
    const v = versioned
      .extend({
        userId: uuid.optional(),
        role: z.enum(["admin", "member"]).optional(),
      })
      .strict()
      .parse(input);
    if (v.expectedPolicyRevision !== p.policyRevision)
      throw new HttpError(409, "Membership changed; refresh and review again");
    if (action === "leave-project") {
      if (p.owner)
        throw new HttpError(403, "Transfer ownership before leaving");
      await db.query(
        "delete from orka.members where project_id=$1 and user_id=$2",
        [projectId, user],
      );
    } else {
      if (!p.owner)
        throw new HttpError(
          403,
          "Only the Owner can appoint Admins or transfer ownership",
        );
      if (!p.rolePolicies)
        throw new HttpError(409, "Review role migration first");
      if (!v.userId || v.userId === user)
        throw new HttpError(400, "Choose another current member");
      const target = (
        await db.query(
          "select role from orka.members where project_id=$1 and user_id=$2",
          [projectId, v.userId],
        )
      ).rows[0];
      if (!target || target.role === "owner")
        throw new HttpError(400, "Choose another current member");
      if (action === "transfer-ownership") {
        await db.query(
          "update orka.members set role='member' where project_id=$1 and user_id=$2",
          [projectId, user],
        );
        await db.query(
          "update orka.members set role='owner' where project_id=$1 and user_id=$2",
          [projectId, v.userId],
        );
        await db.query("update orka.projects set created_by=$2 where id=$1", [
          projectId,
          v.userId,
        ]);
      } else {
        if (!v.role) throw new HttpError(400, "Choose a role");
        await db.query(
          "update orka.members set role=$3 where project_id=$1 and user_id=$2",
          [projectId, v.userId, v.role],
        );
      }
    }
    await db.query(
      "update orka.projects set policy_revision=policy_revision+1 where id=$1",
      [projectId],
    );
    return { ok: true, policyRevision: p.policyRevision + 1 };
  }
  throw new HttpError(400, "Unknown role policy action");
}
