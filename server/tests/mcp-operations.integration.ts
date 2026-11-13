import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { Store } from "./bridge/store.js";
import { Blobs } from "./fixtures/blobs.js";
import { acceptingMemoryResolver } from "./fixtures/memory-fixtures.js";
import { OrkaReader, OrkaOAuth, tokenHash } from "./bridge/mcp.js";
import { createApi } from "./bridge/main.js";
import { authSettings } from "./bridge/auth.js";
import { createServer } from "node:http";
import type { ResourceInput } from "@portable/protocol";

await test("MCP operations preserve ACLs, revision history, exact writes, reviews and OAuth scope isolation", async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const directory = await mkdtemp(join(tmpdir(), "orka-mcp-operations-"));
  const store = new Store(
    pool,
    new Blobs(directory),
    acceptingMemoryResolver(),
  );
  const owner = randomUUID(),
    member = randomUUID(),
    outsider = randomUUID();
  const project = await store.createProject(owner, "MCP operations", true);
  const otherProject = await store.createProject(
    outsider,
    "Inaccessible",
    true,
  );
  await pool.query("insert into orka.members values($1,$2,'member')", [
    project,
    member,
  ]);
  await store.device(owner, owner, "Fixture");
  await store.device(member, member, "Member");
  await store.device(outsider, outsider, "Other");
  const reservation = createServer();
  await new Promise<void>((r) => reservation.listen(0, "127.0.0.1", r));
  const addr = reservation.address();
  assert.ok(addr && typeof addr !== "string");
  await new Promise<void>((r) => reservation.close(() => r()));
  const origin = `http://127.0.0.1:${addr.port}`;
  const settings = authSettings({ PUBLIC_URL: origin });
  const server = createApi(
    store,
    async (token) => token,
    undefined,
    settings,
    true,
  );
  await new Promise<void>((r) => server.listen(addr.port, "127.0.0.1", r));
  const reader = new OrkaReader(store, owner, origin),
    teammate = new OrkaReader(store, member, origin),
    outside = new OrkaReader(store, outsider, origin);
  const call = async (reader: OrkaReader, name: string, input: object) =>
    (await reader.run(name, input)) as Record<string, unknown>;
  const put = async (
    projectId: string,
    user: string,
    resource: Omit<ResourceInput, "files">,
    text: string,
    path = "content.md",
  ) => {
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
    return await store.mutate(user, {
      version: 2,
      id: randomUUID(),
      projectId,
      deviceId: user,
      baseRevision: 0,
      resource: {
        ...resource,
        files: [{ path, hash, size: bytes.length, executable: false }],
      },
    });
  };
  try {
    const privateId = randomUUID();
    await put(
      otherProject,
      outsider,
      {
        resourceId: privateId,
        kind: "memory",
        source: "shared",
        logicalPath: `knowledge/${privateId}.md`,
        title: "Private other project",
        memory: {
          topic: "Private",
          scope: "",
          provider: "manual",
          supersedes: [],
        },
        deleted: false,
      },
      "PRIVATE_OTHER_PROJECT",
    );
    assert.ok(
      !JSON.stringify(
        await call(reader, "search_resources", {
          query: "PRIVATE_OTHER_PROJECT",
        }),
      ).includes(privateId),
    );
    const input = {
      projectId: project,
      requestId: randomUUID(),
      title: "Decision",
      text: "Use immutable snapshots",
      scope: "",
    };
    const created = await call(reader, "create_memory", input);
    assert.equal(created.status, "published");
    assert.deepEqual(await call(reader, "create_memory", input), created);
    await assert.rejects(
      call(reader, "create_memory", { ...input, text: "Different retry" }),
      /Retry ID/,
    );
    const id = input.requestId;
    const found = await call(reader, "search_resources", {
      query: "immutable",
    });
    assert.ok(JSON.stringify(found).includes(id));
    assert.ok(
      !JSON.stringify(await call(outside, "search_resources", {})).includes(id),
    );
    await assert.rejects(
      call(outside, "get_resource_history", {
        projectId: project,
        resourceId: id,
      }),
      /access denied/,
    );
    const plan = randomUUID();
    await put(
      project,
      owner,
      {
        resourceId: plan,
        kind: "plan",
        source: "codex",
        logicalPath: "codex/deploy.md",
        title: "Deploy",
        deleted: false,
      },
      "# Plan\nOld step\n",
    );
    const original = (
      await pool.query(
        "select payload from orka.resources where project_id=$1 and id=$2",
        [project, plan],
      )
    ).rows[0].payload as { revision: number };
    const update = {
      projectId: project,
      resourceId: plan,
      requestId: randomUUID(),
      expectedRevision: original.revision,
      text: "# Plan\nNew step\n",
    };
    const updated = await call(reader, "update_plan", update);
    assert.equal(updated.status, "published");
    assert.deepEqual(await call(reader, "update_plan", update), updated);
    await assert.rejects(
      call(reader, "update_plan", { ...update, requestId: randomUUID() }),
      /Plan changed/,
    );
    const history = await call(reader, "get_resource_history", {
      projectId: project,
      resourceId: plan,
    });
    const revisions = history.items as {
      revision: number;
      updatedBy: string;
      updatedAt: string;
    }[];
    assert.equal(revisions.length, 2);
    assert.equal(revisions[0].updatedBy, owner);
    assert.ok(revisions[0].updatedAt);
    const diff = await call(reader, "compare_revisions", {
      projectId: project,
      resourceId: plan,
      fromRevision: original.revision,
      toRevision: revisions[0].revision,
    });
    assert.ok(JSON.stringify(diff).includes("New step"));
    assert.equal((diff.changedFiles as unknown[]).length, 1);
    const skill = randomUUID();
    await put(
      project,
      owner,
      {
        resourceId: skill,
        kind: "skill",
        source: "shared",
        logicalPath: "fixture-skill",
        title: "Fixture",
        deleted: false,
      },
      "---\nname: fixture\n---\n",
      "SKILL.md",
    );
    assert.ok(
      JSON.stringify(await call(reader, "list_skills", {})).includes(skill),
    );
    await pool.query("insert into orka.resource_access values($1,$2,$3,$4)", [
      project,
      skill,
      member,
      { mode: "hidden", canShare: false },
    ]);
    assert.ok(
      !JSON.stringify(await call(teammate, "list_skills", {})).includes(skill),
    );
    await assert.rejects(
      store.invoke("governance", {
        user: member,
        input: {
          action: "installation",
          input: { projectId: project, resourceId: skill, expectedRevision: 1 },
        },
      }),
      /Skill unavailable/,
    );
    const permissions = await call(reader, "get_permissions", {
      projectId: project,
      memberId: member,
    });
    assert.equal(permissions.role, "member");
    await assert.rejects(
      call(teammate, "get_permissions", {
        projectId: project,
        memberId: owner,
      }),
      /Only the Owner/,
    );
    const policy = await call(reader, "get_permissions", {
      projectId: project,
    });
    await assert.rejects(
      call(teammate, "update_permissions", {
        projectId: project,
        requestId: randomUUID(),
        expectedPolicyRevision: policy.policyRevision,
        action: "policy",
        category: "plan",
        rule: { mode: "hidden", create: "hidden", canShare: false },
      }),
      /Only the Owner/,
    );
    const changePermission = {
      projectId: project,
      requestId: randomUUID(),
      expectedPolicyRevision: policy.policyRevision,
      action: "policy",
      category: "memory",
      memberId: member,
      rule: { mode: "suggest", create: "suggest", canShare: false },
    };
    await call(reader, "update_permissions", changePermission);
    await assert.rejects(
      call(reader, "update_permissions", {
        ...changePermission,
        requestId: randomUUID(),
      }),
      /Permissions changed/,
    );
    const afterPermission = await call(reader, "get_permissions", {
      projectId: project,
    });
    assert.deepEqual(
      await call(reader, "update_permissions", changePermission),
      await call(reader, "update_permissions", changePermission),
    );
    const proposed = await call(teammate, "create_memory", {
      projectId: project,
      requestId: randomUUID(),
      title: "Proposed decision",
      text: "Review me",
    });
    assert.equal(proposed.status, "approval_required");
    const request = proposed.request as { id: string; previewHash: string };
    assert.ok(
      JSON.stringify(
        await call(reader, "list_requests", {
          projectId: project,
          status: "pending",
        }),
      ).includes(request.id),
    );
    const preview = await call(reader, "review_request", {
      projectId: project,
      requestId: request.id,
    });
    assert.ok(
      JSON.stringify(preview).includes(
        Buffer.from("Review me").toString("base64"),
      ),
    );
    await assert.rejects(
      call(reader, "review_request", {
        projectId: project,
        requestId: request.id,
        decision: "approve",
        previewHash: "0".repeat(64),
        expectedPolicyRevision: afterPermission.policyRevision,
      }),
      /exact proposed/,
    );
    const reviewed = await call(reader, "review_request", {
      projectId: project,
      requestId: request.id,
      decision: "approve",
      previewHash: request.previewHash,
      expectedPolicyRevision: afterPermission.policyRevision,
    });
    assert.equal(reviewed.status, "approved");
    const sessionText = (message: string) =>
      [
        { type: "session_meta", payload: { id: "fixture-session" } },
        { type: "response_item", payload: { role: "user", content: message } },
        {
          type: "response_item",
          payload: {
            role: "assistant",
            channel: "analysis",
            content: "HIDDEN_ANALYSIS_MARKER",
          },
        },
        {
          type: "response_item",
          payload: {
            type: "function_call_output",
            output: "HIDDEN_TOOL_MARKER",
          },
        },
        {
          type: "response_item",
          payload: {
            role: "user",
            content:
              "<environment_context>HIDDEN_SETUP_MARKER</environment_context>",
          },
        },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n";
    const sessionId = randomUUID();
    const sessionResource = {
      resourceId: sessionId,
      kind: "session" as const,
      source: "codex" as const,
      logicalPath: `codex/${sessionId}.jsonl`,
      title: "Conflicting session",
      deleted: false,
    };
    await put(
      project,
      owner,
      sessionResource,
      sessionText("Original conversation"),
      "session.jsonl",
    );
    const divergence = await put(
      project,
      owner,
      sessionResource,
      sessionText("Candidate conversation " + "long ".repeat(5000)),
      "session.jsonl",
    );
    const inspected = await call(reader, "resolve_conflict", {
      projectId: project,
      resourceId: sessionId,
      action: "inspect",
    });
    assert.ok(JSON.stringify(inspected).includes("Original conversation"));
    assert.ok(JSON.stringify(inspected).includes("Candidate conversation"));
    assert.ok(!JSON.stringify(inspected).includes("HIDDEN_"));
    const candidates = inspected.conflicts as {
      id: string;
      candidate: { nextOffset: number };
    }[];
    assert.ok(candidates[0].candidate.nextOffset);
    await assert.rejects(
      call(reader, "resolve_conflict", {
        projectId: project,
        resourceId: sessionId,
        action: "inspect",
        offset: 20000,
      }),
      /revision missing/,
    );
    const continued = await call(reader, "resolve_conflict", {
      projectId: project,
      resourceId: sessionId,
      action: "inspect",
      offset: 20000,
      expectedRevision: divergence.event.revision,
    });
    assert.ok(JSON.stringify(continued).includes("long"));
    const resolution = {
      projectId: project,
      resourceId: sessionId,
      action: "accept",
      conflictId: candidates[0].id,
      selected: "candidate",
      expectedRevision: divergence.event.revision,
      requestId: randomUUID(),
    };
    await assert.rejects(
      call(teammate, "resolve_conflict", {
        ...resolution,
        requestId: randomUUID(),
      }),
      /Only the session owner/,
    );
    const resolved = await call(reader, "resolve_conflict", resolution);
    assert.deepEqual(
      await call(reader, "resolve_conflict", resolution),
      resolved,
    );
    await assert.rejects(
      call(reader, "resolve_conflict", { ...resolution, selected: "current" }),
      /Retry ID/,
    );
    const latestPolicy = await call(reader, "get_permissions", {
      projectId: project,
    });
    await call(reader, "update_permissions", {
      projectId: project,
      requestId: randomUUID(),
      expectedPolicyRevision: latestPolicy.policyRevision,
      action: "policy",
      category: "session",
      memberId: member,
      rule: { mode: "suggest", create: "suggest", canShare: false },
    });
    const proposedSessionId = randomUUID(),
      bytes = Buffer.from(sessionText("Proposed visible conversation")),
      hash = await store.blobs.put(project, bytes);
    await pool.query(
      "insert into orka.blobs values($1,$2,$3) on conflict do nothing",
      [project, hash, bytes.length],
    );
    await pool.query(
      "insert into orka.blob_uploads values($1,$2,$3) on conflict do nothing",
      [project, hash, member],
    );
    const sessionRequestId = randomUUID();
    await store.invoke("governance", {
      user: member,
      input: {
        action: "submit",
        input: {
          projectId: project,
          change: {
            version: 2,
            id: sessionRequestId,
            projectId: project,
            deviceId: member,
            baseRevision: 0,
            resource: {
              resourceId: proposedSessionId,
              kind: "session",
              source: "codex",
              logicalPath: `codex/${proposedSessionId}.jsonl`,
              title: "Proposed session",
              deleted: false,
              files: [
                {
                  path: "session.jsonl",
                  hash,
                  size: bytes.length,
                  executable: false,
                },
              ],
            },
          },
        },
      },
    });
    const sessionPreview = await call(reader, "review_request", {
      projectId: project,
      requestId: sessionRequestId,
    });
    assert.ok(
      JSON.stringify(sessionPreview).includes("Proposed visible conversation"),
    );
    assert.ok(!JSON.stringify(sessionPreview).includes("HIDDEN_"));
    assert.equal(sessionPreview.proposedFiles, undefined);
    // A legacy read token cannot perform a write, even for the project owner.
    const client = randomUUID(),
      family = randomUUID(),
      access = "A".repeat(43),
      refresh = "B".repeat(43);
    await pool.query("insert into orka.mcp_clients values($1,$2)", [
      client,
      { client_id: client, redirect_uris: ["http://localhost/callback"] },
    ]);
    await pool.query(
      "insert into orka.mcp_tokens(access_hash,refresh_hash,family,client_id,user_id,resource,access_expires_at,refresh_expires_at) values($1,$2,$3,$4,$5,$6,now()+interval '1 hour',now()+interval '1 day')",
      [
        tokenHash(access),
        tokenHash(refresh),
        family,
        client,
        owner,
        origin + "/mcp",
      ],
    );
    const rpcTool = async (token: string, name: string, args: object) => {
      const response = await fetch(origin + "/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
      assert.equal(response.status, 200);
      const payload = (await response.json()) as {
        result: {
          isError?: boolean;
          structuredContent?: Record<string, unknown>;
          _meta?: unknown;
        };
      };
      return payload.result;
    };
    const answer = await rpcTool(access, "create_memory", {
      ...input,
      requestId: randomUUID(),
    });
    assert.equal(answer.isError, true);
    assert.ok(JSON.stringify(answer).includes("insufficient_scope"));
    const scopedToken = async (scopes: string, marker: string) => {
      const token = marker.repeat(43),
        refreshToken = marker.toLowerCase().repeat(43);
      await pool.query(
        "insert into orka.mcp_tokens(access_hash,refresh_hash,family,client_id,user_id,resource,access_expires_at,refresh_expires_at,scopes) values($1,$2,$3,$4,$5,$6,now()+interval '1 hour',now()+interval '1 day',$7)",
        [
          tokenHash(token),
          tokenHash(refreshToken),
          randomUUID(),
          client,
          owner,
          origin + "/mcp",
          scopes,
        ],
      );
      return { token, refreshToken };
    };
    const writer = await scopedToken("orka.read orka.write", "C");
    const createdOverHTTP = await rpcTool(writer.token, "create_memory", {
      ...input,
      requestId: randomUUID(),
      title: "HTTP scoped memory",
    });
    assert.equal(createdOverHTTP.isError, undefined);
    assert.equal(createdOverHTTP.structuredContent?.status, "published");
    const rejectedManage = await rpcTool(writer.token, "review_request", {
      projectId: project,
      requestId: sessionRequestId,
    });
    assert.equal(rejectedManage.isError, true);
    assert.ok(JSON.stringify(rejectedManage).includes("insufficient_scope"));
    const manager = await scopedToken("orka.read orka.manage", "D");
    const inspectedOverHTTP = await rpcTool(manager.token, "review_request", {
      projectId: project,
      requestId: sessionRequestId,
    });
    assert.equal(inspectedOverHTTP.isError, undefined);
    assert.ok(
      JSON.stringify(inspectedOverHTTP).includes(
        "Proposed visible conversation",
      ),
    );
    const currentPermissions = await call(reader, "get_permissions", {
      projectId: project,
    });
    const updatedOverHTTP = await rpcTool(manager.token, "update_permissions", {
      projectId: project,
      requestId: randomUUID(),
      expectedPolicyRevision: currentPermissions.policyRevision,
      action: "policy",
      category: "plan",
      memberId: member,
      rule: { mode: "read", create: "hidden", canShare: false },
    });
    assert.equal(updatedOverHTTP.isError, undefined);
    assert.equal(
      updatedOverHTTP.structuredContent?.policyRevision,
      Number(currentPermissions.policyRevision) + 1,
    );
    const rejectedWrite = await rpcTool(manager.token, "create_memory", {
      ...input,
      requestId: randomUUID(),
    });
    assert.equal(rejectedWrite.isError, true);
    assert.ok(JSON.stringify(rejectedWrite).includes("insufficient_scope"));
    const oauth = new OrkaOAuth(
      store,
      origin,
      async (token) => token,
      settings,
    );
    await assert.rejects(
      oauth.exchangeRefreshToken(
        { client_id: client, redirect_uris: ["http://localhost/callback"] },
        refresh,
        ["orka.read", "orka.write"],
        new URL(origin + "/mcp"),
      ),
      /Refresh cannot add permissions/,
    );
    const rotated = await oauth.exchangeRefreshToken(
      { client_id: client, redirect_uris: ["http://localhost/callback"] },
      refresh,
      undefined,
      new URL(origin + "/mcp"),
    );
    assert.equal(rotated.scope, "orka.read");
    const reduced = await oauth.exchangeRefreshToken(
      { client_id: client, redirect_uris: ["http://localhost/callback"] },
      writer.refreshToken,
      ["orka.read"],
      new URL(origin + "/mcp"),
    );
    assert.equal(reduced.scope, "orka.read");
    const reducedAuth = await oauth.verifyAccessToken(reduced.access_token);
    assert.deepEqual(reducedAuth.scopes, ["orka.read"]);
    const deniedAfterReduction = await rpcTool(
      reduced.access_token,
      "create_memory",
      { ...input, requestId: randomUUID() },
    );
    assert.equal(deniedAfterReduction.isError, true);
    await assert.rejects(
      oauth.exchangeRefreshToken(
        { client_id: client, redirect_uris: ["http://localhost/callback"] },
        reduced.refresh_token!,
        ["orka.read", "orka.write"],
        new URL(origin + "/mcp"),
      ),
      /Refresh cannot add permissions/,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await store.close();
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("MCP catalog rechecks locked resources and bounds unreadable session content", async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const directory = await mkdtemp(join(tmpdir(), "orka-mcp-catalog-"));
  const store = new Store(
    pool,
    new Blobs(directory),
    acceptingMemoryResolver(),
  );
  const owner = randomUUID(),
    member = randomUUID();
  const project = await store.createProject(owner, "Catalog boundaries", true);
  await store.device(owner, owner, "Catalog fixture");
  await pool.query("insert into orka.members values($1,$2,'member')", [
    project,
    member,
  ]);
  const reader = new OrkaReader(store, owner, "https://catalog.example"),
    teammate = new OrkaReader(store, member, "https://catalog.example");
  const publish = async (
    kind: "memory" | "session",
    title: string,
    content: string,
  ) => {
    const resourceId = randomUUID(),
      bytes = Buffer.from(content),
      hash = await store.blobs.put(project, bytes);
    await pool.query(
      "insert into orka.blobs values($1,$2,$3) on conflict do nothing",
      [project, hash, bytes.length],
    );
    await pool.query(
      "insert into orka.blob_uploads values($1,$2,$3) on conflict do nothing",
      [project, hash, owner],
    );
    const resource: ResourceInput = {
      resourceId,
      kind,
      source: kind === "memory" ? "shared" : "codex",
      logicalPath:
        kind === "memory"
          ? `knowledge/${resourceId}.md`
          : `codex/${resourceId}.jsonl`,
      title,
      deleted: false,
      files: [
        {
          path: kind === "memory" ? "content.md" : "session.jsonl",
          hash,
          size: bytes.length,
          executable: false,
        },
      ],
      ...(kind === "memory"
        ? {
            memory: {
              topic: title,
              scope: "",
              provider: "manual",
              supersedes: [],
            },
          }
        : {}),
    };
    return store.mutate(owner, {
      version: 2,
      id: randomUUID(),
      projectId: project,
      deviceId: owner,
      baseRevision: 0,
      resource,
    });
  };
  try {
    const needle = await publish(
      "memory",
      "Accepted knowledge",
      "Find the catalog needle",
    );
    await assert.rejects(
      reader.run("create_memory", {
        projectId: project,
        requestId: needle.event.resource.resourceId,
        title: "Unexpected overwrite",
        text: "This must remain a separate new memory",
      }),
      /Resource ID already exists/,
    );
    const unchangedNeedle = (
      await pool.query(
        "select payload from orka.resources where project_id=$1 and id=$2",
        [project, needle.event.resource.resourceId],
      )
    ).rows[0].payload as { revision: number; title: string };
    assert.equal(unchangedNeedle.revision, needle.event.revision);
    assert.equal(unchangedNeedle.title, "Accepted knowledge");
    await publish(
      "session",
      "Large remote session",
      JSON.stringify({ type: "session_meta", payload: { id: "large" } }) +
        "\n" +
        JSON.stringify({
          type: "response_item",
          payload: { role: "user", content: "x".repeat(32_000_001) },
        }) +
        "\n",
    );
    await publish(
      "session",
      "Malformed native session",
      "not a supported native session\n",
    );
    const found = await reader.run("search_resources", {
      projectId: project,
      query: "catalog needle",
    });
    assert.ok(JSON.stringify(found).includes(needle.event.resource.resourceId));
    const large = (await reader.run("search_resources", {
      projectId: project,
      query: "Large remote session",
    })) as { items: { contentUnavailable?: boolean }[] };
    assert.equal(large.items.length, 1);
    assert.equal(large.items[0].contentUnavailable, true);
    const race = async (hide: boolean) => {
      const target = await publish(
        "memory",
        hide ? "Permission race" : "Deletion race",
        "SENSITIVE_RACE_CONTENT",
      );
      const resourceId = target.event.resource.resourceId;
      const lock = await pool.connect();
      let committed = false;
      try {
        await lock.query("begin");
        await lock.query(
          "select id from orka.projects where id=$1 for update",
          [project],
        );
        let done = false;
        const pending = (hide ? teammate : reader)
          .run("search_resources", {
            query: hide ? "Permission race" : "Deletion race",
          })
          .finally(() => {
            done = true;
          });
        const deadline = Date.now() + 5000;
        for (;;) {
          const waiting = await pool.query(
            "select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%from orka.projects%for share%' limit 1",
          );
          if (waiting.rowCount) break;
          assert.equal(
            done,
            false,
            "Catalog must wait for the project authorization lock",
          );
          assert.ok(
            Date.now() < deadline,
            "Catalog did not acquire the project read lock",
          );
          await new Promise((r) => setTimeout(r, 10));
        }
        if (hide)
          await lock.query(
            "insert into orka.resource_access values($1,$2,$3,$4) on conflict(project_id,resource_id,user_id) do update set rule=excluded.rule",
            [project, resourceId, member, { mode: "hidden", canShare: false }],
          );
        else
          await lock.query(
            "update orka.resources set payload=jsonb_set(payload,'{deleted}','true') where project_id=$1 and id=$2",
            [project, resourceId],
          );
        await lock.query("commit");
        committed = true;
        assert.ok(!JSON.stringify(await pending).includes(resourceId));
        if (!hide) {
          await assert.rejects(
            reader.run("get_resource_history", {
              projectId: project,
              resourceId,
            }),
            /Resource unavailable/,
          );
          await assert.rejects(
            reader.run("compare_revisions", {
              projectId: project,
              resourceId,
              fromRevision: target.event.revision,
              toRevision: target.event.revision,
            }),
            /Resource unavailable/,
          );
        }
      } finally {
        if (!committed) await lock.query("rollback");
        lock.release();
      }
    };
    await race(false);
    await race(true);
  } finally {
    await store.close();
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("MCP deletion-conflict receipts remain retryable only with current access", async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const directory = await mkdtemp(join(tmpdir(), "orka-mcp-deletion-retry-"));
  const store = new Store(
    pool,
    new Blobs(directory),
    acceptingMemoryResolver(),
  );
  const owner = randomUUID(),
    author = randomUUID();
  const project = await store.createProject(
    owner,
    "Deletion conflict retry",
    true,
  );
  await pool.query("insert into orka.members values($1,$2,'member')", [
    project,
    author,
  ]);
  await store.device(author, author, "Author fixture");
  const resourceId = randomUUID(),
    bytes = Buffer.from(
      JSON.stringify({
        type: "user",
        message: { content: "Original shared session" },
      }) + "\n",
    );
  const hash = await store.blobs.put(project, bytes);
  const resource: ResourceInput = {
    resourceId,
    kind: "session",
    source: "claude",
    logicalPath: `claude/${resourceId}.jsonl`,
    title: "Session pending deletion",
    deleted: false,
    files: [
      { path: "session.jsonl", hash, size: bytes.length, executable: false },
    ],
  };
  const reader = new OrkaReader(store, author, "https://retry.example");
  try {
    await pool.query("insert into orka.blobs values($1,$2,$3)", [
      project,
      hash,
      bytes.length,
    ]);
    await pool.query("insert into orka.blob_uploads values($1,$2,$3)", [
      project,
      hash,
      author,
    ]);
    await store.mutate(author, {
      version: 2,
      id: randomUUID(),
      projectId: project,
      deviceId: author,
      baseRevision: 0,
      resource,
    });
    const conflict = await store.mutate(author, {
      version: 2,
      id: randomUUID(),
      projectId: project,
      deviceId: author,
      baseRevision: 0,
      resource: { ...resource, deleted: true, files: [] },
    });
    const resolution = {
      projectId: project,
      resourceId,
      requestId: randomUUID(),
      expectedRevision: conflict.event.revision,
      conflictId: conflict.event.conflicts[0].id,
      action: "accept",
      selected: "candidate",
    };
    const result = (await reader.run("resolve_conflict", resolution)) as {
      event: { resource: { deleted: boolean } };
    };
    assert.equal(result.event.resource.deleted, true);
    assert.deepEqual(await reader.run("resolve_conflict", resolution), result);
    await assert.rejects(
      reader.run("resolve_conflict", { ...resolution, selected: "current" }),
      /Retry ID reused/,
    );
    await assert.rejects(
      reader.run("resolve_conflict", {
        ...resolution,
        requestId: randomUUID(),
      }),
      /Resource unavailable/,
    );
    await assert.rejects(
      reader.run("resolve_conflict", {
        projectId: project,
        resourceId,
        action: "inspect",
      }),
      /Resource unavailable/,
    );
    await pool.query("insert into orka.resource_access values($1,$2,$3,$4)", [
      project,
      resourceId,
      author,
      { mode: "hidden", canShare: false },
    ]);
    await assert.rejects(
      reader.run("resolve_conflict", resolution),
      /Receipt access denied/,
    );
    await pool.query(
      "delete from orka.resource_access where project_id=$1 and resource_id=$2 and user_id=$3",
      [project, resourceId, author],
    );
    await pool.query(
      "delete from orka.members where project_id=$1 and user_id=$2",
      [project, author],
    );
    await assert.rejects(
      reader.run("resolve_conflict", resolution),
      /Project access denied/,
    );
  } finally {
    await store.close();
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  }
});
