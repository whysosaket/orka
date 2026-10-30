import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  realpath,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
const temporary = await mkdtemp(join(tmpdir(), "orka-native-"));
await mkdir(join(temporary, "project"));
const root = await realpath(join(temporary, "project"));
await mkdir(join(temporary, "codex"));
const child = spawn(
  process.env.CODEX_BINARY ?? "/opt/homebrew/bin/codex",
  ["app-server", "--stdio"],
  {
    env: { ...process.env, CODEX_HOME: join(temporary, "codex") },
    stdio: ["pipe", "pipe", "pipe"],
  },
);
child.stderr.on("data", (data) => process.stderr.write(data));
child.on("exit", () => {
  for (const request of pending.values())
    request.reject(new Error("Codex app server exited"));
  pending.clear();
});
let sequence = 0;
const pending = new Map<
  number,
  {
    resolve: (result: Record<string, unknown>) => void;
    reject: (e: Error) => void;
  }
>();
createInterface({ input: child.stdout }).on("line", (line) => {
  const message = JSON.parse(line) as {
    id?: number;
    result: Record<string, unknown>;
    error?: { message: string };
  };
  if (!message.id) return;
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve(message.result);
});
const call = (
  method: string,
  params: unknown,
): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, 20_000);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      reject: (e) => {
        clearTimeout(timeout);
        reject(e);
      },
    });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
try {
  await call("initialize", {
    clientInfo: { name: "orka-smoke", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write('{"method":"initialized"}\n');
  const oldId = randomUUID(),
    stamp = "2026-10-02T00:00:00.000Z",
    source = join(temporary, "source.jsonl");
  await writeFile(
    source,
    [
      {
        timestamp: stamp,
        type: "session_meta",
        payload: {
          id: oldId,
          timestamp: stamp,
          cwd: "/old/mac/project",
          originator: "codex_cli_rs",
          cli_version: "0.159.2",
          source: "cli",
          model_provider: "openai",
        },
      },
      {
        timestamp: stamp,
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "Orka fixture user message",
          images: [],
          local_images: [],
          text_elements: [],
        },
      },
      {
        timestamp: stamp,
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Orka fixture user message" }],
        },
      },
      {
        timestamp: stamp,
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "Orka fixture assistant message" },
          ],
        },
      },
    ]
      .map((v) => JSON.stringify(v))
      .join("\n") + "\n",
  );
  const imported = await call("thread/fork", {
    threadId: "",
    path: source,
    cwd: root,
    runtimeWorkspaceRoots: [root],
    deferGoalContinuation: true,
    excludeTurns: true,
    threadSource: "cli",
  });
  const thread = imported.thread as { id: string; path: string; cwd: string };
  assert.ok(thread.id && thread.id !== oldId);
  assert.equal(thread.cwd, await realpath(root));
  assert.ok(thread.path);
  const project = await call("project/create", {
    idempotencyKey: `orka-smoke-${randomUUID()}`,
    name: "Orka smoke",
    roots: [{ path: root }],
  });
  await call("thread/metadata/update", {
    threadId: thread.id,
    projectId: (project.project as { id: string }).id,
  });
  await call("thread/name/set", {
    threadId: thread.id,
    name: "Orka imported fixture",
  });
  await call("thread/unsubscribe", { threadId: thread.id });
  const listed = await call("thread/list", {
    cwd: root,
    limit: 100,
    modelProviders: [],
  });
  assert.ok((listed.data as { id: string }[]).some((t) => t.id === thread.id));
  const resumed = await call("thread/resume", {
    threadId: thread.id,
    cwd: root,
    runtimeWorkspaceRoots: [root],
  });
  assert.equal((resumed.thread as { id: string }).id, thread.id);
  const data = await readFile(thread.path, "utf8");
  assert.match(data, /Orka fixture assistant message/);
  await call("thread/archive", { threadId: thread.id });
  const remaining = await call("thread/list", {
    cwd: root,
    limit: 100,
    modelProviders: [],
  });
  assert.ok(
    !(remaining.data as { id: string }[]).some((t) => t.id === thread.id),
  );
  console.log(
    "Codex legacy import, project registration, history listing, resume, and archive verified without a model turn. Run npm run test:native-paginated for the paginated adapter.",
  );
  console.log(
    "Claude Desktop automatic sidebar registration and both desktop visual checks remain release gates.",
  );
} finally {
  child.kill();
  if (child.exitCode === null && child.signalCode === null)
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  await rm(temporary, { recursive: true, force: true });
}
