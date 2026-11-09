import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const go = process.env.GO_BINARY ?? "go";
const run = (...args) => execFileSync(go, args, { encoding: "utf8" }).trim();
const modules = run(
  "list",
  "-deps",
  "-f",
  "{{if .Module}}{{if not .Module.Main}}{{.Module.Path}} {{.Module.Version}} {{.Module.Dir}}{{end}}{{end}}",
  "./cmd/orka-server",
)
  .split("\n")
  .filter(Boolean);
let output =
  "# Go runtime dependency notices\n\nGenerated from the locked dependencies of cmd/orka-server. The production image contains the Go executable and these notices; Node dependencies are development and test tools.\n\n";
const section = (name, text) => {
  output += `## ${name}\n\n\`\`\`text\n${text.trim()}\n\`\`\`\n\n`;
};
section(
  "Go standard library and runtime",
  readFileSync(join(run("env", "GOROOT"), "LICENSE"), "utf8"),
);
for (const row of [...new Set(modules)].sort()) {
  const [name, version, ...parts] = row.split(" ");
  const directory = parts.join(" ");
  const notices = readdirSync(directory).filter((file) =>
    /^(licen[sc]e|copying|notice)(\.|$)/i.test(file),
  );
  if (!notices.length) throw new Error(`Review the license for ${name}`);
  for (const notice of notices)
    section(
      `${name} ${version} — ${notice}`,
      readFileSync(join(directory, notice), "utf8"),
    );
}
section(
  "jsdiff algorithm attribution",
  readFileSync("licenses/jsdiff-BSD-3-Clause.txt", "utf8"),
);
output = output.trimEnd() + "\n";
const target = "GO_THIRD_PARTY_NOTICES.md";
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== output)
    throw new Error("Run npm run licenses:go after changing Go dependencies.");
} else writeFileSync(target, output);
