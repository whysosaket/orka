package server

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf16"
)

// Object keeps optional wire fields distinct from explicitly null values.
type Object = map[string]any

type HTTPError struct {
	Status  int
	Message string
	Code    string
}

func (e *HTTPError) Error() string { return e.Message }
func bad(message string) error     { return &HTTPError{Status: 400, Message: message} }
func object(v any) Object {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return nil
}
func array(v any) []any {
	if a, ok := v.([]string); ok {
		r := make([]any, len(a))
		for i, s := range a {
			r[i] = s
		}
		return r
	}
	if a, ok := v.([]Object); ok {
		return values(a)
	}
	if a, ok := v.([]any); ok {
		return a
	}
	return nil
}
func text(v any) string { s, _ := v.(string); return s }
func flag(v any) bool   { b, _ := v.(bool); return b }
func number(v any) int64 {
	switch x := v.(type) {
	case json.Number:
		n, err := x.Int64()
		if err == nil {
			return n
		}
		f, _ := x.Float64()
		return int64(f)
	case int:
		return int64(x)
	case int64:
		return x
	case int32:
		return int64(x)
	case int16:
		return int64(x)
	case float64:
		return int64(x)
	}
	return 0
}
func field(v any, key string) any { return object(v)[key] }
func values(a []Object) []any {
	r := make([]any, len(a))
	for i, v := range a {
		r[i] = v
	}
	return r
}
func stringsOf(v any) []string {
	r := []string{}
	for _, x := range array(v) {
		r = append(r, text(x))
	}
	return r
}
func includes(a []string, s string) bool {
	for _, x := range a {
		if x == s {
			return true
		}
	}
	return false
}
func unique(a []string) []string {
	seen := map[string]bool{}
	r := []string{}
	for _, v := range a {
		if !seen[v] {
			seen[v] = true
			r = append(r, v)
		}
	}
	return r
}
func clone(m Object) Object {
	n := Object{}
	for k, v := range m {
		n[k] = v
	}
	return n
}
func merge(a, b Object) Object {
	c := clone(a)
	for k, v := range b {
		c[k] = v
	}
	return c
}
func choose(condition bool, a, b any) any {
	if condition {
		return a
	}
	return b
}
func stamp() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }
func trim(s string) string {
	return strings.TrimFunc(s, func(r rune) bool { return r != '\u0085' && (unicode.IsSpace(r) || r == '\ufeff') })
}
func jsLength(s string) int { return len(utf16.Encode([]rune(s))) }
func decode(data []byte) (any, error) {
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	var value any
	if err := d.Decode(&value); err != nil {
		return nil, bad("Invalid JSON")
	}
	if err := d.Decode(new(any)); !errors.Is(err, io.EOF) {
		return nil, bad("Invalid JSON")
	}
	return value, nil
}
func jsonBytes(v any) []byte {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	if e.Encode(v) != nil {
		return []byte("null")
	}
	return bytes.TrimSuffix(b.Bytes(), []byte("\n"))
}

// Canonical matches JavaScript's recursively sorted JSON for the signed v2 values.
func Canonical(v any) string {
	switch x := v.(type) {
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Slice(keys, func(i, j int) bool {
			return slices.Compare(utf16.Encode([]rune(keys[i])), utf16.Encode([]rune(keys[j]))) < 0
		})
		parts := make([]string, 0, len(keys))
		for _, k := range keys {
			parts = append(parts, Canonical(k)+":"+Canonical(x[k]))
		}
		return "{" + strings.Join(parts, ",") + "}"
	case []any:
		parts := make([]string, len(x))
		for i, v := range x {
			parts[i] = Canonical(v)
		}
		return "[" + strings.Join(parts, ",") + "]"
	case []string:
		a := make([]any, len(x))
		for i, v := range x {
			a[i] = v
		}
		return Canonical(a)
	case string:
		s := string(jsonBytes(x))
		s = strings.ReplaceAll(s, `\u2028`, "\u2028")
		s = strings.ReplaceAll(s, `\u2029`, "\u2029")
		return s
	case json.Number:
		f, err := strconv.ParseFloat(string(x), 64)
		if err != nil {
			return "null"
		}
		return Canonical(f)
	case float64:
		if x == 0 {
			return "0"
		}
		s := strconv.FormatFloat(x, 'f', -1, 64)
		if (x >= 1e21 || x <= -1e21) || (x > 0 && x < 1e-6) || (x < 0 && x > -1e-6) {
			s = strconv.FormatFloat(x, 'e', -1, 64)
			s = strings.ReplaceAll(s, "e-0", "e-")
			s = strings.ReplaceAll(s, "e+0", "e+")
		}
		return s
	default:
		return string(jsonBytes(v))
	}
}
func bytesHash(v []byte) string { h := sha256.Sum256(v); return hex.EncodeToString(h[:]) }
func Hash(v any) string         { return bytesHash([]byte(Canonical(v))) }
func randomToken(n int) (string, error) {
	v := make([]byte, n)
	if _, err := rand.Read(v); err != nil {
		return "", err
	}
	return hex.EncodeToString(v), nil
}
func newID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(fmt.Errorf("secure randomness: %w", err))
	}
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}
