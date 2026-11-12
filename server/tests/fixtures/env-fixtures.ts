import {
  createPrivateKey,
  createPublicKey,
  createHash,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import {
  envCanonical,
  envAccess,
  type EnvDevice,
  type EnvHeader,
  type EnvManifest,
  type EnvVersion,
} from "@portable/protocol";

export function identity(owner: string = randomUUID(), seed = randomBytes(32)) {
  const privateKey = createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      seed,
    ]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(privateKey)
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("hex");
  const device: EnvDevice = {
    id: randomUUID(),
    owner,
    name: "Test Mac",
    signingKey: publicKey,
    encryptionKey: "age1" + "q".repeat(58),
  };
  const signature = (value: unknown) =>
    sign(null, Buffer.from(envCanonical(value)), privateKey).toString("hex");
  return { device, signature };
}
export const digest = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
export const headerHash = (header: EnvHeader) => digest(envCanonical(header));
export function version(
  author: ReturnType<typeof identity>,
  project: string,
  changes: Partial<EnvManifest> = {},
  old?: EnvVersion,
): EnvVersion {
  // The server handles opaque age bytes. Real encryption/decryption is covered in native tests.
  const ciphertext = Buffer.concat([
    Buffer.from("age-encryption.org/v1\n"),
    randomBytes(64),
  ]).toString("base64");
  const manifest: EnvManifest = {
    format: 1,
    projectId: project,
    setId: randomUUID(),
    name: "Development",
    creator: author.device.owner,
    revision: 1,
    accessRevision: 1,
    grants: [author.device.owner],
    devices: [author.device],
    approvals: [],
    authorDeviceId: author.device.id,
    previousHash: "",
    ciphertextHash: digest(Buffer.from(ciphertext, "base64")),
    deleted: false,
    ...old?.manifest,
    ...changes,
  };
  manifest.authorDeviceId = author.device.id;
  manifest.revision = (old?.manifest.revision ?? 0) + 1;
  manifest.previousHash = old
    ? headerHash({ manifest: old.manifest, signature: old.signature })
    : "";
  manifest.accessRevision =
    (old?.manifest.accessRevision ?? 1) +
    (old && envAccess(manifest) !== envAccess(old.manifest) ? 1 : 0);
  manifest.ciphertextHash = digest(
    manifest.deleted ? Buffer.alloc(0) : Buffer.from(ciphertext, "base64"),
  );
  return {
    manifest,
    signature: author.signature(manifest),
    ciphertext: manifest.deleted ? "" : ciphertext,
  };
}
