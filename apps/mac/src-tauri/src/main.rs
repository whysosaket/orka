mod account_profile;
mod auth;
mod bundles;
mod claude_import;
mod codex_import;
mod codex_skills;
mod commands;
mod db;
mod device_metadata;
mod env;
mod global_skills;
mod governance;
mod history;
mod indexer;
mod memory_context;
mod native;
mod onboarding;
mod packages;
mod plans;
mod plugin_mcp;
mod profiles;
mod projects;
mod repair;
mod repositories;
mod selective_sharing;
mod session_forks;
mod session_launcher;
mod session_presentation;
mod session_translation;
mod settings;
mod settings_lifecycle;
mod skill_usage;
mod sources;
mod sync;
#[cfg(test)]
mod tests;
use serde_json::json;
#[cfg(debug_assertions)]
use serde_json::Value;
use std::io::Read;
use tauri::Manager;
fn main() {
    let mut args = std::env::args().collect::<Vec<_>>();
    if let Err(error) = profiles::initialize(&mut args) {
        eprintln!("{error}");
        std::process::exit(1);
    }
    #[cfg(debug_assertions)]
    if args.get(1).is_some_and(|a| a == "--orka-env-test") {
        env::test_support::run();
        return;
    }
    if args.get(1).is_some_and(|a| a == "--orka-agent") {
        tokio::runtime::Runtime::new()
            .expect("Background runtime")
            .block_on(sync::run());
        return;
    }
    if args.get(1).is_some_and(|a| a == "--orka-plugin") {
        if let Err(error) = plugin_mcp::run() {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    if args.get(1).is_some_and(|a| a == "--orka-sync") {
        if let Err(error) = tokio::runtime::Runtime::new()
            .expect("Sync runtime")
            .block_on(sync::once())
        {
            eprintln!("Orka sync: {error}");
            std::process::exit(1);
        }
        println!("Orka sync completed");
        return;
    }
    if args.get(1).is_some_and(|a| a == "--orka-hook") {
        let mut input = String::new();
        let _ = std::io::stdin().take(1_000_000).read_to_string(&mut input);
        let result = serde_json::from_str(&input)
            .map_err(|e| e.to_string())
            .and_then(|v| native::hook(args.get(2).map(String::as_str).unwrap_or(""), v));
        match result {
            Ok(v) => println!("{v}"),
            Err(e) => {
                eprintln!("Orka hook: {e}");
                println!("{{}}");
            }
        }
        return;
    }
    if args.get(1).is_some_and(|a| a == "--orka-context") {
        let mut raw = String::new();
        let _ = std::io::stdin().take(2_000_000).read_to_string(&mut raw);
        let result = serde_json::from_str::<serde_json::Value>(&raw)
            .map_err(|e| e.to_string())
            .and_then(|v| {
                let action = v["action"].as_str().ok_or("Missing action")?.to_string();
                if ![
                    "context",
                    "catalog",
                    "resource",
                    "drafts",
                    "draft",
                    "save-candidate",
                    "submit-draft",
                    "refresh-draft",
                    "request-access",
                    "requests",
                    "request",
                ]
                .contains(&action.as_str())
                {
                    return Err("This agent operation is unavailable".into());
                }
                tokio::runtime::Runtime::new()
                    .map_err(|e| e.to_string())?
                    .block_on(governance::governance_command(action, v["input"].clone()))
            });
        match result {
            Ok(value) => println!("{value}"),
            Err(error) => {
                println!("{}", json!({"status":"awaiting_permission","error":error}));
                std::process::exit(1);
            }
        }
        return;
    }
    #[cfg(debug_assertions)]
    if args.get(1).is_some_and(|a| a == "--orka-test") {
        if std::env::var_os("ORKA_TEST_HOME").is_none() {
            eprintln!("Isolated test home required");
            std::process::exit(1);
        }
        let mut raw = String::new();
        std::io::stdin()
            .read_to_string(&mut raw)
            .expect("Test input");
        let input: Value = serde_json::from_str(&raw).expect("Test JSON");
        let result:db::Result<Value>=match input["action"].as_str().unwrap_or("") {
            "rpc"=>native::Rpc::connect().and_then(|mut rpc|rpc.call(input["method"].as_str().unwrap_or(""),input["params"].clone())),
            "configure"=>commands::configure(input["config"].clone()).map(|_|json!({"ok":true})),
            "test-session"=>auth::test_session(&input["session"]).map(|_|json!({"ok":true})),
            "switch-service"=>commands::switch_service(input["config"].clone()).map(|_|json!({"ok":true})),
            "begin-sign-in"=>tokio::runtime::Runtime::new().expect("Test runtime").block_on(commands::begin_sign_in(input["method"].as_str().unwrap_or("").into(),input["email"].as_str().map(str::to_string))),
            "complete-sign-in"=>tokio::runtime::Runtime::new().expect("Test runtime").block_on(commands::complete_sign_in(input["callback"].as_str().map(str::to_string),input["code"].as_str().map(str::to_string))),
            "sign-in"=>tokio::runtime::Runtime::new().expect("Test runtime").block_on(commands::sign_in(input["email"].as_str().unwrap_or("").into(),input["password"].as_str().unwrap_or("").into())),
            "sign-out"=>auth::sign_out().map(|_|json!({"ok":true})),
            "snapshot"=>commands::snapshot(),
            "session-launch-options"=>session_launcher::options(input["id"].as_str().unwrap_or("")).and_then(|options|serde_json::to_value(options).map_err(|e|e.to_string())),
            "session-handoff-prompt"=>session_launcher::handoff_prompt(input["id"].as_str().unwrap_or("")),
            "resume-session"=>session_launcher::Tool::parse(input["tool"].as_str().unwrap_or("")).and_then(|tool| {
                let destination=serde_json::from_value(input.get("destination").cloned().unwrap_or(json!("desktop"))).map_err(|e|e.to_string())?;
                if input["fork"] == true { session_launcher::launch(input["id"].as_str().unwrap_or(""),tool,destination,true) }
                else { session_launcher::resume(input["id"].as_str().unwrap_or(""),tool,destination) }
            }),
            "onboarding"=>tokio::runtime::Runtime::new().expect("Test runtime").block_on(onboarding::onboarding_command(input["operation"].as_str().unwrap_or("").into(),input["input"].clone(),input.get("context").cloned())),
            "repository"=>(|| -> db::Result<Value> {
                let context: repositories::Context = serde_json::from_value(input["context"].clone()).map_err(|e| e.to_string())?;
                tokio::runtime::Runtime::new().map_err(|e|e.to_string())?.block_on(async {
                    let operation=input["operation"].as_str().ok_or("Missing repository operation")?;
                    let result=repositories::repository_command(operation.into(),input["input"].clone(),context.clone()).await?;
                    if operation=="clone" && input["wait"]==true {
                        for _ in 0..600 {
                            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                            let jobs=repositories::repository_command("jobs".into(),json!({}),context.clone()).await?;
                            if let Some(job)=jobs.as_array().and_then(|jobs|jobs.iter().find(|job|job["id"]==result["id"])) {
                                if !["queued","cloning","connecting"].contains(&job["state"].as_str().unwrap_or("")) {return Ok(job.clone());}
                            }
                        }
                        return Err("Clone acceptance timed out".into());
                    }
                    Ok(result)
                })
            })(),
            "profile-info"=>(|| -> db::Result<Value> { Ok(json!({"profile":profiles::current(),"root":db::root()?,"keychain":profiles::credential_service()?,"agent":profiles::label(),"codexHome":native::codex_home()?,"claudeHome":native::claude_home()?})) })(),
            "profiles"=>profiles::profile_list(),
            "session-user"=>auth::session().map(|value|json!({"user":value["user"]["id"]})),
            "queue-callback"=>profiles::queue_callback(input["callback"].as_str().unwrap_or("")).map(|name|json!({"profile":name})),
            "take-callback"=>profiles::take_callback().map(|callback|json!({"callback":callback})),
            "project"=>tokio::runtime::Runtime::new().expect("Test runtime").block_on(projects::project_command(input["operation"].as_str().unwrap_or("").into(),input["input"].clone())),
            "cloud-action"=>tokio::runtime::Runtime::new().expect("Test runtime").block_on(commands::cloud_action(input["operation"].as_str().unwrap_or("").into(),input["input"].clone())),
            "connect"=>tokio::runtime::Runtime::new().expect("Test runtime").block_on(sources::connect_project_sources(input["id"].as_str().unwrap_or("").into(),vec![input["path"].as_str().unwrap_or("").into()],input["sourceId"].as_str().map(str::to_owned))).map(|_|json!({"ok":true})),
            "sync-now"=>commands::sync_now().map(|_|json!({"ok":true})),
            "scan"=>db::open().and_then(|db|indexer::scan(&db,&input["project"]).map(|_|json!({"resources":db::rows(&db,"SELECT value FROM resources",&[]).unwrap_or_default(),"outbox":db::rows(&db,"SELECT value FROM outbox",&[]).unwrap_or_default()}))),
            "sync"=>tokio::runtime::Runtime::new().expect("Test runtime").block_on(sync::once()).map(|_|json!({"ok":true})),
            "materialize"=>db::open().and_then(|db|sync::materialize(&db,&input["project"],&input["resource"]).map(|_|json!({"ok":true}))),
            _=>Err("Unknown test action".into())
        };
        match result {
            Ok(v) => println!("{v}"),
            Err(e) => {
                eprintln!("{e}");
                std::process::exit(1);
            }
        }
        return;
    }
    let _instance = match profiles::acquire_instance() {
        Ok(Some(lock)) => lock,
        Ok(None) => return,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    };
    let mut context = tauri::generate_context!();
    if profiles::current() != "default" {
        for window in &mut context.config_mut().app.windows {
            // Credentials and settings are native; an ephemeral webview also
            // isolates browser storage on the macOS 12 minimum target.
            window.incognito = true;
        }
    }
    tauri::Builder::default()
        .manage(settings_lifecycle::SettingsCloseGuard::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .setup(|_app| {
            #[cfg(target_os = "macos")]
            settings_lifecycle::install_quit_menu(_app.handle())?;
            db::open().map_err(std::io::Error::other)?;
            if let Err(e) = commands::ensure_agent() {
                db::set(
                    &db::open().map_err(std::io::Error::other)?,
                    "daemon",
                    &json!({"running":false,"error":e}),
                )
                .map_err(std::io::Error::other)?;
            }
            onboarding::resume_sync();
            sync::start_foreground();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            settings_lifecycle::guard_settings_close,
            settings_lifecycle::finish_settings_close,
            onboarding::onboarding_command,
            commands::open_legal_link,
            env::env_command,
            governance::governance_command,
            profiles::profile_list,
            profiles::open_profile,
            profiles::route_auth_callback,
            profiles::profile_events,
            commands::snapshot,
            projects::project_command,
            settings::settings_command,
            commands::configure,
            commands::sign_in,
            commands::switch_service,
            commands::auth_capabilities,
            commands::begin_sign_in,
            commands::complete_sign_in,
            commands::cancel_sign_in,
            commands::retry_sign_in_storage,
            commands::sign_out,
            commands::sync_now,
            commands::sync_progress,
            commands::cloud_action,
            commands::connect_project,
            sources::connect_project_sources,
            repositories::repository_command,
            sources::disconnect_project_source,
            sources::scan_project_folders,
            commands::disconnect_project,
            commands::inspect_resource,
            commands::session_messages,
            commands::session_display_title,
            commands::open_editor,
            commands::session_action,
            commands::resume_session,
            commands::session_launch_options,
            commands::session_handoff_prompt,
            commands::export_bundle,
            commands::import_bundle,
            global_skills::scan_global_skills,
            global_skills::add_global_skill,
            global_skills::add_global_skills,
            skill_usage::global_skill_usage,
            skill_usage::project_skill_usage,
            commands::retry_uploads,
            commands::background_agent
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if settings_lifecycle::request(window.app_handle(), "close") {
                    api.prevent_close();
                }
            }
        })
        .build(context)
        .expect("Unable to start Orka")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = &event {
                if settings_lifecycle::request(app, "quit") {
                    api.prevent_exit();
                }
            }
            if matches!(event, tauri::RunEvent::Exit) {
                env::clear();
            }
        });
}
