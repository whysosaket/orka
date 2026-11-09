import { Pool } from "pg";
import { migrate } from "../migrations.js";

// Source IDs for migrated projects equal the project ID, so every Mac can map
// its existing checkout without sharing absolute paths or coordinating UUIDs.
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const apply = process.argv.includes("--apply");
const db = await pool.connect();
try {
  await migrate(pool);
  await db.query("begin");
  await db.query(
    "lock table orka.projects,orka.project_sources,orka.resources,orka.snapshots,orka.conflicts,orka.events,orka.receipts in exclusive mode",
  );
  await db.query(`create or replace function pg_temp.scope_project_resources(document jsonb, source_id text) returns jsonb language plpgsql immutable as $$
    declare result jsonb;
    begin
      if jsonb_typeof(document)='object' then
        select coalesce(jsonb_object_agg(key,pg_temp.scope_project_resources(value,source_id)),'{}'::jsonb) into result from jsonb_each(document);
        if result ?& array['resourceId','kind','logicalPath'] and not result ? 'sourceId' then
          result=result || jsonb_build_object('sourceId',source_id);
        end if;
        return result;
      elsif jsonb_typeof(document)='array' then
        select coalesce(jsonb_agg(pg_temp.scope_project_resources(value,source_id) order by ordinal),'[]'::jsonb) into result from jsonb_array_elements(document) with ordinality as items(value,ordinal);
        return result;
      end if;
      return document;
    end;
  $$`);
  const projects = await db.query(
    "select p.id,p.name from orka.projects p where p.source_model=0",
  );
  console.log(
    `${projects.rowCount} projects need a default source. ${apply ? "Applying migration." : "Dry run; pass --apply to migrate."}`,
  );
  for (const project of projects.rows) {
    await db.query(
      "insert into orka.project_sources values($1,$1,$2) on conflict do nothing",
      [project.id, project.name],
    );
    for (const table of [
      "resources",
      "snapshots",
      "conflicts",
      "events",
      "receipts",
    ]) {
      await db.query(
        `update orka.${table} set payload=pg_temp.scope_project_resources(payload,$1::text) where project_id=$1`,
        [project.id],
      );
    }
    // Reviewed previews contain hashes of their exact old resource shape.
    // Preserve their history but require pending suggestions to be resubmitted.
    await db.query(
      "update orka.review_requests set payload=jsonb_set(payload,'{status}','\"stale\"'::jsonb) where project_id=$1 and payload->>'status'='pending'",
      [project.id],
    );
    await db.query("update orka.projects set source_model=1 where id=$1", [
      project.id,
    ]);
  }
  await db.query(apply ? "commit" : "rollback");
} catch (error) {
  await db.query("rollback");
  console.error("project_source_migration_failed", {
    code: (error as { code?: string }).code ?? "unknown",
  });
  process.exitCode = 1;
} finally {
  db.release();
  await pool.end();
}
