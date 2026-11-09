/** Disposable local preview. Uses synthetic projects and a synthetic sign-in service only. */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Pool } from "pg";
import { Store } from "../../packages/server-core/src/store.js";
import { Blobs } from "../../packages/server-core/src/blobs.js";
import { migrate } from "../../packages/server-core/src/migrations.js";
import { createApi } from "../../packages/server-core/src/main.js";
import { authSettings } from "../../packages/server-core/src/auth.js";
import { tokenHash } from "../../packages/server-core/src/mcp/oauth.js";
import { acceptingMemoryResolver } from "../../packages/server-core/src/testing/memory-fixtures.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const directory = await mkdtemp(join(tmpdir(), "orka-plugin-preview-"));
const evidence = resolve(
  process.env.ORKA_PLUGIN_EVIDENCE_DIR ?? "artifacts/plugin-review",
);
const bin = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@17/bin";
const init = spawnSync(
  join(bin, "initdb"),
  ["-D", join(directory, "pg"), "-A", "trust", "-U", "postgres", "--no-locale"],
  { encoding: "utf8" },
);
if (init.status !== 0)
  throw new Error(`Preview PostgreSQL init failed: ${init.stderr}`);
const pgPort = 55900 + Math.floor(Math.random() * 400);
const postgres = spawn(
  join(bin, "postgres"),
  ["-D", join(directory, "pg"), "-h", "127.0.0.1", "-p", String(pgPort)],
  { stdio: "ignore" },
);
const pool = new Pool({
  connectionString: `postgresql://postgres@127.0.0.1:${pgPort}/postgres`,
});
const deadline = Date.now() + 20_000;
for (;;) {
  try {
    await pool.query("select 1");
    break;
  } catch (error) {
    if (Date.now() > deadline || postgres.exitCode !== null) throw error;
    await new Promise((r) => setTimeout(r, 100));
  }
}
await migrate(pool);
const store = new Store(
  pool,
  new Blobs(join(directory, "blobs")),
  acceptingMemoryResolver(),
);
const owner = randomUUID(),
  teammate = randomUUID();
const project = await store.createProject(owner, "Acme onboarding", true);
await pool.query("insert into orka.members values($1,$2,'member')", [
  project,
  teammate,
]);
await pool.query(
  "insert into orka.env_profiles values($1,'Alex · Product'),($2,'Sam · Engineering')",
  [owner, teammate],
);
await store.device(owner, owner, "Preview Mac");
const publish = async (
  kind: "memory" | "session",
  title: string,
  content: string,
) => {
  const id = randomUUID(),
    bytes = Buffer.from(content),
    hash = await store.blobs.put(project, bytes);
  await pool.query("insert into orka.blobs values($1,$2,$3)", [
    project,
    hash,
    bytes.length,
  ]);
  await pool.query("insert into orka.blob_uploads values($1,$2,$3)", [
    project,
    hash,
    owner,
  ]);
  await store.mutate(owner, {
    version: 2,
    id: randomUUID(),
    projectId: project,
    deviceId: owner,
    baseRevision: 0,
    resource: {
      resourceId: id,
      kind,
      source: kind === "memory" ? "shared" : "claude",
      title,
      logicalPath:
        kind === "memory" ? `knowledge/${id}.md` : `claude/${id}.jsonl`,
      ...(kind === "memory"
        ? {
            memory: {
              topic: title,
              scope: "",
              provider: "manual",
              supersedes: [],
            },
          }
        : {}),
      deleted: false,
      files: [
        {
          path: kind === "memory" ? "content.md" : "session.jsonl",
          hash,
          size: bytes.length,
          executable: false,
        },
      ],
    },
  });
  return id;
};
const memory = await publish(
  "memory",
  "Email-first onboarding",
  "Ship email sign-in first. Keep the existing account and project permissions. Defer social login until the first flow is validated.",
);
const sessionId = randomUUID();
const session = await publish(
  "session",
  "Sam: onboarding implementation plan",
  [
    {
      type: "user",
      sessionId,
      message: { content: "How should we implement onboarding?" },
    },
    {
      type: "assistant",
      sessionId,
      message: {
        content: [
          {
            type: "text",
            text: "Reuse the existing form fields, implement email sign-in, and test returning-user behavior. The empty-project state is still an open design question.",
          },
        ],
      },
    },
  ]
    .map((r) => JSON.stringify(r))
    .join("\n") + "\n",
);
await pool.query(
  "update orka.resources set payload=jsonb_set(payload,'{owner}',$3::jsonb) where project_id=$1 and id=$2",
  [project, session, JSON.stringify(teammate)],
);
let origin = "";
let clientId = "";
const verifier = "p".repeat(43);
const fakeAuth = createServer((req, res) => {
  void (async () => {
    if (req.url?.startsWith("/callback?")) {
      const url = new URL(req.url, "http://localhost");
      const response = await fetch(origin + "/token", {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          code: url.searchParams.get("code") ?? "",
          code_verifier: verifier,
          redirect_uri: callback,
          resource: origin + "/mcp",
        }),
      });
      if (!response.ok) throw new Error("Preview connection failed");
      const token = (await response.json()) as { access_token: string };
      const client = new Client({ name: "Orka preview", version: "0.1.0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(origin + "/mcp"), {
          requestInit: {
            headers: { Authorization: `Bearer ${token.access_token}` },
          },
        }),
      );
      const tools = await client.listTools();
      const context = await client.callTool({
        name: "get_project_context",
        arguments: { projectId: project },
      });
      const sessions = await client.callTool({
        name: "list_sessions",
        arguments: { projectId: project, memberId: teammate },
      });
      const handoff = await client.callTool({
        name: "prepare_claude_handoff",
        arguments: {
          projectId: project,
          goal: "Implement email-first onboarding in Claude Code",
          sessionIds: [session],
          resourceIds: [memory],
          currentContext:
            "The current ChatGPT conversation selected email sign-in as the initial scope.",
          decisions: [
            "Use the existing form components",
            "Keep returning-user behavior",
          ],
          nextSteps: [
            "Verify repository state",
            "Implement the email sign-in flow",
            "Resolve the empty-project design question",
          ],
        },
      });
      await mkdir(evidence, { recursive: true });
      await writeFile(
        join(evidence, "tools.json"),
        JSON.stringify(tools, null, 2) + "\n",
      );
      await writeFile(
        join(evidence, "project-context.json"),
        JSON.stringify(context, null, 2) + "\n",
      );
      await writeFile(
        join(evidence, "team-sessions.json"),
        JSON.stringify(sessions, null, 2) + "\n",
      );
      await writeFile(
        join(evidence, "claude-handoff.md"),
        String((handoff.structuredContent as { markdown: string }).markdown),
      );
      await client.close();
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Orka connected</title><body style="background:#101010;color:#eee;font:16px/1.6 system-ui;padding:48px"><h1>Orka connected</h1><p>The synthetic browser sign-in and all three plugin workflows completed.</p><p>Seven tools discovered. Project context and Sam’s shared session were read. A Claude Code handoff was saved for review.</p><p>Only synthetic fixture data was used.</p></body></html>',
      );
    } else if (req.url?.startsWith("/token") || req.url === "/verify") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ access_token: "preview-native-token" }));
    } else {
      res.setHeader("Content-Type", "application/json");
      res.end("{}");
    }
  })().catch(() => {
    res.statusCode = 500;
    res.end("Preview failed");
  });
});
await new Promise<void>((r) => fakeAuth.listen(0, "127.0.0.1", r));
const authAddress = fakeAuth.address();
if (!authAddress || typeof authAddress === "string")
  throw new Error("Preview auth unavailable");
const callback = `http://127.0.0.1:${authAddress.port}/callback`;
const port = Number(process.env.ORKA_PLUGIN_PREVIEW_PORT ?? 8787);
origin = `http://127.0.0.1:${port}`;
const api = createApi(
  store,
  (token) =>
    token === "preview-native-token"
      ? Promise.resolve(owner)
      : Promise.reject(new Error("Fixture credentials required")),
  `http://127.0.0.1:${authAddress.port}`,
  authSettings({ PUBLIC_URL: origin, MAGIC_LINK_ENABLED: "true" }),
  undefined,
  true,
);
await new Promise<void>((r) => api.listen(port, "127.0.0.1", r));
const response = await fetch(origin + "/register", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    client_name: "Orka preview · synthetic data",
    redirect_uris: [callback],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  }),
});
clientId = ((await response.json()) as { client_id: string }).client_id;
const authorize = new URL(origin + "/authorize");
authorize.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: callback,
  response_type: "code",
  scope: "orka.read",
  resource: origin + "/mcp",
  code_challenge: Buffer.from(tokenHash(verifier), "hex").toString("base64url"),
  code_challenge_method: "S256",
  state: "synthetic-preview",
}).toString();
console.log(
  JSON.stringify(
    {
      origin,
      authorize: authorize.href,
      fixtureEmail: "preview@example.test",
      fixturePassword: "preview-only",
      evidence,
    },
    null,
    2,
  ),
);
let closing = false;
const cleanup = async () => {
  if (closing) return;
  closing = true;
  api.closeAllConnections();
  fakeAuth.closeAllConnections();
  await Promise.all([
    new Promise<void>((r) => api.close(() => r())),
    new Promise<void>((r) => fakeAuth.close(() => r())),
  ]);
  await pool.end();
  postgres.kill("SIGTERM");
  if (postgres.exitCode === null)
    await new Promise<void>((r) => postgres.once("exit", () => r()));
  await rm(directory, { recursive: true, force: true });
};
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void cleanup();
  });
