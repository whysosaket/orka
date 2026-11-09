import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import type {
  Change,
  Event,
  MemoryChoice,
  Receipt,
  ResourceInput,
} from "@portable/protocol";
import { Store } from "./bridge/store.js";
import { Blobs, bytesHash } from "./reference/blobs.js";
import { createApi } from "./bridge/main.js";
import { JevMemoryResolver } from "./reference/jev.js";

async function fixture(resolver: JevMemoryResolver) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const directory = await mkdtemp(join(tmpdir(), "orka-memory-"));
  const blobs = new Blobs(directory);
  const store = new Store(pool, blobs, resolver);
  const user = randomUUID(),
    device = randomUUID();
  const project = await store.createProject(
    user,
    "Synthetic memory validation",
  );
  await store.device(user, device, "Synthetic client");
  const server = createApi(store, async () => user);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const api = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(origin + path, {
      method,
      headers: {
        Authorization: `Bearer ${user}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  const file = async (text: string) => {
    const bytes = Buffer.from(text),
      hash = bytesHash(bytes);
    const response = await fetch(`${origin}/v2/blobs/${project}/${hash}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${user}` },
      body: bytes,
    });
    assert.equal(response.status, 200);
    return { path: "content.md", hash, size: bytes.length, executable: false };
  };
  const change = async (
    text: string,
    source: ResourceInput["source"] = "claude",
  ): Promise<Change> => ({
    version: 2,
    id: randomUUID(),
    projectId: project,
    deviceId: device,
    baseRevision: 0,
    resource: {
      resourceId: randomUUID(),
      kind: "memory",
      source,
      logicalPath:
        source === "shared"
          ? "instructions/AGENTS.md"
          : `${source}/${randomUUID()}.md`,
      title: "Synthetic runtime memory",
      files: [await file(text)],
      deleted: false,
    },
  });
  const text = async (receipt: Receipt) => {
    const response = await fetch(
      `${origin}/v2/blobs/${project}/${receipt.event.resource.files[0].hash}`,
      {
        headers: { Authorization: `Bearer ${user}` },
      },
    );
    assert.equal(response.status, 200);
    return response.text();
  };
  const close = async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  };
  return { pool, store, project, api, file, change, text, close };
}

await test("HTTP memory consolidation: all sources, JEV decisions, snapshots, retries, concurrency and rollback", async () => {
  let choice: MemoryChoice = "accept_incoming",
    unavailable = false,
    calls = 0;
  const resolver = new JevMemoryResolver(
    { enabled: true, apiKey: "fixture" },
    async (_url, request) => {
      calls++;
      if (unavailable)
        return new Response("private provider body", {
          status: 503,
          headers: { "retry-after": "0" },
        });
      const { questions } = JSON.parse(request?.body as string);
      return Response.json({
        model: "jev-1.13.0",
        usage: { input_tokens: 100, output_tokens: 20 },
        answers: Object.fromEntries(
          Object.keys(questions).map((id) => [
            id,
            {
              type: "choice",
              choice,
              confidence: 1,
              probabilities: {
                keep_current: choice === "keep_current" ? 1 : 0,
                accept_incoming: choice === "accept_incoming" ? 1 : 0,
                keep_both: choice === "keep_both" ? 1 : 0,
              },
            },
          ]),
        ),
      });
    },
  );
  const f = await fixture(resolver);
  try {
    for (const source of ["shared", "claude", "codex"] as const) {
      const initial = await f.change("# Runtime\nUse Node 22.\n", source);
      const first = await f.api("/v2/sync/push", "POST", initial);
      assert.equal(first.status, 200);
      const before = calls;
      const updated: Change = {
        ...initial,
        id: randomUUID(),
        baseRevision: first.data.event.revision,
        resource: {
          ...initial.resource,
          files: [await f.file("# Runtime\nUse Node 24.\n")],
        },
      };
      const accepted = await f.api("/v2/sync/push", "POST", updated);
      assert.equal(accepted.status, 200);
      assert.equal(calls, before + 1);
      assert.equal(await f.text(accepted.data), "# Runtime\nUse Node 24.\n");
      assert.equal(
        accepted.data.event.memoryResolutions[0].choice,
        "accept_incoming",
      );
      const replay = await f.api("/v2/sync/push", "POST", updated);
      assert.deepEqual(replay.data, accepted.data);
      assert.equal(calls, before + 1);
      const snap = await f.pool.query(
        "select payload from orka.snapshots where project_id=$1 and resource_id=$2 and revision=$3",
        [f.project, initial.resource.resourceId, first.data.event.revision],
      );
      assert.deepEqual(snap.rows[0].payload.files, initial.resource.files);
    }
    const initial = await f.change(
      "# Runtime\nUse Node 22.\n# Verification\nRun npm test.\n",
    );
    const base = (await f.api("/v2/sync/push", "POST", initial))
      .data as Receipt;
    const edit = async (
      text: string,
      baseRevision = base.event.revision,
    ): Promise<Change> => ({
      ...initial,
      id: randomUUID(),
      baseRevision,
      resource: { ...initial.resource, files: [await f.file(text)] },
    });
    const first = await f.api(
      "/v2/sync/push",
      "POST",
      await edit(
        "# Runtime\nLegacy worker uses Node 22.\n# Verification\nRun npm test.\n",
      ),
    );
    choice = "keep_both";
    const merged = await f.api(
      "/v2/sync/push",
      "POST",
      await edit(
        "# Runtime\nNew API uses Node 24.\n# Verification\nRun npm test.\nAdded verification note.\n",
      ),
    );
    assert.equal(merged.status, 200);
    assert.equal(
      await f.text(merged.data),
      "# Runtime\nLegacy worker uses Node 22.\nNew API uses Node 24.\n# Verification\nRun npm test.\nAdded verification note.\n",
    );
    choice = "keep_current";
    const kept = await f.api(
      "/v2/sync/push",
      "POST",
      await edit("# Runtime\nGuess: Node 18.\n# Verification\nRun npm test.\n"),
    );
    assert.equal(kept.status, 200);
    assert.equal(await f.text(kept.data), await f.text(merged.data));
    assert.equal(kept.data.event.memoryResolutions[0].choice, "keep_current");
    const currentText = await f.text(kept.data);
    const pending = await edit(
      currentText.replace("Node 24", "Node 26"),
      kept.data.event.revision,
    );
    unavailable = true;
    const failed = await f.api("/v2/sync/push", "POST", pending);
    assert.equal(failed.status, 503);
    assert.match(failed.data.error, /Memory consolidation pending/);
    assert.ok(!failed.data.error.includes("private provider"));
    const head = await f.pool.query(
      "select payload from orka.resources where project_id=$1 and id=$2",
      [f.project, initial.resource.resourceId],
    );
    assert.deepEqual(head.rows[0].payload, kept.data.event.resource);
    assert.equal(
      (
        await f.pool.query(
          "select 1 from orka.receipts where project_id=$1 and id=$2",
          [f.project, pending.id],
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await f.pool.query("select revision from orka.projects where id=$1", [
          f.project,
        ])
      ).rows[0].revision,
      String(kept.data.event.revision),
    );
    unavailable = false;
    choice = "accept_incoming";
    const retried = await f.api("/v2/sync/push", "POST", pending);
    assert.equal(retried.status, 200);
    assert.match(await f.text(retried.data), /Node 26/);
    const beforeAdds = calls;
    const full = await f.text(retried.data);
    const changes = await Promise.all([
      edit(full + "A note.\n", retried.data.event.revision),
      edit(full + "B note.\n", retried.data.event.revision),
    ]);
    const concurrent = await Promise.all(
      changes.map((c) => f.api("/v2/sync/push", "POST", c)),
    );
    assert.ok(concurrent.every((r) => r.status === 200));
    const newest = concurrent.sort(
      (a, b) => b.data.event.revision - a.data.event.revision,
    )[0];
    assert.match(await f.text(newest.data), /A note/);
    assert.match(await f.text(newest.data), /B note/);
    assert.equal(calls, beforeAdds);
    const feed = await f.api(
      `/v2/sync/pull?projectId=${f.project}&cursor=${first.data.event.revision}`,
    );
    assert.ok(
      feed.data.events.some(
        (e: Event) => e.memoryResolutions?.[0].choice === "keep_both",
      ),
    );
    assert.ok(
      feed.data.events.some(
        (e: Event) => e.memoryResolutions?.[0].choice === "keep_current",
      ),
    );
    const deleted = await f.api("/v2/sync/push", "POST", {
      ...initial,
      id: randomUUID(),
      baseRevision: newest.data.event.revision,
      resource: { ...initial.resource, deleted: true, files: [] },
    });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.data.event.resource.deleted, true);
    assert.equal(calls, beforeAdds);
  } finally {
    await f.close();
  }
});

await test(
  "live JEV and HTTP/PostgreSQL/blob consolidation using synthetic memory",
  { skip: process.env.ORKA_TEST_LIVE_JEV !== "true" },
  async () => {
    assert.ok(process.env.JEV_API_KEY || process.env.TYPESAFE_API_KEY);
    const f = await fixture(new JevMemoryResolver());
    try {
      for (const [name, baseText, currentText, incomingText, expected] of [
        [
          "runtime update",
          "Use Node 22.\n",
          "Use Node 22.\n",
          "Use Node 24.\n",
          "accept_incoming",
        ],
        [
          "complementary scope",
          "The legacy worker uses Node 22.\n",
          "The legacy worker uses Node 22.\n",
          "The new API service uses Node 24.\n",
          "keep_both",
        ],
        [
          "unsupported speculation",
          "Production runs on Node 24; verified by the production container.\n",
          "Production runs on Node 24; verified by the production container.\n",
          "Production may run on Node 18; this is an unverified guess.\n",
          "keep_current",
        ],
        [
          "qualified update",
          "Use PostgreSQL 16.\n",
          "Use PostgreSQL 16.\n",
          "Use PostgreSQL 17 for production; development may use PostgreSQL 16.\n",
          "accept_incoming",
        ],
      ] as const) {
        const initial = await f.change(baseText);
        const first = await f.api("/v2/sync/push", "POST", initial);
        assert.equal(first.status, 200);
        if (currentText !== baseText) {
          const current = await f.api("/v2/sync/push", "POST", {
            ...initial,
            id: randomUUID(),
            baseRevision: first.data.event.revision,
            resource: {
              ...initial.resource,
              files: [await f.file(currentText)],
            },
          });
          assert.equal(current.status, 200, name);
        }
        const update = {
          ...initial,
          id: randomUUID(),
          baseRevision: first.data.event.revision,
          resource: {
            ...initial.resource,
            files: [await f.file(incomingText)],
          },
        };
        const result = await f.api("/v2/sync/push", "POST", update);
        assert.equal(
          result.status,
          200,
          `${name}: ${JSON.stringify(result.data)}`,
        );
        assert.equal(
          result.data.event.memoryResolutions[0].choice,
          expected,
          name,
        );
        const expectedText =
          expected === "keep_both"
            ? currentText + incomingText
            : expected === "keep_current"
              ? currentText
              : incomingText;
        assert.equal(await f.text(result.data), expectedText, name);
        assert.deepEqual(
          (await f.api("/v2/sync/push", "POST", update)).data,
          result.data,
        );
        console.log(`Live JEV: ${name} → ${expected}`);
      }
    } finally {
      await f.close();
    }
  },
);
