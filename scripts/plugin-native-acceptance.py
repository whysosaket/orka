import argparse, base64, hashlib, http.server, json, os, pathlib, queue, sqlite3, subprocess, tempfile, threading, uuid, socket, struct, time, sys, signal, fcntl

parser = argparse.ArgumentParser(
    description="Exercise local Orka plugin operations with disposable native and HTTP fixtures."
)
parser.add_argument(
    "--binary",
    type=pathlib.Path,
    default=pathlib.Path(__file__).resolve().parents[1]
    / "apps/mac/src-tauri/target/debug/portable-workspace-mac",
)
parser.add_argument("--service-fixture", type=pathlib.Path)
options = parser.parse_args()
BINARY = pathlib.Path(
    os.environ.get("ORKA_CONNECTOR_NATIVE_BINARY", options.binary)
).resolve()
service_fixture = (
    json.loads(options.service_fixture.read_text()) if options.service_fixture else None
)
if not BINARY.is_file():
    parser.error("Build the debug Orka executable first, or pass --binary.")
uid, pid, rid, changeid, deviceid = [str(uuid.uuid4()) for _ in range(5)]
requests = []
blobs = {}
installation_mode = "allow"
skill = None
desktop_connector_capability = 1
if service_fixture:
    uid = service_fixture["accounts"][0]["id"]
    pid = service_fixture["projectId"]
active_user = uid
scopes = ["orka.read", "orka.write", "orka.manage"]


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
        if self.path == "/v2/connector/tools":
            name = body["name"]
            if name == "get_profile":
                result = {"accountId": active_user, "serviceOrigin": origin}
            elif name == "list_projects":
                result = {
                    "items": [{"id": pid, "name": "Native fixture", "role": "owner"}]
                }
            elif name == "list_skills":
                result = {"items": []}
            elif name == "review_request":
                content = base64.b64encode(b"x" * 1_000_000).decode()
                result = {
                    "request": {"id": body["arguments"]["requestId"]},
                    "files": [
                        {"path": name, "contentBase64": content}
                        for name in ["SKILL.md", "one.txt", "two.txt", "three.txt"]
                    ],
                    "previewHash": "a" * 64,
                }
            elif name == "create_memory":
                result = {"created": True}
            elif name == "update_permissions":
                result = {"updated": True}
            else:
                self.respond({"error": "Unexpected connector tool"}, 400)
                return
            self.respond(
                {
                    "content": [{"type": "text", "text": compact(result)}],
                    "structuredContent": result,
                }
            )
        elif self.path.startswith("/v2/blobs/"):
            digest = self.path.rsplit("/", 1)[1]
            if self.command == "PUT":
                assert hashlib.sha256(data).hexdigest() == digest
                blobs[digest] = data
                self.respond({})
            else:
                self.respond(blobs[digest], raw=True)
        elif self.path == "/v2/instance":
            self.respond({"desktopConnector": desktop_connector_capability})
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
origin = (
    service_fixture["serviceOrigin"]
    if service_fixture
    else f"http://127.0.0.1:{server.server_port}"
)
with tempfile.TemporaryDirectory(prefix="orka-plugin-native-") as temp:
    root = pathlib.Path(temp)
    home = root / "home"
    project = root / "project"
    home.mkdir()
    project.mkdir()
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
    bridges = []

    def native(value, allow_error=False):
        proc.stdin.write(compact(value) + "\n")
        proc.stdin.flush()
        response = json.loads(replies.get(timeout=50))
        if not allow_error:
            assert "error" not in response, response
        return response

    class Bridge:
        def __init__(self, name="Native fixture assistant", separate_parent=False):
            command = [str(BINARY), "--orka-plugin"]
            if separate_parent:
                command = [
                    sys.executable, "-c",
                    "import subprocess,sys;sys.exit(subprocess.call(sys.argv[1:]))",
                    *command,
                ]
            self.proc = subprocess.Popen(
                command,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env=env,
            )
            self.queue = queue.Queue()
            self.counter = 0
            self.killed = False
            bridges.append(self)
            threading.Thread(
                target=lambda: [self.queue.put(line) for line in self.proc.stdout],
                daemon=True,
            ).start()
            initialized = self.rpc(
                "initialize",
                {
                    "protocolVersion": "2025-03-26",
                    "clientInfo": {"name": name, "version": "1"},
                },
            )
            assert "error" not in initialized, initialized

        def rpc(self, method, params={}):
            self.counter += 1
            self.proc.stdin.write(
                compact(
                    {
                        "jsonrpc": "2.0",
                        "id": self.counter,
                        "method": method,
                        "params": params,
                    }
                )
                + "\n"
            )
            self.proc.stdin.flush()
            response = json.loads(self.queue.get(timeout=95))
            assert response["id"] == self.counter, response
            return response

        def tool(self, name, args={}, error=None):
            response = self.rpc("tools/call", {"name": name, "arguments": args})
            result = response.get("result", {})
            if error is not None:
                assert result.get("isError") is True, response
                text = result["content"][0]["text"]
                assert error in text, text
                return text
            assert "error" not in response and not result.get("isError"), response
            return result["structuredContent"]

        def close(self):
            if self.proc.poll() is None:
                self.proc.stdin.close()
                try:
                    self.proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
                    self.proc.wait()
                    raise
            assert self.proc.returncode == (-9 if self.killed else 0), self.proc.stderr.read()

        def kill(self):
            self.killed = True
            self.proc.kill()
            self.proc.wait(timeout=10)

    def approve(bridge, approved=scopes, operation="approve"):
        status = bridge.tool("get_connection_status")
        ident = status["connection"]["id"]
        pending = native({"action": "plugin-requests"})["value"]
        preview = next(p for p in pending if p["client"]["id"] == ident)
        preview = native(
            {
                "action": "plugin-authorization",
                "operation": "preview",
                "input": {"requestId": preview["requestId"]},
            }
        )["value"]
        assert (
            preview["account"]["id"] == active_user
            and preview["serviceOrigin"] == origin
        ), preview
        assert preview["scopes"] == scopes and "secret" not in compact(preview)
        result = native(
            {
                "action": "plugin-authorization",
                "operation": operation,
                "input": {"requestId": preview["requestId"], "scopes": approved},
            }
        )["value"]
        assert result == (
            {"approved": True} if operation == "approve" else {"cancelled": True}
        ), result
        assert native(
            {
                "action": "plugin-authorization",
                "operation": operation,
                "input": {"requestId": preview["requestId"]},
            },
        )["value"] is None
        return preview

    bridge = None

    def call(value, allow_error=False):
        if value["action"] != "plugin":
            return native(value, allow_error)
        response = bridge.rpc(
            "tools/call", {"name": value["tool"], "arguments": value["input"]}
        )["result"]
        if response.get("isError"):
            result = {"error": response["content"][0]["text"]}
            assert allow_error, result
            return result
        return {"value": response["structuredContent"]}

    if service_fixture:

        def seed(account):
            global active_user
            active_user = account["id"]
            session = {
                "user": {"id": account["id"], "email": account.get("email")},
                "access_token": account["accessToken"],
                "refresh_token": account["refreshToken"],
                "expires_at": int(time.time()) + 3600,
            }
            native(
                {
                    "action": "setup",
                    "url": origin,
                    "user": account["id"],
                    "projectId": pid,
                    "path": str(project),
                    "session": session,
                }
            )
            return session

        try:
            first, second = service_fixture["accounts"][:2]
            session = seed(first)
            native({"action": "plugin-start"})
            bridge = Bridge("Actual API read session")
            approve(bridge, ["orka.read"])
            assert bridge.tool("get_profile")["id"] == first["id"]
            assert any(p["id"] == pid for p in bridge.tool("list_projects")["items"])
            write = {
                "projectId": pid,
                "requestId": str(uuid.uuid4()),
                "title": "Desktop connector chain",
                "text": "Synthetic account-bound knowledge",
            }
            bridge.tool("create_memory", write, error="orka.write")
            writer = Bridge("Actual API write session")
            approve(writer, ["orka.read", "orka.write"])
            result = writer.tool("create_memory", write)
            assert result["status"] == "published", result
            assert writer.tool("create_memory", write) == result
            native({"action": "plugin-stop"})
            writer.tool("get_profile", error="unavailable")
            native({"action": "plugin-start"})
            assert writer.tool("get_profile")["id"] == first["id"]
            native({"action": "plugin-refresh", "session": session})
            assert writer.tool("get_profile")["id"] == first["id"]
            seed(second)
            writer.tool("get_profile", error="Reconnect")
            second_bridge = Bridge("Actual API second account")
            approve(second_bridge, ["orka.read"])
            assert second_bridge.tool("get_profile")["id"] == second["id"]
            assert any(
                p["id"] == pid for p in second_bridge.tool("list_projects")["items"]
            )
            writer.tool("get_profile", error="Reconnect")
            seed(first)
            third = Bridge("Actual API first account again")
            approve(third, ["orka.read"])
            assert third.tool("get_profile")["id"] == first["id"]
            writer.tool("get_profile", error="Reconnect")
            second_bridge.tool("get_profile", error="Reconnect")
            native({"action": "plugin-sign-out"})
            third.tool("get_profile", error="Reconnect")
            print(
                json.dumps(
                    {
                        "result": "passed",
                        "chain": "thin stdio MCP → real desktop Unix broker → actual API → actual GoTrue",
                        "coverage": [
                            "native account identity",
                            "project permissions",
                            "read scope blocks write",
                            "idempotent published memory",
                            "same-account refresh and broker restart",
                            "A→B→A and old session isolation",
                            "signout",
                        ],
                    }
                )
            )
        finally:
            for child in bridges:
                child.close()
            proc.stdin.close()
            proc.wait(timeout=10)
            assert proc.returncode == 0, proc.stderr.read()
            server.shutdown()
            server.server_close()
        raise SystemExit(0)
    conn = None
    try:
        setup = {
            "action": "setup",
            "url": origin,
            "user": uid,
            "projectId": pid,
            "path": str(project),
            "session": {
                "user": {"id": uid, "email": "native-fixture@example.test"},
                "access_token": "native-fixture-token",
                "refresh_token": "unused-native-fixture",
                "expires_at": 4102444800,
            },
        }
        native(setup)
        location = native({"action": "plugin-start"})["value"]["directory"]
        assert (pathlib.Path(location).stat().st_mode & 0o777) == 0o700
        assert (
            (pathlib.Path(location) / "broker.sock").stat().st_mode & 0o777
        ) == 0o600

        # Framing and local credentials cannot invoke native approval or access content.
        def ipc(value=None, raw=None):
            with socket.socket(socket.AF_UNIX) as channel:
                channel.settimeout(5)
                channel.connect(str(pathlib.Path(location) / "broker.sock"))
                data = compact(value).encode() if raw is None else raw
                channel.sendall(struct.pack(">I", len(data)) + data)
                length = struct.unpack(">I", channel.recv(4))[0]
                return json.loads(channel.recv(length))

        assert "error" in ipc(raw=b"not json")
        assert "error" in ipc(
            {
                "version": 1,
                "sessionId": str(uuid.uuid4()),
                "secret": "a" * 64,
                "operation": "call",
                "name": "get_profile",
                "arguments": {},
            }
        )
        assert "error" in ipc(
            {
                "version": 1,
                "sessionId": str(uuid.uuid4()),
                "secret": "a" * 64,
                "operation": "approve",
            }
        )
        # One host starts several helpers during discovery, chats and parallel work.
        # Consent belongs to that kernel-verified assistant, not each child or its label.
        worker = Bridge("Concurrent assistant")
        sibling = Bridge("Concurrent assistant")
        connection = worker.tool("get_connection_status")["connection"]["id"]
        assert sibling.tool("get_connection_status")["connection"]["id"] == connection, "helpers of one assistant must share one logical connection"
        pending = native({"action": "plugin-requests"})["value"]
        assert len(pending) == 1, pending
        approve(worker, ["orka.read"])
        assert sibling.tool("get_profile")["accountId"] == uid
        scope_error = sibling.tool("retry_sync", {"projectId": pid}, error="orka.write")
        assert "revoke its access" in scope_error, scope_error
        joined = Bridge("Concurrent assistant")
        assert joined.tool("get_profile")["accountId"] == uid
        status = native({"action": "plugin-status"})["value"]
        assert len(status["connections"]) == 1 and status["connections"][0]["sessionCount"] == 3, status
        worker.close()
        assert sibling.tool("get_profile")["accountId"] == uid

        # A matching client name or spoofed transport metadata is not an identity.
        independent = Bridge("Concurrent assistant", separate_parent=True)
        assert independent.tool("get_connection_status")["connection"]["id"] != connection
        independent.tool("get_profile", error="Approve")
        independent.close()
        fake_id, fake_secret = str(uuid.uuid4()), "f" * 64
        fake = {"version": 1, "sessionId": fake_id, "secret": fake_secret, "operation": "initialize", "clientName": "Concurrent assistant", "parentPid": os.getpid()}
        assert ipc(fake)["value"]["state"] == "pending"
        assert len(native({"action": "plugin-requests"})["value"]) == 1
        assert "value" in ipc(dict(fake, operation="close"))

        native({"action": "plugin-authorization", "operation": "revoke", "input": {"connectionId": connection}})
        sibling.tool("get_profile", error="Reconnect")
        joined.tool("get_profile", error="Reconnect")
        replacement = Bridge("Concurrent assistant")
        replacement.tool("get_profile", error="Approve")
        approve(replacement, ["orka.read", "orka.write"])
        replacement.tool("create_memory", {"projectId": pid, "requestId": str(uuid.uuid4()), "title": "Changed connector access", "text": "Synthetic scoped content"})
        sibling.tool("get_profile", error="Reconnect")
        replacement.close()
        mixed = native({"action": "plugin-status"})["value"]
        assert mixed["state"] == "reconnect_required" and mixed["reconnectRequired"] is True and "Reconnect" in mixed["reason"], mixed
        sibling.kill()
        joined.kill()
        status = native({"action": "plugin-status"})["value"]
        assert len(status["connections"]) == 1 and status["connections"][0]["state"] == "idle" and status["state"] == "not_linked", status
        assert status["reconnectRequired"] is False and "No active" in status["reason"], status
        resumed = Bridge("Concurrent assistant")
        assert resumed.tool("get_profile")["accountId"] == uid
        assert native({"action": "plugin-requests"})["value"] == []
        connection = resumed.tool("get_connection_status")["connection"]["id"]
        resumed.close()
        native({"action": "plugin-authorization", "operation": "revoke", "input": {"connectionId": connection}})
        assert native({"action": "plugin-status"})["value"]["connections"] == []

        orphan = Bridge("Abruptly exited assistant")
        approve(orphan)
        connection = orphan.tool("get_connection_status")["connection"]["id"]
        orphan.kill()
        status = native({"action": "plugin-status"})["value"]
        assert status["connections"][0]["state"] == "idle" and status["state"] == "not_linked", status
        assert native({"action": "plugin-requests"})["value"] == []
        native({"action": "plugin-authorization", "operation": "revoke", "input": {"connectionId": connection}})

        # Killing the assistant invalidates its approval even if its child survives.
        parent = Bridge("Exited assistant parent", separate_parent=True)
        approve(parent)
        helper_pid = int(subprocess.check_output(["pgrep", "-P", str(parent.proc.pid)], text=True).strip())
        try:
            parent.kill()
            parent.tool("get_profile", error="Reconnect")
            assert native({"action": "plugin-status"})["value"]["connections"] == []
        finally:
            parent.proc.stdin.close()
            try:
                os.kill(helper_pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        print("same-assistant concurrent/sequential consent, independent/spoofed parents, least scopes, grouped revoke, helper and parent exit cleanup passed")

        bridge = Bridge()
        listed = bridge.rpc("tools/list")
        assert "error" not in listed, listed
        catalog = listed["result"]["tools"]
        assert len(catalog) == 27 and len({t["name"] for t in catalog}) == 27
        assert all(
            "connectionProof" not in compact(t)
            and "accountId" not in t["inputSchema"]["properties"]
            for t in catalog
        )
        before = len(requests)
        bridge.tool("get_profile", error="Approve")
        assert len(requests) == before
        cancelled = Bridge("Denied session")
        approve(cancelled, operation="cancel")
        cancelled.tool("get_profile", error="denied")
        readonly = Bridge("Read-only session")
        approve(readonly, ["orka.read"])
        assert readonly.tool("get_profile")["accountId"] == uid
        before = len(requests)
        readonly.tool("retry_sync", {"projectId": pid}, error="orka.write")
        readonly.tool(
            "update_permissions",
            {
                "projectId": pid,
                "requestId": str(uuid.uuid4()),
                "expectedPolicyRevision": 0,
                "action": "policy",
            },
            error="orka.manage",
        )
        assert len(requests) == before
        approve(bridge)
        assert bridge.tool("get_profile")["accountId"] == uid
        assert bridge.tool("list_projects")["items"][0]["id"] == pid
        bridge.tool("list_skills", {"projectId": pid})
        bridge.tool("list_local_skills", {"projectId": pid})
        bridge.tool("list_local_resources", {"projectId": pid, "kind": "memory"})
        bridge.tool(
            "create_memory",
            {
                "projectId": pid,
                "requestId": str(uuid.uuid4()),
                "title": "Fixture",
                "text": "Synthetic knowledge",
            },
        )
        large = bridge.tool(
            "review_request", {"projectId": pid, "requestId": str(uuid.uuid4())}
        )
        assert (
            sum(len(base64.b64decode(file["contentBase64"])) for file in large["files"])
            == 4_000_000
        )
        bridge.tool(
            "update_permissions",
            {
                "projectId": pid,
                "requestId": str(uuid.uuid4()),
                "expectedPolicyRevision": 0,
                "action": "policy",
            },
        )
        # Broker restart retains this exact session for the same unchanged account.
        native({"action": "plugin-stop"})
        bridge.tool("get_profile", error="unavailable")
        assert not (pathlib.Path(location) / "broker.sock").exists()
        native({"action": "plugin-start"})
        assert bridge.tool("get_profile")["accountId"] == uid
        native({"action": "plugin-refresh", "session": setup["session"]})
        assert bridge.tool("get_profile")["accountId"] == uid
        account_db = None
        for candidate in home.rglob("sync.sqlite"):
            check = sqlite3.connect(candidate)
            exists = check.execute(
                "SELECT count(*) FROM projects WHERE id=?", (pid,)
            ).fetchone()[0]
            check.close()
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
        binding = {"projectId": pid}
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

        # An account switch cannot redirect an old approved session or a displayed pending preview.
        pending_bridge = Bridge("Pending before account switch")
        assert pending_bridge.tool("get_connection_status")["state"] == "pending"
        pending = native({"action": "plugin-requests"})["value"][0]
        other = dict(setup, user=str(uuid.uuid4()))
        other["session"] = dict(setup["session"], user={"id": other["user"]})
        active_user = other["user"]
        native(other)
        before = len(requests)
        bridge.tool("get_profile", error="Reconnect")
        assert len(requests) == before
        native(setup)
        active_user = uid
        assert native(
            {
                "action": "plugin-authorization",
                "operation": "approve",
                "input": {"requestId": pending["requestId"]},
            },
        )["value"] is None
        fresh = Bridge("Fresh approved session")
        approve(fresh)
        assert fresh.tool("get_profile")["accountId"] == uid
        bridge.tool("get_profile", error="Reconnect")
        pending_bridge.tool("get_profile", error="Reconnect")
        native({"action": "plugin-sign-out"})
        signedout = Bridge("Signed-out session")
        assert signedout.tool("get_connection_status")["state"] == "signed_out"
        signedout.tool("get_profile", error="Sign in")
        native(setup)
        signedout.tool("get_profile", error="Reconnect")
        after_signin = Bridge("Signed in again")
        approve(after_signin)
        assert after_signin.tool("get_profile")["accountId"] == uid
        alternate = dict(setup, url=origin + "/other")
        native(alternate)
        native(setup)
        after_signin.tool("get_profile", error="Reconnect")
        revoked = Bridge("Revoked session")
        approve(revoked)
        ident = revoked.tool("get_connection_status")["connection"]["id"]
        native(
            {
                "action": "plugin-authorization",
                "operation": "revoke",
                "input": {"connectionId": ident},
            }
        )
        revoked.tool("get_profile", error="Reconnect")
        native(setup)
        old_service = Bridge("Older API service")
        approve(old_service)
        desktop_connector_capability = 0
        old_service.tool("get_profile", error="Upgrade your Orka service")
        desktop_connector_capability = 1
        assert old_service.tool("get_profile")["accountId"] == uid
        state = (home / "orka/plugin-connection.json").read_text()
        assert "native-fixture-token" not in state and "access_token" not in state
        # Explicit Quit / unavailable app never triggers an idle bridge relaunch.
        native({"action": "plugin-stop"})
        revoked.tool("get_profile", error="unavailable")
        time.sleep(0.3)
        assert not (pathlib.Path(location) / "broker.sock").exists()
        # Discovery succeeds with Orka closed and never launches it.
        unavailable = Bridge("Unavailable desktop")
        listed = unavailable.rpc("tools/list")
        assert len(listed["result"]["tools"]) == 27, listed
        assert unavailable.tool("get_connection_status")["state"] == "unavailable"
        assert not (pathlib.Path(location) / "broker.sock").exists()
        native({"action": "plugin-start"})
        # The idle helper retries when Orka returns, without needing a tool call.
        deadline = time.monotonic() + 8
        while not native({"action": "plugin-requests"})["value"]:
            assert time.monotonic() < deadline, "startup registration did not recover"
            time.sleep(0.05)
        assert unavailable.tool("get_connection_status")["state"] == "pending"
        approve(unavailable)
        assert unavailable.tool("get_profile")["accountId"] == uid
        unavailable.close()
        with (home / "orka/workspace.lock").open("rb") as workspace_lock:
            fcntl.flock(workspace_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            busy = Bridge("Busy desktop")
            assert len(busy.rpc("tools/list")["result"]["tools"]) == 27
            assert busy.tool("get_connection_status")["state"] == "busy"
        deadline = time.monotonic() + 8
        while not native({"action": "plugin-requests"})["value"]:
            assert time.monotonic() < deadline, "background registration did not recover"
            time.sleep(0.05)
        assert busy.tool("get_connection_status")["state"] == "pending"
        busy.close()
        native({"action": "plugin-stop"})
        print(
            json.dumps(
                {
                    "result": "passed",
                    "transport": "real desktop-owned Unix broker + thin MCP stdio bridge; peer UID, private socket, bounded malformed input and unknown credential denial",
                    "consent": "pending, denial, exact preview replay, read/write/manage scopes, revocation and signed-out handling",
                    "isolation": "same-account refresh and broker restart retained; A→B→A, service roundtrip, signout and new session grants never revive old sessions",
                    "operations": "shared native JWT reads/writes plus exact queued retry/materialization and complete freshly-authorized skill installation",
                    "requests": len(requests),
                },
                indent=2,
            )
        )
    finally:
        if conn is not None:
            conn.close()
        for child in bridges:
            child.close()
        proc.stdin.close()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
            raise
        errors = proc.stderr.read()
        assert proc.returncode == 0, errors
        if errors:
            print(errors)
server.shutdown()
server.server_close()
