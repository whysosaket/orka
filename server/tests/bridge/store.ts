import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import type { Pool } from "pg";
import { Store as ReferenceStore, HttpError } from "../reference/store.js";
export { HttpError } from "../reference/store.js";
import { Permissions } from "../reference/permissions.js";
import type { Blobs } from "../reference/blobs.js";
import { JevMemoryResolver } from "../reference/jev.js";
import type { MemoryResolver, MemoryState } from "../reference/memory.js";

// The existing acceptance fixtures still use pg and blob writers. Every operation
// under test crosses the process boundary to the native Go implementation.
export class Store extends ReferenceStore {
  authenticate: (token: string) => Promise<string> = async (token) => token;
  readonly ready: Promise<string>;
  private readonly secret = randomBytes(32).toString("hex");
  private child?: ChildProcess;
  private callback: Server;
  private closed = false;
  private log = "";
  constructor(
    pool: Pool,
    blobs: Blobs,
    resolver: MemoryResolver = new JevMemoryResolver(),
  ) {
    super(pool, blobs, resolver);
    const callback = async (req: IncomingMessage, res: ServerResponse) => {
      try {
        if (req.headers["x-orka-test-secret"] !== this.secret)
          throw new HttpError(403, "Forbidden");
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const input = JSON.parse(Buffer.concat(chunks).toString()) as {
          method: string;
          token: string;
          project: string;
          state: MemoryState;
        };
        const result =
          input.method === "authenticate"
            ? await this.authenticate(input.token)
            : input.method === "memory"
              ? await resolver.resolve(input.state)
              : input.method === "removeProject"
                ? await blobs.removeProject(input.project)
                : undefined;
        res.end(JSON.stringify({ result: result ?? null }));
      } catch (error) {
        res.end(
          JSON.stringify({
            error: {
              status:
                error instanceof HttpError
                  ? error.status
                  : error instanceof Error &&
                      error.message.startsWith("Memory consolidation pending:")
                    ? 503
                    : 500,
              message: error instanceof Error ? error.message : String(error),
            },
          }),
        );
      }
    };
    this.callback = createServer((req, res) => {
      void callback(req, res);
    });
    this.ready = this.start(pool, blobs);
    // Test fixtures own the pool; closing it also shuts down their Go runtime.
    const end = pool.end.bind(pool);
    pool.end = (async () => {
      await this.close();
      return end();
    }) as typeof pool.end;
    const access = this.permissions.access.bind(this.permissions);
    this.permissions.access = (async (user, project, resource, db, trail) => {
      if (db || trail) return access(user, project, resource, db, trail);
      return this.invoke("permissions.access", { user, project, resource });
    }) as Permissions["access"];
    this.permissions.canRead = (async (user, project, id) =>
      this.invoke("permissions.canRead", {
        user,
        project,
        id,
      })) as Permissions["canRead"];
  }
  private async start(pool: Pool, blobs: Blobs): Promise<string> {
    await new Promise<void>((done) =>
      this.callback.listen(0, "127.0.0.1", done),
    );
    const address = this.callback.address();
    if (!address || typeof address === "string")
      throw new Error("Missing callback address");
    const database = new URL(
      pool.options.connectionString ??
        process.env.DATABASE_URL ??
        "postgresql://localhost/postgres",
    );
    if (pool.options.application_name)
      database.searchParams.set(
        "application_name",
        pool.options.application_name,
      );
    this.child = spawn(
      process.env.ORKA_GO_TEST_BIN ?? resolve("artifacts/bin/orka-test-server"),
      [],
      {
        env: {
          ...process.env,
          DATABASE_URL: database.href,
          BLOB_ROOT: (blobs as unknown as { root: string }).root,
          ORKA_TEST_SECRET: this.secret,
          ORKA_TEST_CALLBACK: `http://127.0.0.1:${address.port}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    this.child.stderr!.on("data", (chunk) => {
      this.log += String(chunk);
    });
    const lines = createInterface({ input: this.child.stdout! });
    return new Promise<string>((done, reject) => {
      this.child!.once("error", reject);
      this.child!.once("exit", (code) =>
        reject(new Error(`Go test server exited (${code}): ${this.log}`)),
      );
      lines.once("line", (line) => {
        lines.close();
        done((JSON.parse(line) as { origin: string }).origin);
      });
    });
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.ready.catch(() => undefined);
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((done) => child.once("exit", () => done()));
    }
    await new Promise<void>((done) => this.callback.close(() => done()));
    if (child && child.exitCode !== null && child.exitCode !== 0)
      throw new Error(`Go test server failed (${child.exitCode}): ${this.log}`);
  }
  async invoke<T>(method: string, args: unknown): Promise<T> {
    const response = await fetch(`${await this.ready}/control`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Orka-Test-Secret": this.secret,
      },
      body: JSON.stringify({ method, args }),
    });
    const value = (await response.json()) as {
      result: T;
      error?: { status: number; message: string; code?: string };
    };
    if (value.error)
      throw Object.assign(
        new HttpError(value.error.status, value.error.message),
        { code: value.error.code },
      );
    return value.result;
  }
  override async createProject(
    ...[
      user,
      name,
      governed = false,
      remoteKey,
      requestId,
      roles = false,
    ]: Parameters<ReferenceStore["createProject"]>
  ) {
    return this.invoke<string>("createProject", {
      user,
      name,
      governed,
      remoteKey,
      requestId,
      roles,
    });
  }
  override async device(
    ...[user, id, name, hardwareFamily]: Parameters<ReferenceStore["device"]>
  ) {
    await this.invoke("device", { user, id, name, hardwareFamily });
  }
  override async member(user: string, project: string) {
    await this.invoke("member", { user, project });
  }
  override async mutate(
    ...[user, input]: Parameters<ReferenceStore["mutate"]>
  ) {
    return this.invoke<Awaited<ReturnType<ReferenceStore["mutate"]>>>(
      "mutate",
      { user, input },
    );
  }
  override async resolve(
    ...[user, input]: Parameters<ReferenceStore["resolve"]>
  ) {
    return this.invoke<Awaited<ReturnType<ReferenceStore["resolve"]>>>(
      "resolve",
      { user, input },
    );
  }
  override async copy(...[user, input]: Parameters<ReferenceStore["copy"]>) {
    return this.invoke<Awaited<ReturnType<ReferenceStore["copy"]>>>("copy", {
      user,
      input,
    });
  }
}
