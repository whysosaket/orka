package server

func (s *Store) preservedReview(q *Queries, request Object) bool {
	return q.One("select 1 from orka.policy_migrations where project_id=$1 and previous->'pending' @> $2::jsonb", request["projectId"], string(jsonBytes([]any{Object{"id": request["id"], "payload": Object{"author": request["author"], "previewHash": request["previewHash"], "type": "change", "policyRevision": number(request["policyRevision"]) - 1}}}))) != nil
}
func (s *Store) legacySnapshot(q *Queries, project string) Object {
	return Object{
		"project":       q.One("select governed,policy,policy_revision from orka.projects where id=$1", project),
		"members":       values(q.Rows("select user_id,role from orka.members where project_id=$1 order by user_id", project)),
		"memberRules":   values(q.Rows("select user_id,class,rule from orka.member_policy where project_id=$1 order by user_id,class", project)),
		"resourceRules": values(q.Rows("select user_id,resource_id,rule from orka.resource_access where project_id=$1 order by user_id,resource_id", project)),
		"pending":       values(q.Rows("select id,payload from orka.review_requests where project_id=$1 and payload->>'status'='pending' order by id", project)),
	}
}
func (s *Store) rolePolicyAction(q *Queries, user, action string, input Object) any {
	project := text(input["projectId"])
	p := s.projectAccess(q, project, user)
	switch action {
	case "role-policy":
		q.Parse(input, scopeShape(nil))
		return Object{"policies": p["rolePolicies"], "policyRevision": p["policyRevision"], "role": p["role"], "owner": p["owner"]}
	case "migration-preview":
		q.Parse(input, scopeShape(nil))
		if !q.Require(flag(p["owner"]), 403, "Only the Owner can review migration") || !q.Require(p["rolePolicies"] == nil, 409, "This project already uses role policies") {
			return nil
		}
		previous := s.legacySnapshot(q, project)
		retained := []any{}
		for _, rule := range array(previous["resourceRules"]) {
			if text(field(field(rule, "rule"), "mode")) != "publish" {
				retained = append(retained, rule)
			}
		}
		return Object{"previous": previous, "migrationHash": Hash(previous), "proposed": defaultRolePolicies(), "retainedRestrictions": retained, "policyRevision": p["policyRevision"]}
	case "policy-operation":
		v := q.Parse(input, scopeShape(map[string]Field{"operationId": uuidField()}))
		if !q.Require(flag(p["owner"]), 403, "Only the Owner can reconcile policy saves") {
			return nil
		}
		row := q.One("select author,result from orka.policy_operations where project_id=$1 and operation_id=$2", project, v["operationId"])
		if row != nil {
			if !q.Require(text(row["author"]) == user, 403, "Operation access denied") {
				return nil
			}
			return merge(Object{"status": "committed"}, object(row["result"]))
		}
		return Object{"status": "not_found"}
	case "save-role-policy":
		v := q.Parse(input, versionedShape(map[string]Field{"operationId": uuidField(), "policies": contractField("rolePolicies"), "migrationHash": optional(strField(64, 64))}))
		if !q.Require(flag(p["owner"]), 403, "Only the Owner can change role policies") {
			return nil
		}
		prior := q.One("select author,request_hash,result from orka.policy_operations where project_id=$1 and operation_id=$2", project, v["operationId"])
		if prior != nil {
			q.Require(text(prior["author"]) == user && text(prior["request_hash"]) == Hash(v), 409, "Operation ID reused with different choices")
			return prior["result"]
		}
		if !q.Require(number(v["expectedPolicyRevision"]) == number(p["policyRevision"]), 409, "Permissions changed; review the latest values") {
			return nil
		}
		if p["rolePolicies"] == nil {
			previous := s.legacySnapshot(q, project)
			if !q.Require(text(v["migrationHash"]) != "" && text(v["migrationHash"]) == Hash(previous), 409, "Review and confirm the current migration diff first") {
				return nil
			}
			q.Exec("insert into orka.policy_migrations(project_id,author,previous) values($1,$2,$3)", project, user, previous)
			q.Exec("delete from orka.member_policy where project_id=$1 and class <> 'env'", project)
			q.Exec("update orka.review_requests set payload=jsonb_set(payload,'{policyRevision}',to_jsonb($2::bigint)) where project_id=$1 and payload->>'status'='pending' and payload->>'type'='change' and (payload->>'policyRevision')::bigint=$3", project, number(p["policyRevision"])+1, p["policyRevision"])
		} else if !q.Require(v["migrationHash"] == nil, 409, "Migration already completed; refresh permissions") {
			return nil
		}
		q.Exec("update orka.projects set governed=true,role_policies=$2,policy_revision=policy_revision+1 where id=$1", project, v["policies"])
		result := Object{"operationId": v["operationId"], "policies": v["policies"], "policyRevision": number(p["policyRevision"]) + 1}
		q.Exec("insert into orka.policy_operations values($1,$2,$3,$4,$5)", project, v["operationId"], user, Hash(v), result)
		s.appendLog(q, project, Object{"action": "permissions.updated", "actor": user}, true, nil)
		return result
	case "member-role", "transfer-ownership", "leave-project":
		v := q.Parse(input, versionedShape(map[string]Field{"userId": optional(uuidField()), "role": optional(enumField("admin", "member"))}))
		if !q.Require(number(v["expectedPolicyRevision"]) == number(p["policyRevision"]), 409, "Membership changed; refresh and review again") {
			return nil
		}
		if action == "leave-project" {
			if !q.Require(!flag(p["owner"]), 403, "Transfer ownership before leaving") {
				return nil
			}
			q.Exec("delete from orka.members where project_id=$1 and user_id=$2", project, user)
		} else {
			if !q.Require(flag(p["owner"]), 403, "Only the Owner can appoint Admins or transfer ownership") || !q.Require(p["rolePolicies"] != nil, 409, "Review role migration first") || !q.Require(v["userId"] != nil && text(v["userId"]) != user, 400, "Choose another current member") {
				return nil
			}
			target := q.One("select role from orka.members where project_id=$1 and user_id=$2", project, v["userId"])
			if !q.Require(target != nil && text(target["role"]) != "owner", 400, "Choose another current member") {
				return nil
			}
			if action == "transfer-ownership" {
				q.Exec("update orka.members set role='member' where project_id=$1 and user_id=$2", project, user)
				q.Exec("update orka.members set role='owner' where project_id=$1 and user_id=$2", project, v["userId"])
				q.Exec("update orka.projects set created_by=$2 where id=$1", project, v["userId"])
			} else {
				if !q.Require(v["role"] != nil, 400, "Choose a role") {
					return nil
				}
				q.Exec("update orka.members set role=$3 where project_id=$1 and user_id=$2", project, v["userId"], v["role"])
			}
		}
		q.Exec("update orka.projects set policy_revision=policy_revision+1 where id=$1", project)
		return Object{"ok": true, "policyRevision": number(p["policyRevision"]) + 1}
	}
	q.Check(bad("Unknown role policy action"))
	return nil
}
