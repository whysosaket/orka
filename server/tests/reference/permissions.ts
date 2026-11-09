import type { Pool, PoolClient } from "pg";
import {
  accessRank,
  defaultProjectRules,
  policyClass,
  type AccessMode,
  type AccessRule,
  type EffectiveAccess,
  type ProjectRules,
  type ResourceInput,
  type Resource,
  type Event,
  type RolePolicies,
} from "@portable/protocol";
import { HttpError } from "./errors.js";

type Database = Pool | PoolClient;
type PolicyResource = {
  kind: string;
  resourceId: string;
  source?: string;
  logicalPath?: string;
  owner?: string;
  contextSources?: string[];
};
export class Permissions {
  constructor(private pool: Pool) {}
  async project(db: Database, project: string, user: string) {
    const row = (
      await db.query(
        `select p.governed,p.policy,p.policy_revision,p.role_policies,m.role from orka.projects p
       join orka.members m on m.project_id=p.id where p.id=$1 and m.user_id=$2 and p.archived_at is null`,
        [project, user],
      )
    ).rows[0];
    if (!row) throw new HttpError(403, "Project access denied");
    return {
      governed: Boolean(row.governed),
      policyRevision: Number(row.policy_revision),
      policy: (row.policy ?? defaultProjectRules) as ProjectRules,
      owner: row.role === "owner",
      role: row.role as "owner" | "admin" | "member",
      rolePolicies: (row.role_policies ?? null) as RolePolicies | null,
    };
  }
  async access(
    user: string,
    project: string,
    resource: PolicyResource,
    db: Database = this.pool,
    trail = new Set<string>(),
  ): Promise<EffectiveAccess> {
    const p = await this.project(db, project, user);
    if (!p.governed || p.owner)
      return {
        mode: "publish",
        canShare: p.owner,
        create: "publish",
        governed: p.governed,
        policyRevision: p.policyRevision,
      };
    const category = policyClass(resource);
    if (p.rolePolicies && category !== "env") {
      const categoryKey = category === "instructions" ? "memory" : category;
      const level =
        p.rolePolicies[p.role === "admin" ? "admin" : "member"][categoryKey];
      const current = await this.resource(db, project, resource.resourceId);
      let mode: AccessMode =
        level === "none"
          ? "hidden"
          : level === "write"
            ? "publish"
            : level === "add"
              ? current?.owner === user
                ? "read"
                : "hidden"
              : "read";
      // Legacy file/source restrictions are ceilings, never grants beyond a role.
      const restriction = (
        await db.query(
          "select rule from orka.resource_access where project_id=$1 and resource_id=$2 and user_id=$3",
          [project, resource.resourceId, user],
        )
      ).rows[0]?.rule;
      if (
        restriction &&
        accessRank[restriction.mode as AccessMode] < accessRank[mode]
      )
        mode = restriction.mode;
      if (trail.has(resource.resourceId)) mode = "hidden";
      else
        for (const id of current?.contextSources ?? []) {
          const source = await this.resource(db, project, id);
          if (
            !source ||
            (
              await this.access(
                user,
                project,
                source,
                db,
                new Set([...trail, resource.resourceId]),
              )
            ).mode === "hidden"
          ) {
            mode = "hidden";
            break;
          }
        }
      return {
        mode,
        canShare: false,
        create: level === "write" || level === "add" ? "publish" : "hidden",
        governed: true,
        policyRevision: p.policyRevision,
      };
    }
    const member = (
      await db.query(
        "select rule from orka.member_policy where project_id=$1 and user_id=$2 and class=$3",
        [project, user, category],
      )
    ).rows[0]?.rule;
    const rule = member ?? p.policy[category];
    const specific = (
      await db.query(
        "select rule from orka.resource_access where project_id=$1 and resource_id=$2 and user_id=$3",
        [project, resource.resourceId, user],
      )
    ).rows[0]?.rule;
    // Publishing your own opted-in session/plan is a creation capability, never an exemption for skills or instructions.
    const own =
      !specific &&
      resource.owner === user &&
      ["session", "plan"].includes(category) &&
      rule.create === "publish";
    let mode = own ? "publish" : (specific ?? rule).mode;
    const current = await this.resource(db, project, resource.resourceId);
    const sources = current?.contextSources ?? [];
    if (trail.has(resource.resourceId)) mode = "hidden";
    else
      for (const id of sources) {
        const source = await this.resource(db, project, id);
        if (
          !source ||
          (
            await this.access(
              user,
              project,
              source,
              db,
              new Set([...trail, resource.resourceId]),
            )
          ).mode === "hidden"
        ) {
          mode = "hidden";
          break;
        }
      }
    return {
      ...(specific ?? rule),
      mode,
      canShare: false,
      create: rule.create,
      governed: true,
      policyRevision: p.policyRevision,
    };
  }
  async require(
    user: string,
    project: string,
    resource: Parameters<Permissions["access"]>[2],
    mode: AccessMode,
    db: Database,
    create = false,
  ) {
    const access = await this.access(user, project, resource, db);
    if (accessRank[create ? access.create : access.mode] < accessRank[mode])
      throw new HttpError(
        403,
        mode === "publish"
          ? "Publishing requires permission; save a draft or submit a suggestion"
          : "Resource access denied",
      );
    return access;
  }
  async resource(
    db: Database,
    project: string,
    id: string,
  ): Promise<Resource | undefined> {
    return (
      await db.query(
        "select payload from orka.resources where project_id=$1 and id=$2",
        [project, id],
      )
    ).rows[0]?.payload;
  }
  async canRead(
    user: string,
    project: string,
    id: string,
    db: Database = this.pool,
  ) {
    const resource = await this.resource(db, project, id);
    return Boolean(
      resource &&
      accessRank[(await this.access(user, project, resource, db)).mode] >= 1,
    );
  }
  async event(
    user: string,
    project: string,
    event: Event,
    db: Database,
  ): Promise<Event | null> {
    if (!(await this.canRead(user, project, event.resource.resourceId, db)))
      return null;
    const related = [];
    for (const item of event.related ?? [])
      if (await this.canRead(user, project, item.resource.resourceId, db))
        related.push(item);
    const activity =
      event.activity &&
      (await this.canRead(user, project, event.activity.resourceId, db)) &&
      (await this.canRead(user, project, event.activity.copyId, db))
        ? event.activity
        : null;
    return { ...event, activity, ...(event.related ? { related } : {}) };
  }
  async blob(
    user: string,
    project: string,
    hash: string,
    db: Database,
  ): Promise<boolean> {
    if (!(await this.project(db, project, user)).governed) return true;
    const resources = (
      await db.query(
        `select distinct resource_id from orka.snapshots where project_id=$1 and payload->'files' @> $2::jsonb
       union select resource_id from orka.conflicts where project_id=$1 and payload->'candidate'->'files' @> $2::jsonb`,
        [project, JSON.stringify([{ hash }])],
      )
    ).rows;
    for (const r of resources)
      if (await this.canRead(user, project, r.resource_id, db)) return true;
    const proposals = (
      await db.query(
        "select payload,content from orka.review_requests where project_id=$1 and content->'resource'->'files' @> $2::jsonb",
        [project, JSON.stringify([{ hash }])],
      )
    ).rows;
    for (const row of proposals) {
      if (
        await this.requestReadable(
          user,
          project,
          row.payload,
          row.content.resource,
          db,
        )
      )
        return true;
    }
    // Consolidated previews can contain accepted knowledge. Once referenced by a
    // proposal they use its current visibility, even for the original uploader.
    if (
      !resources.length &&
      !proposals.length &&
      (
        await db.query(
          "select 1 from orka.blob_uploads where project_id=$1 and hash=$2 and author=$3",
          [project, hash, user],
        )
      ).rowCount
    )
      return true;
    return false;
  }
  async requestReadable(
    user: string,
    project: string,
    request: { author: string; resourceId: string },
    resource: ResourceInput,
    db: Database,
  ) {
    if (
      user !== request.author &&
      !(await this.canReview(user, project, resource, db))
    )
      return false;
    const current = await this.resource(db, project, request.resourceId);
    if (current && !(await this.canRead(user, project, current.resourceId, db)))
      return false;
    for (const id of resource.contextSources ?? [])
      if (!(await this.canRead(user, project, id, db))) return false;
    return true;
  }
  async canReview(
    user: string,
    project: string,
    resource: ResourceInput,
    db: Database,
  ) {
    const current = await this.resource(db, project, resource.resourceId);
    const access = await this.access(user, project, current ?? resource, db);
    for (const id of resource.contextSources ?? [])
      if (!(await this.canRead(user, project, id, db))) return false;
    return (
      access.mode === "publish" &&
      Boolean(current || access.create === "publish") &&
      (resource.kind !== "session" || !current || current.owner === user)
    );
  }
  async setRule(
    db: PoolClient,
    project: string,
    id: string,
    user: string,
    rule: AccessRule,
  ) {
    await db.query(
      "insert into orka.resource_access values($1,$2,$3,$4) on conflict(project_id,resource_id,user_id) do update set rule=excluded.rule",
      [project, id, user, rule],
    );
  }
  async sources(
    db: PoolClient,
    user: string,
    project: string,
    resource: ResourceInput,
    current?: Resource,
    preview = false,
  ) {
    const sources = [
      ...new Set([
        ...(current?.contextSources ?? []),
        ...(resource.contextSources ?? []),
        ...(resource.memory?.supersedes ?? []),
      ]),
    ];
    for (const id of resource.memory?.supersedes ?? []) {
      const previous = await this.resource(db, project, id);
      if (
        !previous ||
        previous.kind !== "memory" ||
        previous.logicalPath.startsWith("instructions/") ||
        (previous.memory?.scope ?? "") !== (resource.memory?.scope ?? "") ||
        previous.sourceId !== resource.sourceId
      )
        throw new HttpError(
          400,
          "Superseded knowledge must belong to the same repository and scope",
        );
    }
    if (!sources.length) return;
    if (sources.length > 100)
      throw new HttpError(400, "Too many context references");
    if (sources.includes(resource.resourceId))
      throw new HttpError(400, "A resource cannot derive from itself");
    const reaches = async (id: string, seen: Set<string>): Promise<boolean> => {
      if (id === resource.resourceId) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      for (const source of (await this.resource(db, project, id))
        ?.contextSources ?? [])
        if (await reaches(source, seen)) return true;
      return false;
    };
    for (const id of sources)
      if (await reaches(id, new Set()))
        throw new HttpError(400, "Context references cannot form a cycle");
    resource.contextSources = sources;
    for (const id of sources)
      if (!(await this.canRead(user, project, id, db)))
        throw new HttpError(403, "Source context is unavailable");
    const members = (
      await db.query("select user_id from orka.members where project_id=$1", [
        project,
      ])
    ).rows;
    for (const { user_id: reader } of members) {
      let allowed = true;
      for (const id of sources)
        if (!(await this.canRead(reader, project, id, db))) {
          allowed = false;
          break;
        }
      if (allowed) continue;
      if (!current && !preview)
        await this.setRule(db, project, resource.resourceId, reader, {
          mode: "hidden",
          canShare: false,
        });
      else if (
        current &&
        (await this.canRead(reader, project, current.resourceId, db))
      )
        throw new HttpError(
          403,
          "Restricted source context requires sharing review before widening its audience",
        );
    }
  }
}
