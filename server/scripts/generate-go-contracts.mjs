import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import * as protocol from "../packages/protocol/dist/index.js";

import { orkaTools } from "../packages/protocol/dist/mcp.js";

const schemas = {};
for (const [name, value] of Object.entries({
  ...protocol,
  ...Object.fromEntries(orkaTools.map((t) => ["mcp:" + t.name, t.schema])),
  "mcp:get_profile": z.object({}).strict(),
}))
  if (value instanceof z.ZodType)
    schemas[name] = z.toJSONSchema(value, {
      io: "input",
      unrepresentable: "any",
      override: ({ zodSchema, jsonSchema }) => {
        if (
          zodSchema._zod.def.checks?.some((check) =>
            check._zod.def.tx?.toString().includes(".trim()"),
          )
        )
          jsonSchema["x-orka-trim"] = true;
      },
    });
const output = "internal/server/contracts.json";
const bytes = JSON.stringify(schemas, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if (readFileSync(output, "utf8") !== bytes)
    throw new Error(
      "Run npm run contracts:go after changing the canonical protocol.",
    );
} else writeFileSync(output, bytes);

const toolsOutput = "internal/server/mcp-tools.json";
const toolBytes =
  JSON.stringify(
    orkaTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: z.toJSONSchema(t.schema),
    })),
    null,
    2,
  ) + "\n";
if (process.argv.includes("--check")) {
  if (readFileSync(toolsOutput, "utf8") !== toolBytes)
    throw new Error("MCP tool schema drift");
} else writeFileSync(toolsOutput, toolBytes);
