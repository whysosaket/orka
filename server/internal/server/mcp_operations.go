package server

import (
	"context"
	"encoding/base64"
	"sort"
	"strings"
	"unicode/utf8"
)

var operationNames = []string{"search_resources", "get_resource_history", "compare_revisions", "list_skills", "create_memory", "update_plan", "get_permissions", "update_permissions", "list_requests", "review_request", "resolve_conflict"}

func (r Reader) operation(ctx context.Context, name string, input Object) (any, error) {
	if name == "search_resources" || name == "list_skills" {
		return r.Store.transaction(ctx, func(q *Queries) any { return r.catalog(q, name, input) })
	}
	project := text(input["projectId"])
	return r.Store.transaction(ctx, func(q *Queries) any {
		q.One("select id from orka.projects where id=$1 for update", project)
		r.Store.member(q, r.User, project)
		if q.err != nil {
			return nil
		}
		switch name {
		case "get_resource_history":
			r.accepted(q, project, text(input["resourceId"]))
			limit := pageLimit(input)
			before := number(input["beforeRevision"])
			rows := q.Rows("select payload from orka.snapshots where project_id=$1 and resource_id=$2 and ($3::bigint=0 or revision<$3::bigint) order by revision desc limit $4", project, input["resourceId"], before, limit+1)
			items := []Object{}
			for _, row := range rows[:min(limit, len(rows))] {
				snapshot := object(row["payload"])
				if r.historicalReadable(q, snapshot) {
					items = append(items, merge(r.source(snapshot), Object{"deleted": snapshot["deleted"], "files": snapshot["files"]}))
				}
			}
			var next any
			if len(rows) > limit {
				next = field(rows[limit-1]["payload"], "revision")
			}
			return Object{"items": items, "nextBeforeRevision": next}
		case "compare_revisions":
			return r.compare(q, project, input)
		case "create_memory", "update_plan":
			return r.writeText(q, name, input)
		case "get_permissions":
			return r.permissions(q, input)
		case "update_permissions":
			return r.updatePermissions(q, input)
		case "list_requests":
			requests := r.Store.requestRows(q, r.User, project)
			items := []any{}
			for _, raw := range requests {
				request := object(raw)
				if !r.envRequest(q, request) && (input["status"] == nil || request["status"] == input["status"]) {
					items = append(items, request)
				}
			}
			offset := min(int(number(input["offset"])), len(items))
			end := min(offset+pageLimit(input), len(items))
			var next any
			if end < len(items) {
				next = end
			}
			return Object{"items": items[offset:end], "nextOffset": next}
		case "review_request":
			request := object(q.One("select payload from orka.review_requests where project_id=$1 and id=$2", project, input["requestId"])["payload"])
			if !q.Require(request != nil && !r.envRequest(q, request), 404, "Request unavailable") {
				return nil
			}
			args := Object{"projectId": project, "id": input["requestId"]}
			action := "request"
			if input["decision"] != nil {
				action = "decide"
				args["decision"] = input["decision"]
				args["previewHash"] = input["previewHash"]
				args["expectedPolicyRevision"] = input["expectedPolicyRevision"]
			}
			result := r.Store.governance(q, r.User, action, args)
			if action == "request" && q.err == nil {
				if !q.Require((number(input["offset"]) == 0 || input["previewHash"] != nil) && (input["previewHash"] == nil || input["previewHash"] == request["previewHash"]), 409, "Proposal changed or previewHash missing; restart inspection") {
					return nil
				}
				return r.requestPreview(q, object(result), number(input["offset"]))
			}
			return result
		case "resolve_conflict":
			if input["action"] != "inspect" {
				if !q.Require(input["requestId"] != nil && input["expectedRevision"] != nil && input["conflictId"] != nil && input["selected"] != nil, 400, "Choose a conflict, version, expectedRevision and requestId") {
					return nil
				}
				if prior := r.priorOperation(q, input, name); prior != nil || q.err != nil {
					return prior
				}
			}
			current := r.accepted(q, project, text(input["resourceId"]))
			if !q.Require(text(current["kind"]) == "session", 400, "Choose a session conflict") {
				return nil
			}
			offset := number(input["offset"])
			if input["action"] == "inspect" && !q.Require((offset == 0 || input["expectedRevision"] != nil) && (input["expectedRevision"] == nil || number(input["expectedRevision"]) == number(current["revision"])), 409, "Conflict changed or revision missing; restart inspection") {
				return nil
			}
			conflicts := []any{}
			for _, raw := range r.Store.conflicts(q, project, text(input["resourceId"])) {
				candidate := object(field(raw, "candidate"))
				if r.historicalReadable(q, candidate) {
					preview := r.source(candidate)
					if input["action"] == "inspect" {
						preview = r.conflictText(q, candidate, offset)
					}
					conflicts = append(conflicts, merge(object(raw), Object{"candidate": preview}))
				}
			}
			if input["action"] == "inspect" {
				return Object{"current": r.conflictText(q, current, offset), "conflicts": conflicts}
			}
			if !q.Require(input["requestId"] != nil && input["expectedRevision"] != nil && input["conflictId"] != nil && input["selected"] != nil, 400, "Choose a conflict, version, expectedRevision and requestId") {
				return nil
			}
			visible := false
			for _, c := range conflicts {
				visible = visible || field(c, "id") == input["conflictId"]
			}
			if !q.Require(visible, 404, "Conflict unavailable") {
				return nil
			}
			device := r.operationDevice(q)
			receipt := r.Store.resolve(q, r.User, Object{"version": 2, "projectId": project, "resourceId": input["resourceId"], "id": input["requestId"], "deviceId": device, "conflictId": input["conflictId"], "expectedRevision": input["expectedRevision"], "action": input["action"], "selected": input["selected"]})
			return r.saveOperation(q, input, name, receipt)
		}
		q.Check(bad("Unknown Orka operation"))
		return nil
	})
}
func pageLimit(input Object) int {
	limit := int(number(input["limit"]))
	if limit == 0 {
		return 20
	}
	return limit
}
func (r Reader) accepted(q *Queries, project, id string) Object {
	resource := r.Store.resource(q, project, id)
	if !q.Require(resource != nil && !flag(resource["deleted"]) && includes([]string{"memory", "plan", "skill", "session"}, text(resource["kind"])) && !strings.HasPrefix(text(resource["logicalPath"]), "env/") && r.Store.canRead(q, r.User, project, id), 404, "Resource unavailable") {
		return nil
	}
	return resource
}
func (r Reader) historicalReadable(q *Queries, snapshot Object) bool {
	if snapshot == nil {
		return false
	}
	for _, id := range stringsOf(snapshot["contextSources"]) {
		if !r.Store.canRead(q, r.User, text(snapshot["projectId"]), id) {
			return false
		}
	}
	return true
}
func (r Reader) fileText(q *Queries, resource Object, path string) string {
	if resource == nil || flag(resource["deleted"]) {
		return ""
	}
	if text(resource["kind"]) == "session" {
		return r.content(q, resource, false)
	}
	if path == "" {
		path = "content.md"
		if resource["kind"] == "skill" {
			path = "SKILL.md"
		}
	}
	for _, raw := range array(resource["files"]) {
		file := object(raw)
		if file["path"] != path {
			continue
		}
		if number(file["size"]) > 1_000_000 {
			return ""
		}
		data := r.Store.readBlob(q, text(resource["projectId"]), text(file["hash"]))
		if !q.Require(number(file["size"]) == int64(len(data)), 422, "Resource size changed") {
			return ""
		}
		if !utf8.Valid(data) || strings.ContainsRune(string(data), 0) {
			return ""
		}
		return strings.TrimPrefix(string(data), "\ufeff")
	}
	return ""
}
func (r Reader) catalog(q *Queries, name string, input Object) Object {
	project, source := text(input["projectId"]), text(input["sourceId"])
	if !q.Require(source == "" || project != "", 400, "Choose projectId when filtering sourceId") {
		return nil
	}
	if project != "" {
		q.One("select id from orka.projects where id=$1 for share", project)
		r.Store.member(q, r.User, project)
		r.sourceFilter(q, project, source, "")
	}
	cursor := object(input["cursor"])
	rows := q.Rows(`select r.payload from orka.resources r join orka.members m on m.project_id=r.project_id join orka.projects p on p.id=r.project_id where m.user_id=$1 and p.archived_at is null and r.payload->>'deleted'='false' and ($2='' or r.project_id::text=$2) and ($3='' or r.payload->>'sourceId'=$3) and ($4='' or (r.payload->>'updatedAt',r.project_id::text,r.id::text)<($4,$5,$6)) order by r.payload->>'updatedAt' desc,r.project_id::text desc,r.id::text desc limit 101`, r.User, project, source, text(cursor["updatedAt"]), text(cursor["projectId"]), text(cursor["resourceId"]))
	// Match scoped reader/blob authorization: lock projects in a stable order,
	// then re-read resources and membership rather than exposing pre-lock bytes.
	projects := []string{}
	for _, row := range rows {
		projects = append(projects, text(field(row["payload"], "projectId")))
	}
	projects = unique(projects)
	sort.Strings(projects)
	accessible := map[string]bool{}
	for _, id := range projects {
		q.One("select id from orka.projects where id=$1 for share", id)
		accessible[id] = q.One("select 1 from orka.members m join orka.projects p on p.id=m.project_id where m.project_id=$1 and m.user_id=$2 and p.archived_at is null", id, r.User) != nil
	}

	items := []Object{}
	scanned := 0
	limit := pageLimit(input)
	query := strings.ToLower(text(input["query"]))
	for i, row := range rows {
		if i == 100 || len(items) == limit {
			break
		}
		scanned++
		scannedResource := object(row["payload"])
		projectId := text(scannedResource["projectId"])
		if !accessible[projectId] {
			continue
		}
		resource := r.Store.resource(q, projectId, text(scannedResource["resourceId"]))
		if resource == nil || flag(resource["deleted"]) {
			continue
		}
		kind := policyClass(resource)
		if name == "list_skills" && kind != "skill" || name == "search_resources" && len(array(input["kinds"])) > 0 && !includes(stringsOf(input["kinds"]), kind) {
			continue
		}
		if !includes([]string{"memory", "instructions", "plan", "session", "skill"}, kind) || !r.Store.canRead(q, r.User, text(resource["projectId"]), text(resource["resourceId"])) {
			continue
		}
		content := ""
		contentAvailable := true
		if resource["kind"] == "session" {
			total := int64(0)
			for _, file := range array(resource["files"]) {
				total += number(field(file, "size"))
			}
			contentAvailable = total <= 32_000_000
		}
		titleMatch := query == "" || strings.Contains(strings.ToLower(text(resource["title"])), query)
		if !titleMatch {
			if contentAvailable {
				content, contentAvailable = r.catalogText(q, resource)
			}
			if !contentAvailable || !strings.Contains(strings.ToLower(content), query) {
				continue
			}
		}
		item := merge(r.source(resource), Object{"category": kind})
		if name == "list_skills" {
			item["files"] = resource["files"]
			item["snapshotHash"] = skillSnapshotHash(resource["files"])
			item["logicalPath"] = resource["logicalPath"]
		} else {
			if content == "" && resource["kind"] != "session" {
				content, contentAvailable = r.catalogText(q, resource)
			}
			item["excerpt"] = jsSlice(content, 0, 1000)
			item["truncated"] = jsLength(content) > 1000
			if !contentAvailable {
				item["contentUnavailable"] = true
				item["note"] = "Content search is unavailable for this snapshot. Open it in Orka."
			}
		}
		items = append(items, item)
	}
	var next any
	if scanned < len(rows) && scanned > 0 {
		last := object(rows[scanned-1]["payload"])
		next = Object{"updatedAt": last["updatedAt"], "projectId": last["projectId"], "resourceId": last["resourceId"]}
	}
	return Object{"items": items, "nextCursor": next, "scope": "accepted shared resources"}
}
func (r Reader) catalogText(q *Queries, resource Object) (string, bool) {
	// An incomplete or oversized session must not abort a cross-project catalog.
	// These readers only inspect blobs; their per-source errors are isolated.
	contentQuery := &Queries{ctx: q.ctx, db: q.db}
	content := r.fileText(contentQuery, resource, "")
	return content, contentQuery.err == nil
}

func (r Reader) compare(q *Queries, project string, input Object) Object {
	r.accepted(q, project, text(input["resourceId"]))
	snapshots := []Object{}
	for _, key := range []string{"fromRevision", "toRevision"} {
		snapshot := object(q.One("select payload from orka.snapshots where project_id=$1 and resource_id=$2 and revision=$3", project, input["resourceId"], input[key])["payload"])
		if !q.Require(snapshot != nil && r.historicalReadable(q, snapshot), 404, "Revision unavailable") {
			return nil
		}
		snapshots = append(snapshots, snapshot)
	}
	before, after := snapshots[0], snapshots[1]
	files := []Object{}
	paths := []string{}
	b, a := fileMap(before), fileMap(after)
	for path := range b {
		paths = append(paths, path)
	}
	for path := range a {
		paths = append(paths, path)
	}
	paths = unique(paths)
	sort.Strings(paths)
	for _, path := range paths {
		if Canonical(b[path]) != Canonical(a[path]) {
			status := "modified"
			if b[path] == nil {
				status = "added"
			}
			if a[path] == nil {
				status = "removed"
			}
			files = append(files, Object{"path": path, "status": status, "before": b[path], "after": a[path]})
		}
	}
	path := text(input["file"])
	left, right := r.fileText(q, before, path), r.fileText(q, after, path)
	offset := number(input["offset"])
	total := max(jsLength(left), jsLength(right))
	if !q.Require(offset <= int64(total), 400, "Offset exceeds comparison text") {
		return nil
	}
	end := min(offset+20000, int64(total))
	var next any
	if end < int64(total) {
		next = end
	}
	return Object{"from": r.source(before), "to": r.source(after), "changedFiles": files, "metadataChanged": Canonical(merge(resourceInputOnly(before), Object{"files": []any{}})) != Canonical(merge(resourceInputOnly(after), Object{"files": []any{}})), "beforeMetadata": merge(resourceInputOnly(before), Object{"files": []any{}}), "afterMetadata": merge(resourceInputOnly(after), Object{"files": []any{}}), "before": jsSlice(left, offset, min(end, int64(jsLength(left)))), "after": jsSlice(right, offset, min(end, int64(jsLength(right)))), "offset": offset, "nextOffset": next, "note": "Before and after text is paginated for the selected file. Binary files are represented by their manifests. Session text excludes tools, setup and analysis."}
}
func (r Reader) operationDevice(q *Queries) string {
	hash := tokenHash("orka-mcp-device:" + r.User)
	id := hash[:8] + "-" + hash[8:12] + "-5" + hash[13:16] + "-a" + hash[17:20] + "-" + hash[20:32]
	r.Store.device(q, r.User, id, "Orka plugin", nil)
	return id
}
func (r Reader) priorOperation(q *Queries, input Object, name string) any {
	row := q.One("select request_hash,payload from orka.mcp_operations where project_id=$1 and author=$2 and id=$3", input["projectId"], r.User, input["requestId"])
	if row == nil {
		return nil
	}
	if !q.Require(text(row["request_hash"]) == Hash(Object{"name": name, "input": input}), 409, "Retry ID reused with different content") {
		return nil
	}
	result := object(row["payload"])
	if receipt := object(result["receipt"]); receipt != nil {
		resource := object(field(receipt["event"], "resource"))
		if !q.Require(r.Store.canRead(q, r.User, text(input["projectId"]), text(resource["resourceId"])), 403, "Receipt access denied") {
			return nil
		}
	}
	if result["status"] == "approval_required" {
		request := object(result["request"])
		content := object(q.One("select content from orka.review_requests where project_id=$1 and id=$2", input["projectId"], request["id"])["content"])
		if !q.Require(r.Store.requestReadable(q, r.User, text(input["projectId"]), request, object(content["resource"])), 403, "Request access denied") {
			return nil
		}
	}
	if event := object(result["event"]); event != nil {
		if !q.Require(r.Store.visibleEvent(q, r.User, text(input["projectId"]), event) != nil, 403, "Receipt access denied") {
			return nil
		}
	}
	return result
}
func (r Reader) saveOperation(q *Queries, input Object, name string, result any) any {
	if q.err == nil {
		q.Exec("insert into orka.mcp_operations values($1,$2,$3,$4,$5)", input["projectId"], r.User, input["requestId"], Hash(Object{"name": name, "input": input}), result)
	}
	return result
}
func (r Reader) writeText(q *Queries, name string, input Object) any {
	project := text(input["projectId"])
	id := text(input["requestId"])
	incoming := Object{}
	if name == "update_plan" {
		current := r.accepted(q, project, text(input["resourceId"]))
		if !q.Require(current["kind"] == "plan" && !flag(current["deleted"]), 404, "Plan unavailable") {
			return nil
		}
		incoming = resourceInputOnly(current)
	} else {
		incoming = Object{"resourceId": id, "source": "shared", "kind": "memory", "title": input["title"], "logicalPath": "knowledge/" + id + ".md", "deleted": false, "memory": Object{"topic": input["title"], "scope": text(input["scope"]), "provider": "manual", "supersedes": []any{}}}
		if input["sourceId"] != nil {
			incoming["sourceId"] = input["sourceId"]
		}
		if input["contextSources"] != nil {
			incoming["contextSources"] = input["contextSources"]
		}
	}
	access := r.Store.access(q, r.User, project, incoming)
	mode := text(access["mode"])
	if name == "create_memory" {
		mode = text(access["create"])
	}
	if !q.Require(accessRanks[mode] >= accessRanks["suggest"], 403, "Resource write access denied") {
		return nil
	}
	if prior := r.priorOperation(q, input, name); prior != nil || q.err != nil {
		return prior
	}
	if name == "create_memory" && !q.Require(r.Store.resource(q, project, id) == nil, 409, "Resource ID already exists; use a fresh requestId") {
		return nil
	}
	if name == "update_plan" {
		current := r.Store.resource(q, project, text(input["resourceId"]))
		if !q.Require(number(current["revision"]) == number(input["expectedRevision"]), 409, "Plan changed; refresh before updating") {
			return nil
		}
	}
	bytes := []byte(text(input["text"]))
	if !q.Require(len(bytes) <= 1_000_000 && !strings.ContainsRune(string(bytes), 0), 413, "Text exceeds resource limit") {
		return nil
	}
	hash := r.Store.putBlob(q, project, bytes)
	q.Exec("insert into orka.blobs values($1,$2,$3) on conflict do nothing", project, hash, len(bytes))
	q.Exec("insert into orka.blob_uploads values($1,$2,$3) on conflict do nothing", project, hash, r.User)
	incoming["files"] = []any{Object{"path": "content.md", "hash": hash, "size": len(bytes), "executable": false}}
	if input["title"] != nil {
		incoming["title"] = input["title"]
	}
	incoming = object(q.Contract("resourceInput", incoming))
	device := r.operationDevice(q)
	change := Object{"version": 2, "id": id, "projectId": project, "deviceId": device, "baseRevision": number(input["expectedRevision"]), "resource": incoming}
	if mode == "suggest" {
		request := r.Store.governance(q, r.User, "submit", Object{"projectId": project, "change": change})
		return r.saveOperation(q, input, name, Object{"status": "approval_required", "request": request})
	}
	receipt := r.Store.change(q, r.User, change, ChangeOptions{})
	return r.saveOperation(q, input, name, Object{"status": "published", "receipt": receipt})
}
func (r Reader) permissions(q *Queries, input Object) any {
	project, member := text(input["projectId"]), text(input["memberId"])
	own := r.Store.projectAccess(q, project, r.User)
	if member == "" {
		member = r.User
	}
	if !q.Require(member == r.User || flag(own["owner"]), 403, "Only the Owner may inspect another member's permissions") {
		return nil
	}
	p := r.Store.projectAccess(q, project, member)
	if input["resourceId"] != nil {
		resource := r.accepted(q, project, text(input["resourceId"]))
		return Object{"memberId": member, "resource": r.source(resource), "access": r.Store.access(q, member, project, resource), "policyRevision": p["policyRevision"]}
	}
	access := Object{}
	for _, category := range policyClasses {
		if category == "env" {
			continue
		}
		kind, path := category, ""
		if category == "instructions" {
			kind = "memory"
			path = "instructions/AGENTS.md"
		}
		access[category] = r.Store.access(q, member, project, Object{"resourceId": project, "kind": kind, "source": "shared", "logicalPath": path})
	}
	return Object{"memberId": member, "role": p["role"], "governed": p["governed"], "policyRevision": p["policyRevision"], "access": access, "rolePolicies": p["rolePolicies"]}
}
func (r Reader) updatePermissions(q *Queries, input Object) any {
	project := text(input["projectId"])
	p := r.Store.projectAccess(q, project, r.User)
	if !q.Require(flag(p["owner"]), 403, "Only the Owner can change sharing permissions") {
		return nil
	}
	if prior := r.priorOperation(q, input, "update_permissions"); prior != nil || q.err != nil {
		return prior
	}
	action := text(input["action"])
	args := Object{"projectId": project, "expectedPolicyRevision": input["expectedPolicyRevision"]}
	if input["memberId"] != nil {
		args["userId"] = input["memberId"]
	}
	switch action {
	case "policy":
		if !q.Require(input["category"] != nil && input["rule"] != nil, 400, "Choose category and rule") {
			return nil
		}
		args["class"] = input["category"]
		args["rule"] = input["rule"]
	case "access":
		if !q.Require(input["resourceId"] != nil && input["memberId"] != nil && input["access"] != nil, 400, "Choose resourceId, memberId and access") {
			return nil
		}
		r.accepted(q, project, text(input["resourceId"]))
		args["resourceId"] = input["resourceId"]
		args["rule"] = input["access"]
	case "inherit":
		if !q.Require(input["memberId"] != nil && (input["resourceId"] != nil) != (input["category"] != nil), 400, "Choose memberId and one resource or category") {
			return nil
		}
		if input["resourceId"] != nil {
			r.accepted(q, project, text(input["resourceId"]))
			args["resourceId"] = input["resourceId"]
		} else {
			args["class"] = input["category"]
		}
	case "member-role":
		if !q.Require(input["memberId"] != nil && input["role"] != nil, 400, "Choose memberId and role") {
			return nil
		}
		args["role"] = input["role"]
	case "save-role-policy":
		if !q.Require(input["policies"] != nil && p["rolePolicies"] != nil, 409, "Use Orka Settings to review migration before saving role policies") {
			return nil
		}
		args["policies"] = input["policies"]
		args["operationId"] = input["requestId"]
	}
	result := r.Store.governance(q, r.User, action, args)
	return r.saveOperation(q, input, "update_permissions", result)
}
func (r Reader) envRequest(q *Queries, request Object) bool {
	content := object(q.One("select content from orka.review_requests where project_id=$1 and id=$2", request["projectId"], request["id"])["content"])
	if strings.HasPrefix(text(field(content["resource"], "logicalPath")), "env/") {
		return true
	}
	if request["requestedClass"] == "env" {
		return true
	}
	target := r.Store.resource(q, text(request["projectId"]), text(request["resourceId"]))
	if target == nil && request["requestedClass"] == nil {
		return q.One("select 1 from orka.env_sets where project_id=$1 and id=$2", request["projectId"], request["resourceId"]) != nil
	}
	return strings.HasPrefix(text(target["logicalPath"]), "env/")
}
func (r Reader) requestPreview(q *Queries, result Object, offset int64) Object {
	// Include bounded file contents so an agent can actually inspect the immutable
	// proposal before sending its preview hash back to Orka's decision workflow.
	content := object(result["content"])
	resource := object(content["resource"])
	if resource == nil {
		return result
	}
	project := text(field(result["request"], "projectId"))
	if resource["kind"] == "session" {
		return merge(result, Object{"proposedConversation": r.conflictText(q, merge(resource, Object{"projectId": project}), offset)})
	}
	files := []Object{}
	total := int64(0)
	for _, raw := range array(resource["files"]) {
		file := object(raw)
		total += number(file["size"])
		if total > 4_000_000 {
			q.Require(false, 413, "Review package exceeds size limit")
			return nil
		}
		data := r.Store.readBlob(q, text(field(result["request"], "projectId")), text(file["hash"]))
		files = append(files, merge(file, Object{"contentBase64": base64.StdEncoding.EncodeToString(data)}))
	}
	return merge(result, Object{"proposedFiles": files})
}

func skillSnapshotHash(files any) string {
	// Go escapes Unicode line separators even with HTML escaping disabled. Native
	// manifests use their literal UTF-8 form; paths cannot contain backslashes.
	value := strings.ReplaceAll(strings.ReplaceAll(string(jsonBytes(files)), `\u2028`, " "), `\u2029`, " ")
	return bytesHash([]byte(value))
}
func (r Reader) conflictText(q *Queries, resource Object, offset int64) Object {
	text := ""
	if !flag(resource["deleted"]) {
		text = r.content(q, resource, false)
	}
	total := int64(jsLength(text))
	end := min(offset+20000, total)
	start := min(offset, total)
	var next any
	if end < total {
		next = end
	}
	return merge(r.source(resource), Object{"text": jsSlice(text, start, end), "offset": offset, "totalCharacters": total, "nextOffset": next, "truncated": end < total, "representation": "readable conversation; setup, analysis, tool records and nontext content excluded"})
}
