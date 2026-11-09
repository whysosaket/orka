import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { Pool } from "pg";
import { Store } from "../bridge/store.js";
import { Blobs } from "../reference/blobs.js";
import { migrate } from "../bridge/migrations.js";
import { createApi } from "../bridge/main.js";
import { githubSettings, GitHubRepositories } from "../bridge/github.js";

const [environmentPath, nativePath, repositoryName] = process.argv.slice(2);
assert.ok(
  environmentPath && nativePath && repositoryName,
  "Usage: tsx scripts/github-live-e2e.ts /private/development.env /absolute/native-binary owner/private-fixture",
);
const env = parseEnv(await readFile(environmentPath, "utf8"));
const github = githubSettings({
  ...env,
  GITHUB_REPOS_TOKEN_KEY:
    env.GITHUB_REPOS_TOKEN_KEY || randomBytes(32).toString("hex"),
});
assert.ok(github.enabled);
const temporary = await mkdtemp(join(tmpdir(), "orka-github-live-"));
const pgBin = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@17/bin";
const children: ChildProcess[] = [];
const execute = async (
  binary: string,
  args: string[],
  options: { input?: unknown; env?: NodeJS.ProcessEnv } = {},
) => {
  const child = spawn(binary, args, {
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (value) => {
    stdout += value;
  });
  child.stderr.on("data", (value) => {
    stderr += value;
  });
  child.stdin.end(
    options.input === undefined ? undefined : JSON.stringify(options.input),
  );
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  assert.equal(code, 0, stderr || "Native acceptance operation failed");
  return stdout;
};
await execute(join(pgBin, "initdb"), [
  "-D",
  join(temporary, "postgres"),
  "-A",
  "trust",
  "-U",
  "postgres",
  "--no-locale",
]);
const port = 55900 + Math.floor(Math.random() * 200);
const pg = spawn(
  join(pgBin, "postgres"),
  ["-D", join(temporary, "postgres"), "-h", "127.0.0.1", "-p", String(port)],
  { stdio: "ignore" },
);
children.push(pg);
const pool = new Pool({
  connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres`,
});
const user = randomUUID();
const store = new Store(pool, new Blobs(join(temporary, "blobs")));
const repositories = new GitHubRepositories(store, github);
const server = createApi(
  store,
  async (token) => token,
  undefined,
  undefined,
  undefined,
  false,
  repositories,
);
let origin = "";
const rpc = async (mac: string, input: unknown) =>
  JSON.parse(
    await execute(resolve(nativePath), ["--orka-test"], {
      input,
      env: {
        ...process.env,
        ORKA_TEST_HOME: join(temporary, mac),
        ORKA_PROFILE: "default",
        CODEX_HOME: join(temporary, mac, ".codex"),
        CLAUDE_CONFIG_DIR: join(temporary, mac, ".claude"),
      },
    }),
  );
const call = (
  mac: string,
  operation: string,
  input: unknown = {},
  wait = false,
) =>
  rpc(mac, {
    action: "repository",
    operation,
    input,
    wait,
    context: { user, service: origin },
  });
try {
  for (let attempt = 0; ; attempt++) {
    try {
      await pool.query("select 1");
      break;
    } catch {
      assert.ok(attempt < 100, "PostgreSQL did not start");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  await migrate(pool);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;
  for (const mac of ["mac-one", "mac-two"]) {
    await rpc(mac, {
      action: "configure",
      config: { apiUrl: origin, mode: "self-hosted", syncMinutes: 15 },
    });
    await rpc(mac, {
      action: "test-session",
      session: {
        user: { id: user },
        access_token: user,
        refresh_token: "fixture-session",
        expires_in: 3600,
      },
    });
  }
  const authorization = await call("mac-one", "begin");
  process.stdout.write(
    `Authorize development app at ${authorization.verificationUrl} with code ${authorization.userCode}\n`,
  );
  const expires = Date.now() + authorization.expiresIn * 1000;
  for (;;) {
    assert.ok(Date.now() < expires, "GitHub authorization expired");
    await new Promise((resolve) =>
      setTimeout(resolve, authorization.interval * 1000),
    );
    const result = await call("mac-one", "poll", { id: authorization.id });
    assert.ok(!result.error, result.error);
    if (result.connected) break;
  }
  process.stdout.write(
    "Real GitHub device authorization and identity verification passed\n",
  );
  const installations = await call("mac-one", "installations", { page: 1 });
  let repository: { id: string; fullName: string } | undefined;
  for (const installation of installations.items) {
    const values = await call("mac-one", "repositories", {
      installationId: installation.id,
      page: 1,
    });
    repository = values.items.find(
      (item: { fullName: string }) => item.fullName === repositoryName,
    );
    if (repository) break;
  }
  assert.ok(
    repository,
    "Install the development app on the private fixture repository first",
  );
  const project = await rpc("mac-one", {
    action: "cloud-action",
    operation: "create",
    input: {
      name: "GitHub native acceptance",
      sharing: {
        memory: false,
        skill: false,
        session: false,
        plan: false,
        env: false,
      },
    },
  });
  const linked = await call("mac-one", "add-source", {
    projectId: project.id,
    repositoryId: repository.id,
  });
  const scope = { projectId: project.id, sourceId: linked.sourceId };
  assert.equal((await call("mac-one", "access", scope)).state, "ready");
  const first = await call(
    "mac-one",
    "clone",
    {
      ...scope,
      directory: join(temporary, "first workspace"),
      folderName: "fixture",
    },
    true,
  );
  assert.equal(first.state, "connected", first.message);
  assert.ok(
    (await readFile(join(first.destination, "README.md"), "utf8")).includes(
      "Orka",
    ),
  );
  assert.ok(
    !(
      await readFile(join(first.destination, ".git", "config"), "utf8")
    ).includes("x-access-token"),
  );
  // The second isolated native cache discovers the existing project/source before
  // cloning; source identity is retained even though its checkout path differs.
  await rpc("mac-two", { action: "sync-now" });
  const catalog = await fetch(`${origin}/v2/projects`, {
    headers: { Authorization: `Bearer ${user}`, "X-Orka-Governance": "1" },
  }).then((response) => response.json());
  const secondHome = await rpc("mac-two", { action: "profile-info" });
  const { DatabaseSync } = await import("node:sqlite");
  const { createHash } = await import("node:crypto");
  const account = new DatabaseSync(
    join(
      secondHome.root,
      "services",
      createHash("sha256").update(origin).digest("hex"),
      user,
      "sync.sqlite",
    ),
  );
  for (const value of catalog)
    account.prepare("insert or replace into projects values(?,?)").run(
      value.id,
      JSON.stringify({
        ...value,
        sharing: {
          memory: false,
          skill: false,
          session: false,
          plan: false,
          env: false,
        },
      }),
    );
  account.close();
  const second = await call(
    "mac-two",
    "clone",
    {
      ...scope,
      directory: join(temporary, "second workspace"),
      folderName: "fixture",
    },
    true,
  );
  assert.equal(second.state, "connected", second.message);
  assert.notEqual(second.destination, first.destination);
  const snapshot = await rpc("mac-two", { action: "snapshot" });
  assert.equal(
    snapshot.projects.find((p: { id: string }) => p.id === project.id)
      .sources[0].id,
    linked.sourceId,
  );
  await pool.query(
    "update orka.github_connections set expires_at=now()-interval '1 second' where user_id=$1",
    [user],
  );
  assert.equal((await call("mac-one", "access", scope)).state, "ready");
  process.stdout.write(
    "Private repository discovery, two isolated native clones, stable source binding and real GitHub token refresh passed\n",
  );
  await call("mac-one", "disconnect");
  assert.equal((await call("mac-one", "status")).connected, false);
  assert.equal((await call("mac-one", "access", scope)).state, "not_connected");
  process.stdout.write(
    "Real GitHub token revocation and disconnected-state acceptance passed\n",
  );
} finally {
  for (const mac of ["mac-one", "mac-two"]) {
    try {
      await rpc(mac, { action: "sign-out" });
    } catch {
      /* Preserve the original acceptance failure. */
    }
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
  for (const child of children) {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) =>
      child.exitCode !== null ? resolve() : child.once("exit", () => resolve()),
    );
  }
  await rm(temporary, { recursive: true, force: true });
}
