/** Explicit local acceptance: real native commands + API + isolated PostgreSQL. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { tmpdir } from "node:os";
import { Pool } from "pg";
import { migrate } from "../../packages/server-core/src/migrations.js";
import { Store } from "../../packages/server-core/src/store.js";
import { Blobs } from "../../packages/server-core/src/blobs.js";
import { createApi } from "../../packages/server-core/src/main.js";
import { authSettings } from "../../packages/server-core/src/auth.js";

interface NativeSnapshot {
  background: boolean;
  onboarding: { active: boolean };
  projects: {
    id: string;
    sources: { id: string; path: string | null }[];
    sharing: { env: boolean; session: boolean };
  }[];
  resources: { title?: string }[];
  drafts: { status: string; resource: { kind: string } }[];
  outbox: unknown[];
}
interface NativeDraft {
  step: string;
  completedAt?: string;
  projects: {
    path: string;
    projectId?: string;
    status: string;
    reviewPending?: number;
  }[];
}
let executable = process.env.ORKA_NATIVE_BIN;
assert.ok(
  executable,
  "Set ORKA_NATIVE_BIN to the app checkout’s debug executable",
);
const directory = await realpath(
  await mkdtemp(join(tmpdir(), "orka-onboarding-native-")),
);
let reviewBundle: string | undefined;
let reviewBundleId: string | undefined;
if (process.env.ORKA_NATIVE_UI_BIN) {
  assert.equal(process.platform, "darwin", "Native UI acceptance needs macOS");
  const source = dirname(dirname(dirname(process.env.ORKA_NATIVE_UI_BIN)));
  assert.equal(extname(source), ".app", "Pass the bundled app executable");
  reviewBundle = join(directory, "Orka Onboarding Review.app");
  reviewBundleId = `com.orka.native-review.${randomUUID()}`;
  await cp(source, reviewBundle, { recursive: true });
  const plist = join(reviewBundle, "Contents", "Info.plist");
  const converted = spawnSync(
    "/usr/bin/plutil",
    ["-convert", "json", "-o", "-", plist],
    {
      encoding: "utf8",
    },
  );
  assert.equal(converted.status, 0, converted.stderr);
  const info = JSON.parse(converted.stdout) as Record<string, unknown>;
  info.CFBundleIdentifier = reviewBundleId;
  info.CFBundleName = "Orka Onboarding Review";
  info.CFBundleDisplayName = "Orka Onboarding Review";
  delete info.CFBundleURLTypes;
  const inputPlist = join(directory, "review-info.json");
  await writeFile(inputPlist, JSON.stringify(info));
  for (const [command, args] of [
    ["/usr/bin/plutil", ["-convert", "xml1", "-o", plist, inputPlist]],
    ["/usr/bin/codesign", ["--force", "--deep", "--sign", "-", reviewBundle]],
  ] as const) {
    const result = spawnSync(command, [...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  // Freeze the test executable and its Keychain identity for the whole run.
  // A later rebuild or a UI rebind must never launch the regular Orka profile.
  executable = join(
    reviewBundle,
    "Contents",
    "MacOS",
    basename(process.env.ORKA_NATIVE_UI_BIN),
  );
}
const pgBin = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@17/bin";
const pgDirectory = join(directory, "postgres");
const home = join(directory, "home");
await mkdir(home);
const init = spawnSync(
  join(pgBin, "initdb"),
  ["-D", pgDirectory, "-A", "trust", "-U", "postgres", "--no-locale"],
  { encoding: "utf8" },
);
assert.equal(init.status, 0, init.stderr);
const port = 56000 + Math.floor(Math.random() * 1000);
const pg = spawn(
  join(pgBin, "postgres"),
  ["-D", pgDirectory, "-h", "127.0.0.1", "-p", String(port)],
  { stdio: "ignore" },
);
const pool = new Pool({
  connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres`,
});
const owner = randomUUID(),
  member = randomUUID();
const environment = {
  ...process.env,
  ORKA_TEST_HOME: home,
  ORKA_PROFILE: "default",
  CODEX_HOME: join(home, ".codex"),
  CLAUDE_CONFIG_DIR: join(home, ".claude"),
};
const rpc = async <T = NativeSnapshot>(input: unknown): Promise<T> => {
  const child = spawn(executable, ["--orka-test"], {
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "",
    errors = "";
  child.stdout.on("data", (chunk) => (output += String(chunk)));
  child.stderr.on("data", (chunk) => (errors += String(chunk)));
  child.stdin.end(JSON.stringify(input));
  const code = await new Promise<number | null>((resolve) =>
    child.once("exit", resolve),
  );
  assert.equal(code, 0, errors);
  return JSON.parse(output) as T;
};
const onboarding = <T = NativeDraft>(operation: string, input: unknown = {}) =>
  rpc<T>({ action: "onboarding", operation, input });
const store = new Store(pool, new Blobs(join(directory, "blobs")));
const server = createApi(
  store,
  async (token) => {
    if (token !== owner && token !== member)
      throw new Error("Invalid fixture token");
    return token;
  },
  undefined,
  authSettings({ DEPLOYMENT_MODE: "self-hosted", PASSWORD_ENABLED: "true" }),
);
let loseCreateResponse = true;
let failCreates = false;
const listeners = server.listeners("request");
server.removeAllListeners("request");
server.on("request", (request, response) => {
  if (
    failCreates &&
    request.method === "POST" &&
    request.url === "/v2/projects"
  ) {
    response.writeHead(503, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Temporarily unavailable" }));
    return;
  }
  if (
    loseCreateResponse &&
    request.method === "POST" &&
    request.url === "/v2/projects"
  ) {
    loseCreateResponse = false;
    response.end = (() => {
      response.destroy();
      return response;
    }) as typeof response.end;
  }
  for (const listener of listeners) listener.call(server, request, response);
});
try {
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      await pool.query("select 1");
      break;
    } catch {
      if (Date.now() > deadline) throw new Error("PostgreSQL did not start");
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  await migrate(pool);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const api = async (path: string) => {
    const response = await fetch(origin + path, {
      headers: { Authorization: `Bearer ${owner}`, "X-Orka-Governance": "1" },
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  await rpc({
    action: "configure",
    config: { apiUrl: origin, mode: "self-hosted", syncMinutes: 1 },
  });
  await rpc({
    action: "test-session",
    session: {
      user: { id: owner, user_metadata: { full_name: "Alex" } },
      access_token: owner,
      refresh_token: owner,
    },
  });
  assert.equal((await rpc({ action: "snapshot" })).background, false);
  const profile = await onboarding<{
    displayName: string;
    detailsSupported: boolean;
  }>("profile");
  assert.equal(profile.displayName, "Alex");
  assert.equal(profile.detailsSupported, true);
  const photo =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=";
  await onboarding("save-profile", {
    displayName: "Pratham",
    jobRole: "Designer",
    avatarData: photo,
    avatarUrl: null,
  });
  const savedProfile = await api("/v2/profile");
  assert.equal(savedProfile.displayName, "Pratham");
  assert.equal(savedProfile.jobRole, "Designer");
  assert.equal(savedProfile.avatarData, photo);
  const folders = [
    join(home, "Developer", "Orka"),
    join(home, "Developer", "Nimbus"),
  ];
  await mkdir(join(home, ".claude", "projects", "fixture"), {
    recursive: true,
  });
  await mkdir(join(home, ".codex", "sessions"), { recursive: true });
  for (const folder of folders) {
    await mkdir(join(folder, ".git"), { recursive: true });
    await writeFile(
      join(folder, "CLAUDE.md"),
      "# Project instructions\nKeep the onboarding concise.\n",
    );
    await writeFile(
      join(folder, "AGENTS.md"),
      "# Project instructions\nKeep the onboarding concise.\n",
    );
    await writeFile(join(folder, ".env"), "ONBOARDING_SECRET=do-not-sync\n");
  }
  await writeFile(
    join(home, ".claude", "projects", "fixture", "session.jsonl"),
    JSON.stringify({
      cwd: folders[0],
      sessionId: randomUUID(),
      timestamp: new Date().toISOString(),
      type: "user",
      message: { role: "user", content: "Fixture instructions" },
    }) + "\n",
  );
  await writeFile(
    join(home, ".codex", "sessions", "rollout-fixture.jsonl"),
    JSON.stringify({
      type: "session_meta",
      payload: { cwd: folders[1], id: randomUUID() },
    }) + "\n",
  );
  if (process.env.ORKA_NATIVE_UI_BIN) {
    loseCreateResponse = false;
    await onboarding("save-profile", {
      displayName: "Alex",
      jobRole: null,
      avatarData: null,
      avatarUrl: null,
    });
    const child = spawn(executable, [], {
      env: environment,
      stdio: "ignore",
    });
    if (process.env.ORKA_NATIVE_UI_STATE)
      await writeFile(
        process.env.ORKA_NATIVE_UI_STATE,
        JSON.stringify({
          home,
          origin,
          pid: child.pid,
          bundle: reviewBundle,
          bundleId: reviewBundleId,
        }),
      );
    console.log(
      "Native UI fixture ready; the local service stays available until the review app closes.",
    );
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  } else {
    const discovery = await onboarding<{ projects: unknown[] }>("discover");
    assert.equal(discovery.projects.length, 2, JSON.stringify(discovery));
    assert.equal(
      (await api("/v2/projects")).length,
      0,
      "Discovery must not create or upload projects",
    );
    const review = await onboarding<{ matches: Record<string, unknown> }>(
      "review",
      { paths: folders },
    );
    assert.equal(
      (await api("/v2/projects")).length,
      0,
      "Review must precede creation",
    );
    const sharing = {
      memory: true,
      session: false,
      plan: true,
      skill: true,
      env: false,
    };
    await onboarding("checkpoint", {
      step: "syncing",
      projects: discovery.projects,
      selected: folders,
      sharing,
      reviewed: true,
      matches: review.matches,
      folder: "",
    });
    const interrupted = await onboarding("batch-sync");
    assert.equal(interrupted.step, "offline");
    assert.equal((await api("/v2/projects")).length, 2);
    const recovered = await onboarding("batch-sync", { retry: true });
    assert.equal(recovered.step, "ready", JSON.stringify(recovered));
    assert.ok(
      recovered.projects.every((project) => project.status === "synced"),
    );
    const projects = await api("/v2/projects");
    assert.equal(
      projects.length,
      2,
      "A lost creation response must not duplicate the project",
    );
    assert.equal(
      (await onboarding("progress")).step,
      "ready",
      "Progress survives native process restarts",
    );
    const snapshot = await rpc({ action: "snapshot" });
    assert.ok(
      snapshot.projects.every(
        (project) =>
          project.sharing.env === false && project.sharing.session === false,
      ),
    );
    assert.ok(
      snapshot.resources.every(
        (resource) => !resource.title?.includes("ONBOARDING_SECRET"),
      ),
    );
    assert.equal(snapshot.outbox.length, 0);
    assert.equal(
      snapshot.drafts.filter((draft) => draft.status === "local").length,
      4,
      "First sync preserves owner review of newly discovered memories",
    );
    assert.ok(
      recovered.projects.every((project) => project.reviewPending === 2),
    );
    const remote = "github.com/fixture/onboarding";
    const remoteKey = createHash("sha256")
      .update(`orka-remote-v1:${remote}`)
      .digest("hex");
    const legacy = await store.createProject(owner, "Existing project");
    const sourceIds = [randomUUID(), randomUUID()];
    for (const [index, id] of sourceIds.entries()) {
      await pool.query(
        "insert into orka.project_sources(project_id,id,name) values($1,$2,$3)",
        [legacy, id, `original-${index}`],
      );
    }
    const makeProject = async (name: string) => {
      const path = join(home, "Projects", name);
      await mkdir(join(path, ".git"), { recursive: true });
      await writeFile(
        join(path, ".git", "config"),
        `[remote "origin"]\nurl = git@${remote.replace("/", ":")}.git\n`,
      );
      return { name, path, displayPath: path, sources: [], readable: true };
    };
    const renamed = await Promise.all([
      makeProject("renamed-one"),
      makeProject("renamed-two"),
    ]);
    const legacyReview = await onboarding<{
      matches: Record<
        string,
        { requiresChoice: boolean; projects: { id: string }[] }
      >;
    }>("review", { paths: renamed.map((p) => p.path) });
    for (const project of renamed) {
      assert.equal(legacyReview.matches[project.path].requiresChoice, true);
      assert.ok(
        legacyReview.matches[project.path].projects.some(
          (p) => p.id === legacy,
        ),
      );
    }
    const legacyDraft = {
      step: "syncing",
      projects: renamed,
      selected: renamed.map((p) => p.path),
      sharing,
      reviewed: true,
      matches: legacyReview.matches,
      folder: "",
    };
    await onboarding("checkpoint", legacyDraft);
    await assert.rejects(
      onboarding("batch-sync"),
      /Choose which existing Orka project/,
    );
    await onboarding("checkpoint", {
      ...legacyDraft,
      choices: { [renamed[0].path]: "" },
    });
    await assert.rejects(
      onboarding("batch-sync"),
      /Choose which existing Orka project/,
    );
    await onboarding("checkpoint", {
      ...legacyDraft,
      choices: Object.fromEntries(renamed.map((p) => [p.path, legacy])),
      sourceChoices: Object.fromEntries(
        renamed.map((p, index) => [p.path, sourceIds[index]]),
      ),
    });
    const legacySynced = await onboarding("batch-sync");
    assert.equal(legacySynced.step, "ready", JSON.stringify(legacySynced));
    assert.ok(
      legacySynced.projects.every((p) => p.status === "synced"),
      "Every folder in one project reaches a terminal status",
    );
    assert.equal(
      (await api("/v2/projects")).length,
      3,
      "Legacy setup reuses the existing project",
    );
    assert.equal(
      (await api("/v2/projects")).find((p: { id: string }) => p.id === legacy)
        .remoteKey,
      remoteKey,
      "An owner backfills the remote hint after connecting",
    );
    const legacyLocal = (await rpc({ action: "snapshot" })).projects.find(
      (p) => p.id === legacy,
    )!;
    assert.equal(
      legacyLocal.sources.length,
      2,
      "Renamed folders must not create extra sources",
    );
    for (const [index, id] of sourceIds.entries()) {
      assert.equal(
        legacyLocal.sources.find((s) => s.id === id)?.path,
        renamed[index].path,
      );
    }
    const memberProject = await store.createProject(owner, "Member project");
    const memberSource = randomUUID();
    await pool.query(
      "insert into orka.project_sources(project_id,id,name) values($1,$2,'original-folder')",
      [memberProject, memberSource],
    );
    await pool.query("insert into orka.members values($1,$2,'member')", [
      memberProject,
      member,
    ]);
    await rpc({
      action: "test-session",
      session: {
        user: { id: member },
        access_token: member,
        refresh_token: member,
      },
    });
    const memberFolder = await makeProject("member-renamed");
    const memberReview = await onboarding<{ matches: Record<string, unknown> }>(
      "review",
      { paths: [memberFolder.path] },
    );
    await onboarding("checkpoint", {
      step: "syncing",
      projects: [memberFolder],
      selected: [memberFolder.path],
      choices: { [memberFolder.path]: memberProject },
      matches: memberReview.matches,
      sharing,
      reviewed: true,
      folder: "",
    });
    const memberSynced = await onboarding("batch-sync");
    assert.equal(memberSynced.step, "ready", JSON.stringify(memberSynced));
    const memberLocal = (await rpc({ action: "snapshot" })).projects.find(
      (p) => p.id === memberProject,
    )!;
    assert.deepEqual(
      memberLocal.sources.map((s) => ({ id: s.id, path: s.path })),
      [{ id: memberSource, path: memberFolder.path }],
      "A member connects the original source without owner-only source creation",
    );
    assert.equal(
      (await api("/v2/projects")).find(
        (p: { id: string }) => p.id === memberProject,
      ).remoteKey,
      null,
      "Members cannot backfill remote keys",
    );
    await pool.query("insert into orka.members values($1,$2,'member')", [
      legacy,
      member,
    ]);
    const secondary = await makeProject("secondary-repository");
    await writeFile(
      join(secondary.path, ".git", "config"),
      '[remote "origin"]\nurl = git@github.com:fixture/secondary.git\n',
    );
    const secondaryReview = await onboarding<{
      matches: Record<
        string,
        {
          requiresChoice: boolean;
          remoteKey: string;
          projects: { id: string }[];
        }
      >;
    }>("review", { paths: [secondary.path] });
    assert.equal(secondaryReview.matches[secondary.path].requiresChoice, true);
    assert.notEqual(
      secondaryReview.matches[secondary.path].remoteKey,
      remoteKey,
    );
    assert.ok(
      secondaryReview.matches[secondary.path].projects.some(
        (project) => project.id === legacy,
      ),
      "A different remote must not hide an existing multi-repository project",
    );
    const countBeforeSecondary = (await api("/v2/projects")).length;
    await onboarding("checkpoint", {
      step: "syncing",
      projects: [secondary],
      selected: [secondary.path],
      matches: secondaryReview.matches,
      choices: { [secondary.path]: legacy },
      sourceChoices: { [secondary.path]: sourceIds[1] },
      sharing,
      reviewed: true,
      folder: "",
    });
    const secondarySynced = await onboarding("batch-sync");
    assert.equal(
      secondarySynced.step,
      "ready",
      JSON.stringify(secondarySynced),
    );
    assert.equal((await api("/v2/projects")).length, countBeforeSecondary);
    assert.equal(
      (await rpc({ action: "snapshot" })).projects
        .find((project) => project.id === legacy)
        ?.sources.find((source) => source.id === sourceIds[1])?.path,
      secondary.path,
    );
    await rpc({
      action: "test-session",
      session: {
        user: { id: owner },
        access_token: owner,
        refresh_token: owner,
      },
    });
    const portKey = createHash("sha256")
      .update("orka-remote-v1:git.example.test:2222/team/repo")
      .digest("hex");
    const portProject = await store.createProject(
      owner,
      "Port 2222",
      false,
      portKey,
    );
    const portSource = randomUUID();
    await pool.query(
      "insert into orka.project_sources(project_id,id,name) values($1,$2,'port-repository')",
      [portProject, portSource],
    );
    const portFolder = await makeProject("port-repository");
    await writeFile(
      join(portFolder.path, ".git", "config"),
      '[remote "origin"]\nurl = ssh://git@git.example.test:2223/team/repo.git\n',
    );
    const portReview = await onboarding<{
      matches: Record<string, { requiresChoice: boolean; remoteKey: string }>;
    }>("review", { paths: [portFolder.path] });
    assert.equal(
      portReview.matches[portFolder.path].requiresChoice,
      true,
      "Another SSH port is not an automatic match",
    );
    assert.notEqual(portReview.matches[portFolder.path].remoteKey, portKey);
    assert.equal(
      portReview.matches[portFolder.path].remoteKey,
      createHash("sha256")
        .update("orka-remote-v1:git.example.test:2223/team/repo")
        .digest("hex"),
    );
    const countBeforePort = (await api("/v2/projects")).length;
    await onboarding("checkpoint", {
      step: "syncing",
      projects: [portFolder],
      selected: [portFolder.path],
      matches: portReview.matches,
      choices: { [portFolder.path]: "new" },
      sharing,
      reviewed: true,
      folder: "",
    });
    const portSynced = await onboarding("batch-sync");
    assert.equal(portSynced.step, "ready", JSON.stringify(portSynced));
    assert.notEqual(portSynced.projects[0].projectId, portProject);
    assert.equal((await api("/v2/projects")).length, countBeforePort + 1);
    const portSnapshot = await rpc({ action: "snapshot" });
    assert.equal(
      portSnapshot.projects.find((project) => project.id === portProject)
        ?.sources[0].path,
      null,
      "Different ports must not attach the other repository's source",
    );
    for (const operation of ["checkpoint", "complete"]) {
      await assert.rejects(
        rpc({
          action: "onboarding",
          operation,
          context: { user: randomUUID(), service: origin },
          input: { step: "profile" },
        }),
        /Account or service changed/,
      );
    }
    await assert.rejects(
      rpc({
        action: "onboarding",
        operation: "complete",
        context: { user: owner, service: "https://another.example.test" },
        input: {},
      }),
      /Account or service changed/,
    );
    const beforeCompletion = await onboarding("progress");
    await onboarding("checkpoint", { ...beforeCompletion, step: "syncing" });
    const projectLock = spawn("python3", [
      "-c",
      "import fcntl,sys; f=open(sys.argv[1],'a+'); fcntl.flock(f,fcntl.LOCK_EX); print('locked',flush=True); sys.stdin.read(1)",
      join(home, "orka", "workspace.lock"),
    ]);
    await new Promise<void>((resolve, reject) => {
      projectLock.once("error", reject);
      projectLock.once("exit", () =>
        reject(new Error("Project lock exited early")),
      );
      projectLock.stdout.once("data", (value) => {
        if (String(value).trim() === "locked") resolve();
        else reject(new Error("Could not hold the project operation lock"));
      });
    });
    try {
      await rpc({
        action: "onboarding",
        operation: "complete",
        context: { user: owner, service: origin },
        input: {},
      });
    } finally {
      projectLock.stdin.end("x");
      await new Promise<void>((resolve) =>
        projectLock.once("exit", () => resolve()),
      );
    }
    const completed = await onboarding("progress");
    assert.ok(completed.completedAt);
    await onboarding("checkpoint", { ...beforeCompletion, step: "ready" });
    assert.equal(
      (await onboarding("progress")).completedAt,
      completed.completedAt,
    );
    assert.equal((await rpc({ action: "snapshot" })).onboarding.active, false);
    assert.equal((await rpc({ action: "snapshot" })).background, false);
    await rpc({
      action: "test-session",
      session: {
        user: { id: member },
        access_token: member,
        refresh_token: member,
      },
    });
    const offlineFolder = await makeProject("offline-new-project");
    await writeFile(
      join(offlineFolder.path, ".git", "config"),
      '[remote "origin"]\nurl = git@github.com:fixture/offline-new.git\n',
    );
    const offlineReview = await onboarding<{
      matches: Record<string, unknown>;
    }>("review", { paths: [offlineFolder.path] });
    await onboarding("checkpoint", {
      step: "syncing",
      projects: [offlineFolder],
      selected: [offlineFolder.path],
      matches: offlineReview.matches,
      choices: { [offlineFolder.path]: "new" },
      sharing,
      reviewed: true,
      folder: "",
    });
    failCreates = true;
    const offline = await onboarding("batch-sync");
    assert.equal(offline.step, "offline", JSON.stringify(offline));
    assert.equal(offline.projects[0].projectId, undefined);
    await onboarding("complete");
    const offlineCompletion = (await onboarding("progress")).completedAt;
    await assert.rejects(
      rpc({ action: "sync" }),
      /503: Temporarily unavailable/,
    );
    assert.equal((await rpc({ action: "snapshot" })).onboarding.active, false);
    failCreates = false;
    await rpc({ action: "sync" });
    await rpc({ action: "sync" });
    const resumed = await rpc({ action: "snapshot" });
    assert.equal(
      resumed.onboarding.active,
      false,
      "Normal sync recovers without reopening onboarding",
    );
    assert.equal((await onboarding("progress")).completedAt, offlineCompletion);
    assert.ok(
      resumed.projects.some((project) =>
        project.sources.some((source) => source.path === offlineFolder.path),
      ),
      "Reconnect and Sync now must connect the saved folder without relaunching",
    );
    const recoveredCreations = await pool.query(
      "select id from orka.projects where created_by=$1",
      [member],
    );
    assert.equal(
      recoveredCreations.rowCount,
      1,
      "Repeated normal sync must not duplicate a recovered project",
    );
    console.log(
      "Passed: native profile/photo/role persistence, history discovery, consent before create, lost-response retry without duplicates, legacy and multi-remote project selection, owner-only remote backfill, renamed owner/member source mapping, SSH port isolation, every folder's sync progress, ENV exclusion, scoped completion, and normal-sync recovery after dismissing offline setup with background sync off.",
    );
  }
} finally {
  try {
    await rpc({ action: "sign-out" });
  } catch {
    /* Isolated test credentials only. */
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
  pg.kill("SIGTERM");
  if (pg.exitCode === null && pg.signalCode === null)
    await new Promise<void>((resolve) => pg.once("exit", () => resolve()));
  await rm(directory, { recursive: true, force: true });
}
console.log("Native acceptance cleanup complete.");
