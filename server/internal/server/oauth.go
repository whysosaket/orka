package server

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

var emailPattern = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)

const mcpScope = "orka.read"

var mcpScopes = []string{"orka.read", "orka.write", "orka.manage"}
var mcpPermissionDescriptions = map[string]string{
	"orka.read":   "Read accessible shared project resources, revision history, permissions and review requests.",
	"orka.write":  "Create shared memories, update plans and resolve session conflicts within your current access.",
	"orka.manage": "Change permissions and approve or reject requests within your current authority.",
}

func normalizedScopes(scope string) string {
	if scope == "" {
		return mcpScope
	}
	out := []string{}
	for _, known := range mcpScopes {
		if includes(strings.Fields(scope), known) {
			out = append(out, known)
		}
	}
	return strings.Join(out, " ")
}
func scopeSubset(requested, granted string) bool {
	for _, value := range strings.Fields(requested) {
		if !includes(strings.Fields(granted), value) {
			return false
		}
	}
	return true
}

type OAuthError struct{ Code, Message string }

func (e *OAuthError) Error() string         { return e.Message }
func oauthError(code, message string) error { return &OAuthError{code, message} }
func tokenHash(s string) string             { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }
func oauthSecret() string                   { return base64.RawURLEncoding.EncodeToString(randomBytes(32)) }
func randomBytes(n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return b
}

type OAuth struct {
	Store           *Store
	Origin, AuthURL string
	Settings        AuthSettings
	Authenticate    func(context.Context, string) (string, error)
}

func (o *OAuth) resource() string { return o.Origin + "/mcp" }
func (o *OAuth) checkResource(value string) error {
	if value != o.resource() {
		return oauthError("invalid_request", "The resource parameter must identify this Orka MCP server")
	}
	return nil
}
func (o *OAuth) scopes(scope string) error {
	for _, value := range strings.Fields(scope) {
		if !includes(mcpScopes, value) {
			return oauthError("invalid_scope", "Unsupported Orka scope")
		}
	}
	if scope != "" && len(strings.Fields(scope)) == 0 {
		return oauthError("invalid_scope", "Choose an Orka scope")
	}
	return nil
}
func (o *OAuth) register(q *Queries, input Object) Object {
	redirects := stringsOf(input["redirect_uris"])
	valid := len(redirects) > 0 && len(redirects) <= 10
	for _, raw := range redirects {
		u, err := url.Parse(raw)
		if err != nil || u.Host == "" || u.User != nil || u.Fragment != "" || strings.ContainsAny(u.Scheme+"://"+u.Host, " \t\n\r;'\"<>") || u.Scheme != "https" && !(u.Scheme == "http" && includes([]string{"localhost", "127.0.0.1", "::1"}, u.Hostname())) {
			valid = false
		}
	}
	method := text(input["token_endpoint_auth_method"])
	if method == "" {
		method = "client_secret_post"
	}
	valid = valid && (method == "none" || method == "client_secret_post")
	if !valid {
		q.Check(oauthError("invalid_client_metadata", "Use HTTPS or a native loopback redirect and a supported token authentication method"))
		return nil
	}
	if err := o.scopes(text(input["scope"])); err != nil {
		q.Check(oauthError("invalid_client_metadata", "Unsupported Orka scope"))
		return nil
	}
	registered := clone(input)
	registered["client_id"] = newID()
	registered["client_id_issued_at"] = time.Now().Unix()
	registered["scope"] = normalizedScopes(text(input["scope"]))
	// The HTTP registration handler supplies secrets; direct provider fixtures do not.
	q.Exec("insert into orka.mcp_clients values($1,$2)", registered["client_id"], registered)
	return registered
}
func (o *OAuth) client(q *Queries, id string) Object {
	return object(q.One("select metadata from orka.mcp_clients where id::text=$1", id)["metadata"])
}
func (o *OAuth) issue(q *Queries, client, user, family, scope string) Object {
	if family == "" {
		family = newID()
	}
	access, refresh := oauthSecret(), oauthSecret()
	q.Exec("insert into orka.mcp_tokens(access_hash,refresh_hash,family,client_id,user_id,resource,access_expires_at,refresh_expires_at,scopes) values($1,$2,$3,$4,$5,$6,now()+interval '1 hour',now()+interval '30 days',$7)", tokenHash(access), tokenHash(refresh), family, client, user, o.resource(), normalizedScopes(scope))
	return Object{"access_token": access, "token_type": "Bearer", "expires_in": 3600, "refresh_token": refresh, "scope": normalizedScopes(scope)}
}
func (o *OAuth) lockFamily(q *Queries, client, token string) string {
	row := q.One("select family from orka.mcp_tokens where client_id=$1 and (access_hash=$2 or refresh_hash=$2)", client, tokenHash(token))
	family := text(row["family"])
	if family != "" {
		q.One("select pg_advisory_xact_lock(hashtextextended($1,0))", "mcp-token-family:"+family)
	}
	return family
}
func (o *OAuth) refresh(ctx context.Context, client, raw, scope, resource string) (any, error) {
	if err := o.checkResource(resource); err != nil {
		return nil, err
	}
	if err := o.scopes(scope); err != nil {
		return nil, err
	}
	result, err := o.Store.transaction(ctx, func(q *Queries) any {
		if o.lockFamily(q, client, raw) == "" {
			return nil
		}
		row := q.One("select family,user_id,revoked,resource,scopes from orka.mcp_tokens where refresh_hash=$1 and client_id=$2 and refresh_expires_at>now() for update", tokenHash(raw), client)
		if row == nil || text(row["resource"]) != o.resource() {
			return nil
		}
		if flag(row["revoked"]) {
			q.Exec("update orka.mcp_tokens set revoked=true where family=$1", row["family"])
			return nil
		}
		granted := text(row["scopes"])
		if scope != "" {
			if !scopeSubset(scope, granted) {
				q.Check(oauthError("invalid_scope", "Refresh cannot add permissions; reconnect Orka"))
				return nil
			}
			granted = normalizedScopes(scope)
		}
		q.Exec("update orka.mcp_tokens set revoked=true where refresh_hash=$1", tokenHash(raw))
		return o.issue(q, client, text(row["user_id"]), text(row["family"]), granted)
	})
	if err == nil && result == nil {
		err = oauthError("invalid_grant", "Refresh token unavailable; connect Orka again")
	}
	return result, err
}
func (o *OAuth) verify(q *Queries, token string) Object {
	row := q.One("select client_id,user_id,resource,scopes,extract(epoch from access_expires_at)::bigint as expires from orka.mcp_tokens where access_hash=$1 and not revoked and access_expires_at>now()", tokenHash(token))
	if row == nil || text(row["resource"]) != o.resource() {
		q.Check(oauthError("invalid_token", "Orka connection expired or was revoked"))
		return nil
	}
	return Object{"token": token, "clientId": row["client_id"], "scopes": strings.Fields(text(row["scopes"])), "expiresAt": row["expires"], "resource": row["resource"], "extra": Object{"userId": row["user_id"]}}
}
func (o *OAuth) revoke(ctx context.Context, client, token string) (any, error) {
	return o.Store.transaction(ctx, func(q *Queries) any {
		if family := o.lockFamily(q, client, token); family != "" {
			q.Exec("update orka.mcp_tokens set revoked=true where family=$1", family)
		}
		return nil
	})
}
func (o *OAuth) exchange(ctx context.Context, client, raw, verifier, redirect, resource string, checkPKCE bool) (any, error) {
	if err := o.checkResource(resource); err != nil {
		return nil, err
	}
	return o.Store.transaction(ctx, func(q *Queries) any {
		code := object(q.One("select payload from orka.mcp_codes where hash=$1 and expires_at>now() for update", tokenHash(raw))["payload"])
		if code == nil || text(code["clientId"]) != client {
			q.Check(oauthError("invalid_grant", "Authorization code unavailable"))
			return nil
		}
		if checkPKCE {
			sum := sha256.Sum256([]byte(verifier))
			challenge := base64.RawURLEncoding.EncodeToString(sum[:])
			if subtle.ConstantTimeCompare([]byte(challenge), []byte(text(code["codeChallenge"]))) != 1 {
				q.Check(oauthError("invalid_grant", "code_verifier does not match the challenge"))
				return nil
			}
		}
		if text(code["redirectUri"]) != redirect || text(code["resource"]) != resource {
			q.Check(oauthError("invalid_grant", "Authorization code binding changed"))
			return nil
		}
		q.Exec("delete from orka.mcp_codes where hash=$1", tokenHash(raw))
		return o.issue(q, client, text(code["userId"]), "", normalizedScopes(text(code["scope"])))
	})
}
func cookieName(tx string) string { return "orka_mcp_" + tx[:min(16, len(tx))] }
func (o *OAuth) cookie(w http.ResponseWriter, tx, value string, expire bool) {
	age := 600
	if expire {
		age = 0
	}
	raw := fmt.Sprintf("%s=%s; HttpOnly; SameSite=Lax; Path=/mcp/connect; Max-Age=%d", cookieName(tx), value, age)
	if strings.HasPrefix(o.Origin, "https:") {
		raw += "; Secure"
	}
	w.Header().Add("Set-Cookie", raw)
}
func (o *OAuth) authorize(w http.ResponseWriter, r *http.Request) error {
	v := r.URL.Query()
	if err := o.checkResource(v.Get("resource")); err != nil {
		return err
	}
	if err := o.scopes(v.Get("scope")); err != nil {
		return err
	}
	if v.Get("response_type") != "code" || v.Get("code_challenge_method") != "S256" || !regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`).MatchString(v.Get("code_challenge")) {
		return oauthError("invalid_request", "A valid S256 PKCE challenge is required")
	}
	var client Object
	_, err := o.Store.read(r.Context(), func(q *Queries) any { client = o.client(q, v.Get("client_id")); return nil })
	if err != nil {
		return err
	}
	if client == nil {
		return oauthError("invalid_client", "Invalid client_id")
	}
	redirect := v.Get("redirect_uri")
	if redirect == "" && len(stringsOf(client["redirect_uris"])) == 1 {
		redirect = stringsOf(client["redirect_uris"])[0]
	}
	if !includes(stringsOf(client["redirect_uris"]), redirect) {
		return oauthError("invalid_request", "Invalid redirect_uri")
	}
	tx, cookie := oauthSecret(), oauthSecret()
	params := Object{"codeChallenge": v.Get("code_challenge"), "redirectUri": redirect, "resource": v.Get("resource"), "scope": normalizedScopes(v.Get("scope"))}
	if v.Has("state") {
		params["state"] = v.Get("state")
	}
	_, err = o.Store.transaction(r.Context(), func(q *Queries) any {
		q.Exec("delete from orka.mcp_pending where expires_at<now()")
		q.Exec("delete from orka.mcp_codes where expires_at<now()")
		q.Exec("delete from orka.mcp_tokens where refresh_expires_at<now()")
		q.Exec("insert into orka.mcp_pending values($1,$2,$3,now()+interval '10 minutes')", tokenHash(tx), tokenHash(cookie), Object{"client": Object{"client_id": client["client_id"], "client_name": client["client_name"], "redirect_uris": client["redirect_uris"]}, "params": params})
		return nil
	})
	if err != nil {
		return err
	}
	o.cookie(w, tx, cookie, false)
	o.page(w, r, tx, text(client["client_name"]), "", "", 200, redirect, strings.Fields(text(params["scope"])))
	return nil
}
func (o *OAuth) page(w http.ResponseWriter, r *http.Request, tx, client, notice, email string, status int, redirect string, scopes []string) {
	if client == "" {
		client = "Connected assistant"
	}
	descriptions := []string{}
	for _, scope := range scopes {
		descriptions = append(descriptions, mcpPermissionDescriptions[scope])
	}
	if fromDashboard(r) {
		w.WriteHeader(status)
		_, _ = w.Write(jsonBytes(Object{"transaction": tx, "client": client, "notice": notice, "email": email, "password": o.Settings.Password, "magicLink": o.Settings.MagicLink, "redirect": redirect, "scopes": scopes, "permissionDescriptions": descriptions}))
		return
	}
	formAction := "'self'"
	if u, err := url.Parse(redirect); err == nil && u.Host != "" {
		formAction += " " + u.Scheme + "://" + u.Host
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Referrer-Policy", "same-origin")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action "+formAction+"; base-uri 'none'; frame-ancestors 'none'")
	w.Header().Set("X-Robots-Tag", "noindex, nofollow, noarchive")
	password, emailCode := "", ""
	if o.Settings.Password {
		password = `<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password">`
	}
	if o.Settings.MagicLink {
		emailCode = `<label for="code">Email code</label><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6,10}"><button name="action" value="send-code" formnovalidate>Send email code</button>`
	}
	notification := ""
	if notice != "" {
		notification = `<p class="notice" role="status">` + escapeHTML(notice) + `</p>`
	}
	page := oauthTemplate
	for key, value := range map[string]string{"CLIENT": escapeHTML(client), "NOTICE": notification, "TRANSACTION": escapeHTML(tx), "EMAIL": escapeHTML(email), "EMAIL_CODE": emailCode, "PASSWORD": password, "ORIGIN": escapeHTML(o.Origin), "PERMISSIONS": escapeHTML(strings.Join(descriptions, " "))} {
		page = strings.ReplaceAll(page, "{{"+key+"}}", value)
	}
	w.WriteHeader(status)
	_, _ = io.WriteString(w, page)
}
func (o *OAuth) connect(w http.ResponseWriter, r *http.Request) error {
	origin := o.Origin
	if fromDashboard(r) {
		origin = o.Settings.DashboardURL
	}
	if r.Header.Get("Origin") != origin {
		return &HTTPError{Status: 403, Message: "Open the original connection page to continue"}
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8192)
	if err := r.ParseForm(); err != nil {
		return bad("Invalid connection request")
	}
	v := r.PostForm
	for k, values := range v {
		if !includes([]string{"transaction", "action", "email", "password", "code"}, k) || len(values) != 1 {
			return bad("Invalid connection request")
		}
	}
	tx, action, email := v.Get("transaction"), v.Get("action"), v.Get("email")
	if !regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`).MatchString(tx) || !includes([]string{"connect", "send-code", "cancel"}, action) || utf8.RuneCountInString(email) > 320 || utf8.RuneCountInString(v.Get("password")) > 1024 || utf8.RuneCountInString(v.Get("code")) > 10 {
		return bad("Invalid connection request")
	}
	var row Object
	_, err := o.Store.read(r.Context(), func(q *Queries) any {
		row = q.One("select cookie_hash,payload from orka.mcp_pending where hash=$1 and expires_at>now()", tokenHash(tx))
		return nil
	})
	if err != nil {
		return err
	}
	cookie, err := r.Cookie(cookieName(tx))
	if row == nil || err != nil || subtle.ConstantTimeCompare([]byte(tokenHash(cookie.Value)), []byte(text(row["cookie_hash"]))) != 1 {
		return &HTTPError{Status: 403, Message: "Connection expired. Start again from your assistant."}
	}
	pending := object(row["payload"])
	params, client := object(pending["params"]), object(pending["client"])
	redirect, err := url.Parse(text(params["redirectUri"]))
	if err != nil {
		return err
	}
	query := redirect.Query()
	if params["state"] != nil {
		query.Set("state", text(params["state"]))
	}
	query.Set("iss", o.Origin+"/")
	finish := func() {
		o.cookie(w, tx, "", true)
		redirect.RawQuery = query.Encode()
		http.Redirect(w, r, redirect.String(), 303)
	}
	if action == "cancel" {
		_, err = o.Store.read(r.Context(), func(q *Queries) any { q.Exec("delete from orka.mcp_pending where hash=$1", tokenHash(tx)); return nil })
		if err != nil {
			return err
		}
		query.Set("error", "access_denied")
		finish()
		return nil
	}
	if !emailPattern.MatchString(email) {
		return bad("Invalid connection request")
	}
	if o.AuthURL == "" {
		return &HTTPError{Status: 503, Message: "Orka sign-in is unavailable"}
	}
	password := v.Get("password") != ""
	if action == "send-code" && !o.Settings.MagicLink || action == "connect" && password && !o.Settings.Password || action == "connect" && !password && !o.Settings.MagicLink {
		return bad("This sign-in method is unavailable")
	}
	if action == "connect" && !password && !regexp.MustCompile(`^\d{6,10}$`).MatchString(v.Get("code")) {
		o.page(w, r, tx, text(client["client_name"]), "Enter your email code or password.", email, 400, redirect.String(), strings.Fields(normalizedScopes(text(params["scope"]))))
		return nil
	}
	path := "/verify"
	body := Object{"email": email, "token": v.Get("code"), "type": "email"}
	if action == "send-code" {
		path = "/otp?" + url.Values{"redirect_to": []string{o.Origin + "/mcp/connect"}}.Encode()
		body = Object{"email": email, "create_user": false}
	} else if password {
		path = "/token?grant_type=password"
		body = Object{"email": email, "password": v.Get("password")}
	}
	response, err := requestHTTP(r.Context(), http.MethodPost, strings.TrimSuffix(o.AuthURL, "/")+path, jsonBytes(body), http.Header{"Content-Type": []string{"application/json"}, "X-Orka-Client-Ip": []string{authClientIP(r, o.Settings)}}, 10*time.Second)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	ok := response.StatusCode >= 200 && response.StatusCode < 300
	if action == "send-code" {
		notice, status := "Could not send a code. Try again shortly.", 400
		if ok {
			notice, status = "Check your email and enter the sign-in code here.", 200
		}
		o.page(w, r, tx, text(client["client_name"]), notice, email, status, redirect.String(), strings.Fields(normalizedScopes(text(params["scope"]))))
		return nil
	}
	if !ok {
		o.page(w, r, tx, text(client["client_name"]), "Could not sign in. Check your credentials or request a fresh email code.", email, 400, redirect.String(), strings.Fields(normalizedScopes(text(params["scope"]))))
		return nil
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return err
	}
	session, err := decode(raw)
	if err != nil {
		return err
	}
	token := text(field(session, "access_token"))
	if token == "" {
		return &HTTPError{Status: 502, Message: "Orka sign-in did not return a session"}
	}
	user, err := o.Authenticate(r.Context(), token)
	if err != nil {
		return err
	}
	if !validUUID(user) {
		return bad("Invalid connection request")
	}
	code := oauthSecret()
	_, err = o.Store.transaction(r.Context(), func(q *Queries) any {
		consumed := q.One("delete from orka.mcp_pending where hash=$1 and expires_at>now() returning hash", tokenHash(tx))
		if !q.Require(consumed != nil, 409, "This connection was already completed") {
			return nil
		}
		q.Exec("insert into orka.mcp_codes values($1,$2,now()+interval '5 minutes')", tokenHash(code), Object{"clientId": client["client_id"], "redirectUri": params["redirectUri"], "codeChallenge": params["codeChallenge"], "userId": user, "resource": o.resource(), "scope": normalizedScopes(text(params["scope"]))})
		return nil
	})
	if err != nil {
		return err
	}
	query.Set("code", code)
	finish()
	return nil
}
