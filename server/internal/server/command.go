package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/joho/godotenv"
)

// Edition is set by the image build. The OSS executable always uses self-hosted
// defaults; the managed executable always advertises managed auth capabilities.
var Edition = "oss"
var Version = "development"

func Command(ctx context.Context, args []string) error {
	action := "serve"
	if len(args) > 0 {
		action = args[0]
		args = args[1:]
	}
	env := processEnv()
	switch action {
	case "version", "--version":
		fmt.Printf("orka-server %s (%s)\n", Version, Edition)
		return nil
	case "serve":
		if len(args) > 0 {
			return fmt.Errorf("serve takes no arguments")
		}
		return run(ctx, env)
	case "healthcheck":
		_, err := getJSON(ctx, "http://127.0.0.1:"+envOr(env, "PORT", "8080")+"/health")
		return err
	case "doctor":
		return doctor(ctx, env)
	case "create-user":
		return createUser(ctx, args, env)
	case "check-deployment":
		if len(args) < 1 || len(args) > 2 {
			return fmt.Errorf("usage: orka-server check-deployment FILE [--cloud]")
		}
		config, err := godotenv.Read(args[0])
		if err != nil {
			return err
		}
		return checkDeployment(config, len(args) == 2 && args[1] == "--cloud")
	case "verify-deployment":
		if len(args) != 1 {
			return fmt.Errorf("usage: orka-server verify-deployment FILE")
		}
		config, err := godotenv.Read(args[0])
		if err != nil {
			return err
		}
		return verifyDeployment(ctx, "https://"+config["DOMAIN"])
	case "check-data-root":
		if len(args) != 1 {
			return fmt.Errorf("usage: orka-server check-data-root FILE")
		}
		config, err := godotenv.Read(args[0])
		if err != nil {
			return err
		}
		if config["DATA_ROOT"] != "" && config["DATA_ROOT"] != "/srv/orka" {
			return fmt.Errorf("CI requires DATA_ROOT=/srv/orka")
		}
		return nil
	case "check-empty-database":
		if len(args) != 1 {
			return fmt.Errorf("usage: orka-server check-empty-database DIRECTORY")
		}
		entries, err := os.ReadDir(args[0])
		if err != nil {
			return err
		}
		if len(entries) > 0 {
			return fmt.Errorf("Initial CI deployment requires an empty database directory; migrate existing stacks explicitly")
		}
		return nil
	case "migrate", "migrate-sources":
		store, err := Open(ctx, env["DATABASE_URL"], env["BLOB_ROOT"])
		if err != nil {
			return err
		}
		defer store.Pool.Close()
		if action == "migrate-sources" {
			return store.migrateSources(ctx, includes(args, "--apply"))
		}
		for _, arg := range args {
			if arg != "--reset-ledger" {
				return fmt.Errorf("unknown migration option")
			}
		}
		return store.Migrate(ctx, includes(args, "--reset-ledger"))
	case "help", "--help", "-h":
		fmt.Println("orka-server [serve|version|healthcheck|doctor|create-user|migrate|migrate-sources|check-deployment|verify-deployment]")
		return nil
	default:
		return fmt.Errorf("unknown command %q; run orka-server help", action)
	}
}
func envOr(env map[string]string, key, def string) string {
	if v := env[key]; v != "" {
		return v
	}
	return def
}
func run(parent context.Context, env map[string]string) error {
	ctx, cancel := signal.NotifyContext(parent, syscall.SIGTERM, syscall.SIGINT)
	defer cancel()
	for _, key := range []string{"AUTH_URL", "DATABASE_URL", "BLOB_ROOT"} {
		if env[key] == "" {
			return fmt.Errorf("missing %s", key)
		}
	}
	env = cloneStrings(env)
	if Edition == "oss" {
		env["DEPLOYMENT_MODE"] = "self-hosted"
	}
	settings, err := SettingsFromEnv(env, Edition == "managed")
	if err != nil {
		return err
	}
	memory, err := memorySettings(env)
	if err != nil {
		return err
	}
	store, err := Open(ctx, env["DATABASE_URL"], env["BLOB_ROOT"])
	if err != nil {
		return err
	}
	defer store.Pool.Close()
	store.Resolver = memory
	if err = store.Migrate(ctx, false); err != nil {
		return err
	}
	github, err := GitHubSettingsFromEnv(env)
	if err != nil {
		return err
	}
	api := NewAPI(store, settings, env["AUTH_URL"])
	api.Repositories = &GitHub{Store: store, Settings: github}
	if settings.MCPEnabled {
		api.MCP, err = NewMCP(api)
		if err != nil {
			return err
		}
	}
	port, err := strconv.Atoi(envOr(env, "PORT", "8080"))
	if err != nil || port < 1 || port > 65535 {
		return fmt.Errorf("PORT must be between 1 and 65535")
	}
	listener, err := net.Listen("tcp", net.JoinHostPort("0.0.0.0", strconv.Itoa(port)))
	if err != nil {
		return err
	}
	defer listener.Close()
	server := &http.Server{Handler: api, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 1 << 20}
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		timer := time.NewTicker(time.Minute)
		defer timer.Stop()
		for {
			store.cleanupBlobs(ctx)
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
			}
		}
	}()
	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		<-ctx.Done()
		shutdown, c := context.WithTimeout(context.Background(), 30*time.Second)
		defer c()
		if err := server.Shutdown(shutdown); err != nil {
			_ = server.Close()
		}
	}()
	log.Printf("orka_server_ready edition=%s port=%d", Edition, port)
	err = server.Serve(listener)
	cancel()
	<-shutdownDone
	<-stopped
	if err == http.ErrServerClosed {
		return nil
	}
	return err
}
func memorySettings(env map[string]string) (*JevResolver, error) {
	enabled := envOr(env, "MEMORY_JEV_ENABLED", "true")
	if enabled != "true" && enabled != "false" {
		return nil, fmt.Errorf("MEMORY_JEV_ENABLED must be true or false")
	}
	key := trim(env["JEV_API_KEY"])
	if key == "" {
		key = trim(env["TYPESAFE_API_KEY"])
	}
	return &JevResolver{Enabled: enabled == "true", APIKey: key}, nil
}
func getJSON(ctx context.Context, endpoint string) (any, error) {
	response, err := requestHTTP(ctx, "GET", endpoint, nil, nil, 15*time.Second)
	if err != nil {
		return nil, fmt.Errorf("service health check failed")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("service health check failed (HTTP %d)", response.StatusCode)
	}
	bytes, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	return decode(bytes)
}
func retry(ctx context.Context, attempts int, delay time.Duration, fn func() error) error {
	var err error
	for i := 0; i < attempts; i++ {
		if err = fn(); err == nil {
			return nil
		}
		if i+1 < attempts {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(delay):
			}
		}
	}
	return err
}
func doctor(ctx context.Context, env map[string]string) error {
	if _, err := getJSON(ctx, strings.TrimSuffix(envOr(env, "AUTH_URL", "http://auth:9999"), "/")+"/health"); err != nil {
		return fmt.Errorf("authentication service check failed")
	}
	origin := "http://127.0.0.1:" + envOr(env, "PORT", "8080")
	if _, err := getJSON(ctx, origin+"/health"); err != nil {
		return fmt.Errorf("API/database check failed")
	}
	instance, err := getJSON(ctx, origin+"/v2/instance")
	if err != nil {
		return err
	}
	if text(field(instance, "mode")) != "self-hosted" {
		return fmt.Errorf("expected a self-hosted API")
	}
	auth := object(field(instance, "auth"))
	if !flag(auth["password"]) && !flag(auth["github"]) && !flag(auth["magicLink"]) {
		return fmt.Errorf("no sign-in provider is enabled; check .env")
	}
	suffix := "."
	if env["TRUST_PROXY"] == "true" {
		if err = retry(ctx, 6, 2*time.Second, func() error { _, err := getJSON(ctx, env["PUBLIC_URL"]+"/health"); return err }); err != nil {
			return fmt.Errorf("public HTTPS check failed; check DNS, ports 80/443 and Caddy logs")
		}
		suffix = "; public HTTPS passed."
	}
	fmt.Println("Database, authentication and API checks passed" + suffix)
	return nil
}
func checkDeployment(env map[string]string, cloud bool) error {
	domain := env["DOMAIN"]
	if !regexp.MustCompile(`^[a-zA-Z0-9.-]+$`).MatchString(domain) || strings.Contains(domain, "example.") || domain == "localhost" {
		return fmt.Errorf("set DOMAIN to the public hostname or stable public IP")
	}
	seen := map[string]bool{}
	for _, key := range []string{"POSTGRES_PASSWORD", "AUTH_DB_PASSWORD", "API_DB_PASSWORD"} {
		value := env[key]
		if !regexp.MustCompile(`(?i)^[a-f0-9]{48,}$`).MatchString(value) {
			return fmt.Errorf("%s must contain at least 24 random hex bytes", key)
		}
		if seen[value] {
			return fmt.Errorf("use separate database passwords for each role")
		}
		seen[value] = true
	}
	if !regexp.MustCompile(`(?i)^[a-f0-9]{64,}$`).MatchString(env["JWT_SECRET"]) {
		return fmt.Errorf("JWT_SECRET must contain at least 32 random hex bytes")
	}
	env = cloneStrings(env)
	env["PUBLIC_URL"] = "https://" + domain
	cloud = cloud || env["DEPLOYMENT_MODE"] == "cloud"
	if cloud {
		env["DEPLOYMENT_MODE"] = "cloud"
		env["GITHUB_ENABLED"] = "true"
		env["MAGIC_LINK_ENABLED"] = "true"
		env["EMAIL_PROVIDER"] = "resend"
		env["RESEND_ENABLED"] = "true"
	}
	settings, err := SettingsFromEnv(env, false)
	if err != nil {
		return err
	}
	memory, err := memorySettings(env)
	if err != nil {
		return err
	}
	if memory.Enabled && memory.APIKey == "" {
		return fmt.Errorf("set JEV_API_KEY (or TYPESAFE_API_KEY), or MEMORY_JEV_ENABLED=false to defer memory replacements")
	}
	if settings.GitHub && (env["GITHUB_CLIENT_ID"] == "" || env["GITHUB_CLIENT_SECRET"] == "") {
		return fmt.Errorf("configure the GitHub OAuth App client ID and secret")
	}
	if (env["RESEND_ENABLED"] == "true") != (settings.EmailProvider == "resend") {
		return fmt.Errorf("EMAIL_PROVIDER=resend and RESEND_ENABLED=true must be set together")
	}
	if settings.EmailProvider == "resend" {
		if !regexp.MustCompile(`^v1,whsec_[A-Za-z0-9+/]{43}=$`).MatchString(env["SEND_EMAIL_HOOK_SECRET"]) {
			return fmt.Errorf("generate SEND_EMAIL_HOOK_SECRET as v1,whsec_ followed by 32 base64-encoded random bytes")
		}
		if !strings.HasPrefix(env["RESEND_API_KEY"], "re_") || !strings.Contains(env["RESEND_FROM"], "@") {
			return fmt.Errorf("configure a Resend sending key and verified sender")
		}
	}
	if settings.MagicLink && settings.EmailProvider == "smtp" && (env["SMTP_HOST"] == "" || env["SMTP_FROM"] == "") {
		return fmt.Errorf("magic links need SMTP configuration or Resend")
	}
	fmt.Printf("Configuration valid for %s. Provider credentials and sender verification still require a live sign-in smoke test.\nGitHub callback: https://%s/auth/callback\nDesktop redirect: orka://auth/callback\n", settings.Mode, domain)
	return nil
}
func verifyDeployment(ctx context.Context, origin string) error {
	return retry(ctx, 6, 5*time.Second, func() error {
		if _, err := getJSON(ctx, origin+"/health"); err != nil {
			return err
		}
		v, err := getJSON(ctx, origin+"/v2/instance")
		if err != nil {
			return err
		}
		if number(field(v, "version")) != 1 || text(field(v, "mode")) != "cloud" || !flag(field(field(v, "auth"), "github")) || !flag(field(field(v, "auth"), "magicLink")) {
			return fmt.Errorf("managed auth capabilities check failed")
		}
		fmt.Println("Public HTTPS health and managed auth capabilities passed.")
		return nil
	})
}
func createUser(ctx context.Context, args []string, env map[string]string) error {
	if len(args) != 1 && len(args) != 3 || len(args) > 0 && !emailPattern.MatchString(args[0]) {
		return fmt.Errorf("usage: docker compose run --rm admin owner@example.com [--output owner.json]")
	}
	email := args[0]
	filename := ""
	if len(args) == 3 {
		if args[1] != "--output" || !regexp.MustCompile(`^[a-z][a-z0-9-]*\.json$`).MatchString(args[2]) {
			return fmt.Errorf("use --output owner.json to save an account at a stable private filename")
		}
		filename = args[2]
	}
	config, err := godotenv.Read(envOr(env, "ORKA_OPERATOR_ENV", "/run/secrets/operator_env"))
	if err != nil {
		return err
	}
	if len(config["JWT_SECRET"]) < 32 {
		return fmt.Errorf("the operator configuration needs a JWT_SECRET of at least 32 characters")
	}
	auth, err := url.Parse(envOr(env, "AUTH_URL", "http://auth:9999"))
	if err != nil || auth.Host == "" || auth.User != nil || auth.RawQuery != "" || auth.Fragment != "" || auth.Path != "" && auth.Path != "/" || !includes([]string{"http", "https"}, auth.Scheme) {
		return fmt.Errorf("AUTH_URL must be the internal GoTrue origin")
	}
	service := "https://" + config["DOMAIN"]
	if config["DOMAIN"] == "localhost" {
		service = "http://127.0.0.1:" + envOr(config, "ORKA_LOCAL_PORT", "8080")
	}
	name := filename
	if name == "" {
		name = "account-" + newID() + ".json"
	}
	path := filepath.Join(envOr(env, "ORKA_ACCOUNT_DIRECTORY", "/output"), name)
	request := func(endpoint string, body Object, bearer string) (int, error) {
		headers := http.Header{"Content-Type": []string{"application/json"}}
		if bearer != "" {
			headers.Set("Authorization", "Bearer "+bearer)
		}
		response, err := requestHTTP(ctx, "POST", strings.TrimSuffix(auth.String(), "/")+endpoint, jsonBytes(body), headers, 15*time.Second)
		if err != nil {
			return 0, err
		}
		defer response.Body.Close()
		return response.StatusCode, nil
	}
	if filename != "" {
		bytes, err := os.ReadFile(path)
		if err == nil {
			v, err := decode(bytes)
			saved := object(v)
			if err != nil || !strings.EqualFold(text(saved["email"]), email) || text(saved["password"]) == "" {
				return fmt.Errorf("setup already belongs to another account; existing credentials were preserved")
			}
			status, err := request("/token?grant_type=password", Object{"email": saved["email"], "password": saved["password"]}, "")
			if err != nil || status < 200 || status >= 300 {
				return fmt.Errorf("the saved owner login could not be verified; credentials were preserved")
			}
			if text(saved["service"]) != service {
				saved["service"] = service
				temporary := path + "." + newID()
				if err = writePrivate(temporary, saved); err != nil {
					return err
				}
				if err = os.Rename(temporary, path); err != nil {
					return err
				}
			}
			fmt.Printf("Existing account verified. Credentials remain in .runtime/accounts/%s.\n", name)
			return nil
		}
		if !os.IsNotExist(err) {
			return fmt.Errorf("the existing private account file could not be read; it was preserved")
		}
	}
	password := base64.RawURLEncoding.EncodeToString(randomBytes(24))
	if err = writePrivate(path, Object{"service": service, "email": email, "password": password}); err != nil {
		return err
	}
	now := time.Now().Unix()
	encode := func(v any) string { return base64.RawURLEncoding.EncodeToString(jsonBytes(v)) }
	unsigned := encode(Object{"alg": "HS256", "typ": "JWT"}) + "." + encode(Object{"role": "service_role", "aud": "authenticated", "iat": now, "exp": now + 60})
	h := hmac.New(sha256.New, []byte(config["JWT_SECRET"]))
	_, _ = h.Write([]byte(unsigned))
	bearer := unsigned + "." + base64.RawURLEncoding.EncodeToString(h.Sum(nil))
	status, err := request("/admin/users", Object{"email": email, "password": password, "email_confirm": true}, bearer)
	if err != nil {
		return fmt.Errorf("account creation could not be confirmed; check GoTrue before retrying; credentials retained in .runtime/accounts/%s", name)
	}
	if status < 200 || status >= 300 {
		if err = os.Remove(path); err != nil {
			return err
		}
		return fmt.Errorf("account provisioning failed (HTTP %d); the account may already exist", status)
	}
	fmt.Printf("Account created. Read .runtime/accounts/%s privately for the password (mode 0600).\n", name)
	return nil
}
func writePrivate(path string, value any) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	encoder := json.NewEncoder(file)
	encoder.SetIndent("", "  ")
	err = encoder.Encode(value)
	if err == nil {
		err = file.Sync()
	}
	closed := file.Close()
	if err == nil {
		err = closed
	}
	return err
}
