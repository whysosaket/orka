import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { Store } from "./bridge/store.js";
import { Blobs } from "./reference/blobs.js";
import { createApi } from "./bridge/main.js";
import { authSettings } from "./reference/auth.js";
import { GitHubRepositories, githubSettings } from "./bridge/github.js";

for (const mode of ["cloud", "self-hosted"] as const)
  await test(`GitHub repository lifecycle over HTTP/PostgreSQL (${mode})`, async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const directory = await mkdtemp(join(tmpdir(), "orka-github-"));
    const store = new Store(pool, new Blobs(directory));
    const owner = randomUUID(),
      member = randomUUID(),
      outsider = randomUUID();
    const allowed = new Set(["fixture-owner"]);
    let beforeRepository: (() => Promise<void>) | undefined;
    let deviceCounter = 0,
      refreshes = 0;
    const tokens = new Map<string, string>();
    const repo = {
      id: 4242,
      full_name: "fixtures/private-repo",
      default_branch: "main",
      private: true,
    };
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    const provider: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const data = init?.body ? JSON.parse(String(init.body)) : {};
      const auth = new Headers(init?.headers)
        .get("Authorization")
        ?.replace("Bearer ", "");
      if (url.pathname === "/login/device/code")
        return json({
          device_code: `device-${++deviceCounter}`,
          user_code: "ABCD-EFGH",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 5,
        });
      if (url.pathname === "/login/oauth/access_token") {
        const identity =
          data.grant_type === "refresh_token"
            ? tokens.get(data.refresh_token)
            : data.device_code === "device-1"
              ? "fixture-owner"
              : "fixture-member";
        assert.ok(identity);
        if (data.grant_type === "refresh_token") {
          tokens.delete(data.refresh_token);
          refreshes++;
        }
        const access = `fixture-access-${randomUUID()}`,
          refresh = `fixture-refresh-${randomUUID()}`;
        tokens.set(access, identity);
        tokens.set(refresh, identity);
        return json({
          access_token: access,
          refresh_token: refresh,
          expires_in: 28800,
        });
      }
      if (
        url.pathname.startsWith("/applications/") &&
        init?.method === "DELETE"
      )
        return new Response(null, { status: 204 });
      const identity = auth ? tokens.get(auth) : undefined;
      if (!identity) return json({}, 401);
      if (url.pathname === "/user")
        return json({
          id: identity === "fixture-owner" ? 101 : 102,
          login: identity,
        });
      if (url.pathname === "/user/installations")
        return json({
          total_count: 51,
          installations: [{ id: 17, account: { login: "fixtures" } }],
        });
      if (url.pathname === "/user/installations/17/repositories")
        return json({
          total_count: allowed.has(identity) ? 1 : 0,
          repositories: allowed.has(identity) ? [repo] : [],
        });
      if (url.pathname === "/repositories/4242") {
        await beforeRepository?.();
        return allowed.has(identity) ? json(repo) : json({}, 404);
      }
      return json({}, 404);
    };
    const settings = {
      enabled: true,
      clientId: "fixture-client",
      clientSecret: "fixture-secret",
      appSlug: "fixture-orka",
      encryptionKey: randomBytes(32),
      webhookSecret: "fixture-webhook-".repeat(4),
    };
    const github = new GitHubRepositories(store, settings, provider);
    const server = createApi(
      store,
      async (token) => token,
      undefined,
      { ...authSettings({}), mode },
      undefined,
      false,
      github,
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const api = async (
      action: string,
      input: unknown = {},
      user: string = owner,
    ) => {
      const response = await fetch(`${base}/v2/github/action`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${user}`,
          "Content-Type": "application/json",
          "X-Orka-Governance": "1",
        },
        body: JSON.stringify({ action, input }),
      });
      return { status: response.status, value: await response.json() };
    };
    const connect = async (user: string) => {
      const started = await api("begin", {}, user);
      assert.equal(started.status, 200);
      assert.ok(!("device_code" in started.value));
      assert.equal(
        (await api("poll", { id: started.value.id }, outsider)).status,
        410,
      );
      assert.equal(
        (await api("poll", { id: started.value.id }, user)).value.pending,
        true,
      );
      await pool.query(
        "update orka.github_authorizations set next_poll_at=now()-interval '1 second' where id=$1",
        [started.value.id],
      );
      const result = await api("poll", { id: started.value.id }, user);
      assert.equal(result.status, 200);
      assert.equal(result.value.connected, true);
      assert.ok(!JSON.stringify(result.value).includes("fixture-access"));
    };
    try {
      const projectId = await store.createProject(
        owner,
        "GitHub integration",
        true,
      );
      await pool.query("insert into orka.members values($1,$2,'member')", [
        projectId,
        member,
      ]);
      assert.equal(
        (await fetch(`${base}/v2/instance`).then((r) => r.json())).repositories
          .github,
        1,
      );
      assert.equal(
        (
          await api(
            "clone-credentials",
            { projectId, sourceId: randomUUID() },
            outsider,
          )
        ).status,
        403,
      );
      await connect(owner);
      await connect(member);
      const encrypted = (
        await pool.query(
          "select credentials from orka.github_connections where user_id=$1",
          [owner],
        )
      ).rows[0].credentials;
      assert.ok(!encrypted.includes("fixture-access"));
      assert.equal((await api("installations")).value.nextPage, 2);
      assert.equal(
        (await api("repositories", { installationId: "17" }, member)).value
          .items.length,
        0,
      );
      assert.equal(
        (await api("add-source", { projectId, repositoryId: "4242" }, member))
          .status,
        403,
      );
      const added = await api("add-source", {
        projectId,
        repositoryId: "4242",
      });
      assert.equal(added.status, 200);
      const sourceId = added.value.sourceId;
      assert.equal(
        (await api("add-source", { projectId, repositoryId: "4242" })).status,
        409,
      );
      const source = { projectId, sourceId };
      assert.equal(
        (await api("access", source, member)).value.state,
        "access_unavailable",
      );
      assert.equal(
        (await api("clone-credentials", source, member)).status,
        403,
      );
      assert.equal(
        (
          await api(
            "bind",
            { ...source, repositoryId: "4242", expectedRevision: 1 },
            member,
          )
        ).status,
        403,
      );
      const requested = await api(
        "request-access",
        { ...source, reason: "Need to work on the repository" },
        member,
      );
      assert.equal(requested.status, 200);
      assert.equal(
        (await api("request-access", { ...source, reason: "Retry" }, member))
          .value.id,
        requested.value.id,
      );
      assert.equal(
        (await api("requests", { projectId }, outsider)).status,
        403,
      );
      let pending = (await api("requests", { projectId })).value.items[0];
      assert.equal(pending.githubLogin, "fixture-member");
      assert.equal(pending.canReview, true);
      assert.equal(
        (
          await api("review", {
            projectId,
            id: pending.id,
            expectedRevision: pending.revision,
            status: "verified",
            note: "Cannot bypass GitHub",
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await api(
            "review",
            {
              projectId,
              id: pending.id,
              expectedRevision: pending.revision,
              status: "waiting_on_github",
              note: "Ask GitHub administrator",
            },
            member,
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await api("review", {
            projectId,
            id: pending.id,
            expectedRevision: pending.revision,
            status: "waiting_on_github",
            note: "Ask GitHub administrator",
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await api("review", {
            projectId,
            id: pending.id,
            expectedRevision: pending.revision,
            status: "rejected",
            note: "Stale review",
          })
        ).status,
        409,
      );
      assert.equal(
        (await api("clone-credentials", source, member)).status,
        403,
      );
      allowed.add("fixture-member");
      assert.equal((await api("access", source, member)).value.state, "ready");
      pending = (await api("requests", { projectId }, member)).value.items[0];
      assert.equal(pending.status, "verified");
      assert.equal(pending.canReview, false);
      const clone = await api("clone-credentials", source, member);
      assert.equal(clone.status, 200);
      assert.ok(tokens.get(clone.value.token) === "fixture-member");
      assert.equal(
        clone.value.repository.cloneUrl,
        "https://github.com/fixtures/private-repo.git",
      );
      beforeRepository = async () => {
        await pool.query(
          "update orka.source_repositories set revision=2 where project_id=$1 and source_id=$2",
          [projectId, sourceId],
        );
      };
      assert.equal(
        (await api("clone-credentials", source)).status,
        412,
        "a link change during GitHub verification must not issue credentials",
      );
      beforeRepository = undefined;
      await pool.query(
        "update orka.source_repositories set revision=1 where project_id=$1 and source_id=$2",
        [projectId, sourceId],
      );
      beforeRepository = async () => {
        await pool.query(
          "delete from orka.members where project_id=$1 and user_id=$2",
          [projectId, member],
        );
      };
      assert.equal(
        (await api("clone-credentials", source, member)).status,
        403,
        "membership revoked during verification must not issue credentials",
      );
      beforeRepository = undefined;
      await pool.query("insert into orka.members values($1,$2,'member')", [
        projectId,
        member,
      ]);
      await pool.query(
        "update orka.github_connections set expires_at=now()-interval '1 second' where user_id=$1",
        [owner],
      );
      await Promise.all([
        api("repositories", { installationId: "17" }),
        api("repositories", { installationId: "17" }),
      ]);
      assert.equal(refreshes, 1, "refresh rotation is serialized per account");
      repo.full_name = "fixtures/renamed-private-repo";
      assert.equal((await api("access", source)).value.state, "ready");
      const catalog = await fetch(`${base}/v2/projects`, {
        headers: { Authorization: `Bearer ${owner}`, "X-Orka-Governance": "1" },
      }).then((r) => r.json());
      assert.equal(
        catalog.find((p: { id: string }) => p.id === projectId).sources[0]
          .repository.id,
        "4242",
      );
      const renamed = catalog.find((p: { id: string }) => p.id === projectId)
        .sources[0].repository;
      assert.equal(renamed.fullName, "fixtures/renamed-private-repo");
      assert.deepEqual(renamed.previousCloneUrls, [
        "https://github.com/fixtures/private-repo.git",
      ]);
      assert.equal(
        (await api("unlink", { ...source, expectedRevision: 1 })).status,
        200,
      );
      assert.equal(
        (
          await api("bind", {
            ...source,
            expectedRevision: 0,
            repositoryId: "4242",
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await api("bind", {
            ...source,
            expectedRevision: 2,
            repositoryId: "4242",
          })
        ).status,
        200,
      );
      assert.equal(
        (await api("clone-credentials", source, member)).value.bindingRevision,
        3,
      );
      const payload = Buffer.from(
        JSON.stringify({ action: "revoked", sender: { id: 102 } }),
      );
      const delivery = randomUUID();
      const webhook = (signature: string) =>
        fetch(`${base}/integrations/github/webhook`, {
          method: "POST",
          headers: {
            "X-GitHub-Delivery": delivery,
            "X-GitHub-Event": "github_app_authorization",
            "X-Hub-Signature-256": signature,
          },
          body: payload,
        });
      assert.equal((await webhook("wrong")).status, 401);
      assert.equal((await webhook("sha256=" + "é".repeat(64))).status, 401);
      const signature = `sha256=${createHmac("sha256", settings.webhookSecret).update(payload).digest("hex")}`;
      assert.equal((await webhook(signature)).status, 200);
      assert.equal((await webhook(signature)).status, 200);
      assert.equal((await api("status", {}, member)).value.connected, false);
      assert.equal(
        (await api("access", source, member)).value.state,
        "not_connected",
      );
      assert.equal((await api("disconnect")).status, 200);
      assert.equal((await api("status")).value.connected, false);
      assert.ok(
        Number(
          (
            await pool.query(
              "select count(*) as count from orka.repository_events where project_id=$1",
              [projectId],
            )
          ).rows[0].count,
        ) >= 4,
      );
      await pool.query("delete from orka.projects where id=$1", [projectId]);
    } finally {
      await pool.query(
        "delete from orka.github_connections where user_id=any($1::uuid[])",
        [[owner, member]],
      );
      await pool.query(
        "delete from orka.github_authorizations where user_id=any($1::uuid[])",
        [[owner, member]],
      );
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
      await rm(directory, { recursive: true, force: true });
    }
  });

await test("GitHub configuration stays optional and validates enabled credentials", () => {
  assert.equal(githubSettings({}).enabled, false);
  assert.throws(() => githubSettings({ GITHUB_REPOS_ENABLED: "true" }));
  const common = {
    GITHUB_REPOS_ENABLED: "true",
    GITHUB_CLIENT_ID: "Iv1fixture",
    GITHUB_CLIENT_SECRET: "same-secret",
    GITHUB_REPOS_APP_SLUG: "orka-development",
    GITHUB_REPOS_TOKEN_KEY: "ab".repeat(32),
    GITHUB_REPOS_WEBHOOK_SECRET: "test-secret".repeat(4),
  };
  assert.equal(githubSettings(common).clientId, "Iv1fixture");
  assert.throws(() =>
    githubSettings({ ...common, GITHUB_CLIENT_ID: "old-oauth-client" }),
  );
  assert.throws(() =>
    githubSettings({ ...common, GITHUB_REPOS_TOKEN_KEY: "short" }),
  );
});
