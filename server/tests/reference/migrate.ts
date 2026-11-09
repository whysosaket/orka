import { Pool } from "pg";
import { LegacySchemaError, migrate } from "./migrations.js";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== "--reset-ledger"))
    throw new Error("Usage: migrate [--reset-ledger]");
  await migrate(pool, { resetLedger: args[0] === "--reset-ledger" });
  console.log("Orka schema installed");
} catch (error) {
  if (error instanceof LegacySchemaError) console.error(error.message);
  console.error("migration_failed", {
    code: (error as { code?: string }).code ?? "unknown",
  });
  process.exitCode = 1;
} finally {
  await pool.end();
}
