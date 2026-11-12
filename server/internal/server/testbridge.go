//go:build orkatest

package server

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

// This adapter is compiled only into the acceptance-test executable. The normal
// server has neither the control endpoint nor callback authentication.
type bridgeResolver struct {
	callback func(context.Context, string, Object) (any, error)
}
type bridgeTransport struct {
	callback func(context.Context, string, Object) (any, error)
}

func (t bridgeTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	headers := Object{}
	for key := range req.Header {
		headers[key] = req.Header.Get(key)
	}
	var body any
	if req.Body != nil {
		raw, err := io.ReadAll(req.Body)
		if err != nil {
			return nil, err
		}
		body = string(raw)
	}
	result, err := t.callback(req.Context(), "github", Object{"url": req.URL.String(), "requestMethod": req.Method, "headers": headers, "body": body})
	if err != nil {
		return nil, err
	}
	value := object(result)
	responseHeaders := http.Header{}
	for k, v := range object(value["headers"]) {
		responseHeaders.Set(k, text(v))
	}
	return &http.Response{StatusCode: int(number(value["status"])), Header: responseHeaders, Body: io.NopCloser(strings.NewReader(text(value["body"]))), Request: req}, nil
}

func (r bridgeResolver) Resolve(ctx context.Context, state Object) ([]Object, error) {
	v, err := r.callback(ctx, "memory", Object{"state": state})
	out := []Object{}
	for _, v := range array(v) {
		out = append(out, object(v))
	}
	return out, err
}

type bridgeBlobs struct {
	*Blobs
	callback func(context.Context, string, Object) (any, error)
}

func (b bridgeBlobs) RemoveProject(project string) error {
	_, err := b.callback(context.Background(), "removeProject", Object{"project": project})
	return err
}

func RunTestCommand(method string) error {
	var input struct{ Environment map[string]string }
	if err := json.NewDecoder(os.Stdin).Decode(&input); err != nil {
		return err
	}
	var result any
	var err error
	switch method {
	case "auth-settings":
		var settings AuthSettings
		settings, err = SettingsFromEnv(input.Environment, false)
		result = Object{"mode": settings.Mode, "password": settings.Password, "github": settings.GitHub, "magicLink": settings.MagicLink, "emailProvider": settings.EmailProvider, "publicUrl": settings.PublicURL, "trustProxy": settings.TrustProxy}
	case "github-settings":
		var settings GitHubSettings
		settings, err = GitHubSettingsFromEnv(input.Environment)
		result = Object{"enabled": settings.Enabled, "clientId": settings.ClientID, "clientSecret": settings.ClientSecret, "appSlug": settings.AppSlug, "encryptionKey": settings.EncryptionKey, "webhookSecret": settings.WebhookSecret}
	case "migration-info":
		result = Object{"initialMigration": InitialMigration, "legacyMigrationNames": LegacyMigrationNames}
	default:
		return fmt.Errorf("unknown test command: %s", method)
	}
	if err != nil {
		return json.NewEncoder(os.Stdout).Encode(Object{"error": err.Error()})
	}
	return json.NewEncoder(os.Stdout).Encode(Object{"result": result})
}

func RunTestBridge() error {
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	secret, callbackURL := os.Getenv("ORKA_TEST_SECRET"), os.Getenv("ORKA_TEST_CALLBACK")
	if len(secret) < 32 || callbackURL == "" {
		return fmt.Errorf("test callback and secret are required")
	}
	store, err := Open(ctx, os.Getenv("DATABASE_URL"), os.Getenv("BLOB_ROOT"))
	if err != nil {
		return err
	}
	defer store.Pool.Close()
	callback := func(ctx context.Context, method string, args Object) (any, error) {
		response, err := requestHTTP(ctx, http.MethodPost, callbackURL, jsonBytes(merge(Object{"method": method}, args)), http.Header{"Content-Type": []string{"application/json"}, "X-Orka-Test-Secret": []string{secret}}, 30*time.Second)
		if err != nil {
			return nil, err
		}
		defer response.Body.Close()
		bytes, err := io.ReadAll(response.Body)
		if err != nil {
			return nil, err
		}
		value, err := decode(bytes)
		if err != nil {
			return nil, err
		}
		if failure := object(field(value, "error")); failure != nil {
			return nil, &HTTPError{Status: int(number(failure["status"])), Message: text(failure["message"])}
		}
		return field(value, "result"), nil
	}
	if os.Getenv("ORKA_TEST_MEMORY_CALLBACK") == "true" {
		store.Resolver = bridgeResolver{callback}
	} else {
		store.Resolver, err = memorySettings(processEnv())
		if err != nil {
			return err
		}
	}
	store.Blobs = bridgeBlobs{&Blobs{Root: os.Getenv("BLOB_ROOT")}, callback}
	api := NewAPI(store, AuthSettings{Mode: "self-hosted", Password: true}, "")
	api.Authenticate = func(ctx context.Context, token string) (string, error) {
		v, err := callback(ctx, "authenticate", Object{"token": token})
		return text(v), err
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/control", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Orka-Test-Secret")), []byte(secret)) != 1 {
			w.WriteHeader(403)
			return
		}
		raw, err := readJSON(w, r)
		if err != nil {
			writeError(w, err)
			return
		}
		input := object(raw)
		args := object(input["args"])
		user := text(args["user"])
		method := text(input["method"])
		var result any
		switch method {
		case "configure":
			err = json.Unmarshal(jsonBytes(args["settings"]), &api.Settings)
			api.AuthURL = text(args["authUrl"])
			if github := object(args["github"]); github != nil {
				var settings GitHubSettings
				err = json.Unmarshal(jsonBytes(github), &settings)
				api.Repositories = &GitHub{Store: store, Settings: settings, Client: &http.Client{Transport: bridgeTransport{callback}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
			}
			if env := object(args["environment"]); env != nil {
				api.Environment = map[string]string{}
				for key, value := range env {
					api.Environment[key] = text(value)
				}
			}
			if flag(args["mcpEnabled"]) {
				api.MCP, err = NewMCP(api)
			}
			result = Object{"ok": true}
		case "reader":
			result, err = (Reader{store, user, text(args["origin"])}).run(r.Context(), text(args["name"]), object(args["input"]))
		case "readSession":
			result, err = store.read(r.Context(), func(q *Queries) any { return store.readSession(q, object(args["resource"])) })
		case "pid":
			result, err = store.read(r.Context(), func(q *Queries) any { return q.One("select pg_backend_pid() as pid")["pid"] })
		case "migrate":
			err = store.Migrate(r.Context(), flag(args["resetLedger"]))
		case "accountAuthenticate":
			native := NewAPI(store, AuthSettings{}, text(args["authUrl"]))
			result, err = native.accountAuthenticate(r.Context(), text(args["token"]))
		case "oauth":
			oauth := &OAuth{Store: store, Origin: text(args["origin"])}
			client := text(field(args["client"], "client_id"))
			switch text(args["operation"]) {
			case "refresh":
				result, err = oauth.refresh(r.Context(), client, text(args["token"]), text(args["scope"]), text(args["resource"]))
			case "verify":
				result, err = store.read(r.Context(), func(q *Queries) any { return oauth.verify(q, text(args["token"])) })
			case "revoke":
				result, err = oauth.revoke(r.Context(), client, text(args["token"]))
			case "register":
				result, err = store.read(r.Context(), func(q *Queries) any { return oauth.register(q, object(args["client"])) })
			default:
				err = bad("Unknown OAuth test operation")
			}
		case "member":
			result, err = store.read(ctx, func(q *Queries) any { store.member(q, user, text(args["project"])); return nil })
		case "device":
			result, err = store.read(ctx, func(q *Queries) any {
				store.device(q, user, text(args["id"]), text(args["name"]), args["hardwareFamily"])
				return nil
			})
		case "createProject":
			result, err = store.transaction(ctx, func(q *Queries) any {
				return store.createProject(q, user, text(args["name"]), flag(args["governed"]), args["remoteKey"], args["requestId"], flag(args["roles"]))
			})
		case "addSources":
			result, err = store.transaction(ctx, func(q *Queries) any { return store.addSources(q, user, object(args["input"])) })
		case "mutate":
			result, err = store.transaction(ctx, func(q *Queries) any { return store.change(q, user, object(args["input"]), ChangeOptions{}) })
		case "resolve":
			result, err = store.transaction(ctx, func(q *Queries) any { return store.resolve(q, user, object(args["input"])) })
		case "copy":
			result, err = store.transaction(ctx, func(q *Queries) any { return store.copySession(q, user, object(args["input"])) })
		case "permissions.access":
			result, err = store.read(ctx, func(q *Queries) any { return store.access(q, user, text(args["project"]), object(args["resource"])) })
		case "permissions.canRead":
			result, err = store.read(ctx, func(q *Queries) any { return store.canRead(q, user, text(args["project"]), text(args["id"])) })
		case "governance":
			result, err = store.transaction(ctx, func(q *Queries) any {
				return store.governance(q, user, text(field(args["input"], "action")), object(field(args["input"], "input")))
			})
		case "cleanup":
			store.cleanupBlobs(ctx)
			result = nil
		default:
			err = bad("Unknown test control operation")
		}
		if err != nil {
			failure := Object{"status": 500, "message": err.Error()}
			if h, ok := err.(*HTTPError); ok {
				failure["status"] = h.Status
				failure["code"] = h.Code
			}
			if p, ok := err.(*pgconn.PgError); ok {
				failure["code"] = p.Code
			}
			_, _ = w.Write(jsonBytes(Object{"error": failure}))
			return
		}
		_, _ = w.Write(jsonBytes(Object{"result": result}))
	})
	mux.Handle("/", api)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	fmt.Println(string(jsonBytes(Object{"origin": "http://" + listener.Addr().String()})))
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	err = server.Serve(listener)
	if err == http.ErrServerClosed {
		return nil
	}
	return err
}
