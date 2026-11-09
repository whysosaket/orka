package server

import (
	"bytes"
	"context"
	"strings"
	"testing"
)

func TestGitHubCredentialEnvelopeCompatibility(t *testing.T) {
	// Produced by Node's aes-256-gcm with a fixed synthetic key and nonce.
	const fixture = "BwcHBwcHBwcHBwcHqp85D7waZpsCJjakophLntaGvBdvIpKGFZK4gJBSBwCiikTe7ZiH4bc1uKUR8UED44QCcMbFllbXPNFgMNYRIqu2M4nLg0Nd9f37qoibu1JJpZG+RrHuGPXIWObqxFM+nUEWJtlP"
	g := GitHub{Settings: GitHubSettings{EncryptionKey: bytes.Repeat([]byte{171}, 32)}}
	q := &Queries{ctx: context.Background()}
	value := g.unseal(q, fixture, "fixture-user")
	if q.err != nil || text(field(value, "access_token")) != "fixture-access" || number(field(value, "expires_in")) != 28800 {
		t.Fatalf("cannot open existing Node credentials: %v", q.err)
	}
	sealed := g.seal(q, value, "fixture-user")
	if q.err != nil || Canonical(g.unseal(q, sealed, "fixture-user")) != Canonical(value) {
		t.Fatalf("credential round trip failed: %v", q.err)
	}
	wrong := &Queries{ctx: context.Background()}
	g.unseal(wrong, fixture, "different-user")
	if wrong.err == nil {
		t.Fatal("credential associated data was not authenticated")
	}
	wrong = &Queries{ctx: context.Background()}
	g.Settings.EncryptionKey = bytes.Repeat([]byte{172}, 32)
	g.unseal(wrong, fixture, "fixture-user")
	if wrong.err == nil {
		t.Fatal("wrong token key accepted")
	}
}
func TestGitHubSettingsRemainOptional(t *testing.T) {
	if settings, err := GitHubSettingsFromEnv(map[string]string{}); err != nil || settings.Enabled {
		t.Fatal("optional integration changed defaults")
	}
	env := map[string]string{"GITHUB_REPOS_ENABLED": "true", "GITHUB_CLIENT_ID": "Iv1fixture", "GITHUB_CLIENT_SECRET": "fixture", "GITHUB_REPOS_APP_SLUG": "orka-development", "GITHUB_REPOS_TOKEN_KEY": strings.Repeat("ab", 32), "GITHUB_REPOS_WEBHOOK_SECRET": strings.Repeat("fixture-", 5)}
	settings, err := GitHubSettingsFromEnv(env)
	if err != nil || settings.ClientID != "Iv1fixture" || len(settings.EncryptionKey) != 32 {
		t.Fatalf("valid app settings rejected: %v", err)
	}
	for _, key := range []string{"GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "GITHUB_REPOS_APP_SLUG", "GITHUB_REPOS_TOKEN_KEY", "GITHUB_REPOS_WEBHOOK_SECRET"} {
		copy := cloneStrings(env)
		delete(copy, key)
		if _, err := GitHubSettingsFromEnv(copy); err == nil {
			t.Fatalf("enabled integration accepted missing %s", key)
		}
	}
}
