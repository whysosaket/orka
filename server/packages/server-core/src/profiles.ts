import { z } from "zod";
import { crc32, inflateSync } from "node:zlib";
import type { Store } from "./store.js";
import { HttpError } from "./store.js";
export const remoteKey = z.string().regex(/^[0-9a-f]{64}$/);
export function validAvatarData(value: string): boolean {
  const prefix = "data:image/png;base64,";
  if (!value.startsWith(prefix)) return false;
  const encoded = value.slice(prefix.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false;
  const bytes = Buffer.from(encoded, "base64");
  if (
    bytes.length < 33 ||
    bytes.length > 524288 ||
    bytes.toString("base64") !== encoded
  )
    return false;
  if (
    !bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString("ascii", 12, 16) !== "IHDR"
  )
    return false;
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  if (!width || !height || width > 512 || height > 512) return false;
  // The bounded canvas pipeline emits non-interlaced, 8-bit PNGs. Check the
  // complete container and decode with a strict output bound, not just IHDR.
  const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  if (
    bytes[24] !== 8 ||
    !channels[bytes[25]] ||
    bytes[26] !== 0 ||
    bytes[27] !== 0 ||
    bytes[28] !== 0
  )
    return false;
  const compressed: Buffer[] = [];
  let offset = 8,
    ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset),
      end = offset + 8 + length;
    if (
      end + 4 > bytes.length ||
      crc32(bytes.subarray(offset + 4, end)) !== bytes.readUInt32BE(end)
    )
      return false;
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") compressed.push(bytes.subarray(offset + 8, end));
    offset = end + 4;
    if (type === "IEND") {
      ended = length === 0 && offset === bytes.length;
      break;
    }
  }
  if (!ended || !compressed.length) return false;
  try {
    const row = width * channels[bytes[25]] + 1;
    const decoded = inflateSync(Buffer.concat(compressed), {
      maxOutputLength: row * height,
    });
    return (
      decoded.length === row * height &&
      Array.from({ length: height }, (_, i) => decoded[i * row]).every(
        (filter) => filter <= 4,
      )
    );
  } catch {
    return false;
  }
}
const columns =
  'display_name as "displayName",job_role as "jobRole",avatar_url as "avatarUrl",avatar_data as "avatarData",source,updated_at as "updatedAt",updated_at::text as revision';
export const profileInput = z
  .object({
    displayName: z.string().trim().min(1).max(80),
    avatarUrl: z
      .string()
      .max(2048)
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === "https:" &&
          url.hostname === "avatars.githubusercontent.com" &&
          !url.username &&
          !url.password &&
          !url.port &&
          value.startsWith("https://avatars.githubusercontent.com/")
        );
      }, "Choose a GitHub avatar URL")
      .nullable()
      .optional(),
    jobRole: z.string().trim().max(80).nullable().optional(),
    avatarData: z
      .string()
      .max(700000)
      .refine(validAvatarData, "Choose a PNG photo up to 512 by 512 pixels")
      .nullable()
      .optional(),
    source: z.enum(["github", "email", "user"]),
    ifAbsent: z.boolean().optional(),
    expectedRevision: z.string().min(1).max(64).optional(),
  })
  .strict();
export async function getProfile(store: Store, user: string) {
  const result = await store.pool.query(
    `select ${columns} from orka.profiles where user_id=$1`,
    [user],
  );
  if (!result.rowCount) throw new HttpError(404, "Profile not set up yet");
  return result.rows[0];
}
export async function putProfile(store: Store, user: string, raw: unknown) {
  const input = profileInput.parse(raw);
  return store.transaction(async (db) => {
    const selected = columns;
    // Compare under the same row lock as the write; the token is always bound.
    if (input.expectedRevision !== undefined) {
      const current = await db.query(
        "select updated_at::text as revision from orka.profiles where user_id=$1 for update",
        [user],
      );
      if (
        input.ifAbsent ||
        current.rows[0]?.revision !== input.expectedRevision
      )
        throw new HttpError(409, "Profile changed; review the latest values");
    }
    const inserted = await db.query(
      `insert into orka.profiles(user_id,display_name,avatar_url,source,job_role,avatar_data) values($1,$2,$3,$4,$5,$6)
      on conflict(user_id) ${input.ifAbsent ? "do nothing" : "do update set display_name=excluded.display_name,avatar_url=excluded.avatar_url,source=excluded.source,job_role=case when $7 then excluded.job_role else orka.profiles.job_role end,avatar_data=case when $8 then excluded.avatar_data else orka.profiles.avatar_data end,updated_at=now()"} returning ${selected}`,
      [
        user,
        input.displayName,
        input.avatarUrl ?? null,
        input.source,
        input.jobRole ?? null,
        input.avatarData ?? null,
        ...(!input.ifAbsent
          ? [input.jobRole !== undefined, input.avatarData !== undefined]
          : []),
      ],
    );
    const profile =
      inserted.rows[0] ??
      (
        await db.query(
          `select ${selected} from orka.profiles where user_id=$1`,
          [user],
        )
      ).rows[0];
    // Existing ENV directories and append-only logs share this account label.
    await db.query(
      "insert into orka.env_profiles(user_id,label) values($1,$2) on conflict(user_id) do update set label=excluded.label",
      [user, profile.displayName],
    );
    return profile;
  });
}
