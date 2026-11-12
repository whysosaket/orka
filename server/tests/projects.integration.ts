import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { Store } from "./bridge/store.js";
import { Blobs, bytesHash } from "./fixtures/blobs.js";
import { createApi } from "./bridge/main.js";
import { identity, version } from "./fixtures/env-fixtures.js";
import { startEnvMac, type EnvMac } from "./fixtures/env-native.js";

await test("shared project names are owner-only, validated, revisioned, and retryable", async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const home = await mkdtemp(join(tmpdir(), "orka-project-names-"));
  const store = new Store(pool, new Blobs(home));
  const owner = randomUUID(),
    member = randomUUID(),
    outsider = randomUUID();
  const server = createApi(store, async (token) => token);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const api = async (path: string, input?: unknown, user = owner) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: input === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${user}`,
        "Content-Type": "application/json",
      },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    return { status: response.status, value: await response.json() };
  };
  try {
    const projectId = await store.createProject(owner, "Original name");
    const invite = await api("/v2/invites", { projectId });
    assert.equal(
      (await api("/v2/join", { token: invite.value.token }, member)).status,
      200,
    );
    const input = {
      requestId: randomUUID(),
      projectId,
      action: "rename",
      expectedRevision: 0,
      name: "  Shared name  ",
    };
    for (const user of [member, outsider])
      assert.equal((await api("/v2/projects/action", input, user)).status, 403);
    for (const name of ["", "   ", "x".repeat(101), null, 123])
      assert.equal(
        (await api("/v2/projects/action", { ...input, name })).status,
        400,
      );
    assert.equal(
      (await api("/v2/projects/action", { ...input, name: undefined })).status,
      400,
    );
    assert.equal(
      (await api("/v2/projects/action", { ...input, localName: "Private" }))
        .status,
      400,
    );
    assert.equal((await api("/v2/projects/capabilities")).value.rename, 1);
    const renamed = await api("/v2/projects/action", input);
    assert.equal(renamed.status, 200);
    assert.equal(renamed.value.name, "Shared name");
    assert.equal(renamed.value.lifecycleRevision, 1);
    assert.deepEqual(await api("/v2/projects/action", input), renamed);
    assert.equal(
      (await api("/v2/projects/action", { ...input, name: "Changed retry" }))
        .status,
      409,
    );
    assert.equal(
      (await api("/v2/projects/action", { ...input, requestId: randomUUID() }))
        .status,
      409,
    );
    for (const user of [owner, member]) {
      const project = (await api("/v2/projects", undefined, user)).value.find(
        (p: { id: string }) => p.id === projectId,
      );
      assert.equal(project.name, "Shared name");
      assert.equal(project.revision, 0);
      assert.equal(project.localName, undefined);
    }
    const concurrent = await Promise.all(
      ["Next name", "Other name"].map((name) =>
        api("/v2/projects/action", {
          ...input,
          requestId: randomUUID(),
          expectedRevision: 1,
          name,
        }),
      ),
    );
    assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 409]);
    assert.equal(
      (
        await api("/v2/projects/action", {
          requestId: randomUUID(),
          projectId,
          action: "archive",
          expectedRevision: 2,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await api("/v2/projects/action", {
          ...input,
          requestId: randomUUID(),
          expectedRevision: 3,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await api("/v2/projects?includeArchived=true", undefined, member)
      ).value.find((p: { id: string }) => p.id === projectId).lifecycleRevision,
      3,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
    await rm(home, { recursive: true, force: true });
  }
});

await test("project lifecycle: owner permissions, archive boundaries, restoration, durable retries, deletion and blob cleanup", async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const home = await mkdtemp(join(tmpdir(), "orka-projects-"));
  const blobs = new Blobs(join(home, "blobs"));
  const store = new Store(pool, blobs);
  const owner = identity(),
    member = randomUUID(),
    outsider = randomUUID();
  const server = createApi(store, async (token) => token);
  const macs: EnvMac[] = [];
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const api = async (
    path: string,
    method = "GET",
    input?: unknown,
    user = owner.device.owner,
  ) => {
    const r = await fetch(url + path, {
      method,
      headers: {
        Authorization: `Bearer ${user}`,
        "Content-Type": "application/json",
      },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    return { status: r.status, value: await r.json() };
  };
  const env = async (operation: string, input: unknown) => {
    const call = {
      format: 1,
      deviceId: owner.device.id,
      time: Date.now(),
      nonce: randomUUID(),
      operation,
      input,
    };
    return api("/v2/env/action", "POST", {
      call,
      signature: owner.signature(call),
    });
  };
  try {
    const project = await store.createProject(
      owner.device.owner,
      "Disposable project",
    );
    const other = await store.createProject(
      owner.device.owner,
      "Keep this project",
    );
    const invite = await api("/v2/invites", "POST", { projectId: project });
    assert.equal(
      (await api("/v2/join", "POST", { token: invite.value.token }, member))
        .status,
      200,
    );
    const unused = await api("/v2/invites", "POST", { projectId: project });
    const content = Buffer.from("shared project data");
    const hash = bytesHash(content);
    assert.equal(
      (await api(`/v2/blobs/${project}/${hash}`, "PUT", undefined)).status,
      400,
    );
    await blobs.put(project, content);
    await blobs.put(other, content);
    await pool.query("insert into orka.blobs values($1,$3,$4),($2,$3,$4)", [
      project,
      other,
      hash,
      content.length,
    ]);
    await store.device(owner.device.owner, owner.device.id, "Mac");
    const change = {
      version: 2,
      id: randomUUID(),
      projectId: project,
      deviceId: owner.device.id,
      baseRevision: 0,
      resource: {
        resourceId: randomUUID(),
        kind: "memory",
        source: "shared",
        logicalPath: "instructions/AGENTS.md",
        title: "Notes",
        files: [
          { path: "content.md", hash, size: content.length, executable: false },
        ],
        deleted: false,
      },
    };
    assert.equal((await api("/v2/sync/push", "POST", change)).status, 200);
    assert.equal((await env("enroll", owner.device)).status, 200);
    const first = version(owner, project);
    const publication = {
      requestId: randomUUID(),
      expectedRevision: 0,
      expectedAccessRevision: 0,
      version: first,
    };
    assert.equal((await env("mutate", publication)).status, 200);
    const scope = { projectId: project, setId: first.manifest.setId };
    const action = {
      requestId: randomUUID(),
      projectId: project,
      action: "archive",
      expectedRevision: 0,
    };
    for (const user of [member, outsider])
      assert.equal(
        (await api("/v2/projects/action", "POST", action, user)).status,
        403,
      );
    assert.equal((await api("/v2/projects/capabilities")).value.lifecycle, 1);
    assert.equal((await fetch(url + "/v2/projects/capabilities")).status, 401);

    if (process.env.ORKA_ENV_NATIVE_BIN) {
      const mac = await startEnvMac({
        home,
        name: "local",
        user: owner.device.owner,
        project,
        url,
        enable: false,
      });
      macs.push(mac);
      const run = (action: string, input: Record<string, unknown> = {}) =>
        mac.request({ action: "project", operation: action, input });
      await run("remove", { projectId: project });
      await run("list"); // Discovery must not undo removal.
      let snap = await mac.request<{
        projects: { id: string }[];
        managedProjects: { id: string; hidden: boolean; path: string | null }[];
      }>({ action: "snapshot" });
      assert.ok(!snap.projects.some((p) => p.id === project));
      const hidden = snap.managedProjects.find((p) => p.id === project)!;
      assert.equal(hidden.hidden, true);
      assert.equal(hidden.path, null);
      await run("show", { projectId: project });
      snap = await mac.request({ action: "snapshot" });
      assert.ok(snap.projects.some((p) => p.id === project));
    }

    const archived = await api("/v2/projects/action", "POST", action);
    assert.equal(archived.status, 200);
    assert.deepEqual(
      await api("/v2/projects/action", "POST", action),
      archived,
    );
    assert.equal(
      (
        await api("/v2/projects/action", "POST", {
          ...action,
          action: "restore",
        })
      ).status,
      409,
    );
    assert.ok(
      !(await api("/v2/projects")).value.some(
        (p: { id: string }) => p.id === project,
      ),
    );
    const catalog = (
      await api("/v2/projects?includeArchived=true", "GET", undefined, member)
    ).value;
    assert.ok(catalog.find((p: { id: string }) => p.id === project).archivedAt);
    assert.equal(
      (
        await api(
          "/v2/projects?includeArchived=true",
          "GET",
          undefined,
          outsider,
        )
      ).value.length,
      0,
    );
    for (const path of [
      `/v2/sync/pull?projectId=${project}`,
      `/v2/blobs/${project}/${hash}`,
    ])
      assert.equal((await api(path)).status, 403);
    assert.equal(
      (await api("/v2/sync/push", "POST", { ...change, id: randomUUID() }))
        .status,
      403,
    );
    assert.equal(
      (await api("/v2/invites", "POST", { projectId: project })).status,
      403,
    );
    assert.equal((await env("read", scope)).status, 403);
    assert.equal((await env("mutate", publication)).status, 403);
    assert.equal(
      (await api("/v2/join", "POST", { token: unused.value.token }, outsider))
        .status,
      400,
    );
    const restore = {
      ...action,
      requestId: randomUUID(),
      action: "restore",
      expectedRevision: 1,
    };
    assert.equal(
      (
        await api("/v2/projects/action", "POST", {
          ...restore,
          expectedRevision: 0,
        })
      ).status,
      409,
    );
    const simultaneous = await Promise.all([
      api("/v2/projects/action", "POST", restore),
      api("/v2/projects/action", "POST", {
        ...restore,
        requestId: randomUUID(),
      }),
    ]);
    assert.deepEqual(simultaneous.map((r) => r.status).sort(), [200, 409]);
    assert.equal((await env("read", scope)).status, 200);
    assert.equal((await api(`/v2/sync/pull?projectId=${project}`)).status, 200);
    assert.equal(
      (await api("/v2/join", "POST", { token: unused.value.token }, outsider))
        .status,
      400,
    );
    const deletion = {
      ...action,
      requestId: randomUUID(),
      action: "delete",
      expectedRevision: 2,
      confirmation: "Disposable project",
    };
    assert.equal(
      (
        await api("/v2/projects/action", "POST", {
          ...deletion,
          confirmation: "wrong",
        })
      ).status,
      400,
    );
    assert.equal(
      (await api("/v2/projects/action", "POST", deletion, member)).status,
      403,
    );
    const removeProject = blobs.removeProject.bind(blobs);
    let failCleanup = true;
    blobs.removeProject = async (id) => {
      if (failCleanup) {
        failCleanup = false;
        throw new Error("Simulated interrupted cleanup");
      }
      await removeProject(id);
    };
    const deleted = await api("/v2/projects/action", "POST", deletion);
    assert.equal(deleted.status, 200);
    assert.equal(
      (
        await pool.query(
          "select count(*) from orka.project_blob_cleanup where project_id=$1",
          [project],
        )
      ).rows[0].count,
      "1",
    );
    assert.deepEqual(
      await api("/v2/projects/action", "POST", deletion),
      deleted,
    );
    assert.equal((await env("read", scope)).status, 403);
    assert.equal((await api(`/v2/sync/pull?projectId=${project}`)).status, 403);
    for (const table of [
      "projects",
      "members",
      "resources",
      "snapshots",
      "events",
      "receipts",
      "env_sets",
      "env_headers",
      "env_receipts",
      "env_activity",
      "blobs",
      "project_blob_cleanup",
    ])
      assert.equal(
        Number(
          (
            await pool.query(
              `select count(*) from orka.${table} where ${table === "projects" ? "id" : "project_id"}=$1`,
              [project],
            )
          ).rows[0].count,
        ),
        0,
        table,
      );
    await assert.rejects(access(join(home, "blobs", project)));
    assert.deepEqual(await blobs.read(other, hash), content);
    if (macs[0]) {
      await macs[0].request({
        action: "project",
        operation: "list",
        input: {},
      });
      const snap = await macs[0].request<{ projects: { id: string }[] }>({
        action: "snapshot",
      });
      assert.ok(!snap.projects.some((p) => p.id === project));
    }
  } finally {
    await Promise.all(macs.map((m) => m.close()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
    await rm(home, { recursive: true, force: true });
  }
});
