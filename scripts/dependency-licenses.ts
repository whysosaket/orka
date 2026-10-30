import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

type NpmPackage = { version?: string; license?: string; link?: boolean };
type CargoPackage = {
  name: string;
  version: string;
  license: string | null;
  source: string | null;
};
const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as {
  packages: Record<string, NpmPackage>;
};
const javascript = Object.entries(lock.packages)
  .filter(([path, pkg]) => path.includes("node_modules/") && !pkg.link)
  .map(([path, pkg]) => ({
    name: path.split("node_modules/").at(-1)!,
    version: pkg.version!,
    license: pkg.license ?? "UNDECLARED",
  }))
  .sort(
    (a, b) =>
      a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
const metadata = JSON.parse(
  execFileSync(
    "cargo",
    [
      "metadata",
      "--locked",
      "--format-version",
      "1",
      "--manifest-path",
      "apps/mac/src-tauri/Cargo.toml",
    ],
    { encoding: "utf8", maxBuffer: 32_000_000 },
  ),
) as { packages: CargoPackage[] };
const rust = metadata.packages
  .filter((pkg) => pkg.source !== null)
  .sort(
    (a, b) =>
      a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
const row = (
  name: string,
  version: string,
  license: string | null,
  url: string,
) =>
  `| [${name}](${url}) | ${version} | ${(license ?? "UNDECLARED").replaceAll("|", "\\|")} |`;
const output = [
  "# Dependency license inventory",
  "",
  "Generated from the locked npm and Cargo graphs with `npm run licenses`. Includes development, optional, and platform-specific dependencies; it is not a list of everything shipped in a particular binary.",
  "",
  "Declared licenses are upstream metadata. Preserve the actual license notices and any applicable source obligations when distributing dependencies. See [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).",
  "",
  "## JavaScript",
  "",
  "| Package | Version | Declared license |",
  "| --- | --- | --- |",
  ...javascript.map((pkg) =>
    row(
      pkg.name,
      pkg.version,
      pkg.license,
      `https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}`,
    ),
  ),
  "",
  "## Rust",
  "",
  "| Crate | Version | Declared license |",
  "| --- | --- | --- |",
  ...rust.map((pkg) =>
    row(
      pkg.name,
      pkg.version,
      pkg.license,
      `https://crates.io/crates/${pkg.name}/${pkg.version}`,
    ),
  ),
  "",
].join("\n");
const path = "docs/dependency-licenses.md";
if (process.argv.includes("--check")) {
  if (readFileSync(path, "utf8") !== output)
    throw new Error("Dependency inventory is stale; run npm run licenses.");
} else writeFileSync(path, output);
console.log(
  `License inventory: ${javascript.length} npm packages and ${rust.length} crates.`,
);
