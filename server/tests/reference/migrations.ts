import { readdir, readFile } from "node:fs/promises";
import type { Pool } from "pg";

export const initialMigration = "001_initial.sql";
export const legacyMigrationNames = [
  "001_workspace.sql",
  "002_env.sql",
  "003_project_lifecycle.sql",
  "004_governance.sql",
  "005_management_logs.sql",
  "006_project_sources.sql",
  "007_mcp_oauth.sql",
  "008_onboarding.sql",
  "009_profile_details.sql",
  "010_role_policies.sql",
  "011_member_emails.sql",
] as const;

export class LegacySchemaError extends Error {
  readonly code = "ORKA_BASELINE_REQUIRED";
  constructor() {
    super(
      "This database does not use the current Orka baseline. A fully completed historical schema can be adopted with upgrade --reset-ledger; otherwise use a matching server version or a fresh database. Existing data and ledger were preserved.",
    );
  }
}

export async function migrate(
  pool: Pool,
  options: { resetLedger?: boolean } = {},
): Promise<void> {
  const directory = new URL(
    "../../packages/server-core/migrations/",
    import.meta.url,
  );
  const files = (await readdir(directory))
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .sort();
  if (!files.includes(initialMigration))
    throw new Error(
      "The initial Orka schema is missing from this server build.",
    );
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query("select pg_advisory_xact_lock(72651209)");
    await db.query("create schema if not exists orka");
    await db.query(
      "create table if not exists orka.schema_migrations(name text primary key)",
    );
    const completed = new Set<string>(
      (await db.query("select name from orka.schema_migrations")).rows.map(
        (row) => row.name as string,
      ),
    );
    if ([...completed].some((name) => !files.includes(name))) {
      const completeLegacy =
        completed.size === legacyMigrationNames.length &&
        legacyMigrationNames.every((name) => completed.has(name));
      const installed = (
        await db.query(
          "select to_regclass('orka.projects') is not null as installed",
        )
      ).rows[0].installed;
      if (!options.resetLedger || !completeLegacy || !installed)
        throw new LegacySchemaError();
      await db.query("delete from orka.schema_migrations");
      await db.query("insert into orka.schema_migrations(name) values($1)", [
        initialMigration,
      ]);
      completed.clear();
      completed.add(initialMigration);
    }
    if (
      !completed.size &&
      (
        await db.query(
          "select 1 from pg_tables where schemaname='orka' and tablename <> 'schema_migrations' limit 1",
        )
      ).rowCount
    )
      throw new LegacySchemaError();
    for (const name of files) {
      if (completed.has(name)) continue;
      await db.query(await readFile(new URL(name, directory), "utf8"));
      await db.query("insert into orka.schema_migrations(name) values($1)", [
        name,
      ]);
    }
    await db.query("commit");
  } catch (error) {
    await db.query("rollback");
    throw error;
  } finally {
    db.release();
  }
}
