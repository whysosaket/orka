package server

import "testing"

func TestSkillSnapshotHashMatchesNativeUTF8Manifest(t *testing.T) {
	files := []Object{{"path": "scripts/a\u2028b\u2029.ts", "hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "size": 123, "executable": true}, {"path": "SKILL.md", "hash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "size": 20, "executable": false}}
	// Independently calculated using UTF-8 JSON with sorted keys, as native
	// serde_json does, including literal Unicode line separators.
	if got := skillSnapshotHash(files); got != "3985a8285727b0c1b17b733f173656d54de809194f762257cc414da3e682b6ea" {
		t.Fatalf("native skill manifest hash mismatch: %s", got)
	}
}
