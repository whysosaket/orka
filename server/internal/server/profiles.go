package server

import (
	"bytes"
	"compress/zlib"
	"encoding/base64"
	"encoding/binary"
	"hash/crc32"
	"io"
	"net/url"
	"strings"
)

const profileColumns = `display_name as "displayName",job_role as "jobRole",avatar_url as "avatarUrl",avatar_data as "avatarData",source,updated_at as "updatedAt",updated_at::text as revision`

func validAvatarData(value string) bool {
	const prefix = "data:image/png;base64,"
	if !strings.HasPrefix(value, prefix) {
		return false
	}
	encoded := strings.TrimPrefix(value, prefix)
	data, err := base64.StdEncoding.Strict().DecodeString(encoded)
	if err != nil || len(data) < 33 || len(data) > 524288 || base64.StdEncoding.EncodeToString(data) != encoded {
		return false
	}
	if !bytes.Equal(data[:8], []byte{137, 80, 78, 71, 13, 10, 26, 10}) || binary.BigEndian.Uint32(data[8:12]) != 13 || string(data[12:16]) != "IHDR" {
		return false
	}
	width, height := int(binary.BigEndian.Uint32(data[16:20])), int(binary.BigEndian.Uint32(data[20:24]))
	if width == 0 || height == 0 || width > 512 || height > 512 {
		return false
	}
	channels := map[byte]int{0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[data[25]]
	if data[24] != 8 || channels == 0 || data[26] != 0 || data[27] != 0 || data[28] != 0 {
		return false
	}
	compressed := []byte{}
	offset := 8
	ended := false
	for offset+12 <= len(data) {
		length := int(binary.BigEndian.Uint32(data[offset : offset+4]))
		end := offset + 8 + length
		if end+4 > len(data) || crc32.ChecksumIEEE(data[offset+4:end]) != binary.BigEndian.Uint32(data[end:end+4]) {
			return false
		}
		kind := string(data[offset+4 : offset+8])
		if kind == "IDAT" {
			compressed = append(compressed, data[offset+8:end]...)
		}
		offset = end + 4
		if kind == "IEND" {
			ended = length == 0 && offset == len(data)
			break
		}
	}
	if !ended || len(compressed) == 0 {
		return false
	}
	reader, err := zlib.NewReader(bytes.NewReader(compressed))
	if err != nil {
		return false
	}
	defer reader.Close()
	row := width*channels + 1
	decoded, err := io.ReadAll(io.LimitReader(reader, int64(row*height+1)))
	if err != nil || len(decoded) != row*height {
		return false
	}
	for y := 0; y < height; y++ {
		if decoded[y*row] > 4 {
			return false
		}
	}
	return true
}
func parseProfile(raw any) (Object, error) {
	input, err := parseObject(raw, map[string]Field{"displayName": trimmed(strField(1, 80)), "avatarUrl": optional(nullable(strField(0, 2048))), "jobRole": optional(nullable(trimmed(strField(0, 80)))), "avatarData": optional(nullable(strField(0, 700000))), "source": enumField("github", "email", "user"), "ifAbsent": optional(boolField()), "expectedRevision": optional(strField(1, 64))})
	if err != nil {
		return nil, err
	}
	if value := input["avatarUrl"]; value != nil {
		u, err := url.Parse(text(value))
		if err != nil || u.Scheme != "https" || u.Hostname() != "avatars.githubusercontent.com" || u.User != nil || u.Port() != "" || !strings.HasPrefix(text(value), "https://avatars.githubusercontent.com/") {
			return nil, bad("Invalid request")
		}
	}
	if value := input["avatarData"]; value != nil && !validAvatarData(text(value)) {
		return nil, bad("Invalid request")
	}
	return input, nil
}
func (s *Store) getProfile(q *Queries, user string) Object {
	row := q.One("select "+profileColumns+" from orka.profiles where user_id=$1", user)
	q.Require(row != nil, 404, "Profile not set up yet")
	return row
}
func (s *Store) putProfile(q *Queries, user string, input Object) Object {
	if expected, exists := input["expectedRevision"]; exists {
		current := q.One("select updated_at::text as revision from orka.profiles where user_id=$1 for update", user)
		if !q.Require(!flag(input["ifAbsent"]) && current["revision"] == expected, 409, "Profile changed; review the latest values") {
			return nil
		}
	}
	conflict := "do nothing"
	args := []any{user, input["displayName"], input["avatarUrl"], input["source"], input["jobRole"], input["avatarData"]}
	if !flag(input["ifAbsent"]) {
		conflict = "do update set display_name=excluded.display_name,avatar_url=excluded.avatar_url,source=excluded.source,job_role=case when $7 then excluded.job_role else orka.profiles.job_role end,avatar_data=case when $8 then excluded.avatar_data else orka.profiles.avatar_data end,updated_at=now()"
		_, job := input["jobRole"]
		_, photo := input["avatarData"]
		args = append(args, job, photo)
	}
	profile := q.One("insert into orka.profiles(user_id,display_name,avatar_url,source,job_role,avatar_data) values($1,$2,$3,$4,$5,$6) on conflict(user_id) "+conflict+" returning "+profileColumns, args...)
	if profile == nil {
		profile = q.One("select "+profileColumns+" from orka.profiles where user_id=$1", user)
	}
	q.Exec("insert into orka.env_profiles(user_id,label) values($1,$2) on conflict(user_id) do update set label=excluded.label", user, profile["displayName"])
	return profile
}
