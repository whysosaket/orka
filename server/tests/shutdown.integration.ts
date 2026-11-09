import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";

await test(
  "production executable drains authenticated requests before exiting",
  { timeout: 20_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "orka-shutdown-"));
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const user = randomUUID();
    let releaseAuth!: () => void;
    let receivedAuth!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseAuth = resolve;
    });
    const received = new Promise<void>((resolve) => {
      receivedAuth = resolve;
    });
    const auth = createServer((request, response) => {
      if (request.url !== "/user") {
        response.writeHead(404).end();
        return;
      }
      receivedAuth();
      void held.then(() =>
        response.end(
          JSON.stringify({ id: user, email: "shutdown@example.test" }),
        ),
      );
    });
    let native: ChildProcess | undefined;
    try {
      await new Promise<void>((resolve) =>
        auth.listen(0, "127.0.0.1", resolve),
      );
      const authAddress = auth.address();
      assert.ok(authAddress && typeof authAddress !== "string");
      const reserved = createServer();
      await new Promise<void>((resolve) =>
        reserved.listen(0, "127.0.0.1", resolve),
      );
      const address = reserved.address();
      assert.ok(address && typeof address !== "string");
      await new Promise<void>((resolve) => reserved.close(() => resolve()));
      native = spawn("artifacts/bin/orka-server", [], {
        env: {
          ...process.env,
          DATABASE_URL: process.env.DATABASE_URL,
          BLOB_ROOT: join(directory, "blobs"),
          AUTH_URL: `http://127.0.0.1:${authAddress.port}`,
          PORT: String(address.port),
          PUBLIC_URL: `http://127.0.0.1:${address.port}`,
          MCP_ENABLED: "false",
          MEMORY_JEV_ENABLED: "false",
          GITHUB_ENABLED: "false",
          GITHUB_REPOS_ENABLED: "false",
          MAGIC_LINK_ENABLED: "false",
          EMAIL_PROVIDER: "smtp",
        },
        stdio: ["ignore", "ignore", "pipe"],
      });
      const exited = once(native, "exit");
      let log = "";
      native.stderr?.on("data", (chunk) => {
        log += String(chunk);
      });
      const base = `http://127.0.0.1:${address.port}`;
      const deadline = Date.now() + 10_000;
      for (;;) {
        assert.equal(native.exitCode, null, log);
        try {
          if ((await fetch(`${base}/health`)).ok) break;
        } catch {
          /* Wait for the listener. */
        }
        assert.ok(Date.now() < deadline, `startup timed out: ${log}`);
        await delay(25);
      }
      const request = fetch(`${base}/v2/projects`, {
        headers: { Authorization: "Bearer fixture" },
      });
      // Attach the rejection handler before SIGTERM so a broken drain cannot cause an unhandled rejection.
      const result = request.then(async (response) => ({
        status: response.status,
        body: await response.json(),
      }));
      void result.catch(() => {});
      await received;
      native.kill("SIGTERM");
      await delay(150);
      assert.equal(
        native.exitCode,
        null,
        "process exited while authentication was still in flight",
      );
      releaseAuth();
      assert.deepEqual(await result, { status: 200, body: [] });
      const [code] = await exited;
      assert.equal(code, 0, log);
    } finally {
      releaseAuth();
      if (native && native.exitCode === null) {
        native.kill("SIGKILL");
        await once(native, "exit");
      }
      auth.closeAllConnections();
      await new Promise<void>((resolve) => auth.close(() => resolve()));
      await pool.query("delete from orka.env_profiles where user_id=$1", [
        user,
      ]);
      await pool.end();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
