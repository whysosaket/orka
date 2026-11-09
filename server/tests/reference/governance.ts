import { appendManagementLog } from "./management-log.js";
import { rolePolicyAction, preservedReview } from "./role-policies.js";
import { z } from "zod";
import type { PoolClient } from "pg";
import {
  accessMode,
  accessRank,
  accessRule,
  classRule,
  change,
  policyClasses,
  policyClassSchema,
  projectRules,
  resourceInput,
  uuid,
  type Event,
  type PolicyClass,
  type ResourceInput,
  type ReviewRequest,
} from "@portable/protocol";
import { Store, HttpError, hash } from "./store.js";

const scope = z.object({ projectId: uuid });
const revision = z.number().int().nonnegative();
const versioned = scope.extend({ expectedPolicyRevision: revision });

async function target(
  store: Store,
  db: PoolClient,
  project: string,
  id: string,
): Promise<ResourceInput & { owner?: string }> {
  const resource = await store.permissions.resource(db, project, id);
  if (resource) return resource;
  const env = (
    await db.query(
      "select header from orka.env_sets where project_id=$1 and id=$2",
      [project, id],
    )
  ).rows[0];
  if (!env) throw new HttpError(404, "Resource unavailable");
  return {
    resourceId: id,
    kind: "memory",
    source: "shared",
    logicalPath: "env/" + id,
    title: "ENV set",
    files: [],
    deleted: false,
    owner: env.header.manifest.creator,
  };
}
function envTarget(resource: ResourceInput & { owner?: string }) {
  return resource.logicalPath.startsWith("env/")
    ? { ...resource, kind: "env" }
    : resource;
}
async function reviewer(
  store: Store,
  db: PoolClient,
  user: string,
  request: ReviewRequest,
  content: Record<string, unknown>,
) {
  if (request.type === "change")
    return store.permissions.canReview(
      user,
      request.projectId,
      content.resource as ResourceInput,
      db,
    );
  if (request.requestedClass)
    return (await store.permissions.project(db, request.projectId, user)).owner;
  await target(store, db, request.projectId, request.resourceId);
  return (await store.permissions.project(db, request.projectId, user)).owner;
}
async function requestRows(
  store: Store,
  db: PoolClient,
  user: string,
  project: string,
) {
  const result = [];
  const policy = await store.permissions.project(db, project, user);
  for (const row of (
    await db.query(
      "select payload,content from orka.review_requests where project_id=$1 order by payload->>'createdAt' desc",
      [project],
    )
  ).rows) {
    const request = row.payload as ReviewRequest;
    const canReview = await reviewer(store, db, user, request, row.content);
    if (user !== request.author && !canReview) continue;
    const existing = request.requestedClass
      ? null
      : await store.permissions.resource(db, project, request.resourceId);
    const hidden = Boolean(
      existing &&
      !(await store.permissions.canRead(user, project, request.resourceId, db)),
    );
    if (hidden && user !== request.author) continue;
    const stale =
      request.status === "pending" &&
      (request.policyRevision !== policy.policyRevision ||
        (request.type === "change" &&
          (existing?.revision ?? 0) !== request.baseRevision) ||
        hidden);
    const status = stale ? "stale" : request.status;
    const seen = (
      await db.query(
        "select preview_hash from orka.notification_reads where project_id=$1 and user_id=$2 and request_id=$3",
        [project, user, request.id],
      )
    ).rows[0]?.preview_hash;
    result.push({
      ...request,
      title: hidden ? "Resource access changed" : request.title,
      status,
      canReview: canReview && !stale,
      unread: seen !== request.previewHash + ":" + status,
    });
  }
  return result;
}
async function setAccess(
  store: Store,
  db: PoolClient,
  user: string,
  project: string,
  id: string,
  recipient: string,
  rule: z.infer<typeof accessRule>,
) {
  const p = await store.permissions.project(db, project, user);
  const r = envTarget(await target(store, db, project, id));
  if (!p.owner)
    throw new HttpError(403, "Only project owners can manage sharing");
  const member = (
    await db.query(
      "select role from orka.members where project_id=$1 and user_id=$2",
      [project, recipient],
    )
  ).rows[0];
  if (!member || member.role === "owner")
    throw new HttpError(400, "Choose a current non-owner member");
  // A derivative cannot be granted a broader audience than its known sources.
  if (rule.mode !== "hidden")
    for (const source of r.contextSources ?? [])
      if (!(await store.permissions.canRead(recipient, project, source, db)))
        throw new HttpError(403, "Grant access to the source context first");
  await store.permissions.setRule(db, project, id, recipient, rule);
  await db.query(
    "update orka.projects set policy_revision=policy_revision+1 where id=$1",
    [project],
  );
}

export async function governanceAction(
  store: Store,
  user: string,
  raw: unknown,
): Promise<unknown> {
  const { action, input } = z
    .object({ action: z.string(), input: z.unknown() })
    .strict()
    .parse(raw);
  const { projectId } = scope.passthrough().parse(input);
  return store.transaction(async (db) => {
    await db.query("select id from orka.projects where id=$1 for update", [
      projectId,
    ]);
    const p = await store.permissions.project(db, projectId, user);
    if (
      [
        "role-policy",
        "save-role-policy",
        "policy-operation",
        "migration-preview",
        "member-role",
        "transfer-ownership",
        "leave-project",
      ].includes(action)
    )
      return rolePolicyAction(store, db, user, action, input);
    if (
      p.rolePolicies &&
      [
        "activate",
        "policy",
        "inherit",
        "access",
        "sharing-lock",
        "request-access",
      ].includes(action)
    )
      throw new HttpError(
        409,
        "This project uses role policies. Review Permissions in Settings.",
      );
    const owner = () => {
      if (!p.owner)
        throw new HttpError(
          403,
          "Only project owners can change project permissions",
        );
    };
    const current = (expected: number) => {
      if (expected !== p.policyRevision)
        throw new HttpError(
          409,
          "Permissions changed; refresh and review again",
        );
    };
    if (action === "logs") {
      const v = scope
        .extend({
          before: z.string().regex(/^\d+$/).optional(),
          limit: z.number().int().min(1).max(100).default(25),
        })
        .strict()
        .parse(input);
      const rows = (
        await db.query(
          "select id::text,payload from orka.management_logs where project_id=$1 and ($2 or project_wide or actor=$3 or subject=$3) and ($4::bigint is null or id<$4::bigint) order by id desc limit $5",
          [projectId, p.owner, user, v.before ?? null, v.limit + 1],
        )
      ).rows;
      const items = rows
        .slice(0, v.limit)
        .map((row) => ({ ...row.payload, id: row.id }));
      return { items, next: rows.length > v.limit ? items.at(-1)?.id : null };
    }
    if (action === "catalog") {
      scope.strict().parse(input);
      const members = (
        await db.query(
          `select m.user_id as id,m.role,coalesce(profile.display_name,p.label,'Member ' || left(m.user_id::text,8)) as name,p.email,profile.display_name as "displayName",profile.avatar_url as "avatarUrl",profile.avatar_data as "avatarData"
           from orka.members m left join orka.env_profiles p on p.user_id=m.user_id left join orka.profiles profile on profile.user_id=m.user_id
           where m.project_id=$1 order by m.role,name,m.user_id`,
          [projectId],
        )
      ).rows;
      const access: Record<string, unknown> = {};
      for (const category of policyClasses)
        access[category] = await store.permissions.access(
          user,
          projectId,
          {
            resourceId: projectId,
            kind: category === "instructions" ? "memory" : category,
            source: "shared",
            logicalPath:
              category === "instructions" ? "instructions/AGENTS.md" : "",
          },
          db,
        );
      return {
        ...p,
        access,
        members,
        memberRules: p.owner
          ? (
              await db.query(
                'select user_id as "userId",class,rule from orka.member_policy where project_id=$1',
                [projectId],
              )
            ).rows
          : [],
        resourceRules:
          p.owner || Boolean(p.rolePolicies)
            ? (
                await db.query(
                  'select resource_id as "resourceId",user_id as "userId",rule from orka.resource_access where project_id=$1 and (user_id=$2 or $3)',
                  [projectId, user, p.owner],
                )
              ).rows
            : [],
        resourceCount: p.owner
          ? Number(
              (
                await db.query(
                  "select count(*) from orka.resources where project_id=$1",
                  [projectId],
                )
              ).rows[0].count,
            )
          : 0,
        envSets: p.owner
          ? (
              await db.query(
                "select id as \"resourceId\",header->'manifest'->>'name' as title from orka.env_sets where project_id=$1 and header->'manifest'->>'deleted'='false'",
                [projectId],
              )
            ).rows
          : [],
        requests: await requestRows(store, db, user, projectId),
      };
    }
    if (action === "activate") {
      const v = versioned.extend({ rules: projectRules }).strict().parse(input);
      owner();
      current(v.expectedPolicyRevision);
      if (Object.values(v.rules).some((rule) => rule.canShare))
        throw new HttpError(400, "Only project owners manage sharing");
      if (p.governed)
        throw new HttpError(409, "Project already uses resource permissions");
      await db.query(
        "update orka.projects set governed=true,policy=$2,policy_revision=policy_revision+1 where id=$1",
        [projectId, v.rules],
      );
      await appendManagementLog(
        db,
        projectId,
        { action: "permissions.enabled", actor: user },
        true,
      );
      return { governed: true, policyRevision: p.policyRevision + 1 };
    }
    if (!p.governed)
      throw new HttpError(409, "Activate resource permissions first");
    if (action === "policy") {
      const v = versioned
        .extend({
          class: policyClassSchema,
          userId: uuid.optional(),
          rule: classRule,
        })
        .strict()
        .parse(input);
      owner();
      if (v.rule.canShare)
        throw new HttpError(400, "Only project owners manage sharing");
      current(v.expectedPolicyRevision);
      if (v.userId) {
        if (
          !(
            await db.query(
              "select 1 from orka.members where project_id=$1 and user_id=$2 and role='member'",
              [projectId, v.userId],
            )
          ).rowCount
        )
          throw new HttpError(400, "Choose a current member");
        await db.query(
          "insert into orka.member_policy values($1,$2,$3,$4) on conflict(project_id,user_id,class) do update set rule=excluded.rule",
          [projectId, v.userId, v.class, v.rule],
        );
      } else
        await db.query("update orka.projects set policy=$2 where id=$1", [
          projectId,
          { ...p.policy, [v.class]: v.rule },
        ]);
      await db.query(
        "update orka.projects set policy_revision=policy_revision+1 where id=$1",
        [projectId],
      );
      await appendManagementLog(
        db,
        projectId,
        {
          action: "permissions.updated",
          actor: user,
          ...(v.userId ? { subject: v.userId } : {}),
          category: v.class,
          mode: v.rule.mode,
          canAdd: v.rule.create !== "hidden",
        },
        !v.userId,
      );
      return { policyRevision: p.policyRevision + 1 };
    }
    if (action === "inherit") {
      const v = versioned
        .extend({
          userId: uuid,
          class: policyClassSchema.optional(),
          resourceId: uuid.optional(),
        })
        .strict()
        .parse(input);
      owner();
      current(v.expectedPolicyRevision);
      if (Boolean(v.class) === Boolean(v.resourceId))
        throw new HttpError(400, "Choose one permission override");
      if (v.class)
        await db.query(
          "delete from orka.member_policy where project_id=$1 and user_id=$2 and class=$3",
          [projectId, v.userId, v.class],
        );
      else
        await db.query(
          "delete from orka.resource_access where project_id=$1 and user_id=$2 and resource_id=$3",
          [projectId, v.userId, v.resourceId],
        );
      await db.query(
        "update orka.projects set policy_revision=policy_revision+1 where id=$1",
        [projectId],
      );
      await appendManagementLog(db, projectId, {
        action: "permissions.reset",
        actor: user,
        subject: v.userId,
        ...(v.class ? { category: v.class } : {}),
      });
      return { policyRevision: p.policyRevision + 1 };
    }
    if (action === "access") {
      const v = versioned
        .extend({ resourceId: uuid, userId: uuid, rule: accessRule })
        .strict()
        .parse(input);
      owner();
      if (v.rule.canShare)
        throw new HttpError(400, "Only project owners manage sharing");
      current(v.expectedPolicyRevision);
      await setAccess(
        store,
        db,
        user,
        projectId,
        v.resourceId,
        v.userId,
        v.rule,
      );
      await appendManagementLog(db, projectId, {
        action: "access.granted",
        actor: user,
        subject: v.userId,
        mode: v.rule.mode,
      });
      return { policyRevision: p.policyRevision + 1 };
    }
    if (action === "resource") {
      const v = scope.extend({ resourceId: uuid }).strict().parse(input);
      const r = envTarget(await target(store, db, projectId, v.resourceId));
      const access = await store.permissions.require(
        user,
        projectId,
        r,
        "read",
        db,
      );
      return {
        access,
        rules: access.canShare
          ? (
              await db.query(
                'select user_id as "userId",rule from orka.resource_access where project_id=$1 and resource_id=$2',
                [projectId, v.resourceId],
              )
            ).rows
          : [],
      };
    }
    if (action === "submit") {
      const v = scope.extend({ change }).strict().parse(input);
      if (v.change.projectId !== projectId)
        throw new HttpError(400, "Project mismatch");
      const prior = (
        await db.query(
          "select * from orka.review_requests where project_id=$1 and id=$2",
          [projectId, v.change.id],
        )
      ).rows[0];
      if (prior) {
        if (prior.author !== user || prior.request_hash !== hash(v))
          throw new HttpError(409, "Retry ID reused with different content");
        const existing = await store.permissions.resource(
          db,
          projectId,
          v.change.resource.resourceId,
        );
        await store.permissions.require(
          user,
          projectId,
          existing ?? v.change.resource,
          "suggest",
          db,
          !existing,
        );
        if (
          !(await store.permissions.requestReadable(
            user,
            projectId,
            prior.payload,
            prior.content.resource,
            db,
          ))
        )
          throw new HttpError(403, "Request access denied");
        return prior.payload;
      }
      const preview = await store.changeInTransaction(db, user, v.change, {
        preview: true,
      });
      if (preview.conflict)
        throw new HttpError(
          409,
          "Resolve the session conflict before suggesting changes",
        );
      const prepared = resourceInput.strip().parse(preview.event.resource);
      const existing = await store.permissions.resource(
        db,
        projectId,
        prepared.resourceId,
      );
      const content = {
        change: { ...v.change, baseRevision: existing?.revision ?? 0 },
        resource: prepared,
      };
      const request: ReviewRequest = {
        id: v.change.id,
        projectId,
        author: user,
        type: "change",
        resourceId: prepared.resourceId,
        title: prepared.title,
        status: "pending",
        baseRevision: existing?.revision ?? 0,
        policyRevision: p.policyRevision,
        previewHash: hash(prepared),
        createdAt: new Date().toISOString(),
      };
      await db.query(
        "insert into orka.review_requests values($1,$2,$3,$4,$5,$6)",
        [projectId, request.id, user, hash(v), request, content],
      );
      await appendManagementLog(
        db,
        projectId,
        {
          action: "request.created",
          actor: user,
          subject: user,
          requestId: request.id,
          requestType: "change",
        },
        false,
        `created:${request.id}`,
      );
      return request;
    }
    if (action === "request-access") {
      const v = scope
        .extend({
          id: uuid,
          resourceId: uuid.optional(),
          class: policyClassSchema.optional(),
          mode: accessMode.exclude(["hidden"]),
        })
        .strict()
        .refine(
          (value) => Boolean(value.resourceId) !== Boolean(value.class),
          "Choose a file or category",
        )
        .parse(input);
      if (v.resourceId) await target(store, db, projectId, v.resourceId);
      if (v.class === "env" && v.mode === "suggest")
        throw new HttpError(
          400,
          "ENV access requests must request read or publish access",
        );
      const request: ReviewRequest = {
        id: v.id,
        projectId,
        author: user,
        type: "access",
        resourceId: v.resourceId ?? projectId,
        ...(v.class ? { requestedClass: v.class } : {}),
        title: v.class
          ? `${{ instructions: "Memories", memory: "Memories", skill: "Skills", plan: "Plans", session: "Sessions", env: "ENV sets" }[v.class]} access request`
          : "Resource access request",
        status: "pending",
        baseRevision: 0,
        policyRevision: p.policyRevision,
        previewHash: hash(v),
        requestedMode: v.mode,
        createdAt: new Date().toISOString(),
      };
      const inserted = await db.query(
        "insert into orka.review_requests values($1,$2,$3,$4,$5,$6) on conflict do nothing returning id",
        [projectId, v.id, user, hash(v), request, {}],
      );
      if (!inserted.rowCount) {
        const old = (
          await db.query(
            "select * from orka.review_requests where project_id=$1 and id=$2",
            [projectId, v.id],
          )
        ).rows[0];
        if (old.author !== user || old.request_hash !== hash(v))
          throw new HttpError(409, "Retry ID reused with different content");
        return old.payload;
      }
      await appendManagementLog(
        db,
        projectId,
        {
          action: "request.created",
          actor: user,
          subject: user,
          requestId: request.id,
          requestType: "access",
          ...(v.class ? { category: v.class } : {}),
          mode: v.mode,
        },
        false,
        `created:${request.id}`,
      );
      return request;
    }
    if (action === "requests") {
      scope.strict().parse(input);
      return await requestRows(store, db, user, projectId);
    }
    if (
      action === "request" ||
      action === "read-notification" ||
      action === "decide"
    ) {
      const v = scope
        .extend({
          id: uuid,
          decision: z.enum(["approve", "reject"]).optional(),
          previewHash: z.string().optional(),
          expectedPolicyRevision: revision.optional(),
        })
        .strict()
        .parse(input);
      const row = (
        await db.query(
          "select * from orka.review_requests where project_id=$1 and id=$2 for update",
          [projectId, v.id],
        )
      ).rows[0];
      if (!row) throw new HttpError(404, "Request unavailable");
      const request = row.payload as ReviewRequest;
      const canReview = await reviewer(store, db, user, request, row.content);
      if (user !== request.author && !canReview)
        throw new HttpError(403, "Request access denied");
      if (action === "read-notification") {
        const visible = (await requestRows(store, db, user, projectId)).find(
          (r) => r.id === request.id,
        );
        await db.query(
          "insert into orka.notification_reads values($1,$2,$3,$4) on conflict(project_id,user_id,request_id) do update set preview_hash=excluded.preview_hash",
          [
            projectId,
            user,
            v.id,
            request.previewHash + ":" + (visible?.status ?? request.status),
          ],
        );
        return { ok: true };
      }
      if (
        request.type === "change" &&
        !(await store.permissions.requestReadable(
          user,
          projectId,
          request,
          row.content.resource,
          db,
        ))
      )
        throw new HttpError(403, "Request access denied");
      if (action === "request") {
        const base =
          request.type === "change"
            ? (
                await db.query(
                  "select payload from orka.snapshots where project_id=$1 and resource_id=$2 and revision=$3",
                  [projectId, request.resourceId, request.baseRevision],
                )
              ).rows[0]?.payload
            : null;
        const audience: string[] = [];
        if (request.type === "change")
          for (const { user_id: reader } of (
            await db.query(
              "select user_id from orka.members where project_id=$1",
              [projectId],
            )
          ).rows) {
            const prepared = row.content.resource as ResourceInput;
            const currentResource = await store.permissions.resource(
              db,
              projectId,
              prepared.resourceId,
            );
            if (
              (
                await store.permissions.access(
                  reader,
                  projectId,
                  currentResource ?? prepared,
                  db,
                )
              ).mode === "hidden"
            )
              continue;
            let readable = true;
            for (const source of prepared.contextSources ?? [])
              if (
                !(await store.permissions.canRead(
                  reader,
                  projectId,
                  source,
                  db,
                ))
              ) {
                readable = false;
                break;
              }
            if (readable) audience.push(reader);
          }
        return {
          request: { ...request, canReview },
          content: row.content,
          base,
          audience,
        };
      }
      if (!canReview) throw new HttpError(403, "Review permission required");
      if (request.status !== "pending") return request;
      if (!v.decision || v.previewHash !== request.previewHash)
        throw new HttpError(409, "Review the exact proposed version first");
      current(v.expectedPolicyRevision ?? -1);
      if (v.decision === "approve") {
        if (p.rolePolicies && request.type === "access")
          throw new HttpError(
            409,
            "This project now uses role policies. Review the person's role in Settings instead of granting an individual exception. The pending request is retained.",
          );
        const author = await store.permissions.project(
          db,
          projectId,
          request.author,
        );
        if (!author.governed)
          throw new HttpError(403, "Proposer access changed");
        if (request.policyRevision !== p.policyRevision)
          request.status = "stale";
        else if (request.type === "access") {
          if (request.requestedClass) {
            owner();
            if (author.owner)
              throw new HttpError(400, "This member already owns the project");
            const categories: PolicyClass[] =
              request.requestedClass === "memory"
                ? ["instructions", "memory"]
                : [request.requestedClass];
            for (const category of categories) {
              const existing =
                (
                  await db.query(
                    "select rule from orka.member_policy where project_id=$1 and user_id=$2 and class=$3",
                    [projectId, request.author, category],
                  )
                ).rows[0]?.rule ?? p.policy[category];
              // An access request cannot lower existing access, change creation rights, or delegate sharing.
              const mode =
                accessRank[existing.mode as keyof typeof accessRank] >
                accessRank[request.requestedMode!]
                  ? existing.mode
                  : request.requestedMode!;
              await db.query(
                "insert into orka.member_policy values($1,$2,$3,$4) on conflict(project_id,user_id,class) do update set rule=excluded.rule",
                [projectId, request.author, category, { ...existing, mode }],
              );
            }
            await db.query(
              "update orka.projects set policy_revision=policy_revision+1 where id=$1",
              [projectId],
            );
          } else {
            await setAccess(
              store,
              db,
              user,
              projectId,
              request.resourceId,
              request.author,
              { mode: request.requestedMode!, canShare: false },
            );
          }
          request.status = "approved";
        } else {
          const proposed = change.parse(row.content.change),
            prepared = resourceInput.parse(row.content.resource);
          const existing = await store.permissions.resource(
            db,
            projectId,
            request.resourceId,
          );
          const legacyReview =
            Boolean(p.rolePolicies) && (await preservedReview(db, request));
          if (!legacyReview)
            await store.permissions.require(
              request.author,
              projectId,
              existing ?? prepared,
              "suggest",
              db,
              !existing,
            );
          if ((existing?.revision ?? 0) !== request.baseRevision)
            request.status = "stale";
          else {
            await store.changeInTransaction(
              db,
              request.author,
              { ...proposed, resource: prepared },
              { review: true, exact: true, legacyReview },
            );
            request.status = "approved";
          }
        }
      } else request.status = "rejected";
      request.reviewer = user;
      await appendManagementLog(
        db,
        projectId,
        {
          action: `request.${request.status}`,
          actor: user,
          subject: request.author,
          requestId: request.id,
          requestType: request.type,
          status: request.status,
          ...(request.requestedClass
            ? { category: request.requestedClass }
            : {}),
          ...(request.requestedMode ? { mode: request.requestedMode } : {}),
        },
        false,
        `decision:${request.id}`,
      );
      await db.query(
        "update orka.review_requests set payload=$3 where project_id=$1 and id=$2",
        [projectId, v.id, request],
      );
      return request;
    }
    if (action === "remove-member") {
      const v = versioned.extend({ userId: uuid }).strict().parse(input);
      if (!p.owner && !(p.rolePolicies && p.role === "admin"))
        throw new HttpError(
          403,
          "Only the Owner or an Admin can remove Members",
        );
      current(v.expectedPolicyRevision);
      const removed = await db.query(
        "delete from orka.members where project_id=$1 and user_id=$2 and user_id<>$3 and (role='member' or ($4 and role='admin')) returning user_id",
        [projectId, v.userId, user, p.owner],
      );
      if (!removed.rowCount)
        throw new HttpError(400, "Choose a current non-owner member");
      await db.query(
        "insert into orka.env_replacements(project_id,set_id) select project_id,id from orka.env_sets where project_id=$1 and header->'manifest'->>'creator'=$2 on conflict do nothing",
        [projectId, v.userId],
      );
      await db.query(
        "update orka.review_requests set payload=jsonb_set(payload,'{status}','\"stale\"') where project_id=$1 and author=$2 and payload->>'status'='pending'",
        [projectId, v.userId],
      );
      await db.query(
        "delete from orka.member_policy where project_id=$1 and user_id=$2",
        [projectId, v.userId],
      );
      await db.query(
        "delete from orka.resource_access where project_id=$1 and user_id=$2",
        [projectId, v.userId],
      );
      await db.query(
        "update orka.projects set policy_revision=policy_revision+1 where id=$1",
        [projectId],
      );
      await appendManagementLog(
        db,
        projectId,
        { action: "member.removed", actor: user, subject: v.userId },
        true,
      );
      return { ok: true };
    }
    if (action === "replace-env") {
      const v = versioned
        .extend({ setId: uuid, replacementId: uuid.optional() })
        .strict()
        .parse(input);
      owner();
      current(v.expectedPolicyRevision);
      const old = await target(store, db, projectId, v.setId);
      if (!old.logicalPath.startsWith("env/"))
        throw new HttpError(400, "Choose an ENV set");
      if (v.replacementId) {
        if (v.replacementId === v.setId)
          throw new HttpError(400, "Replacement requires a new ENV set");
        const next = await target(store, db, projectId, v.replacementId);
        if (!next.logicalPath.startsWith("env/"))
          throw new HttpError(400, "Replacement requires an ENV set");
      }
      await db.query(
        "insert into orka.env_replacements values($1,$2,$3,true) on conflict(project_id,set_id) do update set replacement_id=excluded.replacement_id,disabled=true",
        [projectId, v.setId, v.replacementId ?? null],
      );
      await db.query(
        "update orka.projects set policy_revision=policy_revision+1 where id=$1",
        [projectId],
      );
      await appendManagementLog(db, projectId, {
        action: "env.replaced",
        actor: user,
      });
      return { ok: true };
    }
    throw new HttpError(400, "Unknown permissions action");
  });
}

export async function pullAuthorized(
  store: Store,
  user: string,
  project: string,
  cursor: number,
  policyRevision: number,
  supported: boolean,
) {
  return store.transaction(async (db) => {
    await db.query("select id from orka.projects where id=$1 for share", [
      project,
    ]);
    const p = await store.permissions.project(db, project, user);
    if (p.governed && !supported)
      throw new HttpError(
        409,
        "Update Orka to use this project's resource permissions",
      );
    const max = Number(
      (
        await db.query("select revision from orka.projects where id=$1", [
          project,
        ])
      ).rows[0].revision,
    );
    if (cursor > max) throw new HttpError(400, "Cursor is ahead of project");
    const reset = p.governed && policyRevision !== p.policyRevision;
    let scanned: Event[];
    if (reset) {
      scanned = [];
      for (const { payload } of (
        await db.query(
          "select payload from orka.resources where project_id=$1 order by revision",
          [project],
        )
      ).rows) {
        const conflicts = (
          await db.query(
            "select payload from orka.conflicts where project_id=$1 and resource_id=$2 and not resolved",
            [project, payload.resourceId],
          )
        ).rows.map((r) => r.payload);
        scanned.push({
          revision: payload.revision,
          resource: payload,
          conflicts,
          activity: null,
        });
      }
    } else
      scanned = (
        await db.query(
          "select payload from orka.events where project_id=$1 and revision>$2 order by revision limit 200",
          [project, cursor],
        )
      ).rows.map((r) => r.payload);
    const events = [];
    for (const e of scanned) {
      const visible = await store.permissions.event(user, project, e, db);
      if (visible)
        events.push({
          ...visible,
          resource: {
            ...visible.resource,
            access: await store.permissions.access(
              user,
              project,
              visible.resource,
              db,
            ),
          },
        });
    }
    const presence = [];
    for (const r of (
      await db.query(
        "select p.resource_id,p.device_id,p.owner,d.name from orka.presence p join orka.devices d on d.id=p.device_id where p.project_id=$1 and p.last_seen>now()-interval '3 minutes'",
        [project],
      )
    ).rows)
      if (
        !p.governed ||
        (await store.permissions.canRead(user, project, r.resource_id, db))
      )
        presence.push(r);
    const next = reset ? max : (scanned.at(-1)?.revision ?? cursor);
    return {
      events,
      cursor: next,
      hasMore: next < max,
      presence,
      reset,
      governed: p.governed,
      policyRevision: p.policyRevision,
      requests: p.governed ? await requestRows(store, db, user, project) : [],
    };
  });
}
