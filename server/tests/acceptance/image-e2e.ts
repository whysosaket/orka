import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  stat,
  writeFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkMcpImage } from "./mcp-image-check.js";

const [
  edition = "oss",
  image = `orka-test:${edition}`,
  composeFile = "deploy/ec2/compose.yml",
] = process.argv.slice(2);
assert.ok(["oss", "managed"].includes(edition));
const managed = edition === "managed";
const root = await mkdtemp(join(tmpdir(), "orka-image-"));
const name = `orka-image-${randomBytes(5).toString("hex")}`;
const port = 54000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`,
  mailBase = `http://127.0.0.1:${port + 1000}`;
const compose = resolve(composeFile),
  override = join(root, "test.json"),
  envFile = join(root, ".env");
const secret = "v1,whsec_" + randomBytes(32).toString("base64");
const accounts = join(root, "accounts");
await mkdir(accounts, { mode: 0o700 });
await writeFile(
  envFile,
  Object.entries({
    DOMAIN: "localhost",
    POSTGRES_PASSWORD: randomBytes(24).toString("hex"),
    AUTH_DB_PASSWORD: randomBytes(24).toString("hex"),
    API_DB_PASSWORD: randomBytes(24).toString("hex"),
    JWT_SECRET: randomBytes(48).toString("hex"),
    ORKA_OPERATOR_ENV_FILE: envFile,
  })
    .map(([k, v]) => `${k}=${v}`)
    .join("\n"),
  { mode: 0o600 },
);
const capture = join(root, "capture.mjs");
await writeFile(
  capture,
  `import {createServer} from 'node:http';
const messages=[];
createServer(async(req,res)=>{res.setHeader('Content-Type','application/json');
if(req.url==='/emails'&&req.method==='POST'){if(req.headers.authorization!=='Bearer re_fixture'){res.writeHead(401).end('{}');return;}const chunks=[];for await(const chunk of req)chunks.push(chunk);const mail=JSON.parse(Buffer.concat(chunks));const ID=String(messages.length+1);messages.unshift({ID,HTML:mail.html});res.end(JSON.stringify({id:ID}));}
else if(req.url==='/api/v1/messages')res.end(JSON.stringify({messages}));
else if(req.url.startsWith('/api/v1/message/'))res.end(JSON.stringify(messages.find(m=>m.ID===req.url.split('/').at(-1))));
else res.writeHead(404).end('{}');}).listen(8025,'0.0.0.0');`,
);
await writeFile(
  override,
  JSON.stringify({
    volumes: { "db-data": {}, "blob-data": {} },
    services: {
      ...(!managed
        ? {
            admin: {
              image,
              entrypoint: ["orka-server", "create-user"],
              environment: {
                AUTH_URL: "http://auth:9999",
                ORKA_OPERATOR_ENV: "/fixtures/operator.env",
              },
              user: `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
              volumes: [
                `${accounts}:/output`,
                `${envFile}:/fixtures/operator.env:ro`,
              ],
            },
          }
        : {}),
      db: { volumes: ["db-data:/var/lib/postgresql/data"] },
      ...(managed
        ? {
            "hook-proxy": {
              image: "node:24-bookworm-slim",
              network_mode: "service:auth",
              volumes: [
                `${resolve("deploy/testing/email-hook-proxy.mjs")}:/proxy.mjs:ro`,
              ],
              command: ["node", "/proxy.mjs"],
            },
          }
        : {}),
      api: {
        image,
        pull_policy: "never",
        volumes: ["blob-data:/data/blobs"],
        environment: {
          PUBLIC_URL: base,
          TRUST_PROXY: "false",
          GITHUB_ENABLED: "true",
          GITHUB_CLIENT_ID: "Iv1fixture",
          GITHUB_CLIENT_SECRET: "fixture-secret",
          GITHUB_REPOS_ENABLED: "true",
          GITHUB_REPOS_APP_SLUG: "orka-fixture",
          GITHUB_REPOS_TOKEN_KEY: randomBytes(32).toString("hex"),
          GITHUB_REPOS_WEBHOOK_SECRET: "fixture-github-webhook-".repeat(3),
          MAGIC_LINK_ENABLED: "true",
          SMTP_HOST: "mail",
          SMTP_PORT: "1025",
          SMTP_FROM: "login@example.test",
          SMTP_USER: "",
          SMTP_PASSWORD: "",
          MCP_ENABLED: "true",
          ...(managed
            ? {
                RESEND_API_KEY: "re_fixture",
                RESEND_FROM: "Orka <login@example.test>",
                SEND_EMAIL_HOOK_SECRET: secret,
                RESEND_API_URL: "http://mail:8025",
              }
            : {}),
        },
        ports: [`127.0.0.1:${port}:8080`],
      },
      auth: {
        environment: {
          API_EXTERNAL_URL: base + "/auth",
          GOTRUE_SITE_URL: base,
          GOTRUE_EXTERNAL_GITHUB_ENABLED: String(managed),
          GOTRUE_EXTERNAL_GITHUB_CLIENT_ID: "Iv1fixture",
          GOTRUE_EXTERNAL_GITHUB_SECRET: "fixture-secret",
          GOTRUE_DISABLE_SIGNUP: String(!managed),
          GOTRUE_SMTP_HOST: "mail",
          GOTRUE_SMTP_PORT: "1025",
          GOTRUE_SMTP_USER: "",
          GOTRUE_SMTP_PASS: "",
          GOTRUE_SMTP_ADMIN_EMAIL: "login@example.test",
          GOTRUE_SMTP_MAX_FREQUENCY: "1s",
          ...(managed
            ? {
                GOTRUE_HOOK_SEND_EMAIL_ENABLED: "true",
                GOTRUE_HOOK_SEND_EMAIL_URI: "http://127.0.0.1:8081",
                GOTRUE_HOOK_SEND_EMAIL_SECRETS: secret,
              }
            : {}),
        },
      },
      mail: managed
        ? {
            image: "node:24-bookworm-slim",
            command: ["node", "/capture.mjs"],
            volumes: [`${capture}:/capture.mjs:ro`],
            ports: [`127.0.0.1:${port + 1000}:8025`],
          }
        : {
            image: "axllent/mailpit:v1.27.8",
            ports: [`127.0.0.1:${port + 1000}:8025`],
          },
    },
  }),
);
const dc = (...args: string[]) => {
  const result = spawnSync(
    "docker",
    [
      "compose",
      "--env-file",
      envFile,
      "-p",
      name,
      "-f",
      compose,
      "-f",
      override,
      ...args,
    ],
    { encoding: "utf8", maxBuffer: 5_000_000 },
  );
  if (result.status !== 0) {
    const logs =
      args[0] === "up" ? dc("logs", "--tail", "10", "auth", "api") : "";
    throw new Error(
      `Compose ${args[0]} failed: ${result.stderr.slice(-1200)}\n${logs}`,
    );
  }
  return result.stdout;
};
const wait = async (check: () => Promise<boolean>) => {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      if (await check()) return;
    } catch {
      /* Container startup can take a few seconds. */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Container readiness timed out");
};
let previousMail = "";
async function email() {
  let id = "";
  await wait(async () => {
    const inbox = (await (
      await fetch(mailBase + "/api/v1/messages")
    ).json()) as { messages: { ID: string }[] };
    id = inbox.messages[0]?.ID;
    return Boolean(id && id !== previousMail);
  });
  previousMail = id;
  return (
    (await (await fetch(mailBase + "/api/v1/message/" + id)).json()) as {
      HTML: string;
    }
  ).HTML;
}
const post = (path: string, body: unknown, token?: string) =>
  fetch(base + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token
        ? { Authorization: `Bearer ${token}`, "X-Orka-Governance": "1" }
        : {}),
    },
    body: JSON.stringify(body),
  });
type Session = {
  access_token: string;
  refresh_token: string;
  user: { id: string };
};

async function passwordAccount(email: string) {
  const filename = email.split("@")[0] + ".json";
  dc("run", "--rm", "--no-deps", "admin", email, "--output", filename);
  const credentialPath = join(accounts, filename);
  assert.equal((await stat(credentialPath)).mode & 0o777, 0o600);
  const account = JSON.parse(await readFile(credentialPath, "utf8")) as {
    email: string;
    password: string;
  };
  const login = await post("/auth/token?grant_type=password", account);
  assert.equal(login.status, 200, "Admin-provisioned account sign-in failed");
  return {
    session: (await login.json()) as Session,
    password: account.password,
  };
}

async function emailAccount(
  address: string,
  profile?: string,
  useCode = false,
): Promise<Session> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const redirect =
    "orka://auth/callback" + (profile ? "?profile=" + profile : "");
  const requested = await post(
    "/auth/otp?" + new URLSearchParams({ redirect_to: redirect }),
    {
      email: address,
      create_user: true,
      code_challenge: challenge,
      code_challenge_method: "s256",
    },
  );
  assert.equal(requested.status, 200);
  const html = await email();
  const emailCode = html.match(/<h1>(\d{6,10})<\/h1>/)?.[1];
  assert.ok(emailCode);
  const link = html.match(/href="([^"]+)"/)?.[1]?.replaceAll("&amp;", "&");
  assert.ok(link);
  const url = new URL(link);
  assert.equal(url.pathname, "/auth/confirm");
  for (let scan = 0; scan < 2; scan++) {
    const preview = await fetch(url);
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get("referrer-policy"), "strict-origin");
  }
  assert.equal(
    (
      await post("/auth/verify", {
        email: address,
        token: emailCode === "000000" ? "999999" : "000000",
        type: "email",
      })
    ).status,
    403,
  );
  const confirm = () =>
    fetch(base + "/auth/confirm", {
      method: "POST",
      headers: { Origin: base },
      body: url.searchParams,
      redirect: "manual",
    });
  const verifyCode = () =>
    post("/auth/verify", { email: address, token: emailCode, type: "email" });
  if (useCode) {
    const login = await verifyCode();
    assert.equal(login.status, 200, await login.clone().text());
    assert.equal((await confirm()).status, 410);
    assert.equal((await verifyCode()).status, 403);
    return (await login.json()) as Session;
  }
  const verification = await confirm();
  assert.equal(verification.status, 200, await verification.clone().text());
  const handoff = (await verification.text()).match(/href="(orka:[^"]+)"/)?.[1];
  assert.ok(handoff);
  const callback = new URL(handoff.replaceAll("&amp;", "&"));
  assert.equal(callback.searchParams.get("profile"), profile ?? null);
  const code = callback.searchParams.get("code");
  assert.ok(code);
  const exchange = (code_verifier: string) =>
    post("/auth/token?grant_type=pkce", { auth_code: code, code_verifier });
  assert.equal(
    (await exchange(randomBytes(32).toString("base64url"))).status,
    400,
  );
  const login = await exchange(verifier);
  assert.equal(login.status, 200, await login.clone().text());
  assert.equal((await confirm()).status, 410);
  assert.equal((await verifyCode()).status, 403);
  assert.equal((await exchange(verifier)).status, 404);
  return (await login.json()) as Session;
}

try {
  dc("up", "-d", "--wait", "api", "mail", ...(managed ? ["hook-proxy"] : []));
  await wait(async () => (await fetch(base + "/health")).ok);
  const instance = await (await fetch(base + "/v2/instance")).json();
  assert.equal(instance.mode, managed ? "cloud" : "self-hosted");
  assert.equal(instance.auth.password, true);
  assert.equal(instance.auth.github, managed);
  assert.equal(instance.auth.magicLink, managed);
  assert.equal(instance.auth.emailCode, managed);
  assert.equal(instance.auth.browserOrigin, undefined);
  assert.equal(instance.repositories.github, 1);
  assert.equal((await fetch(base + "/v2/projects")).status, 401);
  for (const route of ["/auth/admin/users", "/auth/signup", "/auth/user"])
    assert.equal((await post(route, {})).status, 404);

  let session: Session, other: Session, password: string | undefined;
  if (managed) {
    session = await emailAccount("owner@example.test", "qa-login");
    other = await emailAccount("other@example.test", undefined, true);
  } else {
    for (const route of [
      "/auth/callback",
      "/auth/confirm",
      "/auth/verify",
      "/internal/dashboard/v2/instance",
    ])
      assert.equal((await fetch(base + route)).status, 404);
    for (const route of [
      "/auth/otp",
      "/auth/verify",
      "/auth/token?grant_type=pkce",
      "/auth/token?grant_type=password&grant_type=pkce",
    ])
      assert.equal((await post(route, {})).status, 404);
    ({ session, password } = await passwordAccount("owner@example.test"));
    ({ session: other } = await passwordAccount("other@example.test"));
  }
  const githubStatus = await post(
    "/v2/github/action",
    { action: "status", input: {} },
    session.access_token,
  );
  assert.equal(githubStatus.status, 200);
  assert.equal((await githubStatus.json()).connected, false);
  const projectResponse = await post(
    "/v2/projects",
    { name: "Image parity" },
    session.access_token,
  );
  assert.equal(projectResponse.status, 200);
  const project = (await projectResponse.json()).id as string;
  const apiHeaders = {
    Authorization: `Bearer ${session.access_token}`,
    "X-Orka-Governance": "1",
  };
  assert.equal(
    (
      await fetch(base + `/v2/sync/pull?projectId=${project}`, {
        headers: { Authorization: `Bearer ${other.access_token}` },
      })
    ).status,
    403,
  );
  assert.equal(instance.invites.email, true);
  const emailed = await post(
    "/v2/invites",
    { projectId: project, email: "other@example.test" },
    session.access_token,
  );
  assert.equal(emailed.status, 200, await emailed.clone().text());
  const invitationHtml = await email();
  const invitationUrl = invitationHtml.match(
    /href="([^"]+\/join\/[a-f0-9]{48})"/,
  )?.[1];
  assert.ok(invitationUrl);
  const invitationToken = new URL(invitationUrl).pathname.split("/").at(-1)!;
  assert.equal((await fetch(invitationUrl)).status, 200);
  assert.equal(
    (await post("/v2/join", { token: invitationToken }, session.access_token))
      .status,
    403,
  );
  assert.equal(
    (await post("/v2/join", { token: invitationToken }, other.access_token))
      .status,
    200,
  );
  assert.equal(
    (await post("/v2/join", { token: invitationToken }, other.access_token))
      .status,
    400,
  );
  const inviteResponse = await post(
    "/v2/invites",
    { projectId: project },
    session.access_token,
  );
  assert.equal(inviteResponse.status, 200, await inviteResponse.clone().text());
  const invite = (await inviteResponse.json()) as {
    token: string;
    url: string;
  };
  assert.equal(invite.url, `${base}/join/${invite.token}`);
  const invitePath = `/join/${invite.token}`;
  for (const method of ["GET", "HEAD", "GET"]) {
    const response = await fetch(base + invitePath, { method });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    if (method === "GET") {
      const html = await response.text();
      assert.ok(html.includes("Join Image parity"));
      assert.ok(
        html.includes(
          `orka://join/${invite.token}?server=${encodeURIComponent(base)}`,
        ),
      );
    }
  }
  assert.equal((await post(invitePath, {})).status, 405);
  assert.equal(
    (await post("/v2/join", { token: invite.token }, other.access_token))
      .status,
    200,
  );
  assert.equal((await fetch(base + invitePath)).status, 410);
  // Simulate dormant accounts at upgrade, then run the exact operator backfill
  // against this disposable stack's real GoTrue schema and restricted API role.
  dc(
    "exec",
    "-T",
    "db",
    "psql",
    "-U",
    "postgres",
    "-d",
    "orka",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    "update orka.env_profiles set email=null",
  );
  dc(
    "exec",
    "-T",
    "db",
    "psql",
    "-U",
    "postgres",
    "-d",
    "orka",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    await readFile(resolve("deploy/ec2/backfill-member-emails.sql"), "utf8"),
  );
  const catalogResponse = await post(
    "/v2/governance/action",
    { action: "catalog", input: { projectId: project } },
    session.access_token,
  );
  assert.equal(
    catalogResponse.status,
    200,
    await catalogResponse.clone().text(),
  );
  const catalog = (await catalogResponse.json()) as {
    members: { email: string }[];
  };
  assert.deepEqual(catalog.members.map((member) => member.email).sort(), [
    "other@example.test",
    "owner@example.test",
  ]);
  assert.equal(
    (await post("/v2/invites", { projectId: project }, other.access_token))
      .status,
    403,
  );
  const data = "Shared image parity content\n",
    hash = createHash("sha256").update(data).digest("hex");
  assert.equal(
    (
      await fetch(base + `/v2/blobs/${project}/${hash}`, {
        method: "PUT",
        headers: apiHeaders,
        body: data,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await fetch(base + `/v2/blobs/${project}/${hash}`, {
        headers: {
          Authorization: `Bearer ${other.access_token}`,
          "X-Orka-Governance": "1",
        },
      })
    ).status,
    404, // A member cannot read another person's unpublished upload.
  );
  await checkMcpImage(
    base,
    project,
    session.access_token,
    managed ? { email } : { password: password! },
  );
  assert.equal(
    (
      await post("/auth/token?grant_type=refresh_token", {
        refresh_token: session.refresh_token,
      })
    ).status,
    200,
  );
  const authorize = await fetch(
    base +
      "/auth/authorize?" +
      new URLSearchParams({
        provider: "github",
        redirect_to: "orka://auth/callback",
        code_challenge_method: "s256",
        code_challenge: randomBytes(32).toString("base64url"),
      }),
    { redirect: "manual" },
  );
  if (managed) {
    assert.equal(authorize.status, 302);
    assert.equal(
      new URL(authorize.headers.get("location")!).hostname,
      "github.com",
    );
    assert.ok(
      new URL(authorize.headers.get("location")!).searchParams.get("state"),
    );
    // GoTrue's IP limiter must see a server-derived identity even when callers spoof headers.
    let throttled = false;
    for (let attempt = 0; attempt < 70; attempt++) {
      const response = await fetch(base + "/auth/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Orka-Client-IP": `fake-${attempt}`,
          "X-Forwarded-For": `192.0.2.${attempt + 1}`,
        },
        body: JSON.stringify({
          email: "other@example.test",
          token: "000000",
          type: "email",
        }),
      });
      if (response.status === 429) {
        throttled = true;
        break;
      }
    }
    assert.ok(
      throttled,
      "Verification attempts must be rate limited even with forged forwarding headers",
    );
  } else {
    assert.equal(authorize.status, 404);
  }
  // Backup and restore run against the final image and validate every stored blob.
  for (const script of ["backup.sh", "restore-check.sh"]) {
    const result = spawnSync(
      "bash",
      [resolve("deploy/ec2", script), join(root, "backup")],
      {
        cwd: resolve("deploy/ec2"),
        env: {
          ...process.env,
          COMPOSE_FILE: `${compose}:${override}`,
          COMPOSE_PROJECT_NAME: name,
          COMPOSE_ENV_FILES: envFile,
        },
        encoding: "utf8",
        maxBuffer: 2_000_000,
      },
    );
    assert.equal(result.status, 0, `${script}: ${result.stderr}`);
  }
  await wait(async () => (await fetch(base + "/health")).ok);
  assert.equal(
    await (
      await fetch(base + `/v2/blobs/${project}/${hash}`, {
        headers: apiHeaders,
      })
    ).text(),
    data,
  );
  console.log(
    `Passed ${edition} image: actual GoTrue, ${managed ? "signed Resend hook, scanner-safe desktop PKCE and email code, GitHub redirect" : "admin-provisioned password-only sign-in"}, project invites, session refresh, membership/blob isolation, MCP consent and all seven tools, handoff, token refresh/revocation, coordinated backup/restore.`,
  );
} finally {
  try {
    dc("down", "--volumes", "--remove-orphans");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
