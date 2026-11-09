import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const [image, requestedOutput = "artifacts/release/orka-server.tar.gz"] =
  process.argv.slice(2);
assert.ok(
  image && /^[a-zA-Z0-9._/:@-]+$/.test(image) && /:[^/]+$/.test(image),
  "Usage: npm run package:operator -- registry/orka:version [archive.tar.gz]",
);
const output = resolve(requestedOutput);
const temporary = mkdtempSync(join(tmpdir(), "orka-operator-"));
try {
  const root = join(temporary, "orka-server");
  mkdirSync(root);
  const compose = JSON.parse(
    execFileSync(
      "docker",
      [
        "compose",
        "--env-file",
        "/dev/null",
        "-f",
        "compose.yml",
        "config",
        "--no-interpolate",
        "--no-path-resolution",
        "--format",
        "json",
      ],
      {
        encoding: "utf8",
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => !key.startsWith("COMPOSE_"),
          ),
        ),
      },
    ),
  );
  delete compose.services.api.build;
  compose.services.api.image = "${ORKA_IMAGE:?Choose the released image}";
  compose.services.api.pull_policy = "never";
  compose.services.admin.image = compose.services.api.image;
  // Compose must derive names from the saved installation, not the build host.
  for (const section of ["networks", "volumes", "secrets"])
    for (const item of Object.values(compose[section] ?? {})) delete item.name;
  const files = [
    "orka-server",
    "configure.sh",
    "compose.image.yml",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "deploy/local/compose.yml",
    "deploy/self-hosted/.env.example",
    "deploy/self-hosted/restore.sh",
    "deploy/ec2/init-db.sh",
    "deploy/ec2/Caddyfile",
    "deploy/ec2/backup.sh",
    "deploy/ec2/restore-check.sh",
    "deploy/ec2/verify-blobs.py",
  ];
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    copyFileSync(file, join(root, file));
  }
  if (existsSync("source-manifest.json"))
    copyFileSync("source-manifest.json", join(root, "source-manifest.json"));
  writeFileSync(
    join(root, "compose.yml"),
    JSON.stringify(compose, null, 2) + "\n",
  );
  writeFileSync(join(root, ".release-image"), image + "\n");
  writeFileSync(
    join(root, "README.md"),
    `# Orka server\n\nThis operator release runs ${image}. Install Docker Compose 2.24 or later, a shell and OpenSSL. Backups and recovery also require Bash and Python 3.\n\nRun \`sh ./orka-server setup --local --email you@example.com\` to try it locally, or use \`setup --domain sync.example.com --email you@example.com\` after configuring DNS and ports 80/443. Run \`credentials\` to retrieve the saved owner login locally.\n\nEveryday commands: \`start\`, \`stop\`, \`status\`, \`doctor\`, \`logs\`, \`user teammate@example.com\` and \`backup\`. Start reuses installed images and data. Use \`upgrade --image registry/orka:version\` after reviewing the release notes; upgrade verifies a backup before changing images. Keep this directory and private .env for the installation. Backups contain credentials: encrypt off-host copies.\n\nOn a clean host, extract the matching release and run \`restore /absolute/backup\`. The destination must have no .env and the saved Compose project must have no existing containers or volumes. A new \`--project name\` can be used for an isolated recovery drill. Existing account passwords remain valid.\n\nThe complete source and provider configuration are documented at https://github.com/whysosaket/orka/tree/main/server. No Git, npm or source build is required for this archive.\n`,
  );
  mkdirSync(dirname(output), { recursive: true });
  execFileSync("tar", ["-czf", output, "-C", temporary, "orka-server"]);
  const digest = createHash("sha256")
    .update(readFileSync(output))
    .digest("hex");
  writeFileSync(
    output + ".sha256",
    digest + "  " + output.split("/").at(-1) + "\n",
  );
  console.log(`Operator archive: ${output}\nSHA-256: ${digest}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
