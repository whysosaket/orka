import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { digest, uuid } from "@portable/protocol";
export const bytesHash = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
export class Blobs {
  constructor(readonly root: string) {}
  async removeProject(project: string): Promise<void> {
    await rm(join(this.root, uuid.parse(project)), {
      recursive: true,
      force: true,
    });
  }
  private path(project: string, hash: string): string {
    return join(this.root, uuid.parse(project), digest.parse(hash));
  }
  async read(project: string, hash: string): Promise<Buffer> {
    const b = await readFile(this.path(project, hash));
    if (bytesHash(b) !== hash) throw new Error("Blob integrity failure");
    return b;
  }
  async put(project: string, bytes: Buffer): Promise<string> {
    const hash = bytesHash(bytes),
      destination = this.path(project, hash);
    await mkdir(join(this.root, project), { recursive: true, mode: 0o700 });
    const staged = destination + "." + randomUUID();
    try {
      const file = await open(staged, "wx", 0o600);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(staged, destination);
      const directory = await open(join(this.root, project), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await rm(staged, { force: true });
    }
    return hash;
  }
}
