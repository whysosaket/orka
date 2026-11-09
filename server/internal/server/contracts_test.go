package server

import (
	"os"
	"testing"
)

func TestCanonicalProtocolFixtures(t *testing.T) {
	bytes, err := os.ReadFile("testdata/protocol.json")
	if err != nil {
		t.Fatal(err)
	}
	v, err := decode(bytes)
	if err != nil {
		t.Fatal(err)
	}
	fixture := object(v)
	for i, raw := range array(fixture["canonicals"]) {
		row := object(raw)
		if got := Canonical(row["value"]); got != text(row["canonical"]) {
			t.Errorf("canonical %d: %q != %q", i, got, row["canonical"])
		}
		if got := Hash(row["value"]); got != text(row["hash"]) {
			t.Errorf("hash %d differs", i)
		}
	}
	for i, raw := range array(fixture["merges"]) {
		row := object(raw)
		base, current, incoming := text(row["base"]), text(row["current"]), text(row["incoming"])
		if got := MergeText(base, current, incoming); got != text(row["merged"]) {
			t.Fatalf("merge %d: %q != %q (base %q, current %q, incoming %q)", i, got, row["merged"], base, current, incoming)
		}
		got, _ := decode(jsonBytes(DiffText(base, incoming)))
		if Canonical(got) != Canonical(row["edits"]) {
			t.Fatalf("edits %d differ: %s != %s", i, Canonical(got), Canonical(row["edits"]))
		}
	}
	for i, raw := range array(fixture["cases"]) {
		row := object(raw)
		_, err := ValidateContract(text(row["name"]), row["value"])
		if (err == nil) != flag(row["valid"]) {
			t.Errorf("validation %d (%s): got %v, want valid=%v", i, row["name"], err, row["valid"])
		}
	}
}
