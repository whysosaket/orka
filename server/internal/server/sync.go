package server

import (
	"bytes"
	"sort"
	"strings"
	"unicode/utf8"
)

type ChangeOptions struct{ Preview, Review, Exact, LegacyReview bool }

func (s *Store) beginChange(q *Queries, user string, input Object) (int64, Object) {
	project := text(input["projectId"])
	locked := q.One("select revision from orka.projects where id=$1 for update", project)
	s.member(q, user, project)
	s.checkDevice(q, user, text(input["deviceId"]))
	prior := q.One("select request_hash,payload from orka.receipts where project_id=$1 and author=$2 and id=$3", project, user, input["id"])
	if prior != nil {
		if !q.Require(text(prior["request_hash"]) == Hash(input), 409, "Retry ID reused with different content") {
			return 0, nil
		}
		receipt := clone(object(prior["payload"]))
		event := s.visibleEvent(q, user, project, object(receipt["event"]))
		if !q.Require(event != nil, 403, "Receipt access denied") {
			return 0, nil
		}
		receipt["event"] = event
		return number(locked["revision"]), receipt
	}
	return number(locked["revision"]) + 1, nil
}
func (s *Store) conflicts(q *Queries, project, id string) []any {
	result := []any{}
	for _, row := range q.Rows("select payload from orka.conflicts where project_id=$1 and resource_id=$2 and not resolved order by id", project, id) {
		result = append(result, row["payload"])
	}
	return result
}
func (s *Store) verifyFiles(q *Queries, project, user string, files []any) {
	for _, raw := range files {
		f := object(raw)
		uploaded := q.One("select 1 from orka.blob_uploads where project_id=$1 and hash=$2 and author=$3", project, f["hash"], user) != nil
		if !q.Require(uploaded || s.blobReadable(q, user, project, text(f["hash"])), 403, "Blob access denied") {
			return
		}
		row := q.One("select size from orka.blobs where project_id=$1 and hash=$2", project, f["hash"])
		if !q.Require(row != nil && number(row["size"]) == number(f["size"]), 400, "Upload and verify every blob before its manifest") {
			return
		}
	}
}
func (s *Store) saveChange(q *Queries, user string, input Object, revision int64, resource Object, conflicts []any, activity any, resolutions []any) Object {
	resource = merge(resource, Object{"hash": Hash(Object{"files": resource["files"], "deleted": resource["deleted"]})})
	project := text(input["projectId"])
	q.Exec("insert into orka.resources values($1,$2,$3,$4) on conflict(project_id,id) do update set revision=excluded.revision,payload=excluded.payload", project, resource["resourceId"], resource["revision"], resource)
	q.Exec("insert into orka.snapshots values($1,$2,$3,$4) on conflict do nothing", project, resource["resourceId"], resource["revision"], resource)
	event := Object{"revision": revision, "resource": resource, "conflicts": conflicts, "activity": activity}
	if len(resolutions) > 0 {
		event["memoryResolutions"] = resolutions
	}
	receipt := Object{"event": event, "conflict": len(conflicts) > 0}
	q.Exec("update orka.projects set revision=$2 where id=$1", project, revision)
	q.Exec("insert into orka.events values($1,$2,$3)", project, revision, event)
	q.Exec("insert into orka.receipts values($1,$2,$3,$4,$5)", project, user, input["id"], Hash(input), receipt)
	return receipt
}
func fileMap(resource Object) map[string]Object {
	m := map[string]Object{}
	for _, raw := range array(resource["files"]) {
		f := object(raw)
		m[text(f["path"])] = f
	}
	return m
}
func (s *Store) mergeFiles(q *Queries, project string, base, current, incoming Object) []any {
	b, c, n := fileMap(base), fileMap(current), fileMap(incoming)
	paths := []string{}
	for _, files := range []map[string]Object{b, c, n} {
		for path := range files {
			paths = append(paths, path)
		}
	}
	paths = unique(paths)
	sort.Strings(paths)
	result := []any{}
	for _, path := range paths {
		old, now, next := b[path], c[path], n[path]
		if Canonical(next) == Canonical(old) {
			if now != nil {
				result = append(result, now)
			}
			continue
		}
		if next == nil {
			continue
		}
		merged := clone(next)
		if old != nil && now != nil && next["hash"] == old["hash"] {
			merged = merge(now, Object{"executable": next["executable"]})
		}
		if old != nil && now != nil && next["hash"] != old["hash"] && now["hash"] != old["hash"] && now["hash"] != next["hash"] {
			buffers := [][]byte{}
			valid := true
			for _, f := range []Object{old, now, next} {
				data := s.readBlob(q, project, text(f["hash"]))
				buffers = append(buffers, data)
				valid = valid && !bytes.ContainsRune(data, 0) && utf8.Valid(data)
			}
			if valid && q.err == nil {
				data := []byte(MergeText(strings.TrimPrefix(string(buffers[0]), "\ufeff"), strings.TrimPrefix(string(buffers[1]), "\ufeff"), strings.TrimPrefix(string(buffers[2]), "\ufeff")))
				hash := s.putBlob(q, project, data)
				q.Exec("insert into orka.blobs values($1,$2,$3) on conflict do nothing", project, hash, len(data))
				merged = merge(next, Object{"hash": hash, "size": len(data)})
			}
		}
		if old != nil && now != nil && next["executable"] == old["executable"] {
			merged["executable"] = now["executable"]
		}
		result = append(result, merged)
	}
	return result
}
func (s *Store) change(q *Queries, user string, input Object, options ChangeOptions) Object {
	revision, prior := s.beginChange(q, user, input)
	if prior != nil || q.err != nil {
		return prior
	}
	project := text(input["projectId"])
	incoming := object(input["resource"])
	id := text(incoming["resourceId"])
	if incoming["sourceId"] != nil && !q.Require(q.One("select 1 from orka.project_sources where project_id=$1 and id=$2", project, incoming["sourceId"]) != nil, 400, "Source folder does not belong to this project") {
		return nil
	}
	existing := s.resource(q, project, id)
	if existing == nil {
		if !q.Require(q.One("select 1 from orka.resources where project_id=$1 and payload->>'kind'=$2 and payload->>'logicalPath'=$3 and coalesce(payload->>'sourceId','')=$4", project, incoming["kind"], incoming["logicalPath"], text(incoming["sourceId"])) == nil, 409, "Resource path already exists; edit the accepted resource") {
			return nil
		}
		if !q.Require(q.One("select 1 from orka.env_sets where project_id=$1 and id=$2", project, id) == nil, 409, "Resource ID is already used by an ENV set") {
			return nil
		}
	}
	target := existing
	if target == nil {
		target = incoming
	}
	mode := "publish"
	if options.Preview || options.Review {
		mode = "suggest"
	}
	var access Object
	if options.LegacyReview {
		access = s.access(q, user, project, target)
	} else {
		access = s.requireAccess(q, user, project, target, mode, existing == nil)
	}
	p := s.projectAccess(q, project, user)
	if p["rolePolicies"] != nil && flag(incoming["deleted"]) && !q.Require(flag(p["owner"]) || text(p["role"]) == "admin" && text(access["mode"]) == "publish", 403, "Only the Owner or an Admin with write access can delete shared content") {
		return nil
	}
	s.verifyFiles(q, project, user, array(incoming["files"]))
	s.sourcePermissions(q, user, project, incoming, existing, options.Preview)
	if flag(access["governed"]) && existing != nil && includes([]string{"instructions", "skill", "plan"}, policyClass(existing)) && !q.Require(number(input["baseRevision"]) == number(existing["revision"]), 409, "Resource changed; refresh and review the exact version again") {
		return nil
	}
	if text(incoming["kind"]) == "plan" && !flag(incoming["deleted"]) {
		files := array(incoming["files"])
		data := s.readBlob(q, project, text(field(files[0], "hash")))
		if !q.Require(utf8.Valid(data) && !bytes.ContainsRune(data, 0), 400, "Plans must contain UTF-8 Markdown") {
			return nil
		}
	}
	current := s.resource(q, project, id)
	conflicts := s.conflicts(q, project, id)
	if current != nil && !q.Require(current["kind"] == incoming["kind"] && current["sourceId"] == incoming["sourceId"] && current["source"] == incoming["source"] && current["logicalPath"] == incoming["logicalPath"], 409, "Resource identity cannot change") {
		return nil
	}
	if current == nil && !q.Require(number(input["baseRevision"]) == 0, 409, "Unknown base revision") {
		return nil
	}
	var base Object
	if current != nil {
		if number(input["baseRevision"]) == number(current["revision"]) {
			base = current
		} else {
			base = object(q.One("select payload from orka.snapshots where project_id=$1 and resource_id=$2 and revision=$3", project, id, input["baseRevision"])["payload"])
			if !q.Require(base != nil || number(input["baseRevision"]) == 0, 409, "Unknown base revision") {
				return nil
			}
		}
	}
	owner := user
	if current != nil {
		owner = text(current["owner"])
	}
	resource := merge(incoming, Object{"hash": Hash(Object{"files": incoming["files"], "deleted": incoming["deleted"]}), "projectId": project, "revision": revision, "owner": owner, "updatedBy": user, "updatedAt": stamp()})
	if text(current["kind"]) == "session" && user != text(current["owner"]) {
		if !q.Require(p["rolePolicies"] != nil && flag(incoming["deleted"]) && (len(array(incoming["files"])) == 0 || Hash(incoming["files"]) == Hash(current["files"])), 403, "Copy a teammate session before editing it") {
			return nil
		}
		if !q.Require(number(input["baseRevision"]) == number(current["revision"]), 409, "Session changed; review the current version before deleting it") {
			return nil
		}
		resource = merge(current, Object{"files": []any{}, "deleted": true, "hash": Hash(Object{"files": []any{}, "deleted": true}), "revision": revision, "updatedBy": user, "updatedAt": resource["updatedAt"]})
	}
	differs := current != nil && (Hash(current["files"]) != Hash(resource["files"]) || current["deleted"] != resource["deleted"])
	resolutions := []any{}
	if text(resource["kind"]) == "memory" && !flag(resource["deleted"]) && !options.Exact && !(flag(access["governed"]) && policyClass(resource) == "instructions") {
		read := func(r Object) string {
			if r == nil || flag(r["deleted"]) || len(array(r["files"])) == 0 {
				return ""
			}
			data := s.readBlob(q, project, text(field(array(r["files"])[0], "hash")))
			q.Require(!bytes.ContainsRune(data, 0) && utf8.Valid(data), 400, "Memory must contain UTF-8 text")
			return strings.TrimPrefix(string(data), "\ufeff")
		}
		original, accepted, proposed := read(base), read(current), read(resource)
		if q.err != nil {
			return nil
		}
		details := Object{"logicalPath": resource["logicalPath"], "title": resource["title"], "source": resource["source"], "baseRevision": input["baseRevision"], "currentRevision": number(current["revision"]), "incomingAuthor": user}
		if current != nil {
			details["currentAuthor"] = current["updatedBy"]
		}
		merged, answers, err := ConsolidateMemory(q.ctx, original, accepted, proposed, details, s.Resolver)
		if !q.Check(err) {
			return nil
		}
		data := []byte(merged)
		if !q.Require(len(data) <= 1000000, 413, "Merged resource exceeds size limit") {
			return nil
		}
		hash := s.putBlob(q, project, data)
		q.Exec("insert into orka.blobs values($1,$2,$3) on conflict do nothing", project, hash, len(data))
		first := object(array(resource["files"])[0])
		executable := first["executable"]
		currentFiles, baseFiles := array(current["files"]), array(base["files"])
		if len(currentFiles) > 0 && len(baseFiles) > 0 && field(baseFiles[0], "executable") == executable {
			executable = field(currentFiles[0], "executable")
		}
		resource["files"] = []any{merge(first, Object{"hash": hash, "size": len(data), "executable": executable})}
		resolutions = answers
	} else if text(current["kind"]) == "session" && differs && (number(input["baseRevision"]) != number(current["revision"]) || len(conflicts) > 0) {
		candidate := Object{"id": input["id"], "resourceId": id, "author": user, "deviceId": input["deviceId"], "candidate": resource, "revision": revision}
		conflicts = append(conflicts, candidate)
		q.Exec("insert into orka.conflicts(id,project_id,resource_id,payload) values($1,$2,$3,$4)", input["id"], project, id, candidate)
		resource = merge(current, Object{"revision": revision})
	} else if current != nil && text(current["kind"]) != "session" && !flag(resource["deleted"]) && !flag(current["deleted"]) && number(input["baseRevision"]) != number(current["revision"]) {
		if base == nil {
			base = merge(current, Object{"files": []any{}})
		}
		resource["files"] = s.mergeFiles(q, project, base, current, resource)
		size, hasSkill := int64(0), false
		for _, raw := range array(resource["files"]) {
			size += number(field(raw, "size"))
			hasSkill = hasSkill || text(field(raw, "path")) == "SKILL.md"
		}
		if text(resource["kind"]) == "skill" && !q.Require(hasSkill, 409, "Merged skill must contain SKILL.md") {
			return nil
		}
		limit := int64(1000000)
		if text(resource["kind"]) == "skill" {
			limit = 4000000
		}
		if !q.Require(size <= limit, 413, "Merged resource exceeds size limit") {
			return nil
		}
	}
	if options.Preview {
		return Object{"event": Object{"revision": revision, "resource": resource, "conflicts": conflicts, "activity": nil, "memoryResolutions": resolutions}, "conflict": len(conflicts) > 0}
	}
	return s.saveChange(q, user, input, revision, resource, conflicts, nil, resolutions)
}
func (s *Store) resolve(q *Queries, user string, input Object) Object {
	revision, prior := s.beginChange(q, user, input)
	if prior != nil || q.err != nil {
		return prior
	}
	project, id := text(input["projectId"]), text(input["resourceId"])
	current := s.resource(q, project, id)
	conflicts := s.conflicts(q, project, id)
	var candidate Object
	for _, raw := range conflicts {
		if field(raw, "id") == input["conflictId"] {
			candidate = object(raw)
		}
	}
	if !q.Require(current != nil && number(current["revision"]) == number(input["expectedRevision"]) && candidate != nil, 409, "Conflict changed; refresh before resolving") {
		return nil
	}
	s.requireAccess(q, user, project, current, "read", false)
	if text(input["action"]) != "copy" {
		s.requireAccess(q, user, project, current, "publish", false)
	} else {
		s.requireAccess(q, user, project, merge(current, Object{"resourceId": input["id"]}), "publish", true)
		selected := current
		if text(input["selected"]) == "candidate" {
			selected = object(candidate["candidate"])
		}
		if !q.Require(text(selected["owner"]) == user, 403, "Only the selected version owner can promote it to a copy") {
			return nil
		}
		q.Exec("update orka.conflicts set resolved=true where id=$1", candidate["id"])
		copyID := text(input["id"])
		copy := merge(selected, Object{"resourceId": copyID, "logicalPath": "copies/" + copyID, "title": text(current["title"]) + " (copy)", "revision": revision, "owner": user, "updatedBy": user, "updatedAt": stamp()})
		remaining := []any{}
		for _, raw := range conflicts {
			if field(raw, "id") != candidate["id"] {
				remaining = append(remaining, raw)
			}
		}
		updated := merge(current, Object{"revision": revision})
		q.Exec("update orka.resources set revision=$3,payload=$4 where project_id=$1 and id=$2", project, id, revision, updated)
		q.Exec("insert into orka.snapshots values($1,$2,$3,$4)", project, id, revision, updated)
		copy["contextSources"] = unique(append(stringsOf(copy["contextSources"]), id))
		s.sourcePermissions(q, user, project, copy, nil, false)
		receipt := s.saveChange(q, user, input, revision, copy, []any{}, Object{"id": input["id"], "type": "session_copied", "resourceId": id, "copyId": copyID, "author": user, "notifyOwner": current["owner"]}, nil)
		payload := merge(object(receipt["event"]), Object{"related": []any{Object{"resource": updated, "conflicts": remaining}}})
		q.Exec("update orka.events set payload=$3 where project_id=$1 and revision=$2", project, revision, payload)
		result := merge(receipt, Object{"event": payload})
		q.Exec("update orka.receipts set payload=$4 where project_id=$1 and author=$2 and id=$3", project, user, input["id"], result)
		return result
	}
	if !q.Require(text(current["owner"]) == user, 403, "Only the session owner can resolve its versions") {
		return nil
	}
	selected := object(candidate["candidate"])
	if text(input["selected"]) == "current" {
		selected = current
	}
	q.Exec("update orka.conflicts set resolved=true where project_id=$1 and resource_id=$2", project, id)
	return s.saveChange(q, user, input, revision, merge(selected, Object{"revision": revision, "updatedBy": user, "updatedAt": stamp()}), []any{}, nil, nil)
}
func (s *Store) copySession(q *Queries, user string, input Object) Object {
	revision, prior := s.beginChange(q, user, input)
	if prior != nil || q.err != nil {
		return prior
	}
	project, id := text(input["projectId"]), text(input["resourceId"])
	current := s.resource(q, project, id)
	if !q.Require(current != nil && text(current["kind"]) == "session" && !flag(current["deleted"]), 409, "Session unavailable") {
		return nil
	}
	s.requireAccess(q, user, project, current, "read", false)
	s.requireAccess(q, user, project, merge(current, Object{"resourceId": input["id"]}), "publish", true)
	source := current
	if number(current["revision"]) != number(input["expectedRevision"]) {
		source = object(q.One("select payload from orka.snapshots where project_id=$1 and resource_id=$2 and revision=$3", project, id, input["expectedRevision"])["payload"])
	}
	if !q.Require(source != nil && !flag(source["deleted"]), 409, "Cached session revision unavailable") {
		return nil
	}
	copyID := text(input["id"])
	resource := merge(source, Object{"resourceId": copyID, "logicalPath": "copies/" + copyID, "title": text(source["title"]) + " (copy)", "revision": revision, "owner": user, "updatedBy": user, "updatedAt": stamp()})
	resource["contextSources"] = unique(append(stringsOf(resource["contextSources"]), id))
	s.sourcePermissions(q, user, project, resource, nil, false)
	return s.saveChange(q, user, input, revision, resource, []any{}, Object{"id": input["id"], "type": "session_copied", "resourceId": id, "copyId": copyID, "author": user, "notifyOwner": current["owner"]}, nil)
}
