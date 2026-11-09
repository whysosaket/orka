import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

execFileSync("git", ["diff", "--exit-code", "HEAD"], { stdio: "ignore" });
if (
  execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
    encoding: "utf8",
  }).trim()
)
  throw new Error("Commit or remove untracked source files before packaging.");
execFileSync("npm", ["run", "check:repository"], { stdio: "inherit" });
const temporary = mkdtempSync(join(tmpdir(), "orka-source-"));
try {
  const source = execFileSync("git", ["archive", "--format=tar", "HEAD"], {
    maxBuffer: 32_000_000,
  });
  execFileSync("tar", ["-xf", "-", "-C", temporary], { input: source });
  execFileSync("gitleaks", ["dir", temporary, "--redact", "--no-banner"], {
    stdio: "inherit",
  });
  const commit = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const directory = "artifacts/release";
  mkdirSync(directory, { recursive: true });
  const name = `orka-source-${commit}.tar.gz`;
  const archive = join(directory, name);
  execFileSync("git", [
    "archive",
    "--format=tar.gz",
    "--prefix=orka/",
    `--output=${archive}`,
    "HEAD",
  ]);
  const digest = createHash("sha256")
    .update(readFileSync(archive))
    .digest("hex");
  writeFileSync(`${archive}.sha256`, `${digest}  ${name}\n`);
  console.log(`Scanned source archive: ${archive}\nSHA-256: ${digest}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
