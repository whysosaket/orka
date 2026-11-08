import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

await test("portable and desktop plugin ZIPs preserve host metadata and the verified endpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orka-plugin-test-"));
  const tools = [
    "get_profile",
    "list_projects",
    "get_project_context",
    "list_team_members",
    "list_sessions",
    "fetch_resource",
    "prepare_claude_handoff",
  ];
  let origin = "";
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/.well-known/oauth-protected-resource/mcp") {
      response.end(
        JSON.stringify({
          resource: origin + "/mcp",
          authorization_servers: [origin + "/"],
        }),
      );
    } else if (request.url === "/.well-known/oauth-authorization-server") {
      response.end(
        JSON.stringify({
          code_challenge_methods_supported: ["S256"],
          registration_endpoint: origin + "/register",
        }),
      );
    } else if (request.url === "/mcp") {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString()));
      request.on("end", () => {
        const rpc = JSON.parse(body) as { id: number; method: string };
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: rpc.id,
            result:
              rpc.method === "initialize"
                ? {
                    protocolVersion: "2025-03-26",
                    serverInfo: { name: "orka" },
                  }
                : {
                    tools: tools.map((name) => ({
                      name,
                      annotations: { readOnlyHint: true },
                      securitySchemes: [
                        { type: "oauth2", scopes: ["orka.read"] },
                      ],
                    })),
                  },
          }),
        );
      });
    } else {
      response.writeHead(404).end();
    }
  });
  try {
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    origin = `http://127.0.0.1:${address.port}`;
    const output = join(directory, "orka.zip");
    await run(process.execPath, [
      resolve("plugins/orka/scripts/package.mjs"),
      origin + "/mcp",
      output,
    ]);
    const entry = async (path: string) =>
      JSON.parse((await run("unzip", ["-p", output, `orka/${path}`])).stdout);
    const manifest = JSON.parse(
      await readFile("plugins/orka/plugin.json", "utf8"),
    );
    assert.deepEqual(await entry("plugin.json"), manifest);
    const readme = await readFile("plugins/orka/README.md", "utf8");
    assert.equal(
      (await run("unzip", ["-p", output, "orka/README.md"])).stdout,
      readme,
    );
    const portable = await entry("mcp.json");
    assert.equal(portable.mcpServers.orka.type, "streamable-http");
    assert.equal(portable.mcpServers.orka.url, origin + "/mcp");
    assert.equal(
      portable.mcpServers.orka.extensions["com.openai"].auth.type,
      "oauth",
    );
    const claude = await entry(".claude-plugin/plugin.json");
    assert.equal(claude.name, manifest.name);
    assert.equal(claude.version, manifest.version);
    assert.equal(claude.description, manifest.description);
    assert.deepEqual(await entry(".mcp.json"), {
      mcpServers: { orka: { type: "http", url: origin + "/mcp" } },
    });
    const verification = JSON.parse(
      await readFile(output + ".verification.json", "utf8"),
    );
    assert.equal(verification.developmentOnly, true);
    assert.equal(verification.authenticatedWorkflowVerified, false);
    const inventory = (await run("unzip", ["-Z1", output])).stdout;
    assert.equal(inventory.match(/\/SKILL\.md$/gm)?.length, 4);
    const desktop = join(directory, "orka-desktop.zip");
    assert.equal(
      (await run("unzip", ["-p", desktop, "orka/README.md"])).stdout,
      readme,
    );
    const desktopInventory = (await run("unzip", ["-Z1", desktop])).stdout
      .trim()
      .split("\n");
    assert.ok(!desktopInventory.includes("orka/plugin.json"));
    assert.ok(!desktopInventory.includes("orka/mcp.json"));
    assert.ok(desktopInventory.includes("orka/.claude-plugin/plugin.json"));
    const codex = JSON.parse(
      (await run("unzip", ["-p", desktop, "orka/.codex-plugin/plugin.json"]))
        .stdout,
    );
    assert.equal(codex.name, manifest.name);
    assert.equal(codex.version, manifest.version);
    assert.equal(codex.skills, "./skills/");
    assert.equal(codex.mcpServers, "./.mcp.json");
    assert.deepEqual(
      codex.interface,
      manifest.extensions["com.openai"].interface,
    );
    const desktopConnection = JSON.parse(
      (await run("unzip", ["-p", desktop, "orka/.mcp.json"])).stdout,
    );
    assert.deepEqual(
      desktopConnection.mcpServers.orka,
      (await entry(".mcp.json")).mcpServers.orka,
    );
    assert.equal(
      desktopConnection.mcpServers.orka_local.command,
      "/Applications/Orka.app/Contents/MacOS/portable-workspace-mac",
    );
    assert.deepEqual(desktopConnection.mcpServers.orka_local.args, [
      "--orka-plugin",
    ]);
  } finally {
    await new Promise<void>((done, fail) =>
      server.close((error) => (error ? fail(error) : done())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});
