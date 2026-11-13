import { randomInt } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function available(port: number) {
  const listener = createServer();
  return new Promise<boolean>((resolve, reject) => {
    listener.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES")
        resolve(false);
      else reject(error);
    });
    listener.listen(port, "127.0.0.1", () =>
      listener.close((error) => (error ? reject(error) : resolve(true))),
    );
  });
}

export async function reserveImagePorts(start = randomInt(20000, 25000)) {
  // Both ranges are below default Linux/macOS outgoing ephemeral ports. Keep
  // a pair lease through teardown so parallel fixtures cannot race Docker's bind.
  for (let offset = 0; offset < 5000; offset++) {
    const port = 20000 + ((start - 20000 + offset) % 5000);
    const mailPort = port + 5000;
    const lease = join(tmpdir(), "orka-image-ports-" + port);
    try {
      await mkdir(lease);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    try {
      if (!(await available(port)) || !(await available(mailPort))) {
        await rm(lease, { recursive: true });
        continue;
      }
      let released = false;
      const cleanup = () => {
        if (released) return;
        released = true;
        rmSync(lease, { recursive: true, force: true });
      };
      process.once("exit", cleanup);
      return {
        port,
        mailPort,
        release() {
          process.removeListener("exit", cleanup);
          cleanup();
        },
      };
    } catch (error) {
      await rm(lease, { recursive: true, force: true });
      throw error;
    }
  }
  throw new Error("No API/mail port pair is available for the image fixture");
}
