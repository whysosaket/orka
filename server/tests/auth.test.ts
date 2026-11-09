import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { Resend } from "resend";
import { Webhook } from "standardwebhooks";
import {
  authSettings,
  createEmailHook,
  desktopRedirect,
} from "../packages/server-core/src/auth.js";
import { createApi } from "../packages/server-core/src/main.js";
import { Store } from "../packages/server-core/src/store.js";
import { Blobs } from "../packages/server-core/src/blobs.js";

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}
const close = (server: Server) =>
  new Promise<void>((resolve) => server.close(() => resolve()));

await test("deployment settings fail closed without required email configuration", () => {
  assert.equal(authSettings({}).mode, "self-hosted");
  assert.throws(() => authSettings({ DEPLOYMENT_MODE: "other" }));
  assert.throws(() => authSettings({ GITHUB_ENABLED: "true" }));
  assert.throws(() => authSettings({ EMAIL_PROVIDER: "resend" }));
  for (const PUBLIC_URL of [
    "http://example.com",
    "https://user:secret@example.com",
    "https://example.com/path",
    "https://example.com?redirect=evil",
  ])
    assert.throws(() => authSettings({ PUBLIC_URL }));
});

await test("Resend hook verifies signed raw payloads, fixes the redirect, and propagates delivery failures", async () => {
  const deliveries: {
    input: Record<string, unknown>;
    key: string | undefined;
  }[] = [];
  let fail = false;
  const provider = createServer((req, res) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      assert.equal(req.url, "/emails");
      assert.equal(req.headers.authorization, "Bearer re_fixture");
      deliveries.push({
        input: JSON.parse(Buffer.concat(chunks).toString()),
        key: req.headers["idempotency-key"] as string | undefined,
      });
      res.writeHead(fail ? 429 : 200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          fail
            ? { name: "rate_limit_exceeded", message: "Try later" }
            : { id: "email-id" },
        ),
      );
    })().catch(() => res.destroy());
  });
  const baseUrl = await listen(provider);
  const secret = "whsec_" + randomBytes(32).toString("base64");
  const env = {
    PUBLIC_URL: "https://orka.example.com",
    EMAIL_PROVIDER: "resend",
    RESEND_API_KEY: "re_fixture",
    RESEND_FROM: "Orka <login@example.com>",
    SEND_EMAIL_HOOK_SECRET: `v1,${secret}`,
  };
  const hook = createEmailHook(
    authSettings(env),
    env,
    new Resend("re_fixture", { baseUrl }),
  );
  const payload = JSON.stringify({
    user: { email: "person@example.com" },
    email_data: {
      token: "123456",
      token_hash: "abc123",
      email_action_type: "magiclink",
      redirect_to: "https://attacker.example",
    },
  });
  const timestamp = new Date();
  const headers = {
    "webhook-id": "delivery-1",
    "webhook-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
    "webhook-signature": new Webhook(secret).sign(
      "delivery-1",
      timestamp,
      payload,
    ),
  };
  try {
    await assert.rejects(hook(payload, {}), /signature/);
    await assert.rejects(hook(payload + " ", headers), /signature/);
    const expired = new Date(Date.now() - 600_000);
    await assert.rejects(
      hook(payload, {
        ...headers,
        "webhook-timestamp": String(Math.floor(expired.getTime() / 1000)),
        "webhook-signature": new Webhook(secret).sign(
          "delivery-1",
          expired,
          payload,
        ),
      }),
      /signature/,
    );
    assert.equal(deliveries.length, 0);
    await hook(payload, headers);
    await hook(payload, headers);
    assert.equal(deliveries[0].key, deliveries[1].key);
    assert.equal(deliveries[0].input.to, "person@example.com");
    assert.match(
      String(deliveries[0].input.text),
      /orka%3A%2F%2Fauth%2Fcallback/,
    );
    assert.doesNotMatch(String(deliveries[0].input.html), /attacker/);
    for (const format of ["text", "html"]) {
      const content = String(deliveries[0].input[format]);
      assert.match(content, /auth\/confirm/);
      assert.doesNotMatch(content, /123456|enter this code/i);
    }
    const pluginPayload = JSON.stringify({
      ...JSON.parse(payload),
      email_data: {
        ...JSON.parse(payload).email_data,
        redirect_to: "https://orka.example.com/mcp/connect",
      },
    });
    await hook(pluginPayload, {
      ...headers,
      "webhook-signature": new Webhook(secret).sign(
        "delivery-1",
        timestamp,
        pluginPayload,
      ),
    });
    for (const format of ["text", "html"]) {
      const content = String(deliveries.at(-1)!.input[format]);
      assert.match(content, /123456/);
      assert.match(content, /Orka connection page/);
      assert.doesNotMatch(content, /auth\/confirm|on the Mac/);
    }
    fail = true;
    await assert.rejects(hook(payload, headers), /could not be sent/);
  } finally {
    await close(provider);
  }
});

await test("public auth proxy preserves OAuth redirects/cookies without following them or exposing admin routes", async () => {
  const requests: { path: string; cookie?: string; body: string }[] = [];
  const upstream = createServer((req, res) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      requests.push({
        path: req.url!,
        cookie: req.headers.cookie,
        body: Buffer.concat(chunks).toString(),
      });
      if (req.url?.startsWith("/authorize")) {
        res.writeHead(302, {
          Location: "https://github.com/login/oauth/authorize?state=opaque",
          "Set-Cookie": [
            "auth-state=one; HttpOnly; Secure",
            "auth-proof=two; HttpOnly; Secure",
          ],
        });
        res.end();
      } else if (req.url?.startsWith("/callback")) {
        res.writeHead(302, { Location: `${desktopRedirect}?code=one-time` });
        res.end();
      } else {
        res.setHeader("Content-Type", "application/json");
        res.end("{}");
      }
    })().catch(() => res.destroy());
  });
  const authUrl = await listen(upstream);
  const pool = new Pool();
  const store = new Store(pool, new Blobs("unused-auth-test"));
  const settings = authSettings({
    GITHUB_ENABLED: "true",
    MAGIC_LINK_ENABLED: "true",
    PUBLIC_URL: "https://orka.example.com",
    DEPLOYMENT_MODE: "cloud",
  });
  const api = createApi(
    store,
    async () => {
      throw new Error("Must not authenticate public routes");
    },
    authUrl,
    settings,
  );
  const base = await listen(api);
  const params = new URLSearchParams({
    provider: "github",
    redirect_to: desktopRedirect,
    code_challenge_method: "s256",
    code_challenge: "a".repeat(43),
    scopes: "repo admin:org",
  });
  try {
    const instance = await (await fetch(base + "/v2/instance")).json();
    assert.equal(instance.mode, "cloud");
    assert.deepEqual(instance.auth, {
      password: true,
      github: true,
      magicLink: true,
      profileRedirect: true,
    });
    const response = await fetch(base + "/auth/authorize?" + params, {
      redirect: "manual",
    });
    assert.equal(response.status, 302);
    assert.match(response.headers.get("location")!, /^https:\/\/github.com\//);
    assert.equal(response.headers.getSetCookie().length, 2);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.doesNotMatch(requests[0].path, /scopes/);
    params.set("redirect_to", `${desktopRedirect}?profile=alice`);
    assert.equal(
      (await fetch(base + "/auth/authorize?" + params, { redirect: "manual" }))
        .status,
      302,
    );
    assert.equal(
      new URL(requests.at(-1)!.path, base).searchParams.get("redirect_to"),
      `${desktopRedirect}?profile=alice`,
    );
    const callback = await fetch(
      base + "/auth/callback?code=github-code&state=opaque",
      { headers: { Cookie: "auth-state=one" }, redirect: "manual" },
    );
    assert.equal(
      callback.headers.get("location"),
      `${desktopRedirect}?code=one-time`,
    );
    assert.equal(requests.at(-1)!.cookie, "auth-state=one");
    params.set("redirect_to", "https://attacker.example");
    assert.equal((await fetch(base + "/auth/authorize?" + params)).status, 400);
    for (const path of [
      "/auth/admin/users",
      "/auth/signup",
      "/auth/user",
      "/auth/hooks/send-email",
    ])
      assert.equal(
        (await fetch(base + path, { method: "POST", body: "{}" })).status,
        404,
      );
    await fetch(base + "/auth/token?grant_type=pkce", {
      method: "POST",
      body: JSON.stringify({ auth_code: "code", code_verifier: "secret" }),
    });
    assert.equal(requests.at(-1)?.path, "/token?grant_type=pkce");
    await fetch(base + "/auth/otp?redirect_to=https://attacker.example", {
      method: "POST",
      body: "{}",
    });
    assert.equal(
      new URL(requests.at(-1)!.path, base).searchParams.get("redirect_to"),
      desktopRedirect,
    );
    await fetch(
      base +
        "/auth/otp?" +
        new URLSearchParams({ redirect_to: `${desktopRedirect}?profile=bob` }),
      { method: "POST", body: "{}" },
    );
    assert.equal(
      new URL(requests.at(-1)!.path, base).searchParams.get("redirect_to"),
      `${desktopRedirect}?profile=bob`,
    );
  } finally {
    await close(api);
    await close(upstream);
    await pool.end();
  }
});

await test("email scanners only render a page; confirmation requires an intentional same-origin POST", async () => {
  const verified: string[] = [];
  const upstream = createServer((req, res) => {
    verified.push(req.url!);
    res.writeHead(303, { Location: `${desktopRedirect}?code=one-time` });
    res.end();
  });
  const authUrl = await listen(upstream);
  const pool = new Pool();
  const settings = authSettings({
    MAGIC_LINK_ENABLED: "true",
    PUBLIC_URL: "http://127.0.0.1",
  });
  const api = createApi(
    new Store(pool, new Blobs("unused-confirmation-test")),
    async () => "",
    authUrl,
    settings,
  );
  const base = await listen(api);
  settings.publicUrl = base;
  const input = new URLSearchParams({
    token: "single-use-token",
    type: "magiclink",
    redirect_to: `${desktopRedirect}?profile=alice`,
  });
  try {
    for (let scan = 0; scan < 2; scan++) {
      const response = await fetch(`${base}/auth/confirm?${input}`);
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.match(html, /<button type="submit">Open Orka<\/button>/);
      assert.doesNotMatch(html, /<script|http-equiv="refresh"/i);
      assert.match(
        response.headers.get("content-security-policy")!,
        /form-action 'self'/,
      );
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    }
    assert.equal(verified.length, 0);
    const rejected = await fetch(`${base}/auth/confirm`, {
      method: "POST",
      headers: { Origin: "https://attacker.test" },
      body: input,
    });
    assert.equal(rejected.status, 400);
    assert.equal(verified.length, 0);
    assert.equal(
      (await fetch(`${base}/auth/confirm?${input}&token=duplicate`)).status,
      400,
    );
    const response = await fetch(`${base}/auth/confirm`, {
      method: "POST",
      headers: { Origin: base },
      body: input,
      redirect: "manual",
    });
    assert.equal(response.status, 303);
    assert.equal(
      response.headers.get("location"),
      `${desktopRedirect}?code=one-time`,
    );
    assert.equal(verified.length, 1);
    const forwarded = new URL(verified[0], base);
    assert.equal(forwarded.pathname, "/verify");
    assert.equal(
      forwarded.searchParams.get("redirect_to"),
      `${desktopRedirect}?profile=alice`,
    );
  } finally {
    await close(api);
    await close(upstream);
    await pool.end();
  }
});

await test("disabled email and password providers are blocked by the API, with refresh still available", async () => {
  const requests: string[] = [];
  const upstream = createServer((req, res) => {
    requests.push(req.url!);
    res.end("{}");
  });
  const authUrl = await listen(upstream);
  const pool = new Pool();
  const api = createApi(
    new Store(pool, new Blobs("unused-provider-test")),
    async () => "",
    authUrl,
    authSettings({ PASSWORD_ENABLED: "false" }),
  );
  const base = await listen(api);
  try {
    for (const path of [
      "/auth/otp",
      "/auth/verify",
      "/auth/token?grant_type=password",
      "/auth/confirm",
    ])
      assert.equal(
        (await fetch(base + path, { method: "POST", body: "{}" })).status,
        404,
      );
    assert.equal(requests.length, 0);
    assert.equal(
      (
        await fetch(base + "/auth/token?grant_type=refresh_token", {
          method: "POST",
          body: "{}",
        })
      ).status,
      200,
    );
    const instance = await (await fetch(base + "/v2/instance")).json();
    assert.equal(instance.auth.password, false);
    assert.equal(instance.auth.magicLink, false);
  } finally {
    await close(api);
    await close(upstream);
    await pool.end();
  }
});

await test("email requests hide account existence while keeping delivery and throttle failures actionable", async () => {
  let status = 200,
    error = "";
  const upstream = createServer((_req, res) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Retry-After": "60",
    });
    res.end(JSON.stringify({ error_code: error }));
  });
  const authUrl = await listen(upstream);
  const pool = new Pool();
  const api = createApi(
    new Store(pool, new Blobs("unused-enumeration-test")),
    async () => "",
    authUrl,
    authSettings({
      MAGIC_LINK_ENABLED: "true",
      PUBLIC_URL: "http://127.0.0.1",
    }),
  );
  const base = await listen(api);
  try {
    for (const code of [
      "",
      "user_not_found",
      "signup_disabled",
      "email_exists",
    ]) {
      status = code ? 422 : 200;
      error = code;
      const response = await fetch(base + "/auth/otp", {
        method: "POST",
        body: "{}",
      });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "{}");
    }
    for (const failure of [429, 503]) {
      status = failure;
      error = "delivery_failed";
      const response = await fetch(base + "/auth/otp", {
        method: "POST",
        body: "{}",
      });
      assert.equal(response.status, failure);
      assert.equal(response.headers.get("retry-after"), "60");
    }
  } finally {
    await close(api);
    await close(upstream);
    await pool.end();
  }
});

await test("rate-limit identity uses the connection unless the operator trusts a sanitizing proxy", async () => {
  let observed: string | undefined;
  const upstream = createServer((req, res) => {
    observed = req.headers["x-orka-client-ip"] as string;
    res.end("{}");
  });
  const auth = await listen(upstream);
  try {
    for (const trusted of [false, true]) {
      const api = createApi(
        new Store(new Pool(), new Blobs("unused")),
        async () => "unused",
        auth,
        authSettings({ TRUST_PROXY: String(trusted) }),
      );
      const base = await listen(api);
      try {
        const response = await fetch(
          base + "/auth/token?grant_type=refresh_token",
          {
            method: "POST",
            body: "{}",
            headers: {
              "X-Orka-Client-IP": "attacker",
              "X-Forwarded-For": "198.51.100.1, 203.0.113.8",
            },
          },
        );
        assert.equal(response.status, 200);
        assert.equal(observed, trusted ? "203.0.113.8" : "127.0.0.1");
      } finally {
        await close(api);
      }
    }
  } finally {
    await close(upstream);
  }
});
