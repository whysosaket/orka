package server

import (
	"context"
	"io/fs"
	"sort"
	"strings"

	schema "github.com/whysosaket/orka-api/packages/server-core/migrations"
)

const InitialMigration = "001_initial.sql"

var LegacyMigrationNames = []string{"001_workspace.sql", "002_env.sql", "003_project_lifecycle.sql", "004_governance.sql", "005_management_logs.sql", "006_project_sources.sql", "007_mcp_oauth.sql", "008_onboarding.sql", "009_profile_details.sql", "010_role_policies.sql", "011_member_emails.sql"}

func legacySchemaError() error {
	return &HTTPError{Status: 500, Code: "ORKA_BASELINE_REQUIRED", Message: "This database does not use the current Orka baseline. A fully completed historical schema can be adopted with upgrade --reset-ledger; otherwise use a matching server version or a fresh database. Existing data and ledger were preserved."}
}
func (s *Store) Migrate(ctx context.Context, reset bool) error {
	return s.MigrateFS(ctx, reset, schema.Files)
}
func (s *Store) MigrateFS(ctx context.Context, reset bool, files fs.FS) error {
	entries, err := fs.ReadDir(files, ".")
	if err != nil {
		return err
	}
	names := []string{}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".sql") {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	if !includes(names, InitialMigration) {
		return &HTTPError{Status: 500, Message: "The initial Orka schema is missing from this server build."}
	}
	_, err = s.transaction(ctx, func(q *Queries) any {
		q.Exec("select pg_advisory_xact_lock(72651209)")
		q.Exec("create schema if not exists orka")
		q.Exec("create table if not exists orka.schema_migrations(name text primary key)")
		completed := []string{}
		for _, row := range q.Rows("select name from orka.schema_migrations") {
			completed = append(completed, text(row["name"]))
		}
		unknown := false
		for _, name := range completed {
			unknown = unknown || !includes(names, name)
		}
		if unknown {
			all := len(completed) == len(LegacyMigrationNames)
			for _, name := range LegacyMigrationNames {
				all = all && includes(completed, name)
			}
			installed := flag(q.One("select to_regclass('orka.projects') is not null as installed")["installed"])
			if !reset || !all || !installed {
				q.Check(legacySchemaError())
				return nil
			}
			q.Exec("delete from orka.schema_migrations")
			q.Exec("insert into orka.schema_migrations(name) values($1)", InitialMigration)
			completed = []string{InitialMigration}
		}
		if len(completed) == 0 && len(q.Rows("select 1 from pg_tables where schemaname='orka' and tablename <> 'schema_migrations' limit 1")) > 0 {
			q.Check(legacySchemaError())
			return nil
		}
		for _, name := range names {
			if includes(completed, name) {
				continue
			}
			sql, err := fs.ReadFile(files, name)
			if !q.Check(err) {
				return nil
			}
			q.Exec(string(sql))
			q.Exec("insert into orka.schema_migrations(name) values($1)", name)
		}
		return nil
	})
	return err
}
