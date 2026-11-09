import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { legacyMigrationNames } from "../../packages/server-core/src/migrations.js";

const source = resolve(process.argv[2] ?? ".");
const temporary = await mkdtemp(join(tmpdir(), "orka-readme-e2e-"));
const installation = join(temporary, "server");
const recovery = join(temporary, "recovery");
const operatorImage = process.env.ORKA_TEST_OPERATOR_IMAGE;
const operatorArchive = join(temporary, "operator.tar.gz");
const instances: { root: string; name: string }[] = [];
const environment = { ...process.env };
for (const key of Object.keys(environment))
  if (
    key.startsWith("COMPOSE_") ||
    key.startsWith("ORKA_") ||
    ["DOMAIN", "DATA_ROOT"].includes(key)
  )
    delete environment[key];

function run(root: string, command: string, args: string[], input?: Buffer) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: environment,
    input,
    encoding: "utf8",
    maxBuffer: 8_000_000,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${command} ${args[0]} failed: ${result.stderr?.slice(-3000) ?? result.error?.message}`,
    );
  return result.stdout;
}
const helper = (root: string, ...args: string[]) =>
  run(root, "sh", ["./orka-server", ...args]);
const compose = (root: string, args: string[], input?: Buffer) =>
  run(root, "docker", ["compose", "--env-file", ".env", ...args], input);
const migrationLedger = (root: string) =>
  compose(root, [
    "exec",
    "-T",
    "db",
    "psql",
    "-U",
    "postgres",
    "-d",
    "orka",
    "-At",
    "-c",
    "select name from orka.schema_migrations order by name",
  ]).trim();
async function availablePort() {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((done, reject) =>
    listener.close((error) => (error ? reject(error) : done())),
  );
  return address.port;
}
async function copySnapshot(from: string, to: string) {
  const manifest = JSON.parse(
    await readFile(join(from, "source-manifest.json"), "utf8"),
  ) as { files: { path: string; sha256: string }[] };
  for (const file of manifest.files) {
    const bytes = await readFile(join(from, file.path));
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      file.sha256,
      `Changed source: ${file.path}`,
    );
    await mkdir(join(to, file.path, ".."), { recursive: true });
    await copyFile(join(from, file.path), join(to, file.path));
  }
  await copyFile(
    join(from, "source-manifest.json"),
    join(to, "source-manifest.json"),
  );
}
type Account = { email: string; password: string; service: string };
type Session = { access_token: string; refresh_token: string };
async function api(
  origin: string,
  path: string,
  input?: unknown,
  token?: string,
  expected = 200,
) {
  const response = await fetch(origin + path, {
    method: input === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      Connection: "close",
      "X-Orka-Governance": "1",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: input === undefined ? undefined : JSON.stringify(input),
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, expected, `Unexpected status for ${path}`);
  return response;
}
const login = async (origin: string, account: Account) =>
  (await (
    await api(origin, "/auth/token?grant_type=password", {
      email: account.email,
      password: account.password,
    })
  ).json()) as Session;

try {
  try {
    await stat(join(source, "source-manifest.json"));
    await copySnapshot(source, installation);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    run(source, process.execPath, [
      "scripts/export-public-server.mjs",
      installation,
      "--candidate",
    ]);
  }
  if (operatorImage) {
    const snapshot = join(temporary, "source-snapshot");
    await rename(installation, snapshot);
    run(snapshot, process.execPath, [
      "scripts/release/package-operator.mjs",
      operatorImage,
      operatorArchive,
    ]);
    await mkdir(installation);
    run(snapshot, "tar", [
      "-xzf",
      operatorArchive,
      "--strip-components=1",
      "-C",
      installation,
    ]);
    assert.ok(!(await readdir(installation)).includes("packages"));
  }
  const readme = await readFile(join(installation, "README.md"), "utf8");
  assert.ok(
    readme.includes("sh ./orka-server setup --local --email"),
    "The README must document the tested setup command",
  );
  const port = await availablePort();
  console.log(
    "Testing the README setup from an isolated public source snapshot...",
  );
  const installationState = { root: installation, name: "" };
  instances.push(installationState);
  helper(
    installation,
    "setup",
    "--local",
    "--email",
    "owner@example.test",
    "--port",
    String(port),
  );
  const envPath = join(installation, ".env");
  const initialEnv = await readFile(envPath, "utf8");
  const config = parseEnv(initialEnv);
  const projectName = config.COMPOSE_PROJECT_NAME;
  assert.ok(projectName);
  installationState.name = projectName;
  const ownerPath = join(installation, ".runtime/accounts/owner.json");
  const ownerBytes = await readFile(ownerPath, "utf8");
  const owner = JSON.parse(helper(installation, "credentials")) as Account;
  let origin = `http://127.0.0.1:${port}`;
  assert.equal(owner.service, origin);
  assert.equal((await stat(ownerPath)).mode & 0o777, 0o600);
  assert.equal((await stat(envPath)).mode & 0o777, 0o600);
  helper(
    installation,
    "setup",
    "--local",
    "--email",
    owner.email,
    "--port",
    String(port),
  );
  assert.ok(
    (await readFile(envPath, "utf8")) === initialEnv,
    "Repeated setup must preserve secrets and project identity",
  );
  assert.ok(
    (await readFile(ownerPath, "utf8")) === ownerBytes,
    "Repeated setup must preserve the owner's password",
  );
  const changedPort = await availablePort();
  helper(
    installation,
    "setup",
    "--local",
    "--email",
    owner.email,
    "--port",
    String(changedPort),
  );
  origin = `http://127.0.0.1:${changedPort}`;
  const movedAccount = JSON.parse(
    helper(installation, "credentials"),
  ) as Account;
  assert.equal(movedAccount.service, origin);
  assert.ok(
    movedAccount.password === owner.password,
    "Changing the local port must keep the account password",
  );
  const changedConfig = parseEnv(await readFile(envPath, "utf8"));
  for (const key of [
    "POSTGRES_PASSWORD",
    "AUTH_DB_PASSWORD",
    "API_DB_PASSWORD",
    "JWT_SECRET",
    "COMPOSE_PROJECT_NAME",
  ])
    assert.ok(
      changedConfig[key] === config[key],
      `Changing the local port must preserve ${key}`,
    );
  helper(installation, "status");
  helper(installation, "doctor");
  assert.equal(
    migrationLedger(installation),
    "001_initial.sql\n002_github_repositories.sql",
  );
  console.log(
    "Fresh setup, repeated setup, port changes and diagnostics passed.",
  );
  helper(installation, "user", "teammate@example.test");
  const accountFiles = await readdir(join(installation, ".runtime/accounts"));
  const teammateName = accountFiles.find((name) => name.startsWith("account-"));
  assert.ok(teammateName);
  const teammate = JSON.parse(
    await readFile(
      join(installation, ".runtime/accounts", teammateName),
      "utf8",
    ),
  ) as Account;
  const session = await login(origin, owner),
    member = await login(origin, teammate);
  const instance = (await (await api(origin, "/v2/instance")).json()) as {
    mode: string;
    auth: { password: boolean; github: boolean; magicLink: boolean };
  };
  assert.equal(instance.mode, "self-hosted");
  assert.equal(instance.auth.password, true);
  assert.equal(instance.auth.github, false);
  assert.equal(instance.auth.magicLink, false);
  await api(origin, "/v2/projects", undefined, undefined, 401);
  await api(origin, "/auth/admin/users", {}, undefined, 404);
  const project = (await (
    await api(
      origin,
      "/v2/projects",
      { name: "README end-to-end", governance: 1 },
      session.access_token,
    )
  ).json()) as { id: string };
  const pullPath = `/v2/sync/pull?projectId=${project.id}&cursor=0&governance=1`;
  await api(origin, pullPath, undefined, member.access_token, 403);
  const sourceId = randomUUID(),
    deviceId = randomUUID();
  await api(
    origin,
    "/v2/projects/sources",
    { projectId: project.id, sources: [{ id: sourceId, name: "example" }] },
    session.access_token,
  );
  await api(
    origin,
    "/v2/devices",
    { id: deviceId, name: "README Mac" },
    session.access_token,
  );
  const text =
    "# Shared instructions\nUse the project's tests before publishing.\n";
  const hash = createHash("sha256").update(text).digest("hex");
  const blobPath = `/v2/blobs/${project.id}/${hash}`;
  const upload = await fetch(origin + blobPath, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      "X-Orka-Governance": "1",
      Connection: "close",
    },
    body: text,
  });
  assert.equal(upload.status, 200);
  const change = {
    version: 2,
    id: randomUUID(),
    projectId: project.id,
    deviceId,
    baseRevision: 0,
    resource: {
      resourceId: randomUUID(),
      sourceId,
      kind: "memory",
      source: "shared",
      logicalPath: "instructions/AGENTS.md",
      title: "Instructions",
      files: [
        {
          path: "content.md",
          hash,
          size: Buffer.byteLength(text),
          executable: false,
        },
      ],
      deleted: false,
    },
  };
  const receipt = await (
    await api(origin, "/v2/sync/push", change, session.access_token)
  ).json();
  assert.deepEqual(
    await (
      await api(origin, "/v2/sync/push", change, session.access_token)
    ).json(),
    receipt,
  );
  const invite = (await (
    await api(
      origin,
      "/v2/invites",
      { projectId: project.id },
      session.access_token,
    )
  ).json()) as { token: string };
  await api(origin, "/v2/join", { token: invite.token }, member.access_token);
  const verifyContent = async (base: string, token: string) => {
    const pulled = (await (
      await api(base, pullPath, undefined, token)
    ).json()) as { events: { resource: { resourceId: string } }[] };
    assert.ok(
      pulled.events.some(
        (event) => event.resource.resourceId === change.resource.resourceId,
      ),
    );
    const blob = await fetch(base + blobPath, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Orka-Governance": "1",
        Connection: "close",
      },
    });
    assert.equal(blob.status, 200);
    assert.equal(await blob.text(), text);
  };
  await verifyContent(origin, member.access_token);
  console.log(
    "Two-account sign-in, invitation, governed sync and blob isolation passed.",
  );
  helper(installation, "stop");
  helper(installation, "start");
  const refreshed = (await (
    await api(origin, "/auth/token?grant_type=refresh_token", {
      refresh_token: session.refresh_token,
    })
  ).json()) as Session;
  await verifyContent(origin, refreshed.access_token);
  console.log(
    "Cold restart, session refresh and persisted shared content passed.",
  );
  const backup = join(temporary, "verified-backup");
  helper(installation, "backup", backup);
  assert.equal((await stat(join(backup, "operator.env"))).mode & 0o777, 0o600);
  compose(installation, [
    "exec",
    "-T",
    "db",
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "postgres",
    "-d",
    "orka",
    "-c",
    "delete from orka.schema_migrations; insert into orka.schema_migrations(name) values " +
      legacyMigrationNames.map((name) => `('${name}')`).join(","),
  ]);
  helper(installation, "upgrade", "--reset-ledger");
  assert.equal(
    migrationLedger(installation),
    "001_initial.sql\n002_github_repositories.sql",
  );
  await verifyContent(origin, (await login(origin, owner)).access_token);
  console.log(
    "README setup, repeated setup, credentials, teammate join, real sync, cold restart, verified backup and upgrade passed.",
  );

  if (operatorImage) {
    await mkdir(recovery);
    run(installation, "tar", [
      "-xzf",
      operatorArchive,
      "--strip-components=1",
      "-C",
      recovery,
    ]);
  } else await copySnapshot(installation, recovery);
  const recoveryPort = await availablePort();
  const recoveryName = `${projectName}-restore`;
  instances.push({ root: recovery, name: recoveryName });
  helper(
    recovery,
    "restore",
    backup,
    "--project",
    recoveryName,
    "--port",
    String(recoveryPort),
  );
  assert.equal(
    migrationLedger(recovery),
    "001_initial.sql\n002_github_repositories.sql",
  );
  const recoveredOrigin = `http://127.0.0.1:${recoveryPort}`;
  await verifyContent(
    recoveredOrigin,
    (await login(recoveredOrigin, owner)).access_token,
  );
  await verifyContent(
    recoveredOrigin,
    (await login(recoveredOrigin, teammate)).access_token,
  );
  console.log(
    "Full recovery into fresh Compose volumes passed: original accounts, memberships, instructions and blobs restored.",
  );
} finally {
  for (const instance of instances.reverse()) {
    if (!instance.name) {
      try {
        instance.name =
          parseEnv(await readFile(join(instance.root, ".env"), "utf8"))
            .COMPOSE_PROJECT_NAME ?? "";
      } catch {
        continue;
      }
    }
    if (!/^orka-[a-f0-9]{8}(?:-restore)?$/.test(instance.name)) continue;
    spawnSync(
      "docker",
      [
        "compose",
        "--env-file",
        ".env",
        "-p",
        instance.name,
        "down",
        "--volumes",
        "--remove-orphans",
      ],
      { cwd: instance.root, env: environment, stdio: "ignore" },
    );
    spawnSync("docker", ["image", "rm", `orka-server:${instance.name}`], {
      stdio: "ignore",
    });
  }
  await rm(temporary, { recursive: true, force: true });
}
