import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const endpoint = process.argv[2];
const output = resolve(process.argv[3] ?? "artifacts/orka-plugin-0.1.0.zip");
if (!endpoint)
  throw new Error(
    "Usage: node plugins/orka/scripts/package.mjs <verified-mcp-url> [output.zip]",
  );
const url = new URL(endpoint);
if (
  url.username ||
  url.password ||
  url.hash ||
  url.search ||
  url.pathname !== "/mcp" ||
  (url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(url.hostname)
    ))
)
  throw new Error("Use an HTTPS /mcp endpoint or local development server");
const rpc = async (id, method, params = {}) => {
  const response = await fetch(url, {
    method: "POST",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error(`MCP verification failed: ${response.status}`);
  const result = await response.json();
  if (result.error) throw new Error(`MCP ${method} failed`);
  return result.result;
};
const initialized = await rpc(1, "initialize", {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "orka-package-verifier", version: "0.1.0" },
});
if (initialized.serverInfo?.name !== "orka")
  throw new Error("Endpoint is not the implemented Orka MCP server");
const listed = await rpc(2, "tools/list");
const required = [
  "get_profile",
  "list_projects",
  "get_project_context",
  "list_team_members",
  "list_sessions",
  "fetch_resource",
  "prepare_claude_handoff",
];
if (
  listed.tools?.length !== required.length ||
  !required.every((name) =>
    listed.tools.some(
      (t) =>
        t.name === name &&
        t.annotations?.readOnlyHint === true &&
        t.securitySchemes?.some(
          (s) => s.type === "oauth2" && s.scopes?.includes("orka.read"),
        ),
    ),
  )
)
  throw new Error(
    "The server tool contract is incomplete or differs from this plugin version",
  );
const metadataResponse = await fetch(
  new URL("/.well-known/oauth-protected-resource/mcp", url),
  { redirect: "error", signal: AbortSignal.timeout(10_000) },
);
if (!metadataResponse.ok) throw new Error("OAuth discovery is unavailable");
const metadata = await metadataResponse.json();
if (
  metadata.resource !== url.href ||
  !metadata.authorization_servers?.includes(url.origin + "/")
)
  throw new Error("OAuth resource or issuer does not match the MCP endpoint");
const authorization = await (
  await fetch(new URL("/.well-known/oauth-authorization-server", url), {
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  })
).json();
if (
  !authorization.code_challenge_methods_supported?.includes("S256") ||
  !authorization.registration_endpoint
)
  throw new Error("PKCE and dynamic client registration are required");
const manifest = JSON.parse(await readFile(join(root, "plugin.json"), "utf8"));
if (manifest.extensions["com.openai"].interface.shortDescription.length > 30)
  throw new Error("Plugin subtitle exceeds 30 characters");
const directory = await mkdtemp(join(tmpdir(), "orka-plugin-package-"));
try {
  const staged = join(directory, "orka");
  await mkdir(staged);
  for (const name of ["plugin.json", "skills", "assets"])
    await cp(join(root, name), join(staged, name), {
      recursive: true,
      dereference: false,
    });
  const connection = {
    $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    mcpServers: {
      orka: {
        type: "streamable-http",
        url: url.href,
        extensions: {
          "com.openai": {
            auth: {
              type: "oauth",
              client: { mode: "dcr" },
              baseScopes: ["orka.read"],
              defaultScopes: ["orka.read"],
            },
          },
        },
      },
    },
  };
  await writeFile(
    join(staged, "mcp.json"),
    JSON.stringify(connection, null, 2) + "\n",
  );
  for (const skill of await readdir(join(staged, "skills"))) {
    const text = await readFile(
      join(staged, "skills", skill, "SKILL.md"),
      "utf8",
    );
    if (
      !text.startsWith(`---\nname: ${skill}\n`) ||
      !text.includes("\ndescription: ")
    )
      throw new Error(`Invalid skill: ${skill}`);
  }
  await mkdir(dirname(output), { recursive: true });
  const archive = join(directory, "orka.zip");
  const packed = spawnSync("zip", ["-q", "-r", archive, "orka"], {
    cwd: directory,
    encoding: "utf8",
  });
  if (packed.status !== 0)
    throw new Error(packed.stderr || "ZIP creation failed");
  const inventory = spawnSync("unzip", ["-Z1", archive], { encoding: "utf8" });
  if (
    inventory.status !== 0 ||
    inventory.stdout
      .split("\n")
      .some(
        (p) =>
          p.includes("..") ||
          p.includes("node_modules") ||
          p.includes(".app.json") ||
          p.includes(".env") ||
          p.includes(".DS_Store"),
      )
  )
    throw new Error("Archive inventory validation failed");
  await cp(archive, output);
  await writeFile(
    output + ".verification.json",
    JSON.stringify(
      {
        endpoint: url.href,
        verifiedAt: new Date().toISOString(),
        protocolVersion: initialized.protocolVersion,
        tools: required,
        authenticatedWorkflowVerified: false,
        developmentOnly: url.protocol === "http:",
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `Created ${output}. Endpoint discovery verified; authenticated host acceptance is a separate check.`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
