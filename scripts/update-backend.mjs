import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [tag, source] = process.argv.slice(2);
assert.match(
  tag ?? "",
  /^v\d+\.\d+\.\d+$/,
  "Usage: npm run backend:update -- vX.Y.Z [release-directory]",
);
const temporary = mkdtempSync(join(tmpdir(), "orka-backend-"));
try {
  if (source) cpSync(resolve(source), temporary, { recursive: true });
  else
    execFileSync(
      "gh",
      [
        "release",
        "download",
        tag,
        "--repo",
        "whysosaket/orka-api",
        "--dir",
        temporary,
        "--pattern",
        "portable-protocol-*.tgz",
        "--pattern",
        "manifest.json",
      ],
      { stdio: "inherit" },
    );
  const manifest = JSON.parse(
    readFileSync(join(temporary, "manifest.json"), "utf8"),
  );
  assert.equal(manifest.repository, "https://github.com/whysosaket/orka-api");
  assert.match(manifest.commit, /^[a-f0-9]{40}$/);
  if (manifest.candidate) {
    assert.ok(
      source,
      "Working-tree candidates must come from an explicit local release directory",
    );
    assert.match(manifest.sourceTreeSha256, /^[a-f0-9]{64}$/);
  }
  // Backend releases also contain private server packages; only publish the client contract.
  manifest.packages = manifest.packages.filter(
    (pkg) => pkg.name === "@portable/protocol",
  );
  assert.deepEqual(
    manifest.packages.map((p) => p.name),
    ["@portable/protocol"],
  );
  for (const pkg of manifest.packages) {
    assert.equal(pkg.version, tag.slice(1));
    assert.equal(
      pkg.file,
      `portable-${pkg.name.split("/")[1]}-${pkg.version}.tgz`,
    );
    const bytes = readFileSync(join(temporary, pkg.file));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), pkg.sha256);
    assert.equal(
      "sha512-" + createHash("sha512").update(bytes).digest("base64"),
      pkg.integrity,
    );
  }
  mkdirSync("vendor", { recursive: true });
  const config = JSON.parse(readFileSync("package.json", "utf8"));
  for (const pkg of manifest.packages) {
    for (const file of readdirSync("vendor"))
      if (file.startsWith("portable-protocol-") && file !== pkg.file)
        rmSync(join("vendor", file));
    cpSync(join(temporary, pkg.file), join("vendor", pkg.file));
    config.dependencies[pkg.name] = `file:vendor/${pkg.file}`;
  }
  writeFileSync(
    "vendor/manifest.json",
    JSON.stringify(manifest, null, 2) + "\n",
  );
  writeFileSync("package.json", JSON.stringify(config, null, 2) + "\n");
  // Explicit file arguments also refresh npm's integrity when validating a local pre-release build.
  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--save",
      `./vendor/portable-protocol-${tag.slice(1)}.tgz`,
    ],
    { stdio: "inherit" },
  );
  console.log(
    `Pinned protocol ${tag} from ${manifest.commit}${manifest.candidate ? ` with candidate source tree ${manifest.sourceTreeSha256}` : ""}; run the desktop compatibility checks before committing.`,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
