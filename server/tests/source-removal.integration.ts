import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { change, type EnvVersion, type Resource } from "@portable/protocol";
import { Store } from "./bridge/store.js";
import { Blobs, bytesHash } from "./fixtures/blobs.js";
import { createApi } from "./bridge/main.js";
import { authSettings } from "./bridge/auth.js";
import { identity, version } from "./fixtures/env-fixtures.js";

for (const mode of ["cloud", "self-hosted"] as const)
  await test(`source removal preserves shared history and prevents reconnection (${mode})`, async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const directory = await mkdtemp(join(tmpdir(), "orka-source-removal-"));
    const store = new Store(pool, new Blobs(directory));
    const owner = randomUUID(),
      member = randomUUID(),
      outsider = randomUUID(),
      device = randomUUID();
    const server = createApi(store, async (token) => token, undefined, {
      ...authSettings({}),
      mode,
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const api = async (path: string, input?: unknown, user = owner) => {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
        method: input === undefined ? "GET" : "POST",
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
      const project = await store.createProject(owner, "Remove folders");
      const sources = [
        { id: randomUUID(), name: "desktop" },
        { id: randomUUID(), name: "backend" },
      ];
      await pool.query("insert into orka.members values($1,$2,'member')", [
        project,
        member,
      ]);
      assert.equal(
        (await api("/v2/projects/capabilities")).value.sourcesRemoval,
        1,
      );
      assert.equal(
        (await api("/v2/projects/sources", { projectId: project, sources }))
          .status,
        200,
      );
      await store.device(owner, device, "Mac");
      const content = Buffer.from("Keep shared instructions\n"),
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
      const first = upload(sources[0].id);
      assert.equal((await api("/v2/sync/push", first)).status, 200);
      const envAuthor = identity(owner);
      const envCall = (operation: string, input: unknown) => {
        const call = {
          format: 1,
          deviceId: envAuthor.device.id,
          time: Date.now(),
          nonce: randomUUID(),
          operation,
          input,
        };
        return api("/v2/env/action", {
          call,
          signature: envAuthor.signature(call),
        });
      };
      const envMutate = (
        next: EnvVersion,
        previous?: EnvVersion,
        requestId = randomUUID(),
      ) =>
        envCall("mutate", {
          requestId,
          expectedRevision: previous?.manifest.revision ?? 0,
          expectedAccessRevision: previous?.manifest.accessRevision ?? 0,
          version: next,
        });
      assert.equal((await envCall("enroll", envAuthor.device)).status, 200);
      const firstEnv = version(envAuthor, project, { sourceId: sources[0].id });
      const envRequestId = randomUUID();
      const envCreated = await envMutate(firstEnv, undefined, envRequestId);
      assert.equal(envCreated.status, 200);
      await pool.query(
        "insert into orka.source_repositories values($1,$2,$3,1)",
        [
          project,
          sources[0].id,
          {
            id: "4242",
            fullName: "fixtures/repository",
            cloneUrl: "https://github.com/fixtures/repository.git",
            private: true,
            defaultBranch: "main",
          },
        ],
      );
      await pool.query(
        "insert into orka.repository_access_requests(id,project_id,source_id,requester,github_id,github_login,repository_id,full_name,reason,status) values($1,$2,$3,$4,'101','fixture-owner','4242','fixtures/repository','Read source','requested')",
        [randomUUID(), project, sources[0].id, member],
      );
      const remove = { projectId: project, sourceId: sources[0].id };
      assert.equal(
        (await api("/v2/projects/sources/remove", remove, member)).status,
        403,
      );
      assert.equal(
        (await api("/v2/projects/sources/remove", remove, outsider)).status,
        403,
      );
      assert.equal(
        (
          await api("/v2/projects/sources/remove", {
            ...remove,
            sourceId: randomUUID(),
          })
        ).status,
        404,
      );
      const removed = await api("/v2/projects/sources/remove", remove);
      assert.equal(removed.status, 200);
      assert.equal(removed.value.sourceId, sources[0].id);
      assert.ok(removed.value.removedAt);
      assert.deepEqual(
        (await api("/v2/projects/sources/remove", remove)).value,
        removed.value,
      );
      const envReplay = await envMutate(firstEnv, undefined, envRequestId);
      assert.equal(envReplay.status, 200);
      assert.deepEqual(envReplay.value, envCreated.value);
      const catalog = (await api("/v2/projects", undefined, member)).value;
      const source = catalog
        .find((item: { id: string }) => item.id === project)
        .sources.find((item: { id: string }) => item.id === sources[0].id);
      assert.equal(source.name, "desktop");
      assert.ok(source.removedAt);
      assert.equal(source.repository, null);
      assert.equal(
        (
          await pool.query(
            "select status from orka.repository_access_requests where project_id=$1",
            [project],
          )
        ).rows[0].status,
        "canceled",
      );
      assert.equal(
        (
          await pool.query(
            "select repository from orka.source_repositories where project_id=$1 and source_id=$2",
            [project, sources[0].id],
          )
        ).rows[0].repository.id,
        undefined,
      );
      assert.equal(
        (
          await pool.query(
            "select count(*)::int as count from orka.resources where project_id=$1",
            [project],
          )
        ).rows[0].count,
        1,
      );
      assert.equal(
        (
          await pool.query(
            "select count(*)::int as count from orka.snapshots where project_id=$1",
            [project],
          )
        ).rows[0].count,
        1,
      );
      const pulled = await api(
        `/v2/sync/pull?projectId=${project}&cursor=0`,
        undefined,
        member,
      );
      assert.equal(pulled.status, 200);
      assert.equal(
        pulled.value.events.find(
          (event: { resource: Resource }) =>
            event.resource.resourceId === first.resource.resourceId,
        ).resource.sourceId,
        sources[0].id,
      );
      assert.equal(
        (
          await api("/v2/sync/push", {
            ...first,
            id: randomUUID(),
            baseRevision: 1,
          })
        ).status,
        409,
      );
      assert.equal(
        (await api("/v2/sync/push", upload(sources[0].id))).status,
        409,
      );
      assert.equal(
        (await envMutate(version(envAuthor, project, {}, firstEnv), firstEnv))
          .status,
        409,
      );
      assert.equal(
        (
          await envCall("read", {
            projectId: project,
            setId: firstEnv.manifest.setId,
          })
        ).status,
        200,
      );
      assert.equal((await api("/v2/sync/push", first)).status, 200);
      assert.equal(
        (await api("/v2/sync/push", upload(sources[1].id))).status,
        200,
      );
      assert.equal(
        (
          await api("/v2/projects/sources", {
            projectId: project,
            sources: [sources[0]],
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await api("/v2/projects/sources", {
            projectId: project,
            sources: [{ id: randomUUID(), name: "new desktop" }],
          })
        ).status,
        200,
      );
      const many = Array.from({ length: 98 }, (_, index) => ({
        id: randomUUID(),
        name: `folder ${index}`,
      }));
      assert.equal(
        (
          await api("/v2/projects/sources", {
            projectId: project,
            sources: many,
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await api("/v2/projects/sources", {
            projectId: project,
            sources: [{ id: randomUUID(), name: "too many" }],
          })
        ).status,
        400,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
      await rm(directory, { recursive: true, force: true });
    }
  });
