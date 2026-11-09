package server

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestJevRejectsMalformedAndUncertainAnswers(t *testing.T) {
	good := func() Object {
		return Object{"model": jevModel, "usage": Object{"input_tokens": 1, "output_tokens": 1}, "answers": Object{"conflict_0": Object{"type": "choice", "choice": "accept_incoming", "confidence": 0.9, "probabilities": Object{"keep_current": 0.05, "accept_incoming": 0.9, "keep_both": 0.05}}}}
	}
	tests := []struct {
		name   string
		mutate func(Object)
		want   string
	}{
		{"valid", func(Object) {}, ""},
		{"missing confidence", func(v Object) { delete(object(field(v["answers"], "conflict_0")), "confidence") }, "jev_invalid_response"},
		{"string probability", func(v Object) {
			object(field(field(v["answers"], "conflict_0"), "probabilities"))["keep_current"] = "0.05"
		}, "jev_invalid_response"},
		{"fractional usage", func(v Object) { object(v["usage"])["input_tokens"] = 0.1 }, "jev_invalid_response"},
		{"negative usage", func(v Object) { object(v["usage"])["output_tokens"] = -1 }, "jev_invalid_response"},
		{"missing answer", func(v Object) { v["answers"] = Object{} }, "jev_invalid_answers"},
		{"uncertain", func(v Object) {
			object(field(v["answers"], "conflict_0"))["probabilities"] = Object{"keep_current": 0.3, "accept_incoming": 0.4, "keep_both": 0.3}
		}, "jev_uncertain"},
		{"wrong model", func(v Object) { v["model"] = "other" }, "jev_invalid_response"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			body := good()
			tt.mutate(body)
			transport := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer fixture" {
					t.Error("missing provider authentication")
				}
				_, _ = w.Write(jsonBytes(body))
			}))
			defer transport.Close()
			resolver := JevResolver{Enabled: true, APIKey: "fixture", URL: transport.URL}
			answers, err := resolver.Resolve(context.Background(), Object{"conflicts": []Object{{"base": "a", "current": "b", "incoming": "c"}}})
			if tt.want == "" {
				if err != nil || len(answers) != 1 {
					t.Fatalf("valid answer: %v", err)
				}
			} else if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("wanted %s, got %v", tt.want, err)
			}
		})
	}
}
func TestProfilePhotoContainerValidation(t *testing.T) {
	const prefix = "data:image/png;base64,"
	photo := "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII="
	if !validAvatarData(prefix + photo) {
		t.Fatal("valid bounded PNG rejected")
	}
	bytes, _ := base64.StdEncoding.DecodeString(photo)
	for i := range bytes {
		copy := append([]byte{}, bytes[:i]...)
		if validAvatarData(prefix + base64.StdEncoding.EncodeToString(copy)) {
			t.Fatalf("truncation accepted at %d", i)
		}
	}
	bytes[20] ^= 1
	if validAvatarData(prefix + base64.StdEncoding.EncodeToString(bytes)) {
		t.Fatal("corrupt PNG accepted")
	}
}
func TestReadableSessionsExcludePrivateRecords(t *testing.T) {
	records := []Object{{"type": "session_meta", "payload": Object{}}, {"type": "response_item", "payload": Object{"role": "user", "content": "<environment_context>private</environment_context>\n## My request:\nFix login"}}, {"type": "response_item", "payload": Object{"role": "assistant", "channel": "analysis", "content": "private reasoning"}}, {"type": "response_item", "payload": Object{"role": "assistant", "content": "Use PKCE"}}, {"type": "event_msg", "payload": Object{"type": "agent_message", "message": "Use PKCE"}}, {"type": "event_msg", "payload": Object{"type": "task_started"}}, {"type": "response_item", "payload": Object{"role": "assistant", "content": "Use PKCE"}}}
	got := SessionMessages(records)
	if Canonical(got) != `[{"role":"user","text":"Fix login"},{"role":"assistant","text":"Use PKCE"},{"role":"assistant","text":"Use PKCE"}]` {
		t.Fatalf("unexpected readable messages: %s", Canonical(got))
	}
}
func TestSettingsRejectUnsafeOriginsAndMissingSecrets(t *testing.T) {
	for _, origin := range []string{"http://example.com", "https://user:secret@example.com", "https://example.com/path", "https://example.com?redirect=evil"} {
		if _, err := SettingsFromEnv(map[string]string{"PUBLIC_URL": origin}, false); err == nil {
			t.Fatalf("accepted %s", origin)
		}
	}
	if _, err := SettingsFromEnv(map[string]string{}, true); err == nil {
		t.Fatal("managed settings accepted missing secrets")
	}
	settings, err := SettingsFromEnv(map[string]string{}, false)
	if err != nil || settings.Mode != "self-hosted" || !settings.Password {
		t.Fatal("default OSS settings changed")
	}
}
