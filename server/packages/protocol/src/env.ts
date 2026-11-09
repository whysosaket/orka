import { z } from "zod";

export const ENV_FORMAT = 1 as const;
export const ENV_MAX_BYTES = 1_000_000;
const id = z.uuid();
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const signature = z.string().regex(/^[a-f0-9]{128}$/);
export const envDevice = z
  .object({
    id,
    owner: id,
    name: z.string().trim().min(1).max(100),
    encryptionKey: z
      .string()
      .regex(/^age1[023456789acdefghjklmnpqrstuvwxyz]{58}$/),
    signingKey: hash,
  })
  .strict();
export const envRequest = z
  .object({
    format: z.literal(ENV_FORMAT),
    projectId: id,
    setId: id,
    device: envDevice,
    nonce: id,
    expiresAt: z.number().int().positive(),
  })
  .strict();
export const envApproval = z
  .object({ request: envRequest, signature })
  .strict();
export const envManifest = z
  .object({
    format: z.literal(ENV_FORMAT),
    projectId: id,
    sourceId: id.optional(),
    setId: id,
    name: z.string().trim().min(1).max(100),
    creator: id,
    revision: revision.refine((v) => v > 0),
    accessRevision: revision.refine((v) => v > 0),
    grants: z.array(id).min(1).max(100),
    devices: z.array(envDevice).min(1).max(200),
    approvals: z.array(envApproval).max(200),
    authorDeviceId: id,
    previousHash: z.union([hash, z.literal("")]),
    ciphertextHash: hash,
    deleted: z.boolean(),
  })
  .strict();
export const envHeader = z
  .object({ manifest: envManifest, signature })
  .strict();
export const envVersion = envHeader
  .extend({
    ciphertext: z
      .string()
      .max(1_600_000)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/),
  })
  .strict();
export const envMutation = z
  .object({
    requestId: id,
    expectedRevision: revision,
    expectedAccessRevision: revision,
    version: envVersion,
  })
  .strict();
export const envCall = z
  .object({
    format: z.literal(ENV_FORMAT),
    deviceId: id,
    time: z.number().int(),
    nonce: id,
    operation: z.enum(["enroll", "directory", "list", "read", "mutate"]),
    input: z.unknown(),
  })
  .strict();
export const envSignedCall = z.object({ call: envCall, signature }).strict();
export type EnvDevice = z.infer<typeof envDevice>;
export type EnvApproval = z.infer<typeof envApproval>;
export type EnvManifest = z.infer<typeof envManifest>;
export type EnvHeader = z.infer<typeof envHeader>;
export type EnvVersion = z.infer<typeof envVersion>;
export type EnvMutation = z.infer<typeof envMutation>;
export type EnvCall = z.infer<typeof envCall>;
export interface EnvSet {
  access?: import("./governance.js").EffectiveAccess;
  disabled?: boolean;
  replacementId?: string | null;
  setId: string;
  projectId: string;
  sourceId?: string;
  name: string;
  creator: string;
  revision: number;
  accessRevision: number;
  updatedAt: string;
  updatedBy: string;
  grants: string[];
  devices: EnvDevice[];
  approved: boolean;
}
export interface EnvMember {
  id: string;
  label: string;
  devices: EnvDevice[];
}

// Signed values contain only integers, strings, booleans, arrays and objects.
// Rust's serde_json::Map uses the same sorted ordering for these ASCII field names.
export function envCanonical(value: unknown): string {
  if (Array.isArray(value))
    return "[" + value.map(envCanonical).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return (
      "{" +
      Object.keys(object)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + envCanonical(object[k]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}
export function isEnvPath(path: string): boolean {
  return path.split(/[\\/]/).some((part) => {
    const name = part.toLowerCase();
    return name === ".env" || name.startsWith(".env.") || name.endsWith(".env");
  });
}
export function envAccess(manifest: EnvManifest): string {
  return envCanonical({
    grants: manifest.grants,
    devices: manifest.devices,
    approvals: manifest.approvals,
  });
}

/** Authorization rules are also checked by recipients before decrypting. */
export function validateEnvTransition(
  previous: EnvManifest | undefined,
  next: EnvManifest,
): void {
  const fail = () => {
    throw new Error("Invalid ENV authorization transition");
  };
  const unique = (items: string[]) => new Set(items).size === items.length;
  if (
    !unique(next.grants) ||
    !unique(next.devices.map((d) => d.id)) ||
    !unique(next.approvals.map((a) => a.request.device.id)) ||
    !unique(next.approvals.map((a) => a.request.nonce)) ||
    !next.grants.includes(next.creator) ||
    next.devices.some((d) => !next.grants.includes(d.owner))
  )
    fail();
  const author = (previous ?? next).devices.find(
    (d) => d.id === next.authorDeviceId,
  );
  if (!author) return fail();
  if (!previous) {
    if (
      next.revision !== 1 ||
      next.accessRevision !== 1 ||
      next.previousHash !== "" ||
      next.deleted ||
      author.owner !== next.creator ||
      next.devices.length !== 1 ||
      next.approvals.length
    )
      fail();
    return;
  }
  if (
    previous.deleted ||
    next.creator !== previous.creator ||
    next.projectId !== previous.projectId ||
    (next.sourceId ?? next.projectId) !==
      (previous.sourceId ?? previous.projectId) ||
    next.setId !== previous.setId ||
    next.revision !== previous.revision + 1 ||
    !previous.grants.includes(author.owner) ||
    next.accessRevision !==
      previous.accessRevision +
        (envAccess(previous) === envAccess(next) ? 0 : 1)
  )
    fail();
  if (
    author.owner !== previous.creator &&
    (next.deleted ||
      next.name !== previous.name ||
      envCanonical(next.grants) !== envCanonical(previous.grants))
  )
    fail();
  for (const device of next.devices) {
    const old = previous.devices.find((d) => d.id === device.id);
    if (old) {
      if (envCanonical(old) !== envCanonical(device)) fail();
    } else {
      const approval = next.approvals.find(
        (a) => a.request.device.id === device.id,
      );
      if (
        !approval ||
        envCanonical(approval.request.device) !== envCanonical(device) ||
        approval.request.projectId !== next.projectId ||
        approval.request.setId !== next.setId ||
        (author.owner !== previous.creator && author.owner !== device.owner)
      )
        fail();
    }
  }
  if (
    author.owner !== previous.creator &&
    previous.devices.some(
      (d) =>
        !next.devices.some((n) => n.id === d.id) && d.owner !== author.owner,
    )
  )
    fail();
  for (const approval of next.approvals) {
    if (
      !next.devices.some(
        (d) => envCanonical(d) === envCanonical(approval.request.device),
      )
    )
      fail();
    const old = previous.approvals.find(
      (a) => a.request.device.id === approval.request.device.id,
    );
    if (old && envCanonical(old) !== envCanonical(approval)) fail();
  }
  for (const approval of previous.approvals) {
    if (
      next.devices.some((d) => d.id === approval.request.device.id) &&
      !next.approvals.some((a) => envCanonical(a) === envCanonical(approval))
    )
      fail();
  }
}
