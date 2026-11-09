package server

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

//go:embed contracts.json
var contractBytes []byte
var contractDocs map[string]Object
var contracts map[string]*jsonschema.Schema

func init() {
	if err := json.Unmarshal(contractBytes, &contractDocs); err != nil {
		panic(err)
	}
	contracts = map[string]*jsonschema.Schema{}
	for name, doc := range contractDocs {
		compiler := jsonschema.NewCompiler()
		compiler.AssertFormat()
		loc := "https://orka.invalid/contracts/" + name
		if err := compiler.AddResource(loc, doc); err != nil {
			panic(err)
		}
		schema, err := compiler.Compile(loc)
		if err != nil {
			panic(fmt.Errorf("contract %s: %w", name, err))
		}
		contracts[name] = schema
	}
}
func validUUID(v string) bool   { return contracts["uuid"].Validate(v) == nil }
func validDigest(v string) bool { return contracts["digest"].Validate(v) == nil }

func normalize(doc Object, compiled *jsonschema.Schema, value any) any {
	if compiled == nil {
		return value
	}
	if m := object(value); m != nil && len(m) == 0 && flag(doc["x-orka-empty-form"]) {
		value = Object{"form": Object{}}
	}
	for _, kind := range []string{"anyOf", "oneOf"} {
		branches := compiled.AnyOf
		if kind == "oneOf" {
			branches = compiled.OneOf
		}
		for i, raw := range array(doc[kind]) {
			if i >= len(branches) {
				break
			}
			copy, _ := decode(jsonBytes(value))
			candidate := normalize(object(raw), branches[i], copy)
			if branches[i].Validate(candidate) == nil {
				return candidate
			}
		}
	}
	if s, ok := value.(string); ok && flag(doc["x-orka-trim"]) {
		value = trim(s)
	}
	if m := object(value); m != nil {
		properties := object(doc["properties"])
		for key, raw := range properties {
			schema := object(raw)
			v, present := m[key]
			if !present {
				if d, ok := schema["default"]; ok {
					m[key], _ = decode(jsonBytes(d))
				}
				continue
			}
			m[key] = normalize(schema, compiled.Properties[key], v)
		}
		if text(doc["type"]) == "object" {
			additional, explicit := doc["additionalProperties"]
			for key, v := range m {
				if _, known := properties[key]; known {
					continue
				}
				if !explicit {
					delete(m, key)
				} else if schema, ok := compiled.AdditionalProperties.(*jsonschema.Schema); ok {
					m[key] = normalize(object(additional), schema, v)
				}
			}
		}
	}
	if a := array(value); a != nil {
		for i, v := range a {
			a[i] = normalize(object(doc["items"]), compiled.Items2020, v)
		}
	}
	return value
}
func ValidateContract(name string, value any) (any, error) {
	schema, ok := contracts[name]
	if !ok {
		return nil, fmt.Errorf("unknown contract %s", name)
	}
	copy, err := decode(jsonBytes(value))
	if err != nil {
		return nil, err
	}
	value = normalize(contractDocs[name], schema, copy)
	if err := schema.Validate(value); err != nil {
		return nil, bad("Invalid request")
	}
	if err := validateRefinements(contractDocs[name], value); err != nil {
		return nil, err
	}
	if err := validateResourceContract(name, value); err != nil {
		return nil, err
	}
	return value, nil
}
func validateRefinements(doc Object, value any) error {
	if name := text(doc["x-orka-refinement"]); name != "" {
		if err := validateResourceContract(name, value); err != nil {
			return err
		}
	}
	if m := object(value); m != nil {
		for key, child := range m {
			if schema := object(field(doc["properties"], key)); schema != nil {
				if err := validateRefinements(schema, child); err != nil {
					return err
				}
			}
		}
	}
	if schema := object(doc["items"]); schema != nil {
		for _, child := range array(value) {
			if err := validateRefinements(schema, child); err != nil {
				return err
			}
		}
	}
	for _, key := range []string{"anyOf", "oneOf"} {
		choices := array(doc[key])
		if len(choices) > 0 {
			for _, raw := range choices {
				schema := object(raw)
				kind := text(schema["type"])
				matches := kind == ""
				switch value.(type) {
				case string:
					matches = matches || kind == "string"
				case map[string]any:
					matches = matches || kind == "object"
				case []any:
					matches = matches || kind == "array"
				case nil:
					matches = matches || kind == "null"
				default:
					matches = true
				}
				if matches {
					if err := validateRefinements(schema, value); err != nil {
						return err
					}
				}
			}
		}
	}
	return nil
}
func validateResourceContract(name string, value any) error {
	switch name {
	case "repositoryCloneURL":
		u, err := parseHTTPURL(text(value))
		if err != nil || u.Scheme() != "https" || u.Host() != "github.com" || u.Username() != "" || u.Password() != "" || u.Search() != "" || u.Hash() != "" {
			return bad("Invalid request")
		}
	case "mcpScope":
		if !validMCPScope(text(value)) {
			return bad("Invalid request")
		}
	case "envManifest":
		if number(field(value, "revision")) < 1 || number(field(value, "accessRevision")) < 1 {
			return bad("Invalid request")
		}
	case "envHeader", "envVersion":
		return validateResourceContract("envManifest", field(value, "manifest"))
	case "envMutation":
		return validateResourceContract("envManifest", field(field(value, "version"), "manifest"))
	case "memoryMetadata":
		if !safePath(text(field(value, "scope")), true) {
			return bad("Invalid request")
		}
	case "relativePath":
		if !safePath(text(value), false) {
			return bad("Invalid request")
		}
	case "change":
		return validateResource(object(field(value, "resource")))
	case "resourceInput":
		return validateResource(object(value))
	case "addProjectSources":
		ids := []string{}
		for _, s := range array(field(value, "sources")) {
			ids = append(ids, text(field(s, "id")))
		}
		if len(unique(ids)) != len(ids) {
			return bad("Invalid request")
		}
	}
	return nil
}
func safePath(path string, scope bool) bool {
	if scope && path == "" {
		return true
	}
	if path == "" || strings.HasPrefix(path, "/") || strings.Contains(path, "\\") {
		return false
	}
	for _, r := range path {
		if r < 32 || r == 127 || (scope && r >= 127 && r <= 159) {
			return false
		}
	}
	for _, part := range strings.Split(path, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}
func isEnvPath(path string) bool {
	for _, part := range strings.FieldsFunc(path, func(r rune) bool { return r == '/' || r == '\\' }) {
		part = strings.ToLower(part)
		if part == ".env" || strings.HasPrefix(part, ".env.") || strings.HasSuffix(part, ".env") {
			return true
		}
	}
	return false
}

var knowledgePath = regexp.MustCompile(`^knowledge/[0-9a-f-]{36}\.md$`)

func validateResource(r Object) error {
	fail := func() error { return bad("Invalid request") }
	path, kind, source := text(r["logicalPath"]), text(r["kind"]), text(r["source"])
	if !safePath(path, false) {
		return fail()
	}
	files := array(r["files"])
	seen := map[string]bool{}
	size := int64(0)
	skillFile, sessionFile := false, false
	for _, raw := range files {
		f := object(raw)
		p := text(f["path"])
		if !safePath(p, false) || seen[p] {
			return fail()
		}
		seen[p] = true
		size += number(f["size"])
		skillFile = skillFile || p == "SKILL.md"
		sessionFile = sessionFile || p == "session.jsonl"
		if kind == "skill" && (isEnvPath(p) || number(f["size"]) > 1000000) {
			return fail()
		}
	}
	deleted := flag(r["deleted"])
	if (!deleted && len(files) == 0) || (deleted && len(files) > 0) {
		return fail()
	}
	switch kind {
	case "skill":
		if (!deleted && (!skillFile || size > 4000000)) || strings.Contains(path, "/") || strings.HasPrefix(path, ".") || jsLength(path) > 128 {
			return fail()
		}
	case "memory":
		if !deleted && (len(files) != 1 || text(field(files[0], "path")) != "content.md") {
			return fail()
		}
		if size > 1000000 {
			return fail()
		}
		if source == "shared" && !knowledgePath.MatchString(path) {
			parts := strings.Split(path, "/")
			if !strings.HasPrefix(path, "instructions/") || !includes([]string{"AGENTS.md", "AGENTS.override.md", "CLAUDE.md"}, parts[len(parts)-1]) || includes(parts, ".git") || includes(parts, ".orka") {
				return fail()
			}
		}
		if source == "claude" && !strings.HasPrefix(path, "claude/") || source == "codex" && !strings.HasPrefix(path, "codex/") {
			return fail()
		}
		if strings.HasPrefix(path, "knowledge/") && (source != "shared" || r["memory"] == nil || path != "knowledge/"+text(r["resourceId"])+".md") {
			return fail()
		}
	case "plan":
		if source == "shared" || !strings.HasPrefix(path, source+"/") || !strings.HasSuffix(strings.ToLower(path), ".md") || size > 1000000 || (!deleted && (len(files) != 1 || text(field(files[0], "path")) != "content.md" || flag(field(files[0], "executable")))) {
			return fail()
		}
	case "session":
		if source == "shared" || (!deleted && !sessionFile) || size > 256*1024*1024 {
			return fail()
		}
	}
	if metadata := object(r["memory"]); metadata != nil {
		if kind != "memory" || !strings.HasPrefix(path, "knowledge/") || !safePath(text(metadata["scope"]), true) {
			return fail()
		}
	}
	return nil
}

// Field describes the small request shapes outside the shared v2 contracts.
type Field struct {
	Kind                     string
	Min, Max                 int
	Choices                  []string
	Optional, Nullable, Trim bool
	Item                     *Field
	Shape                    map[string]Field
	Contract                 string
}

func strField(min, max int) Field       { return Field{Kind: "string", Min: min, Max: max} }
func enumField(choices ...string) Field { return Field{Kind: "string", Choices: choices} }
func uuidField() Field                  { return Field{Kind: "contract", Contract: "uuid"} }
func intField(min int) Field            { return Field{Kind: "integer", Min: min, Max: 9007199254740991} }
func boolField() Field                  { return Field{Kind: "boolean"} }
func optional(f Field) Field            { f.Optional = true; return f }
func nullable(f Field) Field            { f.Nullable = true; return f }
func trimmed(f Field) Field             { f.Trim = true; return f }
func listField(item Field, min, max int) Field {
	return Field{Kind: "array", Item: &item, Min: min, Max: max}
}
func contractField(name string) Field { return Field{Kind: "contract", Contract: name} }
func parseObject(raw any, shape map[string]Field) (Object, error) {
	v, err := parseField(raw, Field{Kind: "object", Shape: shape})
	return object(v), err
}
func parseField(raw any, f Field) (any, error) {
	if raw == nil && f.Nullable {
		return nil, nil
	}
	fail := func() (any, error) { return nil, bad("Invalid request") }
	switch f.Kind {
	case "any":
		return raw, nil
	case "contract":
		return ValidateContract(f.Contract, raw)
	case "object":
		m := object(raw)
		if m == nil {
			return fail()
		}
		result := Object{}
		for k, v := range m {
			field, ok := f.Shape[k]
			if !ok {
				return fail()
			}
			parsed, err := parseField(v, field)
			if err != nil {
				return nil, err
			}
			result[k] = parsed
		}
		for key, field := range f.Shape {
			if _, exists := m[key]; !exists && !field.Optional {
				return fail()
			}
		}
		return result, nil
	case "string":
		s, ok := raw.(string)
		if !ok {
			return fail()
		}
		if f.Trim {
			s = trim(s)
		}
		if utf8.RuneCountInString(s) < f.Min || (f.Max > 0 && utf8.RuneCountInString(s) > f.Max) || len(f.Choices) > 0 && !includes(f.Choices, s) {
			return fail()
		}
		return s, nil
	case "boolean":
		if _, ok := raw.(bool); !ok {
			return fail()
		}
		return raw, nil
	case "integer":
		n, ok := raw.(json.Number)
		if !ok {
			switch x := raw.(type) {
			case float64:
				n = json.Number(fmt.Sprint(x))
			case int:
				n = json.Number(fmt.Sprint(x))
			case int64:
				n = json.Number(fmt.Sprint(x))
			default:
				return fail()
			}
		}
		v, err := n.Float64()
		if err != nil || math.Trunc(v) != v || v < float64(f.Min) || (f.Max > 0 && v > float64(f.Max)) {
			return fail()
		}
		return int64(v), nil
	case "array":
		a, ok := raw.([]any)
		if !ok || len(a) < f.Min || (f.Max > 0 && len(a) > f.Max) {
			return fail()
		}
		result := make([]any, len(a))
		for i, v := range a {
			p, err := parseField(v, *f.Item)
			if err != nil {
				return nil, err
			}
			result[i] = p
		}
		return result, nil
	}
	return fail()
}
func versionedShape(extra map[string]Field) map[string]Field {
	shape := map[string]Field{"projectId": uuidField(), "expectedPolicyRevision": intField(0)}
	for k, v := range extra {
		shape[k] = v
	}
	return shape
}
func controlCharacter(s string) bool {
	for _, r := range s {
		if unicode.IsControl(r) {
			return true
		}
	}
	return false
}

func (q *Queries) Parse(raw any, shape map[string]Field) Object {
	if q.err != nil {
		return nil
	}
	v, err := parseObject(raw, shape)
	q.Check(err)
	return v
}
func scopeShape(extra map[string]Field) map[string]Field {
	shape := map[string]Field{"projectId": uuidField()}
	for k, v := range extra {
		shape[k] = v
	}
	return shape
}
