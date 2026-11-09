import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import * as protocol from "../packages/protocol/dist/index.js";
import { orkaTools } from "../packages/protocol/dist/mcp.js";
import {
  JSONRPCMessageSchema,
  InitializeRequestSchema,
  CallToolRequestSchema,
  ListToolsRequestSchema,
  PingRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const schemas = Object.fromEntries(
  Object.entries({
    ...protocol,
    ...Object.fromEntries(
      orkaTools.map((tool) => ["mcp:" + tool.name, tool.schema]),
    ),
    "mcp:get_profile": z.object({}).strict(),
    "rpc:message": JSONRPCMessageSchema,
    "rpc:initialize": InitializeRequestSchema,
    "rpc:tools/call": CallToolRequestSchema,
    "rpc:tools/list": ListToolsRequestSchema,
    "rpc:ping": PingRequestSchema,
  }).filter(([, value]) => value instanceof z.ZodType),
);
const docs = JSON.parse(readFileSync("internal/server/contracts.json", "utf8"));
const uuid = "12345678-1234-4123-8123-123456789012";
const strings = [
  "value",
  "content.md",
  uuid,
  "a".repeat(64),
  "a".repeat(128),
  "age1" + "q".repeat(58),
  "4242",
  "owner/repo",
  "deadbee",
];
function example(doc) {
  if ("const" in doc) return doc.const;
  if ("default" in doc) return structuredClone(doc.default);
  if (doc.enum) return doc.enum[0];
  if (doc.anyOf) return example(doc.anyOf[0]);
  if (doc.type === "object")
    return Object.fromEntries(
      (doc.required ?? []).map((key) => [key, example(doc.properties[key])]),
    );
  if (doc.type === "array")
    return Array.from({ length: doc.minItems ?? 0 }, () => example(doc.items));
  if (doc.type === "boolean") return false;
  if (doc.type === "null") return null;
  if (doc.type === "integer" || doc.type === "number")
    return Math.max(1, doc.minimum ?? 1, (doc.exclusiveMinimum ?? 0) + 1);
  if (doc.type === "string") {
    if (doc.format === "uuid") return uuid;
    if (doc.format === "uri") return "https://github.com/owner/repo.git";
    if (doc.format === "date-time") return "2026-01-01T00:00:00.000Z";
    if (doc.pattern) {
      const found = strings.find((value) =>
        new RegExp(doc.pattern).test(value),
      );
      assert.notEqual(
        found,
        undefined,
        `Add a valid example for ${doc.pattern}`,
      );
      return found;
    }
    return "value";
  }
  return {};
}
const resource = {
  resourceId: uuid,
  kind: "memory",
  source: "shared",
  logicalPath: "instructions/AGENTS.md",
  title: "Instructions",
  files: [
    { path: "content.md", hash: "a".repeat(64), size: 12, executable: false },
  ],
  deleted: false,
};
const cases = [];
const mutations = [
  null,
  false,
  0,
  0.5,
  [],
  {},
  "",
  "value",
  " value ",
  "\u0085",
  "\u0085value\u0085",
  "😀",
  "../unsafe",
  "/absolute",
  "a\\b",
  "a\u0000b",
  "DEADBEEF",
  "00000000-0000-0000-0000-000000000000",
  "ffffffff-ffff-ffff-ffff-ffffffffffff",
  "https://evil.example/repo.git",
  "https://github.com:443/owner/repo.git",
  "https://user:pass@github.com/repo.git",
  "https://GITHUB.COM/repo.git",
  "https://github.com/repo.git?query=1",
  "https://github.com/repo.git#fragment",
];
function at(root, path, value, remove = false) {
  if (!path.length) return value;
  const copy = structuredClone(root);
  let parent = copy;
  for (const part of path.slice(0, -1)) parent = parent[part];
  if (remove) delete parent[path.at(-1)];
  else parent[path.at(-1)] = value;
  return copy;
}
function record(name, value, scenario) {
  let parsed;
  try {
    parsed = schemas[name].safeParse(value);
  } catch {
    parsed = { success: false };
  }
  cases.push({
    name,
    value,
    scenario,
    valid: parsed.success,
    ...(parsed.success ? { parsed: parsed.data } : {}),
  });
}
function visit(name, root, doc, path = []) {
  for (const value of mutations)
    record(
      name,
      at(root, path, value),
      `${path.join(".") || "root"}: ${JSON.stringify(value)}`,
    );
  if (doc.anyOf) {
    visit(name, root, doc.anyOf[0], path);
    return;
  }
  if (doc.type === "string" && doc.maxLength && doc.maxLength <= 4096) {
    for (const length of [doc.maxLength, doc.maxLength + 1]) {
      record(
        name,
        at(
          root,
          path,
          "😀".repeat(Math.floor(length / 2)) + "x".repeat(length % 2),
        ),
        `${path.join(".")}: UTF-16 length ${length}`,
      );
      record(
        name,
        at(root, path, "😀".repeat(length)),
        `${path.join(".")}: code-point length ${length}`,
      );
    }
  }
  if (doc.type === "integer" || doc.type === "number") {
    for (const value of [-1, 1, 2, 9007199254740991, 9007199254740992])
      record(
        name,
        at(root, path, value),
        `${path.join(".")}: numeric ${value}`,
      );
  }
  if (doc.type === "object") {
    const value = path.reduce((v, key) => v[key], root);
    record(
      name,
      at(root, path, { ...value, unexpectedContractField: true }),
      `${path.join(".")}: unknown field`,
    );
    for (const [key, schema] of Object.entries(doc.properties ?? {})) {
      record(
        name,
        at(root, [...path, key], undefined, true),
        `${[...path, key].join(".")}: missing`,
      );
      const seeded = at(root, [...path, key], value[key] ?? example(schema));
      visit(name, seeded, schema, [...path, key]);
    }
  }
  if (doc.type === "array" && doc.items) {
    const value = path.reduce((v, key) => v[key], root);
    const item = value[0] ?? example(doc.items);
    record(
      name,
      at(root, path, [item, item]),
      `${path.join(".")}: duplicate items`,
    );
    visit(name, at(root, path, [item]), doc.items, [...path, 0]);
  }
}
for (const [name, schema] of Object.entries(schemas)) {
  const seed =
    name === "resourceInput" ? structuredClone(resource) : example(docs[name]);
  if (name === "change") seed.resource = structuredClone(resource);
  assert.ok(schema.safeParse(seed).success, `Add a valid seed for ${name}`);
  record(name, seed, "valid seed");
  visit(name, seed, docs[name]);
}
const directory = mkdtempSync(join(tmpdir(), "orka-contract-parity-"));
try {
  const file = join(directory, "cases.json");
  writeFileSync(file, JSON.stringify({ cases }));
  const result = spawnSync(
    process.env.GO_BINARY ?? "go",
    [
      "test",
      "./internal/server",
      "-run",
      "^TestContractParityReplay$",
      "-count=1",
    ],
    { stdio: "inherit", env: { ...process.env, ORKA_CONTRACT_FIXTURES: file } },
  );
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    "Go validators differ from the canonical TypeScript contracts",
  );
  console.log(
    `Validated ${cases.length} cases across ${Object.keys(schemas).length} protocol and MCP contracts.`,
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
