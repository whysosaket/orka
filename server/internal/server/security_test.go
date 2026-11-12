package server

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"net/url"
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
		{"wrong answer id", func(v Object) { v["answers"] = Object{"wrong_id": field(v["answers"], "conflict_0")} }, "jev_invalid_answers"},
		{"confidence out of bounds", func(v Object) { object(field(v["answers"], "conflict_0"))["confidence"] = 2 }, "jev_invalid_response"},
		{"probabilities do not sum to one", func(v Object) {
			object(field(v["answers"], "conflict_0"))["probabilities"] = Object{"keep_current": 0.9, "accept_incoming": 0.9, "keep_both": 0.9}
		}, "jev_invalid_probabilities"},
		{"choice disagrees with probabilities", func(v Object) { object(field(v["answers"], "conflict_0"))["choice"] = "keep_current" }, "jev_invalid_probabilities"},
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

func TestDesktopEmailConfirmationKeepsVerificationAndHandoffSeparate(t *testing.T) {
	const origin = "https://orka.example"
	const code = "12345678-1234-4123-8123-123456789abc"
	const redirect = "orka://auth/callback?profile=qa"
	verifications := 0
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		verifications++
		if r.Method != http.MethodGet || r.URL.Path != "/verify" || r.URL.Query().Get("redirect_to") != redirect {
			t.Errorf("unexpected verifier request: %s %s", r.Method, r.URL)
		}
		if verifications == 1 {
			w.Header().Set("Location", redirect+"&code="+code)
		} else {
			w.Header().Set("Location", redirect+"#error=access_denied")
		}
		w.WriteHeader(http.StatusSeeOther)
	}))
	defer auth.Close()
	api := NewAPI(nil, AuthSettings{MagicLink: true, PublicURL: origin}, auth.URL)
	params := url.Values{"token": {"fixture-token"}, "type": {"magiclink"}, "redirect_to": {redirect}}
	form := func(method, requestOrigin string) *httptest.ResponseRecorder {
		path := "/auth/confirm"
		var body string
		if method == "GET" {
			path += "?" + params.Encode()
		} else {
			body = params.Encode()
		}
		req := httptest.NewRequest(method, origin+path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.Header.Set("Origin", requestOrigin)
		res := httptest.NewRecorder()
		api.ServeHTTP(res, req)
		return res
	}
	for range 2 {
		res := form("GET", "")
		if res.Code != 200 || !strings.Contains(res.Body.String(), "Continue to Orka") || res.Header().Get("Cache-Control") != "no-store" || res.Header().Get("Referrer-Policy") != "strict-origin" {
			t.Fatalf("expected scanner-safe confirmation, got %d", res.Code)
		}
	}
	if res := form("POST", "https://other.example"); res.Code != 400 || verifications != 0 {
		t.Fatal("verification ran before a same-origin form submission")
	}
	res := form("POST", origin)
	if res.Code != 200 || !strings.Contains(res.Body.String(), "Open Orka") ||
		!strings.Contains(res.Body.String(), code) || strings.Contains(res.Body.String(), params.Get("token")) ||
		res.Header().Get("Location") != "" {
		t.Fatalf("expected a clean app handoff page, got %d", res.Code)
	}
	res = form("POST", origin)
	if res.Code != 410 || !strings.Contains(res.Body.String(), "request a new sign-in email") {
		t.Fatalf("expected recovery instructions after replay, got %d", res.Code)
	}
}
