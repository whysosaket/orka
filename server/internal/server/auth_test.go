package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func authRequest(api *API, method, path, body string, headers http.Header) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, "https://orka.example"+path, strings.NewReader(body))
	req.RemoteAddr = "127.0.0.1:12345"
	for key, values := range headers {
		req.Header[key] = values
	}
	res := httptest.NewRecorder()
	api.ServeHTTP(res, req)
	return res
}

func TestEditionSettings(t *testing.T) {
	env := map[string]string{}
	oss, err := SettingsFromEnv(env, false)
	if err != nil || oss.Mode != "self-hosted" || !oss.Password || oss.GitHub || oss.MagicLink {
		t.Fatalf("self-hosted defaults: %+v, %v", oss, err)
	}
	if _, err := SettingsFromEnv(nil, true); err == nil {
		t.Fatal("managed accepted missing provider configuration")
	}
	env = map[string]string{"PUBLIC_URL": "https://api.tryorka.ai", "RESEND_API_KEY": "fixture", "RESEND_FROM": "login@example.test", "SEND_EMAIL_HOOK_SECRET": "fixture", "PASSWORD_ENABLED": "false", "GITHUB_ENABLED": "false"}
	managed, err := SettingsFromEnv(env, true)
	if err != nil || managed.Mode != "cloud" || !managed.GitHub || !managed.MagicLink || managed.Password || managed.EmailProvider != "resend" {
		t.Fatalf("managed defaults: %+v, %v", managed, err)
	}
	for _, invalid := range []map[string]string{
		{"DEPLOYMENT_MODE": "other"}, {"EMAIL_PROVIDER": "other"},
		{"DEPLOYMENT_MODE": "cloud", "GITHUB_ENABLED": "true"},
		{"DEPLOYMENT_MODE": "cloud", "EMAIL_PROVIDER": "resend"},
	} {
		if _, err := SettingsFromEnv(invalid, false); err == nil {
			t.Fatalf("accepted invalid configuration: %v", invalid)
		}
	}
}

func TestEmailHookAuthenticatesPayloadAndDelivery(t *testing.T) {
	type delivery struct {
		body Object
		key  string
	}
	deliveries := make(chan delivery, 4)
	var fail atomic.Bool
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/emails" || r.Header.Get("Authorization") != "Bearer re_fixture" {
			t.Error("incorrect provider request")
		}
		bytes, _ := io.ReadAll(r.Body)
		raw, _ := decode(bytes)
		deliveries <- delivery{object(raw), r.Header.Get("Idempotency-Key")}
		if fail.Load() {
			w.WriteHeader(429)
		} else {
			_, _ = w.Write([]byte(`{"id":"fixture"}`))
		}
	}))
	defer provider.Close()
	key := []byte(strings.Repeat("s", 32))
	api := NewAPI(nil, AuthSettings{PublicURL: "https://orka.example", EmailProvider: "resend"}, "")
	api.Environment = map[string]string{"SEND_EMAIL_HOOK_SECRET": "v1,whsec_" + base64.StdEncoding.EncodeToString(key), "RESEND_API_KEY": "re_fixture", "RESEND_FROM": "login@example.test", "RESEND_API_URL": provider.URL}
	payload := func(redirect string) []byte {
		return jsonBytes(Object{"user": Object{"email": "person@example.test"}, "email_data": Object{"token": "123456", "token_hash": "abc123", "email_action_type": "magiclink", "redirect_to": redirect}})
	}
	signed := func(body []byte, timestamp time.Time) http.Header {
		stamp := fmt.Sprint(timestamp.Unix())
		mac := hmac.New(sha256.New, key)
		_, _ = mac.Write([]byte("delivery-1." + stamp + "." + string(body)))
		return http.Header{"Webhook-Id": {"delivery-1"}, "Webhook-Timestamp": {stamp}, "Webhook-Signature": {"v1," + base64.StdEncoding.EncodeToString(mac.Sum(nil))}}
	}
	body := payload("https://attacker.example")
	headers := signed(body, time.Now())
	for _, invalid := range []struct {
		body    []byte
		headers http.Header
	}{
		{body, nil}, {append(append([]byte{}, body...), ' '), headers}, {body, signed(body, time.Now().Add(-10*time.Minute))},
	} {
		if err := api.emailHook(context.Background(), invalid.body, invalid.headers); err == nil || !strings.Contains(err.Error(), "signature") {
			t.Fatalf("accepted invalid signature: %v", err)
		}
	}
	if len(deliveries) != 0 {
		t.Fatal("invalid hook reached provider")
	}
	for range 2 {
		if err := api.emailHook(context.Background(), body, headers); err != nil {
			t.Fatal(err)
		}
	}
	first, second := <-deliveries, <-deliveries
	if first.key == "" || first.key != second.key || first.body["to"] != "person@example.test" {
		t.Fatal("delivery identity changed")
	}
	for _, format := range []string{"text", "html"} {
		content := text(first.body[format])
		if !strings.Contains(content, "/auth/confirm") || !strings.Contains(content, "orka%3A%2F%2Fauth%2Fcallback") || strings.Contains(content, "attacker") {
			t.Fatalf("unsafe sign-in content: %s", content)
		}
	}
	plugin := payload("https://orka.example/mcp/connect")
	if err := api.emailHook(context.Background(), plugin, signed(plugin, time.Now())); err != nil {
		t.Fatal(err)
	}
	mail := <-deliveries
	for _, format := range []string{"text", "html"} {
		content := text(mail.body[format])
		if !strings.Contains(content, "123456") || !strings.Contains(content, "Orka connection page") || strings.Contains(content, "auth/confirm") {
			t.Fatal("MCP code content changed")
		}
	}
	fail.Store(true)
	if err := api.emailHook(context.Background(), body, headers); err == nil || !strings.Contains(err.Error(), "could not be sent") {
		t.Fatalf("delivery failure hidden: %v", err)
	}
}

func TestAuthProxyPreservesCallbacksAndRestrictsRoutes(t *testing.T) {
	type forwarded struct{ path, cookie, body string }
	requests := make(chan forwarded, 10)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		requests <- forwarded{r.URL.String(), r.Header.Get("Cookie"), string(body)}
		if r.URL.Path == "/authorize" {
			w.Header().Set("Location", "https://github.com/login/oauth/authorize?state=opaque")
			w.Header().Add("Set-Cookie", "auth-state=one; HttpOnly; Secure")
			w.Header().Add("Set-Cookie", "auth-proof=two; HttpOnly; Secure")
			w.WriteHeader(302)
		} else if r.URL.Path == "/callback" {
			w.Header().Set("Location", desktopRedirect+"?code=one-time")
			w.WriteHeader(302)
		} else {
			_, _ = w.Write([]byte(`{}`))
		}
	}))
	defer upstream.Close()
	api := NewAPI(nil, AuthSettings{Mode: "cloud", Password: true, GitHub: true, MagicLink: true, PublicURL: "https://orka.example"}, upstream.URL)
	api.Authenticate = func(context.Context, string) (string, error) {
		t.Error("public auth route authenticated")
		return "", nil
	}
	params := url.Values{"provider": {"github"}, "redirect_to": {desktopRedirect}, "code_challenge_method": {"s256"}, "code_challenge": {strings.Repeat("a", 43)}, "scopes": {"repo admin:org"}}
	for _, target := range []string{desktopRedirect, desktopRedirect + "?profile=alice"} {
		params.Set("redirect_to", target)
		res := authRequest(api, "GET", "/auth/authorize?"+params.Encode(), "", nil)
		seen := <-requests
		parsed, _ := url.Parse(seen.path)
		if res.Code != 302 || len(res.Header().Values("Set-Cookie")) != 2 || res.Header().Get("Referrer-Policy") != "no-referrer" || parsed.Query().Get("redirect_to") != target || parsed.Query().Has("scopes") {
			t.Fatalf("OAuth proxy changed: %d %s", res.Code, seen.path)
		}
	}
	callback := authRequest(api, "GET", "/auth/callback?code=github-code&state=opaque", "", http.Header{"Cookie": {"auth-state=one"}})
	if callback.Header().Get("Location") != desktopRedirect+"?code=one-time" || (<-requests).cookie != "auth-state=one" {
		t.Fatal("callback cookie/redirect lost")
	}
	params.Set("redirect_to", "https://attacker.example")
	if res := authRequest(api, "GET", "/auth/authorize?"+params.Encode(), "", nil); res.Code != 400 {
		t.Fatal("accepted foreign OAuth redirect")
	}
	for _, path := range []string{"/auth/admin/users", "/auth/signup", "/auth/user", "/auth/hooks/send-email"} {
		if res := authRequest(api, "POST", path, `{}`, nil); res.Code != 404 {
			t.Fatalf("exposed %s: %d", path, res.Code)
		}
	}
	authRequest(api, "POST", "/auth/token?grant_type=pkce", `{"auth_code":"code","code_verifier":"secret"}`, nil)
	if seen := <-requests; seen.path != "/token?grant_type=pkce" || !strings.Contains(seen.body, "secret") {
		t.Fatal("PKCE exchange changed")
	}
	for _, target := range []string{"https://attacker.example", desktopRedirect + "?profile=bob"} {
		authRequest(api, "POST", "/auth/otp?"+url.Values{"redirect_to": {target}}.Encode(), `{}`, nil)
		parsed, _ := url.Parse((<-requests).path)
		if parsed.Query().Get("redirect_to") != SafeDesktopRedirect(target) {
			t.Fatal("OTP redirect escaped allowlist")
		}
	}
}

func TestAuthProviderGatesEnumerationAndRateIdentity(t *testing.T) {
	var status atomic.Int32
	var code atomic.Value
	status.Store(200)
	code.Store("")
	requests := make(chan string, 20)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests <- r.Header.Get("X-Orka-Client-IP")
		w.Header().Set("Retry-After", "60")
		w.WriteHeader(int(status.Load()))
		_, _ = w.Write(jsonBytes(Object{"error_code": code.Load()}))
	}))
	defer upstream.Close()
	api := NewAPI(nil, AuthSettings{}, upstream.URL)
	for _, path := range []string{"/auth/otp", "/auth/verify", "/auth/token?grant_type=password", "/auth/confirm"} {
		if res := authRequest(api, "POST", path, `{}`, nil); res.Code != 404 {
			t.Fatalf("disabled route %s: %d", path, res.Code)
		}
	}
	if len(requests) != 0 {
		t.Fatal("disabled provider contacted upstream")
	}
	if res := authRequest(api, "POST", "/auth/token?grant_type=refresh_token", `{}`, nil); res.Code != 200 {
		t.Fatal("refresh blocked")
	}
	<-requests
	api.Settings.MagicLink = true
	for _, value := range []string{"", "user_not_found", "signup_disabled", "email_exists"} {
		code.Store(value)
		status.Store(200)
		if value != "" {
			status.Store(422)
		}
		res := authRequest(api, "POST", "/auth/otp", `{}`, nil)
		<-requests
		if res.Code != 200 || res.Body.String() != "{}" {
			t.Fatalf("account existence leaked: %d %s", res.Code, res.Body)
		}
	}
	for _, failure := range []int{429, 503} {
		status.Store(int32(failure))
		code.Store("delivery_failed")
		res := authRequest(api, "POST", "/auth/otp", `{}`, nil)
		<-requests
		if res.Code != failure || res.Header().Get("Retry-After") != "60" {
			t.Fatal("actionable provider failure hidden")
		}
	}
	status.Store(200)
	for _, trusted := range []bool{false, true} {
		api.Settings.TrustProxy = trusted
		authRequest(api, "POST", "/auth/token?grant_type=refresh_token", `{}`, http.Header{"X-Orka-Client-Ip": {"attacker"}, "X-Forwarded-For": {"198.51.100.1, 203.0.113.8"}})
		want := "127.0.0.1"
		if trusted {
			want = "203.0.113.8"
		}
		if got := <-requests; got != want {
			t.Fatalf("rate identity: %s != %s", got, want)
		}
	}
}

func TestEmailConfirmationRequiresAnIntentionalSameOriginPost(t *testing.T) {
	verified := make(chan string, 1)
	const redirect = "orka://auth/callback?profile=alice"
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		verified <- r.URL.String()
		w.Header().Set("Location", redirect+"&code=12345678-1234-4123-8123-123456789abc")
		w.WriteHeader(http.StatusSeeOther)
	}))
	defer upstream.Close()
	api := NewAPI(nil, AuthSettings{MagicLink: true, PublicURL: "https://orka.example"}, upstream.URL)
	params := url.Values{"token": {"single-use-token"}, "type": {"magiclink"}, "redirect_to": {redirect}}
	for range 2 {
		res := authRequest(api, "GET", "/auth/confirm?"+params.Encode(), "", nil)
		body := strings.ToLower(res.Body.String())
		if res.Code != 200 || strings.Contains(body, "<script") || strings.Contains(body, `http-equiv="refresh"`) || !strings.Contains(res.Header().Get("Content-Security-Policy"), "form-action 'self'") || res.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("unsafe confirmation preview: %d %s", res.Code, body)
		}
	}
	for _, key := range []string{"token", "type", "redirect_to"} {
		duplicate, _ := url.ParseQuery(params.Encode())
		duplicate.Add(key, params.Get(key))
		if res := authRequest(api, "GET", "/auth/confirm?"+duplicate.Encode(), "", nil); res.Code != 400 {
			t.Fatalf("duplicate %s accepted", key)
		}
	}
	headers := http.Header{"Content-Type": {"application/x-www-form-urlencoded"}, "Origin": {"https://attacker.example"}}
	if res := authRequest(api, "POST", "/auth/confirm", params.Encode(), headers); res.Code != 400 {
		t.Fatal("cross-origin confirmation accepted")
	}
	if len(verified) != 0 {
		t.Fatal("scanner or rejected request consumed the link")
	}
	headers.Set("Origin", api.Settings.PublicURL)
	res := authRequest(api, "POST", "/auth/confirm", params.Encode(), headers)
	if res.Code < 200 || res.Code >= 400 || len(verified) != 1 {
		t.Fatalf("intentional confirmation rejected: %d %s", res.Code, res.Body)
	}
	forwarded, _ := url.Parse(<-verified)
	if forwarded.Path != "/verify" || forwarded.Query().Get("redirect_to") != redirect {
		t.Fatalf("verification redirect changed: %s", forwarded)
	}
}
