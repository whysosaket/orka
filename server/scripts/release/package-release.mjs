import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const candidate = process.argv.includes("--candidate");
if (!candidate)
  execFileSync("git", ["diff", "--exit-code", "HEAD"], { stdio: "ignore" });
if (
  !candidate &&
  execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
    encoding: "utf8",
  }).trim()
)
  throw new Error("Commit source files before recording release provenance.");
const output = resolve("artifacts/release");
mkdirSync(output, { recursive: true });
const packages = [];
for (const name of ["protocol"]) {
  const result = JSON.parse(
    execFileSync(
      "npm",
      [
        "pack",
        `./packages/${name}`,
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        output,
      ],
      { encoding: "utf8" },
    ),
  )[0];
  const bytes = readFileSync(resolve(output, result.filename));
  packages.push({
    name: result.name,
    version: result.version,
    file: result.filename,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    integrity: result.integrity,
  });
}
const manifest = {
  server: {
    language: "Go",
    module: "github.com/whysosaket/orka-api",
    toolchain: "1.27.4",
  },
  repository: "https://github.com/whysosaket/orka-api",
  commit: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  packages,
};
if (candidate) {
  const sourceHash = createHash("sha256");
  const paths = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean)
    .sort();
  for (const path of [...new Set(paths)]) {
    sourceHash
      .update(path + "\0")
      .update(readFileSync(path))
      .update("\0");
  }
  manifest.candidate = true;
  manifest.sourceTreeSha256 = sourceHash.digest("hex");
}
writeFileSync(
  resolve(output, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
console.log(JSON.stringify(manifest, null, 2));
