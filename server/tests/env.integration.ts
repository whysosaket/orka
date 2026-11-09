import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import type { EnvVersion } from "@portable/protocol";
import { createApi } from "./bridge/main.js";
import { Store } from "./bridge/store.js";
import { Blobs } from "./reference/blobs.js";
import { migrate } from "./bridge/migrations.js";
import {
  identity,
  version,
  headerHash,
} from "./reference/testing/env-fixtures.js";
import { startEnvMac, type EnvMac } from "./reference/testing/env-native.js";
import { readFile, readdir, writeFile } from "node:fs/promises";
import type { EnvManifest, EnvSet } from "@portable/protocol";

await test("encrypted ENV exchange: device proof, grants, approval, concurrency, revocation, deletion and storage isolation", async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const directory = await mkdtemp(join(tmpdir(), "orka-env-"));
  const store = new Store(pool, new Blobs(directory));
  const a = identity(),
    b = identity(),
    otherMac = identity(b.device.owner),
    outsider = identity(),
    unselected = identity();
  const server = createApi(store, async (token) => token);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const call = async (
    who: ReturnType<typeof identity>,
    operation: string,
    input: unknown,
    override: Record<string, unknown> = {},
  ) => {
    const payload = {
      format: 1,
      deviceId: who.device.id,
      time: Date.now(),
      nonce: randomUUID(),
      operation,
      input,
      ...override,
    };
    const result = await fetch(url + "/v2/env/action", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${who.device.owner}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        call: payload,
        signature: who.signature(payload),
      }),
    });
    return { status: result.status, value: await result.json() };
  };
  const mutate = (
    who: ReturnType<typeof identity>,
    v: EnvVersion,
    old?: EnvVersion,
    requestId = randomUUID(),
  ) =>
    call(who, "mutate", {
      requestId,
      expectedRevision: old?.manifest.revision ?? 0,
      expectedAccessRevision: old?.manifest.accessRevision ?? 0,
      version: v,
    });
  try {
    await migrate(pool); // Re-running migrations must preserve existing schema and data.
    const project = await store.createProject(a.device.owner, "ENV project");
    const project2 = await store.createProject(a.device.owner, "Other project");
    await pool.query(
      "insert into orka.members values($1,$2,'member'),($1,$3,'member')",
      [project, b.device.owner, unselected.device.owner],
    );
    for (const who of [a, b, otherMac, outsider, unselected])
      assert.equal((await call(who, "enroll", who.device)).status, 200);
    assert.equal(
      (
        await call(a, "enroll", {
          ...a.device,
          signingKey: b.device.signingKey,
        })
      ).status,
      403,
    );
    assert.equal(
      (await call(outsider, "directory", { projectId: project })).status,
      403,
    );
    assert.equal(
      (await call(a, "directory", { projectId: project })).value.members.length,
      3,
    );
    assert.equal(
      (await call(a, "list", { projectId: project }, { time: 0 })).status,
      400,
    );
    assert.equal(
      (
        await call(
          otherMac,
          "list",
          { projectId: project },
          { deviceId: b.device.id },
        )
      ).status,
      403,
    );
    const first = version(a, project, {
      grants: [a.device.owner, b.device.owner],
    });
    const requestId = randomUUID();
    const created = await mutate(a, first, undefined, requestId);
    assert.equal(created.status, 200);
    assert.deepEqual(
      (await mutate(a, first, undefined, requestId)).value,
      created.value,
    );
    assert.equal(
      (await mutate(a, version(a, project), undefined, requestId)).status,
      409,
    );
    const scope = { projectId: project, setId: first.manifest.setId };
    assert.equal(
      (await call(b, "list", { projectId: project })).value.sets[0].approved,
      false,
    );
    assert.equal(
      (await call(unselected, "list", { projectId: project })).value.sets
        .length,
      0,
    );
    for (const who of [b, unselected, outsider])
      assert.equal((await call(who, "read", scope)).status, 403);
    const req = {
      format: 1 as const,
      ...scope,
      device: b.device,
      nonce: randomUUID(),
      expiresAt: Date.now() + 600_000,
    };
    const approval = { request: req, signature: b.signature(req) };
    const approved = version(
      a,
      project,
      { devices: [a.device, b.device], approvals: [approval] },
      first,
    );
    const forged = structuredClone(approved);
    forged.manifest.approvals[0].signature = a.signature(req);
    forged.signature = a.signature(forged.manifest);
    assert.equal((await mutate(a, forged, first)).status, 403);
    assert.equal((await mutate(a, approved, first)).status, 200);
    const read = await call(b, "read", scope);
    assert.equal(read.status, 200);
    assert.equal(read.value.chain.length, 2);
    assert.equal(read.value.version.ciphertext, approved.ciphertext);
    assert.equal(
      (await call(b, "read", { ...scope, projectId: project2 })).status,
      403,
    );
    assert.equal((await call(otherMac, "read", scope)).status, 403);
    assert.equal(
      (
        await mutate(
          b,
          version(b, project, { deleted: true }, approved),
          approved,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await mutate(
          b,
          version(
            b,
            project,
            {
              grants: [a.device.owner, b.device.owner, unselected.device.owner],
            },
            approved,
          ),
          approved,
        )
      ).status,
      403,
    );
    const nextA = version(a, project, {}, approved),
      nextB = version(b, project, {}, approved);
    const raced = await Promise.all([
      mutate(a, nextA, approved),
      mutate(b, nextB, approved),
    ]);
    assert.deepEqual(raced.map((r) => r.status).sort(), [200, 409]);
    const current = raced[0].status === 200 ? nextA : nextB;
    const revoked = version(
      a,
      project,
      { grants: [a.device.owner], devices: [a.device], approvals: [] },
      current,
    );
    assert.equal((await mutate(a, revoked, current)).status, 200);
    assert.equal((await call(b, "read", scope)).status, 403);
    assert.equal(
      (await mutate(b, version(b, project, {}, current), current)).status,
      403,
    );
    assert.equal(
      (await call(b, "list", { projectId: project })).value.sets.length,
      0,
    );
    const raw = await pool.query(
      "select ciphertext,header from orka.env_sets where project_id=$1",
      [project],
    );
    assert.equal(raw.rows[0].ciphertext, revoked.ciphertext);
    assert.equal(
      headerHash(raw.rows[0].header),
      headerHash({ manifest: revoked.manifest, signature: revoked.signature }),
    );
    for (const table of ["resources", "events", "blobs", "snapshots"])
      assert.equal(
        (
          await pool.query(
            `select count(*)::int as count from orka.${table} where project_id=$1`,
            [project],
          )
        ).rows[0].count,
        0,
      );
    const headers = await pool.query(
      "select header from orka.env_headers where project_id=$1",
      [project],
    );
    assert.ok(
      headers.rows.every((r) => !JSON.stringify(r).includes('"ciphertext":')),
    );
    assert.ok(!JSON.stringify(raw.rows).includes("CANARY"));
    const deleted = version(a, project, { deleted: true }, revoked);
    assert.equal((await mutate(a, deleted, revoked)).status, 200);
    assert.equal((await call(a, "read", scope)).status, 403);
    assert.equal(
      (await call(a, "list", { projectId: project })).value.sets.length,
      0,
    );
    assert.equal(
      (
        await pool.query(
          "select ciphertext from orka.env_sets where project_id=$1",
          [project],
        )
      ).rows[0].ciphertext,
      "",
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  }
});

await test(
  "native ENV commands exchange real age ciphertext across three isolated Macs",
  { skip: !process.env.ORKA_ENV_NATIVE_BIN, timeout: 90_000 },
  async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const home = await mkdtemp(join(tmpdir(), "orka-env-native-"));
    const store = new Store(pool, new Blobs(join(home, "cloud-blobs")));
    const server = createApi(store, async (token) => token);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}`;
    const owner = randomUUID(),
      member = randomUUID(),
      project = await store.createProject(owner, "Native encrypted ENV flow");
    await pool.query("insert into orka.members values($1,$2,'member')", [
      project,
      member,
    ]);
    const processes: EnvMac[] = [];
    async function mac(name: string, user: string) {
      const client = await startEnvMac({ home, name, user, url, project });
      processes.push(client);
      return client;
    }
    interface Draft {
      draftId: string;
      setId: string;
      keys: string[];
      revision: number;
      manifest: EnvManifest;
    }
    interface List {
      sets: (EnvSet & { trusted: boolean })[];
      pending: { id: string }[];
    }
    const canary = "CANARY_NATIVE_ENCRYPTED_" + randomUUID();
    try {
      const a = await mac("mac-a", owner),
        b = await mac("mac-b", member),
        c = await mac("mac-b-new", member);
      const privateSharing = {
        memory: false,
        skill: false,
        session: false,
        plan: false,
        env: false,
      };
      const selectedSharing = { ...privateSharing, memory: true, plan: true };
      const added = await a.request<{ id: string }>({
        action: "cloud",
        operation: "create",
        input: { name: "Selected sharing", sharing: selectedSharing },
      });
      const privateProject = await a.request<{ id: string }>({
        action: "cloud",
        operation: "create",
        input: { name: "Private by default" },
      });
      await a.request({ action: "project", operation: "list", input: {} });
      const snapshot = await a.request<{
        projects: { id: string; sharing: typeof privateSharing }[];
      }>({ action: "snapshot" });
      assert.deepEqual(
        snapshot.projects.find((p) => p.id === added.id)?.sharing,
        selectedSharing,
      );
      assert.deepEqual(
        snapshot.projects.find((p) => p.id === privateProject.id)?.sharing,
        privateSharing,
      );
      await assert.rejects(
        a.request({
          action: "cloud",
          operation: "create",
          input: { name: "Invalid choices", sharing: { memory: "true" } },
        }),
        /Invalid project sharing choices/,
      );
      const draft = await a.env<Draft>("import", {
        projectId: project,
        text: `API_KEY=${canary}\nURL=https://example.test\nOMIT=NOT_SHARED_CANARY\n`,
      });
      assert.deepEqual(draft.keys, ["API_KEY", "URL", "OMIT"]);
      assert.ok(!JSON.stringify(draft).includes(canary));
      const created = await a.env<{ setId: string }>("publish", {
        draftId: draft.draftId,
        name: "Development",
        grants: [owner, member],
        keys: ["API_KEY", "URL"],
      });
      const scope = { projectId: project, setId: created.setId };
      assert.equal(
        (await a.env<List>("list", { projectId: project })).sets[0].trusted,
        true,
      );
      assert.equal(
        (await b.env<List>("list", { projectId: project })).sets[0].approved,
        false,
      );
      await assert.rejects(b.env("pull", scope));
      const request = await b.env<{ code: string }>("request", scope);
      const info = await a.env<{ device: { owner: string } }>("approval_info", {
        code: request.code,
      });
      assert.equal(info.device.owner, member);
      const approved = await a.env<{ approvalCode: string }>("approve", {
        code: request.code,
      });
      const awaitingResponse = (
        await b.env<List>("list", { projectId: project })
      ).sets[0];
      assert.equal(awaitingResponse.approved, true);
      assert.equal(awaitingResponse.trusted, false);
      await assert.rejects(b.env("pull", scope), /approval response/);
      let received = await b.env<Draft>("accept", {
        code: approved.approvalCode,
      });
      assert.equal(
        (await b.env<List>("list", { projectId: project })).sets[0].trusted,
        true,
      );
      assert.equal(
        (
          await b.env<{ value: string }>("reveal", {
            draftId: received.draftId,
            key: "API_KEY",
          })
        ).value,
        canary,
      );
      assert.deepEqual(received.keys, ["API_KEY", "URL"]);
      await assert.rejects(c.env("accept", { code: approved.approvalCode }));
      const ownRequest = await c.env<{ code: string }>("request", scope);
      const ownApproval = await b.env<{ approvalCode: string }>("approve", {
        code: ownRequest.code,
      });
      const own = await c.env<Draft>("accept", {
        code: ownApproval.approvalCode,
      });
      assert.equal(
        (
          await c.env<{ value: string }>("reveal", {
            draftId: own.draftId,
            key: "API_KEY",
          })
        ).value,
        canary,
      );
      received = await b.env<Draft>("pull", scope);
      await writeFile(
        join(b.path, ".env.local"),
        "# keep this\nLOCAL=untouched\nAPI_KEY=old\n",
      );
      const previewInput = {
        draftId: received.draftId,
        path: ".env.local",
        keys: ["API_KEY"],
      };
      assert.equal((await b.env("preview", previewInput)).ignored, false);
      await b.env("exclude", { projectId: project, path: ".env.local" });
      await b.env("preview", previewInput);
      await writeFile(
        join(b.path, ".env.local"),
        "# keep this\nLOCAL=untouched\nAPI_KEY=edited-after-preview\n",
      );
      await assert.rejects(
        b.env("apply", { draftId: received.draftId }),
        /changed/,
      );
      await b.env("preview", previewInput);
      await b.env("apply", { draftId: received.draftId });
      assert.equal(
        await readFile(join(b.path, ".env.local"), "utf8"),
        `# keep this\nLOCAL=untouched\nAPI_KEY=${canary}\n`,
      );
      const aBase = await a.env<Draft>("pull", scope);
      const aChange = await a.env<Draft>("import", {
        projectId: project,
        baseDraft: aBase.draftId,
        text: `API_KEY=${canary}-a\nURL=https://example.test\n`,
      });
      const bChange = await b.env<Draft>("import", {
        projectId: project,
        baseDraft: received.draftId,
        text: `API_KEY=${canary}-b\nURL=https://example.test\n`,
      });
      await a.env("publish", { draftId: aChange.draftId, keys: aChange.keys });
      await assert.rejects(
        b.env("publish", { draftId: bChange.draftId, keys: bChange.keys }),
        /changed/,
      );
      const pending = (await b.env<List>("list", { projectId: project }))
        .pending;
      assert.equal(pending.length, 1);
      await assert.rejects(
        b.env("retry", { pendingId: pending[0].id }),
        /changed/,
      );
      const latest = await b.env<Draft>("pull", scope);
      const comparison = await b.env<{
        keys: {
          key: string;
          changed: boolean;
          local: boolean;
          remote: boolean;
        }[];
      }>("compare", {
        draftId: bChange.draftId,
        remoteDraft: latest.draftId,
        keys: ["API_KEY"],
      });
      assert.equal(
        comparison.keys.find((k) => k.key === "API_KEY")?.changed,
        true,
      );
      assert.deepEqual(
        comparison.keys.find((k) => k.key === "URL"),
        {
          key: "URL",
          changed: true,
          local: false,
          remote: true,
        },
      );
      const merged = await b.env<Draft>("rebase", {
        draftId: bChange.draftId,
        remoteDraft: latest.draftId,
        keys: ["API_KEY"],
        choices: { API_KEY: "local", URL: "omit" },
      });
      assert.deepEqual(merged.keys, ["API_KEY"]);
      await b.env("publish", { draftId: merged.draftId, keys: merged.keys });
      const sharing = {
        memory: false,
        skill: false,
        session: false,
        plan: false,
        env: false,
      };
      await b.request({
        action: "project",
        operation: "sharing",
        input: { projectId: project, sharing },
      });
      await assert.rejects(
        b.env("retry", { pendingId: pending[0].id }),
        /Sharing for env is off/,
      );
      await assert.rejects(
        b.env("import", { projectId: project, text: "PRIVATE=local" }),
        /Sharing for env is off/,
      );
      await assert.rejects(b.env("pull", scope), /Sharing for env is off/);
      await b.request({
        action: "project",
        operation: "sharing",
        input: { projectId: project, sharing: { ...sharing, env: true } },
      });
      await b.env("discard", { pendingId: pending[0].id });
      const final = await a.env<Draft>("pull", scope);
      assert.equal(
        (
          await a.env<{ value: string }>("reveal", {
            draftId: final.draftId,
            key: "API_KEY",
          })
        ).value,
        canary + "-b",
      );
      await a.request({ action: "locked", value: true });
      await assert.rejects(a.env("pull", scope));
      await a.request({ action: "locked", value: false });
      await a.env("access", {
        ...scope,
        revision: final.revision,
        grants: [owner],
        removeDevices: [],
      });
      await assert.rejects(b.env("pull", scope));
      await assert.rejects(c.env("pull", scope));
      const raw = await pool.query(
        "select * from orka.env_sets where project_id=$1",
        [project],
      );
      assert.ok(!JSON.stringify(raw.rows).includes(canary));
      assert.ok(!JSON.stringify(raw.rows).includes("NOT_SHARED_CANARY"));
      const metadata = await pool.query(
        "select header from orka.env_headers where project_id=$1",
        [project],
      );
      assert.ok(!JSON.stringify(metadata.rows).includes(canary));
      async function checkFiles(directory: string): Promise<void> {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) await checkFiles(path);
          else if (path !== join(b.path, ".env.local")) {
            const bytes = await readFile(path);
            assert.equal(
              bytes.includes(Buffer.from(canary)),
              false,
              `Plaintext canary in ${path}`,
            );
            assert.equal(
              bytes.includes(Buffer.from("NOT_SHARED_CANARY")),
              false,
            );
          }
        }
      }
      await checkFiles(a.root);
      await checkFiles(b.root);
      await checkFiles(c.root);
      assert.ok(processes.every((mac) => !mac.stderr().includes(canary)));
      await a.request({ action: "logout" });
      await a.setup();
      await assert.rejects(
        a.env("reveal", { draftId: final.draftId, key: "API_KEY" }),
        /expired/,
      );
      const another = randomUUID();
      await a.setup(another);
      assert.equal((await a.env("capabilities")).enabled, false);
      await a.setup();
      assert.equal((await a.env("capabilities")).enabled, true);
    } finally {
      await Promise.all(processes.map((mac) => mac.close()));
      await new Promise<void>((r) => server.close(() => r()));
      await pool.end();
      await rm(home, { recursive: true, force: true });
    }
  },
);
