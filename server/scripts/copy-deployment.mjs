import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

// Explicit distribution inputs keep local credentials and runtime data out of packages.
const files = [
  "Dockerfile",
  "build/compose.yml",
  "cloud/compose.yml",
  "local/compose.yml",
  "testing/email-hook-proxy.mjs",
  "ec2/.env.example",
  "ec2/Caddyfile",
  "ec2/Caddyfile.ip",
  "ec2/README.md",
  "ec2/backup.sh",
  "ec2/backfill-member-emails.sql",
  "ec2/bootstrap.sh",
  "ec2/compose.yml",
  "ec2/init-db.sh",
  "ec2/restore-check.sh",
  "ec2/verify-blobs.py",
];
rmSync("packages/server-core/deploy", { recursive: true, force: true });
for (const file of files) {
  const output = join("packages/server-core/deploy", file);
  mkdirSync(dirname(output), { recursive: true });
  copyFileSync(join("deploy", file), output);
}
