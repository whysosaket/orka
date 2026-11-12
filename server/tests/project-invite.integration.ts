import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createServer } from "node:http";
import { createApi } from "./bridge/main.js";
import { authSettings } from "./bridge/auth.js";
import { Store } from "./bridge/store.js";
import { Blobs } from "./fixtures/blobs.js";

for (const mode of ["cloud", "self-hosted"] as const) {
  await test(`${mode} email invites require the verified recipient and retain link fallback`, async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const store = new Store(pool, new Blobs("unused-email-invite-test"));
    const owner = randomUUID(),
      recipient = randomUUID(),
      stranger = randomUUID();
    const deliveries: {
      email: string;
      url: string;
      tokenHash?: string;
      committed: boolean;
    }[] = [];
    let failDelivery = false;
    let deliveryAccepted: (() => void) | undefined;
    let deliveryResponse: Promise<void> | undefined;
    let releaseDelivery = () => {};
    let verified = true;
    let recipientEmail = "PERSON@example.com";
    const provider = createServer((req, res) => {
      void (async () => {
        res.setHeader("Content-Type", "application/json");
        if (req.url === "/user") {
          const id = req.headers.authorization?.slice(7);
          res.end(
            JSON.stringify({
              id,
              email: id === recipient ? recipientEmail : "other@example.com",
              email_confirmed_at: verified ? new Date().toISOString() : null,
            }),
          );
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const message = JSON.parse(Buffer.concat(chunks).toString());
        if (failDelivery) {
          res.writeHead(503).end(JSON.stringify({ message: "unavailable" }));
          return;
        }
        const url = String(message.text).match(
          /https:\/\/team.example\/join\/[a-f0-9]{48}/,
        )![0];
        const hash = createHash("sha256")
          .update(url.split("/").at(-1)!)
          .digest("hex");
        deliveries.push({
          email: message.to,
          url,
          tokenHash: req.headers["idempotency-key"]
            ?.toString()
            .replace("orka-invite-", ""),
          committed:
            (
              await pool.query(
                "select 1 from orka.invites where token_hash=$1",
                [hash],
              )
            ).rowCount === 1,
        });
        deliveryAccepted?.();
        await deliveryResponse;
        res.end(JSON.stringify({ id: "captured" }));
      })().catch(() => res.destroy());
    });
    await new Promise<void>((resolve) =>
      provider.listen(0, "127.0.0.1", resolve),
    );
    const providerAddress = provider.address();
    assert.ok(providerAddress && typeof providerAddress !== "string");
    const providerUrl = `http://127.0.0.1:${providerAddress.port}`;
    const previous = { ...process.env };
    Object.assign(process.env, {
      RESEND_API_KEY: "re_fixture",
      RESEND_FROM: "Orka <invite@example.com>",
      RESEND_API_URL: providerUrl,
    });
    const server = createApi(store, async (id) => id, providerUrl, {
      // Exercise the mail adapter in both modes; final-image tests cover each edition's configuration.
      ...authSettings({
        PUBLIC_URL: "https://team.example",
        DEPLOYMENT_MODE: "cloud",
        EMAIL_PROVIDER: "resend",
        RESEND_API_KEY: "re_fixture",
        RESEND_FROM: "Orka <invite@example.com>",
        SEND_EMAIL_HOOK_SECRET: "fixture",
      }),
      mode,
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const post = (path: string, input: unknown, user = owner) =>
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
      assert.equal(
        (await (await fetch(base + "/v2/instance")).json()).invites.email,
        true,
      );
      const projectId = await store.createProject(owner, "Team", true);
      assert.equal(
        (
          await post(
            "/v2/invites",
            { projectId, email: "person@example.com" },
            stranger,
          )
        ).status,
        403,
      );
      for (const email of [
        "",
        "invalid",
        "person@example.com\r\nBcc: other@example.com",
      ])
        assert.equal(
          (await post("/v2/invites", { projectId, email })).status,
          400,
        );
      assert.equal(deliveries.length, 0);
      const response = await post("/v2/invites", {
        projectId,
        email: "  Person@Example.com ",
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        sent: true,
        email: "person@example.com",
      });
      const token = new URL(deliveries[0].url).pathname.split("/").at(-1)!;
      const tokenHash = createHash("sha256").update(token).digest("hex");
      assert.equal(deliveries[0].email, "person@example.com");
      assert.equal(deliveries[0].tokenHash, tokenHash);
      assert.equal(deliveries[0].committed, true);
      const catalog = async () => {
        const response = await post("/v2/governance/action", {
          action: "catalog",
          input: { projectId },
        });
        assert.equal(response.status, 200);
        return response.json();
      };
      const pending = (await catalog()).pendingInvites;
      assert.equal(pending.length, 1);
      assert.deepEqual(Object.keys(pending[0]).sort(), ["email", "expiresAt"]);
      assert.equal(pending[0].email, "person@example.com");
      assert.ok(Date.parse(pending[0].expiresAt) > Date.now());
      for (const method of ["GET", "HEAD", "GET"])
        assert.equal(
          (await fetch(base + `/join/${token}`, { method })).status,
          200,
        );
      assert.equal(
        (
          await pool.query(
            "select 1 from orka.members where project_id=$1 and user_id=$2",
            [projectId, recipient],
          )
        ).rowCount,
        0,
      );
      assert.equal((await post("/v2/join", { token }, stranger)).status, 403);
      verified = false;
      assert.equal((await post("/v2/join", { token }, recipient)).status, 403);
      verified = true;
      const joins = await Promise.all([
        post("/v2/join", { token }, recipient),
        post("/v2/join", { token }, recipient),
      ]);
      assert.deepEqual(joins.map((r) => r.status).sort(), [200, 400]);
      assert.equal((await fetch(base + `/join/${token}`)).status, 410);
      assert.deepEqual((await catalog()).pendingInvites, []);
      assert.equal(
        (await post("/v2/invites", { projectId, email: "person@example.com" }))
          .status,
        429,
      );
      // Cooldowns survive token redemption, expiry and retries.
      const concurrent = await Promise.all([
        post("/v2/invites", { projectId, email: "next@example.com" }),
        post("/v2/invites", { projectId, email: "NEXT@example.com" }),
      ]);
      assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 429]);
      const accepted = new Promise<void>((resolve) => {
        deliveryAccepted = resolve;
      });
      deliveryResponse = new Promise<void>((resolve) => {
        releaseDelivery = resolve;
      });
      const controller = new AbortController();
      // Use the Go origin directly so disconnects reach the request context.
      const disconnected = assert.rejects(
        fetch((await store.ready) + "/v2/invites", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${owner}`,
            "Content-Type": "application/json",
            "X-Orka-Governance": "1",
          },
          body: JSON.stringify({ projectId, email: "cancelled@example.com" }),
          signal: controller.signal,
        }),
      );
      await accepted;
      controller.abort();
      await disconnected;
      releaseDelivery();
      deliveryAccepted = undefined;
      deliveryResponse = undefined;
      const interrupted = deliveries.at(-1)!;
      assert.equal(interrupted.committed, true);
      assert.equal(
        (await fetch(interrupted.url.replace("https://team.example", base)))
          .status,
        200,
      );
      recipientEmail = "cancelled@example.com";
      assert.equal(
        (
          await post(
            "/v2/join",
            { token: interrupted.url.split("/").at(-1)! },
            recipient,
          )
        ).status,
        200,
      );
      failDelivery = true;
      assert.equal(
        (await post("/v2/invites", { projectId, email: "failed@example.com" }))
          .status,
        503,
      );
      assert.equal(
        (
          await pool.query(
            "select 1 from orka.invites where project_id=$1 and email='failed@example.com'",
            [projectId],
          )
        ).rowCount,
        1,
      );
      failDelivery = false;
      assert.equal(
        (await post("/v2/invites", { projectId, email: "failed@example.com" }))
          .status,
        429,
      );
      await pool.query(
        "update orka.invitation_deliveries set created_at=now()-interval '61 seconds' where project_id=$1 and email_hash=$2",
        [
          projectId,
          createHash("sha256").update("failed@example.com").digest("hex"),
        ],
      );
      assert.equal(
        (await post("/v2/invites", { projectId, email: "failed@example.com" }))
          .status,
        200,
      );
      const expiredToken = deliveries.at(-1)!.url.split("/").at(-1)!;
      await pool.query(
        "update orka.invites set expires_at=now()-interval '1 second' where project_id=$1",
        [projectId],
      );
      recipientEmail = "failed@example.com";
      assert.equal(
        (await post("/v2/join", { token: expiredToken }, recipient)).status,
        400,
      );
      const link = await (await post("/v2/invites", { projectId })).json();
      assert.equal(
        (await post("/v2/join", { token: link.token }, stranger)).status,
        200,
      );
      await pool.query(
        "insert into orka.invitation_deliveries(token_hash,project_id,email_hash) select md5(n::text||$1::text),$1::uuid,'other' from generate_series(1,30) n",
        [projectId],
      );
      assert.equal(
        (await post("/v2/invites", { projectId, email: "limited@example.com" }))
          .status,
        429,
      );
      assert.equal((await post("/v2/invites", { projectId })).status, 200);
    } finally {
      releaseDelivery();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => provider.close(() => resolve()));
      for (const key of ["RESEND_API_KEY", "RESEND_FROM", "RESEND_API_URL"]) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
      await pool.end();
    }
  });

  await test(`${mode} pending invitation catalogs exclude expired, duplicate, and accepted recipients and restrict visibility`, async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const store = new Store(pool, new Blobs("unused-pending-invite-test"));
    const owner = randomUUID(),
      admin = randomUUID(),
      member = randomUUID(),
      outsider = randomUUID();
    const projects: string[] = [];
    const server = createApi(
      store,
      async (token) => token,
      undefined,
      authSettings({ DEPLOYMENT_MODE: mode }),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const catalog = async (projectId: string, user = owner) => {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/v2/governance/action`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${user}`,
            "Content-Type": "application/json",
            "X-Orka-Governance": "1",
          },
          body: JSON.stringify({ action: "catalog", input: { projectId } }),
        },
      );
      return { status: response.status, value: await response.json() };
    };
    try {
      await pool.query(
        "insert into orka.env_profiles(user_id,label,email) values($1,'Current member','MEMBER@example.com')",
        [member],
      );
      for (const roles of [true, false]) {
        const projectId = await store.createProject(
          owner,
          "Pending invitations",
          true,
          undefined,
          undefined,
          roles,
        );
        projects.push(projectId);
        for (const [user, role] of [
          [member, "member"],
          [admin, "admin"],
        ])
          await pool.query("insert into orka.members values($1,$2,$3)", [
            projectId,
            user,
            role,
          ]);
        for (const [email, expiry] of [
          ["pending@example.com", "2100-01-01T00:00:00.000Z"],
          ["pending@example.com", "2100-01-02T00:00:00.000Z"],
          ["expired@example.com", "2000-01-01T00:00:00.000Z"],
          ["member@example.com", "2100-01-01T00:00:00.000Z"],
          [null, "2100-01-01T00:00:00.000Z"],
        ])
          await pool.query(
            "insert into orka.invites(token_hash,project_id,email,expires_at) values($1,$2,$3,$4)",
            [randomUUID(), projectId, email, expiry],
          );
        const expected = [
          {
            email: "pending@example.com",
            expiresAt: "2100-01-02T00:00:00.000Z",
          },
        ];
        const result = await catalog(projectId);
        assert.equal(result.status, 200);
        assert.deepEqual(result.value.pendingInvites, expected);
        assert.deepEqual(
          (await catalog(projectId, admin)).value.pendingInvites,
          roles ? expected : [],
        );
        assert.deepEqual(
          (await catalog(projectId, member)).value.pendingInvites,
          [],
        );
        assert.equal((await catalog(projectId, outsider)).status, 403);
        const unrelated = await store.createProject(owner, "Other project");
        projects.push(unrelated);
        assert.deepEqual((await catalog(unrelated)).value.pendingInvites, []);
        await pool.query(
          "update orka.projects set archived_at=now() where id=$1",
          [projectId],
        );
        assert.equal((await catalog(projectId)).status, 403);
      }
    } finally {
      for (const id of projects)
        await pool.query("delete from orka.projects where id=$1", [id]);
      await pool.query("delete from orka.env_profiles where user_id=$1", [
        member,
      ]);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
    }
  });

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
