package server

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"
)

type SessionMessage struct {
	Role string `json:"role"`
	Text string `json:"text"`
}

func contentText(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	parts := []string{}
	for _, p := range array(v) {
		if includes([]string{"text", "input_text", "output_text", "Text"}, text(field(p, "type"))) {
			parts = append(parts, text(field(p, "text")))
		}
	}
	return strings.Join(parts, "\n")
}

var setupPrefix = regexp.MustCompile(`^(# AGENTS\.md instructions|<environment_context|<local-command|<command-|<INSTRUCTIONS|<user_instructions|<turn_aborted|<task-notification|<external_codex_apps|This session is being continued|You are continuing a task)`)
var setupBlocks = func() []*regexp.Regexp {
	out := []*regexp.Regexp{}
	for _, tag := range []string{"environment_context", "INSTRUCTIONS", "user_instructions", "system-reminder", "local-command-caveat", "in-app-browser-context", "external_codex_apps_open_page"} {
		out = append(out, regexp.MustCompile(`(?s)<`+tag+`(?:\s[^>]*)?>.*?</`+tag+`>`))
	}
	return out
}()

func SessionMessages(records []Object) []SessionMessage {
	type candidate struct {
		message    SessionMessage
		tier, turn int
	}
	candidates := []candidate{}
	turn := 0
	for _, record := range records {
		payload := object(record["payload"])
		kind := text(record["type"])
		if kind == "session_meta" || kind == "event_msg" && includes([]string{"task_started", "user_message"}, text(payload["type"])) {
			turn++
		}
		var value Object
		tier := 0
		switch {
		case kind == "response_item":
			value = payload
		case kind == "event_msg" && text(payload["type"]) == "item_completed":
			value = object(payload["item"])
			tier = 1
		case kind == "event_msg" && includes([]string{"user_message", "agent_message"}, text(payload["type"])):
			value = payload
			tier = 2
		case kind == "user" || kind == "assistant":
			value = object(record["message"])
		default:
			continue
		}
		_, author := value["author"].(string)
		if flag(record["isMeta"]) || text(value["channel"]) == "analysis" || text(value["type"]) == "agent_message" && author {
			continue
		}
		role := text(value["role"])
		if role == "" {
			if kind == "user" || kind == "assistant" {
				role = kind
			} else {
				role = text(value["type"])
			}
		}
		if includes([]string{"user", "user_message", "userMessage", "UserMessage"}, role) {
			role = "user"
		} else if includes([]string{"assistant", "agent_message", "agentMessage", "AgentMessage"}, role) {
			role = "assistant"
		} else {
			continue
		}
		raw := value["content"]
		if raw == nil {
			raw = value["text"]
		}
		if tier == 2 {
			raw = value["message"]
		}
		content := contentText(raw)
		if role == "user" {
			parts := strings.Split(content, "## My request:")
			content = parts[len(parts)-1]
			for _, pattern := range setupBlocks {
				content = pattern.ReplaceAllString(content, "")
			}
			content = trim(content)
			if setupPrefix.MatchString(content) {
				continue
			}
		}
		if content = trim(content); content != "" {
			candidates = append(candidates, candidate{SessionMessage{role, content}, tier, turn})
		}
	}
	key := func(c candidate) string { return string(jsonBytes([]any{c.turn, c.message.Role, c.message.Text})) }
	counts := map[string][3]int{}
	seen := map[string][3]int{}
	for _, c := range candidates {
		n := counts[key(c)]
		n[c.tier]++
		counts[key(c)] = n
	}
	out := []SessionMessage{}
	for _, c := range candidates {
		k := key(c)
		n := seen[k]
		n[c.tier]++
		seen[k] = n
		skip := false
		all := counts[k]
		for _, count := range all[:c.tier] {
			if count >= n[c.tier] {
				skip = true
			}
		}
		if !skip {
			out = append(out, c.message)
		}
	}
	return out
}
func decodeText(bytes []byte) (string, error) {
	if !utf8.Valid(bytes) {
		return "", fmt.Errorf("invalid UTF-8")
	}
	return strings.TrimPrefix(string(bytes), "\ufeff"), nil
}
func (s *Store) readSession(q *Queries, resource Object) []SessionMessage {
	if !q.Require(text(resource["kind"]) == "session" && !flag(resource["deleted"]), 404, "Session unavailable") {
		return nil
	}
	files := map[string]Object{}
	total := int64(0)
	for _, f := range array(resource["files"]) {
		file := object(f)
		files[text(file["path"])] = file
		total += number(file["size"])
	}
	if !q.Require(total <= 32_000_000, 413, "Session exceeds the plugin's 32 MB reading limit. Open it in Orka.") {
		return nil
	}
	visited := map[string]bool{}
	type boundary struct {
		id         string
		end, bytes int64
	}
	var load func(string, *boundary) []Object
	load = func(path string, expected *boundary) []Object {
		if !q.Require(!visited[path] && len(visited) < 100, 422, "Invalid session lineage") {
			return nil
		}
		visited[path] = true
		file := files[path]
		if !q.Require(file != nil, 422, "Incomplete session lineage. Sync this session from its source device.") {
			return nil
		}
		bytes := s.readBlob(q, text(resource["projectId"]), text(file["hash"]))
		if !q.Require(int64(len(bytes)) == number(file["size"]) && (expected == nil || int64(len(bytes)) == expected.bytes) && len(bytes) > 0 && bytes[len(bytes)-1] == 10, 422, "Invalid session boundary") {
			return nil
		}
		raw, err := decodeText(bytes)
		if !q.Require(err == nil, 422, "Cannot decode the session. Open the original in Orka.") {
			return nil
		}
		records := []Object{}
		for _, line := range strings.Split(strings.TrimRight(raw, " \n\r\t\v\f\u00a0\ufeff"), "\n") {
			if line == "" {
				continue
			}
			v, err := decode([]byte(line))
			if !q.Require(err == nil, 422, "Cannot decode the session. Open the original in Orka.") {
				return nil
			}
			row := object(v)
			if row == nil {
				row = Object{}
			}
			records = append(records, row)
		}
		if text(resource["source"]) == "claude" {
			ids := map[string]bool{}
			for _, r := range records {
				if id := text(r["sessionId"]); id != "" {
					ids[id] = true
				}
			}
			q.Require(len(ids) <= 1, 422, "Mixed session identities")
			return records
		}
		var first Object
		if len(records) > 0 {
			first = records[0]
		}
		meta := object(first["payload"])
		_, idIsString := meta["id"].(string)
		if !q.Require(text(first["type"]) == "session_meta" && idIsString, 422, "Unknown Codex session format") {
			return nil
		}
		mode := text(meta["history_mode"])
		if !q.Require(meta["history_mode"] == nil || mode == "legacy" || mode == "paginated", 422, "Unsupported Codex history mode") {
			return nil
		}
		if !q.Require(expected == nil || text(meta["id"]) == expected.id, 422, "Session lineage identity changed") {
			return nil
		}
		base := object(meta["history_base"])
		if mode == "paginated" {
			start := number(base["end_ordinal_exclusive"])
			for i, r := range records {
				if !q.Require(r["ordinal"] != nil && number(r["ordinal"]) == start+int64(i), 422, "Invalid history ordinals") {
					return nil
				}
			}
			if !q.Require(expected == nil || start+int64(len(records)) == expected.end, 422, "Session lineage boundary changed") {
				return nil
			}
		} else if !q.Require(expected == nil && meta["history_base"] == nil, 422, "Invalid inherited history") {
			return nil
		}
		if len(base) == 0 {
			return records
		}
		end, n := number(base["end_ordinal_exclusive"]), number(base["end_byte_offset"])
		_, isString := base["thread_id"].(string)
		if !q.Require(isString && safePositiveInteger(base["end_ordinal_exclusive"]) && safePositiveInteger(base["end_byte_offset"]), 422, "Invalid inherited boundary") {
			return nil
		}
		preferred := fmt.Sprintf("lineage/%s/%d.jsonl", text(base["thread_id"]), end)
		if files[preferred] == nil {
			preferred = "lineage/" + text(base["thread_id"]) + ".jsonl"
		}
		return append(load(preferred, &boundary{text(base["thread_id"]), end, n}), records...)
	}
	records := load("session.jsonl", nil)
	q.Require(len(visited) == len(files), 422, "Session has unreferenced history files")
	return SessionMessages(records)
}
func safePositiveInteger(v any) bool {
	var n float64
	switch x := v.(type) {
	case json.Number:
		var err error
		n, err = x.Float64()
		if err != nil {
			return false
		}
	case float64:
		n = x
	case int64:
		n = float64(x)
	default:
		return false
	}
	return n >= 1 && n <= 9007199254740991 && n == float64(int64(n))
}
