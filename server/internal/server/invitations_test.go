package server

import (
	"bytes"
	"context"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/mail"
	"strings"
	"testing"
)

func TestInvitationEmailValidation(t *testing.T) {
	value, err := normalizeInvitationEmail(" Person@Example.com ")
	if err != nil || value != "person@example.com" {
		t.Fatalf("normalization: %q %v", value, err)
	}
	for _, value := range []string{"", "invalid", "Name <person@example.com>", "person@example.com\r\nBcc: other@example.com", "a@b", strings.Repeat("a", 255) + "@example.com"} {
		if _, err := normalizeInvitationEmail(value); err == nil {
			t.Errorf("accepted invalid address %q", value)
		}
	}
}

func TestInvitationMailContent(t *testing.T) {
	link := "https://team.example/join/" + strings.Repeat("ab", 24)
	raw, from, err := invitationMessage("Orka <invite@example.com>", "person@example.com", `<Team & "project">`, link)
	if err != nil || from != "invite@example.com" {
		t.Fatalf("message: %s %v", from, err)
	}
	message, err := mail.ReadMessage(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	_, parameters, err := mime.ParseMediaType(message.Header.Get("Content-Type"))
	if err != nil {
		t.Fatal(err)
	}
	parts := multipart.NewReader(message.Body, parameters["boundary"])
	for i := 0; i < 2; i++ {
		part, err := parts.NextPart()
		if err != nil {
			t.Fatal(err)
		}
		raw, err := io.ReadAll(part)
		if err != nil {
			t.Fatal(err)
		}
		body := string(raw)
		if !strings.Contains(body, link) || !strings.Contains(body, "person@example.com") || !strings.Contains(body, "24 hours") {
			t.Errorf("incomplete invitation: %s", body)
		}
		if i == 1 && (!strings.Contains(body, "&lt;Team &amp; &quot;project&quot;&gt;") || strings.Contains(body, "<Team")) {
			t.Errorf("unescaped HTML: %s", body)
		}
	}
}

func TestInvitationResendAndFallback(t *testing.T) {
	api := &API{Settings: AuthSettings{PublicURL: "https://team.example", EmailProvider: "resend"}, Environment: map[string]string{}}
	if api.invitationEmailAvailable() {
		t.Fatal("unconfigured email was advertised")
	}
	fail := false
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer re_fixture" || r.Header.Get("Idempotency-Key") != "orka-invite-hash" {
			t.Error("missing provider authentication/idempotency")
		}
		raw, _ := io.ReadAll(r.Body)
		value, _ := decode(raw)
		if !strings.Contains(text(field(value, "html")), "&lt;Team&gt;") {
			t.Error("unescaped project")
		}
		if fail {
			w.WriteHeader(429)
		} else {
			w.WriteHeader(200)
		}
	}))
	defer provider.Close()
	api.Environment = map[string]string{"RESEND_API_KEY": "re_fixture", "RESEND_FROM": "invite@example.com", "RESEND_API_URL": provider.URL}
	if !api.invitationEmailAvailable() {
		t.Fatal("configured email unavailable")
	}
	if err := api.sendInvitation(context.Background(), "person@example.com", "<Team>", "https://team.example/join/token", "hash"); err != nil {
		t.Fatal(err)
	}
	fail = true
	if err := api.sendInvitation(context.Background(), "person@example.com", "<Team>", "https://team.example/join/token", "hash"); err == nil || !strings.Contains(err.Error(), "joining link") {
		t.Fatalf("missing delivery failure: %v", err)
	}
	api.Settings.PublicURL = ""
	if api.invitationEmailAvailable() {
		t.Fatal("email advertised without public origin")
	}
}
