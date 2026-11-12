import { spawn, execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

/** Persistent isolated native process; its debug harness uses an in-memory Keychain. */
export async function startEnvMac(options: {
  home: string;
  name: string;
  user: string;
  url: string;
  project: string;
  enable?: boolean;
  session?: Record<string, unknown>;
  sources?: { id: string; name: string }[];
}) {
  const root = join(options.home, options.name),
    path = join(root, "project");
  await mkdir(path, { recursive: true });
  execFileSync("git", ["init", "-q", path]);
  const headers = {
    Authorization: `Bearer ${options.session?.access_token ?? options.user}`,
    "Content-Type": "application/json",
    "X-Orka-Governance": "1",
  };
  const catalog = await fetch(options.url + "/v2/projects", { headers }).then(
    (response) => response.json(),
  );
  const project = catalog.find(
    (item: { id: string }) => item.id === options.project,
  );
  let sharedSources = options.sources ?? project?.sources ?? [];
  if (!sharedSources.length && project?.role === "owner") {
    sharedSources = [{ id: options.project, name: "project" }];
    const registration = await fetch(options.url + "/v2/projects/sources", {
      method: "POST",
      headers,
      body: JSON.stringify({
        projectId: options.project,
        sources: sharedSources,
      }),
    });
    if (!registration.ok)
      throw new Error("Native fixture source registration failed");
  }
  const sources = await Promise.all(
    sharedSources.map(
      async (source: { id: string; name: string }, index: number) => {
        const localPath = index === 0 ? path : join(root, source.name);
        await mkdir(localPath, { recursive: true });
        execFileSync("git", ["init", "-q", localPath]);
        return { ...source, path: localPath };
      },
    ),
  );
  const child = spawn(
    resolve(process.env.ORKA_ENV_NATIVE_BIN!),
    ["--orka-env-test"],
    {
      env: {
        ...process.env,
        ORKA_TEST_HOME: root,
        CODEX_HOME: join(root, ".codex"),
        CLAUDE_CONFIG_DIR: join(root, ".claude"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const waiting: {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }[] = [];
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    const item = waiting.shift();
    if (!item) return;
    try {
      const result = JSON.parse(line) as { value?: unknown; error?: string };
      if (result.error) item.reject(new Error(result.error));
      else item.resolve(result.value);
    } catch {
      item.reject(new Error("Invalid native test output"));
    }
  });
  const exited = new Promise<void>((done) => {
    child.once("error", (error) => {
      for (const item of waiting.splice(0)) item.reject(error);
      done();
    });
    child.once("exit", (code) => {
      for (const item of waiting.splice(0))
        item.reject(new Error(`Native test process exited ${code}`));
      done();
    });
  });
  const close = async () => {
    child.stdin.end();
    await exited;
  };
  function request<T = Record<string, unknown>>(input: unknown): Promise<T> {
    if (child.exitCode !== null || child.killed)
      return Promise.reject(new Error("Native test process is closed"));
    return new Promise((resolve, reject) => {
      waiting.push({ resolve: (value) => resolve(value as T), reject });
      child.stdin.write(JSON.stringify(input) + "\n");
    });
  }
  const setup = (user = options.user) =>
    request({
      action: "setup",
      user,
      url: options.url,
      projectId: options.project,
      path,
      session: options.session,
      sources,
    });
  const env = <T = Record<string, unknown>>(
    operation: string,
    input: Record<string, unknown> = {},
  ) => request<T>({ action: "env", operation, input });
  try {
    await setup();
    if (options.enable !== false) await env("enable", { name: options.name });
  } catch (error) {
    await close();
    throw error;
  }
  return {
    root,
    path,
    sources,
    request,
    env,
    setup,
    close,
    stderr: () => stderr,
  };
}
export type EnvMac = Awaited<ReturnType<typeof startEnvMac>>;
