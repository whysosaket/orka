import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";

async function createUser() {
  const [email, option, filename, ...extra] = process.argv.slice(2);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new Error("Usage: docker compose run --rm admin owner@example.com");
  if (
    (option !== undefined &&
      (option !== "--output" ||
        !/^[a-z][a-z0-9-]*\.json$/.test(filename ?? ""))) ||
    extra.length
  )
    throw new Error(
      "Use --output owner.json to save an account at a stable private filename.",
    );
  const env = parseEnv(
    await readFile(
      process.env.ORKA_OPERATOR_ENV ?? "/run/secrets/operator_env",
      "utf8",
    ),
  );
  if (!env.JWT_SECRET || env.JWT_SECRET.length < 32)
    throw new Error(
      "The operator configuration needs a JWT_SECRET of at least 32 characters.",
    );
  const auth = new URL(process.env.AUTH_URL ?? "http://auth:9999");
  if (
    auth.username ||
    auth.password ||
    auth.search ||
    auth.hash ||
    auth.pathname !== "/"
  )
    throw new Error("AUTH_URL must be the internal GoTrue origin.");
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
  const service =
    env.DOMAIN === "localhost"
      ? `http://127.0.0.1:${env.ORKA_LOCAL_PORT ?? "8080"}`
      : `https://${env.DOMAIN}`;
  const name = filename ?? `account-${randomUUID()}.json`;
  const output = join(process.env.ORKA_ACCOUNT_DIRECTORY ?? "/output", name);
  let saved: { email: string; password: string; service: string } | undefined;
  if (filename) {
    try {
      saved = JSON.parse(await readFile(output, "utf8")) as typeof saved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error(
          "The existing private account file could not be read; it was preserved.",
          { cause: error },
        );
    }
  }
  if (saved) {
    if (
      typeof saved.email !== "string" ||
      saved.email.toLowerCase() !== email.toLowerCase() ||
      typeof saved.password !== "string"
    )
      throw new Error(
        "Setup already belongs to another account. Use the user command to add teammates; existing credentials were preserved.",
      );
    const login = await fetch(new URL("/token?grant_type=password", auth), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: saved.email, password: saved.password }),
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
    if (!login.ok)
      throw new Error(
        "The saved owner login could not be verified. Check the existing account and server before retrying; credentials were preserved.",
      );
    if (saved.service !== service) {
      const temporary = `${output}.${randomUUID()}`;
      await writeFile(
        temporary,
        JSON.stringify({ ...saved, service }, null, 2) + "\n",
        { mode: 0o600, flag: "wx" },
      );
      await rename(temporary, output);
    }
    console.log(
      `Existing account verified. Credentials remain in .runtime/accounts/${name}.`,
    );
    return;
  }
  const password = randomBytes(24).toString("base64url");
  await writeFile(
    output,
    JSON.stringify(
      {
        service,
        email,
        password,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  let response: Response;
  try {
    response = await fetch(new URL("/admin/users", auth), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${header}.${payload}.${signature}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, password, email_confirm: true }),
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
  } catch {
    // Retain credentials after transport failure: GoTrue may have created the account.
    throw new Error(
      `Account creation could not be confirmed. Check GoTrue before retrying; credentials are retained in .runtime/accounts/${name}.`,
    );
  }
  if (!response.ok) {
    await unlink(output);
    throw new Error(
      `Account provisioning failed (HTTP ${response.status}); the account may already exist.`,
    );
  }
  console.log(
    `Account created. Read .runtime/accounts/${name} privately for the password (mode 0600).`,
  );
}

try {
  await createUser();
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Account provisioning failed.",
  );
  process.exitCode = 1;
}
