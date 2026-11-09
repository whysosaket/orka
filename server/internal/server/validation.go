package server

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strings"
	"unicode"

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
		// Zod string limits count UTF-16 units. JSON Schema counts Unicode
		// points, so enforce these limits below using the protocol's semantics.
		compiled, _ := decode(jsonBytes(doc))
		removeStringBounds(compiled)
		if err := compiler.AddResource(loc, compiled); err != nil {
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

func normalize(doc Object, value any) any {
	if flag(doc["x-orka-trim"]) {
		value = trim(text(value))
	}
	if m := object(value); m != nil {
		for key, raw := range object(doc["properties"]) {
			schema := object(raw)
			v, present := m[key]
			if !present {
				if d, ok := schema["default"]; ok {
					data, _ := decode(jsonBytes(d))
					m[key] = data
				}
				continue
			}
			m[key] = normalize(schema, v)
		}
	}
	if a := array(value); a != nil {
		for i, v := range a {
			a[i] = normalize(object(doc["items"]), v)
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
	value = normalize(contractDocs[name], copy)
	if err := schema.Validate(value); err != nil {
		return nil, bad("Invalid request")
	}
	if !validStringBounds(contractDocs[name], value) {
		return nil, bad("Invalid request")
	}
	if err := validateResourceContract(name, value); err != nil {
		return nil, err
	}
	return value, nil
}
func removeStringBounds(value any) {
	if doc := object(value); doc != nil {
		delete(doc, "minLength")
		delete(doc, "maxLength")
		for _, child := range doc {
			removeStringBounds(child)
		}
	}
	for _, child := range array(value) {
		removeStringBounds(child)
	}
}
func validStringBounds(doc Object, value any) bool {
	if s, ok := value.(string); ok {
		n := int64(jsLength(s))
		if min, exists := doc["minLength"]; exists && n < number(min) {
			return false
		}
		if max, exists := doc["maxLength"]; exists && n > number(max) {
			return false
		}
	}
	if m := object(value); m != nil {
		for key, child := range m {
			if schema := object(field(doc["properties"], key)); schema != nil {
				if !validStringBounds(schema, child) {
					return false
				}
			} else if schema := object(doc["additionalProperties"]); schema != nil && !validStringBounds(schema, child) {
				return false
			}
		}
	}
	if schema := object(doc["items"]); schema != nil {
		for _, child := range array(value) {
			if !validStringBounds(schema, child) {
				return false
			}
		}
	}
	for _, key := range []string{"anyOf", "oneOf"} {
		choices := array(doc[key])
		if len(choices) > 0 {
			valid := false
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
				if matches && validStringBounds(schema, value) {
					valid = true
					break
				}
			}
			if !valid {
				return false
			}
		}
	}
	return true
}
func validateResourceContract(name string, value any) error {
	switch name {
	case "envManifest":
		if number(field(value, "revision")) < 1 || number(field(value, "accessRevision")) < 1 {
			return bad("Invalid request")
		}
	case "envHeader", "envVersion":
		return validateResourceContract("envManifest", field(value, "manifest"))
	case "envMutation":
		return validateResourceContract("envManifest", field(field(value, "version"), "manifest"))
	case "memoryMetadata":
		if !safePath(text(field(value, "scope")), true) || jsLength(text(field(value, "scope"))) > 512 || jsLength(text(field(value, "topic"))) > 160 {
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
	if !safePath(path, false) || jsLength(path) > 1024 || jsLength(text(r["title"])) > 256 {
		return fail()
	}
	files := array(r["files"])
	seen := map[string]bool{}
	size := int64(0)
	skillFile, sessionFile := false, false
	for _, raw := range files {
		f := object(raw)
		p := text(f["path"])
		if !safePath(p, false) || jsLength(p) > 1024 || seen[p] {
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
		if kind != "memory" || !strings.HasPrefix(path, "knowledge/") || !safePath(text(metadata["scope"]), true) || jsLength(text(metadata["scope"])) > 512 || jsLength(text(metadata["topic"])) > 160 {
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
		if jsLength(s) < f.Min || (f.Max > 0 && jsLength(s) > f.Max) || len(f.Choices) > 0 && !includes(f.Choices, s) {
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
