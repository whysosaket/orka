import { createHash, createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import {
  envCanonical,
  envDevice,
  envMutation,
  envSignedCall,
  validateEnvTransition,
  type EnvDevice,
  type EnvHeader,
  type EnvManifest,
  type EnvSet,
} from "@portable/protocol";
import { HttpError, Store } from "./store.js";

export const envHash = (value: unknown) =>
  createHash("sha256").update(envCanonical(value)).digest("hex");
export function verifyEnvSignature(
  key: string,
  value: unknown,
  signature: string,
): boolean {
  try {
    return verify(
      null,
      Buffer.from(envCanonical(value)),
      createPublicKey({
        key: Buffer.concat([
          Buffer.from("302a300506032b6570032100", "hex"),
          Buffer.from(key, "hex"),
        ]),
        format: "der",
        type: "spki",
      }),
      Buffer.from(signature, "hex"),
    );
  } catch {
    return false;
  }
}
function requireSignature(
  device: EnvDevice,
  value: unknown,
  signature: string,
) {
  if (!verifyEnvSignature(device.signingKey, value, signature))
    throw new HttpError(403, "Invalid ENV signature");
}
const scope = z.object({ projectId: z.uuid() }).strict();
const setScope = scope.extend({ setId: z.uuid() }).strict();
function allowed(manifest: EnvManifest, user: string, device: string) {
  if (
    manifest.deleted ||
    !manifest.grants.includes(user) ||
    !manifest.devices.some((d) => d.id === device && d.owner === user)
  )
    throw new HttpError(403, "ENV access requires an approved device");
}

export async function envAction(
  store: Store,
  user: string,
  raw: unknown,
): Promise<unknown> {
  const { call, signature } = envSignedCall.parse(raw);
  if (Math.abs(Date.now() - call.time) > 300_000)
    throw new HttpError(400, "ENV request expired; check this Mac’s clock");
  let device: EnvDevice;
  if (call.operation === "enroll") device = envDevice.parse(call.input);
  else {
    const record = await store.pool.query(
      "select payload from orka.env_devices where id=$1 and owner=$2",
      [call.deviceId, user],
    );
    if (!record.rowCount)
      throw new HttpError(403, "Enable ENVs on this Mac first");
    device = envDevice.parse(record.rows[0].payload);
  }
  if (device.id !== call.deviceId || device.owner !== user)
    throw new HttpError(403, "ENV device belongs to another account");
  requireSignature(device, call, signature);
  if (call.operation === "enroll") {
    const inserted = await store.pool.query(
      "insert into orka.env_devices values($1,$2,$3) on conflict(id) do nothing returning id",
      [device.id, user, device],
    );
    if (!inserted.rowCount) {
      const old = await store.pool.query(
        "select payload from orka.env_devices where id=$1",
        [device.id],
      );
      if (envCanonical(old.rows[0].payload) !== envCanonical(device))
        throw new HttpError(
          409,
          "ENV device keys cannot be replaced; enroll a new device",
        );
    }
    return { device };
  }
  if (call.operation === "directory") {
    const { projectId } = scope.parse(call.input);
    await store.member(user, projectId);
    return {
      members: (
        await store.pool.query(
          `select m.user_id as id,coalesce(p.label,'Member ' || left(m.user_id::text,8)) as label,
       coalesce((select jsonb_agg(d.payload order by d.id) from orka.env_devices d where d.owner=m.user_id),'[]'::jsonb) as devices
       from orka.members m left join orka.env_profiles p on p.user_id=m.user_id where m.project_id=$1 order by label`,
          [projectId],
        )
      ).rows,
    };
  }
  if (call.operation === "list") {
    const { projectId } = scope.parse(call.input);
    return store.transaction(async (db) => {
      await db.query("select id from orka.projects where id=$1 for share", [
        projectId,
      ]);
      await store.member(user, projectId, db);
      const records = await db.query(
        "select s.header,s.updated_at,(select a.author from orka.env_activity a where a.project_id=s.project_id and a.set_id=s.id and a.revision=s.revision limit 1) as updated_by from orka.env_sets s where s.project_id=$1 and s.header->'manifest'->'grants' ? $2 and s.header->'manifest'->>'deleted'='false' order by s.updated_at desc",
        [projectId, user],
      );
      return {
        sets: (
          await Promise.all(
            records.rows.map(async (r): Promise<EnvSet | null> => {
              const m = (r.header as EnvHeader).manifest;
              const access = await store.permissions.access(
                user,
                projectId,
                {
                  resourceId: m.setId,
                  kind: "env",
                  owner: m.creator,
                },
                db,
              );
              if (access.mode === "hidden") return null;
              const replacement = (
                await db.query(
                  "select replacement_id,disabled from orka.env_replacements where project_id=$1 and set_id=$2",
                  [projectId, m.setId],
                )
              ).rows[0];
              return {
                access,
                disabled: Boolean(replacement?.disabled),
                replacementId: replacement?.replacement_id ?? null,
                setId: m.setId,
                sourceId: m.sourceId ?? projectId,
                projectId,
                name: m.name,
                creator: m.creator,
                revision: m.revision,
                accessRevision: m.accessRevision,
                grants: m.grants,
                devices: m.devices,
                updatedAt: new Date(r.updated_at).toISOString(),
                updatedBy: r.updated_by ?? m.creator,
                approved: m.devices.some(
                  (d) => d.id === device.id && d.owner === user,
                ),
              };
            }),
          )
        ).filter((r): r is EnvSet => r !== null),
      };
    });
  }
  if (call.operation === "read") {
    const { projectId, setId } = setScope.parse(call.input);
    return store.transaction(async (db) => {
      // Serialize with mutations so the payload and chain describe the same version.
      await db.query("select id from orka.projects where id=$1 for share", [
        projectId,
      ]);
      await store.member(user, projectId, db);
      const row = await db.query(
        "select header,ciphertext from orka.env_sets where project_id=$1 and id=$2",
        [projectId, setId],
      );
      if (!row.rowCount) throw new HttpError(404, "ENV set not found");
      await store.permissions.require(
        user,
        projectId,
        {
          resourceId: setId,
          kind: "env",
          owner: row.rows[0].header.manifest.creator,
        },
        "read",
        db,
      );
      const replacement = (
        await db.query(
          "select replacement_id from orka.env_replacements where project_id=$1 and set_id=$2 and disabled",
          [projectId, setId],
        )
      ).rows[0];
      if (replacement?.replacement_id)
        throw new HttpError(
          403,
          "This ENV set has been replaced; use the replacement set",
        );
      allowed(row.rows[0].header.manifest, user, device.id);
      const history = await db.query(
        "select header from orka.env_headers where project_id=$1 and set_id=$2 order by revision",
        [projectId, setId],
      );
      return {
        version: { ...row.rows[0].header, ciphertext: row.rows[0].ciphertext },
        chain: history.rows.map((r) => r.header),
      };
    });
  }
  const input = envMutation.parse(call.input),
    next = input.version.manifest;
  if (next.authorDeviceId !== device.id)
    throw new HttpError(403, "ENV publisher does not match this device");
  requireSignature(device, next, input.version.signature);
  const encrypted = Buffer.from(input.version.ciphertext, "base64");
  if (
    encrypted.toString("base64") !== input.version.ciphertext ||
    createHash("sha256").update(encrypted).digest("hex") !==
      next.ciphertextHash ||
    (next.deleted
      ? encrypted.length !== 0
      : encrypted.length > 1_150_000 ||
        !encrypted
          .subarray(0, 22)
          .equals(Buffer.from("age-encryption.org/v1\n")))
  )
    throw new HttpError(400, "Invalid encrypted ENV payload");
  return store.transaction(async (db) => {
    await db.query("select id from orka.projects where id=$1 for update", [
      next.projectId,
    ]);
    await store.member(user, next.projectId, db);
    if (
      next.sourceId &&
      !(
        await db.query(
          "select 1 from orka.project_sources where project_id=$1 and id=$2",
          [next.projectId, next.sourceId],
        )
      ).rowCount
    )
      throw new HttpError(
        400,
        "ENV source folder does not belong to this project",
      );
    const rows = await db.query(
      "select header from orka.env_sets where project_id=$1 and id=$2",
      [next.projectId, next.setId],
    );
    const previous = rows.rows[0]?.header as EnvHeader | undefined;
    if (
      !previous &&
      (await store.permissions.resource(db, next.projectId, next.setId))
    )
      throw new HttpError(
        409,
        "ENV ID is already used by an ordinary resource",
      );
    await store.permissions.require(
      user,
      next.projectId,
      {
        resourceId: next.setId,
        kind: "env",
        owner: previous?.manifest.creator,
      },
      "publish",
      db,
      !previous,
    );
    if (
      (
        await db.query(
          "select 1 from orka.env_replacements where project_id=$1 and set_id=$2 and disabled",
          [next.projectId, next.setId],
        )
      ).rowCount
    )
      throw new HttpError(
        403,
        "This ENV set needs replacement and cannot publish new versions",
      );
    if (
      previous &&
      envCanonical(previous.manifest.grants) !== envCanonical(next.grants) &&
      !(
        await store.permissions.access(
          user,
          next.projectId,
          { resourceId: next.setId, kind: "env", owner: next.creator },
          db,
        )
      ).canShare &&
      (await store.permissions.project(db, next.projectId, user)).governed
    )
      throw new HttpError(
        403,
        "Managing ENV recipients requires sharing permission and a trusted device",
      );
    // Membership and signature checks happen even for retries. Receipts never contain ciphertext.
    const receipt = await db.query(
      "select request_hash,payload from orka.env_receipts where project_id=$1 and author=$2 and id=$3",
      [next.projectId, user, input.requestId],
    );
    if (receipt.rowCount) {
      if (receipt.rows[0].request_hash !== envHash(input))
        throw new HttpError(409, "ENV retry ID reused with different content");
      return receipt.rows[0].payload;
    }
    if (previous) allowed(previous.manifest, user, device.id);
    else if (next.creator !== user)
      throw new HttpError(403, "Only the ENV creator can initialize a set");
    if (
      input.expectedRevision !== (previous?.manifest.revision ?? 0) ||
      input.expectedAccessRevision !==
        (previous?.manifest.accessRevision ?? 0) ||
      next.previousHash !== (previous ? envHash(previous) : "")
    )
      throw new HttpError(
        409,
        "ENV changed. Pull the latest version and review before publishing again",
      );
    try {
      validateEnvTransition(previous?.manifest, next);
    } catch {
      throw new HttpError(403, "Invalid ENV authorization transition");
    }
    const members = await db.query(
      "select user_id from orka.members where project_id=$1",
      [next.projectId],
    );
    if (next.grants.some((id) => !members.rows.some((r) => r.user_id === id)))
      throw new HttpError(
        403,
        "ENV recipients must be current project members",
      );
    if ((await store.permissions.project(db, next.projectId, user)).governed)
      for (const recipient of next.grants) {
        const access = await store.permissions.access(
          recipient,
          next.projectId,
          { resourceId: next.setId, kind: "env", owner: next.creator },
          db,
        );
        if (access.mode === "hidden")
          throw new HttpError(
            403,
            "ENV recipient also needs project permission",
          );
      }
    for (const recipient of next.devices) {
      const registered = await db.query(
        "select payload from orka.env_devices where id=$1 and owner=$2",
        [recipient.id, recipient.owner],
      );
      if (
        !registered.rowCount ||
        envCanonical(registered.rows[0].payload) !== envCanonical(recipient)
      )
        throw new HttpError(403, "ENV recipient device keys changed");
    }
    const added = next.approvals.filter(
      (a) =>
        !previous?.manifest.approvals.some(
          (old) => old.request.nonce === a.request.nonce,
        ),
    );
    for (const approval of next.approvals)
      requireSignature(
        approval.request.device,
        approval.request,
        approval.signature,
      );
    for (const approval of added) {
      if (
        approval.request.expiresAt < Date.now() ||
        approval.request.expiresAt > Date.now() + 900_000
      )
        throw new HttpError(
          400,
          "Device approval expired; generate a new request",
        );
      if (
        (
          await db.query(
            "select 1 from orka.env_nonces where project_id=$1 and set_id=$2 and nonce=$3",
            [next.projectId, next.setId, approval.request.nonce],
          )
        ).rowCount
      )
        throw new HttpError(409, "Device approval request already used");
    }
    const header: EnvHeader = {
      manifest: next,
      signature: input.version.signature,
    };
    await db.query(
      "insert into orka.env_sets values($1,$2,$3,$4,$5,now()) on conflict(project_id,id) do update set revision=excluded.revision,header=excluded.header,ciphertext=excluded.ciphertext,updated_at=now()",
      [
        next.projectId,
        next.setId,
        next.revision,
        header,
        input.version.ciphertext,
      ],
    );
    await db.query("insert into orka.env_headers values($1,$2,$3,$4)", [
      next.projectId,
      next.setId,
      next.revision,
      header,
    ]);
    for (const approval of added)
      await db.query("insert into orka.env_nonces values($1,$2,$3)", [
        next.projectId,
        next.setId,
        approval.request.nonce,
      ]);
    const result = { revision: next.revision, hash: envHash(header) };
    await db.query("insert into orka.env_receipts values($1,$2,$3,$4,$5)", [
      next.projectId,
      user,
      input.requestId,
      envHash(input),
      result,
    ]);
    await db.query(
      "insert into orka.env_activity(project_id,set_id,author,device_id,revision,action) values($1,$2,$3,$4,$5,$6)",
      [
        next.projectId,
        next.setId,
        user,
        device.id,
        next.revision,
        next.deleted
          ? "deleted"
          : !previous
            ? "created"
            : next.accessRevision !== previous.manifest.accessRevision
              ? "access_changed"
              : "published",
      ],
    );
    return result;
  });
}
