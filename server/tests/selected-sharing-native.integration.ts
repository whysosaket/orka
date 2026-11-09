import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  writeFile,
  appendFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Store, HttpError } from "./bridge/store.js";
import { Blobs } from "./reference/blobs.js";
import { createApi } from "./bridge/main.js";

const binary = process.env.ORKA_TEST_NATIVE_BINARY;
const records = (text: string): unknown[] =>
  text
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);
await test(
  "native plugin shares and updates only selected frozen sessions while automation stays off",
  { skip: !binary },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "orka-native-selected-"));
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const store = new Store(pool, new Blobs(join(home, "blobs")));
    const owner = randomUUID();
    const server = createApi(store, async (token) => {
      if (token !== owner)
        throw new HttpError(401, "Fixture credentials required");
      return owner;
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const env = {
      ...process.env,
      ORKA_TEST_HOME: home,
      CODEX_HOME: join(home, ".codex"),
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
    };
    const native = async (input: unknown) => {
      const child = spawn(binary!, ["--orka-test"], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "",
        error = "";
      child.stdout.on("data", (chunk) => (output += String(chunk)));
      child.stderr.on("data", (chunk) => (error += String(chunk)));
      child.stdin.end(JSON.stringify(input));
      const timer = setTimeout(() => child.kill("SIGTERM"), 30000);
      const code = await new Promise<number | null>((resolve) =>
        child.once("exit", resolve),
      );
      clearTimeout(timer);
      assert.equal(code, 0, error || output);
      return JSON.parse(output) as unknown;
    };
    let client: Client | undefined;
    try {
      await native({
        action: "configure",
        config: { apiUrl: origin, syncMinutes: 15 },
      });
      await native({
        action: "test-session",
        session: {
          access_token: owner,
          refresh_token: "fixture-refresh",
          expires_in: 3600,
          user: { id: owner },
        },
      });
      const projectId = await store.createProject(
        owner,
        "Native selected fixture",
        true,
      );
      const directory = join(home, "project");
      await mkdir(directory);
      const root = await realpath(directory);
      const paths = await readdir(join(home, "orka"), { recursive: true });
      const database = paths.find(
        (path) => path.includes(owner) && path.endsWith("sync.sqlite"),
      );
      assert.ok(database);
      const local = new DatabaseSync(join(home, "orka", database));
      const sharing = {
        memory: false,
        skill: false,
        plan: false,
        session: false,
        env: false,
      };
      local.prepare("insert into projects values(?,?)").run(
        projectId,
        JSON.stringify({
          id: projectId,
          name: "Native selected fixture",
          path: root,
          governed: true,
          sharing,
        }),
      );
      local.close();
      const nativeId = randomUUID();
      const sessions = join(home, ".codex/sessions");
      await mkdir(sessions, { recursive: true });
      const session = join(sessions, `rollout-${nativeId}.jsonl`);
      const original =
        [
          {
            type: "session_meta",
            payload: {
              id: nativeId,
              cwd: root,
              source: "cli",
              cli_version: "0.159.2",
            },
          },
          {
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [{ text: "Explicitly share this snapshot" }],
            },
          },
        ]
          .map((record) => JSON.stringify(record))
          .join("\n") + "\n";
      await writeFile(session, original);
      client = new Client({
        name: "Orka native selected fixture",
        version: "0.2.0",
      });
      await client.connect(
        new StdioClientTransport({
          command: binary!,
          args: ["--orka-plugin"],
          env,
        }),
      );
      const scope = { accountId: owner, serviceOrigin: origin, projectId };
      const call = async (name: string, input: Record<string, unknown>) => {
        const result = await client!.callTool({
          name,
          arguments: { ...scope, ...input },
        });
        assert.ok(!result.isError, JSON.stringify(result));
        return result.structuredContent as Record<string, unknown>;
      };
      const catalog = await call("list_local_resources", {
        kind: "session",
        nativeId,
      });
      const item = (catalog.items as { resourceId: string }[])[0];
      assert.ok(item, JSON.stringify(catalog));
      const preview = await call("preview_share", {
        kind: "session",
        resourceId: item.resourceId,
      });
      const future =
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ text: "Future private turn" }],
          },
        }) + "\n";
      await appendFile(session, future);
      const published = await call("share_selected", {
        previewToken: preview.previewToken,
      });
      assert.equal(published.status, "published");
      assert.deepEqual(
        await call("share_selected", { previewToken: preview.previewToken }),
        published,
      );
      const resources = await pool.query<{
        payload: { files: { hash: string }[] };
      }>("select payload from orka.resources where project_id=$1", [projectId]);
      assert.equal(resources.rowCount, 1);
      const oldHash = resources.rows[0].payload.files[0].hash;
      const frozen = (await store.blobs.read(projectId, oldHash)).toString();
      assert.deepEqual(records(frozen), records(original));
      const updated = await call("preview_share", {
        kind: "session",
        resourceId: item.resourceId,
      });
      assert.notEqual(updated.snapshotHash, preview.snapshotHash);
      assert.equal(
        (await call("share_selected", { previewToken: updated.previewToken }))
          .status,
        "published",
      );
      const current = await pool.query<{
        payload: { files: { hash: string }[] };
      }>("select payload from orka.resources where project_id=$1", [projectId]);
      assert.equal(current.rowCount, 1);
      assert.deepEqual(
        records(
          (
            await store.blobs.read(
              projectId,
              current.rows[0].payload.files[0].hash,
            )
          ).toString(),
        ),
        records(original + future),
      );
      assert.equal(
        (await store.blobs.read(projectId, oldHash)).toString(),
        frozen,
      );
      assert.equal(await readFile(session, "utf8"), original + future);
      const check = new DatabaseSync(join(home, "orka", database));
      const saved = check
        .prepare("select value from projects where id=?")
        .get(projectId) as { value: string };
      assert.deepEqual(JSON.parse(saved.value).sharing, sharing);
      assert.equal(
        (
          check.prepare("select count(*) as count from outbox").get() as {
            count: number;
          }
        ).count,
        0,
      );
      check.close();
    } finally {
      await client?.close();
      await native({ action: "sign-out" });
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
      await rm(home, { recursive: true, force: true });
    }
  },
);
