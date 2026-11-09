import { readFileSync, writeFileSync } from "node:fs";
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const rows = Object.entries(lock.packages)
  .filter(([path, pkg]) => path.includes("node_modules/") && !pkg.link)
  .map(([path, pkg]) => ({ name: path.split("node_modules/").at(-1), ...pkg }))
  .sort((a, b) => a.name.localeCompare(b.name));
const output =
  "# Dependency license inventory\n\nGenerated from the locked npm graph with `npm run licenses`. Includes development dependencies. Preserve actual upstream notices when distributing images.\n\n| Package | Version | License |\n| --- | --- | --- |\n" +
  rows
    .map(
      (p) =>
        `| [${p.name}](https://www.npmjs.com/package/${p.name}/v/${p.version}) | ${p.version} | ${(p.license ?? "UNDECLARED").replaceAll("|", "\\|")} |`,
    )
    .join("\n") +
  "\n";
if (process.argv.includes("--check")) {
  if (readFileSync("docs/dependency-licenses.md", "utf8") !== output)
    throw new Error("Run npm run licenses");
} else writeFileSync("docs/dependency-licenses.md", output);
