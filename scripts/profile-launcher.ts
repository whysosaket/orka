import { createHash } from "node:crypto";
import { basename } from "node:path";
import { createServer } from "node:net";

export function worktreeProfile(directory: string) {
  const slug = basename(directory)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .slice(0, 24);
  return `wt-${slug}-${createHash("sha256").update(directory).digest("hex").slice(0, 10)}`;
}

export function validateProfile(name: string) {
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(name))
    throw new Error(
      "Profile names use 1–48 lowercase letters, numbers or hyphens, starting with a letter.",
    );
  return name;
}

export async function availablePort(
  start: number,
  attempts = 100,
): Promise<number> {
  for (let port = start; port < Math.min(start + attempts, 65536); port++) {
    const available = await new Promise<boolean>((resolve) => {
      const server = createServer();
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
    });
    if (available) return port;
  }
  throw new Error(
    `No free development port starting at ${start}. Choose --port <number>.`,
  );
}

export function devConfig(port: number) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("Choose a development port from 1024 to 65535.");
  return {
    build: {
      devUrl: `http://127.0.0.1:${port}`,
      beforeDevCommand: `npm run dev -- --port ${port} --strictPort`,
    },
  };
}
