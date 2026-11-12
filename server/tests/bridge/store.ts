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
import type {
  Change,
  EffectiveAccess,
  Receipt,
  Resolution,
  ResourceInput,
  SessionCopy,
} from "@portable/protocol";
import { HttpError } from "./errors.js";
export { HttpError } from "./errors.js";
import type { Blobs } from "../fixtures/blobs.js";
import type {
  MemoryResolver,
  MemoryState,
} from "../fixtures/memory-fixtures.js";

// The existing acceptance fixtures still use pg and blob writers. Every operation
// under test crosses the process boundary to the native Go implementation.
export class Store {
  githubFetcher: typeof fetch = fetch;
  authenticate: (token: string) => Promise<string> = async (token) => token;
  readonly ready: Promise<string>;
  readonly permissions = {
    access: (
      user: string,
      project: string,
      resource: Pick<ResourceInput, "resourceId"> & {
        kind: string;
        source?: string;
        logicalPath?: string;
        owner?: string;
        contextSources?: string[];
      },
    ) =>
      this.invoke<EffectiveAccess>("permissions.access", {
        user,
        project,
        resource,
      }),
    canRead: (user: string, project: string, id: string) =>
      this.invoke<boolean>("permissions.canRead", { user, project, id }),
  };
  private readonly secret = randomBytes(32).toString("hex");
  private child?: ChildProcess;
  private callback: Server;
  private closed = false;
  private log = "";
  constructor(
    public pool: Pool,
    public blobs: Blobs,
    resolver?: MemoryResolver,
  ) {
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
          url: string;
          requestMethod: string;
          headers: Record<string, string>;
          body?: string;
        };
        if (input.method === "github") {
          const response = await this.githubFetcher(input.url, {
            method: input.requestMethod,
            headers: input.headers,
            body: input.body ?? undefined,
          });
          res.end(
            JSON.stringify({
              result: {
                status: response.status,
                headers: Object.fromEntries(response.headers),
                body: await response.text(),
              },
            }),
          );
          return;
        }
        const result =
          input.method === "authenticate"
            ? await this.authenticate(input.token)
            : input.method === "memory"
              ? await resolver!.resolve(input.state)
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
    this.ready = this.start(pool, blobs, resolver !== undefined);
    // Test fixtures own the pool; closing it also shuts down their Go runtime.
    const end = pool.end.bind(pool);
    pool.end = (async () => {
      await this.close();
      return end();
    }) as typeof pool.end;
  }
  private async start(
    pool: Pool,
    blobs: Blobs,
    memoryCallback: boolean,
  ): Promise<string> {
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
          BLOB_ROOT: blobs.root,
          ORKA_TEST_MEMORY_CALLBACK: String(memoryCallback),
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
  async createProject(
    user: string,
    name: string,
    governed = false,
    remoteKey?: string,
    requestId?: string,
    roles = false,
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
  async device(
    user: string,
    id: string,
    name: string,
    hardwareFamily?: string,
  ) {
    await this.invoke("device", { user, id, name, hardwareFamily });
  }
  async member(user: string, project: string) {
    await this.invoke("member", { user, project });
  }
  async mutate(user: string, input: Change) {
    return this.invoke<Receipt>("mutate", { user, input });
  }
  async resolve(user: string, input: Resolution) {
    return this.invoke<Receipt>("resolve", { user, input });
  }
  async copy(user: string, input: SessionCopy) {
    return this.invoke<Receipt>("copy", { user, input });
  }
}
