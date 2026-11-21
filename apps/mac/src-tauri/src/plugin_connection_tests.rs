use super::*;
use crate::{
    plugin_connection::{self, Binding},
    plugin_process::{AssistantApp, Peer, ProcessIdentity},
};
use uuid::Uuid;

#[test]
fn plugin_generation_survives_restarts_and_invalidates_account_and_service_roundtrips() {
    let f = Fixture::new();
    let first = plugin_connection::generation().unwrap();
    assert_eq!(first, plugin_connection::generation().unwrap());
    db::set(
        &f.db,
        "config",
        &json!({"apiUrl":"https://first.example","syncMinutes":15}),
    )
    .unwrap();
    let initial = plugin_connection::generation().unwrap();
    assert_ne!(first, initial);
    db::set(
        &f.db,
        "config",
        &json!({"apiUrl":"https://first.example","syncMinutes":30}),
    )
    .unwrap();
    assert_eq!(initial, plugin_connection::generation().unwrap());
    db::set(&f.db, "config", &json!({"apiUrl":"https://second.example"})).unwrap();
    db::set(&f.db, "config", &json!({"apiUrl":"https://first.example"})).unwrap();
    assert_ne!(initial, plugin_connection::generation().unwrap());
    let a = Uuid::new_v4().to_string();
    let b = Uuid::new_v4().to_string();
    db::profile(&a).unwrap();
    let selected = plugin_connection::generation().unwrap();
    db::profile(&a).unwrap();
    assert_eq!(selected, plugin_connection::generation().unwrap());
    db::profile(&b).unwrap();
    db::profile(&a).unwrap();
    assert_ne!(selected, plugin_connection::generation().unwrap());
    let current = plugin_connection::generation().unwrap();
    db::guest().unwrap();
    db::profile(&a).unwrap();
    assert_ne!(current, plugin_connection::generation().unwrap());
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        fs::metadata(db::root().unwrap().join("plugin-connection.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}

#[test]
fn browser_plugin_handoffs_cannot_grant_desktop_access() {
    let _f = Fixture::new();
    let callback="orka://mcp/authorize?handoff=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&service=https://api.example";
    assert!(plugin_connection::callback(callback)
        .unwrap_err()
        .contains("no longer supported"));
    assert!(crate::profiles::route_plugin_callback(callback.into()).is_err());
}

#[test]
fn connector_transport_rejects_unregistered_secrets_and_unsafe_directories() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let _f = Fixture::new();
    let broker = crate::plugin_broker::start().unwrap();
    let directory = crate::plugin_broker::directory().unwrap();
    assert_eq!(
        fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(directory.join("broker.sock"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    let request = json!({"version":1,"sessionId":Uuid::new_v4().to_string(),"secret":"a".repeat(64),"operation":"call","name":"get_connection_status","arguments":{}});
    assert!(crate::plugin_broker::exchange(&request)
        .unwrap_err()
        .contains("Reconnect"));
    let mut invalid = request.clone();
    invalid["operation"] = json!("approve");
    assert!(crate::plugin_broker::exchange(&invalid)
        .unwrap_err()
        .contains("Unknown"));
    drop(broker);
    fs::remove_dir_all(&directory).unwrap();
    let other = _f._home.path().join("other");
    fs::create_dir(&other).unwrap();
    symlink(&other, &directory).unwrap();
    assert!(crate::plugin_broker::start().is_err());
    fs::remove_file(&directory).unwrap();
}

#[test]
fn plugin_operations_recheck_generation_inside_their_own_workspace_locks() {
    let f = Fixture::new();
    db::set(&f.db, "config", &json!({"apiUrl":"https://plugin.example"})).unwrap();
    let binding = Binding::current().unwrap();
    let request = json!({"accountId":binding.account_id,"serviceOrigin":binding.service_origin,"projectId":f.project["id"]});
    plugin_connection::invalidate("Test account changed after proof verification").unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    for action in [
        "list_skills",
        "install_skill",
        "get_sync_status",
        "retry_sync",
        "repair_sync",
    ] {
        assert_eq!(
            runtime
                .block_on(crate::plugin_operations::command(
                    action,
                    &request,
                    Some(&binding)
                ))
                .unwrap_err(),
            plugin_connection::RECONNECT
        );
    }
    for action in ["list_local_resources", "preview_share", "share_selected"] {
        assert_eq!(
            runtime
                .block_on(crate::selective_sharing::plugin_command(
                    action, &request, &binding
                ))
                .unwrap_err(),
            plugin_connection::RECONNECT
        );
    }
    assert_eq!(
        runtime
            .block_on(sync::plugin_once_bound(
                &binding.account_id,
                &binding.service_origin,
                f.project["id"].as_str().unwrap(),
                Some(&binding)
            ))
            .unwrap_err(),
        plugin_connection::RECONNECT
    );
    assert!(f.outbox().is_empty());
    assert!(db::rows(&f.db, "SELECT value FROM local_resources", &[])
        .unwrap()
        .is_empty());
}

#[test]
fn connector_binding_rechecks_individual_revocation_inside_operation_locks() {
    let f = Fixture::new();
    db::set(&f.db, "config", &json!({"apiUrl":"https://plugin.example"})).unwrap();
    let mut binding = Binding::current().unwrap();
    let id = Uuid::new_v4().to_string();
    let path = db::root().unwrap().join("plugin-connection.json");
    let mut state: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    state["sessions"][&id] =
        json!({"state":"approved","binding":{"generation":binding.generation}});
    db::atomic(&path, state.to_string().as_bytes()).unwrap();
    binding.session_id = Some(id.clone());
    binding.check_current().unwrap();
    state["sessions"][&id]["state"] = json!("reconnect_required");
    db::atomic(&path, state.to_string().as_bytes()).unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let input = json!({"accountId":binding.account_id,"serviceOrigin":binding.service_origin,"projectId":f.project["id"]});
    assert_eq!(
        runtime
            .block_on(crate::plugin_operations::command(
                "get_sync_status",
                &input,
                Some(&binding)
            ))
            .unwrap_err(),
        plugin_connection::RECONNECT
    );
    assert_eq!(
        runtime
            .block_on(crate::selective_sharing::plugin_command(
                "preview_share",
                &input,
                &binding
            ))
            .unwrap_err(),
        plugin_connection::RECONNECT
    );
    assert!(f.outbox().is_empty());
}

#[test]
fn connector_history_is_bounded_and_expired_pending_requests_require_reconnect() {
    let f = Fixture::new();
    db::set(&f.db, "config", &json!({"apiUrl":"https://plugin.example"})).unwrap();
    let generation = plugin_connection::generation().unwrap();
    let path = db::root().unwrap().join("plugin-connection.json");
    let mut state: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    let first = Uuid::new_v4().to_string();
    for i in 0..512 {
        let id = if i == 0 {
            first.clone()
        } else {
            Uuid::new_v4().to_string()
        };
        state["sessions"][&id] = json!({"id":id,"state":"pending","createdAt":i,"expiresAt":"2000-01-01T00:00:00Z","binding":{"generation":generation}});
    }
    db::atomic(&path, state.to_string().as_bytes()).unwrap();
    let status = plugin_connection::plugin_connection_status().unwrap();
    assert_eq!(status["pendingCount"], 0);
    assert!(status["connections"]
        .as_array()
        .unwrap()
        .iter()
        .all(|v| v["state"] == "reconnect_required"));
    assert_eq!(
        plugin_connection::plugin_connection_requests().unwrap(),
        json!([])
    );
    plugin_connection::initialize_session(
        &Uuid::new_v4().to_string(),
        &"a".repeat(64),
        "A fresh connector",
        &crate::plugin_process::Peer {
            helper: crate::plugin_process::ProcessIdentity::read(std::process::id())
                .unwrap()
                .0,
            assistant: crate::plugin_process::ProcessIdentity::read(std::process::id())
                .unwrap()
                .0,
        },
        None,
    )
    .unwrap();
    let bounded: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(bounded["sessions"].as_object().unwrap().len(), 512);
    assert!(bounded["sessions"][first].is_null());
}

#[test]
fn legacy_approvals_are_not_reported_live_until_their_secret_identifies_a_real_helper() {
    let f = Fixture::new();
    db::set(&f.db, "config", &json!({"apiUrl":"https://plugin.example"})).unwrap();
    let binding = Binding::current().unwrap();
    let id = Uuid::new_v4().to_string();
    let secret = "b".repeat(64);
    let path = db::root().unwrap().join("plugin-connection.json");
    let mut state: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    state["sessions"][&id] = json!({"id":id,"client":{"id":id,"name":"Legacy assistant"},"state":"approved","secretHash":db::digest(secret.as_bytes()),"binding":binding,"scopes":["orka.read"]});
    db::atomic(&path, state.to_string().as_bytes()).unwrap();
    assert_eq!(
        plugin_connection::plugin_connection_status().unwrap()["connections"],
        json!([])
    );
    let identity = crate::plugin_process::ProcessIdentity::read(std::process::id())
        .unwrap()
        .0;
    let peer = crate::plugin_process::Peer {
        helper: identity.clone(),
        assistant: identity,
    };
    assert!(plugin_connection::identify_session(&id, &"c".repeat(64), &peer).is_err());
    plugin_connection::identify_session(&id, &secret, &peer).unwrap();
    let live = plugin_connection::plugin_connection_status().unwrap();
    assert_eq!(live["connections"][0]["sessionCount"], 1);
    assert_eq!(live["connections"][0]["scopes"], json!(["orka.read"]));
    assert_eq!(plugin_connection::generation().unwrap(), binding.generation);
    let mut state: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    state["sessions"][&id]["members"][&id]["process"]["started"] = json!(0);
    db::atomic(&path, state.to_string().as_bytes()).unwrap();
    let inactive = plugin_connection::plugin_connection_status().unwrap();
    assert_eq!(inactive["connections"][0]["state"], "idle");
    assert_eq!(inactive["connections"][0]["sessionCount"], 0);
    assert!(plugin_connection::identify_session(&id, &secret, &peer).is_err());
}

#[test]
fn verified_first_connector_request_is_offered_once_and_retries_notify_once() {
    let f = Fixture::new();
    crate::env::test_support::install_memory_keychain();
    db::set(&f.db, "config", &json!({"apiUrl":"https://plugin.example"})).unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let identity = ProcessIdentity::read(std::process::id()).unwrap().0;
    let peer = Peer {
        helper: identity.clone(),
        assistant: identity,
    };
    let secret = &"c".repeat(64);
    let init = |app: Option<AssistantApp>| {
        let id = Uuid::new_v4().to_string();
        let label = if app.is_some() {
            "Untrusted name"
        } else {
            "Codex"
        };
        let response =
            plugin_connection::initialize_session(&id, secret, label, &peer, app).unwrap();
        (id, response)
    };
    let attention =
        |allow_prompt| plugin_connection::plugin_connection_attention(allow_prompt, None).unwrap();
    let review = |operation: &str, input: Value| {
        runtime
            .block_on(plugin_connection::plugin_authorization(
                operation.into(),
                input,
            ))
            .unwrap()
    };

    let (signed_out, request) = init(Some(AssistantApp::Codex));
    assert_eq!(request["state"], "signed_out");
    assert_eq!(request["raiseConsent"], false);
    assert!(attention(false).is_null());
    plugin_connection::close_session(&signed_out, secret).unwrap();
    sign_in_connector_fixture(&f);

    let (unverified, request) = init(None);
    assert_eq!(request["state"], "pending");
    assert_eq!(request["raiseConsent"], false);
    assert!(attention(true).is_null());
    assert!(review(
        "preview",
        json!({"requestId":request["requestId"],"automatic":true})
    )
    .is_null());
    plugin_connection::close_session(&unverified, secret).unwrap();

    let (brief, request) = init(Some(AssistantApp::Codex));
    assert_eq!(request["raiseConsent"], true);
    plugin_connection::close_session(&brief, secret).unwrap();
    assert!(attention(true).is_null());

    let (first, request) = init(Some(AssistantApp::Codex));
    assert_eq!(request["state"], "pending");
    assert_eq!(request["raiseConsent"], true);
    assert_eq!(attention(true), json!({"requestId":request["requestId"]}));
    assert!(attention(false).is_null());
    let (second, joined) = init(Some(AssistantApp::Codex));
    assert_eq!(joined["requestId"], request["requestId"]);
    assert_ne!(joined["raiseConsent"], true);
    plugin_connection::close_session(&first, secret).unwrap();

    let automatic = json!({"requestId":request["requestId"],"automatic":true});
    let preview = review("preview", automatic.clone());
    assert_eq!(preview["verified"], true);
    assert_eq!(preview["client"]["name"], "Codex");
    assert_eq!(review("preview", automatic.clone()), preview);
    assert!(attention(true).is_null());
    let dismiss = json!({"requestId":request["requestId"]});
    assert_eq!(review("preview", dismiss.clone())["verified"], true);
    assert_eq!(review("cancel", dismiss), json!({"cancelled":true}));
    assert!(review("preview", automatic).is_null());
    assert!(attention(true).is_null());
    plugin_connection::close_session(&second, secret).unwrap();
    assert!(attention(true).is_null());

    let (failed, request) = init(Some(AssistantApp::Codex));
    assert_eq!(request["raiseConsent"], false);
    let reconnect = attention(true);
    assert_eq!(reconnect["reconnect"]["name"], "Codex");
    let notice_id = reconnect["reconnect"]["id"].as_str().unwrap().to_owned();
    assert_eq!(attention(false), reconnect);
    plugin_connection::close_session(&failed, secret).unwrap();
    assert!(
        plugin_connection::plugin_connection_attention(false, Some(notice_id.clone()))
            .unwrap()
            .is_null()
    );
    assert!(attention(true).is_null());

    let (replacement, request) = init(Some(AssistantApp::Codex));
    assert_eq!(request["state"], "pending");
    assert!(attention(true).is_null());
    assert_eq!(
        review(
            "approve",
            json!({"requestId":request["requestId"],"scopes":["orka.read"]})
        ),
        json!({"approved":true})
    );
    assert!(plugin_connection::authorize(&replacement, secret, "orka.read").is_ok());
    assert!(attention(true).is_null());
    plugin_connection::close_session(&replacement, secret).unwrap();

    // Leave an older helper running that started while its Keychain session was unavailable.
    crate::env::test_support::install_memory_keychain();
    let (_, state) = init(Some(AssistantApp::Codex));
    assert_eq!(state["state"], "signed_out");
    let reconnect = attention(false);
    assert_eq!(reconnect["reconnect"]["name"], "Codex");
    let stale_notice = reconnect["reconnect"]["id"].as_str().unwrap().to_owned();
    assert_ne!(stale_notice, notice_id);
    sign_in_connector_fixture(&f);
    let (resumed, state) = init(Some(AssistantApp::Codex));
    assert_eq!(state["state"], "approved");
    assert!(plugin_connection::authorize(&resumed, secret, "orka.read").is_ok());
    assert!(attention(true).is_null());
    plugin_connection::close_session(&resumed, secret).unwrap();
    assert!(attention(true).is_null());
    assert_eq!(
        review("revoke", json!({"connectionId":replacement})),
        json!({"revoked":true})
    );
    assert!(attention(true).is_null());
    let (_, request) = init(Some(AssistantApp::Codex));
    assert_eq!(request["raiseConsent"], false);
    let reconnect = attention(true);
    assert_eq!(reconnect["reconnect"]["name"], "Codex");
    assert_ne!(reconnect["reconnect"]["id"], stale_notice);
    assert!(
        plugin_connection::plugin_connection_attention(false, Some(stale_notice))
            .unwrap()
            .is_null()
    );
    assert_eq!(attention(false), reconnect);
}

#[test]
fn existing_verified_grants_keep_reconnects_quiet_after_upgrade() {
    let f = Fixture::new();
    crate::env::test_support::install_memory_keychain();
    db::set(&f.db, "config", &json!({"apiUrl":"https://plugin.example"})).unwrap();
    sign_in_connector_fixture(&f);
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let identity = ProcessIdentity::read(std::process::id()).unwrap().0;
    let peer = Peer {
        helper: identity.clone(),
        assistant: identity,
    };
    let secret = &"c".repeat(64);
    let init = |app| {
        let id = Uuid::new_v4().to_string();
        let response = plugin_connection::initialize_session(
            &id,
            secret,
            "Fixture assistant",
            &peer,
            Some(app),
        )
        .unwrap();
        (id, response)
    };
    let approve = |app| {
        let (id, request) = init(app);
        assert_eq!(
            runtime
                .block_on(plugin_connection::plugin_authorization(
                    "approve".into(),
                    json!({"requestId":request["requestId"],"scopes":["orka.read"]}),
                ))
                .unwrap(),
            json!({"approved":true})
        );
        id
    };
    let active = approve(AssistantApp::Codex);
    let idle = approve(AssistantApp::ClaudeCode);
    let revoked = approve(AssistantApp::ClaudeDesktop);
    plugin_connection::close_session(&idle, secret).unwrap();
    runtime
        .block_on(plugin_connection::plugin_authorization(
            "revoke".into(),
            json!({"connectionId":revoked}),
        ))
        .unwrap();

    let path = db::root().unwrap().join("plugin-connection.json");
    let mut previous: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    previous
        .as_object_mut()
        .unwrap()
        .remove("assistantAttention");
    previous["sessions"][&revoked]["members"] = json!({});
    db::atomic(&path, previous.to_string().as_bytes()).unwrap();

    assert!(plugin_connection::authorize(&active, secret, "orka.read").is_ok());
    assert!(plugin_connection::plugin_connection_attention(true, None)
        .unwrap()
        .is_null());
    let (resumed, state) = init(AssistantApp::ClaudeCode);
    assert_eq!(state["state"], "approved");
    assert!(plugin_connection::authorize(&resumed, secret, "orka.read").is_ok());
    assert!(plugin_connection::plugin_connection_attention(true, None)
        .unwrap()
        .is_null());

    let (replacement, state) = init(AssistantApp::ClaudeDesktop);
    assert_eq!(state["state"], "pending");
    assert_eq!(state["raiseConsent"], false);
    assert!(plugin_connection::authorize(&replacement, secret, "orka.read").is_err());
    let attention = plugin_connection::plugin_connection_attention(true, None).unwrap();
    assert_eq!(attention["reconnect"]["name"], "Claude");
    assert!(attention["reconnect"]["id"].is_string());
}

fn sign_in_connector_fixture(f: &Fixture) {
    let account_id = db::get(&f.db, "user").unwrap();
    crate::auth::test_session(&json!({
        "user":{"id":account_id},"access_token":"fixture","refresh_token":"fixture"
    }))
    .unwrap();
}

#[test]
fn verified_connector_access_survives_new_processes_but_not_revocation_or_workspace_changes() {
    use std::process::Command;

    let f = Fixture::new();
    crate::env::test_support::install_memory_keychain();
    let config = json!({"apiUrl":"https://plugin.example"});
    db::set(&f.db, "config", &config).unwrap();
    let sign_in = || sign_in_connector_fixture(&f);
    sign_in();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let review = |operation: &str, input: Value| {
        runtime
            .block_on(plugin_connection::plugin_authorization(
                operation.into(),
                input,
            ))
            .unwrap()
    };
    let secret = &"c".repeat(64);
    let helper = ProcessIdentity::read(std::process::id()).unwrap().0;
    let mut first_parent = Command::new("/bin/sleep").arg("30").spawn().unwrap();
    let mut second_parent = Command::new("/bin/sleep").arg("30").spawn().unwrap();
    let first = Peer {
        helper: helper.clone(),
        assistant: ProcessIdentity::read(first_parent.id()).unwrap().0,
    };
    let second = Peer {
        helper,
        assistant: ProcessIdentity::read(second_parent.id()).unwrap().0,
    };
    let init = |peer, app| {
        let id = Uuid::new_v4().to_string();
        let state =
            plugin_connection::initialize_session(&id, secret, "Spoofable label", peer, app)
                .unwrap();
        (id, state)
    };
    let approve = |request: &Value| {
        review(
            "approve",
            json!({"requestId":request["requestId"],"scopes":["orka.read"]}),
        )
    };

    let (first_id, request) = init(&first, Some(AssistantApp::Codex));
    assert_eq!(request["state"], "pending");
    assert_eq!(approve(&request), json!({"approved":true}));
    assert!(plugin_connection::authorize(&first_id, secret, "orka.read").is_ok());
    first_parent.kill().unwrap();
    first_parent.wait().unwrap();
    assert!(plugin_connection::identify_session(&first_id, secret, &first).is_err());
    let idle = plugin_connection::plugin_connection_status().unwrap();
    assert_eq!(idle["connections"][0]["state"], "idle");
    assert_eq!(idle["connections"][0]["scopes"], json!(["orka.read"]));
    assert_eq!(idle["reconnectRequired"], false);

    for app in [
        None,
        Some(AssistantApp::ClaudeCode),
        Some(AssistantApp::ClaudeDesktop),
    ] {
        let (id, request) = init(&second, app);
        assert_eq!(request["state"], "pending");
        assert!(plugin_connection::authorize(&id, secret, "orka.read").is_err());
        plugin_connection::close_session(&id, secret).unwrap();
        assert!(review("preview", json!({"requestId":request["requestId"]})).is_null());
        assert!(approve(&request).is_null());
    }
    let (returned, state) = init(&second, Some(AssistantApp::Codex));
    assert_eq!(state["state"], "approved");
    assert!(plugin_connection::identify_session(&returned, secret, &first).is_err());
    assert!(plugin_connection::identify_session(&returned, secret, &second).is_ok());
    assert!(plugin_connection::authorize(&returned, secret, "orka.read").is_ok());
    for scope in ["orka.write", "orka.manage"] {
        assert!(plugin_connection::authorize(&returned, secret, scope).is_err());
    }
    plugin_connection::close_session(&returned, secret).unwrap();
    review("revoke", json!({"connectionId":first_id}));
    let (replacement, request) = init(&second, Some(AssistantApp::Codex));
    assert_eq!(request["state"], "pending");
    assert_eq!(approve(&request), json!({"approved":true}));

    db::set(&f.db, "config", &json!({"apiUrl":"https://other.example"})).unwrap();
    db::set(&f.db, "config", &config).unwrap();
    sign_in();
    assert!(plugin_connection::authorize(&replacement, secret, "orka.read").is_err());
    let (new_session, request) = init(&second, Some(AssistantApp::Codex));
    assert_eq!(request["state"], "pending");
    assert_eq!(approve(&request), json!({"approved":true}));
    db::guest().unwrap();
    sign_in();
    assert!(plugin_connection::authorize(&new_session, secret, "orka.read").is_err());
    assert_eq!(
        init(&second, Some(AssistantApp::Codex)).1["state"],
        "pending"
    );
    second_parent.kill().unwrap();
    second_parent.wait().unwrap();
}
