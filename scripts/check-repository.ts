import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { basename } from "node:path";

const tracked = execFileSync("git", ["ls-files", "--cached", "-z"], {
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);
const manifest = JSON.parse(readFileSync("vendor/manifest.json", "utf8")) as {
  packages: {
    name: string;
    version: string;
    file: string;
    sha256: string;
    integrity: string;
  }[];
};
assert.deepEqual(
  manifest.packages.map((pkg) => pkg.name),
  ["@portable/protocol"],
);
const protocol = manifest.packages[0];
assert.equal(protocol.file, `portable-protocol-${protocol.version}.tgz`);
assert.deepEqual(readdirSync("vendor").sort(), [
  "manifest.json",
  protocol.file,
]);
const bytes = readFileSync(`vendor/${protocol.file}`);
assert.equal(createHash("sha256").update(bytes).digest("hex"), protocol.sha256);
assert.equal(
  "sha512-" + createHash("sha512").update(bytes).digest("base64"),
  protocol.integrity,
);
assert.ok(
  !readFileSync("package-lock.json", "utf8").includes("@portable/server-core"),
  "Keep server dependencies in the separate server workspace, outside the desktop dependency graph.",
);
const server = JSON.parse(
  readFileSync("server/source-manifest.json", "utf8"),
) as {
  repository: string;
  commit: string;
  candidate: boolean;
  sourceTreeSha256: string;
  files: { path: string; sha256: string; mode: number }[];
};
assert.equal(server.repository, "https://github.com/whysosaket/orka-api");
assert.match(server.commit, /^[a-f0-9]{40}$/);
assert.equal(typeof server.candidate, "boolean");
assert.deepEqual(
  server.files
    .map((file) => file.path)
    .filter((path) =>
      /^packages\/server-core\/migrations\/.*\.sql$/.test(path),
    ),
  ["packages/server-core/migrations/001_initial.sql"],
);
assert.equal(
  new Set(server.files.map((file) => file.path)).size,
  server.files.length,
);
const sourceTree = createHash("sha256");
for (const file of server.files) {
  assert.ok(
    !file.path.startsWith("/") &&
      !file.path
        .split("/")
        .some((part) => !part || part === ".." || part === "."),
  );
  const bytes = readFileSync(`server/${file.path}`);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    file.sha256,
    `Server snapshot changed: ${file.path}; update from the canonical backend.`,
  );
  sourceTree
    .update(file.path + "\0")
    .update(bytes)
    .update("\0");
}
assert.equal(sourceTree.digest("hex"), server.sourceTreeSha256);
// Include the new source snapshot in boundary checks before it has been staged.
const files = [
  ...new Set([
    ...tracked,
    ...server.files.map((file) => `server/${file.path}`),
    "server/source-manifest.json",
  ]),
];
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
for (const path of [".env.example", "server/deploy/self-hosted/.env.example"])
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
console.log(`Repository boundaries passed for ${files.length} source files.`);
