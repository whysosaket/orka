import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import {
  defaultProjectRules,
  type Change,
  type ProjectRules,
  type ReviewRequest,
} from "@portable/protocol";
import { Store } from "../packages/server-core/src/store.js";
import { migrate } from "../packages/server-core/src/migrations.js";
import { createApi } from "../packages/server-core/src/main.js";
import { Blobs, bytesHash } from "../packages/server-core/src/blobs.js";
import { acceptingMemoryResolver } from "../packages/server-core/src/testing/memory-fixtures.js";
import {
  identity,
  version,
} from "../packages/server-core/src/testing/env-fixtures.js";

// Review workflows remain supported when an owner selects restrictive rules.
const reviewRule = {
  mode: "suggest",
  canShare: false,
  create: "suggest",
} as const;
const reviewRules: ProjectRules = {
  ...defaultProjectRules,
  instructions: reviewRule,
  memory: reviewRule,
  skill: reviewRule,
  plan: { ...defaultProjectRules.plan, mode: "suggest" },
  session: { ...defaultProjectRules.session, mode: "read" },
};

await test("legacy governed projects retain saved member editing and addition rules while preserving ENV and owner boundaries", async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const home = await mkdtemp(join(tmpdir(), "orka-default-permissions-"));
  const store = new Store(pool, new Blobs(home), acceptingMemoryResolver());
  const owner = randomUUID(),
    member = randomUUID();
  const server = createApi(store, async (token) => token);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const api = async (user: string, path: string, input: unknown) => {
    const response = await fetch(origin + path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${user}`,
        "Content-Type": "application/json",
        "X-Orka-Governance": "1",
      },
      body: JSON.stringify(input),
    });
    return { status: response.status, value: await response.json() };
  };
  try {
    const created = {
      status: 200,
      value: {
        id: await store.createProject(owner, "Legacy member editing", true),
      },
    };
    assert.equal(created.status, 200);
    const projectId = created.value.id as string;
    const invite = await api(owner, "/v2/invites", { projectId });
    assert.equal(invite.status, 200);
    assert.equal(
      (await api(member, "/v2/join", { token: invite.value.token })).status,
      200,
    );
    await store.device(member, member, "Invited Mac");
    const action = (
      user: string,
      action: string,
      input: Record<string, unknown> = {},
    ) =>
      api(user, "/v2/governance/action", {
        action,
        input: { projectId, ...input },
      });
    const catalog = await action(member, "catalog");
    assert.equal(catalog.status, 200);
    assert.deepEqual(catalog.value.access.env, {
      mode: "read",
      create: "suggest",
      canShare: false,
      governed: true,
      policyRevision: 2,
    });
    const categories = [
      "instructions",
      "memory",
      "skill",
      "plan",
      "session",
    ] as const;
    for (const category of categories) {
      assert.equal(catalog.value.access[category].mode, "publish", category);
      assert.equal(catalog.value.access[category].create, "publish", category);
      assert.equal(catalog.value.access[category].canShare, false, category);
      const resourceId = randomUUID();
      const kind = category === "instructions" ? "memory" : category;
      const source = kind === "session" || kind === "plan" ? "codex" : "shared";
      const path =
        kind === "skill"
          ? "SKILL.md"
          : kind === "session"
            ? "session.jsonl"
            : "content.md";
      const upload = async (text: string) => {
        const bytes = Buffer.from(text),
          hash = bytesHash(bytes);
        const response = await fetch(
          `${origin}/v2/blobs/${projectId}/${hash}`,
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${member}`,
              "X-Orka-Governance": "1",
            },
            body: bytes,
          },
        );
        assert.equal(response.status, 200);
        return { path, hash, size: bytes.length, executable: false };
      };
      const change: Change = {
        version: 2,
        id: randomUUID(),
        projectId,
        deviceId: member,
        baseRevision: 0,
        resource: {
          resourceId,
          kind,
          source,
          title: category,
          logicalPath:
            category === "instructions"
              ? `instructions/${resourceId}/AGENTS.md`
              : category === "memory"
                ? `knowledge/${resourceId}.md`
                : kind === "skill"
                  ? `skill-${resourceId}`
                  : `codex/${resourceId}.${kind === "session" ? "jsonl" : "md"}`,
          ...(category === "memory"
            ? {
                memory: {
                  topic: "Runtime",
                  scope: "",
                  provider: "manual" as const,
                  supersedes: [],
                },
              }
            : {}),
          files: [await upload("Original shared content\n")],
          deleted: false,
        },
      };
      const published = await api(member, "/v2/sync/push", change);
      assert.equal(
        published.status,
        200,
        `${category}: ${JSON.stringify(published.value)}`,
      );
      const edited = await api(member, "/v2/sync/push", {
        ...change,
        id: randomUUID(),
        baseRevision: published.value.event.revision,
        resource: {
          ...change.resource,
          files: [await upload("Updated shared content\n")],
        },
      });
      assert.equal(
        edited.status,
        200,
        `${category}: ${JSON.stringify(edited.value)}`,
      );
    }
    assert.equal(
      (
        await action(member, "policy", {
          class: "memory",
          expectedPolicyRevision: 2,
          rule: reviewRule,
        })
      ).status,
      403,
    );
    assert.equal((await api(member, "/v2/invites", { projectId })).status, 403);
    // A project's saved restrictions survive creation of another project.
    const restricted = await action(owner, "policy", {
      class: "memory",
      expectedPolicyRevision: 2,
      rule: reviewRule,
    });
    assert.equal(restricted.status, 200);
    assert.equal(
      (
        await api(owner, "/v2/projects", {
          name: "Another project",
          governance: 1,
        })
      ).status,
      200,
    );
    const saved = await action(owner, "catalog");
    assert.deepEqual(saved.value.policy.memory, reviewRule);
    assert.deepEqual(saved.value.policy.env, {
      mode: "read",
      create: "suggest",
      canShare: false,
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
    await rm(home, { recursive: true, force: true });
  }
});

await test("governed HTTP exchange protects drafts, exact approvals, blobs, derivatives, permission refresh and ENV writers", async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const home = await mkdtemp(join(tmpdir(), "orka-governance-"));
  const store = new Store(pool, new Blobs(home));
  const owner = randomUUID(),
    member = randomUUID(),
    other = randomUUID(),
    device = randomUUID();
  const project = await store.createProject(owner, "Governance fixture");
  await pool.query(
    "insert into orka.members values($1,$2,'member'),($1,$3,'member')",
    [project, member, other],
  );
  for (const user of [owner, member, other])
    await store.device(user, user === owner ? device : user, "Fixture device");
  const server = createApi(store, async (token) => token);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const api = async (
    user: string,
    path: string,
    method = "GET",
    input?: unknown,
    supported = true,
  ) => {
    const response = await fetch(origin + path, {
      method,
      headers: {
        Authorization: `Bearer ${user}`,
        "Content-Type": "application/json",
        ...(supported ? { "X-Orka-Governance": "1" } : {}),
      },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    return { status: response.status, value: await response.json() };
  };
  const action = async (
    user: string,
    action: string,
    input: Record<string, unknown> = {},
  ) =>
    api(user, "/v2/governance/action", "POST", {
      action,
      input: { projectId: project, ...input },
    });
  const catalog = async () => (await action(owner, "catalog")).value;
  const grant = async (
    resourceId: string,
    userId: string,
    mode: string,
    canShare = false,
  ) => {
    const r = await action(owner, "access", {
      resourceId,
      userId,
      rule: { mode, canShare },
      expectedPolicyRevision: (await catalog()).policyRevision,
    });
    assert.equal(r.status, 200, JSON.stringify(r.value));
  };
  const file = async (user: string, text: string, path = "content.md") => {
    const bytes = Buffer.from(text),
      hash = bytesHash(bytes);
    const r = await fetch(`${origin}/v2/blobs/${project}/${hash}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${user}`, "X-Orka-Governance": "1" },
      body: bytes,
    });
    assert.equal(r.status, 200);
    return { path, hash, size: bytes.length, executable: false };
  };
  const change = async (
    user: string,
    text: string,
    kind: "memory" | "skill" | "plan" = "memory",
  ): Promise<Change> => ({
    version: 2,
    id: randomUUID(),
    projectId: project,
    deviceId: user === owner ? device : user,
    baseRevision: 0,
    resource: {
      resourceId: randomUUID(),
      kind,
      source: kind === "plan" ? "codex" : "shared",
      logicalPath:
        kind === "memory"
          ? "instructions/" + randomUUID() + "/AGENTS.md"
          : kind === "skill"
            ? "skill-" + randomUUID()
            : "codex/" + randomUUID() + ".md",
      title: "Synthetic shared content",
      files: [
        await file(user, text, kind === "skill" ? "SKILL.md" : "content.md"),
      ],
      deleted: false,
    },
  });
  const decide = async (request: ReviewRequest, decision = "approve") =>
    action(owner, "decide", {
      id: request.id,
      previewHash: request.previewHash,
      expectedPolicyRevision: (await catalog()).policyRevision,
      decision,
    });
  try {
    assert.equal(
      (
        await action(member, "activate", {
          expectedPolicyRevision: 0,
          rules: reviewRules,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await action(owner, "activate", {
          expectedPolicyRevision: 0,
          rules: reviewRules,
        })
      ).status,
      200,
    );
    const original = await change(owner, "# Instructions\nUse Node 24.\n");
    const pushed = await api(owner, "/v2/sync/push", "POST", original);
    assert.equal(pushed.status, 200, JSON.stringify(pushed.value));
    const id = original.resource.resourceId;
    const initial = await api(
      member,
      `/v2/sync/pull?projectId=${project}&cursor=0&governance=1`,
    );
    assert.equal(initial.value.reset, true);
    assert.equal(initial.value.events.length, 1);
    const blocked = {
      ...original,
      id: randomUUID(),
      deviceId: member,
      baseRevision: pushed.value.event.revision,
      resource: {
        ...original.resource,
        files: [await file(member, "# Instructions\nUse Node 26.\n")],
      },
    };
    assert.equal(
      (await api(member, "/v2/sync/push", "POST", blocked)).status,
      403,
    );
    assert.equal(
      (await api(owner, "/v2/sync/push", "POST", original, false)).status,
      409,
    );
    const proposed = await action(member, "submit", { change: blocked });
    assert.equal(proposed.status, 200, JSON.stringify(proposed.value));
    assert.equal(
      (await action(member, "submit", { change: blocked })).value.id,
      proposed.value.id,
    );
    assert.equal(
      (
        await api(
          other,
          `/v2/blobs/${project}/${blocked.resource.files[0].hash}`,
        )
      ).status,
      404,
    );
    assert.equal(
      (await action(other, "request", { id: proposed.value.id })).status,
      403,
    );
    assert.equal((await decide(proposed.value)).value.status, "approved");
    assert.equal((await decide(proposed.value)).value.status, "approved");
    const accepted = await api(
      member,
      `/v2/sync/pull?projectId=${project}&cursor=${pushed.value.event.revision}&governance=1&policyRevision=1`,
    );
    const latest = accepted.value.events.at(-1).resource;
    assert.equal(latest.files[0].hash, blocked.resource.files[0].hash);
    assert.equal(
      (await action(owner, "request", { id: proposed.value.id })).value.request
        .canReview,
      true,
    );
    await action(owner, "read-notification", { id: proposed.value.id });
    assert.equal(
      (await action(owner, "requests")).value.find(
        (r: ReviewRequest) => r.id === proposed.value.id,
      ).unread,
      false,
    );
    const staleChange = {
      ...blocked,
      id: randomUUID(),
      baseRevision: latest.revision,
      resource: {
        ...blocked.resource,
        files: [await file(member, "Different proposal\n")],
      },
    };
    const stale = await action(member, "submit", { change: staleChange });
    assert.equal(stale.status, 200);
    const edited = await api(owner, "/v2/sync/push", "POST", {
      ...original,
      id: randomUUID(),
      baseRevision: latest.revision,
      resource: {
        ...original.resource,
        files: [await file(owner, "Owner correction\n")],
      },
    });
    assert.equal(edited.status, 200);
    assert.equal((await decide(stale.value)).value.status, "stale");
    assert.equal(
      (
        await api(owner, "/v2/sync/push", "POST", {
          ...original,
          id: randomUUID(),
          baseRevision: latest.revision,
        })
      ).status,
      409,
    );
    await grant(id, member, "hidden");
    assert.equal(
      (
        await api(
          member,
          `/v2/blobs/${project}/${staleChange.resource.files[0].hash}`,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await api(
          member,
          `/v2/blobs/${project}/${original.resource.files[0].hash}`,
        )
      ).status,
      404,
    );
    assert.equal(
      (await action(member, "request", { id: proposed.value.id })).status,
      403,
    );
    const hidden = await api(
      member,
      `/v2/sync/pull?projectId=${project}&cursor=${edited.value.event.revision}&governance=1&policyRevision=1`,
    );
    assert.equal(hidden.value.reset, true);
    assert.equal(hidden.value.events.length, 0);
    assert.equal(
      (await api(member, "/v2/sync/push", "POST", blocked)).status,
      403,
    );
    const stolen = await change(member, "unused");
    stolen.resource.files = original.resource.files;
    assert.equal(
      (await action(member, "submit", { change: stolen })).status,
      403,
    );
    await grant(id, member, "read");
    const regained = await api(
      member,
      `/v2/sync/pull?projectId=${project}&cursor=${edited.value.event.revision}&governance=1&policyRevision=${hidden.value.policyRevision}`,
    );
    assert.equal(regained.value.events.length, 1);
    assert.equal(
      (
        await api(
          member,
          "/v2/sync/push",
          "POST",
          await change(member, "# new skill\n", "skill"),
        )
      ).status,
      403,
    );
    await grant(id, member, "publish");
    const delegate = await action(member, "access", {
      resourceId: id,
      userId: other,
      rule: { mode: "read", canShare: false },
      expectedPolicyRevision: (await catalog()).policyRevision,
    });
    assert.equal(delegate.status, 403);
    assert.equal(
      (
        await action(member, "access", {
          resourceId: id,
          userId: other,
          rule: { mode: "publish", canShare: true },
          expectedPolicyRevision: (await catalog()).policyRevision,
        })
      ).status,
      403,
    );
    // A derivative inherits its source and follows later source revocations and new members.
    const plan = await change(
      member,
      "Plan based on restricted instructions\n",
      "plan",
    );
    plan.resource.contextSources = [id];
    const planResult = await api(member, "/v2/sync/push", "POST", plan);
    assert.equal(planResult.status, 200, JSON.stringify(planResult.value));
    await grant(id, other, "hidden");
    const otherPull = await api(
      other,
      `/v2/sync/pull?projectId=${project}&cursor=0&governance=1`,
    );
    assert.equal(
      otherPull.value.events.some(
        (e: { resource: { resourceId: string } }) =>
          e.resource.resourceId === plan.resource.resourceId,
      ),
      false,
    );
    const cyclic = {
      ...original,
      id: randomUUID(),
      baseRevision: edited.value.event.revision,
      resource: {
        ...original.resource,
        contextSources: [plan.resource.resourceId],
      },
    };
    assert.equal(
      (await api(owner, "/v2/sync/push", "POST", cyclic)).status,
      400,
    );
    const envOwner = identity(owner);
    const env = async (operation: string, input: unknown) => {
      const call = {
        format: 1,
        deviceId: envOwner.device.id,
        time: Date.now(),
        nonce: randomUUID(),
        operation,
        input,
      };
      return api(owner, "/v2/env/action", "POST", {
        call,
        signature: envOwner.signature(call),
      });
    };
    assert.equal((await env("enroll", envOwner.device)).status, 200);
    const first = version(envOwner, project);
    assert.equal(
      (
        await env("mutate", {
          requestId: randomUUID(),
          expectedRevision: 0,
          expectedAccessRevision: 0,
          version: first,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await action(owner, "replace-env", {
          setId: first.manifest.setId,
          expectedPolicyRevision: (await catalog()).policyRevision,
        })
      ).status,
      200,
    );
    const next = version(envOwner, project, {}, first);
    assert.equal(
      (
        await env("mutate", {
          requestId: randomUUID(),
          expectedRevision: 1,
          expectedAccessRevision: 1,
          version: next,
        })
      ).status,
      403,
    );
    // A prepared merge includes accepted knowledge and must lose access even
    // though the server records the preview's generated bytes for its proposer.
    const learned = await change(owner, "Alpha\nBeta\n");
    learned.resource.logicalPath = `knowledge/${learned.resource.resourceId}.md`;
    learned.resource.memory = {
      topic: "Two independent facts",
      scope: "",
      provider: "manual",
      supersedes: [],
    };
    const knowledge = await api(owner, "/v2/sync/push", "POST", learned);
    assert.equal(knowledge.status, 200, JSON.stringify(knowledge.value));
    const revision = knowledge.value.event.revision;
    assert.equal(
      (
        await api(owner, "/v2/sync/push", "POST", {
          ...learned,
          id: randomUUID(),
          baseRevision: revision,
          resource: {
            ...learned.resource,
            files: [await file(owner, "Alpha\nBeta\nAccepted fact\n")],
          },
        })
      ).status,
      200,
    );
    const incoming = {
      ...learned,
      id: randomUUID(),
      deviceId: member,
      baseRevision: revision,
      resource: {
        ...learned.resource,
        files: [await file(member, "Proposed fact\nAlpha\nBeta\n")],
      },
    };
    const preview = await action(member, "submit", { change: incoming });
    assert.equal(preview.status, 200, JSON.stringify(preview.value));
    const detail = await action(member, "request", { id: preview.value.id });
    const preparedHash = detail.value.content.resource.files[0].hash;
    assert.notEqual(preparedHash, incoming.resource.files[0].hash);
    const prepared = await fetch(
      `${origin}/v2/blobs/${project}/${preparedHash}`,
      {
        headers: {
          Authorization: `Bearer ${member}`,
          "X-Orka-Governance": "1",
        },
      },
    );
    assert.equal(prepared.status, 200);
    assert.equal(
      await prepared.text(),
      "Proposed fact\nAlpha\nBeta\nAccepted fact\n",
    );
    await grant(learned.resource.resourceId, member, "hidden");
    assert.equal(
      (await action(member, "request", { id: preview.value.id })).status,
      403,
    );
    assert.equal(
      (await api(member, `/v2/blobs/${project}/${preparedHash}`)).status,
      404,
    );
    const reusedPreview = await change(member, "Unused incoming bytes\n");
    reusedPreview.resource.files = detail.value.content.resource.files;
    assert.equal(
      (await action(member, "submit", { change: reusedPreview })).status,
      403,
    );
    const pendingAudience = await action(owner, "submit", {
      change: await change(owner, "Review this audience before publication\n"),
    });
    assert.equal(pendingAudience.status, 200);
    const invited = await api(owner, "/v2/invites", "POST", {
      projectId: project,
    });
    const newcomer = randomUUID();
    assert.equal(
      (
        await api(
          newcomer,
          "/v2/join",
          "POST",
          { token: invited.value.token },
          false,
        )
      ).status,
      409,
    );
    const beforeJoin = (await catalog()).policyRevision;
    assert.equal(
      (await api(newcomer, "/v2/join", "POST", { token: invited.value.token }))
        .status,
      200,
    );
    assert.equal((await catalog()).policyRevision, beforeJoin + 1);
    assert.equal((await decide(pendingAudience.value)).value.status, "stale");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
    await rm(home, { recursive: true, force: true });
  }
});

await test("governed ENV read access is independent from publishing, receipt replay and creator decryption", async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL }),
    directory = await mkdtemp(join(tmpdir(), "orka-env-policy-"));
  const store = new Store(pool, new Blobs(directory));
  const owner = identity(),
    member = identity();
  const project = await store.createProject(
    owner.device.owner,
    "ENV permissions",
    true,
  );
  await pool.query("insert into orka.members values($1,$2,'member')", [
    project,
    member.device.owner,
  ]);
  const server = createApi(store, async (token) => token);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const api = async (user: string, path: string, input: unknown) => {
    const r = await fetch(url + path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${user}`,
        "X-Orka-Governance": "1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    });
    return { status: r.status, value: await r.json() };
  };
  const env = (
    who: ReturnType<typeof identity>,
    operation: string,
    input: unknown,
  ) => {
    const call = {
      format: 1,
      deviceId: who.device.id,
      time: Date.now(),
      nonce: randomUUID(),
      operation,
      input,
    };
    return api(who.device.owner, "/v2/env/action", {
      call,
      signature: who.signature(call),
    });
  };
  const governance = async (action: string, input: Record<string, unknown>) =>
    api(owner.device.owner, "/v2/governance/action", {
      action,
      input: { projectId: project, ...input },
    });
  const mutate = (
    who: ReturnType<typeof identity>,
    v: ReturnType<typeof version>,
    old?: ReturnType<typeof version>,
    requestId = randomUUID(),
  ) =>
    env(who, "mutate", {
      requestId,
      expectedRevision: old?.manifest.revision ?? 0,
      expectedAccessRevision: old?.manifest.accessRevision ?? 0,
      version: v,
    });
  try {
    await env(owner, "enroll", owner.device);
    await env(member, "enroll", member.device);
    const first = version(owner, project, {
      grants: [owner.device.owner, member.device.owner],
    });
    assert.equal((await mutate(owner, first)).status, 200);
    const request = {
      format: 1 as const,
      projectId: project,
      setId: first.manifest.setId,
      device: member.device,
      nonce: randomUUID(),
      expiresAt: Date.now() + 600_000,
    };
    const approved = version(
      owner,
      project,
      {
        devices: [owner.device, member.device],
        approvals: [{ request, signature: member.signature(request) }],
      },
      first,
    );
    assert.equal((await mutate(owner, approved, first)).status, 200);
    assert.equal(
      (
        await env(member, "read", {
          projectId: project,
          setId: first.manifest.setId,
        })
      ).status,
      200,
    );
    const update = version(member, project, {}, approved),
      id = randomUUID();
    assert.equal((await mutate(member, update, approved, id)).status, 403);
    let revision = (await governance("catalog", {})).value.policyRevision;
    assert.equal(
      (
        await governance("access", {
          resourceId: first.manifest.setId,
          userId: member.device.owner,
          rule: { mode: "publish", canShare: false },
          expectedPolicyRevision: revision,
        })
      ).status,
      200,
    );
    assert.equal((await mutate(member, update, approved, id)).status, 200);
    revision = (await governance("catalog", {})).value.policyRevision;
    await governance("access", {
      resourceId: first.manifest.setId,
      userId: member.device.owner,
      rule: { mode: "read", canShare: false },
      expectedPolicyRevision: revision,
    });
    assert.equal((await mutate(member, update, approved, id)).status, 403);
    revision = (await governance("catalog", {})).value.policyRevision;
    await governance("inherit", {
      resourceId: first.manifest.setId,
      userId: member.device.owner,
      expectedPolicyRevision: revision,
    });
    const rules = (await governance("catalog", {})).value.resourceRules;
    assert.equal(
      rules.some(
        (r: { resourceId: string }) => r.resourceId === first.manifest.setId,
      ),
      false,
    );
    revision = (await governance("catalog", {})).value.policyRevision;
    await governance("policy", {
      class: "env",
      userId: member.device.owner,
      rule: { mode: "read", create: "publish", canShare: false },
      expectedPolicyRevision: revision,
    });
    const personal = version(member, project);
    assert.equal((await mutate(member, personal)).status, 200);
    assert.equal(
      (
        await env(owner, "read", {
          projectId: project,
          setId: personal.manifest.setId,
        })
      ).status,
      403,
    );
    revision = (await governance("catalog", {})).value.policyRevision;
    assert.equal(
      (
        await governance("remove-member", {
          userId: member.device.owner,
          expectedPolicyRevision: revision,
        })
      ).status,
      200,
    );
    assert.equal(
      (await mutate(member, version(member, project, {}, personal), personal))
        .status,
      403,
    );
    assert.equal(
      (
        await pool.query(
          "select disabled from orka.env_replacements where project_id=$1 and set_id=$2",
          [project, personal.manifest.setId],
        )
      ).rows[0].disabled,
      true,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("category access and member names work without exposing hidden files", async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const home = await mkdtemp(join(tmpdir(), "orka-category-access-"));
  const store = new Store(pool, new Blobs(home));
  const owner = randomUUID(),
    member = randomUUID(),
    other = randomUUID();
  const projectId = await store.createProject(
    owner,
    "Category request fixture",
  );
  await pool.query(
    "insert into orka.members values($1,$2,'member'),($1,$3,'member')",
    [projectId, member, other],
  );
  await pool.query("insert into orka.env_profiles values($1,$2)", [
    member,
    "Mira Shah",
  ]);
  const { governanceAction } =
    await import("../packages/server-core/src/governance.js");
  const action = (
    user: string,
    action: string,
    input: Record<string, unknown> = {},
  ) =>
    governanceAction(store, user, { action, input: { projectId, ...input } });
  const catalog = () =>
    action(owner, "catalog") as Promise<{
      policyRevision: number;
      members: { id: string; name: string }[];
      memberRules: {
        userId: string;
        class: string;
        rule: { mode: string; create: string; canShare: boolean };
      }[];
    }>;
  try {
    assert.equal(
      (await catalog()).members.find((item) => item.id === member)?.name,
      "Mira Shah",
    );
    await action(owner, "activate", {
      expectedPolicyRevision: 0,
      rules: reviewRules,
    });
    await action(owner, "policy", {
      class: "memory",
      userId: member,
      expectedPolicyRevision: (await catalog()).policyRevision,
      rule: { mode: "read", create: "publish", canShare: false },
    });
    const input = { id: randomUUID(), class: "memory", mode: "publish" };
    const request = (await action(
      member,
      "request-access",
      input,
    )) as ReviewRequest;
    assert.equal(request.requestedClass, "memory");
    assert.equal(request.resourceId, projectId);
    assert.deepEqual(await action(other, "requests"), []);
    const decision = {
      id: request.id,
      decision: "approve",
      previewHash: request.previewHash,
      expectedPolicyRevision: (await catalog()).policyRevision,
    };
    await assert.rejects(
      action(other, "decide", decision),
      /Request access denied/,
    );
    assert.equal(
      ((await action(owner, "decide", decision)) as ReviewRequest).status,
      "approved",
    );
    const accepted = await catalog();
    assert.deepEqual(
      accepted.memberRules.find(
        (item) => item.userId === member && item.class === "memory",
      )?.rule,
      { mode: "publish", create: "publish", canShare: false },
    );
    assert.deepEqual(
      accepted.memberRules.find(
        (item) => item.userId === member && item.class === "instructions",
      )?.rule,
      { mode: "publish", create: "suggest", canShare: false },
    );
    assert.equal(
      ((await action(member, "request-access", input)) as ReviewRequest).id,
      request.id,
    );
    await assert.rejects(
      action(member, "request-access", {
        id: randomUUID(),
        class: "skill",
        resourceId: randomUUID(),
        mode: "read",
      }),
    );
    const stale = (await action(member, "request-access", {
      id: randomUUID(),
      class: "plan",
      mode: "publish",
    })) as ReviewRequest;
    await action(owner, "policy", {
      class: "skill",
      expectedPolicyRevision: (await catalog()).policyRevision,
      rule: defaultProjectRules.skill,
    });
    assert.equal(
      (
        (await action(owner, "decide", {
          id: stale.id,
          decision: "approve",
          previewHash: stale.previewHash,
          expectedPolicyRevision: (await catalog()).policyRevision,
        })) as ReviewRequest
      ).status,
      "stale",
    );
    const logs = (user: string, input = {}) =>
      action(user, "logs", input) as Promise<{
        items: {
          id: string;
          action: string;
          requestId?: string;
          subjectName?: string;
        }[];
        next: string | null;
      }>;
    const ownerLogs = await logs(owner);
    assert.equal(
      ownerLogs.items.filter(
        (item) =>
          item.action === "request.approved" && item.requestId === request.id,
      ).length,
      1,
    );
    assert.equal(
      ownerLogs.items.filter(
        (item) =>
          item.action === "request.created" && item.requestId === request.id,
      ).length,
      1,
    );
    assert.equal(
      ownerLogs.items.find((item) => item.action === "request.approved")
        ?.subjectName,
      "Mira Shah",
    );
    assert.ok(
      (await logs(member)).items.some((item) => item.requestId === request.id),
    );
    assert.ok(
      !(await logs(other)).items.some((item) => item.requestId === request.id),
    );
    const first = await logs(owner, { limit: 2 });
    const second = await logs(owner, { limit: 2, before: first.next });
    assert.equal(first.items.length, 2);
    assert.ok(first.next);
    assert.ok(
      second.items.every(
        (item) => !first.items.some((old) => old.id === item.id),
      ),
    );
    await assert.rejects(action(randomUUID(), "logs"), /access denied/i);
    await assert.rejects(
      action(member, "policy", {
        class: "skill",
        rule: defaultProjectRules.skill,
        expectedPolicyRevision: (await catalog()).policyRevision,
      }),
      /Only project owners/,
    );
    await assert.rejects(
      action(owner, "policy", {
        class: "skill",
        rule: { ...defaultProjectRules.skill, canShare: true },
        expectedPolicyRevision: (await catalog()).policyRevision,
      }),
      /Only project owners/,
    );
    await assert.rejects(
      pool.query(
        "update orka.management_logs set payload='{}' where project_id=$1",
        [projectId],
      ),
      /append-only/,
    );
    await assert.rejects(
      pool.query("delete from orka.management_logs where project_id=$1", [
        projectId,
      ]),
      /append-only/,
    );
  } finally {
    await pool.query("delete from orka.projects where id=$1", [projectId]);
    await pool.query("delete from orka.env_profiles where user_id=$1", [
      member,
    ]);
    await pool.end();
    await rm(home, { recursive: true, force: true });
  }
});

await test("migration restarts preserve current policies and management logs", async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const home = await mkdtemp(join(tmpdir(), "orka-log-restart-"));
  const store = new Store(pool, new Blobs(home));
  const owner = randomUUID(),
    member = randomUUID(),
    resource = randomUUID();
  const projectId = await store.createProject(owner, "Restart fixture", true);
  try {
    await pool.query("insert into orka.members values($1,$2,'member')", [
      projectId,
      member,
    ]);
    const rule = { mode: "publish", create: "publish", canShare: false };
    await pool.query(
      "insert into orka.member_policy values($1,$2,'skill',$3)",
      [projectId, member, rule],
    );
    await pool.query("insert into orka.resource_access values($1,$2,$3,$4)", [
      projectId,
      resource,
      member,
      { mode: "hidden", canShare: false },
    ]);
    await pool.query(
      "insert into orka.management_logs(project_id,dedupe_key,payload) values($1,'restart-fixture',$2)",
      [projectId, { action: "request.recorded" }],
    );
    const before = (
      await pool.query(
        "select policy_revision from orka.projects where id=$1",
        [projectId],
      )
    ).rows[0];
    await migrate(pool);
    await migrate(pool);
    assert.deepEqual(
      (
        await pool.query(
          "select rule from orka.member_policy where project_id=$1",
          [projectId],
        )
      ).rows[0].rule,
      rule,
    );
    assert.deepEqual(
      (
        await pool.query(
          "select rule from orka.resource_access where project_id=$1",
          [projectId],
        )
      ).rows[0].rule,
      { mode: "hidden", canShare: false },
    );
    assert.equal(
      (
        await pool.query(
          "select count(*) from orka.management_logs where project_id=$1 and dedupe_key='restart-fixture'",
          [projectId],
        )
      ).rows[0].count,
      "1",
    );
    assert.deepEqual(
      (
        await pool.query(
          "select policy_revision from orka.projects where id=$1",
          [projectId],
        )
      ).rows[0],
      before,
    );
  } finally {
    await pool.query("delete from orka.projects where id=$1", [projectId]);
    await pool.end();
    await rm(home, { recursive: true, force: true });
  }
});
