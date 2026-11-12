package server

import (
	"os"
	"testing"
)

func TestEnvSignatureFixture(t *testing.T) {
	bytes, err := os.ReadFile("../../packages/protocol/fixtures/env-signature.json")
	if err != nil {
		t.Fatal(err)
	}
	raw, err := decode(bytes)
	if err != nil {
		t.Fatal(err)
	}
	fixture := object(raw)
	value := object(fixture["value"])
	if Canonical(value) != text(fixture["canonical"]) || !VerifyEnvSignature(text(fixture["publicKey"]), value, text(fixture["signature"])) {
		t.Fatal("native ENV signature fixture rejected")
	}
	value["revision"] = 2
	if VerifyEnvSignature(text(fixture["publicKey"]), value, text(fixture["signature"])) {
		t.Fatal("tampered ENV signature accepted")
	}
}
