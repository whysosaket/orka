import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("source_migration", Path(__file__).parents[1] / "scripts/migrate-project-sources.py")
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


class SourceMigrationTest(unittest.TestCase):
    def test_cache_from_before_drafts_were_introduced(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sync.sqlite"
            with sqlite3.connect(path) as db:
                db.executescript("CREATE TABLE projects(id TEXT PRIMARY KEY,value TEXT); CREATE TABLE cursors(project TEXT,cursor INTEGER); CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE resources(id TEXT PRIMARY KEY,project TEXT,value TEXT);")
                db.execute("INSERT INTO projects VALUES(?,?)", ("project", json.dumps({"id": "project", "name": "Product", "path": "/checkout"})))
                db.execute("INSERT INTO resources VALUES(?,?,?)", ("resource", "project", json.dumps({"resourceId": "resource", "kind": "memory", "logicalPath": "AGENTS.md"})))
            self.assertEqual(migration.migrate(path, True)[0], 1)
            with sqlite3.connect(path) as db:
                self.assertEqual(json.loads(db.execute("SELECT value FROM resources").fetchone()[0])["sourceId"], "project")
            self.assertEqual(migration.migrate(path, True)[0], 0)

    def test_dry_run_backup_scoped_queues_and_idempotence(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sync.sqlite"
            with sqlite3.connect(path) as db:
                db.executescript("CREATE TABLE projects(id TEXT PRIMARY KEY,value TEXT); CREATE TABLE cursors(project TEXT,cursor INTEGER); CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);")
                for table in ["resources", "bindings", "conflicts", "drafts", "outbox"]:
                    db.execute(f"CREATE TABLE {table}(id TEXT PRIMARY KEY,project TEXT,value TEXT" + (",error TEXT" if table == "outbox" else "") + ")")
                resource = {"resourceId": "resource", "kind": "memory", "logicalPath": "instructions/AGENTS.md"}
                db.execute("INSERT INTO projects VALUES(?,?)", ("project", json.dumps({"id": "project", "name": "Product", "path": "/example/checkout", "folderIdentity": "1:2", "sharing": {"memory": False}})))
                db.execute("INSERT INTO resources VALUES(?,?,?)", ("resource", "project", json.dumps(resource)))
                db.execute("INSERT INTO bindings VALUES(?,?,?)", ("resource", "project", json.dumps({"base": resource, "paths": ["/example/checkout/AGENTS.md"]})))
                db.execute("INSERT INTO drafts VALUES(?,?,?)", ("draft", "project", json.dumps({"resource": resource, "status": "proposed", "submission": {"resource": resource}})))
                db.execute("INSERT INTO drafts VALUES(?,?,?)", ("prepared", "project", json.dumps({"resource": resource, "status": "local", "requestId": "old-retry", "submission": {"resource": resource}})))
                db.execute("INSERT INTO outbox VALUES(?,?,?,?)", ("retry", "project", json.dumps({"id": "retry", "resource": resource}), "old error"))
                db.execute("INSERT INTO cursors VALUES('project',42)")
            self.assertEqual(migration.migrate(path), (1, None))
            with sqlite3.connect(path) as db:
                self.assertNotIn("sources", json.loads(db.execute("SELECT value FROM projects").fetchone()[0]))
            count, backup = migration.migrate(path, True)
            self.assertEqual(count, 1)
            self.assertTrue(backup.is_file())
            self.assertEqual(backup.stat().st_mode & 0o777, 0o600)
            with sqlite3.connect(path) as db:
                project = json.loads(db.execute("SELECT value FROM projects").fetchone()[0])
                self.assertNotIn("path", project)
                self.assertEqual(project["sources"][0]["id"], "project")
                self.assertEqual(project["sources"][0]["path"], "/example/checkout")
                self.assertFalse(project["sharing"]["memory"])
                queued = db.execute("SELECT id,value,error FROM outbox").fetchone()
                self.assertNotEqual(queued[0], "retry")
                self.assertEqual(json.loads(queued[1])["resource"]["sourceId"], "project")
                self.assertIsNone(queued[2])
                self.assertEqual(json.loads(db.execute("SELECT value FROM drafts").fetchone()[0])["status"], "local")
                prepared = json.loads(db.execute("SELECT value FROM drafts WHERE id='prepared'").fetchone()[0])
                self.assertIsNone(prepared["submission"])
                self.assertIsNone(prepared["requestId"])
                self.assertEqual(db.execute("SELECT count(*) FROM cursors").fetchone()[0], 0)
            self.assertEqual(migration.migrate(path, True)[0], 0)


if __name__ == "__main__":
    unittest.main()
