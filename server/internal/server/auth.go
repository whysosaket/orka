package server

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"html"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const desktopRedirect = "orka://auth/callback"

var profileRedirect = regexp.MustCompile(`^orka://auth/callback\?profile=[a-z][a-z0-9-]{0,47}$`)
var tokenPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,256}$`)

type AuthSettings struct {
	Mode                                                string
	Password, GitHub, MagicLink, TrustProxy, MCPEnabled bool
	EmailProvider, PublicURL                            string
}

func SettingsFromEnv(env map[string]string, managed bool) (AuthSettings, error) {
	get := func(key, def string) string {
		if v, ok := env[key]; ok {
			return v
		}
		return def
	}
	if managed {
		env = cloneStrings(env)
		env["DEPLOYMENT_MODE"] = "cloud"
		env["GITHUB_ENABLED"] = "true"
		env["MAGIC_LINK_ENABLED"] = "true"
		env["EMAIL_PROVIDER"] = "resend"
	}
	settings := AuthSettings{Mode: get("DEPLOYMENT_MODE", "self-hosted"), Password: get("PASSWORD_ENABLED", "") != "false", GitHub: get("GITHUB_ENABLED", "") == "true", MagicLink: get("MAGIC_LINK_ENABLED", "") == "true", TrustProxy: get("TRUST_PROXY", "") == "true", EmailProvider: get("EMAIL_PROVIDER", "smtp"), PublicURL: strings.TrimSuffix(get("PUBLIC_URL", ""), "/"), MCPEnabled: get("MCP_ENABLED", "") == "true"}
	if !includes([]string{"cloud", "self-hosted"}, settings.Mode) || !includes([]string{"smtp", "resend"}, settings.EmailProvider) {
		return settings, fmt.Errorf("invalid deployment or email provider")
	}
	if settings.PublicURL != "" {
		u, err := parseHTTPURL(settings.PublicURL)
		if err != nil || u.Username() != "" || u.Password() != "" || u.Search() != "" || u.Hash() != "" || u.Pathname() != "/" || u.Scheme() != "https" && !(u.Scheme() == "http" && includes([]string{"localhost", "127.0.0.1"}, u.Hostname())) {
			return settings, fmt.Errorf("PUBLIC_URL must be an HTTPS origin (localhost HTTP is allowed)")
		}
	}
	if (settings.GitHub || settings.MagicLink) && settings.PublicURL == "" {
		return settings, fmt.Errorf("PUBLIC_URL is required for browser sign-in")
	}
	if settings.EmailProvider == "resend" && (get("RESEND_API_KEY", "") == "" || get("RESEND_FROM", "") == "" || get("SEND_EMAIL_HOOK_SECRET", "") == "" || settings.PublicURL == "") {
		return settings, fmt.Errorf("Resend requires RESEND_API_KEY, RESEND_FROM, SEND_EMAIL_HOOK_SECRET and PUBLIC_URL")
	}
	return settings, nil
}
func cloneStrings(m map[string]string) map[string]string {
	out := map[string]string{}
	for k, v := range m {
		out[k] = v
	}
	return out
}
func processEnv() map[string]string {
	m := map[string]string{}
	for _, entry := range os.Environ() {
		k, v, _ := strings.Cut(entry, "=")
		m[k] = v
	}
	return m
}
func SafeDesktopRedirect(raw string) string {
	if profileRedirect.MatchString(raw) {
		return raw
	}
	return desktopRedirect
}
func authClientIP(req *http.Request, settings AuthSettings) string {
	if settings.TrustProxy {
		parts := strings.Split(req.Header.Get("X-Forwarded-For"), ",")
		candidate := trim(parts[len(parts)-1])
		if net.ParseIP(candidate) != nil {
			return candidate
		}
	}
	host, _, err := net.SplitHostPort(req.RemoteAddr)
	if err == nil {
		return host
	}
	if req.RemoteAddr != "" {
		return req.RemoteAddr
	}
	return "unknown"
}

var noRedirectClient = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

func requestHTTP(ctx context.Context, method, endpoint string, body []byte, headers http.Header, timeout time.Duration) (*http.Response, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	req, err := http.NewRequestWithContext(ctx, method, endpoint, bytes.NewReader(body))
	if err != nil {
		cancel()
		return nil, err
	}
	req.Header = headers
	response, err := noRedirectClient.Do(req)
	if err != nil {
		cancel()
		return nil, err
	}
	response.Body = &cancelBody{ReadCloser: response.Body, cancel: cancel}
	return response, nil
}

type cancelBody struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (b *cancelBody) Close() error { err := b.ReadCloser.Close(); b.cancel(); return err }
func (a *API) accountAuthenticate(ctx context.Context, token string) (string, error) {
	response, err := requestHTTP(ctx, http.MethodGet, strings.TrimSuffix(a.AuthURL, "/")+"/user", nil, http.Header{"Authorization": []string{"Bearer " + token}}, 10*time.Second)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", &HTTPError{Status: 401, Message: "Session expired"}
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 1000000))
	if err != nil {
		return "", err
	}
	raw, err := decode(data)
	if err != nil {
		return "", err
	}
	record := object(raw)
	id := text(record["id"])
	if !validUUID(id) {
		return "", bad("Invalid request")
	}
	metadata := object(record["user_metadata"])
	name := ""
	for _, key := range []string{"full_name", "name", "preferred_username", "user_name"} {
		value := trim(text(metadata[key]))
		if value != "" {
			name = value
			break
		}
	}
	if jsLength(name) > 160 {
		for jsLength(name) > 160 {
			runes := []rune(name)
			name = string(runes[:len(runes)-1])
		}
	}
	email := trim(text(record["email"]))
	if name == "" {
		name = email
	}
	if name == "" {
		name = "Member " + id[:8]
	}
	var address any
	if email != "" {
		address = email
	}
	_, err = a.Store.read(ctx, func(q *Queries) any {
		q.Exec("insert into orka.env_profiles(user_id,label,email) values($1,$2,$3) on conflict(user_id) do update set label=coalesce((select display_name from orka.profiles where user_id=excluded.user_id),excluded.label),email=excluded.email", id, name, address)
		return nil
	})
	return id, err
}
func (a *API) proxyAuth(w http.ResponseWriter, r *http.Request, target *url.URL, method string) error {
	path := strings.TrimPrefix(target.Path, "/auth")
	post := includes([]string{"/otp", "/verify", "/token", "/logout"}, path) && method == http.MethodPost
	get := includes([]string{"/authorize", "/callback", "/verify"}, path) && method == http.MethodGet
	if !post && !get {
		return &HTTPError{Status: 404, Message: "Not found"}
	}
	if includes([]string{"/otp", "/verify"}, path) && !a.Settings.MagicLink {
		return &HTTPError{Status: 404, Message: "Email sign-in is not enabled on this service"}
	}
	params := target.Query()
	if path == "/token" && params.Get("grant_type") == "password" && !a.Settings.Password {
		return &HTTPError{Status: 404, Message: "Password sign-in is not enabled on this service"}
	}
	if path == "/authorize" {
		if !a.Settings.GitHub {
			return &HTTPError{Status: 404, Message: "GitHub sign-in is not enabled on this service"}
		}
		if params.Get("provider") != "github" || params.Get("redirect_to") != SafeDesktopRedirect(params.Get("redirect_to")) || params.Get("code_challenge_method") != "s256" || !regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`).MatchString(params.Get("code_challenge")) {
			return bad("Invalid sign-in request")
		}
		for key := range params {
			if !includes([]string{"provider", "redirect_to", "code_challenge", "code_challenge_method"}, key) {
				params.Del(key)
			}
		}
	}
	if path == "/otp" || path == "/verify" && get {
		params.Set("redirect_to", SafeDesktopRedirect(params.Get("redirect_to")))
	}
	endpoint := strings.TrimSuffix(a.AuthURL, "/") + path
	if encoded := params.Encode(); encoded != "" {
		endpoint += "?" + encoded
	}
	headers := http.Header{"Content-Type": []string{"application/json"}, "X-Orka-Client-IP": []string{authClientIP(r, a.Settings)}}
	for _, key := range []string{"Authorization", "Cookie"} {
		if v := r.Header.Get(key); v != "" {
			headers.Set(key, v)
		}
	}
	var body []byte
	var err error
	if post {
		body, err = readBytes(w, r, 64000)
		if err != nil {
			return err
		}
	}
	response, err := requestHTTP(r.Context(), method, endpoint, body, headers, 15*time.Second)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		return err
	}
	if path == "/otp" {
		parsed, _ := decode(data)
		if response.StatusCode >= 200 && response.StatusCode < 300 || includes([]string{"user_not_found", "signup_disabled", "email_exists"}, text(field(parsed, "error_code"))) {
			_, err = w.Write([]byte("{}"))
			return err
		}
	}
	for _, key := range []string{"Location", "Content-Type", "Retry-After"} {
		if value := response.Header.Get(key); value != "" {
			w.Header().Set(key, value)
		}
	}
	for _, cookie := range response.Header.Values("Set-Cookie") {
		w.Header().Add("Set-Cookie", cookie)
	}
	w.WriteHeader(response.StatusCode)
	_, err = w.Write(data)
	return err
}
func (a *API) confirmEmail(w http.ResponseWriter, r *http.Request) error {
	if !a.Settings.MagicLink || !includes([]string{http.MethodGet, http.MethodPost}, r.Method) {
		return &HTTPError{Status: 404, Message: "Not found"}
	}
	params := r.URL.Query()
	if r.Method == http.MethodPost {
		if r.Header.Get("Origin") != a.Settings.PublicURL || strings.Split(r.Header.Get("Content-Type"), ";")[0] != "application/x-www-form-urlencoded" {
			return bad("Open the original link from your sign-in email")
		}
		body, err := readBytes(w, r, 4096)
		if err != nil {
			return err
		}
		params, err = url.ParseQuery(string(body))
		if err != nil {
			return bad("Invalid sign-in link")
		}
	}
	for _, key := range []string{"token", "type", "redirect_to"} {
		if len(params[key]) != 1 {
			return bad("Invalid sign-in link")
		}
	}
	if !tokenPattern.MatchString(params.Get("token")) || !includes([]string{"signup", "magiclink", "recovery", "invite"}, params.Get("type")) || utf8.RuneCountInString(params.Get("redirect_to")) > 256 {
		return bad("Invalid request")
	}
	redirect := SafeDesktopRedirect(params.Get("redirect_to"))
	if r.Method == http.MethodPost {
		target, _ := url.Parse(a.Settings.PublicURL + "/auth/verify")
		target.RawQuery = url.Values{"token": []string{params.Get("token")}, "type": []string{params.Get("type")}, "redirect_to": []string{redirect}}.Encode()
		return a.proxyAuth(w, r, target, http.MethodGet)
	}
	inputs := ""
	for _, key := range []string{"token", "type", "redirect_to"} {
		value := params.Get(key)
		if key == "redirect_to" {
			value = redirect
		}
		inputs += `<input type="hidden" name="` + key + `" value="` + html.EscapeString(value) + `">`
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
	_, err := w.Write(renderPage("confirm.html", map[string]string{"INPUTS": inputs}))
	return err
}
func (a *API) emailHook(ctx context.Context, payload []byte, headers http.Header) error {
	secret := strings.TrimPrefix(strings.TrimPrefix(a.Environment["SEND_EMAIL_HOOK_SECRET"], "v1,"), "whsec_")
	key, err := base64.StdEncoding.DecodeString(secret)
	timestamp, parseErr := strconv.ParseInt(headers.Get("Webhook-Timestamp"), 10, 64)
	now := time.Now().Unix()
	valid := err == nil && parseErr == nil && headers.Get("Webhook-Id") != "" && timestamp >= now-300 && timestamp <= now+300
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(headers.Get("Webhook-Id") + "." + headers.Get("Webhook-Timestamp") + "." + string(payload)))
	expected := mac.Sum(nil)
	matched := false
	for _, signed := range strings.Fields(headers.Get("Webhook-Signature")) {
		version, value, ok := strings.Cut(signed, ",")
		if !ok || version != "v1" {
			continue
		}
		signature, err := base64.StdEncoding.DecodeString(value)
		matched = matched || err == nil && hmac.Equal(expected, signature)
	}
	if !valid || !matched {
		return &HTTPError{Status: 401, Message: "Invalid email hook signature"}
	}
	raw, err := decode(payload)
	if err != nil {
		return bad("Invalid request")
	}
	record := object(raw)
	user, email := object(record["user"]), object(record["email_data"])
	address, token, tokenHash, kind, redirect := text(user["email"]), text(email["token"]), text(email["token_hash"]), text(email["email_action_type"]), text(email["redirect_to"])
	if !regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`).MatchString(address) || !regexp.MustCompile(`^\d{6,10}$`).MatchString(token) || !tokenPattern.MatchString(tokenHash) || !includes([]string{"signup", "magiclink", "recovery", "invite"}, kind) || email["redirect_to"] == nil {
		return bad("Invalid request")
	}
	plugin := redirect == a.Settings.PublicURL+"/mcp/connect"
	link := a.Settings.PublicURL + "/auth/confirm?" + url.Values{"token": []string{tokenHash}, "type": []string{kind}, "redirect_to": []string{SafeDesktopRedirect(redirect)}}.Encode()
	end := "This code expires in 10 minutes and can be used once. If you did not request it, ignore this email."
	plain := "Open this link on the Mac where you requested it:\n" + link + "\n\nThis link expires in 10 minutes and can be used once. If you did not request it, ignore this email."
	content := `<p>Open this link on the Mac where you requested it:</p><p><a href="` + strings.ReplaceAll(link, "&", "&amp;") + `">Sign in to Orka</a></p><p>This link expires in 10 minutes and can be used once. If you did not request it, ignore this email.</p>`
	if plugin {
		plain = "Enter this code on the Orka connection page: " + token + "\n\n" + end
		content = "<p>Enter this code on the Orka connection page:</p><h1>" + token + "</h1><p>" + end + "</p>"
	}
	base := a.Environment["RESEND_API_URL"]
	if base == "" {
		base = "https://api.resend.com"
	}
	response, err := requestHTTP(ctx, http.MethodPost, strings.TrimSuffix(base, "/")+"/emails", jsonBytes(Object{"from": a.Environment["RESEND_FROM"], "to": address, "subject": "Sign in to Orka", "text": plain, "html": content}), http.Header{"Authorization": []string{"Bearer " + a.Environment["RESEND_API_KEY"]}, "Content-Type": []string{"application/json"}, "Idempotency-Key": []string{"orka-auth-" + bytesHash(payload)}}, 4*time.Second)
	if err != nil {
		return &HTTPError{Status: 503, Message: "Sign-in email could not be sent. Try again shortly."}
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return &HTTPError{Status: 503, Message: "Sign-in email could not be sent. Try again shortly."}
	}
	_, _ = io.Copy(io.Discard, response.Body)
	return nil
}
