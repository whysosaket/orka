import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Snapshot } from "../apps/mac/src/types.js";

const home = await mkdtemp(join(tmpdir(), "orka-profiles-"));
const executable = resolve(
  "apps/mac/src-tauri/target/debug/portable-workspace-mac",
);
const names = ["alice", "bob", "default"];
const env = (name: string) => ({
  ...process.env,
  ORKA_TEST_HOME: home,
  ORKA_PROFILE: name,
  CODEX_HOME: join(home, ".codex"),
  CLAUDE_CONFIG_DIR: join(home, ".claude"),
});
const rpc = <T = Snapshot>(name: string, input: unknown): T => {
  const result = spawnSync(executable, ["--orka-test"], {
    env: env(name),
    input: JSON.stringify(input),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as T;
};
const daemons: ChildProcess[] = [];
try {
  const user = randomUUID();
  const info = names.map((name, i) => {
    rpc(name, {
      action: "configure",
      config: {
        apiUrl: "http://127.0.0.1:59998",
        mode: "self-hosted",
        syncMinutes: i + 1,
      },
    });
    rpc(name, {
      action: "test-session",
      session: {
        user: { id: user },
        access_token: "isolated-fixture",
        refresh_token: "isolated-fixture",
      },
    });
    return rpc<Record<string, string>>(name, { action: "profile-info" });
  });
  for (const key of ["root", "keychain", "agent"])
    assert.equal(
      new Set(info.map((value) => value[key])).size,
      3,
      `${key} must be isolated`,
    );
  assert.equal(
    info[2].root,
    join(home, "orka"),
    "Default keeps the existing storage path",
  );
  const snapshots = names.map((name) => rpc(name, { action: "snapshot" }));
  assert.equal(new Set(snapshots.map((s) => s.deviceId)).size, 3);
  assert.deepEqual(
    snapshots.map((s) => s.config?.syncMinutes),
    [1, 2, 3],
  );
  assert.deepEqual(
    snapshots.map((s) => s.background),
    [false, false, false],
  );
  assert.equal(
    snapshots[2].onboarding?.active,
    true,
    "New users choose background sync after first sync",
  );
  const serviceHash = createHash("sha256")
    .update("http://127.0.0.1:59998")
    .digest("hex");
  const existing = new DatabaseSync(
    join(info[2].root, "services", serviceHash, user, "sync.sqlite"),
  );
  existing.prepare("INSERT INTO projects VALUES(?,?)").run(
    "archived-fixture",
    JSON.stringify({
      id: "archived-fixture",
      name: "Existing project",
      role: "owner",
      archivedAt: new Date().toISOString(),
    }),
  );
  existing.close();
  const returning = rpc("default", { action: "snapshot" });
  assert.equal(
    returning.onboarding?.active,
    false,
    "Returning users with archived projects are not forced through first run",
  );
  assert.equal(
    returning.background,
    true,
    "Existing default-profile background behavior remains intact",
  );
  assert.deepEqual(
    snapshots.map((s) => s.profile),
    names,
  );
  rpc("alice", { action: "sign-out" });
  assert.equal(rpc("alice", { action: "snapshot" }).user, null);
  assert.equal(
    rpc("bob", { action: "session-user" }).user,
    user,
    "Signing out Alice must not erase Bob's Keychain session",
  );
  assert.equal(rpc("default", { action: "session-user" }).user, user);
  const callback = `orka://auth/callback?profile=bob&code=${randomUUID()}`;
  rpc("alice", { action: "queue-callback", callback });
  assert.equal(
    rpc<{ callback: string | null }>("alice", { action: "take-callback" })
      .callback,
    null,
  );
  assert.equal(
    rpc<{ callback: string | null }>("bob", { action: "take-callback" })
      .callback,
    callback,
  );
  assert.equal(
    rpc<{ callback: string | null }>("bob", { action: "take-callback" })
      .callback,
    null,
  );
  for (const name of names) rpc(name, { action: "sign-out" });
  for (const name of names.slice(0, 2))
    daemons.push(
      spawn(executable, ["--orka-agent"], { env: env(name), stdio: "ignore" }),
    );
  for (let attempt = 0; attempt < 50; attempt++) {
    if (
      names
        .slice(0, 2)
        .every((name) => rpc(name, { action: "snapshot" }).daemon?.running)
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(
    names
      .slice(0, 2)
      .every((name) => rpc(name, { action: "snapshot" }).daemon?.running),
    "Two profile daemons can run concurrently",
  );
  assert.equal(rpc("default", { action: "snapshot" }).daemon?.running, false);
  const invalid = spawnSync(
    executable,
    ["--profile", "../default", "--orka-test"],
    { env: env("alice"), input: "{}", encoding: "utf8" },
  );
  assert.notEqual(invalid.status, 0);
  const explicit = spawnSync(executable, ["--profile", "bob", "--orka-test"], {
    env: env("alice"),
    input: '{"action":"snapshot"}',
    encoding: "utf8",
  });
  assert.equal(
    JSON.parse(explicit.stdout).profile,
    "bob",
    "CLI selection takes precedence over the environment",
  );
  console.log(
    "Passed: one binary, three isolated profiles, retained logins/settings/devices, callback routing, two concurrent sync agents, default compatibility, and CLI validation.",
  );
} finally {
  for (const child of daemons) {
    child.kill();
    if (child.exitCode === null && child.signalCode === null)
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  }
  for (const name of names) {
    try {
      rpc(name, { action: "sign-out" });
    } catch {
      /* Keep cleaning other fixture credentials. */
    }
  }
  await rm(home, { recursive: true, force: true });
}
