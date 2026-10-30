#!/usr/bin/env python3
"""Migrate one signed-out Orka account/service SQLite cache to source folders."""
import argparse
import datetime
import json
from pathlib import Path
import sqlite3
import uuid


def scope_resources(value, source_id):
    if isinstance(value, list):
        return [scope_resources(item, source_id) for item in value]
    if not isinstance(value, dict):
        return value
    result = {key: scope_resources(item, source_id) for key, item in value.items()}
    if {"resourceId", "kind", "logicalPath"}.issubset(result):
        result.setdefault("sourceId", source_id)
    return result


def migrate(database, apply=False):
    database = Path(database).resolve(strict=True)
    with sqlite3.connect(f"file:{database}?mode={'rw' if apply else 'ro'}", uri=True) as db:
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        projects = [(project_id, json.loads(raw)) for project_id, raw in db.execute("SELECT id,value FROM projects")]
        pending = [(project_id, project) for project_id, project in projects if not isinstance(project.get("sources"), list)]
        if not apply:
            return len(pending), None
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        backup = database.with_name(database.name + f".before-sources-{stamp}.bak")
        with sqlite3.connect(backup) as destination:
            db.backup(destination)
        backup.chmod(0o600)
        db.execute("BEGIN IMMEDIATE")
        for project_id, project in pending:
            source = {"id": project_id, "name": project["name"], "path": project.pop("path", None), "folderIdentity": project.pop("folderIdentity", None)}
            project["sources"] = [source]
            db.execute("UPDATE projects SET value=? WHERE id=?", (json.dumps(project), project_id))
            for table in ["resources", "bindings", "conflicts", "drafts", "outbox"]:
                if table not in tables:
                    continue
                for row_id, raw in db.execute(f"SELECT id,value FROM {table} WHERE project=?", (project_id,)).fetchall():
                    value = scope_resources(json.loads(raw), project_id)
                    if table == "drafts" and value.get("status") in ("local", "proposed"):
                        value.update(status="local", requestId=None, submission=None, request=None)
                    if table == "outbox" and isinstance(value, dict) and "resource" in value:
                        # A changed request body needs a fresh retry identity.
                        next_id = str(uuid.uuid4())
                        value["id"] = next_id
                        db.execute("UPDATE outbox SET id=?,value=?,error=NULL WHERE id=?", (next_id, json.dumps(value), row_id))
                    else:
                        db.execute(f"UPDATE {table} SET value=? WHERE id=?", (json.dumps(value), row_id))
            db.execute("DELETE FROM cursors WHERE project=?", (project_id,))
            db.execute("DELETE FROM meta WHERE key IN (?,?,?,?)", (f"governance:{project_id}", f"requests:{project_id}", f"contextToken:{project_id}", f"exposedSources:{project_id}"))
        db.commit()
        return len(pending), backup


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", required=True, help="Account/service SQLite database; stop Orka and its daemon first")
    parser.add_argument("--apply", action="store_true", help="Back up the database and apply the migration")
    args = parser.parse_args()
    count, backup = migrate(args.database, args.apply)
    print(f"{count} projects {'migrated' if args.apply else 'need migration (dry run)' }.")
    if backup:
        print(f"Backup: {backup}")
