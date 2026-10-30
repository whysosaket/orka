import { cp, mkdir, rm, symlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
const stage = "artifacts/installer";
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await cp(
  "apps/mac/src-tauri/target/debug/bundle/macos/Orka.app",
  `${stage}/Orka.app`,
  { recursive: true },
);
await symlink("/Applications", `${stage}/Applications`);
const result = spawnSync(
  "/usr/bin/hdiutil",
  [
    "create",
    "-ov",
    "-volname",
    "Orka",
    "-srcfolder",
    stage,
    "-format",
    "UDZO",
    "artifacts/Portable-Workspace-local.dmg",
  ],
  { stdio: "inherit" },
);
if (result.status !== 0) throw new Error("Local installer creation failed");
console.log(
  "Local testing installer created. This is not an Apple-signed or notarized release.",
);
