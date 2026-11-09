package server

import (
	"os"
	"testing"
)

// The fixture producer runs the canonical Zod parsers, including refinements,
// defaults and unknown-field handling that JSON Schema alone cannot represent.
func TestContractParityReplay(t *testing.T) {
	path := os.Getenv("ORKA_CONTRACT_FIXTURES")
	if path == "" {
		t.Skip("run npm run contracts:check for cross-language validation")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	fixture, err := decode(data)
	if err != nil {
		t.Fatal(err)
	}
	failures := 0
	for _, raw := range array(field(fixture, "cases")) {
		row := object(raw)
		got, err := ValidateContract(text(row["name"]), row["value"])
		if (err == nil) != flag(row["valid"]) {
			if failures < 40 {
				t.Errorf("%s / %s: valid=%v, want %v", text(row["name"]), text(row["scenario"]), err == nil, row["valid"])
			}
			failures++
			continue
		}
		if err == nil && Canonical(got) != Canonical(row["parsed"]) {
			if failures < 40 {
				t.Errorf("%s / %s: parsed values differ", text(row["name"]), text(row["scenario"]))
			}
			failures++
		}
	}
	if failures > 0 {
		t.Fatalf("%d contract cases differed", failures)
	}
}
