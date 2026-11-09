package server

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMCPOriginNormalization(t *testing.T) {
	for _, tt := range []struct{ input, origin, host string }{
		{"https://EXAMPLE.COM:443", "https://example.com", "example.com"},
		{"http://LOCALHOST:080", "http://localhost", "localhost"},
		{"https://BÜCHER.example:8443", "https://xn--bcher-kva.example:8443", "xn--bcher-kva.example:8443"},
		{"http://[0:0:0:0:0:0:0:1]:8080", "http://[::1]:8080", "[::1]:8080"},
		{"https://127.1:8080", "https://127.0.0.1:8080", "127.0.0.1:8080"},
		{"https://2130706433:8080", "https://127.0.0.1:8080", "127.0.0.1:8080"},
		{"https://0x7f000001:8080", "https://127.0.0.1:8080", "127.0.0.1:8080"},
		{"https://[::ffff:192.0.2.128]:8080", "https://[::ffff:c000:280]:8080", "[::ffff:c000:280]:8080"},
	} {
		t.Run(tt.input, func(t *testing.T) {
			m, err := NewMCP(&API{Settings: AuthSettings{PublicURL: tt.input, Password: true}})
			if err != nil {
				t.Fatal(err)
			}
			if m.OAuth.Origin != tt.origin || m.host != tt.host {
				t.Fatalf("origin %q, host %q", m.OAuth.Origin, m.host)
			}
		})
	}
}

func TestPublicURLAcceptsBrowserLoopbackForms(t *testing.T) {
	for _, input := range []string{"http://LOCALHOST:080", "http://127.1", "http://2130706433", "http://0x7f000001", "http://0177.0.0.1"} {
		if _, err := SettingsFromEnv(map[string]string{"PUBLIC_URL": input}, false); err != nil {
			t.Errorf("browser loopback rejected %q: %v", input, err)
		}
	}
}

func TestMCPTransportMatchesSDK(t *testing.T) {
	ping := `{"jsonrpc":"2.0","id":1,"method":"ping"}`
	notification := `{"jsonrpc":"2.0","method":"notifications/initialized"}`
	initialize := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-10-07","capabilities":{},"clientInfo":{"name":"fixture","version":"1"}}}`
	for _, tt := range []struct {
		name, body, contentType, version string
		status                           int
		want                             string
	}{
		{"batch", "[" + ping + "," + strings.Replace(ping, `"id":1`, `"id":2`, 1) + "]", "application/json", "", 200, `[{"id":1,"jsonrpc":"2.0","result":{}},{"id":2,"jsonrpc":"2.0","result":{}}]`},
		{"single response in batch", "[" + notification + "," + ping + "]", "application/json", "", 200, `{"id":1,"jsonrpc":"2.0","result":{}}`},
		{"notification", notification, "application/json", "", 202, ""},
		{"client response", `{"jsonrpc":"2.0","id":1,"result":{}}`, "application/json", "", 202, ""},
		{"empty batch", "[]", "application/json", "", 202, ""},
		{"initialization batch", "[" + initialize + "," + ping + "]", "application/json", "", 400, ""},
		{"oversized batch", "[" + strings.Repeat(ping+",", 100) + ping + "]", "application/json", "", 400, ""},
		{"unsupported version", ping, "application/json", "2099-01-01", 400, ""},
		{"strict envelope", `{"jsonrpc":"2.0","id":1,"method":"ping","unexpected":true}`, "application/json", "", 400, ""},
		{"fractional id", `{"jsonrpc":"2.0","id":1.5,"method":"ping"}`, "application/json", "", 400, ""},
		{"JSONP", ping, "application/jsonp", "", 415, ""},
		{"case insensitive media type", ping, "Application/JSON; charset=utf-8", "", 200, `{"id":1,"jsonrpc":"2.0","result":{}}`},
		{"oldest supported version", initialize, "application/json", "", 200, "2024-10-07"},
		{"invalid params", `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{}}`, "application/json", "", 200, "-32602"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			m, err := NewMCP(&API{Settings: AuthSettings{PublicURL: "https://EXAMPLE.COM:443", Password: true}})
			if err != nil {
				t.Fatal(err)
			}
			r := httptest.NewRequest("POST", "https://example.com/mcp", strings.NewReader(tt.body))
			r.Header.Set("Accept", "application/json, text/event-stream")
			r.Header.Set("Content-Type", tt.contentType)
			r.Header.Set("MCP-Protocol-Version", tt.version)
			w := httptest.NewRecorder()
			m.ServeHTTP(w, r)
			if w.Code != tt.status {
				t.Fatalf("status %d: %s", w.Code, w.Body.String())
			}
			if tt.want == "" {
				return
			}
			if strings.HasPrefix(tt.want, "{") || strings.HasPrefix(tt.want, "[") {
				value, err := decode(w.Body.Bytes())
				if err != nil || Canonical(value) != tt.want {
					t.Fatalf("unexpected response: %s (%v)", w.Body.String(), err)
				}
			} else if !strings.Contains(w.Body.String(), tt.want) {
				t.Fatalf("missing %q: %s", tt.want, w.Body.String())
			}
		})
	}
}

func TestPaginatedSessionOrdinalsAreSafeIntegers(t *testing.T) {
	for _, tt := range []struct {
		name, first, second string
		valid               bool
	}{
		{"valid", "0", "1", true}, {"fractional", "0.5", "1.5", false},
		{"strings", `"0"`, `"1"`, false}, {"boolean", "false", "true", false},
		{"null", "null", "1", false}, {"unsafe", "9007199254740992", "9007199254740993", false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			const project = "12345678-1234-4123-8123-123456789012"
			data := []byte(`{"type":"session_meta","ordinal":` + tt.first + `,"payload":{"id":"thread","history_mode":"paginated"}}` + "\n" + `{"type":"response_item","ordinal":` + tt.second + `,"payload":{"role":"user","content":"Hello"}}` + "\n")
			store := &Store{Blobs: &Blobs{Root: t.TempDir()}}
			hash, err := store.Blobs.Put(project, data)
			if err != nil {
				t.Fatal(err)
			}
			q := &Queries{}
			messages := store.readSession(q, Object{"kind": "session", "source": "codex", "projectId": project, "files": []Object{{"path": "session.jsonl", "hash": hash, "size": len(data)}}})
			if tt.valid {
				if q.Err() != nil || len(messages) != 1 {
					t.Fatalf("valid history: %v %v", messages, q.Err())
				}
			} else if e, ok := q.Err().(*HTTPError); !ok || e.Status != 422 {
				t.Fatalf("invalid history accepted: %v", q.Err())
			}
		})
	}
}
