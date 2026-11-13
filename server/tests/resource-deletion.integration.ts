import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import type { Change, ResourceInput } from "@portable/protocol";
import { Store, HttpError } from "./bridge/store.js";
import { createApi } from "./bridge/main.js";
import { authSettings } from "./bridge/auth.js";
import { Blobs } from "./fixtures/blobs.js";
import { acceptingMemoryResolver } from "./fixtures/memory-fixtures.js";

for (const mode of ["cloud", "self-hosted"]) {
  await test(`${mode} reviewed deletion protects newer resources and preserves authorization and retry identity`, async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const directory = await mkdtemp(join(tmpdir(), "orka-reviewed-delete-"));
    const store = new Store(
      pool,
      new Blobs(directory),
      acceptingMemoryResolver(),
    );
    const owner = randomUUID(),
      member = randomUUID(),
      admin = randomUUID(),
      outsider = randomUUID();
    const users = new Set<string>([owner, member, admin, outsider]);
    const server = createApi(
      store,
      async (token) => {
        if (!users.has(token)) throw new HttpError(401, "Sign in required");
        return token;
      },
      undefined,
      authSettings({ DEPLOYMENT_MODE: mode }),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const projects: string[] = [];
    const api = async (path: string, input?: unknown, user = owner) => {
      const response = await fetch(origin + path, {
        method: input === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${user}`,
          "Content-Type": "application/json",
          "X-Orka-Governance": "1",
        },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      });
      return { status: response.status, value: await response.json() };
    };
    const file = async (projectId: string, content: string, path: string) => {
      const bytes = Buffer.from(content),
        hash = await store.blobs.put(projectId, bytes);
      await pool.query(
        "insert into orka.blobs values($1,$2,$3) on conflict do nothing",
        [projectId, hash, bytes.length],
      );
      await pool.query(
        "insert into orka.blob_uploads values($1,$2,$3) on conflict do nothing",
        [projectId, hash, owner],
      );
      return { path, hash, size: bytes.length, executable: false };
    };
    try {
      for (const user of [owner, member, admin])
        await store.device(user, user, "Deletion fixture Mac");
      for (const scenario of [
        { name: "legacy", governed: false, roles: false },
        { name: "governed", governed: true, roles: false },
        { name: "role policies", governed: true, roles: true },
      ]) {
        const projectId = await store.createProject(
          owner,
          `${mode} ${scenario.name}`,
          scenario.governed,
          undefined,
          undefined,
          scenario.roles,
        );
        projects.push(projectId);
        await pool.query(
          "insert into orka.members values($1,$2,'member'),($1,$3,'admin')",
          [projectId, member, admin],
        );
        for (const kind of ["memory", "skill", "plan"] as const) {
          const resourceId = randomUUID();
          const path = kind === "skill" ? "SKILL.md" : "content.md";
          const resource: ResourceInput = {
            resourceId,
            kind,
            source: kind === "plan" ? "codex" : "shared",
            logicalPath:
              kind === "plan"
                ? `codex/files/${resourceId}.md`
                : kind === "memory"
                  ? `knowledge/${resourceId}.md`
                  : `skill-${resourceId}`,
            title: `Reviewed ${kind}`,
            files: [await file(projectId, "# Original\n", path)],
            deleted: false,
            ...(kind === "memory"
              ? {
                  memory: {
                    topic: resourceId,
                    scope: "",
                    provider: "manual",
                    supersedes: [],
                  },
                }
              : {}),
          };
          const initial: Change = {
            version: 2,
            id: randomUUID(),
            projectId,
            deviceId: owner,
            baseRevision: 0,
            resource,
          };
          const created = await api("/v2/sync/push", initial);
          assert.equal(created.status, 200, JSON.stringify(created.value));
          const reviewedRevision = created.value.event.resource.revision;
          const updated = await api("/v2/sync/push", {
            ...initial,
            id: randomUUID(),
            baseRevision: reviewedRevision,
            resource: {
              ...resource,
              files: [
                await file(
                  projectId,
                  "# Original\nNew work after the deletion preview.\n",
                  path,
                ),
              ],
            },
          });
          assert.equal(updated.status, 200, JSON.stringify(updated.value));
          const current = updated.value.event.resource;
          const stale: Change = {
            ...initial,
            id: randomUUID(),
            baseRevision: reviewedRevision,
            resource: { ...resource, files: [], deleted: true },
          };
          assert.equal(
            (await api("/v2/sync/push", stale, outsider)).status,
            403,
          );
          const rejected = await api("/v2/sync/push", stale);
          assert.equal(
            rejected.status,
            409,
            `${scenario.name} ${kind}: ${JSON.stringify(rejected.value)}`,
          );
          assert.match(
            rejected.value.error,
            /refresh and review the exact version/,
          );
          const persisted = await pool.query(
            "select payload from orka.resources where project_id=$1 and id=$2",
            [projectId, resourceId],
          );
          assert.equal(persisted.rows[0].payload.revision, current.revision);
          assert.equal(persisted.rows[0].payload.deleted, false);
          assert.deepEqual(persisted.rows[0].payload.files, current.files);
          assert.equal(
            (
              await pool.query(
                "select revision from orka.projects where id=$1",
                [projectId],
              )
            ).rows[0].revision,
            String(current.revision),
          );
          assert.equal(
            (
              await pool.query(
                "select count(*) from orka.receipts where project_id=$1 and id=$2",
                [projectId, stale.id],
              )
            ).rows[0].count,
            "0",
          );
          const author = scenario.roles ? admin : owner;
          const deletion: Change = {
            ...stale,
            id: randomUUID(),
            deviceId: author,
            baseRevision: current.revision,
          };
          if (scenario.roles)
            assert.equal(
              (
                await api(
                  "/v2/sync/push",
                  { ...deletion, id: randomUUID(), deviceId: member },
                  member,
                )
              ).status,
              403,
            );
          const [first, retry] = await Promise.all([
            api("/v2/sync/push", deletion, author),
            api("/v2/sync/push", deletion, author),
          ]);
          assert.equal(first.status, 200, JSON.stringify(first.value));
          assert.deepEqual(retry, first);
          assert.equal(first.value.event.resource.deleted, true);
          assert.deepEqual(first.value.event.resource.files, []);
          assert.equal(
            first.value.event.resource.revision,
            current.revision + 1,
          );
          assert.equal(
            (
              await pool.query(
                "select count(*) from orka.receipts where project_id=$1 and id=$2",
                [projectId, deletion.id],
              )
            ).rows[0].count,
            "1",
          );
          assert.equal(
            (
              await api(
                "/v2/sync/push",
                {
                  ...deletion,
                  resource: { ...deletion.resource, title: "Changed retry" },
                },
                author,
              )
            ).status,
            409,
          );
        }
      }
      assert.equal(
        (await api("/v2/projects/capabilities")).value.resourceDeletion,
        1,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const id of projects)
        await pool.query("delete from orka.projects where id=$1", [id]);
      await pool.end();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
