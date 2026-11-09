// Package migrations embeds the existing SQL lineage in every server binary.
package migrations

import "embed"

//go:embed *.sql
var Files embed.FS
