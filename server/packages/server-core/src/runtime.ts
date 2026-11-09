import { Pool } from "pg";
import { uuid } from "@portable/protocol";
import { Blobs } from "./blobs.js";
import { Store, HttpError } from "./store.js";
import { createApi, type Authenticate } from "./main.js";
import { createEmailHook, type AuthSettings } from "./auth.js";
import { cleanupProjectBlobs } from "./projects.js";
import { migrate } from "./migrations.js";

export function accountAuthenticator(
  store: Store,
  authUrl: string,
): Authenticate {
  return async (token) => {
    const response = await fetch(authUrl.replace(/\/$/, "") + "/user", {
      headers: { Authorization: "Bearer " + token },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new HttpError(401, "Session expired");
    const data = (await response.json()) as {
      id: string;
      email?: string;
      user_metadata?: Record<string, unknown>;
    };
    const metadata = data.user_metadata ?? {};
    const name = [
      metadata.full_name,
      metadata.name,
      metadata.preferred_username,
      metadata.user_name,
    ]
      .find(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0,
      )
      ?.trim()
      .slice(0, 160);
    // Only GoTrue's account email is authoritative; profile/user metadata is editable.
    const email =
      typeof data.email === "string" ? data.email.trim() || null : null;
    await store.pool.query(
      "insert into orka.env_profiles(user_id,label,email) values($1,$2,$3) on conflict(user_id) do update set label=coalesce((select display_name from orka.profiles where user_id=excluded.user_id),excluded.label),email=excluded.email",
      [
        uuid.parse(data.id),
        name || email || `Member ${data.id.slice(0, 8)}`,
        email,
      ],
    );
    return data.id;
  };
}

export async function startServer(settings: AuthSettings) {
  const required = (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`Missing ${name}`);
    return value;
  };
  const authUrl = required("AUTH_URL"),
    store = new Store(
      new Pool({ connectionString: required("DATABASE_URL"), max: 10 }),
      new Blobs(required("BLOB_ROOT")),
    );
  const authenticate = accountAuthenticator(store, authUrl);
  try {
    await migrate(store.pool);
  } catch (error) {
    await store.pool.end();
    throw error;
  }
  const sweep = () =>
    void cleanupProjectBlobs(store).catch(() =>
      console.error("project_cleanup_unavailable"),
    );
  sweep();
  const cleanupTimer = setInterval(sweep, 60_000);
  cleanupTimer.unref();
  const server = createApi(
    store,
    authenticate,
    authUrl,
    settings,
    settings.emailProvider === "resend" ? createEmailHook(settings) : undefined,
    process.env.MCP_ENABLED === "true",
  );
  server.listen(Number(process.env.PORT ?? 8080), "0.0.0.0");
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => {
      clearInterval(cleanupTimer);
      server.close(() => {
        void store.pool.end();
      });
    });
}
