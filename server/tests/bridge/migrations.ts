import type { Pool } from "pg";
import { tmpdir } from "node:os";
import { Blobs } from "../reference/blobs.js";
import { Store } from "./store.js";
export {
  initialMigration,
  legacyMigrationNames,
  LegacySchemaError,
} from "../reference/migrations.js";
import { LegacySchemaError } from "../reference/migrations.js";
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
      throw new LegacySchemaError();
    throw error;
  }
}
export const accountAuthenticator =
  (store: Store, authUrl: string) => (token: string) =>
    store.invoke<string>("accountAuthenticate", { authUrl, token });
