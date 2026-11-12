import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { createServer, type ServerResponse } from "node:http";
import { Pool } from "pg";
import { Store } from "../bridge/store.js";
import { Blobs } from "../fixtures/blobs.js";
import { migrate } from "../bridge/migrations.js";
import { createApi } from "../bridge/main.js";
import { authSettings } from "../bridge/auth.js";

const [environmentPath, nativePath, githubLogin = "whysosaket"] =
  process.argv.slice(2);
assert.ok(
  environmentPath && nativePath,
  "Usage: tsx scripts/github-auth-live-e2e.ts /private/development.env /absolute/native-binary [github-login]",
);
const app = parseEnv(await readFile(environmentPath, "utf8"));
const clientId = app.GITHUB_REPOS_CLIENT_ID || app.GITHUB_CLIENT_ID;
const clientSecret = app.GITHUB_REPOS_CLIENT_SECRET || app.GITHUB_CLIENT_SECRET;
assert.ok(
  clientId?.startsWith("Iv") && clientSecret,
  "Development GitHub App credentials required",
);
const temporary = await mkdtemp(join(tmpdir(), "orka-github-auth-"));
const name = `orka-github-auth-${randomBytes(4).toString("hex")}`;
const origin = "http://127.0.0.1:57431",
  authOrigin = "http://127.0.0.1:57432";
const environment = {
  DOMAIN: "localhost",
  POSTGRES_PASSWORD: randomBytes(24).toString("hex"),
  AUTH_DB_PASSWORD: randomBytes(24).toString("hex"),
  API_DB_PASSWORD: randomBytes(24).toString("hex"),
  JWT_SECRET: randomBytes(48).toString("hex"),
};
const envPath = join(temporary, ".env"),
  override = join(temporary, "compose.json");
await writeFile(
  envPath,
  Object.entries(environment)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n"),
  { mode: 0o600 },
);
await writeFile(
  override,
  JSON.stringify({
    volumes: { "db-data": {} },
    services: {
      db: {
        volumes: ["db-data:/var/lib/postgresql/data"],
        ports: ["127.0.0.1:57433:5432"],
      },
      auth: {
        ports: ["127.0.0.1:57432:9999"],
        environment: {
          API_EXTERNAL_URL: origin + "/auth",
          GOTRUE_SITE_URL: origin,
          GOTRUE_EXTERNAL_GITHUB_ENABLED: "true",
          GOTRUE_EXTERNAL_GITHUB_CLIENT_ID: clientId,
          GOTRUE_EXTERNAL_GITHUB_SECRET: clientSecret,
          GOTRUE_EXTERNAL_GITHUB_REDIRECT_URI: origin + "/auth/callback",
          GOTRUE_DISABLE_SIGNUP: "false",
          GOTRUE_JWT_ISSUER: origin + "/auth",
        },
      },
    },
  }),
  { mode: 0o600 },
);
const execute = async (
  binary: string,
  args: string[],
  options: { input?: unknown; env?: NodeJS.ProcessEnv } = {},
) => {
  const child = spawn(binary, args, {
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.resume();
  child.stdin.end(
    options.input === undefined ? undefined : JSON.stringify(options.input),
  );
  const status = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  assert.equal(
    status,
    0,
    `${binary} acceptance operation failed; private runtime directory retained only until cleanup`,
  );
  return stdout;
};
const compose = (...args: string[]) =>
  execute("docker", [
    "compose",
    "--env-file",
    envPath,
    "--project-name",
    name,
    "-f",
    resolve("deploy/ec2/compose.yml"),
    "-f",
    override,
    ...args,
  ]);
const pool = new Pool({
  connectionString: `postgres://orka_api:${environment.API_DB_PASSWORD}@127.0.0.1:57433/orka`,
});
const authPool = new Pool({
  connectionString: `postgres://supabase_auth_admin:${environment.AUTH_DB_PASSWORD}@127.0.0.1:57433/orka`,
});
let callback: string | undefined;
let capturedSession: Record<string, unknown> | undefined;
const api = createApi(
  new Store(pool, new Blobs(join(temporary, "blobs"))),
  async (token) => {
    const response = await fetch(authOrigin + "/user", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    return (await response.json()).id as string;
  },
  authOrigin,
  authSettings({
    DEPLOYMENT_MODE: "cloud",
    PUBLIC_URL: origin,
    GITHUB_ENABLED: "true",
  }),
);
// The acceptance harness captures the native deep link before the OS dispatches
// it. Production still uses the unmodified proxy and native PKCE exchange.
const server = createServer((request, response) => {
  if (request.url === "/accepted") {
    response.setHeader("Content-Type", "text/html");
    response.end(
      "<h1>Orka GitHub sign-in accepted</h1><p>The native acceptance test will now verify the account.</p>",
    );
    return;
  }
  const setHeader = response.setHeader.bind(response),
    end = response.end.bind(response);
  response.setHeader = ((
    name: string,
    value: string | number | readonly string[],
  ) => {
    if (
      name.toLowerCase() === "location" &&
      typeof value === "string" &&
      value.startsWith("orka://auth/callback")
    ) {
      callback = value;
      return setHeader(name, origin + "/accepted");
    }
    return setHeader(name, value);
  }) as ServerResponse["setHeader"];
  response.end = ((value?: unknown, ...args: unknown[]) => {
    if (request.url?.startsWith("/auth/token") && typeof value === "string") {
      try {
        const parsed = JSON.parse(value);
        if (parsed.access_token && parsed.refresh_token)
          capturedSession = parsed;
      } catch {
        /* Not a successful token response. */
      }
    }
    return (end as (...args: unknown[]) => ServerResponse)(value, ...args);
  }) as ServerResponse["end"];
  api.emit("request", request, response);
});
const rpc = async (input: unknown) =>
  JSON.parse(
    await execute(resolve(nativePath), ["--orka-test"], {
      input,
      env: {
        ...process.env,
        ORKA_TEST_HOME: join(temporary, "native"),
        ORKA_PROFILE: "default",
        CODEX_HOME: join(temporary, "native", ".codex"),
        CLAUDE_CONFIG_DIR: join(temporary, "native", ".claude"),
      },
    }),
  );
try {
  await compose("up", "-d", "--wait", "auth");
  await migrate(pool);
  const github = await fetch(
    `https://api.github.com/users/${encodeURIComponent(githubLogin)}`,
  ).then((response) => response.json());
  assert.ok(Number.isSafeInteger(github.id));
  const originalAccount = randomUUID();
  await authPool.query(
    "insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at,confirmation_token,recovery_token,email_change,email_change_token_new) values('00000000-0000-0000-0000-000000000000',$1,'authenticated','authenticated',$2,'',now(),$3,$4,now(),now(),'','','','')",
    [
      originalAccount,
      `legacy-${originalAccount}@example.test`,
      { provider: "github", providers: ["github"] },
      {
        sub: String(github.id),
        provider_id: String(github.id),
        user_name: githubLogin,
      },
    ],
  );
  await authPool.query(
    "insert into auth.identities(id,provider_id,user_id,identity_data,provider,created_at,updated_at) values($1,$2,$3,$4,'github',now(),now())",
    [
      randomUUID(),
      String(github.id),
      originalAccount,
      {
        sub: String(github.id),
        email: `legacy-${originalAccount}@example.test`,
        email_verified: true,
      },
    ],
  );
  await new Promise<void>((resolve) =>
    server.listen(57431, "127.0.0.1", resolve),
  );
  await rpc({
    action: "configure",
    config: { apiUrl: origin, mode: "self-hosted", syncMinutes: 15 },
  });
  for (let attempt = 1; attempt <= 2; attempt++) {
    callback = undefined;
    capturedSession = undefined;
    await rpc({ action: "begin-sign-in", method: "github" });
    process.stdout.write(
      `GitHub App / GoTrue sign-in ${attempt}: browser flow opened; approve Orka Development Whysosaket if prompted\n`,
    );
    const deadline = Date.now() + 180_000;
    while (!callback) {
      assert.ok(Date.now() < deadline, "GitHub browser sign-in timed out");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.equal(
      (await rpc({ action: "complete-sign-in", callback })).signedIn,
      true,
    );
    assert.equal(
      (await rpc({ action: "session-user" })).user,
      originalAccount,
      "GitHub provider ID must retain the original Orka account",
    );
    const session = capturedSession as Record<string, unknown> | undefined;
    assert.ok(session);
    const user = session.user as {
      id: string;
      email?: string;
      identities?: {
        provider: string;
        identity_data: { sub?: string; email?: string };
      }[];
    };
    assert.equal(user.id, originalAccount);
    assert.ok(
      user.identities?.some(
        (identity) =>
          identity.provider === "github" &&
          identity.identity_data.sub === String(github.id) &&
          identity.identity_data.email?.includes("@"),
      ),
      "Pinned GoTrue must retrieve the GitHub email identity",
    );
    const keychainInfo = await rpc({ action: "profile-info" });
    const keychain = JSON.parse(
      await execute("/usr/bin/security", [
        "find-generic-password",
        "-s",
        keychainInfo.keychain,
        "-a",
        "supabase-session",
        "-w",
      ]),
    );
    assert.ok(
      !("provider_token" in keychain) &&
        !("provider_refresh_token" in keychain),
    );
    await rpc({
      action: "test-session",
      session: { ...session, expires_at: 0 },
    });
    await rpc({
      action: "repository",
      operation: "capabilities",
      input: {},
      context: { user: originalAccount, service: origin },
    });
    assert.equal((await rpc({ action: "session-user" })).user, originalAccount);
    await rpc({ action: "sign-out" });
    process.stdout.write(
      `Sign-in ${attempt} preserved the seeded GitHub account, retrieved email, completed native PKCE, stripped provider credentials, refreshed and signed out\n`,
    );
  }
} finally {
  try {
    await rpc({ action: "sign-out" });
  } catch {
    /* No session may have been created. */
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
  await authPool.end();
  await compose("down", "-v", "--remove-orphans");
  await rm(temporary, { recursive: true, force: true });
}
