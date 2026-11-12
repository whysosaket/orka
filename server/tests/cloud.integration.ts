import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import {
  type ResourceInput,
  type Change,
  type Receipt,
} from "@portable/protocol";
import { Store, HttpError } from "./bridge/store.js";
import { Blobs, bytesHash } from "./fixtures/blobs.js";
import { createApi } from "./bridge/main.js";
import { acceptingMemoryResolver } from "./fixtures/memory-fixtures.js";

await test("exchange API: isolation, retries, merges, snapshots, and session conflict concurrency", async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const directory = await mkdtemp(join(tmpdir(), "orka-blobs-"));
  const blobs = new Blobs(directory),
    store = new Store(pool, blobs, acceptingMemoryResolver());
  const owner = randomUUID(),
    teammate = randomUUID(),
    outsider = randomUUID(),
    device = randomUUID(),
    second = randomUUID(),
    teammateDevice = randomUUID();
  const server = createApi(store, async (token) => {
    if (!new Set<string>([owner, teammate, outsider]).has(token))
      throw new HttpError(401, "Sign in required");
    return token;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const api = async (
    path: string,
    method = "GET",
    input?: unknown,
    user = owner,
  ) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        Authorization: `Bearer ${user}`,
        "Content-Type": "application/json",
      },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    return {
      status: response.status,
      value: (await response.json()) as Record<string, unknown>,
    };
  };
  const textFile = async (
    project: string,
    text: string,
    path = "content.md",
    executable = false,
  ) => {
    const bytes = Buffer.from(text),
      hash = await blobs.put(project, bytes);
    await pool.query(
      "insert into orka.blobs values($1,$2,$3) on conflict do nothing",
      [project, hash, bytes.length],
    );
    return { path, hash, size: bytes.length, executable };
  };
  try {
    assert.equal((await fetch(base + "/v2/projects")).status, 401);
    const created = {
      status: 200,
      value: { id: await store.createProject(owner, "Different local paths") },
    };
    assert.equal(created.status, 200);
    const project = created.value.id as string;
    await store.device(owner, device, "Mac A");
    await store.device(owner, second, "Mac B");
    await store.device(teammate, teammateDevice, "Teammate Mac");
    assert.equal(
      (
        await api(
          `/v2/sync/pull?projectId=${project}`,
          "GET",
          undefined,
          outsider,
        )
      ).status,
      403,
    );
    const invite = await api("/v2/invites", "POST", { projectId: project });
    assert.equal(
      (await api("/v2/join", "POST", { token: invite.value.token }, teammate))
        .status,
      200,
    );
    assert.equal(
      (await api("/v2/join", "POST", { token: invite.value.token }, outsider))
        .status,
      400,
    );
    assert.equal(
      (await api("/v2/invites", "POST", { projectId: project }, teammate))
        .status,
      403,
    );
    const original: ResourceInput = {
      resourceId: randomUUID(),
      kind: "memory",
      source: "shared",
      logicalPath: "instructions/AGENTS.md",
      title: "Instructions",
      files: [await textFile(project, "a\nb\nc\n")],
      deleted: false,
    };
    const first: Change = {
      version: 2,
      id: randomUUID(),
      projectId: project,
      deviceId: device,
      baseRevision: 0,
      resource: original,
    };
    const accepted = await store.mutate(owner, first);
    assert.deepEqual(await store.mutate(owner, first), accepted);
    await assert.rejects(
      store.mutate(owner, {
        ...first,
        resource: { ...original, title: "changed" },
      }),
      /Retry ID reused/,
    );
    const current = await store.mutate(owner, {
      ...first,
      id: randomUUID(),
      baseRevision: accepted.event.revision,
      resource: { ...original, files: [await textFile(project, "A\nb\nc\n")] },
    });
    const latest = await store.mutate(teammate, {
      ...first,
      id: randomUUID(),
      deviceId: teammateDevice,
      baseRevision: accepted.event.revision,
      resource: { ...original, files: [await textFile(project, "a\nb\nC\n")] },
    });
    assert.equal(
      (
        await blobs.read(project, latest.event.resource.files[0].hash)
      ).toString(),
      "A\nb\nC\n",
    );
    const overlapping = await store.mutate(owner, {
      ...first,
      id: randomUUID(),
      baseRevision: accepted.event.revision,
      resource: {
        ...original,
        files: [await textFile(project, "LATER\nb\nc\n")],
      },
    });
    assert.equal(
      (
        await blobs.read(project, overlapping.event.resource.files[0].hash)
      ).toString(),
      "LATER\nb\nC\n",
    );
    assert.ok(overlapping.event.revision > current.event.revision);
    const blobUrl = `/v2/blobs/${project}/${original.files[0].hash}`;
    assert.equal(
      (
        await fetch(base + blobUrl, {
          headers: { Authorization: `Bearer ${outsider}` },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(base + blobUrl, {
          headers: { Authorization: `Bearer ${teammate}` },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(
          base + `/v2/blobs/${project}/${bytesHash(Buffer.from("good"))}`,
          {
            method: "PUT",
            headers: { Authorization: `Bearer ${owner}` },
            body: "bad",
          },
        )
      ).status,
      400,
    );
    const deletion = await store.mutate(owner, {
      ...first,
      id: randomUUID(),
      baseRevision: overlapping.event.revision,
      resource: { ...original, files: [], deleted: true },
    });
    assert.ok(deletion.event.resource.deleted);
    assert.equal(
      (await store.mutate(owner, first)).event.revision,
      accepted.event.revision,
    );
    const pulled = await api(`/v2/sync/pull?projectId=${project}&cursor=0`);
    assert.equal(pulled.status, 200);
    assert.equal(pulled.value.cursor, deletion.event.revision);
    assert.equal(
      (await api(`/v2/sync/pull?projectId=${project}&cursor=999999`)).status,
      400,
    );
    for (const source of ["codex", "claude"] as const) {
      const plan: ResourceInput = {
        ...original,
        resourceId: randomUUID(),
        kind: "plan",
        source,
        logicalPath: `${source}/files/feature.md`,
        title: "Feature plan",
        files: [await textFile(project, "# Plan\nDesign\nImplement\n")],
      };
      const planChange = { ...first, id: randomUUID(), resource: plan };
      const response = await api("/v2/sync/push", "POST", planChange);
      assert.equal(response.status, 200);
      const planBase = response.value as unknown as Receipt;
      await store.mutate(owner, {
        ...planChange,
        id: randomUUID(),
        baseRevision: planBase.event.revision,
        resource: {
          ...plan,
          files: [await textFile(project, "# Plan\nDESIGN\nImplement\n")],
        },
      });
      const mergedPlan = await store.mutate(teammate, {
        ...planChange,
        id: randomUUID(),
        deviceId: teammateDevice,
        baseRevision: planBase.event.revision,
        resource: {
          ...plan,
          files: [await textFile(project, "# Plan\nDesign\nIMPLEMENT\n")],
        },
      });
      assert.equal(
        (
          await blobs.read(project, mergedPlan.event.resource.files[0].hash)
        ).toString(),
        "# Plan\nDESIGN\nIMPLEMENT\n",
      );
      assert.equal(mergedPlan.conflict, false);
      const planFeed = await api(
        `/v2/sync/pull?projectId=${project}&cursor=${planBase.event.revision}`,
        "GET",
        undefined,
        teammate,
      );
      assert.equal(planFeed.status, 200);
      assert.ok(
        (planFeed.value.events as { resource: ResourceInput }[]).some(
          (event) =>
            event.resource.kind === "plan" && event.resource.source === source,
        ),
      );
      assert.equal(
        (
          await api(
            "/v2/sync/push",
            "POST",
            { ...planChange, id: randomUUID() },
            outsider,
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await api("/v2/sync/push", "POST", {
            ...planChange,
            id: randomUUID(),
            resource: {
              ...plan,
              files: [{ ...plan.files[0], executable: true }],
            },
          })
        ).status,
        400,
      );
      await assert.rejects(
        store.mutate(owner, {
          ...planChange,
          id: randomUUID(),
          baseRevision: mergedPlan.event.revision,
          resource: {
            ...plan,
            files: [await textFile(project, "\u0000binary plan")],
          },
        }),
        /UTF-8 Markdown/,
      );
      const removed = await store.mutate(owner, {
        ...planChange,
        id: randomUUID(),
        baseRevision: mergedPlan.event.revision,
        resource: { ...plan, files: [], deleted: true },
      });
      assert.equal(removed.event.resource.deleted, true);
      assert.deepEqual(await store.mutate(owner, planChange), planBase);
    }
    const skill: ResourceInput = {
      ...original,
      resourceId: randomUUID(),
      kind: "skill",
      logicalPath: "test-skill",
      files: [
        await textFile(project, "skill", "SKILL.md"),
        await textFile(project, "echo hello", "scripts/run.sh", true),
      ],
    };
    const packageChange = { ...first, id: randomUUID(), resource: skill };
    const skillBase = await store.mutate(owner, packageChange);
    await store.mutate(owner, {
      ...packageChange,
      id: randomUUID(),
      baseRevision: skillBase.event.revision,
      resource: {
        ...skill,
        files: [{ ...skill.files[0], executable: true }, skill.files[1]],
      },
    });
    const packageMerge = await store.mutate(owner, {
      ...packageChange,
      id: randomUUID(),
      baseRevision: skillBase.event.revision,
      resource: {
        ...skill,
        files: [
          skill.files[0],
          await textFile(project, "echo updated", "scripts/run.sh", true),
        ],
      },
    });
    assert.ok(
      packageMerge.event.resource.files.find((f) => f.path === "SKILL.md")
        ?.executable,
    );
    const modeMerge = await store.mutate(owner, {
      ...packageChange,
      id: randomUUID(),
      baseRevision: skillBase.event.revision,
      resource: {
        ...skill,
        files: [skill.files[0], { ...skill.files[1], executable: false }],
      },
    });
    const script = modeMerge.event.resource.files.find(
      (f) => f.path === "scripts/run.sh",
    )!;
    assert.equal(script.executable, false);
    assert.equal(
      (await blobs.read(project, script.hash)).toString(),
      "echo updated",
    );
    const session: ResourceInput = {
      ...original,
      resourceId: randomUUID(),
      kind: "session",
      source: "claude",
      logicalPath: "claude/" + randomUUID(),
      files: [await textFile(project, '{"complete":true}\n', "session.jsonl")],
    };
    const sessionChange: Change = {
      ...first,
      id: randomUUID(),
      resource: session,
    };
    const sessionBase = await store.mutate(owner, sessionChange);
    await store.mutate(owner, {
      ...sessionChange,
      id: randomUUID(),
      baseRevision: sessionBase.event.revision,
      resource: {
        ...session,
        files: [await textFile(project, '{"version":"a"}\n', "session.jsonl")],
      },
    });
    const divergence = await store.mutate(owner, {
      ...sessionChange,
      id: randomUUID(),
      deviceId: second,
      baseRevision: sessionBase.event.revision,
      resource: {
        ...session,
        files: [await textFile(project, '{"version":"b"}\n', "session.jsonl")],
      },
    });
    assert.equal(divergence.conflict, true);
    assert.equal(divergence.event.conflicts.length, 1);
    await assert.rejects(
      store.mutate(teammate, {
        ...sessionChange,
        id: randomUUID(),
        deviceId: teammateDevice,
        baseRevision: divergence.event.revision,
      }),
      /Copy a teammate/,
    );
    const resolution = {
      version: 2 as const,
      id: randomUUID(),
      projectId: project,
      deviceId: device,
      resourceId: session.resourceId,
      expectedRevision: divergence.event.revision,
      conflictId: divergence.event.conflicts[0].id,
      action: "override" as const,
      selected: "candidate" as const,
    };
    const results = await Promise.allSettled([
      store.resolve(owner, resolution),
      store.resolve(owner, {
        ...resolution,
        id: randomUUID(),
        action: "keep",
        selected: "current",
      }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
    const copyInput = {
      version: 2 as const,
      id: randomUUID(),
      projectId: project,
      deviceId: teammateDevice,
      resourceId: session.resourceId,
      expectedRevision: sessionBase.event.revision,
    };
    const copied = await store.copy(teammate, copyInput);
    assert.equal(copied.event.resource.owner, teammate);
    assert.equal(copied.event.activity?.notifyOwner, owner);
    assert.deepEqual(copied.event.resource.files, session.files);
    assert.deepEqual(await store.copy(teammate, copyInput), copied);
    const head = (
      await pool.query(
        "select payload from orka.resources where project_id=$1 and id=$2",
        [project, session.resourceId],
      )
    ).rows[0].payload as Receipt["event"]["resource"];
    const stale = await store.mutate(owner, {
      ...sessionChange,
      id: randomUUID(),
      baseRevision: sessionBase.event.revision,
      resource: {
        ...session,
        files: [
          await textFile(project, '{"version":"copy-me"}\n', "session.jsonl"),
        ],
      },
    });
    const conflictCopy = await store.resolve(owner, {
      ...resolution,
      id: randomUUID(),
      action: "copy",
      selected: "candidate",
      expectedRevision: stale.event.revision,
      conflictId: stale.event.conflicts[0].id,
    });
    assert.equal(conflictCopy.event.related?.[0].conflicts.length, 0);
    assert.deepEqual(
      conflictCopy.event.related?.[0].resource.files,
      head.files,
    );
    const finalConflict = await store.mutate(owner, {
      ...sessionChange,
      id: randomUUID(),
      baseRevision: sessionBase.event.revision,
      resource: { ...session, files: [], deleted: true },
    });
    const kept = await store.resolve(owner, {
      ...resolution,
      id: randomUUID(),
      action: "keep",
      selected: "current",
      expectedRevision: finalConflict.event.revision,
      conflictId: finalConflict.event.conflicts[0].id,
    });
    assert.equal(kept.event.conflicts.length, 0);
    assert.equal(kept.event.resource.deleted, false);
    await pool.query(
      "delete from orka.members where project_id=$1 and user_id=$2",
      [project, teammate],
    );
    assert.equal(
      (
        await fetch(base + blobUrl, {
          headers: { Authorization: `Bearer ${teammate}` },
        })
      ).status,
      403,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  }
});
