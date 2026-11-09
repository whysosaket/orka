import test from "node:test";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { defaultRolePolicies, type RolePolicies } from "@portable/protocol";
import { Store } from "../packages/server-core/src/store.js";
import { createApi } from "../packages/server-core/src/main.js";
import { acceptingMemoryResolver } from "../packages/server-core/src/testing/memory-fixtures.js";
import { Blobs, bytesHash } from "../packages/server-core/src/blobs.js";

await test("role policies: authorization, atomic rollback, replay, conflicts, access, membership and legacy migration", async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const home = await mkdtemp(join(tmpdir(), "orka-role-policy-"));
  const store = new Store(pool, new Blobs(home), acceptingMemoryResolver());
  const server = createApi(store, async (token) => token);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const owner = randomUUID(),
    member = randomUUID(),
    admin = randomUUID(),
    admin2 = randomUUID();
  const api = async (user: string, path: string, input?: unknown) => {
    const response = await fetch(origin + path, {
      signal: AbortSignal.timeout(10000),
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
  const projectIds: string[] = [];
  try {
    const created = await api(owner, "/v2/projects", {
      name: "Role policy contract",
      governance: 1,
      rolePolicies: 1,
    });
    assert.equal(created.status, 200);
    const projectId = created.value.id;
    projectIds.push(projectId);
    const action = (
      user: string,
      action: string,
      input: Record<string, unknown> = {},
    ) =>
      api(user, "/v2/governance/action", {
        action,
        input: { projectId, ...input },
      });
    for (const user of [member, admin, admin2]) {
      const invite = await api(owner, "/v2/invites", { projectId });
      assert.equal(
        (await api(user, "/v2/join", { token: invite.value.token })).status,
        200,
      );
      assert.equal(
        (await api(user, "/v2/join", { token: invite.value.token })).status,
        400,
      );
    }
    let baseline = (await action(owner, "role-policy")).value;
    assert.deepEqual(baseline.policies, defaultRolePolicies);
    const policies: RolePolicies = structuredClone(defaultRolePolicies);
    policies.member.memory = "add";
    policies.admin.session = "read";
    const input = {
      operationId: randomUUID(),
      expectedPolicyRevision: baseline.policyRevision,
      policies,
    };
    for (const user of [member, admin])
      assert.equal((await action(user, "save-role-policy", input)).status, 403);
    assert.deepEqual((await action(owner, "role-policy")).value, baseline);
    // A real database fault after all eight values were written must roll back
    // both the policy revision and values, not just the operation receipt.
    await pool.query(
      `create function orka.test_policy_rollback() returns trigger language plpgsql as $$ begin if new.project_id='${projectId}'::uuid then raise exception 'injected receipt failure'; end if; return new; end $$`,
    );
    await pool.query(
      "create trigger test_policy_rollback before insert on orka.policy_operations for each row execute function orka.test_policy_rollback()",
    );
    assert.equal((await action(owner, "save-role-policy", input)).status, 500);
    assert.deepEqual((await action(owner, "role-policy")).value, baseline);
    await pool.query(
      "drop trigger test_policy_rollback on orka.policy_operations",
    );
    await pool.query("drop function orka.test_policy_rollback()");
    // Drop the actual HTTP response only after the upstream service committed.
    const dropping = createServer((_request, response) => {
      void action(owner, "save-role-policy", input)
        .then((result) => {
          assert.equal(result.status, 200);
          response.destroy();
        })
        .catch((error: Error) => {
          response.destroy(error);
        });
    });
    await new Promise<void>((resolve) =>
      dropping.listen(0, "127.0.0.1", resolve),
    );
    const dropAddress = dropping.address();
    assert.ok(dropAddress && typeof dropAddress !== "string");
    try {
      await assert.rejects(
        fetch(`http://127.0.0.1:${dropAddress.port}`, { method: "POST" }),
      );
    } finally {
      dropping.closeAllConnections();
      await new Promise<void>((resolve) => dropping.close(() => resolve()));
    }
    const confirmed = (
      await action(owner, "policy-operation", {
        operationId: input.operationId,
      })
    ).value;
    const { status: _status, ...confirmedValue } = confirmed;
    const saved = { status: 200, value: confirmedValue };
    assert.equal(_status, "committed");
    const checked = await action(owner, "policy-operation", {
      operationId: input.operationId,
    });
    assert.equal(checked.value.status, "committed");
    assert.deepEqual(checked.value.policies, policies);
    const replay = await action(owner, "save-role-policy", input);
    assert.deepEqual(replay.value, saved.value);
    assert.equal(saved.value.policyRevision, baseline.policyRevision + 1);
    assert.equal(
      (
        await action(owner, "save-role-policy", {
          ...input,
          policies: defaultRolePolicies,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await action(owner, "save-role-policy", {
          ...input,
          operationId: randomUUID(),
        })
      ).status,
      409,
    );
    assert.equal(
      Number(
        (
          await pool.query(
            "select count(*) from orka.policy_operations where project_id=$1",
            [projectId],
          )
        ).rows[0].count,
      ),
      1,
    );
    baseline = (await action(owner, "role-policy")).value;
    // Two real clients race the same revision. The project row lock must let
    // exactly one commit and leave a single receipt for that winning save.
    const concurrent = await Promise.all(
      ["read", "none"].map((access) => {
        const draft = structuredClone(baseline.policies);
        draft.member.skill = access;
        return action(owner, "save-role-policy", {
          operationId: randomUUID(),
          expectedPolicyRevision: baseline.policyRevision,
          policies: draft,
        });
      }),
    );
    assert.deepEqual(
      concurrent.map((result) => result.status).sort(),
      [200, 409],
    );
    const winner = concurrent.find((result) => result.status === 200)!;
    assert.equal(winner.value.policyRevision, baseline.policyRevision + 1);
    assert.deepEqual(
      (await action(owner, "role-policy")).value.policies,
      winner.value.policies,
    );
    baseline = (await action(owner, "role-policy")).value;
    assert.equal(
      (
        await action(member, "member-role", {
          userId: member,
          role: "admin",
          expectedPolicyRevision: baseline.policyRevision,
        })
      ).status,
      403,
    );
    for (const userId of [admin, admin2]) {
      const current = (await action(owner, "role-policy")).value;
      assert.equal(
        (
          await action(owner, "member-role", {
            userId,
            role: "admin",
            expectedPolicyRevision: current.policyRevision,
          })
        ).status,
        200,
      );
    }
    let revision = (await action(owner, "role-policy")).value.policyRevision;
    for (const userId of [owner, admin2])
      assert.equal(
        (
          await action(admin, "remove-member", {
            userId,
            expectedPolicyRevision: revision,
          })
        ).status,
        400,
      );
    assert.equal(
      (
        await action(admin, "member-role", {
          userId: member,
          role: "admin",
          expectedPolicyRevision: revision,
        })
      ).status,
      403,
    );
    assert.equal((await api(admin, "/v2/invites", { projectId })).status, 200);
    assert.equal((await api(member, "/v2/invites", { projectId })).status, 403);
    // Each mode across all four categories, checked at the authorization boundary
    // with real membership, persisted policies, own and another author's content.
    for (const user of [owner, member, admin])
      await store.device(user, user, "Policy test Mac");
    const upload = async (
      project: string,
      text: string,
      path = "content.md",
      actor = member,
    ) => {
      const bytes = Buffer.from(text),
        hash = bytesHash(bytes);
      const response = await fetch(`${origin}/v2/blobs/${project}/${hash}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${actor}`,
          "X-Orka-Governance": "1",
        },
        body: bytes,
      });
      assert.equal(response.status, 200);
      return { path, hash, size: bytes.length, executable: false };
    };
    const categories = ["memory", "session", "plan", "skill"] as const;
    for (const level of ["none", "read", "add", "write"] as const) {
      const policies = structuredClone(defaultRolePolicies);
      for (const category of categories) policies.member[category] = level;
      revision = (await action(owner, "role-policy")).value.policyRevision;
      assert.equal(
        (
          await action(owner, "save-role-policy", {
            operationId: randomUUID(),
            expectedPolicyRevision: revision,
            policies,
          })
        ).status,
        200,
      );
      for (const category of categories) {
        const candidateId = randomUUID();
        const candidate = {
          version: 2,
          id: randomUUID(),
          projectId,
          deviceId: member,
          baseRevision: 0,
          resource: {
            resourceId: candidateId,
            kind: category,
            source:
              category === "plan" || category === "session"
                ? "codex"
                : "shared",
            logicalPath:
              category === "memory"
                ? `instructions/${candidateId}/AGENTS.md`
                : category === "skill"
                  ? `skill-${candidateId}`
                  : `codex/${candidateId}.${category === "session" ? "jsonl" : "md"}`,
            title: "HTTP permission fixture",
            deleted: false,
            files: [
              await upload(
                projectId,
                "Original shared content",
                category === "skill"
                  ? "SKILL.md"
                  : category === "session"
                    ? "session.jsonl"
                    : "content.md",
              ),
            ],
          },
        };
        const publication = await api(member, "/v2/sync/push", candidate);
        assert.equal(
          publication.status,
          level === "add" || level === "write" ? 200 : 403,
          `${category}/${level} HTTP create: ${JSON.stringify(publication.value)}`,
        );
        if (publication.status === 200) {
          const edit = await api(member, "/v2/sync/push", {
            ...candidate,
            id: randomUUID(),
            baseRevision: publication.value.event.revision,
            resource: {
              ...candidate.resource,
              files: [
                await upload(
                  projectId,
                  "Edited own shared content",
                  candidate.resource.files[0].path,
                ),
              ],
            },
          });
          assert.equal(
            edit.status,
            level === "write" ? 200 : 403,
            `${category}/${level} HTTP edit`,
          );
          const deletion = await api(member, "/v2/sync/push", {
            ...candidate,
            id: randomUUID(),
            baseRevision:
              edit.status === 200
                ? edit.value.event.revision
                : publication.value.event.revision,
            resource: { ...candidate.resource, deleted: true, files: [] },
          });
          assert.equal(
            deletion.status,
            403,
            `${category}/${level} Member deletion`,
          );
          if (level === "write") {
            const otherEdit = await api(admin, "/v2/sync/push", {
              ...candidate,
              id: randomUUID(),
              deviceId: admin,
              baseRevision: edit.value.event.revision,
              resource: {
                ...candidate.resource,
                files: [
                  await upload(
                    projectId,
                    "Another author edited this",
                    candidate.resource.files[0].path,
                    admin,
                  ),
                ],
              },
            });
            assert.equal(
              otherEdit.status,
              category === "session" ? 403 : 200,
              `${category} authorship boundary`,
            );
            const actor = category === "memory" ? owner : admin;
            if (category === "session") {
              const rewrittenDelete = await api(actor, "/v2/sync/push", {
                ...candidate,
                id: randomUUID(),
                deviceId: actor,
                baseRevision: edit.value.event.revision,
                resource: {
                  ...candidate.resource,
                  deleted: true,
                  files: [
                    await upload(
                      projectId,
                      "Rewritten history during deletion",
                      candidate.resource.files[0].path,
                      actor,
                    ),
                  ],
                },
              });
              assert.equal(rewrittenDelete.status, 400);
            }
            const removal = await api(actor, "/v2/sync/push", {
              ...candidate,
              id: randomUUID(),
              deviceId: actor,
              baseRevision:
                otherEdit.status === 200
                  ? otherEdit.value.event.revision
                  : edit.value.event.revision,
              resource: { ...candidate.resource, deleted: true, files: [] },
            });
            assert.equal(
              removal.status,
              200,
              `${category} authorized deletion: ${JSON.stringify(removal.value)}`,
            );
            assert.equal(
              removal.value.event.resource.owner,
              member,
              "Deleting shared history never rewrites its authorship",
            );
            if (category === "session") {
              const snapshot = await pool.query(
                "select payload from orka.snapshots where project_id=$1 and resource_id=$2 and revision=$3",
                [
                  projectId,
                  candidate.resource.resourceId,
                  edit.value.event.revision,
                ],
              );
              assert.deepEqual(
                snapshot.rows[0].payload.files,
                edit.value.event.resource.files,
              );
              assert.equal(
                removal.value.event.resource.title,
                edit.value.event.resource.title,
              );
            }
          }
        }
        const resourceId = randomUUID();
        const resource = {
          resourceId,
          projectId,
          kind: category,
          owner,
          source:
            category === "plan" || category === "session" ? "codex" : "shared",
          logicalPath: `test/${resourceId}`,
          files: [],
          revision: 1,
          title: category,
          deleted: false,
        };
        await pool.query("insert into orka.resources values($1,$2,1,$3)", [
          projectId,
          resourceId,
          resource,
        ]);
        const access = await store.permissions.access(
          member,
          projectId,
          resource,
        );
        assert.equal(
          access.mode,
          level === "write" ? "publish" : level === "read" ? "read" : "hidden",
          `${category}/${level} others`,
        );
        assert.equal(
          access.create,
          level === "add" || level === "write" ? "publish" : "hidden",
          `${category}/${level} create`,
        );
        await pool.query(
          "update orka.resources set payload=jsonb_set(payload,'{owner}',to_jsonb($3::text)) where project_id=$1 and id=$2",
          [projectId, resourceId, member],
        );
        assert.equal(
          (
            await store.permissions.access(member, projectId, {
              ...resource,
              owner: member,
            })
          ).mode,
          level === "write" ? "publish" : level === "none" ? "hidden" : "read",
          `${category}/${level} own`,
        );
        const pull = await api(
          member,
          `/v2/sync/pull?projectId=${projectId}&cursor=0&governance=1&policyRevision=0`,
        );
        assert.equal(pull.status, 200);
        assert.equal(
          pull.value.events.some(
            (e: { resource: { resourceId: string } }) =>
              e.resource.resourceId === resourceId,
          ),
          level !== "none",
        );
      }
    }
    revision = (await action(owner, "role-policy")).value.policyRevision;
    assert.equal(
      (
        await action(admin, "remove-member", {
          userId: member,
          expectedPolicyRevision: revision,
        })
      ).status,
      200,
    );
    assert.equal((await action(member, "catalog")).status, 403);
    assert.equal(
      (
        await api(
          member,
          `/v2/sync/pull?projectId=${projectId}&cursor=0&governance=1&policyRevision=0`,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await action(owner, "leave-project", {
          expectedPolicyRevision: revision + 1,
        })
      ).status,
      403,
    );
    // Legacy data stays untouched until the exact reviewed diff is confirmed.
    const transferRevision = (await action(owner, "role-policy")).value
      .policyRevision;
    assert.equal(
      (
        await action(admin, "transfer-ownership", {
          userId: admin2,
          expectedPolicyRevision: transferRevision,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await action(owner, "transfer-ownership", {
          userId: admin2,
          expectedPolicyRevision: transferRevision,
        })
      ).status,
      200,
    );
    assert.equal((await action(admin2, "role-policy")).value.owner, true);
    assert.equal((await action(owner, "role-policy")).value.role, "member");
    assert.equal(
      (
        await action(owner, "member-role", {
          userId: admin,
          role: "member",
          expectedPolicyRevision: transferRevision + 1,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await action(owner, "leave-project", {
          expectedPolicyRevision: transferRevision + 1,
        })
      ).status,
      200,
    );
    const legacy = await store.createProject(owner, "Legacy mixed rules", true);
    projectIds.push(legacy);
    await pool.query("insert into orka.members values($1,$2,'member')", [
      legacy,
      member,
    ]);
    await pool.query(
      "insert into orka.member_policy values($1,$2,'instructions',$3)",
      [legacy, member, { mode: "suggest", create: "suggest", canShare: false }],
    );
    const legacyAction = (
      action: string,
      input: Record<string, unknown> = {},
    ) =>
      api(owner, "/v2/governance/action", {
        action,
        input: { projectId: legacy, ...input },
      });
    const pendingResource = randomUUID();
    const proposed = {
      version: 2,
      id: randomUUID(),
      projectId: legacy,
      deviceId: member,
      baseRevision: 0,
      resource: {
        resourceId: pendingResource,
        kind: "memory",
        source: "shared",
        logicalPath: `instructions/${pendingResource}/AGENTS.md`,
        title: "Pending legacy proposal",
        deleted: false,
        files: [await upload(legacy, "Preserve this reviewed proposal")],
      },
    };
    const submitted = await api(member, "/v2/governance/action", {
      action: "submit",
      input: { projectId: legacy, change: proposed },
    });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.value));
    const restricted = randomUUID();
    const derived = randomUUID();
    const legacySource = {
      resourceId: restricted,
      projectId: legacy,
      kind: "plan",
      source: "claude",
      logicalPath: "claude/legacy-source.md",
      title: "Restricted source",
      deleted: false,
      revision: 1,
      owner,
      updatedBy: owner,
      updatedAt: new Date().toISOString(),
      hash: "a".repeat(64),
      files: [
        await upload(legacy, "Restricted source content", "content.md", owner),
      ],
    };
    const legacyDerived = {
      ...legacySource,
      resourceId: derived,
      logicalPath: "claude/legacy-derived.md",
      title: "Derived content",
      contextSources: [restricted],
    };
    for (const resource of [legacySource, legacyDerived])
      await pool.query("insert into orka.resources values($1,$2,1,$3)", [
        legacy,
        resource.resourceId,
        resource,
      ]);
    await pool.query("insert into orka.resource_access values($1,$2,$3,$4)", [
      legacy,
      restricted,
      member,
      { mode: "hidden", canShare: false },
    ]);
    const preview = (await legacyAction("migration-preview")).value;
    assert.equal(
      await store.permissions.canRead(member, legacy, restricted, pool),
      false,
    );
    assert.equal(
      await store.permissions.canRead(member, legacy, derived, pool),
      false,
    );
    assert.equal(
      await store.permissions.canRead(owner, legacy, derived, pool),
      true,
    );
    assert.equal(preview.previous.pending.length, 1);
    assert.equal(preview.retainedRestrictions.length, 1);
    assert.equal(preview.previous.memberRules[0].rule.mode, "suggest");
    const migrateInput = {
      operationId: randomUUID(),
      expectedPolicyRevision: preview.policyRevision,
      policies: defaultRolePolicies,
    };
    assert.equal(
      (await legacyAction("save-role-policy", migrateInput)).status,
      409,
    );
    assert.equal((await legacyAction("role-policy")).value.policies, null);
    await pool.query(
      `create function orka.test_policy_rollback() returns trigger language plpgsql as $$ begin if new.project_id='${legacy}'::uuid then raise exception 'injected migration failure'; end if; return new; end $$`,
    );
    await pool.query(
      "create trigger test_policy_rollback before insert on orka.policy_operations for each row execute function orka.test_policy_rollback()",
    );
    assert.equal(
      (
        await legacyAction("save-role-policy", {
          ...migrateInput,
          migrationHash: preview.migrationHash,
        })
      ).status,
      500,
    );
    assert.equal((await legacyAction("role-policy")).value.policies, null);
    assert.equal(
      (
        await pool.query(
          "select rule->>'mode' as mode from orka.member_policy where project_id=$1 and class='instructions'",
          [legacy],
        )
      ).rows[0].mode,
      "suggest",
    );
    assert.equal(
      (
        await pool.query(
          "select count(*) from orka.policy_migrations where project_id=$1",
          [legacy],
        )
      ).rows[0].count,
      "0",
    );
    assert.equal(
      (await legacyAction("requests")).value[0].policyRevision,
      preview.policyRevision,
    );
    await pool.query(
      "drop trigger test_policy_rollback on orka.policy_operations",
    );
    await pool.query("drop function orka.test_policy_rollback()");
    assert.equal(
      (
        await legacyAction("save-role-policy", {
          ...migrateInput,
          migrationHash: preview.migrationHash,
        })
      ).status,
      200,
    );
    const reviews = (await legacyAction("requests")).value;
    assert.equal(
      await store.permissions.canRead(member, legacy, restricted, pool),
      false,
    );
    assert.equal(
      await store.permissions.canRead(member, legacy, derived, pool),
      false,
    );
    assert.equal(
      await store.permissions.canRead(owner, legacy, derived, pool),
      true,
    );
    assert.equal(
      reviews.find(
        (request: { id: string }) => request.id === submitted.value.id,
      ).status,
      "pending",
    );
    const approved = await legacyAction("decide", {
      id: submitted.value.id,
      decision: "approve",
      previewHash: submitted.value.previewHash,
      expectedPolicyRevision: preview.policyRevision + 1,
    });
    assert.equal(approved.status, 200, JSON.stringify(approved.value));
    assert.equal(approved.value.status, "approved");
    assert.equal(
      (
        await pool.query(
          "select count(*) from orka.resource_access where project_id=$1 and resource_id=$2",
          [legacy, restricted],
        )
      ).rows[0].count,
      "1",
    );
    assert.equal(
      (
        await legacyAction("policy", {
          class: "memory",
          rule: { mode: "publish", create: "publish", canShare: false },
          expectedPolicyRevision: preview.policyRevision + 1,
        })
      ).status,
      409,
    );
    const older = await fetch(
      `${origin}/v2/sync/pull?projectId=${legacy}&cursor=0`,
      { headers: { Authorization: `Bearer ${member}` } },
    );
    assert.equal(older.status, 409);
  } finally {
    await pool.query(
      "drop trigger if exists test_policy_rollback on orka.policy_operations",
    );
    await pool.query("drop function if exists orka.test_policy_rollback()");
    for (const id of projectIds)
      await pool.query("delete from orka.projects where id=$1", [id]);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
    await rm(home, { recursive: true, force: true });
  }
});

await test("restriction catalogs keep other people's records private for Members and Admins", async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const home = await mkdtemp(join(tmpdir(), "orka-restriction-catalog-"));
  const store = new Store(pool, new Blobs(home), acceptingMemoryResolver());
  const server = createApi(store, async (token) => token);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const owner = randomUUID(),
    member = randomUUID(),
    admin = randomUUID();
  const projects: string[] = [];
  const catalog = async (user: string, projectId: string) => {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/v2/governance/action`,
      {
        method: "POST",
        signal: AbortSignal.timeout(10000),
        headers: {
          Authorization: `Bearer ${user}`,
          "Content-Type": "application/json",
          "X-Orka-Governance": "1",
        },
        body: JSON.stringify({ action: "catalog", input: { projectId } }),
      },
    );
    return { status: response.status, value: await response.json() };
  };
  try {
    for (const roles of [true, false]) {
      const project = await store.createProject(
        owner,
        "Restriction privacy",
        true,
        undefined,
        undefined,
        roles,
      );
      projects.push(project);
      const people = roles ? [member, admin] : [member];
      for (const user of people) {
        await pool.query("insert into orka.members values($1,$2,$3)", [
          project,
          user,
          user === admin ? "admin" : "member",
        ]);
        await pool.query(
          "insert into orka.resource_access values($1,$2,$3,$4)",
          [project, randomUUID(), user, { mode: "hidden", canShare: false }],
        );
      }
      const complete = await catalog(owner, project);
      assert.equal(complete.status, 200);
      assert.equal(complete.value.resourceRules.length, people.length);
      for (const user of people) {
        const result = await catalog(user, project);
        assert.equal(result.status, 200);
        assert.deepEqual(
          result.value.resourceRules,
          roles
            ? complete.value.resourceRules.filter(
                (rule: { userId: string }) => rule.userId === user,
              )
            : [],
        );
      }
      assert.equal((await catalog(randomUUID(), project)).status, 403);
    }
  } finally {
    for (const id of projects)
      await pool.query("delete from orka.projects where id=$1", [id]);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
    await rm(home, { recursive: true, force: true });
  }
});

await test(
  "isolated native Macs persist profiles, separate local sharing/names, block queued disconnect and revoked writes, and keep private files",
  { skip: !process.env.ORKA_ENV_NATIVE_BIN },
  async () => {
    const { startEnvMac } =
      await import("../packages/server-core/src/testing/env-native.js");
    const { DatabaseSync } = await import("node:sqlite");
    const { mkdir, writeFile, readFile } = await import("node:fs/promises");
    const { createHash } = await import("node:crypto");
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const home = await mkdtemp(join(tmpdir(), "orka-settings-native-"));
    const store = new Store(
      pool,
      new Blobs(join(home, "server")),
      acceptingMemoryResolver(),
    );
    const server = createApi(store, async (token) => token);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}`;
    const owner = randomUUID(),
      member = randomUUID(),
      project = await store.createProject(
        owner,
        "Native Settings contract",
        true,
        undefined,
        undefined,
        true,
      );
    await pool.query("insert into orka.members values($1,$2,'member')", [
      project,
      member,
    ]);
    const macs: Awaited<ReturnType<typeof startEnvMac>>[] = [];
    try {
      const a = await startEnvMac({
        home,
        name: "owner",
        user: owner,
        url,
        project,
        enable: false,
      });
      macs.push(a);
      const b = await startEnvMac({
        home,
        name: "member-a",
        user: member,
        url,
        project,
        enable: false,
      });
      macs.push(b);
      const c = await startEnvMac({
        home,
        name: "member-b",
        user: member,
        url,
        project,
        enable: false,
      });
      macs.push(c);
      for (const mac of macs) await mac.request({ action: "sync" });
      const context = { user: owner, service: url };
      const profile = await a.request<{ displayName: string }>({
        action: "onboarding",
        operation: "save-settings-profile",
        input: {
          displayName: "Native Owner",
          jobRole: "Admin",
          avatarData: null,
          avatarUrl: null,
        },
        context,
      });
      assert.equal(profile.displayName, "Native Owner");
      assert.equal(
        (
          await a.request<{ displayName: string }>({
            action: "onboarding",
            operation: "profile",
            input: {},
            context,
          })
        ).displayName,
        "Native Owner",
      );
      await assert.rejects(
        a.request({
          action: "onboarding",
          operation: "save-settings-profile",
          input: { displayName: "", jobRole: "Owner" },
          context,
        }),
      );
      await assert.rejects(
        a.request({
          action: "onboarding",
          operation: "save-settings-profile",
          input: {
            displayName: "Corrupt",
            avatarData:
              "data:image/png;base64," +
              Buffer.from("corrupt").toString("base64"),
          },
          context,
        }),
      );
      const policy = await a.request<{ role: string; policyRevision: number }>({
        action: "governance",
        operation: "role-policy",
        input: { projectId: project },
      });
      assert.equal(
        policy.role,
        "owner",
        "Descriptive job role cannot grant or replace project authority",
      );
      await b.request({
        action: "project",
        operation: "local_name",
        input: { projectId: project, name: "My Mac name" },
      });
      await a.request({
        action: "project",
        operation: "rename",
        input: {
          projectId: project,
          name: "Shared rename",
          requestId: randomUUID(),
          expectedRevision: 0,
        },
      });
      await b.request({ action: "sync" });
      await c.request({ action: "sync" });
      const getSnapshot = (mac: typeof a) =>
        mac.request<{
          projects: {
            id: string;
            name: string;
            localName?: string;
            sharing?: Record<string, boolean>;
            sources: { id: string; path?: string }[];
          }[];
          deviceId: string;
          outbox: { id: string }[];
        }>({ action: "snapshot" });
      let bs = await getSnapshot(b),
        cs = await getSnapshot(c);
      assert.equal(bs.projects[0].name, "Shared rename");
      assert.equal(bs.projects[0].localName, "My Mac name");
      assert.equal(cs.projects[0].localName ?? null, null);
      await b.request({
        action: "project",
        operation: "local_name",
        input: { projectId: project, name: null },
      });
      const sharing = {
        memory: false,
        session: false,
        plan: true,
        skill: false,
        env: false,
      };
      await b.request({
        action: "project",
        operation: "sharing",
        input: { projectId: project, sharing },
      });
      await c.request({
        action: "project",
        operation: "sharing",
        input: { projectId: project, sharing: { ...sharing, plan: false } },
      });
      bs = await getSnapshot(b);
      cs = await getSnapshot(c);
      assert.equal(bs.projects[0].sharing?.plan, true);
      assert.equal(cs.projects[0].sharing?.plan, false);
      assert.notEqual(bs.deviceId, cs.deviceId);
      const root = join(b.root, "orka");
      const database = new DatabaseSync(
        join(
          root,
          "services",
          createHash("sha256").update(url).digest("hex"),
          member,
          "sync.sqlite",
        ),
      );
      const enqueue = async (text: string) => {
        const resourceId = randomUUID(),
          id = randomUUID(),
          bytes = Buffer.from(text),
          hash = bytesHash(bytes),
          path = join(b.path, `${resourceId}.md`);
        await mkdir(join(root, "blobs"), { recursive: true });
        await writeFile(join(root, "blobs", hash), bytes);
        await writeFile(path, bytes);
        const resource = {
          resourceId,
          sourceId: bs.projects[0].sources[0].id,
          kind: "plan",
          source: "claude",
          logicalPath: `claude/${resourceId}.md`,
          title: "Offline plan",
          deleted: false,
          files: [
            { path: "content.md", hash, size: bytes.length, executable: false },
          ],
        };
        const change = {
          version: 2,
          id,
          projectId: project,
          deviceId: bs.deviceId,
          baseRevision: 0,
          resource,
        };
        database.prepare("insert into resources values(?,?,?)").run(
          resourceId,
          project,
          JSON.stringify({
            ...resource,
            projectId: project,
            revision: 0,
            owner: member,
          }),
        );
        database.prepare("insert into bindings values(?,?,?)").run(
          resourceId,
          project,
          JSON.stringify({
            paths: [path],
            base: {
              ...resource,
              projectId: project,
              revision: 0,
              owner: member,
            },
          }),
        );
        database
          .prepare("insert into outbox values(?,?,?,?,null)")
          .run(id, project, "/v2/sync/push", JSON.stringify(change));
        return { resourceId, id, path, text };
      };
      const allowed = await enqueue("Allowed queued plan\n");
      await b.request({ action: "sync" });
      assert.ok(
        (
          await pool.query(
            "select id from orka.resources where project_id=$1 and id=$2",
            [project, allowed.resourceId],
          )
        ).rows[0],
        JSON.stringify(await getSnapshot(b)),
      );
      assert.equal(
        (
          await pool.query(
            "select payload->>'owner' as owner from orka.resources where project_id=$1 and id=$2",
            [project, allowed.resourceId],
          )
        ).rows[0].owner,
        member,
      );
      assert.equal((await getSnapshot(b)).outbox.length, 0);
      const offline = await enqueue("Keep my offline private plan\n");
      await assert.rejects(
        b.request({
          action: "disconnect-source",
          projectId: project,
          sourceId: bs.projects[0].sources[0].id,
        }),
        /queued/i,
      );
      assert.equal(await readFile(offline.path, "utf8"), offline.text);
      const revision = (
        await a.request<{ policyRevision: number }>({
          action: "governance",
          operation: "role-policy",
          input: { projectId: project },
        })
      ).policyRevision;
      await a.request({
        action: "governance",
        operation: "remove-member",
        input: {
          projectId: project,
          userId: member,
          expectedPolicyRevision: revision,
        },
      });
      await b.request({ action: "sync" });
      assert.equal(
        (
          await pool.query(
            "select count(*) from orka.resources where project_id=$1 and id=$2",
            [project, offline.resourceId],
          )
        ).rows[0].count,
        "0",
      );
      assert.equal(await readFile(offline.path, "utf8"), offline.text);
      assert.ok(
        database.prepare("select id from drafts where project=?").all(project)
          .length > 0,
        "Revocation preserves the queued change as private work",
      );
      await assert.rejects(
        b.request({
          action: "governance",
          operation: "save-role-policy",
          input: {
            projectId: project,
            operationId: randomUUID(),
            expectedPolicyRevision: revision,
            policies: defaultRolePolicies,
          },
        }),
      );
      database.close();
      const devices = await a.request<
        { id: string; hardwareFamily?: string }[]
      >({ action: "settings", operation: "devices", context });
      assert.ok(
        devices.some(
          (device) =>
            device.hardwareFamily &&
            [
              "laptop",
              "all-in-one",
              "mac-mini",
              "mac-studio",
              "mac-pro",
              "generic",
            ].includes(device.hardwareFamily),
        ),
      );
      await a.request({ action: "logout" });
      const signedOut = await a.request<{ user: string | null }>({
        action: "snapshot",
      });
      assert.equal(signedOut.user, null);
      assert.equal(await readFile(offline.path, "utf8"), offline.text);
    } finally {
      for (const mac of macs) await mac.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.query("delete from orka.projects where id=$1", [project]);
      await pool.end();
      await rm(home, { recursive: true, force: true });
    }
  },
);
