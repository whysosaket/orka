package server

import (
	"context"
	"log"
)

func (s *Store) appendLog(q *Queries, project string, event Object, wide bool, key any) {
	ids := []string{}
	for _, k := range []string{"actor", "subject"} {
		if id := text(event[k]); id != "" {
			ids = append(ids, id)
		}
	}
	profiles := q.Rows("select user_id,label from orka.env_profiles where user_id=any($1::uuid[])", ids)
	name := func(id string) string {
		for _, p := range profiles {
			if text(p["user_id"]) == id {
				return text(p["label"])
			}
		}
		if len(id) > 8 {
			id = id[:8]
		}
		return "Member " + id
	}
	payload := merge(event, Object{"at": stamp(), "actorName": "Orka"})
	if actor := text(event["actor"]); actor != "" {
		payload["actorName"] = name(actor)
	}
	if subject := text(event["subject"]); subject != "" {
		payload["subjectName"] = name(subject)
	}
	q.Exec("insert into orka.management_logs(project_id,actor,subject,project_wide,dedupe_key,payload) values($1,$2,$3,$4,$5,$6) on conflict(project_id,dedupe_key) do nothing", project, event["actor"], event["subject"], wide, key, payload)
}
func (s *Store) device(q *Queries, user, id, name string, hardware any) {
	row := q.One("insert into orka.devices(id,owner,name,last_seen,hardware_family) values($1,$2,$3,now(),$4) on conflict(id) do update set name=excluded.name,last_seen=now(),hardware_family=coalesce(nullif(excluded.hardware_family,'generic'),orka.devices.hardware_family,excluded.hardware_family) where orka.devices.owner=excluded.owner returning id", id, user, name, hardware)
	q.Require(row != nil, 403, "Device belongs to another account")
}
func (s *Store) createProject(q *Queries, user, name string, governed bool, remoteKey, requestID any, roles bool) string {
	id := newID()
	input := Object{"name": name, "governed": governed, "remoteKey": remoteKey}
	legacyHash := Hash(input)
	if roles {
		input["roles"] = true
	}
	requestedHash := Hash(input)
	if requestID != nil {
		q.Exec("select pg_advisory_xact_lock(hashtextextended($1,0))", "project-create:"+user+":"+text(requestID))
		prior := q.One("select project_id,request_hash from orka.project_create_receipts where user_id=$1 and request_id=$2", user, requestID)
		if prior != nil {
			q.Require(text(prior["request_hash"]) == requestedHash || (roles && text(prior["request_hash"]) == legacyHash), 409, "This project creation was already submitted with different choices")
			return text(prior["project_id"])
		}
	}
	q.Exec("insert into orka.projects(id,name,created_by,source_model,remote_key) values($1,$2,$3,1,$4)", id, name, user, remoteKey)
	q.Exec("insert into orka.members values($1,$2,'owner')", id, user)
	s.appendLog(q, id, Object{"action": "project.created", "actor": user}, true, nil)
	if governed {
		q.Exec("update orka.projects set governed=true,policy=$2,policy_revision=1 where id=$1", id, defaultProjectRules())
	}
	if roles {
		q.Exec("update orka.projects set governed=true,role_policies=$2,policy_revision=1 where id=$1", id, defaultRolePolicies())
	}
	if requestID != nil {
		q.Exec("insert into orka.project_create_receipts values($1,$2,$3,$4)", user, requestID, requestedHash, id)
	}
	return id
}
func (s *Store) listProjects(q *Queries, user string, archived bool) []Object {
	return q.Rows(`select p.id,p.name,p.revision,m.role,p.remote_key as "remoteKey",p.last_sync_at as "lastSyncAt",p.archived_at as "archivedAt",p.lifecycle_revision as "lifecycleRevision",p.governed,p.policy_revision as "policyRevision",p.role_policies as "rolePolicies",p.source_model as "sourceModel",coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'name',s.name) || case when r.project_id is not null then jsonb_build_object('repository',case when r.repository ? 'id' then r.repository || jsonb_build_object('revision',r.revision) else null end,'repositoryRevision',r.revision) else '{}'::jsonb end order by s.name,s.id) from orka.project_sources s left join orka.source_repositories r on r.project_id=s.project_id and r.source_id=s.id where s.project_id=p.id),'[]'::jsonb) as sources from orka.projects p join orka.members m on m.project_id=p.id where m.user_id=$1 and ($2 or p.archived_at is null) order by p.name`, user, archived)
}
func (s *Store) cleanupBlobs(ctx context.Context) {
	q := &Queries{ctx: ctx, db: s.Pool}
	for _, row := range q.Rows("select project_id from orka.project_blob_cleanup") {
		project := text(row["project_id"])
		if err := s.Blobs.RemoveProject(project); err != nil {
			log.Print("project_blob_cleanup_pending")
			continue
		}
		q.Exec("delete from orka.project_blob_cleanup where project_id=$1", project)
	}
}
func (s *Store) mutateProject(q *Queries, user string, input Object) any {
	project := text(input["projectId"])
	action := text(input["action"])
	if action == "set-remote" {
		p := q.One("select id,remote_key from orka.projects where id=$1 for update", project)
		owner := q.One("select 1 from orka.members where project_id=$1 and user_id=$2 and role='owner'", project, user)
		if !q.Require(p != nil && owner != nil, 403, "Only project owners can set the remote key") || !q.Require(p["remote_key"] == nil, 409, "Project remote key is already set") {
			return nil
		}
		q.Exec("update orka.projects set remote_key=$2 where id=$1", project, input["remoteKey"])
		s.appendLog(q, project, Object{"action": "project.remote_set", "actor": user}, true, nil)
		return Object{"ok": true}
	}
	q.Exec("select pg_advisory_xact_lock(hashtextextended($1,0))", "project:"+user+":"+text(input["requestId"]))
	prior := q.One("select request_hash,payload from orka.project_receipts where author=$1 and id=$2", user, input["requestId"])
	if prior != nil {
		q.Require(text(prior["request_hash"]) == Hash(input), 409, "Retry ID reused with different content")
		return prior["payload"]
	}
	p := q.One("select * from orka.projects where id=$1 for update", project)
	owner := q.One("select 1 from orka.members where project_id=$1 and user_id=$2 and role='owner'", project, user)
	if !q.Require(p != nil && owner != nil, 403, "Only project owners can rename, archive, restore, or delete cloud projects") || !q.Require(number(p["lifecycle_revision"]) == number(input["expectedRevision"]), 409, "Project changed; refresh and review it again") {
		return nil
	}
	switch action {
	case "rename":
		if !q.Require(p["archived_at"] == nil, 409, "Restore the project before renaming it") {
			return nil
		}
		q.Exec("update orka.projects set name=$2,lifecycle_revision=lifecycle_revision+1 where id=$1", project, input["name"])
	case "delete":
		if !q.Require(input["confirmation"] == p["name"], 400, "Type the project name to confirm deletion") {
			return nil
		}
		q.Exec("insert into orka.project_blob_cleanup values($1) on conflict do nothing", project)
		q.Exec("delete from orka.projects where id=$1", project)
	default:
		archived := action == "archive"
		if !q.Require((p["archived_at"] != nil) != archived, 409, "Project changed; refresh and review it again") {
			return nil
		}
		q.Exec("update orka.projects set archived_at=case when $2 then now() else null end,lifecycle_revision=lifecycle_revision+1 where id=$1", project, archived)
		if archived {
			q.Exec("delete from orka.invites where project_id=$1", project)
		}
	}
	receipt := Object{"projectId": project, "action": action, "lifecycleRevision": number(input["expectedRevision"]) + 1}
	if action == "rename" {
		receipt["name"] = input["name"]
	}
	q.Exec("insert into orka.project_receipts values($1,$2,$3,$4)", user, input["requestId"], Hash(input), receipt)
	return receipt
}
func (s *Store) addSources(q *Queries, user string, input Object) any {
	project := text(input["projectId"])
	row := q.One("select id,source_model from orka.projects where id=$1 for update", project)
	s.member(q, user, project)
	if !q.Require(number(row["source_model"]) == 1, 409, "Run the project-source migration before adding folders to this project") {
		return nil
	}
	if !q.Require(q.One("select 1 from orka.members where project_id=$1 and user_id=$2 and role='owner'", project, user) != nil, 403, "Only project owners can add source folders") {
		return nil
	}
	ids := []string{}
	sources := array(input["sources"])
	for _, source := range sources {
		ids = append(ids, text(field(source, "id")))
	}
	count := number(q.One("select count(*)::int as count from orka.project_sources where project_id=$1 and id<>all($2::uuid[])", project, ids)["count"])
	if !q.Require(count+int64(len(sources)) <= 100, 400, "A project can contain at most 100 source folders") {
		return nil
	}
	for _, raw := range sources {
		source := object(raw)
		prior := q.One("select name from orka.project_sources where project_id=$1 and id=$2", project, source["id"])
		if !q.Require(prior == nil || prior["name"] == source["name"], 409, "Source ID already belongs to another folder") {
			return nil
		}
		q.Exec("insert into orka.project_sources(project_id,id,name) values($1,$2,$3) on conflict do nothing", project, source["id"], source["name"])
	}
	return Object{"sources": values(q.Rows("select id,name from orka.project_sources where project_id=$1 order by name,id", project))}
}
