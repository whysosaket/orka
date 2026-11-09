import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  diffText,
  mergeText,
  envCanonical,
  resourceInput,
  relativePath,
  memoryMetadata,
} from "../packages/protocol/dist/index.js";

let seed = 311;
const random = (n) => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed % n;
};
const sample = () =>
  Array.from(
    { length: random(10) },
    () => ["a\n", "b\n", "c\n", "\n", "last"][random(5)],
  ).join("");
const merges = Array.from({ length: 600 }, () => {
  const base = sample(),
    current = sample(),
    incoming = sample();
  return {
    base,
    current,
    incoming,
    edits: diffText(base, incoming),
    merged: mergeText(base, current, incoming),
  };
});
const values = [
  null,
  false,
  0,
  -0,
  1e-7,
  1e20,
  1e21,
  "<script>\u2028&\u2029",
  { z: [1, "a", { b: false, a: null }], a: 'quoted"\n\\' },
];
const canonicals = values.map((value) => ({
  value,
  canonical: envCanonical(value),
  hash: createHash("sha256").update(envCanonical(value)).digest("hex"),
}));
const cases = [];
const check = (name, schema, value) =>
  cases.push({ name, value, valid: schema.safeParse(value).success });
for (const path of [
  "instructions/AGENTS.md",
  "foo/../bar",
  "/absolute",
  "a\\b",
  "a//b",
  "a\u0000b",
  "a\u0080b",
  "é",
  "a/.",
  ".env",
])
  check("relativePath", relativePath, path);
for (const scope of ["", "src", "a/../b", "a\u0080b", "a//b", "a/", " a"])
  check("memoryMetadata", memoryMetadata, {
    topic: " topic ",
    scope,
    provider: "manual",
  });
const file = {
  path: "content.md",
  hash: "a".repeat(64),
  size: 12,
  executable: false,
};
const resource = {
  resourceId: "12345678-1234-4123-8123-123456789012",
  kind: "memory",
  source: "shared",
  logicalPath: "instructions/AGENTS.md",
  title: "Instructions",
  files: [file],
  deleted: false,
};
for (const change of [
  {},
  { extra: true },
  { logicalPath: "instructions/.git/AGENTS.md" },
  { files: [] },
  { deleted: true },
  { deleted: true, files: [] },
  { source: "claude" },
  { files: [file, file] },
  { kind: "plan" },
  {
    kind: "skill",
    logicalPath: "tool",
    files: [{ ...file, path: "SKILL.md" }],
  },
  {
    kind: "skill",
    logicalPath: "tool",
    files: [
      { ...file, path: "SKILL.md" },
      { ...file, path: ".env" },
    ],
  },
])
  check("resourceInput", resourceInput, { ...resource, ...change });
const output = "internal/server/testdata/protocol.json";
const bytes = JSON.stringify({ merges, canonicals, cases }, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if (readFileSync(output, "utf8") !== bytes)
    throw new Error("Regenerate the Go protocol fixtures.");
} else writeFileSync(output, bytes);
