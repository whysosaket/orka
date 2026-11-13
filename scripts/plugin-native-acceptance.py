import argparse, hashlib, http.server, json, os, pathlib, queue, sqlite3, subprocess, tempfile, threading, uuid

parser = argparse.ArgumentParser(
    description="Exercise local Orka plugin operations with disposable native and HTTP fixtures."
)
parser.add_argument(
    "--binary",
    type=pathlib.Path,
    default=pathlib.Path(__file__).resolve().parents[1]
    / "apps/mac/src-tauri/target/debug/portable-workspace-mac",
)
BINARY = parser.parse_args().binary.resolve()
if not BINARY.is_file():
    parser.error("Build the debug Orka executable first, or pass --binary.")
uid, pid, rid, changeid, deviceid = [str(uuid.uuid4()) for _ in range(5)]
requests = []
blobs = {}
installation_mode = "allow"
skill = None


def compact(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def blob(data, path, executable=False):
    digest = hashlib.sha256(data).hexdigest()
    blobs[digest] = data
    return {"path": path, "hash": digest, "size": len(data), "executable": executable}


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def respond(self, value, status=200, raw=False):
        body = value if raw else compact(value).encode()
        self.send_response(status)
        self.send_header(
            "Content-Type", "application/octet-stream" if raw else "application/json"
        )
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def handle_call(self):
        data = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        body = (
            json.loads(data)
            if data
            and self.headers.get("Content-Type", "").startswith("application/json")
            else data
        )
        requests.append((self.command, self.path, body))
        assert self.headers.get("Authorization") == "Bearer native-fixture-token"
        if self.path.startswith("/v2/blobs/"):
            digest = self.path.rsplit("/", 1)[1]
            if self.command == "PUT":
                assert hashlib.sha256(data).hexdigest() == digest
                blobs[digest] = data
                self.respond({})
            else:
                self.respond(blobs[digest], raw=True)
        elif self.path == "/v2/projects/capabilities":
            self.respond({"deviceHardware": 0, "selectedSharing": 1})
        elif self.path == "/v2/devices":
            self.respond([] if self.command == "GET" else {})
        elif self.path.startswith("/v2/projects?"):
            self.respond(
                [
                    {
                        "id": pid,
                        "name": "Native fixture",
                        "role": "owner",
                        "governed": False,
                        "policyRevision": 0,
                        "lifecycleRevision": 0,
                    }
                ]
            )
        elif self.path == "/v2/sync/push":
            assert body["id"] == changeid
            resource = dict(
                body["resource"],
                projectId=pid,
                revision=1,
                owner=uid,
                updatedBy=uid,
                updatedAt="2026-11-13T00:00:00Z",
            )
            self.respond(
                {"conflict": False, "event": {"resource": resource, "conflicts": []}}
            )
        elif self.path.startswith("/v2/sync/pull?"):
            self.respond(
                {
                    "events": [],
                    "cursor": 1,
                    "hasMore": False,
                    "reset": False,
                    "policyRevision": 0,
                    "requests": [],
                    "presence": [],
                }
            )
        elif self.path == "/v2/governance/action" and body["action"] == "installation":
            assert body["input"]["resourceId"] == skill["resourceId"]
            if installation_mode == "deny":
                self.respond({"error": "Access removed"}, 403)
            elif installation_mode == "stale":
                self.respond({"error": "Resource revision changed"}, 409)
            else:
                assert body["input"]["expectedRevision"] == skill["revision"]
                self.respond({"resource": skill, "access": {"canRead": True}})
        else:
            self.respond({"error": "Unexpected fixture route: " + self.path}, 500)

    do_GET = do_POST = do_PUT = handle_call


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
origin = f"http://127.0.0.1:{server.server_port}"
with tempfile.TemporaryDirectory(prefix="orka-plugin-native-") as temp:
    root = pathlib.Path(temp)
    home = root / "home"
    project = root / "project"
    project.mkdir()
    home.mkdir()
    env = dict(
        os.environ,
        ORKA_TEST_HOME=str(home),
        CODEX_HOME=str(home / ".codex"),
        CLAUDE_CONFIG_DIR=str(home / ".claude"),
    )
    proc = subprocess.Popen(
        [str(BINARY), "--orka-env-test"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
    )
    replies = queue.Queue()
    threading.Thread(
        target=lambda: [replies.put(line) for line in proc.stdout], daemon=True
    ).start()

    def call(value, allow_error=False):
        proc.stdin.write(compact(value) + "\n")
        proc.stdin.flush()
        response = json.loads(replies.get(timeout=40))
        if not allow_error:
            assert "error" not in response, response
        return response

    conn = None
    try:
        call(
            {
                "action": "setup",
                "url": origin,
                "user": uid,
                "projectId": pid,
                "path": str(project),
                "session": {
                    "user": {"id": uid},
                    "access_token": "native-fixture-token",
                    "refresh_token": "unused-native-fixture",
                    "expires_at": 4102444800,
                },
            }
        )
        account_db = None
        for candidate in home.rglob("sync.sqlite"):
            conn = sqlite3.connect(candidate)
            exists = conn.execute(
                "SELECT count(*) FROM projects WHERE id=?", (pid,)
            ).fetchone()[0]
            conn.close()
            if exists:
                account_db = candidate
        assert account_db
        conn = sqlite3.connect(account_db)
        file = blob(b"Original pending knowledge\n", "content.md")
        resource = {
            "resourceId": rid,
            "kind": "memory",
            "source": "shared",
            "logicalPath": "instructions/PLUGIN-RETRY.md",
            "title": "Retry fixture",
            "files": [file],
            "deleted": False,
        }
        change = {
            "version": 2,
            "id": changeid,
            "projectId": pid,
            "deviceId": deviceid,
            "baseRevision": 0,
            "resource": resource,
        }
        original = compact(change)
        conn.execute(
            "INSERT INTO outbox VALUES(?,?,?,?,?)",
            (
                changeid,
                pid,
                "/v2/sync/push",
                original,
                "503: fixture transient failure",
            ),
        )
        conn.commit()
        blob_dir = home / "orka" / "blobs"
        blob_dir.mkdir(exist_ok=True)
        (blob_dir / file["hash"]).write_bytes(blobs[file["hash"]])
        binding = {"accountId": uid, "serviceOrigin": origin, "projectId": pid}
        response = call({"action": "plugin", "tool": "retry_sync", "input": binding})[
            "value"
        ]
        assert response["status"] == "completed", response
        assert response["after"]["queuedCount"] == 0, response
        assert (
            project / "PLUGIN-RETRY.md"
        ).read_bytes() == b"Original pending knowledge\n"
        sent = [body for method, path, body in requests if path == "/v2/sync/push"]
        assert len(sent) == 1 and compact(sent[0]) == original
        assert conn.execute("SELECT count(*) FROM outbox").fetchone()[0] == 0
        assert (
            conn.execute(
                "SELECT value FROM meta WHERE key='syncHandledRequest'"
            ).fetchone()
            is None
        )
        # The accepted package is intentionally absent from the local resource cache.
        files = [
            blob(
                b"---\nname: installed-example\ndescription: Native fixture\n---\nComplete skill.\n",
                "SKILL.md",
            ),
            blob(b"#!/bin/sh\nexit 0\n", "scripts/run.sh", True),
        ]
        skill = {
            "resourceId": str(uuid.uuid4()),
            "projectId": pid,
            "kind": "skill",
            "source": "shared",
            "logicalPath": "installed-example",
            "title": "Install fixture",
            "files": files,
            "revision": 3,
            "deleted": False,
        }
        expected = hashlib.sha256(compact(files).encode()).hexdigest()
        install = dict(
            binding,
            skillId=skill["resourceId"],
            origin="shared",
            target="project",
            snapshotHash=expected,
            expectedRevision=3,
        )
        installed = call(
            {"action": "plugin", "tool": "install_skill", "input": install}
        )["value"]
        assert installed["status"] == "installed", installed
        for folder in [
            ".agents/skills/installed-example",
            ".claude/skills/installed-example",
        ]:
            directory = project / folder
            for file in files:
                target = directory / file["path"]
                assert target.read_bytes() == blobs[file["hash"]]
                assert bool(target.stat().st_mode & 0o111) == file["executable"]
        before_downloads = len(
            [
                1
                for method, path, _ in requests
                if method == "GET" and path.startswith("/v2/blobs/")
            ]
        )
        for mode in ["deny", "stale"]:
            installation_mode = mode
            denied = call(
                {"action": "plugin", "tool": "install_skill", "input": install},
                allow_error=True,
            )
            assert "error" in denied, denied
            assert ("403:" if mode == "deny" else "409:") in denied["error"], denied
        after_downloads = len(
            [
                1
                for method, path, _ in requests
                if method == "GET" and path.startswith("/v2/blobs/")
            ]
        )
        assert before_downloads == after_downloads
        assert (
            len(
                [
                    1
                    for _, path, body in requests
                    if path == "/v2/governance/action"
                    and body["action"] == "installation"
                ]
            )
            == 3
        )
        print(
            json.dumps(
                {
                    "result": "passed",
                    "retry": "original request ID and exact payload uploaded once, acknowledged, materialized, queue empty",
                    "install": "fresh authorized complete uncached shared package installed to both project mirrors with executable modes",
                    "freshPermissionChecks": "403 denial and409 stale revision prevented further downloads/writes",
                    "transport": "real native stdio child and loopback HTTP fixture; in-memory test Keychain and disposable agent homes",
                    "requests": len(requests),
                },
                indent=2,
            )
        )
    finally:
        if conn is not None:
            conn.close()
        proc.stdin.close()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
            raise
        assert proc.returncode == 0, proc.stderr.read()
server.shutdown()
server.server_close()
