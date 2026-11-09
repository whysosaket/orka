import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import {
  mergeText,
  policyClass,
  defaultProjectRules,
  defaultRolePolicies,
  type Activity,
  type Change,
  type Event,
  type FileEntry,
  type Receipt,
  type Resolution,
  type Resource,
  type ResourceInput,
  type SessionConflict,
  type SessionCopy,
  type MemoryResolution,
} from "@portable/protocol";
import { Blobs } from "./blobs.js";
import { JevMemoryResolver } from "./jev.js";
import {
  consolidateMemory,
  MemoryUnavailable,
  type MemoryResolver,
} from "./memory.js";
import { HttpError } from "./errors.js";
import { appendManagementLog } from "./management-log.js";
import { Permissions } from "./permissions.js";
export { HttpError } from "./errors.js";
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map(
          (k) =>
            JSON.stringify(k) +
            ":" +
            canonical((value as Record<string, unknown>)[k]),
        )
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export const hash = (value: unknown): string =>
  createHash("sha256").update(canonical(value)).digest("hex");
export class Store {
  readonly permissions: Permissions;
  constructor(
    public pool: Pool,
    public blobs: Blobs,
    private memoryResolver: MemoryResolver = new JevMemoryResolver(),
  ) {
    this.permissions = new Permissions(pool);
  }
  async transaction<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query("begin");
      const result = await fn(db);
      await db.query("commit");
      return result;
    } catch (e) {
      await db.query("rollback");
      throw e;
    } finally {
      db.release();
    }
  }
  async member(
    user: string,
    project: string,
    db: Pool | PoolClient = this.pool,
  ): Promise<void> {
    if (
      !(
        await db.query(
          "select 1 from orka.members m join orka.projects p on p.id=m.project_id where m.project_id=$1 and m.user_id=$2 and p.archived_at is null",
          [project, user],
        )
      ).rowCount
    )
      throw new HttpError(403, "Project access denied");
  }
  async device(
    user: string,
    id: string,
    name: string,
    hardwareFamily?: string,
  ): Promise<void> {
    const r = await this.pool.query(
      "insert into orka.devices(id,owner,name,last_seen,hardware_family) values($1,$2,$3,now(),$4) on conflict(id) do update set name=excluded.name,last_seen=now(),hardware_family=coalesce(nullif(excluded.hardware_family,'generic'),orka.devices.hardware_family,excluded.hardware_family) where orka.devices.owner=excluded.owner returning id",
      [id, user, name, hardwareFamily ?? null],
    );
    if (!r.rowCount)
      throw new HttpError(403, "Device belongs to another account");
  }
  async checkDevice(db: PoolClient, user: string, id: string): Promise<void> {
    if (
      !(
        await db.query("select 1 from orka.devices where id=$1 and owner=$2", [
          id,
          user,
        ])
      ).rowCount
    )
      throw new HttpError(403, "Register this device first");
  }
  async createProject(
    user: string,
    name: string,
    governed = false,
    remoteKey?: string,
    requestId?: string,
    roles = false,
  ): Promise<string> {
    let id = randomUUID();
    await this.transaction(async (db) => {
      if (requestId) {
        await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
          `project-create:${user}:${requestId}`,
        ]);
        const prior = (
          await db.query(
            "select project_id,request_hash from orka.project_create_receipts where user_id=$1 and request_id=$2",
            [user, requestId],
          )
        ).rows[0];
        if (prior) {
          const requestedHash = hash({
            name,
            governed,
            remoteKey: remoteKey ?? null,
            ...(roles ? { roles: true } : {}),
          });
          const legacyHash = hash({
            name,
            governed,
            remoteKey: remoteKey ?? null,
          });
          if (
            prior.request_hash !== requestedHash &&
            !(roles && prior.request_hash === legacyHash)
          )
            throw new HttpError(
              409,
              "This project creation was already submitted with different choices",
            );
          id = prior.project_id;
          return;
        }
      }
      await db.query(
        "insert into orka.projects(id,name,created_by,source_model,remote_key) values($1,$2,$3,1,$4)",
        [id, name, user, remoteKey ?? null],
      );
      await db.query("insert into orka.members values($1,$2,'owner')", [
        id,
        user,
      ]);
      await appendManagementLog(
        db,
        id,
        { action: "project.created", actor: user },
        true,
      );
      if (governed)
        await db.query(
          "update orka.projects set governed=true,policy=$2,policy_revision=1 where id=$1",
          [id, defaultProjectRules],
        );
      if (roles)
        await db.query(
          "update orka.projects set governed=true,role_policies=$2,policy_revision=1 where id=$1",
          [id, defaultRolePolicies],
        );
      if (requestId)
        await db.query(
          "insert into orka.project_create_receipts values($1,$2,$3,$4)",
          [
            user,
            requestId,
            hash({
              name,
              governed,
              remoteKey: remoteKey ?? null,
              ...(roles ? { roles: true } : {}),
            }),
            id,
          ],
        );
    });
    return id;
  }
  private async begin(
    db: PoolClient,
    user: string,
    input: { projectId: string; deviceId: string; id: string },
  ): Promise<{ revision: number; prior?: Receipt }> {
    const locked = await db.query(
      "select revision from orka.projects where id=$1 for update",
      [input.projectId],
    );
    await this.member(user, input.projectId, db);
    await this.checkDevice(db, user, input.deviceId);
    const prior = await db.query(
      "select request_hash,payload from orka.receipts where project_id=$1 and author=$2 and id=$3",
      [input.projectId, user, input.id],
    );
    if (prior.rowCount) {
      if (prior.rows[0].request_hash !== hash(input))
        throw new HttpError(409, "Retry ID reused with different content");
      return {
        revision: Number(locked.rows[0].revision),
        prior: {
          ...prior.rows[0].payload,
          event: await this.authorizedReceipt(
            db,
            user,
            input.projectId,
            prior.rows[0].payload.event,
          ),
        },
      };
    }
    return { revision: Number(locked.rows[0].revision) + 1 };
  }
  private async authorizedReceipt(
    db: PoolClient,
    user: string,
    project: string,
    event: Event,
  ): Promise<Event> {
    const permitted = await this.permissions.event(user, project, event, db);
    if (!permitted) throw new HttpError(403, "Receipt access denied");
    return permitted;
  }
  private async current(
    db: PoolClient,
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
  private async conflicts(
    db: PoolClient,
    project: string,
    id: string,
  ): Promise<SessionConflict[]> {
    return (
      await db.query(
        "select payload from orka.conflicts where project_id=$1 and resource_id=$2 and not resolved order by id",
        [project, id],
      )
    ).rows.map((r) => r.payload);
  }
  private async verifyFiles(
    db: PoolClient,
    project: string,
    files: FileEntry[],
    user: string,
  ): Promise<void> {
    for (const f of files) {
      if (
        !(
          await db.query(
            "select 1 from orka.blob_uploads where project_id=$1 and hash=$2 and author=$3",
            [project, f.hash, user],
          )
        ).rowCount &&
        !(await this.permissions.blob(user, project, f.hash, db))
      )
        throw new HttpError(403, "Blob access denied");
      const r = await db.query(
        "select size from orka.blobs where project_id=$1 and hash=$2",
        [project, f.hash],
      );
      if (!r.rowCount || Number(r.rows[0].size) !== f.size)
        throw new HttpError(
          400,
          "Upload and verify every blob before its manifest",
        );
    }
  }
  private async save(
    db: PoolClient,
    user: string,
    input: { projectId: string; id: string },
    revision: number,
    resource: Resource,
    conflicts: SessionConflict[],
    activity: Activity | null = null,
    memoryResolutions: MemoryResolution[] = [],
  ): Promise<Receipt> {
    resource = {
      ...resource,
      hash: hash({ files: resource.files, deleted: resource.deleted }),
    };
    await db.query(
      "insert into orka.resources values($1,$2,$3,$4) on conflict(project_id,id) do update set revision=excluded.revision,payload=excluded.payload",
      [input.projectId, resource.resourceId, resource.revision, resource],
    );
    await db.query(
      "insert into orka.snapshots values($1,$2,$3,$4) on conflict do nothing",
      [input.projectId, resource.resourceId, resource.revision, resource],
    );
    const event: Event = {
        revision,
        resource,
        conflicts,
        activity,
        ...(memoryResolutions.length ? { memoryResolutions } : {}),
      },
      receipt: Receipt = { event, conflict: conflicts.length > 0 };
    await db.query("update orka.projects set revision=$2 where id=$1", [
      input.projectId,
      revision,
    ]);
    await db.query("insert into orka.events values($1,$2,$3)", [
      input.projectId,
      revision,
      event,
    ]);
    await db.query("insert into orka.receipts values($1,$2,$3,$4,$5)", [
      input.projectId,
      user,
      input.id,
      hash(input),
      receipt,
    ]);
    return receipt;
  }
  private async mergeFiles(
    db: PoolClient,
    project: string,
    base: Resource,
    current: Resource,
    incoming: ResourceInput,
  ): Promise<FileEntry[]> {
    const b = new Map(base.files.map((f) => [f.path, f])),
      c = new Map(current.files.map((f) => [f.path, f])),
      n = new Map(incoming.files.map((f) => [f.path, f])),
      output: FileEntry[] = [];
    for (const path of [
      ...new Set([...b.keys(), ...c.keys(), ...n.keys()]),
    ].sort()) {
      const old = b.get(path),
        now = c.get(path),
        next = n.get(path);
      if (canonical(next) === canonical(old)) {
        if (now) output.push(now);
        continue;
      }
      if (!next) continue;
      let merged = next;
      if (old && now && next.hash === old.hash)
        merged = { ...now, executable: next.executable };
      if (
        old &&
        now &&
        next.hash !== old.hash &&
        now.hash !== old.hash &&
        now.hash !== next.hash
      ) {
        const buffers = await Promise.all(
          [old, now, next].map((f) => this.blobs.read(project, f.hash)),
        );
        try {
          if (buffers.some((b) => b.includes(0)))
            throw new TypeError("Binary file");
          const decoder = new TextDecoder("utf-8", { fatal: true });
          const text = mergeText(
            ...(buffers.map((v) => decoder.decode(v)) as [
              string,
              string,
              string,
            ]),
          );
          const bytes = Buffer.from(text);
          const blobHash = await this.blobs.put(project, bytes);
          await db.query(
            "insert into orka.blobs values($1,$2,$3) on conflict do nothing",
            [project, blobHash, bytes.length],
          );
          merged = { ...next, hash: blobHash, size: bytes.length };
        } catch (e) {
          if (!(e instanceof TypeError)) throw e;
        }
      }
      if (old && now && next.executable === old.executable)
        merged = { ...merged, executable: now.executable };
      output.push(merged);
    }
    return output;
  }
  async mutate(user: string, input: Change): Promise<Receipt> {
    return this.transaction((db) => this.changeInTransaction(db, user, input));
  }
  async changeInTransaction(
    db: PoolClient,
    user: string,
    input: Change,
    options: {
      preview?: boolean;
      review?: boolean;
      exact?: boolean;
      legacyReview?: boolean;
    } = {},
  ): Promise<Receipt> {
    const { revision, prior } = await this.begin(db, user, input);
    if (prior) return prior;
    if (
      input.resource.sourceId &&
      !(
        await db.query(
          "select 1 from orka.project_sources where project_id=$1 and id=$2",
          [input.projectId, input.resource.sourceId],
        )
      ).rowCount
    )
      throw new HttpError(400, "Source folder does not belong to this project");
    const existing = await this.permissions.resource(
      db,
      input.projectId,
      input.resource.resourceId,
    );
    if (
      !existing &&
      (
        await db.query(
          "select 1 from orka.resources where project_id=$1 and payload->>'kind'=$2 and payload->>'logicalPath'=$3 and coalesce(payload->>'sourceId','')=$4",
          [
            input.projectId,
            input.resource.kind,
            input.resource.logicalPath,
            input.resource.sourceId ?? "",
          ],
        )
      ).rowCount
    )
      throw new HttpError(
        409,
        "Resource path already exists; edit the accepted resource",
      );
    if (
      !existing &&
      (
        await db.query(
          "select 1 from orka.env_sets where project_id=$1 and id=$2",
          [input.projectId, input.resource.resourceId],
        )
      ).rowCount
    )
      throw new HttpError(409, "Resource ID is already used by an ENV set");
    const access = options.legacyReview
      ? await this.permissions.access(
          user,
          input.projectId,
          existing ?? input.resource,
          db,
        )
      : await this.permissions.require(
          user,
          input.projectId,
          existing ?? input.resource,
          options.preview || options.review ? "suggest" : "publish",
          db,
          !existing,
        );
    const rolePolicy = await this.permissions.project(
      db,
      input.projectId,
      user,
    );
    if (
      rolePolicy.rolePolicies &&
      input.resource.deleted &&
      !(
        rolePolicy.owner ||
        (rolePolicy.role === "admin" && access.mode === "publish")
      )
    )
      throw new HttpError(
        403,
        "Only the Owner or an Admin with write access can delete shared content",
      );
    await this.verifyFiles(db, input.projectId, input.resource.files, user);
    await this.permissions.sources(
      db,
      user,
      input.projectId,
      input.resource,
      existing,
      Boolean(options.preview),
    );
    if (
      access.governed &&
      existing &&
      ["instructions", "skill", "plan"].includes(policyClass(existing)) &&
      input.baseRevision !== existing.revision
    )
      throw new HttpError(
        409,
        "Resource changed; refresh and review the exact version again",
      );
    if (input.resource.kind === "plan" && !input.resource.deleted) {
      const bytes = await this.blobs.read(
        input.projectId,
        input.resource.files[0].hash,
      );
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (bytes.includes(0)) throw new TypeError("Binary plan");
      } catch {
        throw new HttpError(400, "Plans must contain UTF-8 Markdown");
      }
    }
    const current = await this.current(
        db,
        input.projectId,
        input.resource.resourceId,
      ),
      cs = await this.conflicts(db, input.projectId, input.resource.resourceId);
    if (
      current &&
      (current.kind !== input.resource.kind ||
        current.sourceId !== input.resource.sourceId ||
        current.source !== input.resource.source ||
        current.logicalPath !== input.resource.logicalPath)
    )
      throw new HttpError(409, "Resource identity cannot change");
    if (!current && input.baseRevision !== 0)
      throw new HttpError(409, "Unknown base revision");
    let base: Resource | undefined;
    if (current && input.baseRevision === current.revision) base = current;
    else if (current) {
      base = (
        await db.query(
          "select payload from orka.snapshots where project_id=$1 and resource_id=$2 and revision=$3",
          [input.projectId, current.resourceId, input.baseRevision],
        )
      ).rows[0]?.payload;
      if (!base && input.baseRevision !== 0)
        throw new HttpError(409, "Unknown base revision");
    }
    let resource: Resource = {
      ...input.resource,
      hash: hash({
        files: input.resource.files,
        deleted: input.resource.deleted,
      }),
      projectId: input.projectId,
      revision,
      owner: current?.owner ?? user,
      updatedBy: user,
      updatedAt: new Date().toISOString(),
    };
    if (current?.kind === "session" && user !== current.owner) {
      if (
        !(rolePolicy.rolePolicies && input.resource.deleted) ||
        (input.resource.files.length > 0 &&
          hash(input.resource.files) !== hash(current.files))
      )
        throw new HttpError(403, "Copy a teammate session before editing it");
      if (input.baseRevision !== current.revision)
        throw new HttpError(
          409,
          "Session changed; review the current version before deleting it",
        );
      // A tombstone cannot also replace someone else's metadata or attribution.
      // Conversation bytes remain in the immutable prior snapshot.
      resource = {
        ...current,
        files: [],
        deleted: true,
        hash: hash({ files: [], deleted: true }),
        revision,
        updatedBy: user,
        updatedAt: resource.updatedAt,
      };
    }
    const differs =
      current &&
      (hash(current.files) !== hash(resource.files) ||
        current.deleted !== resource.deleted);
    let memoryResolutions: MemoryResolution[] = [];
    if (
      resource.kind === "memory" &&
      !resource.deleted &&
      !options.exact &&
      !(access.governed && policyClass(resource) === "instructions")
    ) {
      const read = async (r: ResourceInput | undefined) => {
        if (!r || r.deleted || !r.files.length) return "";
        const bytes = await this.blobs.read(input.projectId, r.files[0].hash);
        try {
          if (bytes.includes(0)) throw new TypeError("Binary memory");
          return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          throw new HttpError(400, "Memory must contain UTF-8 text");
        }
      };
      const [original, accepted, proposed] = await Promise.all(
        [base, current, resource].map(read),
      );
      let result;
      try {
        result = await consolidateMemory(
          original,
          accepted,
          proposed,
          {
            logicalPath: resource.logicalPath,
            title: resource.title,
            source: resource.source,
            baseRevision: input.baseRevision,
            currentRevision: current?.revision ?? 0,
            currentAuthor: current?.updatedBy,
            incomingAuthor: user,
          },
          this.memoryResolver,
        );
      } catch (error) {
        if (error instanceof MemoryUnavailable)
          throw new HttpError(503, error.message);
        throw error;
      }
      const bytes = Buffer.from(result.text);
      if (bytes.length > 1_000_000)
        throw new HttpError(413, "Merged resource exceeds size limit");
      const blobHash = await this.blobs.put(input.projectId, bytes);
      await db.query(
        "insert into orka.blobs values($1,$2,$3) on conflict do nothing",
        [input.projectId, blobHash, bytes.length],
      );
      // Generated previews can include accepted knowledge. They are authorized
      // through their resource/proposal, never treated as client-owned uploads.
      resource.files = [
        {
          ...resource.files[0],
          hash: blobHash,
          size: bytes.length,
          executable:
            current?.files[0] &&
            base?.files[0]?.executable === resource.files[0].executable
              ? current.files[0].executable
              : resource.files[0].executable,
        },
      ];
      memoryResolutions = result.resolutions;
    } else if (
      current?.kind === "session" &&
      differs &&
      (input.baseRevision !== current.revision || cs.length)
    ) {
      const candidate: SessionConflict = {
        id: input.id,
        resourceId: current.resourceId,
        author: user,
        deviceId: input.deviceId,
        candidate: resource,
        revision,
      };
      cs.push(candidate);
      await db.query(
        "insert into orka.conflicts(id,project_id,resource_id,payload) values($1,$2,$3,$4)",
        [candidate.id, input.projectId, current.resourceId, candidate],
      );
      resource = { ...current, revision };
    } else if (
      current &&
      current.kind !== "session" &&
      !resource.deleted &&
      !current.deleted &&
      input.baseRevision !== current.revision
    ) {
      resource.files = await this.mergeFiles(
        db,
        input.projectId,
        base ?? { ...current, files: [] },
        current,
        resource,
      );
      if (
        resource.kind === "skill" &&
        !resource.files.some((f) => f.path === "SKILL.md")
      )
        throw new HttpError(409, "Merged skill must contain SKILL.md");
      if (
        resource.files.reduce((n, f) => n + f.size, 0) >
        (resource.kind === "skill" ? 4_000_000 : 1_000_000)
      )
        throw new HttpError(413, "Merged resource exceeds size limit");
    }
    if (options.preview)
      return {
        event: {
          revision,
          resource,
          conflicts: cs,
          activity: null,
          memoryResolutions,
        },
        conflict: cs.length > 0,
      };
    return this.save(
      db,
      user,
      input,
      revision,
      resource,
      cs,
      null,
      memoryResolutions,
    );
  }
  async resolve(user: string, input: Resolution): Promise<Receipt> {
    return this.transaction(async (db) => {
      const { revision, prior } = await this.begin(db, user, input);
      if (prior) return prior;
      const current = await this.current(db, input.projectId, input.resourceId),
        cs = await this.conflicts(db, input.projectId, input.resourceId),
        candidate = cs.find((c) => c.id === input.conflictId);
      if (!current || current.revision !== input.expectedRevision || !candidate)
        throw new HttpError(409, "Conflict changed; refresh before resolving");
      await this.permissions.require(
        user,
        input.projectId,
        current,
        "read",
        db,
      );
      if (input.action !== "copy")
        await this.permissions.require(
          user,
          input.projectId,
          current,
          "publish",
          db,
        );
      if (input.action === "copy") {
        await this.permissions.require(
          user,
          input.projectId,
          { ...current, resourceId: input.id },
          "publish",
          db,
          true,
        );
        const selected =
          input.selected === "candidate" ? candidate.candidate : current;
        if (selected.owner !== user)
          throw new HttpError(
            403,
            "Only the selected version owner can promote it to a copy",
          );
        await db.query("update orka.conflicts set resolved=true where id=$1", [
          candidate.id,
        ]);
        const copyId = input.id,
          copy = {
            ...selected,
            resourceId: copyId,
            logicalPath: "copies/" + copyId,
            title: current.title + " (copy)",
            revision,
            owner: user,
            updatedBy: user,
            updatedAt: new Date().toISOString(),
          };
        // Publish both sides of the resolution under one project revision.
        const remaining = cs.filter((c) => c.id !== candidate.id),
          updated = { ...current, revision };
        await db.query(
          "update orka.resources set revision=$3,payload=$4 where project_id=$1 and id=$2",
          [input.projectId, current.resourceId, revision, updated],
        );
        await db.query("insert into orka.snapshots values($1,$2,$3,$4)", [
          input.projectId,
          current.resourceId,
          revision,
          updated,
        ]);
        copy.contextSources = [
          ...new Set([...(copy.contextSources ?? []), current.resourceId]),
        ];
        await this.permissions.sources(db, user, input.projectId, copy);
        const receipt = await this.save(db, user, input, revision, copy, [], {
          id: input.id,
          type: "session_copied",
          resourceId: current.resourceId,
          copyId,
          author: user,
          notifyOwner: current.owner,
        });
        const payload = {
          ...receipt.event,
          related: [{ resource: updated, conflicts: remaining }],
        };
        await db.query(
          "update orka.events set payload=$3 where project_id=$1 and revision=$2",
          [input.projectId, revision, payload],
        );
        const result = { ...receipt, event: payload };
        await db.query(
          "update orka.receipts set payload=$4 where project_id=$1 and author=$2 and id=$3",
          [input.projectId, user, input.id, result],
        );
        return result;
      }
      if (user !== current.owner)
        throw new HttpError(
          403,
          "Only the session owner can resolve its versions",
        );
      const selected =
        input.selected === "current" ? current : candidate.candidate;
      await db.query(
        "update orka.conflicts set resolved=true where project_id=$1 and resource_id=$2",
        [input.projectId, current.resourceId],
      );
      return this.save(
        db,
        user,
        input,
        revision,
        {
          ...selected,
          revision,
          updatedBy: user,
          updatedAt: new Date().toISOString(),
        },
        [],
      );
    });
  }
  async copy(user: string, input: SessionCopy): Promise<Receipt> {
    return this.transaction(async (db) => {
      const { revision, prior } = await this.begin(db, user, input);
      if (prior) return prior;
      const current = await this.current(db, input.projectId, input.resourceId);
      if (!current || current.kind !== "session" || current.deleted)
        throw new HttpError(409, "Session unavailable");
      await this.permissions.require(
        user,
        input.projectId,
        current,
        "read",
        db,
      );
      await this.permissions.require(
        user,
        input.projectId,
        { ...current, resourceId: input.id },
        "publish",
        db,
        true,
      );
      const source =
        current.revision === input.expectedRevision
          ? current
          : ((
              await db.query(
                "select payload from orka.snapshots where project_id=$1 and resource_id=$2 and revision=$3",
                [input.projectId, input.resourceId, input.expectedRevision],
              )
            ).rows[0]?.payload as Resource | undefined);
      if (!source || source.deleted)
        throw new HttpError(409, "Cached session revision unavailable");
      const copyId = input.id,
        resource = {
          ...source,
          resourceId: copyId,
          logicalPath: "copies/" + copyId,
          title: source.title + " (copy)",
          revision,
          owner: user,
          updatedBy: user,
          updatedAt: new Date().toISOString(),
        };
      resource.contextSources = [
        ...new Set([...(resource.contextSources ?? []), current.resourceId]),
      ];
      await this.permissions.sources(db, user, input.projectId, resource);
      return this.save(db, user, input, revision, resource, [], {
        id: input.id,
        type: "session_copied",
        resourceId: current.resourceId,
        copyId,
        author: user,
        notifyOwner: current.owner,
      });
    });
  }
}
