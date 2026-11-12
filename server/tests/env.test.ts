import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  envCanonical,
  envVersion,
  isEnvPath,
  validateEnvTransition,
} from "@portable/protocol";
import { identity, version } from "./fixtures/env-fixtures.js";

await test("ENV format rejects malformed keys and keeps ordinary resource types separate", () => {
  const a = identity(),
    v = version(a, randomUUID());
  assert.deepEqual(envVersion.parse(v), v);
  assert.equal(
    envVersion.safeParse({
      ...v,
      manifest: {
        ...v.manifest,
        devices: [{ ...a.device, signingKey: "secret" }],
      },
    }).success,
    false,
  );
  for (const path of [
    ".env",
    "scripts/.env.production",
    "config/local.env",
    ".ENV.local",
    ".env.example",
  ])
    assert.equal(isEnvPath(path), true);
  for (const path of [
    "SKILL.md",
    "references/environment.md",
    "scripts/setup.sh",
  ])
    assert.equal(isEnvPath(path), false);
});
await test("signed ENV fixture uses the canonical protocol encoding", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL(
        import.meta.resolve("@portable/protocol/fixtures/env-signature.json"),
      ),
      "utf8",
    ),
  );
  assert.equal(envCanonical(fixture.value), fixture.canonical);
});
await test("ENV authorization preserves creator control and allows recipients to publish", () => {
  const a = identity(),
    b = identity(),
    project = randomUUID();
  const first = version(a, project, {
    grants: [a.device.owner, b.device.owner],
  });
  validateEnvTransition(undefined, first.manifest);
  const request = {
    format: 1 as const,
    projectId: project,
    setId: first.manifest.setId,
    device: b.device,
    nonce: randomUUID(),
    expiresAt: Date.now() + 60_000,
  };
  const granted = version(
    a,
    project,
    {
      devices: [a.device, b.device],
      approvals: [{ request, signature: b.signature(request) }],
    },
    first,
  );
  validateEnvTransition(first.manifest, granted.manifest);
  const changed = version(b, project, {}, granted);
  validateEnvTransition(granted.manifest, changed.manifest);
  assert.throws(() =>
    validateEnvTransition(
      granted.manifest,
      version(b, project, { grants: [b.device.owner] }, granted).manifest,
    ),
  );
  assert.throws(() =>
    validateEnvTransition(
      granted.manifest,
      version(b, project, { deleted: true }, granted).manifest,
    ),
  );
  assert.throws(() =>
    validateEnvTransition(
      granted.manifest,
      version(b, project, { devices: [b.device] }, granted).manifest,
    ),
  );
  assert.throws(() =>
    validateEnvTransition(
      granted.manifest,
      version(
        a,
        project,
        {
          devices: [{ ...a.device, signingKey: b.device.signingKey }, b.device],
        },
        granted,
      ).manifest,
    ),
  );
  assert.throws(() =>
    validateEnvTransition(granted.manifest, {
      ...changed.manifest,
      accessRevision: 99,
    }),
  );
});
