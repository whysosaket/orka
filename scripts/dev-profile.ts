import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  availablePort,
  devConfig,
  validateProfile,
  worktreeProfile,
} from "./profile-launcher.js";

const args = process.argv.slice(2);
const root = realpathSync(
  execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim(),
);
let profile = process.env.ORKA_PROFILE || worktreeProfile(root);
let requestedPort: number | undefined;
let dryRun = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--profile" && args[i + 1]) profile = args[++i];
  else if (args[i] === "--port" && args[i + 1])
    requestedPort = Number(args[++i]);
  else if (args[i] === "--dry-run") dryRun = true;
  else
    throw new Error(
      "Usage: npm run dev:profile -- [--profile alice] [--port 5200] [--dry-run]",
    );
}
validateProfile(profile);
const preferredPort =
  requestedPort ??
  20000 +
    (createHash("sha256").update(`${root}:${profile}`).digest().readUInt16BE() %
      20000);
devConfig(preferredPort);
const port = await availablePort(preferredPort, requestedPort ? 1 : 100);
const config = devConfig(port);
console.log(
  `Orka profile: ${profile}\nWorktree: ${root}\nFrontend: http://127.0.0.1:${port}`,
);
if (dryRun) console.log(JSON.stringify(config));
else {
  const child = spawn(
    "npm",
    [
      "run",
      "tauri",
      "-w",
      "@portable/mac",
      "--",
      "dev",
      "--config",
      JSON.stringify(config),
    ],
    {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        ORKA_PROFILE: profile,
        CARGO_TARGET_DIR: resolve(root, "apps/mac/src-tauri/target"),
      },
    },
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => child.kill(signal));
  child.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}
