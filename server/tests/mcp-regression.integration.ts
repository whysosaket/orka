import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import type { Resource, ResourceInput } from "@portable/protocol";
import { Store } from "./bridge/store.js";
import { Blobs } from "./fixtures/blobs.js";
import { authSettings } from "./bridge/auth.js";
import { OrkaOAuth, tokenHash } from "./bridge/mcp.js";
import { OrkaReader } from "./bridge/mcp.js";
import { orkaTools } from "./bridge/mcp.js";

async function withStore(run: (store: Store) => Promise<void>) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const directory = await mkdtemp(join(tmpdir(), "orka-mcp-regression-"));
  try {
    await run(new Store(pool, new Blobs(directory)));
  } finally {
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  }
}

await test("MCP disconnect and refresh replay revoke concurrent replacement tokens", async () => {
  await withStore(async (store) => {
    const refreshPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1,
    });
    const revokePool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1,
    });
    const user = randomUUID();
    const settings = authSettings({ PUBLIC_URL: "https://fixture.example" });
    const runtimeStores = new Map<Pool, Store>();
    const oauth = (pool: Pool) =>
      new OrkaOAuth(
        (() => {
          const runtime = new Store(pool, store.blobs);
          runtimeStores.set(pool, runtime);
          return runtime;
        })(),
        settings.publicUrl!,
        async () => user,
        settings,
      );
    const verifier = oauth(store.pool),
      refresher = oauth(refreshPool),
      revoker = oauth(revokePool);
    const client = {
      client_id: randomUUID(),
      redirect_uris: ["https://client.example/callback"],
      token_endpoint_auth_method: "none" as const,
    };
    const seed = async () => {
      const access_token = randomBytes(32).toString("base64url"),
        refresh_token = randomBytes(32).toString("base64url");
      await store.pool.query(
        "insert into orka.mcp_tokens(access_hash,refresh_hash,family,client_id,user_id,resource,access_expires_at,refresh_expires_at) values($1,$2,$3,$4,$5,$6,now()+interval '1 hour',now()+interval '30 days')",
        [
          tokenHash(access_token),
          tokenHash(refresh_token),
          randomUUID(),
          client.client_id,
          user,
          verifier.resource.href,
        ],
      );
      return { access_token, refresh_token };
    };
    const waitForLock = async (pid: number) => {
      const deadline = Date.now() + 5000;
      for (;;) {
        const row = (
          await store.pool.query<{ waiting: boolean }>(
            "select wait_event_type='Lock' as waiting from pg_stat_activity where pid=$1",
            [pid],
          )
        ).rows[0];
        if (row?.waiting) return;
        assert.ok(Date.now() < deadline, "Expected a PostgreSQL lock wait");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    try {
      await store.pool.query("insert into orka.mcp_clients values($1,$2)", [
        client.client_id,
        client,
      ]);
      const refreshPid = await runtimeStores
        .get(refreshPool)!
        .invoke<number>("pid", {});
      const revokePid = await runtimeStores
        .get(revokePool)!
        .invoke<number>("pid", {});
      const independent = await seed();
      for (const method of ["access", "refresh", "replay"] as const) {
        const original = await seed();
        const current =
          method === "replay"
            ? await verifier.exchangeRefreshToken(
                client,
                original.refresh_token,
                undefined,
                verifier.resource,
              )
            : original;
        const blocker = await store.pool.connect();
        const pending: Promise<unknown>[] = [];
        try {
          await blocker.query("begin");
          await blocker.query(
            "select access_hash from orka.mcp_tokens where refresh_hash=$1 for update",
            [tokenHash(current.refresh_token!)],
          );
          const refreshing = refresher.exchangeRefreshToken(
            client,
            current.refresh_token!,
            undefined,
            refresher.resource,
          );
          pending.push(refreshing);
          void refreshing.catch(() => {});
          await waitForLock(refreshPid);
          const revoking =
            method === "replay"
              ? assert.rejects(
                  revoker.exchangeRefreshToken(
                    client,
                    original.refresh_token,
                    undefined,
                    revoker.resource,
                  ),
                  /Refresh token unavailable/,
                )
              : revoker.revokeToken(client, {
                  token:
                    method === "access"
                      ? current.access_token
                      : current.refresh_token!,
                });
          pending.push(revoking);
          void revoking.catch(() => {});
          await waitForLock(revokePid);
          await blocker.query("commit");
          const rotated = await refreshing;
          await revoking;
          await assert.rejects(
            verifier.verifyAccessToken(rotated.access_token),
            /expired or was revoked/,
            method,
          );
          await assert.rejects(
            verifier.exchangeRefreshToken(
              client,
              rotated.refresh_token!,
              undefined,
              verifier.resource,
            ),
            /Refresh token unavailable/,
            method,
          );
        } finally {
          await blocker.query("rollback");
          blocker.release();
          await Promise.allSettled(pending);
        }
      }
      await verifier.verifyAccessToken(independent.access_token);
    } finally {
      await Promise.all([refreshPool.end(), revokePool.end()]);
      await store.pool.query("delete from orka.mcp_clients where id=$1", [
        client.client_id,
      ]);
    }
  });
});

await test("MCP pagination retains equal-revision sessions across result and scan boundaries", async () => {
  await withStore(async (store) => {
    const user = randomUUID(),
      member = randomUUID();
    const project = await store.createProject(user, "Pagination fixture", true);
    try {
      await store.device(user, user, "Fixture Mac");
      await store.pool.query(
        "insert into orka.members values($1,$2,'member')",
        [project, member],
      );
      const file = async (text: string) => {
        const bytes = Buffer.from(text + "\n");
        const hash = await store.blobs.put(project, bytes);
        await store.pool.query("insert into orka.blobs values($1,$2,$3)", [
          project,
          hash,
          bytes.length,
        ]);
        await store.pool.query(
          "insert into orka.blob_uploads values($1,$2,$3)",
          [project, hash, user],
        );
        return {
          path: "session.jsonl",
          hash,
          size: bytes.length,
          executable: false,
        };
      };
      const resource: ResourceInput = {
        resourceId: randomUUID(),
        kind: "session",
        source: "claude",
        title: "Session with a conflict",
        logicalPath: "claude/fixture.jsonl",
        deleted: false,
        files: [await file("Original")],
      };
      const change = {
        version: 2 as const,
        projectId: project,
        deviceId: user,
        baseRevision: 0,
      };
      await store.mutate(user, { ...change, id: randomUUID(), resource });
      const conflict = await store.mutate(user, {
        ...change,
        id: randomUUID(),
        resource: { ...resource, files: [await file("Candidate")] },
      });
      const copy = await store.resolve(user, {
        version: 2,
        id: randomUUID(),
        projectId: project,
        deviceId: user,
        resourceId: resource.resourceId,
        action: "copy",
        selected: "candidate",
        expectedRevision: conflict.event.revision,
        conflictId: conflict.event.conflicts[0].id,
      });
      const reader = new OrkaReader(store, member, "https://fixture.example");
      const tool = orkaTools.find((tool) => tool.name === "list_sessions")!;
      const list = async (args: Record<string, unknown>) =>
        (await tool.run({ projectId: project, ...args }, reader)) as Awaited<
          ReturnType<OrkaReader["sessions"]>
        >;
      const first = await list({ limit: 1, cursor: 0 });
      assert.equal(first.sessions.length, 1);
      assert.ok(first.nextCursor);
      const second = await list({ limit: 1, cursor: first.nextCursor });
      assert.equal(second.sessions.length, 1);
      assert.equal(second.nextCursor, null);
      assert.deepEqual(
        new Set([...first.sessions, ...second.sessions].map((r) => r.id)),
        new Set([resource.resourceId, copy.event.resource.resourceId]),
      );
      assert.equal(
        (await list({ cursor: copy.event.revision })).sessions.length,
        0,
      );
      const newer: Resource[] = Array.from({ length: 499 }, (_, i) => {
        const id = randomUUID();
        return {
          ...copy.event.resource,
          resourceId: id,
          logicalPath: `claude/${id}.jsonl`,
          revision: copy.event.revision + i + 1,
        };
      });
      await store.pool.query(
        "insert into orka.resources select $1,(payload->>'resourceId')::uuid,(payload->>'revision')::bigint,payload from jsonb_array_elements($2::jsonb) payload",
        [project, JSON.stringify(newer)],
      );
      // Make the first scan nearly empty; its cursor must still retain the tied sibling.
      await store.pool.query(
        "insert into orka.resource_access select $1,(payload->>'resourceId')::uuid,$3,$4 from jsonb_array_elements($2::jsonb) payload",
        [
          project,
          JSON.stringify(newer),
          member,
          { mode: "hidden", canShare: false },
        ],
      );
      const scanFirst = await list({});
      assert.equal(scanFirst.sessions.length, 1);
      assert.ok(scanFirst.nextCursor);
      const scanSecond = await list({ cursor: scanFirst.nextCursor });
      assert.equal(scanSecond.sessions.length, 1);
      assert.equal(scanSecond.nextCursor, null);
      assert.deepEqual(
        new Set(
          [...scanFirst.sessions, ...scanSecond.sessions].map((r) => r.id),
        ),
        new Set([resource.resourceId, copy.event.resource.resourceId]),
      );
    } finally {
      await store.pool.query("delete from orka.projects where id=$1", [
        project,
      ]);
    }
  });
});
