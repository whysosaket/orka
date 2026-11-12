package server

import (
	"encoding/base64"
	"encoding/binary"
	"strings"
	"testing"
)

func TestProfileInputsPreserveBoundsAndRejectPrivilegeFields(t *testing.T) {
	profile, err := parseProfile(Object{"displayName": " Pratham ", "avatarUrl": "https://avatars.githubusercontent.com/u/123", "source": "github", "ifAbsent": true})
	if err != nil || profile["displayName"] != "Pratham" {
		t.Fatalf("profile normalization: %v %v", profile, err)
	}
	for _, avatar := range []string{"http://avatars.githubusercontent.com/u/1", "https://avatars.githubusercontent.com.evil.test/u/1", "https://user@avatars.githubusercontent.com/u/1", "https://avatars.githubusercontent.com:8443/u/1", "https://example.com/avatar"} {
		if _, err := parseProfile(Object{"displayName": "A", "source": "user", "avatarUrl": avatar}); err == nil {
			t.Fatalf("unsafe avatar accepted: %s", avatar)
		}
	}
	for _, name := range []string{"", " ", strings.Repeat("a", 81)} {
		if _, err := parseProfile(Object{"displayName": name, "source": "user"}); err == nil {
			t.Fatal("invalid display name accepted")
		}
	}
	for _, extra := range []Object{{"extra": 1}, {"role": "owner"}, {"jobRole": strings.Repeat("a", 81)}} {
		if _, err := parseProfile(merge(Object{"displayName": "A", "source": "user"}, extra)); err == nil {
			t.Fatalf("invalid profile field accepted: %v", extra)
		}
	}
	const photo = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII="
	profile, err = parseProfile(Object{"displayName": "Alex", "source": "user", "jobRole": " Designer ", "avatarData": photo})
	if err != nil || profile["jobRole"] != "Designer" {
		t.Fatalf("photo/job role rejected: %v", err)
	}
	large, _ := base64.StdEncoding.DecodeString(strings.TrimPrefix(photo, "data:image/png;base64,"))
	binary.BigEndian.PutUint32(large[16:20], 513)
	for _, value := range []string{"data:image/svg+xml;base64,PHN2Zy8+", "data:image/png;base64,aGVsbG8=", photo + "!", "https://example.test/photo", "data:image/png;base64," + base64.StdEncoding.EncodeToString(large)} {
		if validAvatarData(value) {
			t.Fatal("malformed or oversized photo accepted")
		}
	}
	if !validDigest(strings.Repeat("a", 64)) {
		t.Fatal("valid remote key rejected")
	}
	for _, key := range []string{"", strings.Repeat("A", 64), strings.Repeat("a", 63)} {
		if validDigest(key) {
			t.Fatal("invalid remote key accepted")
		}
	}
}
