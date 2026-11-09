package server

import (
	"regexp"
	"strings"
)

func (s *Store) target(q *Queries, project, id string) Object {
	if r := s.resource(q, project, id); r != nil {
		return r
	}
	env := q.One("select header from orka.env_sets where project_id=$1 and id=$2", project, id)
	if !q.Require(env != nil, 404, "Resource unavailable") {
		return nil
	}
	return Object{"resourceId": id, "kind": "memory", "source": "shared", "logicalPath": "env/" + id, "title": "ENV set", "files": []any{}, "deleted": false, "owner": field(field(env["header"], "manifest"), "creator")}
}
func envTarget(r Object) Object {
	if strings.HasPrefix(text(r["logicalPath"]), "env/") {
		return merge(r, Object{"kind": "env"})
	}
	return r
}
func (s *Store) reviewer(q *Queries, user string, request, content Object) bool {
	project := text(request["projectId"])
	if text(request["type"]) == "change" {
		return s.canReview(q, user, project, object(content["resource"]))
	}
	if request["requestedClass"] == nil {
		s.target(q, project, text(request["resourceId"]))
	}
	return flag(s.projectAccess(q, project, user)["owner"])
}
func (s *Store) requestRows(q *Queries, user, project string) []any {
	result := []any{}
	policy := s.projectAccess(q, project, user)
	for _, row := range q.Rows("select payload,content from orka.review_requests where project_id=$1 order by payload->>'createdAt' desc", project) {
		request := object(row["payload"])
		canReview := s.reviewer(q, user, request, object(row["content"]))
		if user != text(request["author"]) && !canReview {
			continue
		}
		var existing Object
		if request["requestedClass"] == nil {
			existing = s.resource(q, project, text(request["resourceId"]))
		}
		hidden := existing != nil && !s.canRead(q, user, project, text(request["resourceId"]))
		if hidden && user != text(request["author"]) {
			continue
		}
		stale := text(request["status"]) == "pending" && (number(request["policyRevision"]) != number(policy["policyRevision"]) || (text(request["type"]) == "change" && number(existing["revision"]) != number(request["baseRevision"])) || hidden)
		status := text(request["status"])
		if stale {
			status = "stale"
		}
		seen := q.One("select preview_hash from orka.notification_reads where project_id=$1 and user_id=$2 and request_id=$3", project, user, request["id"])["preview_hash"]
		title := request["title"]
		if hidden {
			title = "Resource access changed"
		}
		result = append(result, merge(request, Object{"title": title, "status": status, "canReview": canReview && !stale, "unread": seen != text(request["previewHash"])+":"+status}))
	}
	return result
}
func (s *Store) setAccess(q *Queries, user, project, id, recipient string, rule Object) {
	p := s.projectAccess(q, project, user)
	r := envTarget(s.target(q, project, id))
	if !q.Require(flag(p["owner"]), 403, "Only project owners can manage sharing") {
		return
	}
	member := q.One("select role from orka.members where project_id=$1 and user_id=$2", project, recipient)
	if !q.Require(member != nil && text(member["role"]) != "owner", 400, "Choose a current non-owner member") {
		return
	}
	if text(rule["mode"]) != "hidden" {
		for _, source := range stringsOf(r["contextSources"]) {
			if !q.Require(s.canRead(q, recipient, project, source), 403, "Grant access to the source context first") {
				return
			}
		}
	}
	s.setRule(q, project, id, recipient, rule)
	q.Exec("update orka.projects set policy_revision=policy_revision+1 where id=$1", project)
}
func (q *Queries) Contract(name string, v any) any {
	if q.err != nil {
		return nil
	}
	value, err := ValidateContract(name, v)
	q.Check(err)
	return value
}
func resourceInputOnly(r Object) Object {
	out := Object{}
	for key := range object(contractDocs["resourceInput"]["properties"]) {
		if value, ok := r[key]; ok {
			out[key] = value
		}
	}
	return out
}

func (s *Store) governance(q *Queries, user, action string, input Object) any {
	project := text(input["projectId"])
	q.Exec("select id from orka.projects where id=$1 for update", project)
	p := s.projectAccess(q, project, user)
	if q.err != nil {
		return nil
	}
	if includes([]string{"role-policy", "save-role-policy", "policy-operation", "migration-preview", "member-role", "transfer-ownership", "leave-project"}, action) {
		return s.rolePolicyAction(q, user, action, input)
	}
	if p["rolePolicies"] != nil && includes([]string{"activate", "policy", "inherit", "access", "sharing-lock", "request-access"}, action) {
		q.Require(false, 409, "This project uses role policies. Review Permissions in Settings.")
		return nil
	}
	owner := func() bool {
		return q.Require(flag(p["owner"]), 403, "Only project owners can change project permissions")
	}
	current := func(expected any) bool {
		return q.Require(expected != nil && number(expected) == number(p["policyRevision"]), 409, "Permissions changed; refresh and review again")
	}
	switch action {
	case "logs":
		v := clone(input)
		if _, exists := v["limit"]; !exists {
			v["limit"] = 25
		}
		limitField := intField(1)
		limitField.Max = 100
		v = q.Parse(v, scopeShape(map[string]Field{"before": optional(strField(0, 0)), "limit": limitField}))
		if v["before"] != nil && !q.Require(regexp.MustCompile(`^\d+$`).MatchString(text(v["before"])), 400, "Invalid request") {
			return nil
		}
		limit := int(number(v["limit"]))
		rows := q.Rows("select id::text,payload from orka.management_logs where project_id=$1 and ($2 or project_wide or actor=$3 or subject=$3) and ($4::bigint is null or id<$4::bigint) order by id desc limit $5", project, p["owner"], user, v["before"], limit+1)
		items := []any{}
		for _, row := range rows[:min(limit, len(rows))] {
			items = append(items, merge(object(row["payload"]), Object{"id": row["id"]}))
		}
		var next any
		if len(rows) > limit && len(items) > 0 {
			next = field(items[len(items)-1], "id")
		}
		return Object{"items": items, "next": next}
	case "catalog":
		q.Parse(input, scopeShape(nil))
		members := values(q.Rows(`select m.user_id as id,m.role,coalesce(profile.display_name,p.label,'Member ' || left(m.user_id::text,8)) as name,p.email,profile.display_name as "displayName",profile.avatar_url as "avatarUrl",profile.avatar_data as "avatarData" from orka.members m left join orka.env_profiles p on p.user_id=m.user_id left join orka.profiles profile on profile.user_id=m.user_id where m.project_id=$1 order by m.role,name,m.user_id`, project))
		access := Object{}
		for _, category := range policyClasses {
			kind, path := category, ""
			if category == "instructions" {
				kind, path = "memory", "instructions/AGENTS.md"
			}
			access[category] = s.access(q, user, project, Object{"resourceId": project, "kind": kind, "source": "shared", "logicalPath": path})
		}
		memberRules, resourceRules, envSets := []any{}, []any{}, []any{}
		count := int64(0)
		if flag(p["owner"]) {
			memberRules = values(q.Rows(`select user_id as "userId",class,rule from orka.member_policy where project_id=$1`, project))
			count = number(q.One("select count(*) from orka.resources where project_id=$1", project)["count"])
			envSets = values(q.Rows(`select id as "resourceId",header->'manifest'->>'name' as title from orka.env_sets where project_id=$1 and header->'manifest'->>'deleted'='false'`, project))
		}
		if flag(p["owner"]) || p["rolePolicies"] != nil {
			resourceRules = values(q.Rows(`select resource_id as "resourceId",user_id as "userId",rule from orka.resource_access where project_id=$1 and (user_id=$2 or $3)`, project, user, p["owner"]))
		}
		return merge(p, Object{"access": access, "members": members, "memberRules": memberRules, "resourceRules": resourceRules, "resourceCount": count, "envSets": envSets, "requests": s.requestRows(q, user, project)})
	case "activate":
		v := q.Parse(input, versionedShape(map[string]Field{"rules": contractField("projectRules")}))
		if !owner() || !current(v["expectedPolicyRevision"]) {
			return nil
		}
		for _, raw := range object(v["rules"]) {
			if !q.Require(!flag(field(raw, "canShare")), 400, "Only project owners manage sharing") {
				return nil
			}
		}
		if !q.Require(!flag(p["governed"]), 409, "Project already uses resource permissions") {
			return nil
		}
		q.Exec("update orka.projects set governed=true,policy=$2,policy_revision=policy_revision+1 where id=$1", project, v["rules"])
		s.appendLog(q, project, Object{"action": "permissions.enabled", "actor": user}, true, nil)
		return Object{"governed": true, "policyRevision": number(p["policyRevision"]) + 1}
	}
	if !q.Require(flag(p["governed"]), 409, "Activate resource permissions first") {
		return nil
	}
	switch action {
	case "policy":
		v := q.Parse(input, versionedShape(map[string]Field{"class": contractField("policyClassSchema"), "userId": optional(uuidField()), "rule": contractField("classRule")}))
		rule := object(v["rule"])
		if !owner() || !q.Require(!flag(rule["canShare"]), 400, "Only project owners manage sharing") || !current(v["expectedPolicyRevision"]) {
			return nil
		}
		if v["userId"] != nil {
			if !q.Require(q.One("select 1 from orka.members where project_id=$1 and user_id=$2 and role='member'", project, v["userId"]) != nil, 400, "Choose a current member") {
				return nil
			}
			q.Exec("insert into orka.member_policy values($1,$2,$3,$4) on conflict(project_id,user_id,class) do update set rule=excluded.rule", project, v["userId"], v["class"], rule)
		} else {
			q.Exec("update orka.projects set policy=$2 where id=$1", project, merge(object(p["policy"]), Object{text(v["class"]): rule}))
		}
		q.Exec("update orka.projects set policy_revision=policy_revision+1 where id=$1", project)
		event := Object{"action": "permissions.updated", "actor": user, "category": v["class"], "mode": rule["mode"], "canAdd": text(rule["create"]) != "hidden"}
		if v["userId"] != nil {
			event["subject"] = v["userId"]
		}
		s.appendLog(q, project, event, v["userId"] == nil, nil)
		return Object{"policyRevision": number(p["policyRevision"]) + 1}
	case "inherit":
		v := q.Parse(input, versionedShape(map[string]Field{"userId": uuidField(), "class": optional(contractField("policyClassSchema")), "resourceId": optional(uuidField())}))
		if !owner() || !current(v["expectedPolicyRevision"]) || !q.Require((v["class"] != nil) != (v["resourceId"] != nil), 400, "Choose one permission override") {
			return nil
		}
		if v["class"] != nil {
			q.Exec("delete from orka.member_policy where project_id=$1 and user_id=$2 and class=$3", project, v["userId"], v["class"])
		} else {
			q.Exec("delete from orka.resource_access where project_id=$1 and user_id=$2 and resource_id=$3", project, v["userId"], v["resourceId"])
		}
		q.Exec("update orka.projects set policy_revision=policy_revision+1 where id=$1", project)
		event := Object{"action": "permissions.reset", "actor": user, "subject": v["userId"]}
		if v["class"] != nil {
			event["category"] = v["class"]
		}
		s.appendLog(q, project, event, false, nil)
		return Object{"policyRevision": number(p["policyRevision"]) + 1}
	case "access":
		v := q.Parse(input, versionedShape(map[string]Field{"resourceId": uuidField(), "userId": uuidField(), "rule": contractField("accessRule")}))
		rule := object(v["rule"])
		if !owner() || !q.Require(!flag(rule["canShare"]), 400, "Only project owners manage sharing") || !current(v["expectedPolicyRevision"]) {
			return nil
		}
		s.setAccess(q, user, project, text(v["resourceId"]), text(v["userId"]), rule)
		s.appendLog(q, project, Object{"action": "access.granted", "actor": user, "subject": v["userId"], "mode": rule["mode"]}, false, nil)
		return Object{"policyRevision": number(p["policyRevision"]) + 1}
	case "resource":
		v := q.Parse(input, scopeShape(map[string]Field{"resourceId": uuidField()}))
		r := envTarget(s.target(q, project, text(v["resourceId"])))
		access := s.requireAccess(q, user, project, r, "read", false)
		rules := []any{}
		if flag(access["canShare"]) {
			rules = values(q.Rows(`select user_id as "userId",rule from orka.resource_access where project_id=$1 and resource_id=$2`, project, v["resourceId"]))
		}
		return Object{"access": access, "rules": rules}
	case "submit":
		return s.submitReview(q, user, project, p, input)
	case "request-access":
		return s.requestAccess(q, user, project, p, input)
	case "requests":
		q.Parse(input, scopeShape(nil))
		return s.requestRows(q, user, project)
	case "request", "read-notification", "decide":
		return s.reviewAction(q, user, project, p, action, input)
	case "remove-member":
		v := q.Parse(input, versionedShape(map[string]Field{"userId": uuidField()}))
		if !q.Require(flag(p["owner"]) || p["rolePolicies"] != nil && text(p["role"]) == "admin", 403, "Only the Owner or an Admin can remove Members") || !current(v["expectedPolicyRevision"]) {
			return nil
		}
		removed := q.One("delete from orka.members where project_id=$1 and user_id=$2 and user_id<>$3 and (role='member' or ($4 and role='admin')) returning user_id", project, v["userId"], user, p["owner"])
		if !q.Require(removed != nil, 400, "Choose a current non-owner member") {
			return nil
		}
		q.Exec("insert into orka.env_replacements(project_id,set_id) select project_id,id from orka.env_sets where project_id=$1 and header->'manifest'->>'creator'=$2 on conflict do nothing", project, v["userId"])
		q.Exec(`update orka.review_requests set payload=jsonb_set(payload,'{status}','"stale"') where project_id=$1 and author=$2 and payload->>'status'='pending'`, project, v["userId"])
		q.Exec("delete from orka.member_policy where project_id=$1 and user_id=$2", project, v["userId"])
		q.Exec("delete from orka.resource_access where project_id=$1 and user_id=$2", project, v["userId"])
		q.Exec("update orka.projects set policy_revision=policy_revision+1 where id=$1", project)
		s.appendLog(q, project, Object{"action": "member.removed", "actor": user, "subject": v["userId"]}, true, nil)
		return Object{"ok": true}
	case "replace-env":
		v := q.Parse(input, versionedShape(map[string]Field{"setId": uuidField(), "replacementId": optional(uuidField())}))
		if !owner() || !current(v["expectedPolicyRevision"]) {
			return nil
		}
		old := s.target(q, project, text(v["setId"]))
		if !q.Require(strings.HasPrefix(text(old["logicalPath"]), "env/"), 400, "Choose an ENV set") {
			return nil
		}
		if v["replacementId"] != nil {
			if !q.Require(v["replacementId"] != v["setId"], 400, "Replacement requires a new ENV set") {
				return nil
			}
			next := s.target(q, project, text(v["replacementId"]))
			if !q.Require(strings.HasPrefix(text(next["logicalPath"]), "env/"), 400, "Replacement requires an ENV set") {
				return nil
			}
		}
		q.Exec("insert into orka.env_replacements values($1,$2,$3,true) on conflict(project_id,set_id) do update set replacement_id=excluded.replacement_id,disabled=true", project, v["setId"], v["replacementId"])
		q.Exec("update orka.projects set policy_revision=policy_revision+1 where id=$1", project)
		s.appendLog(q, project, Object{"action": "env.replaced", "actor": user}, false, nil)
		return Object{"ok": true}
	}
	q.Check(bad("Unknown permissions action"))
	return nil
}

func (s *Store) submitReview(q *Queries, user, project string, p, input Object) any {
	v := q.Parse(input, scopeShape(map[string]Field{"change": contractField("change")}))
	change := object(v["change"])
	if !q.Require(text(change["projectId"]) == project, 400, "Project mismatch") {
		return nil
	}
	prior := q.One("select * from orka.review_requests where project_id=$1 and id=$2", project, change["id"])
	if prior != nil {
		if !q.Require(text(prior["author"]) == user && text(prior["request_hash"]) == Hash(v), 409, "Retry ID reused with different content") {
			return nil
		}
		existing := s.resource(q, project, text(field(change["resource"], "resourceId")))
		target := existing
		if target == nil {
			target = object(change["resource"])
		}
		s.requireAccess(q, user, project, target, "suggest", existing == nil)
		q.Require(s.requestReadable(q, user, project, object(prior["payload"]), object(field(prior["content"], "resource"))), 403, "Request access denied")
		return prior["payload"]
	}
	preview := s.change(q, user, change, ChangeOptions{Preview: true})
	if !q.Require(!flag(preview["conflict"]), 409, "Resolve the session conflict before suggesting changes") {
		return nil
	}
	prepared := object(q.Contract("resourceInput", resourceInputOnly(object(field(preview["event"], "resource")))))
	existing := s.resource(q, project, text(prepared["resourceId"]))
	content := Object{"change": merge(change, Object{"baseRevision": number(existing["revision"])}), "resource": prepared}
	request := Object{"id": change["id"], "projectId": project, "author": user, "type": "change", "resourceId": prepared["resourceId"], "title": prepared["title"], "status": "pending", "baseRevision": number(existing["revision"]), "policyRevision": p["policyRevision"], "previewHash": Hash(prepared), "createdAt": stamp()}
	q.Exec("insert into orka.review_requests values($1,$2,$3,$4,$5,$6)", project, request["id"], user, Hash(v), request, content)
	s.appendLog(q, project, Object{"action": "request.created", "actor": user, "subject": user, "requestId": request["id"], "requestType": "change"}, false, "created:"+text(request["id"]))
	return request
}
func (s *Store) requestAccess(q *Queries, user, project string, p, input Object) any {
	v := q.Parse(input, scopeShape(map[string]Field{"id": uuidField(), "resourceId": optional(uuidField()), "class": optional(contractField("policyClassSchema")), "mode": enumField("read", "suggest", "publish")}))
	if !q.Require((v["resourceId"] != nil) != (v["class"] != nil), 400, "Invalid request") {
		return nil
	}
	if v["resourceId"] != nil {
		s.target(q, project, text(v["resourceId"]))
	}
	if !q.Require(!(v["class"] == "env" && v["mode"] == "suggest"), 400, "ENV access requests must request read or publish access") {
		return nil
	}
	resourceID := v["resourceId"]
	title := "Resource access request"
	if resourceID == nil {
		resourceID = project
	}
	request := Object{"id": v["id"], "projectId": project, "author": user, "type": "access", "resourceId": resourceID, "status": "pending", "baseRevision": 0, "policyRevision": p["policyRevision"], "previewHash": Hash(v), "requestedMode": v["mode"], "createdAt": stamp()}
	if v["class"] != nil {
		request["requestedClass"] = v["class"]
		title = map[string]string{"instructions": "Memories", "memory": "Memories", "skill": "Skills", "plan": "Plans", "session": "Sessions", "env": "ENV sets"}[text(v["class"])] + " access request"
	}
	request["title"] = title
	inserted := q.One("insert into orka.review_requests values($1,$2,$3,$4,$5,$6) on conflict do nothing returning id", project, v["id"], user, Hash(v), request, Object{})
	if inserted == nil {
		old := q.One("select * from orka.review_requests where project_id=$1 and id=$2", project, v["id"])
		q.Require(text(old["author"]) == user && text(old["request_hash"]) == Hash(v), 409, "Retry ID reused with different content")
		return old["payload"]
	}
	event := Object{"action": "request.created", "actor": user, "subject": user, "requestId": request["id"], "requestType": "access", "mode": v["mode"]}
	if v["class"] != nil {
		event["category"] = v["class"]
	}
	s.appendLog(q, project, event, false, "created:"+text(request["id"]))
	return request
}

func (s *Store) reviewAction(q *Queries, user, project string, p Object, action string, input Object) any {
	v := q.Parse(input, scopeShape(map[string]Field{"id": uuidField(), "decision": optional(enumField("approve", "reject")), "previewHash": optional(strField(0, 0)), "expectedPolicyRevision": optional(intField(0))}))
	row := q.One("select * from orka.review_requests where project_id=$1 and id=$2 for update", project, v["id"])
	if !q.Require(row != nil, 404, "Request unavailable") {
		return nil
	}
	request := object(row["payload"])
	content := object(row["content"])
	canReview := s.reviewer(q, user, request, content)
	if !q.Require(user == text(request["author"]) || canReview, 403, "Request access denied") {
		return nil
	}
	if action == "read-notification" {
		status := text(request["status"])
		for _, raw := range s.requestRows(q, user, project) {
			if field(raw, "id") == request["id"] {
				status = text(field(raw, "status"))
			}
		}
		q.Exec("insert into orka.notification_reads values($1,$2,$3,$4) on conflict(project_id,user_id,request_id) do update set preview_hash=excluded.preview_hash", project, user, v["id"], text(request["previewHash"])+":"+status)
		return Object{"ok": true}
	}
	if text(request["type"]) == "change" && !q.Require(s.requestReadable(q, user, project, request, object(content["resource"])), 403, "Request access denied") {
		return nil
	}
	if action == "request" {
		audience := []any{}
		result := Object{"request": merge(request, Object{"canReview": canReview}), "content": content, "audience": audience}
		if text(request["type"]) == "change" {
			base := q.One("select payload from orka.snapshots where project_id=$1 and resource_id=$2 and revision=$3", project, request["resourceId"], request["baseRevision"])
			if base != nil {
				result["base"] = base["payload"]
			}
			prepared := object(content["resource"])
			for _, member := range q.Rows("select user_id from orka.members where project_id=$1", project) {
				reader := text(member["user_id"])
				r := s.resource(q, project, text(prepared["resourceId"]))
				if r == nil {
					r = prepared
				}
				if text(s.access(q, reader, project, r)["mode"]) == "hidden" {
					continue
				}
				readable := true
				for _, source := range stringsOf(prepared["contextSources"]) {
					if !s.canRead(q, reader, project, source) {
						readable = false
						break
					}
				}
				if readable {
					audience = append(audience, reader)
				}
			}
			result["audience"] = audience
		} else {
			result["base"] = nil
		}
		return result
	}
	if !q.Require(canReview, 403, "Review permission required") {
		return nil
	}
	if text(request["status"]) != "pending" {
		return request
	}
	if !q.Require(v["decision"] != nil && v["previewHash"] == request["previewHash"], 409, "Review the exact proposed version first") || !q.Require(v["expectedPolicyRevision"] != nil && number(v["expectedPolicyRevision"]) == number(p["policyRevision"]), 409, "Permissions changed; refresh and review again") {
		return nil
	}
	if text(v["decision"]) == "approve" {
		if !q.Require(!(p["rolePolicies"] != nil && text(request["type"]) == "access"), 409, "This project now uses role policies. Review the person's role in Settings instead of granting an individual exception. The pending request is retained.") {
			return nil
		}
		author := s.projectAccess(q, project, text(request["author"]))
		if !q.Require(flag(author["governed"]), 403, "Proposer access changed") {
			return nil
		}
		if number(request["policyRevision"]) != number(p["policyRevision"]) {
			request["status"] = "stale"
		} else if text(request["type"]) == "access" {
			if request["requestedClass"] != nil {
				if !q.Require(flag(p["owner"]), 403, "Only project owners can change project permissions") || !q.Require(!flag(author["owner"]), 400, "This member already owns the project") {
					return nil
				}
				categories := []string{text(request["requestedClass"])}
				if categories[0] == "memory" {
					categories = []string{"instructions", "memory"}
				}
				for _, category := range categories {
					existing := object(q.One("select rule from orka.member_policy where project_id=$1 and user_id=$2 and class=$3", project, request["author"], category)["rule"])
					if existing == nil {
						existing = object(field(p["policy"], category))
					}
					mode := text(request["requestedMode"])
					if accessRanks[text(existing["mode"])] > accessRanks[mode] {
						mode = text(existing["mode"])
					}
					q.Exec("insert into orka.member_policy values($1,$2,$3,$4) on conflict(project_id,user_id,class) do update set rule=excluded.rule", project, request["author"], category, merge(existing, Object{"mode": mode}))
				}
				q.Exec("update orka.projects set policy_revision=policy_revision+1 where id=$1", project)
			} else {
				s.setAccess(q, user, project, text(request["resourceId"]), text(request["author"]), Object{"mode": request["requestedMode"], "canShare": false})
			}
			request["status"] = "approved"
		} else {
			proposed := object(q.Contract("change", content["change"]))
			prepared := object(q.Contract("resourceInput", content["resource"]))
			existing := s.resource(q, project, text(request["resourceId"]))
			legacy := p["rolePolicies"] != nil && s.preservedReview(q, request)
			if !legacy {
				r := existing
				if r == nil {
					r = prepared
				}
				s.requireAccess(q, text(request["author"]), project, r, "suggest", existing == nil)
			}
			if number(existing["revision"]) != number(request["baseRevision"]) {
				request["status"] = "stale"
			} else {
				s.change(q, text(request["author"]), merge(proposed, Object{"resource": prepared}), ChangeOptions{Review: true, Exact: true, LegacyReview: legacy})
				request["status"] = "approved"
			}
		}
	} else {
		request["status"] = "rejected"
	}
	request["reviewer"] = user
	event := Object{"action": "request." + text(request["status"]), "actor": user, "subject": request["author"], "requestId": request["id"], "requestType": request["type"], "status": request["status"]}
	if request["requestedClass"] != nil {
		event["category"] = request["requestedClass"]
	}
	if request["requestedMode"] != nil {
		event["mode"] = request["requestedMode"]
	}
	s.appendLog(q, project, event, false, "decision:"+text(request["id"]))
	q.Exec("update orka.review_requests set payload=$3 where project_id=$1 and id=$2", project, v["id"], request)
	return request
}

func (s *Store) pull(q *Queries, user, project string, cursor, policyRevision int64, supported bool) Object {
	q.Exec("select id from orka.projects where id=$1 for share", project)
	p := s.projectAccess(q, project, user)
	if !q.Require(!flag(p["governed"]) || supported, 409, "Update Orka to use this project's resource permissions") {
		return nil
	}
	maximum := number(q.One("select revision from orka.projects where id=$1", project)["revision"])
	if !q.Require(cursor <= maximum, 400, "Cursor is ahead of project") {
		return nil
	}
	reset := flag(p["governed"]) && policyRevision != number(p["policyRevision"])
	scanned := []Object{}
	if reset {
		for _, row := range q.Rows("select payload from orka.resources where project_id=$1 order by revision", project) {
			r := object(row["payload"])
			cs := []any{}
			for _, c := range q.Rows("select payload from orka.conflicts where project_id=$1 and resource_id=$2 and not resolved", project, r["resourceId"]) {
				cs = append(cs, c["payload"])
			}
			scanned = append(scanned, Object{"revision": r["revision"], "resource": r, "conflicts": cs, "activity": nil})
		}
	} else {
		for _, row := range q.Rows("select payload from orka.events where project_id=$1 and revision>$2 order by revision limit 200", project, cursor) {
			scanned = append(scanned, object(row["payload"]))
		}
	}
	events, presence := []any{}, []any{}
	for _, event := range scanned {
		visible := s.visibleEvent(q, user, project, event)
		if visible != nil {
			r := object(visible["resource"])
			events = append(events, merge(visible, Object{"resource": merge(r, Object{"access": s.access(q, user, project, r)})}))
		}
	}
	for _, row := range q.Rows("select p.resource_id,p.device_id,p.owner,d.name from orka.presence p join orka.devices d on d.id=p.device_id where p.project_id=$1 and p.last_seen>now()-interval '3 minutes'", project) {
		if !flag(p["governed"]) || s.canRead(q, user, project, text(row["resource_id"])) {
			presence = append(presence, row)
		}
	}
	next := cursor
	if reset {
		next = maximum
	} else if len(scanned) > 0 {
		next = number(scanned[len(scanned)-1]["revision"])
	}
	requests := []any{}
	if flag(p["governed"]) {
		requests = s.requestRows(q, user, project)
	}
	return Object{"events": events, "cursor": next, "hasMore": next < maximum, "presence": presence, "reset": reset, "governed": p["governed"], "policyRevision": p["policyRevision"], "requests": requests}
}
