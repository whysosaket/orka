import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createApi } from "../packages/server-core/src/main.js";
import { authSettings } from "../packages/server-core/src/auth.js";
import { Store } from "../packages/server-core/src/store.js";
import { Blobs } from "../packages/server-core/src/blobs.js";

for (const mode of ["cloud", "self-hosted"]) {
  await test(`${mode} browser invites preview without consuming and redeem only through authenticated join`, async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const store = new Store(pool, new Blobs("unused-invite-test"));
    const owner = randomUUID(),
      member = randomUUID();
    const publicUrl = "https://team.example";
    const server = createApi(
      store,
      async (token) => token,
      undefined,
      authSettings({ PUBLIC_URL: publicUrl, DEPLOYMENT_MODE: mode }),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const post = async (path: string, input: unknown, user = owner) =>
      fetch(base + path, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${user}`,
          "Content-Type": "application/json",
          "X-Orka-Governance": "1",
        },
        body: JSON.stringify(input),
      });
    try {
      const projectId = await store.createProject(
        owner,
        '<Team & "project">',
        true,
      );
      assert.equal(
        (await post("/v2/invites", { projectId }, member)).status,
        403,
      );
      const inviteResponse = await post("/v2/invites", { projectId });
      assert.equal(inviteResponse.status, 200);
      const invite = await inviteResponse.json();
      assert.equal(invite.url, `${publicUrl}/join/${invite.token}`);
      const path = `/join/${invite.token}`;
      for (const method of ["GET", "GET", "HEAD"]) {
        const response = await fetch(base + path, {
          method,
          headers: { Host: "attacker.example" },
        });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.equal(response.headers.get("referrer-policy"), "no-referrer");
        assert.match(
          response.headers.get("content-security-policy")!,
          /default-src 'none'/,
        );
        assert.match(response.headers.get("x-robots-tag")!, /noindex/);
        const html = await response.text();
        if (method === "HEAD") assert.equal(html, "");
        else {
          assert.match(html, /Join &lt;Team &amp; &quot;project&quot;&gt;/);
          assert.ok(
            html.includes(
              `orka://join/${invite.token}?server=https%3A%2F%2Fteam.example`,
            ),
          );
          assert.ok(html.includes(invite.url));
          assert.doesNotMatch(html, /<script|attacker.example|<Team/);
        }
      }
      assert.equal((await fetch(base + path, { method: "POST" })).status, 405);
      assert.equal(
        (await fetch(base + path + "?server=https://attacker.example")).status,
        400,
      );
      assert.equal((await fetch(base + "/join/not-a-token")).status, 400);
      assert.equal(
        (
          await pool.query(
            "select 1 from orka.members where project_id=$1 and user_id=$2",
            [projectId, member],
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await fetch(base + "/v2/join", {
            method: "POST",
            body: JSON.stringify({ token: invite.token }),
          })
        ).status,
        401,
      );
      const oldClient = await fetch(base + "/v2/join", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${member}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ token: invite.token }),
      });
      assert.equal(oldClient.status, 409);
      const attempts = await Promise.all([
        post("/v2/join", { token: invite.token }, member),
        post("/v2/join", { token: invite.token }, randomUUID()),
      ]);
      assert.deepEqual(
        attempts.map((response) => response.status).sort(),
        [200, 400],
      );
      assert.equal((await fetch(base + path)).status, 410);
      const expired = await (await post("/v2/invites", { projectId })).json();
      await pool.query(
        "update orka.invites set expires_at=now()-interval '1 second' where project_id=$1",
        [projectId],
      );
      assert.equal((await fetch(base + `/join/${expired.token}`)).status, 410);
      assert.equal(
        (await post("/v2/join", { token: expired.token }, member)).status,
        400,
      );
      const archived = await (await post("/v2/invites", { projectId })).json();
      await pool.query(
        "update orka.projects set archived_at=now() where id=$1",
        [projectId],
      );
      const unavailable = await fetch(base + `/join/${archived.token}`);
      assert.equal(unavailable.status, 410);
      assert.doesNotMatch(await unavailable.text(), /orka:\/\/join/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
    }
  });
}
