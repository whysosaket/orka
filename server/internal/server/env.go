package server

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"time"
)

func VerifyEnvSignature(key string, value any, signature string) bool {
	public, err := hex.DecodeString(key)
	if err != nil || len(public) != ed25519.PublicKeySize {
		return false
	}
	signed, err := hex.DecodeString(signature)
	return err == nil && len(signed) == ed25519.SignatureSize && ed25519.Verify(ed25519.PublicKey(public), []byte(Canonical(value)), signed)
}
func requireEnvSignature(q *Queries, device Object, value any, signature string) bool {
	return q.Require(VerifyEnvSignature(text(device["signingKey"]), value, signature), 403, "Invalid ENV signature")
}
func envAccess(manifest Object) string {
	return Canonical(Object{"grants": manifest["grants"], "devices": manifest["devices"], "approvals": manifest["approvals"]})
}
func envDeviceByID(devices any, id string) Object {
	for _, raw := range array(devices) {
		if text(field(raw, "id")) == id {
			return object(raw)
		}
	}
	return nil
}
func envApprovalByID(approvals any, id string) Object {
	for _, raw := range array(approvals) {
		if text(field(field(field(raw, "request"), "device"), "id")) == id {
			return object(raw)
		}
	}
	return nil
}
func validEnvTransition(previous, next Object) bool {
	grants := stringsOf(next["grants"])
	devices, approvals := array(next["devices"]), array(next["approvals"])
	ids, approvalIDs, nonces := []string{}, []string{}, []string{}
	for _, d := range devices {
		ids = append(ids, text(field(d, "id")))
		if !includes(grants, text(field(d, "owner"))) {
			return false
		}
	}
	for _, a := range approvals {
		approvalIDs = append(approvalIDs, text(field(field(field(a, "request"), "device"), "id")))
		nonces = append(nonces, text(field(field(a, "request"), "nonce")))
	}
	if len(unique(grants)) != len(grants) || len(unique(ids)) != len(ids) || len(unique(approvalIDs)) != len(approvalIDs) || len(unique(nonces)) != len(nonces) || !includes(grants, text(next["creator"])) {
		return false
	}
	source := previous
	if source == nil {
		source = next
	}
	author := envDeviceByID(source["devices"], text(next["authorDeviceId"]))
	if author == nil {
		return false
	}
	if previous == nil {
		return number(next["revision"]) == 1 && number(next["accessRevision"]) == 1 && text(next["previousHash"]) == "" && !flag(next["deleted"]) && author["owner"] == next["creator"] && len(devices) == 1 && len(approvals) == 0
	}
	sourceID := func(m Object) any {
		if m["sourceId"] != nil {
			return m["sourceId"]
		}
		return m["projectId"]
	}
	accessIncrement := int64(0)
	if envAccess(previous) != envAccess(next) {
		accessIncrement = 1
	}
	if flag(previous["deleted"]) || next["creator"] != previous["creator"] || next["projectId"] != previous["projectId"] || sourceID(next) != sourceID(previous) || next["setId"] != previous["setId"] || number(next["revision"]) != number(previous["revision"])+1 || !includes(stringsOf(previous["grants"]), text(author["owner"])) || number(next["accessRevision"]) != number(previous["accessRevision"])+accessIncrement {
		return false
	}
	if author["owner"] != previous["creator"] && (flag(next["deleted"]) || next["name"] != previous["name"] || Canonical(next["grants"]) != Canonical(previous["grants"])) {
		return false
	}
	for _, raw := range devices {
		device := object(raw)
		old := envDeviceByID(previous["devices"], text(device["id"]))
		if old != nil {
			if Canonical(old) != Canonical(device) {
				return false
			}
		} else {
			approval := envApprovalByID(next["approvals"], text(device["id"]))
			request := object(approval["request"])
			if approval == nil || Canonical(request["device"]) != Canonical(device) || request["projectId"] != next["projectId"] || request["setId"] != next["setId"] || (author["owner"] != previous["creator"] && author["owner"] != device["owner"]) {
				return false
			}
		}
	}
	if author["owner"] != previous["creator"] {
		for _, raw := range array(previous["devices"]) {
			device := object(raw)
			if envDeviceByID(next["devices"], text(device["id"])) == nil && device["owner"] != author["owner"] {
				return false
			}
		}
	}
	for _, raw := range approvals {
		approval := object(raw)
		device := object(field(approval["request"], "device"))
		if Canonical(envDeviceByID(next["devices"], text(device["id"]))) != Canonical(device) {
			return false
		}
		old := envApprovalByID(previous["approvals"], text(device["id"]))
		if old != nil && Canonical(old) != Canonical(approval) {
			return false
		}
	}
	for _, raw := range array(previous["approvals"]) {
		approval := object(raw)
		id := text(field(field(approval["request"], "device"), "id"))
		if envDeviceByID(next["devices"], id) != nil && Canonical(envApprovalByID(next["approvals"], id)) != Canonical(approval) {
			return false
		}
	}
	return true
}
func envAllowed(q *Queries, manifest Object, user, device string) bool {
	registered := envDeviceByID(manifest["devices"], device)
	return q.Require(!flag(manifest["deleted"]) && includes(stringsOf(manifest["grants"]), user) && text(registered["owner"]) == user, 403, "ENV access requires an approved device")
}

func (s *Store) envAction(q *Queries, user string, signed Object) any {
	call := object(signed["call"])
	delta := time.Now().UnixMilli() - number(call["time"])
	if !q.Require(delta >= -300000 && delta <= 300000, 400, "ENV request expired; check this Mac’s clock") {
		return nil
	}
	operation := text(call["operation"])
	var device Object
	if operation == "enroll" {
		device = object(q.Contract("envDevice", call["input"]))
	} else {
		row := q.One("select payload from orka.env_devices where id=$1 and owner=$2", call["deviceId"], user)
		if !q.Require(row != nil, 403, "Enable ENVs on this Mac first") {
			return nil
		}
		device = object(q.Contract("envDevice", row["payload"]))
	}
	if !q.Require(device["id"] == call["deviceId"] && text(device["owner"]) == user, 403, "ENV device belongs to another account") || !requireEnvSignature(q, device, call, text(signed["signature"])) {
		return nil
	}
	switch operation {
	case "enroll":
		inserted := q.One("insert into orka.env_devices values($1,$2,$3) on conflict(id) do nothing returning id", device["id"], user, device)
		if inserted == nil {
			old := q.One("select payload from orka.env_devices where id=$1", device["id"])
			q.Require(Canonical(old["payload"]) == Canonical(device), 409, "ENV device keys cannot be replaced; enroll a new device")
		}
		return Object{"device": device}
	case "directory":
		v := q.Parse(call["input"], scopeShape(nil))
		project := text(v["projectId"])
		s.member(q, user, project)
		return Object{"members": values(q.Rows(`select m.user_id as id,coalesce(p.label,'Member ' || left(m.user_id::text,8)) as label,coalesce((select jsonb_agg(d.payload order by d.id) from orka.env_devices d where d.owner=m.user_id),'[]'::jsonb) as devices from orka.members m left join orka.env_profiles p on p.user_id=m.user_id where m.project_id=$1 order by label`, project))}
	case "list":
		v := q.Parse(call["input"], scopeShape(nil))
		project := text(v["projectId"])
		q.Exec("select id from orka.projects where id=$1 for share", project)
		s.member(q, user, project)
		sets := []any{}
		records := q.Rows("select s.header,s.updated_at,(select a.author from orka.env_activity a where a.project_id=s.project_id and a.set_id=s.id and a.revision=s.revision limit 1) as updated_by from orka.env_sets s where s.project_id=$1 and s.header->'manifest'->'grants' ? $2 and s.header->'manifest'->>'deleted'='false' order by s.updated_at desc", project, user)
		for _, row := range records {
			m := object(field(row["header"], "manifest"))
			access := s.access(q, user, project, Object{"resourceId": m["setId"], "kind": "env", "owner": m["creator"]})
			if text(access["mode"]) == "hidden" {
				continue
			}
			replacement := q.One("select replacement_id,disabled from orka.env_replacements where project_id=$1 and set_id=$2", project, m["setId"])
			source, updatedBy := m["sourceId"], row["updated_by"]
			if source == nil {
				source = project
			}
			if updatedBy == nil {
				updatedBy = m["creator"]
			}
			approved := envDeviceByID(m["devices"], text(device["id"]))
			sets = append(sets, Object{"access": access, "disabled": flag(replacement["disabled"]), "replacementId": replacement["replacement_id"], "setId": m["setId"], "sourceId": source, "projectId": project, "name": m["name"], "creator": m["creator"], "revision": m["revision"], "accessRevision": m["accessRevision"], "grants": m["grants"], "devices": m["devices"], "updatedAt": row["updated_at"], "updatedBy": updatedBy, "approved": text(approved["owner"]) == user})
		}
		return Object{"sets": sets}
	case "read":
		v := q.Parse(call["input"], scopeShape(map[string]Field{"setId": uuidField()}))
		project, setID := text(v["projectId"]), text(v["setId"])
		q.Exec("select id from orka.projects where id=$1 for share", project)
		s.member(q, user, project)
		row := q.One("select header,ciphertext from orka.env_sets where project_id=$1 and id=$2", project, setID)
		if !q.Require(row != nil, 404, "ENV set not found") {
			return nil
		}
		manifest := object(field(row["header"], "manifest"))
		s.requireAccess(q, user, project, Object{"resourceId": setID, "kind": "env", "owner": manifest["creator"]}, "read", false)
		replacement := q.One("select replacement_id from orka.env_replacements where project_id=$1 and set_id=$2 and disabled", project, setID)
		if !q.Require(replacement["replacement_id"] == nil, 403, "This ENV set has been replaced; use the replacement set") || !envAllowed(q, manifest, user, text(device["id"])) {
			return nil
		}
		chain := []any{}
		for _, history := range q.Rows("select header from orka.env_headers where project_id=$1 and set_id=$2 order by revision", project, setID) {
			chain = append(chain, history["header"])
		}
		return Object{"version": merge(object(row["header"]), Object{"ciphertext": row["ciphertext"]}), "chain": chain}
	}
	input := object(q.Contract("envMutation", call["input"]))
	version := object(input["version"])
	next := object(version["manifest"])
	if !q.Require(next["authorDeviceId"] == device["id"], 403, "ENV publisher does not match this device") || !requireEnvSignature(q, device, next, text(version["signature"])) {
		return nil
	}
	encrypted, err := base64.StdEncoding.Strict().DecodeString(text(version["ciphertext"]))
	valid := err == nil && base64.StdEncoding.EncodeToString(encrypted) == text(version["ciphertext"]) && bytesHash(encrypted) == text(next["ciphertextHash"])
	if flag(next["deleted"]) {
		valid = valid && len(encrypted) == 0
	} else {
		valid = valid && len(encrypted) <= 1150000 && bytes.HasPrefix(encrypted, []byte("age-encryption.org/v1\n"))
	}
	if !q.Require(valid, 400, "Invalid encrypted ENV payload") {
		return nil
	}
	return s.envMutate(q, user, device, input)
}
func (s *Store) envMutate(q *Queries, user string, device, input Object) any {
	version := object(input["version"])
	next := object(version["manifest"])
	project, setID := text(next["projectId"]), text(next["setId"])
	q.Exec("select id from orka.projects where id=$1 for update", project)
	s.member(q, user, project)
	if next["sourceId"] != nil && !q.Require(q.One("select 1 from orka.project_sources where project_id=$1 and id=$2", project, next["sourceId"]) != nil, 400, "ENV source folder does not belong to this project") {
		return nil
	}
	previous := object(q.One("select header from orka.env_sets where project_id=$1 and id=$2", project, setID)["header"])
	old := object(previous["manifest"])
	if previous == nil && !q.Require(s.resource(q, project, setID) == nil, 409, "ENV ID is already used by an ordinary resource") {
		return nil
	}
	s.requireAccess(q, user, project, Object{"resourceId": setID, "kind": "env", "owner": old["creator"]}, "publish", previous == nil)
	if !q.Require(q.One("select 1 from orka.env_replacements where project_id=$1 and set_id=$2 and disabled", project, setID) == nil, 403, "This ENV set needs replacement and cannot publish new versions") {
		return nil
	}
	if previous != nil && Canonical(old["grants"]) != Canonical(next["grants"]) && !flag(s.access(q, user, project, Object{"resourceId": setID, "kind": "env", "owner": next["creator"]})["canShare"]) && flag(s.projectAccess(q, project, user)["governed"]) {
		q.Require(false, 403, "Managing ENV recipients requires sharing permission and a trusted device")
		return nil
	}
	receipt := q.One("select request_hash,payload from orka.env_receipts where project_id=$1 and author=$2 and id=$3", project, user, input["requestId"])
	if receipt != nil {
		q.Require(text(receipt["request_hash"]) == Hash(input), 409, "ENV retry ID reused with different content")
		return receipt["payload"]
	}
	if previous != nil {
		if !envAllowed(q, old, user, text(device["id"])) {
			return nil
		}
	} else if !q.Require(text(next["creator"]) == user, 403, "Only the ENV creator can initialize a set") {
		return nil
	}
	previousHash := ""
	if previous != nil {
		previousHash = Hash(previous)
	}
	if !q.Require(number(input["expectedRevision"]) == number(old["revision"]) && number(input["expectedAccessRevision"]) == number(old["accessRevision"]) && text(next["previousHash"]) == previousHash, 409, "ENV changed. Pull the latest version and review before publishing again") || !q.Require(validEnvTransition(old, next), 403, "Invalid ENV authorization transition") {
		return nil
	}
	members := []string{}
	for _, member := range q.Rows("select user_id from orka.members where project_id=$1", project) {
		members = append(members, text(member["user_id"]))
	}
	for _, recipient := range stringsOf(next["grants"]) {
		if !q.Require(includes(members, recipient), 403, "ENV recipients must be current project members") {
			return nil
		}
	}
	if flag(s.projectAccess(q, project, user)["governed"]) {
		for _, recipient := range stringsOf(next["grants"]) {
			if !q.Require(text(s.access(q, recipient, project, Object{"resourceId": setID, "kind": "env", "owner": next["creator"]})["mode"]) != "hidden", 403, "ENV recipient also needs project permission") {
				return nil
			}
		}
	}
	for _, raw := range array(next["devices"]) {
		recipient := object(raw)
		registered := q.One("select payload from orka.env_devices where id=$1 and owner=$2", recipient["id"], recipient["owner"])
		if !q.Require(registered != nil && Canonical(registered["payload"]) == Canonical(recipient), 403, "ENV recipient device keys changed") {
			return nil
		}
	}
	oldNonces := []string{}
	for _, approval := range array(old["approvals"]) {
		oldNonces = append(oldNonces, text(field(field(approval, "request"), "nonce")))
	}
	added := []Object{}
	for _, raw := range array(next["approvals"]) {
		approval := object(raw)
		request := object(approval["request"])
		if !requireEnvSignature(q, object(request["device"]), request, text(approval["signature"])) {
			return nil
		}
		if !includes(oldNonces, text(request["nonce"])) {
			added = append(added, approval)
		}
	}
	for _, approval := range added {
		request := object(approval["request"])
		expires := number(request["expiresAt"])
		now := time.Now().UnixMilli()
		if !q.Require(expires >= now && expires <= now+900000, 400, "Device approval expired; generate a new request") {
			return nil
		}
		if !q.Require(q.One("select 1 from orka.env_nonces where project_id=$1 and set_id=$2 and nonce=$3", project, setID, request["nonce"]) == nil, 409, "Device approval request already used") {
			return nil
		}
	}
	header := Object{"manifest": next, "signature": version["signature"]}
	q.Exec("insert into orka.env_sets values($1,$2,$3,$4,$5,now()) on conflict(project_id,id) do update set revision=excluded.revision,header=excluded.header,ciphertext=excluded.ciphertext,updated_at=now()", project, setID, next["revision"], header, version["ciphertext"])
	q.Exec("insert into orka.env_headers values($1,$2,$3,$4)", project, setID, next["revision"], header)
	for _, approval := range added {
		q.Exec("insert into orka.env_nonces values($1,$2,$3)", project, setID, field(approval["request"], "nonce"))
	}
	result := Object{"revision": next["revision"], "hash": Hash(header)}
	q.Exec("insert into orka.env_receipts values($1,$2,$3,$4,$5)", project, user, input["requestId"], Hash(input), result)
	action := "published"
	if flag(next["deleted"]) {
		action = "deleted"
	} else if previous == nil {
		action = "created"
	} else if number(next["accessRevision"]) != number(old["accessRevision"]) {
		action = "access_changed"
	}
	q.Exec("insert into orka.env_activity(project_id,set_id,author,device_id,revision,action) values($1,$2,$3,$4,$5,$6)", project, setID, user, device["id"], next["revision"], action)
	return result
}
