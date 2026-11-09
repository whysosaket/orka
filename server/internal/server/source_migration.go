package server

import (
	"context"
	"fmt"
)

func (s *Store) migrateSources(ctx context.Context, apply bool) error {
	if err := s.Migrate(ctx, false); err != nil {
		return err
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	q := &Queries{ctx: ctx, db: tx}
	q.Exec("lock table orka.projects,orka.project_sources,orka.resources,orka.snapshots,orka.conflicts,orka.events,orka.receipts in exclusive mode")
	q.Exec(`create or replace function pg_temp.scope_project_resources(document jsonb, source_id text) returns jsonb language plpgsql immutable as $$
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
  $$`)
	projects := q.Rows("select p.id,p.name from orka.projects p where p.source_model=0")
	notice := "Dry run; pass --apply to migrate."
	if apply {
		notice = "Applying migration."
	}
	fmt.Printf("%d projects need a default source. %s\n", len(projects), notice)
	for _, project := range projects {
		q.Exec("insert into orka.project_sources values($1,$1,$2) on conflict do nothing", project["id"], project["name"])
		for _, table := range []string{"resources", "snapshots", "conflicts", "events", "receipts"} {
			q.Exec("update orka."+table+" set payload=pg_temp.scope_project_resources(payload,$1::text) where project_id=$1", project["id"])
		}
		q.Exec(`update orka.review_requests set payload=jsonb_set(payload,'{status}','"stale"'::jsonb) where project_id=$1 and payload->>'status'='pending'`, project["id"])
		q.Exec("update orka.projects set source_model=1 where id=$1", project["id"])
	}
	if q.err != nil {
		return q.err
	}
	if apply {
		return tx.Commit(ctx)
	}
	return tx.Rollback(ctx)
}
