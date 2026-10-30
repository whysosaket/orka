import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { basename } from "node:path";

const files = execFileSync("git", ["ls-files", "--cached", "-z"], {
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
  "The public desktop must not include the private server implementation.",
);
const forbidden = files.filter((path) => {
  const name = basename(path);
  return (
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
for (const path of [".env.example"])
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
