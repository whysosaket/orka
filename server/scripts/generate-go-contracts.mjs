import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import * as protocol from "../packages/protocol/dist/index.js";

import { orkaTools } from "../packages/protocol/dist/mcp.js";
import {
  JSONRPCMessageSchema,
  InitializeRequestSchema,
  CallToolRequestSchema,
  ListToolsRequestSchema,
  PingRequestSchema,
  SUPPORTED_PROTOCOL_VERSIONS,
  LATEST_PROTOCOL_VERSION,
} from "@modelcontextprotocol/sdk/types.js";
import { MAX_BATCH_SIZE } from "@modelcontextprotocol/sdk/server/requestBody.js";

const refinements = new Map([
  ...[
    "relativePath",
    "resourceInput",
    "memoryMetadata",
    "envManifest",
    "addProjectSources",
  ].map((name) => [protocol[name], name]),
  [protocol.githubRepository.shape.cloneUrl, "repositoryCloneURL"],
  [
    orkaTools
      .find((tool) => tool.name === "get_project_context")
      .schema.shape.scope.unwrap(),
    "mcpScope",
  ],
]);
const assertedObject =
  InitializeRequestSchema.shape.params.shape.capabilities.shape.sampling
    .unwrap()
    .shape.context.unwrap();
const emptyForm =
  InitializeRequestSchema.shape.params.shape.capabilities.shape.elicitation.unwrap();
const schemas = {};
for (const [name, value] of Object.entries({
  ...protocol,
  ...Object.fromEntries(orkaTools.map((t) => ["mcp:" + t.name, t.schema])),
  "mcp:get_profile": z.object({}).strict(),
  "rpc:message": JSONRPCMessageSchema,
  "rpc:initialize": InitializeRequestSchema,
  "rpc:tools/call": CallToolRequestSchema,
  "rpc:tools/list": ListToolsRequestSchema,
  "rpc:ping": PingRequestSchema,
}))
  if (value instanceof z.ZodType)
    schemas[name] = z.toJSONSchema(value, {
      io: "input",
      unrepresentable: "any",
      override: ({ zodSchema, jsonSchema }) => {
        let inner = zodSchema;
        while (inner._zod.def.innerType) inner = inner._zod.def.innerType;
        const refinement = refinements.get(inner);
        if (refinement) jsonSchema["x-orka-refinement"] = refinement;
        if (inner === assertedObject)
          jsonSchema.anyOf = [
            { type: "object", additionalProperties: true },
            { type: "array" },
          ];
        if (inner === emptyForm) jsonSchema["x-orka-empty-form"] = true;
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
      scope: t.scope,
      inputSchema: z.toJSONSchema(t.schema),
    })),
    null,
    2,
  ) + "\n";
if (process.argv.includes("--check")) {
  if (readFileSync(toolsOutput, "utf8") !== toolBytes)
    throw new Error("MCP tool schema drift");
} else writeFileSync(toolsOutput, toolBytes);

const transportOutput = "internal/server/mcp-transport.json";
const transportBytes =
  JSON.stringify(
    {
      versions: SUPPORTED_PROTOCOL_VERSIONS,
      latest: LATEST_PROTOCOL_VERSION,
      maxBatch: MAX_BATCH_SIZE,
    },
    null,
    2,
  ) + "\n";
if (process.argv.includes("--check")) {
  if (readFileSync(transportOutput, "utf8") !== transportBytes)
    throw new Error("MCP transport contract drift");
} else writeFileSync(transportOutput, transportBytes);
