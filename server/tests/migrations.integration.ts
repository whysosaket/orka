import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { Pool } from "pg";
import {
  initialMigration,
  legacyMigrationNames,
  LegacySchemaError,
  migrate,
} from "../packages/server-core/src/migrations.js";

async function database(run: (pool: Pool) => Promise<void>) {
  const admin = new Pool({ connectionString: process.env.DATABASE_URL });
  const name = `orka_migration_${randomUUID().replaceAll("-", "")}`;
  let pool: Pool | undefined;
  try {
    await admin.query(`create database "${name}"`);
    const connection = new URL(process.env.DATABASE_URL!);
    connection.pathname = `/${name}`;
    pool = new Pool({ connectionString: connection.toString() });
    await run(pool);
  } finally {
    await pool?.end();
    await admin.query(`drop database if exists "${name}" with (force)`);
    await admin.end();
  }
}

async function ledger(pool: Pool) {
  return (
    await pool.query("select name from orka.schema_migrations order by name")
  ).rows.map((row) => row.name as string);
}

await test("a fresh server installs one baseline atomically and concurrent restarts keep one ledger entry", async () => {
  assert.deepEqual(
    (
      await readdir(
        new URL("../packages/server-core/migrations/", import.meta.url),
      )
    ).filter((name) => name.endsWith(".sql")),
    ["001_initial.sql"],
  );
  await database(async (pool) => {
    await Promise.all([migrate(pool), migrate(pool)]);
    assert.deepEqual(await ledger(pool), [initialMigration]);
    assert.equal(
      (
        await pool.query(
          "select count(*) from pg_tables where schemaname='orka'",
        )
      ).rows[0].count,
      "37",
    );
    const project = randomUUID(),
      owner = randomUUID();
    await pool.query(
      "insert into orka.projects(id,name,created_by) values($1,'Keep this project',$2)",
      [project, owner],
    );
    await migrate(pool);
    assert.equal(
      (
        await pool.query("select name from orka.projects where id=$1", [
          project,
        ])
      ).rows[0].name,
      "Keep this project",
    );
    assert.deepEqual(await ledger(pool), [initialMigration]);
  });
});

await test("baseline failure rolls back its DDL and ledger without touching pre-existing objects", async () => {
  await database(async (pool) => {
    await pool.query(
      "create schema orka; create view orka.members as select 1 as preserved",
    );
    await assert.rejects(migrate(pool), { code: "42P07" });
    const state = (
      await pool.query(
        "select to_regclass('orka.projects') as project, to_regclass('orka.schema_migrations') as ledger",
      )
    ).rows[0];
    assert.deepEqual(state, { project: null, ledger: null });
    assert.equal(
      (await pool.query("select preserved from orka.members")).rows[0]
        .preserved,
      1,
    );
    await pool.query("drop view orka.members");
    await migrate(pool);
    assert.deepEqual(await ledger(pool), [initialMigration]);
  });
});

await test("resetting a completed historical ledger is explicit and preserves application data", async () => {
  await database(async (pool) => {
    await migrate(pool);
    const project = randomUUID();
    await pool.query(
      "insert into orka.projects(id,name,created_by) values($1,'Historical project',$2)",
      [project, randomUUID()],
    );
    await pool.query("delete from orka.schema_migrations");
    await pool.query(
      "insert into orka.schema_migrations(name) select unnest($1::text[])",
      [[...legacyMigrationNames]],
    );
    await assert.rejects(migrate(pool), LegacySchemaError);
    assert.deepEqual(await ledger(pool), [...legacyMigrationNames]);
    await migrate(pool, { resetLedger: true });
    await migrate(pool, { resetLedger: true });
    assert.deepEqual(await ledger(pool), [initialMigration]);
    assert.equal(
      (
        await pool.query("select name from orka.projects where id=$1", [
          project,
        ])
      ).rows[0].name,
      "Historical project",
    );
  });
});

await test("partial, unknown and missing histories cannot be relabeled as a completed baseline", async () => {
  await database(async (pool) => {
    await migrate(pool);
    for (const name of ["001_workspace.sql", "999_unknown.sql"]) {
      await pool.query("delete from orka.schema_migrations");
      await pool.query("insert into orka.schema_migrations(name) values($1)", [
        name,
      ]);
      await assert.rejects(
        migrate(pool, { resetLedger: true }),
        LegacySchemaError,
      );
      assert.deepEqual(await ledger(pool), [name]);
    }
    await pool.query("drop table orka.schema_migrations");
    await assert.rejects(
      migrate(pool, { resetLedger: true }),
      LegacySchemaError,
    );
    assert.equal(
      (
        await pool.query(
          "select to_regclass('orka.schema_migrations') as ledger",
        )
      ).rows[0].ledger,
      null,
    );
  });
});
