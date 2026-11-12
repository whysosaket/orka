import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { Store } from "./bridge/store.js";
import { migrate } from "./bridge/migrations.js";
import { Blobs } from "./fixtures/blobs.js";
import { createApi } from "./bridge/main.js";
import { accountAuthenticator } from "./bridge/migrations.js";
import { authSettings } from "./bridge/auth.js";

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

await test("operator backfill covers dormant members without replacing refreshed identities", async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const home = await mkdtemp(join(tmpdir(), "orka-member-backfill-"));
  const store = new Store(pool, new Blobs(home));
  const [dormant, absent, refreshed, blank, outsider] = Array.from(
    { length: 5 },
    () => randomUUID(),
  );
  const project = await store.createProject(dormant, "Backfill", true);
  // The integration harness owns this isolated database; production uses GoTrue's table.
  await pool.query(
    "create schema auth; create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb)",
  );
  try {
    for (const id of [absent, refreshed, blank])
      await pool.query("insert into orka.members values($1,$2,'member')", [
        project,
        id,
      ]);
    for (const [id, email] of [
      [dormant, " o'hara@example.test "],
      [absent, "absent@example.test"],
      [refreshed, "old@example.test"],
      [blank, "  "],
      [outsider, "outsider@example.test"],
    ])
      await pool.query("insert into auth.users values($1,$2,$3)", [
        id,
        email,
        { email: "forged@example.test" },
      ]);
    await pool.query(
      "insert into orka.env_profiles(user_id,label,email) values($1,'Existing name',null),($2,'Current name','current@example.test')",
      [dormant, refreshed],
    );
    const sql = await readFile(
      new URL("../deploy/ec2/backfill-member-emails.sql", import.meta.url),
      "utf8",
    );
    await pool.query(sql);
    await pool.query(sql);
    const { rows } = await pool.query(
      "select user_id,label,email from orka.env_profiles where user_id=any($1::uuid[])",
      [[dormant, absent, refreshed, blank, outsider]],
    );
    const identities = new Map(rows.map((row) => [row.user_id, row]));
    assert.equal(identities.get(dormant).email, "o'hara@example.test");
    assert.equal(identities.get(dormant).label, "Existing name");
    assert.equal(identities.get(absent).email, "absent@example.test");
    assert.equal(identities.get(refreshed).email, "current@example.test");
    assert.equal(identities.get(blank).email, null);
    assert.equal(identities.has(outsider), false);
  } finally {
    await pool.query("drop table auth.users; drop schema auth");
    await pool.query("delete from orka.projects where id=$1", [project]);
    await pool.query(
      "delete from orka.env_profiles where user_id=any($1::uuid[])",
      [[dormant, absent, refreshed, blank, outsider]],
    );
    await pool.end();
    await rm(home, { recursive: true, force: true });
  }
});

for (const mode of ["cloud", "self-hosted"])
  await test(`member emails use authenticated identities and remain project-scoped in ${mode}`, async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const home = await mkdtemp(join(tmpdir(), "orka-member-emails-"));
    const store = new Store(pool, new Blobs(home));
    const [owner, admin, member, missing, outsider] = Array.from(
      { length: 5 },
      () => randomUUID(),
    );
    const accounts = new Map<
      string,
      { id: string; email?: string; user_metadata: Record<string, string> }
    >(
      [owner, admin, member, missing, outsider].map((id, index) => [
        id,
        {
          id,
          email: id === missing ? undefined : `${index}@example.test`,
          user_metadata: {
            full_name: `Person ${index}`,
            email: "forged@example.test",
          },
        },
      ]),
    );
    accounts.get(member)!.email = "o'hara@example.test";
    let lookups = 0;
    const auth = createServer((req, res) => {
      lookups++;
      const account = accounts.get(
        req.headers.authorization?.replace(/^Bearer /, "") ?? "",
      );
      res.writeHead(req.url === "/user" && account ? 200 : 401, {
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify(account ?? { error: "Session expired" }));
    });
    const authUrl = await listen(auth);
    const api = createApi(
      store,
      accountAuthenticator(store, authUrl),
      authUrl,
      authSettings({ DEPLOYMENT_MODE: mode }),
    );
    const origin = await listen(api);
    const request = async (
      user: string,
      path: string,
      method = "GET",
      input?: unknown,
    ) => {
      const response = await fetch(origin + path, {
        method,
        headers: {
          Authorization: `Bearer ${user}`,
          "Content-Type": "application/json",
          "X-Orka-Governance": "1",
        },
        body: input === undefined ? undefined : JSON.stringify(input),
      });
      return { status: response.status, value: await response.json() };
    };
    const project = await store.createProject(
      owner,
      "Email visibility",
      true,
      undefined,
      undefined,
      true,
    );
    const catalog = (user: string, projectId = project) =>
      request(user, "/v2/governance/action", "POST", {
        action: "catalog",
        input: { projectId },
      });
    try {
      for (const [user, role] of [
        [admin, "admin"],
        [member, "member"],
        [missing, "member"],
      ])
        await pool.query("insert into orka.members values($1,$2,$3)", [
          project,
          user,
          role,
        ]);
      // Existing rows have no email until their next authenticated request.
      await pool.query(
        "insert into orka.env_profiles(user_id,label) values($1,$2)",
        [member, "Legacy name"],
      );
      let result = await catalog(owner);
      assert.equal(result.status, 200);
      assert.equal(
        result.value.members.find((row: { id: string }) => row.id === member)
          .email,
        null,
      );
      for (const user of accounts.keys())
        assert.equal((await request(user, "/v2/projects")).status, 200);
      for (const viewer of [owner, admin, member]) {
        const before = lookups;
        result = await catalog(viewer);
        assert.equal(result.status, 200);
        assert.equal(
          lookups - before,
          1,
          "Only authenticate the caller; no per-member requests",
        );
        assert.deepEqual(
          new Map(
            result.value.members.map(
              (row: { id: string; email: string | null }) => [
                row.id,
                row.email,
              ],
            ),
          ),
          new Map([
            [owner, "0@example.test"],
            [admin, "1@example.test"],
            [member, "o'hara@example.test"],
            [missing, null],
          ]),
        );
      }
      // Profile edits cannot supply or erase an authentication-owned email.
      assert.equal(
        (
          await request(member, "/v2/profile", "PUT", {
            displayName: "Edited name",
            source: "user",
            email: "forged@example.test",
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await request(member, "/v2/profile", "PUT", {
            displayName: "Edited name",
            source: "user",
          })
        ).status,
        200,
      );
      result = await catalog(owner);
      const edited = result.value.members.find(
        (row: { id: string }) => row.id === member,
      );
      assert.equal(edited.name, "Edited name");
      assert.equal(edited.email, "o'hara@example.test");

      accounts.get(member)!.email = "updated@example.test";
      await request(member, "/v2/projects");
      result = await catalog(owner);
      assert.equal(
        result.value.members.find((row: { id: string }) => row.id === member)
          .email,
        "updated@example.test",
      );
      accounts.get(member)!.email = "";
      await request(member, "/v2/projects");
      result = await catalog(owner);
      assert.equal(
        result.value.members.find((row: { id: string }) => row.id === member)
          .email,
        null,
        "Missing account email clears stale data without trusting metadata",
      );
      assert.equal(
        result.value.members.find((row: { id: string }) => row.id === member)
          .name,
        "Edited name",
      );

      assert.equal((await catalog(outsider)).status, 403);
      assert.equal((await catalog("invalid-token")).status, 401);
      assert.equal((await catalog(owner, "' OR true; --")).status, 400);
      await pool.query(
        "delete from orka.members where project_id=$1 and user_id=$2",
        [project, admin],
      );
      assert.equal((await catalog(admin)).status, 403);
      result = await catalog(owner);
      assert.ok(
        !result.value.members.some(
          (row: { id: string }) => row.id === admin || row.id === outsider,
        ),
      );

      // Restarting the baseline runner retains identity and profile data.
      await migrate(pool);
      result = await catalog(owner);
      assert.equal(
        result.value.members.find((row: { id: string }) => row.id === owner)
          .email,
        "0@example.test",
      );
      assert.equal(
        result.value.members.find((row: { id: string }) => row.id === member)
          .name,
        "Edited name",
      );
    } finally {
      await close(api);
      await close(auth);
      await pool.query("delete from orka.projects where id=$1", [project]);
      await pool.query(
        "delete from orka.profiles where user_id=any($1::uuid[])",
        [[...accounts.keys()]],
      );
      await pool.query(
        "delete from orka.env_profiles where user_id=any($1::uuid[])",
        [[...accounts.keys()]],
      );
      await pool.end();
      await rm(home, { recursive: true, force: true });
    }
  });
