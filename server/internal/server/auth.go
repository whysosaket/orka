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
	Mode                                                 string
	Password, GitHub, MagicLink, TrustProxy, MCPEnabled  bool
	EmailProvider, PublicURL, DashboardURL, dashboardKey string
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
	if settings.Mode == "self-hosted" {
		settings.Password, settings.GitHub, settings.MagicLink = true, false, false
		settings.EmailProvider = "smtp"
	}
	if settings.PublicURL != "" {
		u, err := parseHTTPURL(settings.PublicURL)
		if err != nil || u.Username() != "" || u.Password() != "" || u.Search() != "" || u.Hash() != "" || u.Pathname() != "/" || u.Scheme() != "https" && !(u.Scheme() == "http" && includes([]string{"localhost", "127.0.0.1"}, u.Hostname())) {
			return settings, fmt.Errorf("PUBLIC_URL must be an HTTPS origin (localhost HTTP is allowed)")
		}
	}
	settings.DashboardURL = strings.TrimSuffix(get("DASHBOARD_URL", ""), "/")
	settings.dashboardKey = get("DASHBOARD_PROXY_SECRET", "")
	if settings.DashboardURL != "" {
		if settings.Mode != "cloud" {
			return settings, fmt.Errorf("DASHBOARD_URL is only supported on managed Orka Cloud")
		}
		u, err := parseHTTPURL(settings.DashboardURL)
		serviceOrigin, _ := canonicalOrigin(settings.PublicURL)
		if serviceOrigin == "" || err != nil || u.Scheme()+"://"+u.Host() != settings.DashboardURL || settings.DashboardURL == serviceOrigin || len(settings.dashboardKey) < 32 ||
			u.Scheme() != "https" && !(u.Scheme() == "http" && includes([]string{"localhost", "127.0.0.1"}, u.Hostname())) {
			return settings, fmt.Errorf("DASHBOARD_URL requires a separate HTTPS origin (localhost HTTP is allowed), PUBLIC_URL, and DASHBOARD_PROXY_SECRET of at least 32 characters")
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

var webFlow = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

func (settings AuthSettings) browserURL() string {
	if settings.DashboardURL != "" {
		return settings.DashboardURL
	}
	return settings.PublicURL
}

func (settings AuthSettings) signInRedirect(raw string, allowWeb bool) string {
	if allowWeb && settings.DashboardURL != "" {
		if flow, ok := strings.CutPrefix(raw, settings.DashboardURL+"/auth/session?flow="); ok && webFlow.MatchString(flow) {
			return raw
		}
	}
	return SafeDesktopRedirect(raw)
}

func authClientIP(req *http.Request, settings AuthSettings) string {
	if fromDashboard(req) {
		if ip := net.ParseIP(req.Header.Get("X-Orka-Dashboard-Client-IP")); ip != nil {
			return ip.String()
		}
	}
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
	if includes([]string{"/authorize", "/callback"}, path) && !a.Settings.GitHub {
		return &HTTPError{Status: 404, Message: "GitHub sign-in is not enabled on this service"}
	}
	params := target.Query()
	if path == "/token" && a.Settings.Mode == "self-hosted" {
		grants := params["grant_type"]
		if len(grants) != 1 || !includes([]string{"password", "refresh_token"}, grants[0]) {
			return &HTTPError{Status: 404, Message: "Only password sign-in and session refresh are enabled on this service"}
		}
	}
	trustedDashboard := fromDashboard(r)
	redirect := a.Settings.signInRedirect(params.Get("redirect_to"), trustedDashboard)
	if path == "/token" && params.Get("grant_type") == "password" && !a.Settings.Password {
		return &HTTPError{Status: 404, Message: "Password sign-in is not enabled on this service"}
	}
	if path == "/authorize" {
		if params.Get("provider") != "github" || len(params["redirect_to"]) != 1 || params.Get("redirect_to") != redirect || params.Get("code_challenge_method") != "s256" || !regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`).MatchString(params.Get("code_challenge")) {
			return bad("Invalid sign-in request")
		}
		for key := range params {
			if !includes([]string{"provider", "redirect_to", "code_challenge", "code_challenge_method"}, key) {
				params.Del(key)
			}
		}
		if a.Settings.DashboardURL != "" && !trustedDashboard {
			http.Redirect(w, r, a.Settings.DashboardURL+"/auth/authorize?"+params.Encode(), http.StatusTemporaryRedirect)
			return nil
		}
	}
	if path == "/otp" || path == "/verify" && get {
		params.Set("redirect_to", redirect)
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
func signInPage(w http.ResponseWriter, status int, title, message, action, hint string) error {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	// Keep the same-origin form's Origin header without revealing its token URL.
	w.Header().Set("Referrer-Policy", "strict-origin")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
	w.Header().Set("X-Robots-Tag", "noindex, nofollow, noarchive")
	w.WriteHeader(status)
	_, err := w.Write(renderPage("confirm.html", map[string]string{"TITLE": title, "MESSAGE": message, "ACTION": action, "HINT": hint}))
	return err
}

func (a *API) confirmEmail(w http.ResponseWriter, r *http.Request) error {
	if !a.Settings.MagicLink || !includes([]string{http.MethodGet, http.MethodPost}, r.Method) {
		return &HTTPError{Status: 404, Message: "Not found"}
	}
	invalid := func() error {
		return signInPage(w, 400, "This sign-in link is invalid", "Return to Orka and request a new sign-in email.", "", "")
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
			return invalid()
		}
	}
	for _, key := range []string{"token", "type", "redirect_to"} {
		if len(params[key]) != 1 {
			return invalid()
		}
	}
	if !tokenPattern.MatchString(params.Get("token")) || !includes([]string{"signup", "magiclink", "recovery", "invite"}, params.Get("type")) || utf8.RuneCountInString(params.Get("redirect_to")) > 256 {
		return invalid()
	}
	redirect := SafeDesktopRedirect(params.Get("redirect_to"))
	verified := url.Values{"token": {params.Get("token")}, "type": {params.Get("type")}, "redirect_to": {redirect}}
	if r.Method == http.MethodGet {
		inputs := ""
		for _, key := range []string{"token", "type", "redirect_to"} {
			inputs += `<input type="hidden" name="` + key + `" value="` + html.EscapeString(verified.Get(key)) + `">`
		}
		form := `<form method="post" action="/auth/confirm">` + inputs + `<button type="submit">Continue to Orka</button></form>`
		return signInPage(w, 200, "Confirm your sign-in", "Continue on the Mac where you requested this email.", form, "If you have a code in your email, you can enter it in Orka instead.")
	}

	response, err := requestHTTP(r.Context(), http.MethodGet, strings.TrimSuffix(a.AuthURL, "/")+"/verify?"+verified.Encode(), nil,
		http.Header{"X-Orka-Client-IP": {authClientIP(r, a.Settings)}}, 15*time.Second)
	if err != nil {
		return signInPage(w, 503, "Sign-in is temporarily unavailable", "Try again shortly from Orka.", "", "")
	}
	defer response.Body.Close()
	if response.StatusCode == 429 || response.StatusCode >= 500 {
		if retry := response.Header.Get("Retry-After"); retry != "" {
			w.Header().Set("Retry-After", retry)
		}
		return signInPage(w, response.StatusCode, "Sign-in is temporarily unavailable", "Try again shortly from Orka.", "", "")
	}
	if response.StatusCode >= 300 && response.StatusCode < 400 {
		if callback, ok := desktopSignInCallback(response.Header.Get("Location"), redirect); ok {
			action := `<a class="button" rel="noreferrer" href="` + html.EscapeString(callback) + `">Open Orka</a>`
			return signInPage(w, 200, "Return to Orka", "Open Orka to finish signing in on the Mac where you started.", action,
				"If Orka doesn’t open, try Open Orka again. You can also return to the app and request a fresh email to use a code.")
		}
	}
	return signInPage(w, 410, "This sign-in link has expired or was used", "Return to Orka and request a new sign-in email.", "", "")
}

func desktopSignInCallback(location, redirect string) (string, bool) {
	callback, err := url.Parse(location)
	if err != nil || callback.Scheme != "orka" || callback.Host != "auth" || callback.Path != "/callback" || callback.Fragment != "" || callback.User != nil {
		return "", false
	}
	query, err := url.ParseQuery(callback.RawQuery)
	code := query.Get("code")
	if err != nil || !validUUID(code) || len(query["code"]) != 1 {
		return "", false
	}
	query.Del("code")
	callback.RawQuery = query.Encode()
	if callback.String() != redirect {
		return "", false
	}
	query.Set("code", code)
	callback.RawQuery = query.Encode()
	return callback.String(), true
}

const desktopEmailExpiry = "The link and code expire in 10 minutes. Use either once. If you did not request this email, ignore it."

func desktopEmailHTML(link, code string) string {
	return `<p>Open this link on the Mac where you requested it:</p><p><a href="` + link + `">Sign in to Orka</a></p><p>Or enter this code in Orka:</p><h1>` + code + `</h1><p>` + desktopEmailExpiry + `</p>`
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
	target := a.Settings.signInRedirect(redirect, true)
	link := a.Settings.browserURL() + "/auth/confirm?" + url.Values{"token": []string{tokenHash}, "type": []string{kind}, "redirect_to": []string{target}}.Encode()
	end := "This code expires in 10 minutes and can be used once. If you did not request it, ignore this email."
	escapedLink := html.EscapeString(link)
	plain := "Open this link on the Mac where you requested it:\n" + link + "\n\nOr enter this code in Orka: " + token + "\n\n" + desktopEmailExpiry
	content := desktopEmailHTML(escapedLink, token)
	if target != SafeDesktopRedirect(target) {
		plain = "Open this link in the browser where you requested it:\n" + link + "\n\nThis link expires in 10 minutes and can be used once. If you did not request it, ignore this email."
		content = `<p>Open this link in the browser where you requested it:</p><p><a href="` + escapedLink + `">Sign in to Orka</a></p><p>This link expires in 10 minutes and can be used once. If you did not request it, ignore this email.</p>`
	}
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
