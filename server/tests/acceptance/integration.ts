import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { migrate } from "../bridge/migrations.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
const directory = await mkdtemp(join(tmpdir(), "portable-pg-"));
const bin =
  process.env.PG_BIN ??
  (process.platform === "darwin"
    ? "/opt/homebrew/opt/postgresql@17/bin"
    : "/usr/lib/postgresql/17/bin");
const init = spawnSync(
  join(bin, "initdb"),
  ["-D", directory, "-A", "trust", "-U", "postgres", "--no-locale"],
  { encoding: "utf8" },
);
if (init.status !== 0) {
  await rm(directory, { recursive: true, force: true });
  throw new Error(`PostgreSQL init failed: ${init.stderr}`);
}
const port = 55400 + Math.floor(Math.random() * 500);
const pgLog: string[] = [];
const pg = spawn(
  join(bin, "postgres"),
  ["-D", directory, "-k", directory, "-h", "127.0.0.1", "-p", String(port)],
  { stdio: ["ignore", "ignore", "pipe"] },
);
pg.stderr?.on("data", (chunk) => pgLog.push(String(chunk)));
const databaseUrl = `postgresql://postgres@127.0.0.1:${port}/postgres`;
const pool = new Pool({ connectionString: databaseUrl });
try {
  // CI runners can take well over five seconds to accept connections.
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (pg.exitCode !== null)
      throw new Error(
        `PostgreSQL exited with code ${pg.exitCode}:\n${pgLog.join("")}`,
      );
    try {
      await pool.query("select 1");
      break;
    } catch {
      if (Date.now() > deadline)
        throw new Error(
          `PostgreSQL did not start within 60s:\n${pgLog.join("")}`,
        );
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  await migrate(pool);
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--test",
      "--test-concurrency=1",
      ...(process.argv.length > 2
        ? process.argv.slice(2)
        : [
            "tests/migrations.integration.ts",
            "tests/shutdown.integration.ts",
            "tests/cloud.integration.ts",
            "tests/onboarding.integration.ts",
            "tests/member-emails.integration.ts",
            "tests/devices.integration.ts",
            "tests/memory.integration.ts",
            "tests/projects.integration.ts",
            "tests/sources.integration.ts",
            "tests/project-invite.integration.ts",
            "tests/github.integration.ts",
            "tests/env.integration.ts",
            "tests/governance.integration.ts",
            "tests/role-policies.integration.ts",
            "tests/mcp.integration.ts",
            "tests/mcp-operations.integration.ts",
            "tests/mcp-regression.integration.ts",
            "tests/selected-sharing.integration.ts",
            "tests/selected-sharing-native.integration.ts",
          ]),
    ],
    { stdio: "inherit", env: { ...process.env, DATABASE_URL: databaseUrl } },
  );
  const exit = await new Promise<number>((resolve) =>
    child.once("exit", (code) => resolve(code ?? 1)),
  );
  process.exitCode = exit;
} finally {
  await pool.end();
  pg.kill("SIGTERM");
  await new Promise<void>((r) => {
    if (pg.exitCode !== null) r();
    else pg.once("exit", () => r());
  });
  await rm(directory, { recursive: true, force: true });
}
