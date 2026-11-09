package server

import "strings"

var policyClasses = []string{"instructions", "memory", "skill", "plan", "session", "env"}
var accessRanks = map[string]int{"hidden": 0, "read": 1, "suggest": 2, "publish": 3}

func policyClass(resource Object) string {
	if text(resource["kind"]) == "memory" && text(resource["source"]) == "shared" && strings.HasPrefix(text(resource["logicalPath"]), "instructions/") {
		return "instructions"
	}
	return text(resource["kind"])
}
func defaultProjectRules() Object {
	r := Object{}
	for _, kind := range policyClasses {
		mode, create := "publish", "publish"
		if kind == "env" {
			mode, create = "read", "suggest"
		}
		r[kind] = Object{"mode": mode, "create": create, "canShare": false}
	}
	return r
}
func defaultRolePolicies() Object {
	return Object{"admin": Object{"memory": "write", "session": "write", "plan": "write", "skill": "write"}, "member": Object{"memory": "read", "session": "read", "plan": "write", "skill": "write"}}
}
func (s *Store) member(q *Queries, user, project string) {
	q.Require(q.One("select 1 from orka.members m join orka.projects p on p.id=m.project_id where m.project_id=$1 and m.user_id=$2 and p.archived_at is null", project, user) != nil, 403, "Project access denied")
}
func (s *Store) checkDevice(q *Queries, user, id string) {
	q.Require(q.One("select 1 from orka.devices where id=$1 and owner=$2", id, user) != nil, 403, "Register this device first")
}
func (s *Store) projectAccess(q *Queries, project, user string) Object {
	row := q.One("select p.governed,p.policy,p.policy_revision,p.role_policies,m.role from orka.projects p join orka.members m on m.project_id=p.id where p.id=$1 and m.user_id=$2 and p.archived_at is null", project, user)
	if !q.Require(row != nil, 403, "Project access denied") {
		return Object{}
	}
	policy := row["policy"]
	if policy == nil {
		policy = defaultProjectRules()
	}
	return Object{"governed": flag(row["governed"]), "policyRevision": number(row["policy_revision"]), "policy": policy, "owner": text(row["role"]) == "owner", "role": row["role"], "rolePolicies": row["role_policies"]}
}
func (s *Store) resource(q *Queries, project, id string) Object {
	return object(q.One("select payload from orka.resources where project_id=$1 and id=$2", project, id)["payload"])
}
func (s *Store) access(q *Queries, user, project string, resource Object) Object {
	return s.accessTrail(q, user, project, resource, map[string]bool{})
}
func (s *Store) accessTrail(q *Queries, user, project string, r Object, trail map[string]bool) Object {
	p := s.projectAccess(q, project, user)
	if q.err != nil {
		return Object{}
	}
	if !flag(p["governed"]) || flag(p["owner"]) {
		return Object{"mode": "publish", "canShare": p["owner"], "create": "publish", "governed": p["governed"], "policyRevision": p["policyRevision"]}
	}
	category, id := policyClass(r), text(r["resourceId"])
	current := s.resource(q, project, id)
	mode, create := "hidden", "hidden"
	if policies := object(p["rolePolicies"]); policies != nil && category != "env" {
		key := category
		if key == "instructions" {
			key = "memory"
		}
		role := "member"
		if text(p["role"]) == "admin" {
			role = "admin"
		}
		level := text(field(policies[role], key))
		switch level {
		case "write":
			mode = "publish"
		case "add":
			if text(current["owner"]) == user {
				mode = "read"
			}
		case "read":
			mode = "read"
		}
		if level == "write" || level == "add" {
			create = "publish"
		}
		restriction := object(q.One("select rule from orka.resource_access where project_id=$1 and resource_id=$2 and user_id=$3", project, id, user)["rule"])
		if restriction != nil && accessRanks[text(restriction["mode"])] < accessRanks[mode] {
			mode = text(restriction["mode"])
		}
	} else {
		rule := object(q.One("select rule from orka.member_policy where project_id=$1 and user_id=$2 and class=$3", project, user, category)["rule"])
		if rule == nil {
			rule = object(field(p["policy"], category))
		}
		specific := object(q.One("select rule from orka.resource_access where project_id=$1 and resource_id=$2 and user_id=$3", project, id, user)["rule"])
		selected := rule
		if specific != nil {
			selected = specific
		}
		mode, create = text(selected["mode"]), text(rule["create"])
		if specific == nil && text(r["owner"]) == user && includes([]string{"session", "plan"}, category) && create == "publish" {
			mode = "publish"
		}
	}
	if trail[id] {
		mode = "hidden"
	} else {
		next := map[string]bool{}
		for k, v := range trail {
			next[k] = v
		}
		next[id] = true
		for _, sourceID := range stringsOf(current["contextSources"]) {
			source := s.resource(q, project, sourceID)
			if source == nil || text(s.accessTrail(q, user, project, source, next)["mode"]) == "hidden" {
				mode = "hidden"
				break
			}
		}
	}
	return Object{"mode": mode, "canShare": false, "create": create, "governed": true, "policyRevision": p["policyRevision"]}
}
func (s *Store) requireAccess(q *Queries, user, project string, r Object, mode string, create bool) Object {
	a := s.access(q, user, project, r)
	fieldName := "mode"
	if create {
		fieldName = "create"
	}
	message := "Resource access denied"
	if mode == "publish" {
		message = "Publishing requires permission; save a draft or submit a suggestion"
	}
	q.Require(accessRanks[text(a[fieldName])] >= accessRanks[mode], 403, message)
	return a
}
func (s *Store) canRead(q *Queries, user, project, id string) bool {
	r := s.resource(q, project, id)
	return r != nil && accessRanks[text(s.access(q, user, project, r)["mode"])] >= 1
}
func (s *Store) visibleEvent(q *Queries, user, project string, event Object) Object {
	r := object(event["resource"])
	if !s.canRead(q, user, project, text(r["resourceId"])) {
		return nil
	}
	out := clone(event)
	if related, exists := event["related"]; exists {
		items := []any{}
		for _, raw := range array(related) {
			if s.canRead(q, user, project, text(field(field(raw, "resource"), "resourceId"))) {
				items = append(items, raw)
			}
		}
		out["related"] = items
	}
	a := object(event["activity"])
	if a == nil || !s.canRead(q, user, project, text(a["resourceId"])) || !s.canRead(q, user, project, text(a["copyId"])) {
		out["activity"] = nil
	}
	return out
}
func (s *Store) canReview(q *Queries, user, project string, r Object) bool {
	current := s.resource(q, project, text(r["resourceId"]))
	target := current
	if target == nil {
		target = r
	}
	a := s.access(q, user, project, target)
	for _, id := range stringsOf(r["contextSources"]) {
		if !s.canRead(q, user, project, id) {
			return false
		}
	}
	return text(a["mode"]) == "publish" && (current != nil || text(a["create"]) == "publish") && (text(r["kind"]) != "session" || current == nil || text(current["owner"]) == user)
}
func (s *Store) requestReadable(q *Queries, user, project string, request, resource Object) bool {
	if user != text(request["author"]) && !s.canReview(q, user, project, resource) {
		return false
	}
	current := s.resource(q, project, text(request["resourceId"]))
	if current != nil && !s.canRead(q, user, project, text(current["resourceId"])) {
		return false
	}
	for _, id := range stringsOf(resource["contextSources"]) {
		if !s.canRead(q, user, project, id) {
			return false
		}
	}
	return true
}
func (s *Store) blobReadable(q *Queries, user, project, hash string) bool {
	if !flag(s.projectAccess(q, project, user)["governed"]) {
		return q.err == nil
	}
	pattern := string(jsonBytes([]any{Object{"hash": hash}}))
	resources := q.Rows("select distinct resource_id from orka.snapshots where project_id=$1 and payload->'files' @> $2::jsonb union select resource_id from orka.conflicts where project_id=$1 and payload->'candidate'->'files' @> $2::jsonb", project, pattern)
	for _, r := range resources {
		if s.canRead(q, user, project, text(r["resource_id"])) {
			return true
		}
	}
	proposals := q.Rows("select payload,content from orka.review_requests where project_id=$1 and content->'resource'->'files' @> $2::jsonb", project, pattern)
	for _, row := range proposals {
		if s.requestReadable(q, user, project, object(row["payload"]), object(field(row["content"], "resource"))) {
			return true
		}
	}
	return len(resources) == 0 && len(proposals) == 0 && q.One("select 1 from orka.blob_uploads where project_id=$1 and hash=$2 and author=$3", project, hash, user) != nil
}
func (s *Store) setRule(q *Queries, project, id, user string, rule Object) {
	q.Exec("insert into orka.resource_access values($1,$2,$3,$4) on conflict(project_id,resource_id,user_id) do update set rule=excluded.rule", project, id, user, rule)
}
func (s *Store) sourcePermissions(q *Queries, user, project string, r, current Object, preview bool) {
	supersedes := stringsOf(field(r["memory"], "supersedes"))
	refs := append(stringsOf(current["contextSources"]), stringsOf(r["contextSources"])...)
	refs = unique(append(refs, supersedes...))
	for _, id := range supersedes {
		previous := s.resource(q, project, id)
		if !q.Require(previous != nil && text(previous["kind"]) == "memory" && !strings.HasPrefix(text(previous["logicalPath"]), "instructions/") && text(field(previous["memory"], "scope")) == text(field(r["memory"], "scope")) && previous["sourceId"] == r["sourceId"], 400, "Superseded knowledge must belong to the same repository and scope") {
			return
		}
	}
	if len(refs) == 0 {
		return
	}
	if !q.Require(len(refs) <= 100, 400, "Too many context references") || !q.Require(!includes(refs, text(r["resourceId"])), 400, "A resource cannot derive from itself") {
		return
	}
	var reaches func(string, map[string]bool) bool
	reaches = func(id string, seen map[string]bool) bool {
		if id == text(r["resourceId"]) {
			return true
		}
		if seen[id] {
			return false
		}
		seen[id] = true
		for _, next := range stringsOf(s.resource(q, project, id)["contextSources"]) {
			if reaches(next, seen) {
				return true
			}
		}
		return false
	}
	for _, id := range refs {
		if !q.Require(!reaches(id, map[string]bool{}), 400, "Context references cannot form a cycle") {
			return
		}
	}
	r["contextSources"] = refs
	for _, id := range refs {
		if !q.Require(s.canRead(q, user, project, id), 403, "Source context is unavailable") {
			return
		}
	}
	for _, member := range q.Rows("select user_id from orka.members where project_id=$1", project) {
		reader := text(member["user_id"])
		allowed := true
		for _, id := range refs {
			if !s.canRead(q, reader, project, id) {
				allowed = false
				break
			}
		}
		if allowed {
			continue
		}
		if current == nil && !preview {
			s.setRule(q, project, text(r["resourceId"]), reader, Object{"mode": "hidden", "canShare": false})
		} else if current != nil && !q.Require(!s.canRead(q, reader, project, text(current["resourceId"])), 403, "Restricted source context requires sharing review before widening its audience") {
			return
		}
	}
}
