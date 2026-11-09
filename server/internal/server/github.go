package server

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type GitHubSettings struct {
	Enabled                         bool
	ClientID, ClientSecret, AppSlug string
	EncryptionKey                   []byte
	WebhookSecret                   string
}

func GitHubSettingsFromEnv(env map[string]string) (GitHubSettings, error) {
	key, _ := hex.DecodeString(env["GITHUB_REPOS_TOKEN_KEY"])
	settings := GitHubSettings{Enabled: env["GITHUB_REPOS_ENABLED"] == "true", ClientID: envOr(env, "GITHUB_REPOS_CLIENT_ID", env["GITHUB_CLIENT_ID"]), ClientSecret: envOr(env, "GITHUB_REPOS_CLIENT_SECRET", env["GITHUB_CLIENT_SECRET"]), AppSlug: env["GITHUB_REPOS_APP_SLUG"], EncryptionKey: key, WebhookSecret: env["GITHUB_REPOS_WEBHOOK_SECRET"]}
	if settings.Enabled && (!regexp.MustCompile(`^Iv[A-Za-z0-9]+$`).MatchString(settings.ClientID) || settings.ClientSecret == "" || !regexp.MustCompile(`^[a-z0-9-]+$`).MatchString(settings.AppSlug) || !regexp.MustCompile(`(?i)^[a-f0-9]{64}$`).MatchString(env["GITHUB_REPOS_TOKEN_KEY"]) || jsLength(settings.WebhookSecret) < 32) {
		return settings, fmt.Errorf("GitHub repositories require GitHub App GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET (or migration overrides), GITHUB_REPOS_APP_SLUG, a 64-hex GITHUB_REPOS_TOKEN_KEY and GITHUB_REPOS_WEBHOOK_SECRET (at least 32 characters)")
	}
	return settings, nil
}

type GitHub struct {
	Store    *Store
	Settings GitHubSettings
	Client   *http.Client
}

var githubActive = []string{"requested", "waiting_on_github", "invitation_pending"}
var githubID = regexp.MustCompile(`^[1-9][0-9]{0,23}$`)

func (g *GitHub) installationURL() string {
	return "https://github.com/apps/" + g.Settings.AppSlug + "/installations/new"
}
func (g *GitHub) enabled(q *Queries) bool {
	return q.Require(g.Settings.Enabled, 404, "GitHub repositories are not enabled on this service")
}
func (g *GitHub) seal(q *Queries, value any, context string) string {
	block, err := aes.NewCipher(g.Settings.EncryptionKey)
	if !q.Check(err) {
		return ""
	}
	aead, err := cipher.NewGCM(block)
	if !q.Check(err) {
		return ""
	}
	iv := randomBytes(12)
	sealed := aead.Seal(nil, iv, jsonBytes(value), []byte(context))
	n := len(sealed) - aead.Overhead()
	bytes := append(append(iv, sealed[n:]...), sealed[:n]...)
	return base64.StdEncoding.EncodeToString(bytes)
}
func (g *GitHub) unseal(q *Queries, value, context string) any {
	fail := func() any {
		q.Require(false, 503, "GitHub credentials could not be opened; check the service token key")
		return nil
	}
	bytes, err := base64.StdEncoding.DecodeString(value)
	if err != nil || len(bytes) < 28 {
		return fail()
	}
	block, err := aes.NewCipher(g.Settings.EncryptionKey)
	if err != nil {
		return fail()
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return fail()
	}
	encrypted := append(append([]byte{}, bytes[28:]...), bytes[12:28]...)
	raw, err := aead.Open(nil, bytes[:12], encrypted, []byte(context))
	if err != nil {
		return fail()
	}
	result, err := decode(raw)
	if err != nil {
		return fail()
	}
	return result
}
func (g *GitHub) call(q *Queries, path, token string, body any, method string, basic bool) any {
	if q.err != nil {
		return nil
	}
	if method == "" {
		method = "GET"
		if body != nil {
			method = "POST"
		}
	}
	origin := "https://api.github.com"
	if strings.HasPrefix(path, "/login/") {
		origin = "https://github.com"
	}
	ctx, cancel := context.WithTimeout(q.ctx, 15*time.Second)
	defer cancel()
	var payload io.Reader
	if body != nil {
		payload = strings.NewReader(string(jsonBytes(body)))
	}
	req, err := http.NewRequestWithContext(ctx, method, origin+path, payload)
	if !q.Check(err) {
		return nil
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if token != "" {
		kind := "Bearer"
		if basic {
			kind = "Basic"
		}
		req.Header.Set("Authorization", kind+" "+token)
	}
	client := g.Client
	if client == nil {
		client = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	response, err := client.Do(req)
	if !q.Require(err == nil, 503, "GitHub is unavailable; try again shortly") {
		return nil
	}
	defer response.Body.Close()
	status := response.StatusCode
	if status < 200 || status >= 300 {
		message := "Repository access unavailable. Check GitHub membership, app selection and organization SSO."
		mapped := 403
		switch {
		case status >= 500:
			mapped = 503
			message = "GitHub is unavailable; try again shortly"
		case status == 401:
			mapped = 401
			message = "Reconnect GitHub to continue"
		case status == 429 || response.Header.Get("X-Ratelimit-Remaining") == "0":
			mapped = 429
			message = "GitHub rate limit reached; try again later"
		}
		q.Require(false, mapped, message)
		return nil
	}
	if status == 204 {
		return Object{}
	}
	bytes, err := io.ReadAll(io.LimitReader(response.Body, 8_000_001))
	if !q.Check(err) || !q.Require(len(bytes) <= 8_000_000, 502, "GitHub response exceeds size limit") {
		return nil
	}
	v, err := decode(bytes)
	q.Check(err)
	return v
}
func (g *GitHub) tx(q *Queries, fn func(*Queries) any) any {
	if q.err != nil {
		return nil
	}
	result, err := g.Store.transaction(q.ctx, fn)
	q.Check(err)
	return result
}
func githubCredentials(q *Queries, value any) Object {
	v := object(value)
	q.Require(text(v["access_token"]) != "" && text(v["refresh_token"]) != "" && safePositiveInteger(v["expires_in"]), 400, "Invalid GitHub credentials")
	return v
}
func (g *GitHub) token(q *Queries, user string) Object {
	return object(g.tx(q, func(db *Queries) any {
		db.One("select pg_advisory_xact_lock(hashtextextended($1,0))", "github:"+user)
		row := db.One("select * from orka.github_connections where user_id=$1 for update", user)
		if !db.Require(row != nil, 409, "Connect GitHub to continue") {
			return nil
		}
		value := githubCredentials(db, g.unseal(db, text(row["credentials"]), user))
		expires, _ := time.Parse(time.RFC3339Nano, text(row["expires_at"]))
		if expires.Before(time.Now().Add(time.Minute)) {
			result := g.call(db, "/login/oauth/access_token", "", Object{"client_id": g.Settings.ClientID, "client_secret": g.Settings.ClientSecret, "grant_type": "refresh_token", "refresh_token": value["refresh_token"]}, "", false)
			if db.err != nil {
				return nil
			}
			v := object(result)
			if !db.Require(text(v["access_token"]) != "" && text(v["refresh_token"]) != "" && safePositiveInteger(v["expires_in"]), 409, "GitHub authorization expired; connect GitHub again") {
				return nil
			}
			value = v
			db.Exec("update orka.github_connections set credentials=$2,expires_at=now()+$3*interval '1 second' where user_id=$1", user, g.seal(db, value, user), number(value["expires_in"]))
		}
		return Object{"accessToken": value["access_token"], "githubId": row["github_id"], "login": row["login"]}
	}))
}
func (g *GitHub) normalize(q *Queries, raw any) Object {
	v := object(raw)
	_, full := v["full_name"].(string)
	_, private := v["private"].(bool)
	branch, branchString := v["default_branch"].(string)
	if !q.Require(safePositiveInteger(v["id"]) && full && private && (v["default_branch"] == nil || branchString && jsLength(branch) <= 255), 400, "Invalid GitHub repository") {
		return nil
	}
	name := text(v["full_name"])
	if !q.Require(regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`).MatchString(name), 400, "Invalid GitHub repository") {
		return nil
	}
	return Object{"id": strconv.FormatInt(number(v["id"]), 10), "fullName": name, "cloneUrl": "https://github.com/" + name + ".git", "defaultBranch": v["default_branch"], "private": v["private"]}
}
func (g *GitHub) repository(q *Queries, user, id string) (Object, Object) {
	if !q.Require(githubID.MatchString(id), 400, "Invalid repository ID") {
		return nil, nil
	}
	auth := g.token(q, user)
	repo := g.normalize(q, g.call(q, "/repositories/"+id, text(auth["accessToken"]), nil, "", false))
	q.Require(text(repo["id"]) == id, 409, "Repository identity changed; refresh and try again")
	return repo, auth
}
func (g *GitHub) source(q *Queries, user string, input Object, owner bool) Object {
	project, source := text(input["projectId"]), text(input["sourceId"])
	if !q.Require(validUUID(project) && validUUID(source), 400, "Invalid request") {
		return nil
	}
	g.Store.member(q, user, project)
	row := q.One("select s.id,r.repository,r.revision,m.role from orka.project_sources s join orka.members m on m.project_id=s.project_id and m.user_id=$3 left join orka.source_repositories r on r.project_id=s.project_id and r.source_id=s.id where s.project_id=$1 and s.id=$2", project, source, user)
	q.Require(row != nil, 404, "Source no longer belongs to this project")
	q.Require(!owner || text(row["role"]) == "owner", 403, "Only project owners can link repositories")
	return row
}
func (g *GitHub) expire(q *Queries, project string) {
	q.Exec("update orka.repository_access_requests set status='expired',revision=revision+1,updated_at=now() where project_id=$1 and status=any($2::text[]) and created_at<now()-interval '30 days'", project, githubActive)
}
func (g *GitHub) Webhook(ctx context.Context, raw []byte, signature, delivery, event string) (any, error) {
	return g.Store.transaction(ctx, func(q *Queries) any {
		if !g.enabled(q) {
			return nil
		}
		h := hmac.New(sha256.New, []byte(g.Settings.WebhookSecret))
		_, _ = h.Write(raw)
		expected := "sha256=" + hex.EncodeToString(h.Sum(nil))
		if !q.Require(hmac.Equal([]byte(expected), []byte(signature)), 401, "Invalid GitHub webhook signature") || !q.Require(validUUID(delivery), 400, "Invalid request") {
			return nil
		}
		payload, err := decode(raw)
		if !q.Require(err == nil, 400, "Invalid webhook JSON") {
			return nil
		}
		if q.One("insert into orka.github_webhook_deliveries(id) values($1) on conflict do nothing returning id", delivery) == nil {
			return Object{"ok": true}
		}
		if event == "github_app_authorization" && text(field(payload, "action")) == "revoked" {
			id := field(field(payload, "sender"), "id")
			if !q.Require(safePositiveInteger(id), 400, "Invalid request") {
				return nil
			}
			github := strconv.FormatInt(number(id), 10)
			q.Exec("delete from orka.github_authorizations where user_id in (select user_id from orka.github_connections where github_id=$1)", github)
			q.Exec("delete from orka.github_connections where github_id=$1", github)
		}
		q.Exec("delete from orka.github_webhook_deliveries where created_at<now()-interval '30 days'")
		return Object{"ok": true}
	})
}
func (g *GitHub) Action(ctx context.Context, user string, raw any) (any, error) {
	q := &Queries{ctx: ctx, db: g.Store.Pool}
	if !g.enabled(q) {
		return nil, q.err
	}
	input := q.Parse(raw, map[string]Field{"action": strField(0, 0), "input": optional(Field{Kind: "any"})})
	result := g.action(q, user, text(input["action"]), input["input"])
	return result, q.err
}
func (g *GitHub) action(q *Queries, user, action string, raw any) any {
	switch action {
	case "status":
		connection := q.One("select github_id as id,login from orka.github_connections where user_id=$1", user)
		return Object{"connected": connection != nil, "identity": connection, "installationUrl": g.installationURL()}
	case "begin":
		device := object(g.call(q, "/login/device/code", "", Object{"client_id": g.Settings.ClientID, "scope": "offline_access"}, "", false))
		if !q.Require(text(device["device_code"]) != "" && text(device["user_code"]) != "" && text(device["verification_uri"]) == "https://github.com/login/device" && safePositiveInteger(device["expires_in"]) && number(device["expires_in"]) <= 1800 && safePositiveInteger(device["interval"]) && number(device["interval"]) <= 60, 400, "Invalid GitHub device response") {
			return nil
		}
		id := newID()
		interval := max(int64(5), number(device["interval"]))
		g.tx(q, func(db *Queries) any {
			db.One("select pg_advisory_xact_lock(hashtextextended($1,0))", "github:"+user)
			db.Exec("delete from orka.github_authorizations where user_id=$1 or expires_at<now()", user)
			db.Exec("insert into orka.github_authorizations values($1,$2,$3,now()+$4*interval '1 second',now()+$5*interval '1 second',$5)", id, user, g.seal(db, device["device_code"], user+":"+id), number(device["expires_in"]), interval)
			return nil
		})
		return Object{"id": id, "userCode": device["user_code"], "verificationUrl": device["verification_uri"], "interval": interval, "expiresIn": device["expires_in"]}
	case "poll":
		v := q.Parse(raw, map[string]Field{"id": uuidField()})
		id := text(v["id"])
		return g.tx(q, func(db *Queries) any {
			db.One("select pg_advisory_xact_lock(hashtextextended($1,0))", "github:"+user)
			row := db.One("select * from orka.github_authorizations where id=$1 and user_id=$2 for update", id, user)
			expires, _ := time.Parse(time.RFC3339Nano, text(row["expires_at"]))
			if !db.Require(row != nil && expires.After(time.Now()), 410, "GitHub authorization expired; start again") {
				return nil
			}
			next, _ := time.Parse(time.RFC3339Nano, text(row["next_poll_at"]))
			if next.After(time.Now()) {
				return Object{"pending": true, "interval": row["poll_interval"]}
			}
			result := object(g.call(db, "/login/oauth/access_token", "", Object{"client_id": g.Settings.ClientID, "device_code": g.unseal(db, text(row["device_code"]), user+":"+id), "grant_type": "urn:ietf:params:oauth:grant-type:device_code"}, "", false))
			if failure, ok := result["error"].(string); ok {
				if !includes([]string{"authorization_pending", "slow_down"}, failure) {
					db.Exec("delete from orka.github_authorizations where id=$1", id)
					return Object{"pending": false, "error": "GitHub authorization declined or expired; start again"}
				}
				interval := number(row["poll_interval"])
				if failure == "slow_down" {
					interval += 5
				}
				interval = min(int64(120), interval)
				db.Exec("update orka.github_authorizations set next_poll_at=now()+$2*interval '1 second',poll_interval=$2 where id=$1", id, interval)
				return Object{"pending": true, "interval": interval}
			}
			value := githubCredentials(db, result)
			identity := object(g.call(db, "/user", text(value["access_token"]), nil, "", false))
			if !db.Require(safePositiveInteger(identity["id"]) && jsLength(text(identity["login"])) >= 1 && jsLength(text(identity["login"])) <= 100, 400, "Invalid GitHub identity") {
				return nil
			}
			github := strconv.FormatInt(number(identity["id"]), 10)
			db.Exec("insert into orka.github_connections values($1,$2,$3,$4,now()+$5*interval '1 second') on conflict(user_id) do update set github_id=excluded.github_id,login=excluded.login,credentials=excluded.credentials,expires_at=excluded.expires_at", user, github, identity["login"], g.seal(db, value, user), number(value["expires_in"]))
			db.Exec("update orka.repository_access_requests set status='canceled',revision=revision+1,updated_at=now(),note='Connected GitHub identity changed' where requester=$1 and github_id<>$2 and status=any($3::text[])", user, github, githubActive)
			db.Exec("delete from orka.github_authorizations where id=$1", id)
			return Object{"connected": true, "identity": Object{"id": github, "login": identity["login"]}}
		})
	case "cancel-authorization":
		v := q.Parse(raw, map[string]Field{"id": uuidField()})
		q.Exec("delete from orka.github_authorizations where user_id=$1 and id=$2", user, v["id"])
		return Object{"ok": true}
	case "disconnect":
		g.tx(q, func(db *Queries) any {
			db.One("select pg_advisory_xact_lock(hashtextextended($1,0))", "github:"+user)
			row := db.One("select credentials from orka.github_connections where user_id=$1 for update", user)
			if row != nil {
				value := githubCredentials(db, g.unseal(db, text(row["credentials"]), user))
				g.call(db, "/applications/"+g.Settings.ClientID+"/token", base64.StdEncoding.EncodeToString([]byte(g.Settings.ClientID+":"+g.Settings.ClientSecret)), Object{"access_token": value["access_token"]}, "DELETE", true)
			}
			db.Exec("delete from orka.github_authorizations where user_id=$1", user)
			db.Exec("delete from orka.github_connections where user_id=$1", user)
			return nil
		})
		return Object{"connected": false}
	case "installations", "repositories":
		if raw == nil {
			raw = Object{}
		}
		v := q.Parse(raw, map[string]Field{"page": optional(Field{Kind: "integer", Min: 1, Max: 10000}), "installationId": optional(contractField("githubRepositoryId"))})
		page := number(v["page"])
		if page == 0 {
			page = 1
		}
		auth := g.token(q, user)
		path := "/user/installations"
		if action == "repositories" {
			if !q.Require(githubID.MatchString(text(v["installationId"])), 400, "Invalid installation ID") {
				return nil
			}
			path += "/" + text(v["installationId"]) + "/repositories"
		}
		value := object(g.call(q, fmt.Sprintf("%s?per_page=50&page=%d", path, page), text(auth["accessToken"]), nil, "", false))
		if !q.Require(nonnegativeInteger(value["total_count"]), 400, "Invalid GitHub response") {
			return nil
		}
		items := []Object{}
		if action == "repositories" {
			for _, raw := range array(value["repositories"]) {
				items = append(items, g.normalize(q, raw))
			}
		} else {
			for _, raw := range array(value["installations"]) {
				v := object(raw)
				_, nameOK := field(v["account"], "login").(string)
				if !q.Require(safePositiveInteger(v["id"]) && nameOK, 400, "Invalid GitHub response") {
					return nil
				}
				items = append(items, Object{"id": strconv.FormatInt(number(v["id"]), 10), "name": field(v["account"], "login")})
			}
		}
		var next any
		if page*50 < number(value["total_count"]) {
			next = page + 1
		}
		return Object{"items": items, "nextPage": next}
	case "repository":
		v := q.Parse(raw, map[string]Field{"repositoryId": contractField("githubRepositoryId")})
		repo, _ := g.repository(q, user, text(v["repositoryId"]))
		return repo
	}
	return g.projectAction(q, user, action, raw)
}
func githubSourceShape(extra map[string]Field) map[string]Field {
	shape := scopeShape(map[string]Field{"sourceId": uuidField()})
	for k, v := range extra {
		shape[k] = v
	}
	return shape
}
func (g *GitHub) projectAction(q *Queries, user, action string, raw any) any {
	switch action {
	case "add-source":
		v := q.Parse(raw, scopeShape(map[string]Field{"repositoryId": contractField("githubRepositoryId")}))
		project := text(v["projectId"])
		g.Store.member(q, user, project)
		repo, _ := g.repository(q, user, text(v["repositoryId"]))
		return g.tx(q, func(db *Queries) any {
			p := db.One("select source_model from orka.projects where id=$1 for update", project)
			g.Store.member(db, user, project)
			if !db.Require(number(p["source_model"]) == 1, 409, "Upgrade this project to add repository sources") || !db.Require(db.One("select 1 from orka.members where project_id=$1 and user_id=$2 and role='owner'", project, user) != nil, 403, "Only project owners can add repositories") || !db.Require(db.One("select 1 from orka.source_repositories where project_id=$1 and repository->>'id'=$2", project, v["repositoryId"]) == nil, 409, "This repository is already linked to a source in this project") || !db.Require(number(db.One("select count(*) as count from orka.project_sources where project_id=$1", project)["count"]) < 100, 400, "A project can contain at most 100 sources") {
				return nil
			}
			id := newID()
			name := strings.Split(text(repo["fullName"]), "/")
			if db.err != nil || len(name) != 2 {
				return nil
			}
			db.Exec("insert into orka.project_sources values($1,$2,$3)", project, id, name[1])
			db.Exec("insert into orka.source_repositories values($1,$2,$3,1)", project, id, repo)
			g.event(db, project, id, user, "add-source", Object{"repositoryId": repo["id"]})
			return Object{"sourceId": id, "repository": repo, "revision": 1}
		})
	case "bind", "unlink":
		v := q.Parse(raw, githubSourceShape(map[string]Field{"repositoryId": optional(contractField("githubRepositoryId")), "expectedRevision": intField(0)}))
		g.source(q, user, v, true)
		var repo Object
		if action == "bind" {
			repo, _ = g.repository(q, user, text(v["repositoryId"]))
		}
		project, source := text(v["projectId"]), text(v["sourceId"])
		return g.tx(q, func(db *Queries) any {
			db.One("select id from orka.projects where id=$1 for update", project)
			g.Store.member(db, user, project)
			if !db.Require(db.One("select 1 from orka.members where project_id=$1 and user_id=$2 and role='owner'", project, user) != nil, 403, "Only project owners can link repositories") {
				return nil
			}
			current := db.One("select revision from orka.source_repositories where project_id=$1 and source_id=$2 for update", project, source)
			if !db.Require(number(current["revision"]) == number(v["expectedRevision"]), 409, "Repository link changed; refresh before trying again") {
				return nil
			}
			revision := number(v["expectedRevision"]) + 1
			payload := repo
			if payload == nil {
				payload = Object{}
			}
			db.Exec("insert into orka.source_repositories values($1,$2,$3,$4) on conflict(project_id,source_id) do update set repository=excluded.repository,revision=excluded.revision", project, source, payload, revision)
			db.Exec("update orka.repository_access_requests set status='canceled',revision=revision+1,updated_at=now(),note='Repository link changed' where project_id=$1 and source_id=$2 and status=any($3::text[])", project, source, githubActive)
			g.event(db, project, source, user, action, Object{"repositoryId": repo["id"], "revision": revision})
			var result any
			if repo != nil {
				result = repo
			}
			return Object{"repository": result, "revision": revision}
		})
	case "access", "clone-credentials":
		v := q.Parse(raw, githubSourceShape(nil))
		row := g.source(q, user, v, false)
		binding := object(row["repository"])
		if !q.Require(text(binding["id"]) != "", 409, "Link a GitHub repository to this source first") {
			return nil
		}
		if q.One("select github_id from orka.github_connections where user_id=$1", user) == nil {
			return Object{"state": "not_connected", "installationUrl": g.installationURL()}
		}
		repo, auth := g.repository(q, user, text(binding["id"]))
		if q.err == nil {
			latest := g.source(q, user, v, false)
			if !q.Require(number(latest["revision"]) == number(row["revision"]) && field(latest["repository"], "id") == binding["id"], 412, "Repository link changed; refresh before continuing") {
				return nil
			}
			if repo["cloneUrl"] != binding["cloneUrl"] {
				previous := unique(append([]string{text(binding["cloneUrl"])}, stringsOf(binding["previousCloneUrls"])...))
				urls := []string{}
				for _, url := range previous {
					if url != text(repo["cloneUrl"]) && len(urls) < 10 {
						urls = append(urls, url)
					}
				}
				q.Exec("update orka.source_repositories set repository=$4 where project_id=$1 and source_id=$2 and revision=$3 and repository->>'id'=$5", v["projectId"], v["sourceId"], row["revision"], merge(repo, Object{"previousCloneUrls": urls}), repo["id"])
			}
			if action == "clone-credentials" {
				return Object{"token": auth["accessToken"], "repository": repo, "bindingRevision": number(row["revision"])}
			}
			q.Exec("with verified as (update orka.repository_access_requests set status='verified',revision=revision+1,updated_at=now() where project_id=$1 and source_id=$2 and requester=$3 and github_id=$4 and repository_id=$5 and status=any($6::text[]) returning id) insert into orka.repository_events(project_id,source_id,actor,action,details) select $1,$2,$3,'access-verified',jsonb_build_object('requestId',id,'repositoryId',$5::text) from verified", v["projectId"], v["sourceId"], user, auth["githubId"], repo["id"], githubActive)
			return Object{"state": "ready", "repository": repo, "bindingRevision": number(row["revision"])}
		}
		if failure, ok := q.err.(*HTTPError); ok && action != "clone-credentials" && includes([]string{"401", "403", "409"}, strconv.Itoa(failure.Status)) {
			state := "access_unavailable"
			if failure.Status == 401 || failure.Status == 409 {
				state = "reconnect"
			}
			q.err = nil
			return Object{"state": state, "installationUrl": g.installationURL()}
		}
		return nil
	case "request-access":
		v := q.Parse(raw, githubSourceShape(map[string]Field{"reason": trimmed(strField(1, 1000))}))
		row := g.source(q, user, v, false)
		binding := object(row["repository"])
		if !q.Require(text(binding["id"]) != "", 409, "Link a GitHub repository first") {
			return nil
		}
		auth := g.token(q, user)
		project, source := text(v["projectId"]), text(v["sourceId"])
		g.expire(q, project)
		return g.tx(q, func(db *Queries) any {
			db.One("select id from orka.projects where id=$1 for update", project)
			g.Store.member(db, user, project)
			current := db.One("select repository from orka.source_repositories where project_id=$1 and source_id=$2", project, source)
			if !db.Require(field(current["repository"], "id") == binding["id"], 409, "Repository link changed; refresh and try again") {
				return nil
			}
			prior := db.One("select id from orka.repository_access_requests where project_id=$1 and source_id=$2 and requester=$3 and status=any($4::text[])", project, source, user, githubActive)
			if prior != nil {
				return Object{"id": prior["id"]}
			}
			id := newID()
			db.Exec("insert into orka.repository_access_requests(id,project_id,source_id,requester,github_id,github_login,repository_id,full_name,reason,status) values($1,$2,$3,$4,$5,$6,$7,$8,$9,'requested')", id, project, source, user, auth["githubId"], auth["login"], binding["id"], binding["fullName"], v["reason"])
			g.event(db, project, source, user, "request-access", Object{"requestId": id, "githubId": auth["githubId"]})
			return Object{"id": id}
		})
	case "requests":
		v := q.Parse(raw, scopeShape(map[string]Field{"offset": optional(Field{Kind: "integer", Min: 0, Max: 100000})}))
		project := text(v["projectId"])
		g.Store.member(q, user, project)
		g.expire(q, project)
		owner := q.One("select 1 from orka.members where project_id=$1 and user_id=$2 and role='owner'", project, user) != nil
		rows := q.Rows(`select id,project_id as "projectId",source_id as "sourceId",requester,github_id as "githubId",github_login as "githubLogin",repository_id as "repositoryId",full_name as "fullName",reason,status,revision,note,created_at as "createdAt",updated_at as "updatedAt" from orka.repository_access_requests where project_id=$1 and ($2 or requester=$3) order by created_at desc,id limit 51 offset $4`, project, owner, user, number(v["offset"]))
		items := []Object{}
		for i, row := range rows {
			if i >= 50 {
				break
			}
			row["revision"] = number(row["revision"])
			row["canReview"] = owner
			items = append(items, row)
		}
		var next any
		if len(rows) > 50 {
			next = number(v["offset"]) + 50
		}
		return Object{"items": items, "nextOffset": next}
	case "review":
		v := q.Parse(raw, scopeShape(map[string]Field{"id": uuidField(), "expectedRevision": intField(1), "status": enumField("waiting_on_github", "invitation_pending", "rejected", "canceled"), "note": trimmed(strField(1, 1000))}))
		project := text(v["projectId"])
		return g.tx(q, func(db *Queries) any {
			db.One("select id from orka.projects where id=$1 for update", project)
			g.Store.member(db, user, project)
			owner := db.One("select 1 from orka.members where project_id=$1 and user_id=$2 and role='owner'", project, user) != nil
			row := db.One("select * from orka.repository_access_requests where project_id=$1 and id=$2 for update", project, v["id"])
			if !db.Require(row != nil && (owner || text(row["requester"]) == user && text(v["status"]) == "canceled"), 403, "Only project owners can review repository requests; requesters can cancel their own") || !db.Require(includes(githubActive, text(row["status"])) && number(row["revision"]) == number(v["expectedRevision"]), 409, "Request changed; refresh before reviewing") {
				return nil
			}
			db.Exec("update orka.repository_access_requests set status=$2,note=$3,revision=revision+1,updated_at=now() where id=$1", v["id"], v["status"], v["note"])
			g.event(db, project, text(row["source_id"]), user, "review", Object{"requestId": v["id"], "status": v["status"], "note": v["note"]})
			return Object{"ok": true}
		})
	default:
		q.Require(false, 404, "Unknown GitHub repository action")
		return nil
	}
}
func (g *GitHub) event(q *Queries, project, source, user, action string, details Object) {
	q.Exec("insert into orka.repository_events(project_id,source_id,actor,action,details) values($1,$2,$3,$4,$5)", project, source, user, action, details)
}
