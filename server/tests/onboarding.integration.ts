import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { Store } from "./bridge/store.js";
import { Blobs } from "./fixtures/blobs.js";
import { createApi } from "./bridge/main.js";
import { authSettings } from "./bridge/auth.js";
for (const mode of ["cloud", "self-hosted"])
  await test(`onboarding identity and remote keys are scoped in ${mode}`, async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const dir = await mkdtemp(join(tmpdir(), "orka-onboarding-"));
    const store = new Store(pool, new Blobs(dir));
    const owner = randomUUID(),
      member = randomUUID(),
      stranger = randomUUID();
    const server = createApi(
      store,
      async (token) => token,
      undefined,
      authSettings({
        DEPLOYMENT_MODE: mode,
        PASSWORD_ENABLED: mode === "cloud" ? "false" : "true",
      }),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const api = async <T = unknown>(
      user: string,
      path: string,
      method = "GET",
      input?: unknown,
    ) => {
      const r = await fetch(origin + path, {
        method,
        headers: {
          Authorization: `Bearer ${user}`,
          "Content-Type": "application/json",
          "X-Orka-Governance": "1",
        },
        body: input === undefined ? undefined : JSON.stringify(input),
      });
      return { status: r.status, value: (await r.json()) as T };
    };
    const projects: string[] = [];
    try {
      assert.equal(
        (await fetch(origin + "/v2/instance").then((r) => r.json())).onboarding,
        1,
      );
      const instance = (await fetch(origin + "/v2/instance").then((r) =>
        r.json(),
      )) as { mode: string; auth: { password: boolean } };
      assert.equal(instance.mode, mode);
      assert.equal(instance.auth.password, mode !== "cloud");
      assert.equal((await api(owner, "/v2/profile")).status, 404);
      assert.equal(
        (
          await api(owner, "/v2/profile", "PUT", {
            displayName: "GitHub name",
            avatarUrl: "https://avatars.githubusercontent.com/u/1",
            source: "github",
            ifAbsent: true,
          })
        ).status,
        200,
      );
      await api(owner, "/v2/profile", "PUT", {
        displayName: "Edited name",
        avatarUrl: null,
        source: "user",
        jobRole: "Designer",
        avatarData:
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
      });
      await api(owner, "/v2/profile", "PUT", {
        displayName: "Overwrite",
        source: "github",
        ifAbsent: true,
      });
      assert.equal(
        (await api<{ displayName: string }>(owner, "/v2/profile")).value
          .displayName,
        "Edited name",
      );
      assert.equal((await api(stranger, "/v2/profile")).status, 404);
      const detailed = await api<{
        jobRole: string;
        avatarData: string;
        role?: string;
      }>(owner, "/v2/profile");
      assert.equal(detailed.value.jobRole, "Designer");
      assert.ok(detailed.value.avatarData.startsWith("data:image/png;base64,"));
      assert.equal(detailed.value.role, undefined);
      // Clients predating job roles and uploads must preserve those fields.
      assert.equal(
        (
          await api(owner, "/v2/profile", "PUT", {
            displayName: "Edited name",
            avatarUrl: null,
            source: "user",
          })
        ).status,
        200,
      );
      const compatible = (
        await api<{ jobRole: string; avatarData: string }>(owner, "/v2/profile")
      ).value;
      assert.equal(compatible.jobRole, detailed.value.jobRole);
      assert.equal(compatible.avatarData, detailed.value.avatarData);
      // Two clients editing the same confirmed profile cannot overwrite each other.
      const baseline = (await api<{ revision: string }>(owner, "/v2/profile"))
        .value;
      const updates = await Promise.all(
        ["First edit", "Second edit"].map((displayName) =>
          api(owner, "/v2/profile", "PUT", {
            displayName,
            source: "user",
            expectedRevision: baseline.revision,
          }),
        ),
      );
      assert.deepEqual(
        updates.map((result) => result.status).sort(),
        [200, 409],
      );
      const current = (
        await api<{ revision: string; displayName: string }>(
          owner,
          "/v2/profile",
        )
      ).value;
      assert.notEqual(current.revision, baseline.revision);
      const rejected = await api(owner, "/v2/profile", "PUT", {
        displayName: "Unsafe overwrite",
        source: "user",
        expectedRevision: "' OR true; --",
      });
      assert.equal(rejected.status, 409);
      assert.equal(
        (await api<{ displayName: string }>(owner, "/v2/profile")).value
          .displayName,
        current.displayName,
      );
      assert.equal(
        (
          await api(owner, "/v2/profile", "PUT", {
            displayName: "Reviewed edit",
            source: "user",
            expectedRevision: current.revision,
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await api(owner, "/v2/profile", "PUT", {
            displayName: "Edited name",
            source: "user",
            role: "owner",
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await api(owner, "/v2/profile", "PUT", {
            displayName: "A",
            avatarUrl: "https://evil.test/x",
            source: "user",
          })
        ).status,
        400,
      );
      const requestId = randomUUID();
      const retried = await Promise.all([
        api<{ id: string }>(owner, "/v2/projects", "POST", {
          name: "Durable create",
          requestId,
        }),
        api<{ id: string }>(owner, "/v2/projects", "POST", {
          name: "Durable create",
          requestId,
        }),
      ]);
      assert.equal(retried[0].status, 200);
      assert.equal(retried[1].status, 200);
      assert.equal(retried[0].value.id, retried[1].value.id);
      projects.push(retried[0].value.id);
      assert.equal(
        (
          await api(owner, "/v2/projects", "POST", {
            name: "Changed after submission",
            requestId,
          })
        ).status,
        409,
      );
      const key = "a".repeat(64);
      const create = await api<{ id: string }>(owner, "/v2/projects", "POST", {
        name: "Remote fixture",
        remoteKey: key,
        governance: 1,
      });
      assert.equal(create.status, 200, JSON.stringify(create));
      projects.push(create.value.id);
      const id = create.value.id;
      await pool.query("insert into orka.members values($1,$2,'member')", [
        id,
        member,
      ]);
      assert.equal(
        (
          await api<{ id: string; remoteKey: string }[]>(owner, "/v2/projects")
        ).value.find((p) => p.id === id)?.remoteKey,
        key,
      );
      assert.equal(
        (
          await api<{ id: string; remoteKey: string }[]>(member, "/v2/projects")
        ).value.find((p) => p.id === id)?.remoteKey,
        key,
      );
      assert.equal(
        (await api<{ id: string }[]>(stranger, "/v2/projects")).value.some(
          (p) => p.id === id,
        ),
        false,
      );
      assert.equal(
        (
          await api(owner, "/v2/projects", "POST", {
            name: "Invalid",
            remoteKey: "bad",
          })
        ).status,
        400,
      );
      const legacy = await store.createProject(owner, "Legacy fixture");
      projects.push(legacy);
      await pool.query("insert into orka.members values($1,$2,'member')", [
        legacy,
        member,
      ]);
      const set = { action: "set-remote", projectId: legacy, remoteKey: key };
      assert.equal(
        (await api(member, "/v2/projects/action", "POST", set)).status,
        403,
      );
      assert.equal(
        (await api(stranger, "/v2/projects/action", "POST", set)).status,
        403,
      );
      assert.equal(
        (await api(owner, "/v2/projects/action", "POST", set)).status,
        200,
      );
      assert.equal(
        (await api(owner, "/v2/projects/action", "POST", set)).status,
        409,
      );
      const log = await pool.query(
        "select payload from orka.management_logs where project_id=$1 and payload->>'action'='project.remote_set'",
        [legacy],
      );
      assert.equal(log.rowCount, 1);
      assert.equal(log.rows[0].payload.actorName, "Reviewed edit");
      const catalog = await api<{
        members: { id: string; displayName: string }[];
      }>(owner, "/v2/governance/action", "POST", {
        action: "catalog",
        input: { projectId: id },
      });
      assert.equal(
        catalog.value.members.find((m) => m.id === owner)?.displayName,
        "Reviewed edit",
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.query("delete from orka.projects where id=any($1::uuid[])", [
        projects,
      ]);
      await pool.query("delete from orka.profiles where user_id=$1", [owner]);
      await pool.query("delete from orka.env_profiles where user_id=$1", [
        owner,
      ]);
      await pool.end();
      await rm(dir, { recursive: true, force: true });
    }
  });
