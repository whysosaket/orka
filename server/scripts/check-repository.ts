import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { basename } from "node:path";

const files = execFileSync("git", ["ls-files", "--cached", "-z"], {
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);
assert.deepEqual(
  readdirSync("packages/server-core/migrations").filter((name) =>
    name.endsWith(".sql"),
  ),
  ["001_initial.sql", "002_github_repositories.sql"],
);
const forbidden = files.filter((path) => {
  const name = basename(path);
  return (
    /(^|\/)(PLAN|PLANS)\.md$|(^|\/)docs\/[^/]*-plan\.md$/.test(path) ||
    ((name === ".env" || name.startsWith(".env.")) &&
      name !== ".env.example") ||
    /\.(pem|key|p12|pfx|sqlite\w*|db|dump|log|dmg)$/.test(name) ||
    /(^|\/)(node_modules|target|dist|artifacts|\.runtime|backups|\.orka)\//.test(
      path,
    )
  );
});
assert.deepEqual(
  forbidden,
  [],
  "Private or generated files must not be tracked.",
);
for (const path of [
  "PLAN.md",
  "docs/self-hosting-plan.md",
  ".codex/plans/example.md",
  ".env",
  ".env.local",
  "nested/.env.production",
  "credentials.json",
  "private.pem",
  "nested/data.sqlite",
  ".runtime/example.json",
  "artifacts/example.json",
]) {
  assert.equal(
    spawnSync("git", ["check-ignore", "--no-index", "--quiet", "--", path])
      .status,
    0,
    `Missing ignore protection: ${path}`,
  );
}
for (const path of [".env.example", "deploy/ec2/.env.example"])
  assert.equal(
    spawnSync("git", ["check-ignore", "--no-index", "--quiet", "--", path])
      .status,
    1,
    `Example must remain publishable: ${path}`,
  );

const privateMetadata =
  /\/Users\/[A-Za-z][\w.-]*\/|\bi-[0-9a-f]{8,17}\b|https:\/\/(?:app\.)?notion\.(?:com|so)\//;
for (const path of files.filter((path) => /\.(md|html)$/.test(path)))
  assert.ok(
    !privateMetadata.test(readFileSync(path, "utf8")),
    `Review personal or internal metadata in ${path}`,
  );
console.log(`Repository boundaries passed for ${files.length} tracked files.`);
