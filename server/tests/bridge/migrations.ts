import type { Pool } from "pg";
import { tmpdir } from "node:os";
import { Blobs } from "../fixtures/blobs.js";
import { Store } from "./store.js";
import { command } from "./command.js";
import { HttpError } from "./errors.js";

export const { initialMigration, legacyMigrationNames } = command<{
  initialMigration: string;
  legacyMigrationNames: string[];
}>("migration-info");

export class LegacySchemaError extends HttpError {
  readonly code = "ORKA_BASELINE_REQUIRED";
}
const stores = new WeakMap<Pool, Store>();
export async function migrate(
  pool: Pool,
  options: { resetLedger?: boolean } = {},
) {
  let store = stores.get(pool);
  if (!store) {
    store = new Store(pool, new Blobs(tmpdir()));
    stores.set(pool, store);
  }
  try {
    await store.invoke("migrate", options);
  } catch (error) {
    if ((error as { code?: string }).code === "ORKA_BASELINE_REQUIRED")
      throw new LegacySchemaError(500, (error as Error).message);
    throw error;
  }
}
export const accountAuthenticator =
  (store: Store, authUrl: string) => (token: string) =>
    store.invoke<string>("accountAuthenticate", { authUrl, token });
