import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Uses synthetic resources and fake CLIs. --launch explicitly opens the chosen terminal.
const destination = process.argv[2];
const handoff = process.argv.includes("--handoff");
assert(
  ["discover", "terminal", "warp", "iterm2"].includes(destination),
  "Choose discover, terminal, warp, or iterm2",
);
const home = await mkdtemp(join(tmpdir(), "orka-session-launcher-"));
const projectFolder = join(home, "repository ' $literal 🌊");
const nativeHome = join(home, "native home ' $literal");
await mkdir(projectFolder);
const projectPath = await realpath(projectFolder);
await mkdir(nativeHome);
const bin = join(home, ".local/bin");
await mkdir(bin, { recursive: true });
const nativeBinary = resolve(
  "apps/mac/src-tauri/target/debug/portable-workspace-mac",
);
const env = {
  ...process.env,
  ORKA_TEST_HOME: home,
  CODEX_HOME: join(nativeHome, "codex"),
  CLAUDE_CONFIG_DIR: join(nativeHome, "claude"),
};
await mkdir(env.CODEX_HOME, { recursive: true });
await mkdir(env.CLAUDE_CONFIG_DIR, { recursive: true });
async function command(input: Record<string, unknown>) {
  const child = spawn(nativeBinary, ["--orka-test"], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (data) => {
    stdout += data;
  });
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  child.stdin.end(JSON.stringify(input));
  const status = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  assert.equal(status, 0, stderr);
  const result = JSON.parse(stdout);
  assert(!result.error, result.error);
  return result;
}

await command({ action: "snapshot" });
const database = new DatabaseSync(join(home, "orka/guest/sync.sqlite"));
const user = randomUUID(),
  projectId = randomUUID();
database
  .prepare("INSERT OR REPLACE INTO meta VALUES (?,?)")
  .run("user", JSON.stringify(user));
database.prepare("INSERT OR REPLACE INTO projects VALUES (?,?)").run(
  projectId,
  JSON.stringify({
    id: projectId,
    name: "Launcher smoke",
    path: projectPath,
  }),
);
const fakeCLI = `#!/usr/bin/python3
import sys, json, os, uuid
from pathlib import Path
root = Path(__file__).resolve().parents[2]
tool = Path(__file__).name
if '--help' in sys.argv:
 print('--desktop --resume')
elif sys.argv[1:] == ['auth', 'status']:
 print(json.dumps({'loggedIn': True, 'authMethod': 'claude.ai'}))
elif '--version' in sys.argv:
 print('codex-cli 0.160.0')
elif 'app-server' in sys.argv:
 for line in sys.stdin:
  message = json.loads(line)
  if 'id' not in message: continue
  result = {'codexHome': os.environ['CODEX_HOME']} if message['method'] == 'initialize' else {'data': []}
  if message['method'] == 'thread/fork':
   records = [json.loads(line) for line in Path(message['params']['path']).read_text().splitlines()]
   id = str(uuid.uuid4())
   records[0]['payload'].update(id=id, forked_from_id=records[0]['payload']['id'])
   path = Path(message['params']['path']).with_name('rollout-fork-'+id+'.jsonl')
   path.write_text(''.join(json.dumps(record)+'\\n' for record in records))
   result = {'thread': {'id': id, 'path': str(path)}}
  print(json.dumps({'id': message['id'], 'result': result}), flush=True)
else:
 (root / (tool + '-received.json')).write_text(json.dumps({'tool': tool, 'args': sys.argv[1:], 'cwd': os.getcwd(), 'codexHome': os.environ.get('CODEX_HOME'), 'claudeHome': os.environ.get('CLAUDE_CONFIG_DIR')}))
 print('Orka synthetic launcher verified. No model request was sent.')
`;
for (const tool of ["codex", "claude"])
  await writeFile(join(bin, tool), fakeCLI, { mode: 0o700 });

const evidence = [];
for (const tool of ["codex", "claude"]) {
  const source = handoff ? (tool === "codex" ? "claude" : "codex") : tool;
  const id = randomUUID(),
    nativeId = randomUUID();
  const records =
    source === "codex"
      ? [
          {
            type: "session_meta",
            payload: { id: nativeId, cwd: projectPath, source: "cli" },
          },
          {
            type: "event_msg",
            payload: {
              type: "user_message",
              message: "Synthetic continuation. Do not submit real model work.",
            },
          },
        ]
      : [
          {
            type: "user",
            sessionId: nativeId,
            cwd: projectPath,
            entrypoint: "cli",
            message: {
              role: "user",
              content: "Synthetic continuation. Do not submit real model work.",
            },
          },
        ];
  const bytes = Buffer.from(
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
  );
  const hash = createHash("sha256").update(bytes).digest("hex");
  await mkdir(join(home, "orka/blobs"), { recursive: true });
  await writeFile(join(home, "orka/blobs", hash), bytes);
  const resource = {
    resourceId: id,
    projectId,
    kind: "session",
    source,
    owner: user,
    revision: 1,
    deleted: false,
    files: [{ path: "session.jsonl", hash, size: bytes.length }],
  };
  database
    .prepare("INSERT INTO resources VALUES (?,?,?)")
    .run(id, projectId, JSON.stringify(resource));
  database
    .prepare("INSERT INTO bindings VALUES (?,?,?)")
    .run(id, projectId, JSON.stringify({ nativeId, base: resource }));
  const options = await command({ action: "session-launch-options", id });
  if (destination === "discover") {
    evidence.push({ tool, options });
    continue;
  }
  const option = options.find(
    (option: { tool: string; destination: string; available: boolean }) =>
      option.tool === tool && option.destination === destination,
  );
  assert(
    option?.available,
    `${destination} unavailable for ${tool}: ${JSON.stringify(options.map(({ tool, destination, available, reason }: Record<string, unknown>) => ({ tool, destination, available, reason })))}`,
  );
  const launched = await command({
    action: "resume-session",
    id,
    tool,
    destination,
  });
  const mode = launched.manualCommand ? "manual" : "automatic";
  if (mode === "manual") {
    assert.equal(destination, "warp");
    // Test the fallback against the fake CLI without controlling Warp's UI.
    const child = spawn("/bin/sh", ["-c", launched.manualCommand], {
      stdio: "ignore",
    });
    assert.equal(await new Promise((resolve) => child.on("exit", resolve)), 0);
  } else assert(launched.opened);
  const deadline = Date.now() + 25_000;
  let received;
  while (Date.now() < deadline) {
    try {
      received = JSON.parse(
        await readFile(join(home, `${tool}-received.json`), "utf8"),
      );
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  assert(
    received,
    `${destination} accepted the launch but did not run the synthetic ${tool} CLI. Evidence: ${home}`,
  );
  if (handoff) {
    assert.equal(received.args.length, 1);
    assert.match(received.args[0], /This is a new session/);
    assert(received.args[0].includes(launched.handoff));
    assert(
      (await readFile(launched.handoff, "utf8")).includes(
        "Synthetic continuation",
      ),
    );
  } else {
    assert.equal(launched.forked, true);
    assert.notEqual(launched.nativeId, nativeId);
    assert.deepEqual(received.args, [
      tool === "codex" ? "resume" : "--resume",
      launched.nativeId,
    ]);
    assert.deepEqual(
      JSON.parse(
        database.prepare("SELECT value FROM bindings WHERE id=?").get(id)!
          .value as string,
      ),
      { nativeId, base: resource },
    );
  }
  assert.equal(received.cwd, await realpath(projectPath));
  assert.equal(
    received[tool === "codex" ? "codexHome" : "claudeHome"],
    env[tool === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"],
  );
  evidence.push({ tool, destination, mode, ...received });
}
database.close();
const launchers = await readdir(join(home, "orka/session-launchers")).catch(
  () => [],
);
if (destination !== "discover")
  assert.deepEqual(launchers, [], "Consumed launcher files should be removed");
await mkdir("artifacts", { recursive: true });
const report = { home, handoff, checkedAt: new Date().toISOString(), evidence };
await writeFile(
  `artifacts/session-launcher-${destination}${handoff ? "-handoff" : ""}.json`,
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
