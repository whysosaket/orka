import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { change, type Resource } from "@portable/protocol";
import { Store } from "./bridge/store.js";
import { Blobs, bytesHash } from "./reference/blobs.js";
import { createApi } from "./bridge/main.js";
import { execFileSync } from "node:child_process";

await test("project sources preserve independent same-path resources, ownership, retries and pull scope", async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const directory = await mkdtemp(join(tmpdir(), "orka-sources-"));
  const store = new Store(pool, new Blobs(directory));
  const owner = randomUUID(),
    member = randomUUID(),
    outsider = randomUUID(),
    device = randomUUID();
  const server = createApi(store, async (token) => token);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const api = async (
    path: string,
    method = "GET",
    input?: unknown,
    user = owner,
  ) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${user}`,
        "Content-Type": "application/json",
        "X-Orka-Governance": "1",
      },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    return { status: response.status, value: await response.json() };
  };
  try {
    const project = await store.createProject(owner, "Multi repo");
    const other = await store.createProject(owner, "Other project");
    await pool.query("insert into orka.members values($1,$2,'member')", [
      project,
      member,
    ]);
    const sources = [
      { id: randomUUID(), name: "desktop" },
      { id: randomUUID(), name: "backend" },
    ];
    const request = { projectId: project, sources };
    assert.equal(
      (await api("/v2/projects/sources", "POST", request, member)).status,
      403,
    );
    assert.equal(
      (await api("/v2/projects/sources", "POST", request, outsider)).status,
      403,
    );
    assert.equal(
      (await api("/v2/projects/sources", "POST", request)).status,
      200,
    );
    assert.equal(
      (await api("/v2/projects/sources", "POST", request)).status,
      200,
    );
    assert.equal(
      (
        await api("/v2/projects/sources", "POST", {
          ...request,
          sources: [{ ...sources[0], name: "renamed" }],
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await api("/v2/projects/sources", "POST", {
          ...request,
          sources: [{ ...sources[0], path: "/private/path" }],
        })
      ).status,
      400,
    );
    const catalog = await api("/v2/projects", "GET", undefined, member);
    assert.deepEqual(
      catalog.value
        .find((item: { id: string }) => item.id === project)
        .sources.map((source: { name: string }) => source.name),
      ["backend", "desktop"],
    );
    await store.device(owner, device, "Mac");
    const content = Buffer.from("Repository instructions\n"),
      hash = bytesHash(content);
    await store.blobs.put(project, content);
    await pool.query("insert into orka.blobs values($1,$2,$3)", [
      project,
      hash,
      content.length,
    ]);
    const upload = (sourceId: string) =>
      change.parse({
        version: 2,
        id: randomUUID(),
        projectId: project,
        deviceId: device,
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
              size: content.length,
              executable: false,
            },
          ],
          deleted: false,
        },
      });
    const first = upload(sources[0].id),
      second = upload(sources[1].id);
    assert.equal((await api("/v2/sync/push", "POST", first)).status, 200);
    assert.equal((await api("/v2/sync/push", "POST", second)).status, 200);
    assert.equal((await api("/v2/sync/push", "POST", first)).status, 200);
    assert.equal(
      (await api("/v2/sync/push", "POST", upload(sources[0].id))).status,
      409,
    );
    assert.equal(
      (
        await api("/v2/sync/push", "POST", {
          ...upload(randomUUID()),
          projectId: other,
        })
      ).status,
      400,
    );
    const pulled = await api(`/v2/sync/pull?projectId=${project}&cursor=0`);
    assert.equal(pulled.status, 200);
    assert.deepEqual(
      new Set(
        pulled.value.events.map(
          (event: { resource: Resource }) => event.resource.sourceId,
        ),
      ),
      new Set(sources.map((source) => source.id)),
    );
    const current = pulled.value.events.find(
      (event: { resource: Resource }) =>
        event.resource.resourceId === first.resource.resourceId,
    ).resource;
    assert.equal(
      (
        await api("/v2/sync/push", "POST", {
          ...first,
          id: randomUUID(),
          baseRevision: current.revision,
          resource: { ...first.resource, sourceId: sources[1].id },
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await api(
          `/v2/sync/pull?projectId=${project}&cursor=0`,
          "GET",
          undefined,
          outsider,
        )
      ).status,
      403,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("explicit source data migration is dry-run by default, preserves resource identity and is repeatable", async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const directory = await mkdtemp(join(tmpdir(), "orka-source-migration-"));
  const store = new Store(pool, new Blobs(directory));
  const user = randomUUID(),
    device = randomUUID();
  try {
    const project = await store.createProject(user, "Legacy migration");
    await store.device(user, device, "Mac");
    await pool.query("update orka.projects set source_model=0 where id=$1", [
      project,
    ]);
    const content = Buffer.from("Preserved instructions\n"),
      hash = bytesHash(content);
    await store.blobs.put(project, content);
    await pool.query("insert into orka.blobs values($1,$2,$3)", [
      project,
      hash,
      content.length,
    ]);
    const request = change.parse({
      version: 2,
      id: randomUUID(),
      projectId: project,
      deviceId: device,
      baseRevision: 0,
      resource: {
        resourceId: randomUUID(),
        kind: "memory",
        source: "shared",
        logicalPath: "instructions/AGENTS.md",
        title: "Instructions",
        files: [
          { path: "content.md", hash, size: content.length, executable: false },
        ],
        deleted: false,
      },
    });
    const receipt = await store.mutate(user, request);
    const run = (apply = false) =>
      execFileSync(
        process.env.ORKA_GO_SERVER_BIN ?? "artifacts/bin/orka-server",
        ["migrate-sources", ...(apply ? ["--apply"] : [])],
        { encoding: "utf8" },
      );
    assert.match(run(), /Dry run/);
    assert.equal(
      (
        await pool.query(
          "select count(*)::int as count from orka.project_sources where project_id=$1",
          [project],
        )
      ).rows[0].count,
      0,
    );
    run(true);
    const row = (
      await pool.query(
        "select payload from orka.resources where project_id=$1",
        [project],
      )
    ).rows[0].payload as Resource;
    assert.equal(row.resourceId, request.resource.resourceId);
    assert.equal(row.sourceId, project);
    assert.equal(row.revision, receipt.event.resource.revision);
    assert.equal(
      (await store.mutate(user, request)).event.resource.sourceId,
      project,
    );
    assert.equal(
      (
        await pool.query(
          "select payload->>'sourceId' as source from orka.snapshots where project_id=$1",
          [project],
        )
      ).rows[0].source,
      project,
    );
    assert.equal(
      (
        await pool.query(
          "select payload->'resource'->>'sourceId' as source from orka.events where project_id=$1",
          [project],
        )
      ).rows[0].source,
      project,
    );
    assert.match(run(true), /^0 projects/);
  } finally {
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  }
});
