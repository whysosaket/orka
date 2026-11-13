import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const home = await mkdtemp(join(tmpdir(), "orka-repository-access-"));
const binary =
  process.env.ORKA_TEST_NATIVE_BINARY ??
  resolve("apps/mac/src-tauri/target/debug/portable-workspace-mac");
let state = "ready",
  checks = 0,
  credentials = 0;
let removalCatalog:
  | {
      id: string;
      name: string;
      role: string;
      governed?: boolean;
      archivedAt?: string;
      sources: { id: string; name: string; removedAt?: string }[];
    }[]
  | null = null;
const catalogRequests: string[] = [];
const server = createServer((req, res) => {
  void (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString() || "{}") as {
      action: string;
    };
    res.setHeader("Content-Type", "application/json");
    if (removalCatalog && req.url === "/v2/projects/capabilities") {
      res.end(JSON.stringify({ sourcesRemoval: 1 }));
      return;
    }
    if (removalCatalog && req.url === "/v2/projects/sources/remove") {
      const source = removalCatalog[0].sources[0];
      source.removedAt = "2026-11-13T00:00:00Z";
      res.end(
        JSON.stringify({ sourceId: source.id, removedAt: source.removedAt }),
      );
      return;
    }
    if (removalCatalog && req.url?.startsWith("/v2/projects")) {
      catalogRequests.push(req.url);
      res.end(
        JSON.stringify(
          req.url.includes("includeArchived=true")
            ? removalCatalog
            : removalCatalog.filter((project) => !project.archivedAt),
        ),
      );
      return;
    }
    if (input.action === "access") {
      checks++;
      if (state === "offline") {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: "Service unavailable" }));
        return;
      }
      res.end(JSON.stringify({ state }));
    } else if (input.action === "clone-credentials") {
      credentials++;
      res.statusCode = 403;
      res.end(JSON.stringify({ error: "GitHub access revoked" }));
    } else res.end(JSON.stringify({ ok: true }));
  })().catch(() => {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: "Invalid fixture request" }));
  });
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
assert.ok(address && typeof address !== "string");
const service = `http://127.0.0.1:${address.port}`;
const user = randomUUID(),
  projectId = randomUUID(),
  sourceId = randomUUID();
let revision = 1;
function native() {
  const child = spawn(binary, ["--orka-env-test"], {
    env: {
      ...process.env,
      ORKA_TEST_HOME: home,
      CODEX_HOME: join(home, ".codex"),
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending: {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }[] = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    const next = pending.shift();
    if (!next) return;
    const value = JSON.parse(line) as { value: unknown; error?: string };
    if (value.error) next.reject(new Error(value.error));
    else next.resolve(value.value);
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const exited = new Promise<void>((done) => {
    child.once("exit", () => {
      for (const item of pending.splice(0))
        item.reject(new Error(stderr || "Native process exited"));
      done();
    });
    child.once("error", (error) => {
      for (const item of pending.splice(0)) item.reject(error);
      done();
    });
  });
  return {
    request: <T>(input: unknown) =>
      new Promise<T>((resolve, reject) => {
        pending.push({ resolve: (value) => resolve(value as T), reject });
        child.stdin.write(JSON.stringify(input) + "\n");
      }),
    close: async () => {
      child.stdin.end();
      await exited;
    },
  };
}
let mac = native();
async function setup(account = user, origin = service) {
  await mac.request({
    action: "setup",
    user: account,
    url: origin,
    projectId,
    path: home,
    sources: [
      {
        id: sourceId,
        name: "private-repo",
        path: null,
        repository: {
          id: "4242",
          fullName: "fixtures/private-repo",
          cloneUrl: "https://github.com/fixtures/private-repo.git",
          defaultBranch: "main",
          private: true,
          revision,
        },
      },
    ],
  });
}
const command = <T>(
  operation: string,
  input: unknown = {},
  account = user,
  origin = service,
) =>
  mac.request<T>({
    action: "repository",
    operation,
    input,
    context: { user: account, service: origin },
  });
const input = { projectId, sourceId };
const check = (force = false, account = user, origin = service) =>
  command<{ state: string }>(
    "access-status",
    { ...input, force },
    account,
    origin,
  );
const database = () =>
  new DatabaseSync(
    join(
      home,
      "orka",
      "services",
      createHash("sha256").update(service).digest("hex"),
      user,
      "sync.sqlite",
    ),
  );
try {
  await setup();
  assert.equal((await check()).state, "ready");
  assert.equal((await check()).state, "ready");
  assert.equal(
    checks,
    1,
    "Opening the same repo again must reuse today's check",
  );
  await assert.rejects(
    command("access-status", { ...input, repositoryId: "stale-repository" }),
    /Repository link changed/,
  );
  state = "access_unavailable";
  await mkdir(join(home, "checkouts"));
  await command("clone", {
    ...input,
    directory: join(home, "checkouts"),
    folderName: "private-repo",
  });
  for (let i = 0; i < 50; i++) {
    const jobs = await command<{ state: string }[]>("jobs");
    if (jobs[0]?.state === "failed") break;
    await new Promise((done) => setTimeout(done, 50));
  }
  assert.equal(
    credentials,
    1,
    "A cached green tick must never bypass the live clone authorization",
  );
  assert.equal((await command<{ state: string }[]>("jobs"))[0].state, "failed");
  assert.equal((await check(true)).state, "access_unavailable");
  assert.equal(checks, 2);
  state = "ready";
  const db = database();
  const key = `repository-access:${projectId}:${sourceId}`;
  const saved = JSON.parse(
    (
      db.prepare("select value from meta where key=?").get(key) as {
        value: string;
      }
    ).value,
  ) as { checkedAt: string };
  saved.checkedAt = new Date(Date.now() - 2 * 86400000).toISOString();
  db.prepare("update meta set value=? where key=?").run(
    JSON.stringify(saved),
    key,
  );
  db.close();
  assert.equal((await check()).state, "ready");
  assert.equal(checks, 3, "A previous day's status must be refreshed");
  await command("disconnect");
  assert.equal((await check()).state, "ready");
  assert.equal(
    checks,
    4,
    "Changing GitHub authorization must invalidate the saved status",
  );
  revision = 2;
  await setup();
  await check();
  assert.equal(
    checks,
    5,
    "Changing the repository binding must invalidate its status",
  );
  await mac.close();
  mac = native();
  await setup();
  await check();
  assert.equal(
    checks,
    6,
    "A new app launch must verify even a status saved today",
  );
  const other = randomUUID();
  await setup(other);
  state = "access_unavailable";
  assert.equal((await check(false, other)).state, "access_unavailable");
  assert.equal(
    checks,
    7,
    "Another account cannot inherit the first account's green tick",
  );
  await assert.rejects(check(false, user), /Account or service changed/);
  const otherOrigin = service.replace("127.0.0.1", "localhost");
  await setup(other, otherOrigin);
  state = "ready";
  assert.equal((await check(false, other, otherOrigin)).state, "ready");
  assert.equal(checks, 8, "Another service cannot inherit a cached status");
  await assert.rejects(
    check(false, other, service),
    /Account or service changed/,
  );
  state = "offline";
  await assert.rejects(check(true, other, otherOrigin), /503/);
  await assert.rejects(check(false, other, otherOrigin), /503/);
  state = "ready";
  assert.equal(
    (await check(false, other, otherOrigin)).state,
    "ready",
    "A failed refresh must never revive an older green status",
  );
  await setup();
  const archivedId = randomUUID(),
    archivedSourceId = randomUUID(),
    archivedResourceId = randomUUID();
  const archivedRoot = join(home, "archived-project");
  const archivedFile = join(archivedRoot, "AGENTS.md");
  await mkdir(archivedRoot);
  await writeFile(archivedFile, "Preserve archived project instructions\n");
  const connection = database();
  const local = JSON.parse(
    String(
      connection.prepare("SELECT value FROM projects WHERE id=?").get(projectId)
        ?.value,
    ),
  ) as { role: string };
  local.role = "owner";
  connection
    .prepare("UPDATE projects SET value=? WHERE id=?")
    .run(JSON.stringify(local), projectId);
  const archived = {
    id: archivedId,
    name: "Archived project",
    role: "owner",
    governed: true,
    archivedAt: "2026-11-01T00:00:00Z",
    sources: [{ id: archivedSourceId, name: "archive", path: archivedRoot }],
  };
  const resource = {
    resourceId: archivedResourceId,
    projectId: archivedId,
    sourceId: archivedSourceId,
    kind: "memory",
    source: "shared",
    logicalPath: "instructions/AGENTS.md",
    title: "Archived instructions",
    revision: 1,
    deleted: false,
    files: [],
  };
  connection
    .prepare("INSERT INTO projects VALUES(?,?)")
    .run(archivedId, JSON.stringify(archived));
  connection
    .prepare("INSERT INTO resources VALUES(?,?,?)")
    .run(archivedResourceId, archivedId, JSON.stringify(resource));
  const binding = { base: resource, managed: true, paths: [archivedFile] };
  connection
    .prepare("INSERT INTO bindings VALUES(?,?,?)")
    .run(archivedResourceId, archivedId, JSON.stringify(binding));
  removalCatalog = [
    {
      id: projectId,
      name: "Repository test",
      role: "owner",
      sources: [{ id: sourceId, name: "private-repo" }],
    },
    { ...archived, sources: [{ id: archivedSourceId, name: "archive" }] },
  ];
  await mac.request({
    action: "project",
    operation: "remove-source",
    input: { projectId, sourceId },
  });
  assert.deepEqual(catalogRequests, ["/v2/projects?includeArchived=true"]);
  const savedArchived = JSON.parse(
    String(
      connection
        .prepare("SELECT value FROM projects WHERE id=?")
        .get(archivedId)?.value,
    ),
  ) as { revoked?: boolean };
  assert.notEqual(
    savedArchived.revoked,
    true,
    "Removing another source must not revoke an archived project",
  );
  assert.deepEqual(
    JSON.parse(
      String(
        connection
          .prepare("SELECT value FROM resources WHERE id=?")
          .get(archivedResourceId)?.value,
      ),
    ),
    resource,
  );
  assert.deepEqual(
    JSON.parse(
      String(
        connection
          .prepare("SELECT value FROM bindings WHERE id=?")
          .get(archivedResourceId)?.value,
      ),
    ),
    binding,
  );
  assert.equal(
    await readFile(archivedFile, "utf8"),
    "Preserve archived project instructions\n",
  );
  connection.close();
  console.log(
    "Passed native repository access: daily cache, launch refresh, authorization/binding invalidation, account/service isolation, live clone authorization and archived project preservation during source removal.",
  );
} finally {
  await mac.close();
  await new Promise<void>((done) => server.close(() => done()));
  await rm(home, { recursive: true, force: true });
}
