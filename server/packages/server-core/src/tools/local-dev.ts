import { spawnSync } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

const root = process.cwd();
const envPath = pathToFileURL(resolve(root, ".env.local"));
const privateDirectory = pathToFileURL(resolve(root, ".runtime/local") + "/");
const deployment = fileURLToPath(new URL("../../deploy/", import.meta.url));
const compose = [
  "compose",
  "--project-name",
  process.env.ORKA_LOCAL_PROJECT ?? "orka-local",
  "--env-file",
  fileURLToPath(envPath),
  "-f",
  resolve(deployment, "ec2/compose.yml"),
  "-f",
  resolve(deployment, "local/compose.yml"),
];

if (process.env.ORKA_API_SOURCE) {
  process.env.ORKA_BUILD_CONTEXT = resolve(process.env.ORKA_API_SOURCE);
  compose.push(
    "-f",
    resolve(process.env.ORKA_API_SOURCE, "deploy/build/compose.yml"),
  );
}

function docker(args: string[], input?: string): string {
  const result = spawnSync("docker", [...compose, ...args], {
    cwd: root,
    input,
    encoding: "utf8",
    stdio: input === undefined ? "inherit" : ["pipe", "pipe", "pipe"],
    maxBuffer: 1_000_000,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `Docker ${args[0]} failed. Check that Docker and the local stack are running.`,
    );
  return result.stdout ?? "";
}

async function up() {
  await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
  const variables = {
    DOMAIN: "localhost",
    POSTGRES_PASSWORD: randomBytes(32).toString("hex"),
    AUTH_DB_PASSWORD: randomBytes(32).toString("hex"),
    API_DB_PASSWORD: randomBytes(32).toString("hex"),
    JWT_SECRET: randomBytes(48).toString("hex"),
  };
  try {
    await writeFile(
      envPath,
      Object.entries(variables)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
      {
        mode: 0o600,
        flag: "wx",
      },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  docker(["config", "--quiet"]);
  docker(["up", "-d", "--build", "--wait", "api"]);
  console.log(
    "Local service ready at http://127.0.0.1:8080. Run npm run local:user -- dev@example.test to create an account.",
  );
}

async function user(email: string | undefined) {
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new Error("Usage: npm run local:user -- dev@example.test");
  const env = parseEnv(await readFile(envPath, "utf8"));
  if (!env.JWT_SECRET || env.JWT_SECRET.length < 32)
    throw new Error(
      "Run npm run local:up first to generate the local configuration.",
    );
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      role: "service_role",
      aud: "authenticated",
      iat: now,
      exp: now + 60,
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", env.JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest("base64url");
  const password = randomBytes(24).toString("base64url");
  await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
  const output = new URL(`account-${randomUUID()}.json`, privateDirectory);
  await writeFile(
    output,
    JSON.stringify(
      { service: "http://127.0.0.1:8080", email, password },
      null,
      2,
    ) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  try {
    const result = docker(
      [
        "exec",
        "-T",
        "api",
        "node",
        "--input-type=module",
        "-e",
        `
      import { readFileSync } from 'node:fs';
      const input = JSON.parse(readFileSync(0, 'utf8'));
      const response = await fetch('http://auth:9999/admin/users', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + input.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: input.email, password: input.password, email_confirm: true }),
        signal: AbortSignal.timeout(15000),
      });
      console.log(JSON.stringify({ status: response.status, ok: response.ok }));
    `,
      ],
      JSON.stringify({
        token: `${header}.${payload}.${signature}`,
        email,
        password,
      }),
    );
    const response = JSON.parse(result) as { ok: boolean; status: number };
    if (!response.ok)
      throw new Error(
        `Account provisioning failed (HTTP ${response.status}); the account may already exist.`,
      );
  } catch (error) {
    await unlink(output);
    throw error;
  }
  console.log(
    `Account created. Credentials are saved privately in ${fileURLToPath(output)} (mode 0600).`,
  );
}

try {
  const [action, email] = process.argv.slice(2);
  if (action === "up") await up();
  else if (action === "down") docker(["down"]);
  else if (action === "user") await user(email);
  else
    throw new Error(
      "Use npm run local:up, local:down, or local:user -- <email>.",
    );
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message
      : "Local development command failed.",
  );
  process.exitCode = 1;
}
