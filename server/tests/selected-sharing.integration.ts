import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import type { Change, ResourceInput } from "@portable/protocol";
import { Store, HttpError } from "../packages/server-core/src/store.js";
import { createApi } from "../packages/server-core/src/main.js";
import { authSettings } from "../packages/server-core/src/auth.js";
import { Blobs } from "../packages/server-core/src/blobs.js";
import { acceptingMemoryResolver } from "../packages/server-core/src/testing/memory-fixtures.js";

for (const mode of ["cloud", "self-hosted"]) {
  await test(`${mode} selected sharing preserves permissions, snapshots, reviews and retry identity`, async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const directory = await mkdtemp(join(tmpdir(), "orka-selected-sharing-"));
    const store = new Store(
      pool,
      new Blobs(directory),
      acceptingMemoryResolver(),
    );
    const owner = randomUUID(),
      member = randomUUID(),
      outsider = randomUUID();
    const users = new Set<string>([owner, member, outsider]);
    const server = createApi(
      store,
      async (token) => {
        if (!users.has(token))
          throw new HttpError(401, "Invalid native credentials");
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
    const projectId = await store.createProject(
      owner,
      "Selected snapshots",
      true,
    );
    await pool.query("insert into orka.members values($1,$2,'member')", [
      projectId,
      member,
    ]);
    await store.device(owner, owner, "Owner Mac");
    await store.device(member, member, "Member Mac");
    const post = async (
      input: unknown,
      user: string = owner,
      governance = true,
    ) => {
      const response = await fetch(origin + "/v2/sharing/selected", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${user}`,
          "Content-Type": "application/json",
          ...(governance ? { "X-Orka-Governance": "1" } : {}),
        },
        body: JSON.stringify(input),
      });
      return { status: response.status, value: await response.json() };
    };
    const file = async (text: string, path: string, user = owner) => {
      const bytes = Buffer.from(text),
        hash = await store.blobs.put(projectId, bytes);
      await pool.query(
        "insert into orka.blobs values($1,$2,$3) on conflict do nothing",
        [projectId, hash, bytes.length],
      );
      await pool.query(
        "insert into orka.blob_uploads values($1,$2,$3) on conflict do nothing",
        [projectId, hash, user],
      );
      return { path, hash, size: bytes.length, executable: false };
    };
    try {
      const capabilities = await fetch(origin + "/v2/projects/capabilities", {
        headers: { Authorization: `Bearer ${owner}` },
      });
      assert.equal((await capabilities.json()).selectedSharing, 1);
      let publishedSkill: Change | undefined;
      let skillRevision = 0;
      for (const kind of ["memory", "skill", "plan", "session"] as const) {
        const resourceId = randomUUID();
        const text =
          kind === "session"
            ? JSON.stringify({
                type: "user",
                sessionId: resourceId,
                cwd: "/fixture",
                message: { role: "user", content: "Only this snapshot" },
              }) + "\n"
            : "# Only this selected snapshot";
        const resource: ResourceInput = {
          resourceId,
          kind,
          source: kind === "plan" || kind === "session" ? "codex" : "shared",
          logicalPath:
            kind === "plan"
              ? `codex/files/${resourceId}.md`
              : kind === "session"
                ? `codex/${resourceId}`
                : kind === "memory"
                  ? `knowledge/${resourceId}.md`
                  : `selected-${resourceId}`,
          title: `Selected ${kind}`,
          deleted: false,
          files: [
            await file(
              text,
              kind === "skill"
                ? "SKILL.md"
                : kind === "session"
                  ? "session.jsonl"
                  : "content.md",
            ),
          ],
          ...(kind === "memory"
            ? {
                memory: {
                  topic: `Selected ${resourceId}`,
                  scope: "",
                  provider: "manual",
                  supersedes: [],
                },
              }
            : {}),
        };
        const input: Change = {
          version: 2,
          id: randomUUID(),
          projectId,
          deviceId: owner,
          baseRevision: 0,
          resource,
        };
        const first = await post(input);
        assert.equal(first.status, 200, JSON.stringify(first.value));
        assert.equal(first.value.status, "published");
        assert.deepEqual(
          first.value.receipt.event.resource.files,
          resource.files,
        );
        const retry = await post(input);
        assert.equal(retry.status, 200);
        assert.deepEqual(retry.value, first.value);
        assert.equal(
          (
            await post({
              ...input,
              resource: { ...resource, title: "Different retry" },
            })
          ).status,
          409,
        );
        assert.equal(
          (
            await post(
              { ...input, id: randomUUID(), deviceId: outsider },
              outsider,
            )
          ).status,
          403,
        );
        assert.equal(
          (await post({ ...input, id: randomUUID() }, "read-only-mcp-token"))
            .status,
          401,
        );
        assert.equal(
          (await post({ ...input, id: randomUUID() }, owner, false)).status,
          409,
        );
        if (kind === "skill") {
          publishedSkill = input;
          skillRevision = first.value.receipt.event.resource.revision;
        }
        if (kind === "session") {
          const stale = {
            ...input,
            id: randomUUID(),
            resource: {
              ...resource,
              files: [
                await file(
                  text.replace("Only this snapshot", "Concurrent snapshot"),
                  "session.jsonl",
                ),
              ],
            },
          };
          const conflict = await post(stale);
          assert.equal(conflict.status, 200, JSON.stringify(conflict.value));
          assert.equal(conflict.value.status, "conflict");
          assert.equal(conflict.value.receipt.conflict, true);
          assert.deepEqual(
            conflict.value.receipt.event.resource.files,
            resource.files,
          );
          assert.deepEqual(
            conflict.value.receipt.event.conflicts[0].candidate.files,
            stale.resource.files,
          );
        }
      }
      assert.ok(publishedSkill);
      await pool.query("insert into orka.resource_access values($1,$2,$3,$4)", [
        projectId,
        publishedSkill.resource.resourceId,
        member,
        { mode: "suggest", canShare: false },
      ]);
      const suggestion: Change = {
        ...publishedSkill,
        id: randomUUID(),
        deviceId: member,
        baseRevision: skillRevision,
        resource: {
          ...publishedSkill.resource,
          files: [await file("# Requested skill update", "SKILL.md", member)],
        },
      };
      const proposed = await post(suggestion, member);
      assert.equal(proposed.status, 200, JSON.stringify(proposed.value));
      assert.equal(proposed.value.status, "approval_required");
      assert.equal(
        proposed.value.request.resourceId,
        suggestion.resource.resourceId,
      );
      assert.equal(proposed.value.request.status, "pending");
      assert.deepEqual((await post(suggestion, member)).value, proposed.value);
      await pool.query(
        "delete from orka.members where project_id=$1 and user_id=$2",
        [projectId, member],
      );
      assert.equal((await post(suggestion, member)).status, 403);
      assert.equal(
        (
          await post({
            ...publishedSkill,
            id: randomUUID(),
            resource: { ...publishedSkill.resource, deleted: true },
          })
        ).status,
        400,
      );
      const secret = await file("SECRET=excluded", ".env");
      assert.equal(
        (
          await post({
            ...publishedSkill,
            id: randomUUID(),
            resource: { ...publishedSkill.resource, files: [secret] },
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
}
