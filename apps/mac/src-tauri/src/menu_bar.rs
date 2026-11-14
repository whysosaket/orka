use crate::{db, projects, sync};
use serde_json::{json, Value};
use tauri::Manager;

pub const LABEL: &str = "menu-bar";

pub fn allows_command(command: &str) -> bool {
    [
        "menu_bar_snapshot",
        "menu_bar_action",
        "sync_now",
        "background_agent",
    ]
    .contains(&command)
}

#[tauri::command]
pub fn menu_bar_snapshot() -> db::Result<Value> {
    let db = db::open()?;
    let running = db::daemon_running()?;
    snapshot(&db, running)
}

pub(crate) fn snapshot(db: &rusqlite::Connection, running: bool) -> db::Result<Value> {
    let onboarding = crate::onboarding::snapshot(db)?["active"] == true;
    let background = db::get(db, "background")?
        .as_bool()
        .unwrap_or(!onboarding && crate::profiles::background_default());
    let projects = db::rows(
        db,
        &format!(
            "SELECT json_object('id',p.id,'name',CASE WHEN json_extract(p.value,'$.role')='owner' THEN json_extract(p.value,'$.name') ELSE coalesce(json_extract(p.value,'$.localName'),json_extract(p.value,'$.name')) END,\
             'pending',(SELECT count(*) FROM outbox WHERE project=p.id),\
             'issues',(SELECT count(*) FROM outbox WHERE project=p.id AND error IS NOT NULL)+(SELECT count(*) FROM conflicts WHERE project=p.id)+(SELECT count(*) FROM errors WHERE source=p.id OR substr(source,1,length(p.id)+1)=p.id||':' OR source IN (SELECT id FROM resources WHERE project=p.id)))\
             FROM projects p WHERE {} AND json_extract(p.value,'$.removedAt') IS NULL AND CASE WHEN json_type(p.value,'$.sources')='array' THEN EXISTS(SELECT 1 FROM json_each(p.value,'$.sources') WHERE json_extract(json_each.value,'$.removedAt') IS NULL AND coalesce(json_extract(json_each.value,'$.path'),'')<>'') ELSE coalesce(json_extract(p.value,'$.path'),'')<>'' END ORDER BY json_extract(p.value,'$.name')",
            projects::ACTIVE
        ),
        &[],
    )?;
    let pending: u64 = projects
        .iter()
        .filter_map(|project| project["pending"].as_u64())
        .sum();
    let project_issues: u64 = projects
        .iter()
        .filter_map(|project| project["issues"].as_u64())
        .sum();
    let status = db::get(db, "sync")?;
    let issues = project_issues.max(u64::from(
        status["error"]
            .as_str()
            .is_some_and(|error| !error.is_empty()),
    ));
    Ok(json!({
        "user":db::get(db,"user")?, "onboarding":onboarding,
        "background":background, "running":running,
        "sync":status, "progress":sync::current_progress(db,running)?,
        "projects":projects, "pending":pending, "issues":issues
    }))
}

pub fn open_main(app: &tauri::AppHandle) -> tauri::Result<()> {
    if let Some(panel) = app.get_webview_window(LABEL) {
        panel.hide()?;
    }
    if let Some(window) = app.get_webview_window("main") {
        window.unminimize()?;
        window.show()?;
        window.set_focus()?;
    }
    Ok(())
}

#[tauri::command]
pub fn menu_bar_action(app: tauri::AppHandle, action: String) -> db::Result<()> {
    match action.as_str() {
        "open" => open_main(&app).map_err(|error| error.to_string()),
        "close" => app
            .get_webview_window(LABEL)
            .map(|window| window.hide())
            .transpose()
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "quit" => {
            if let Some(panel) = app.get_webview_window(LABEL) {
                panel.hide().map_err(|error| error.to_string())?;
            }
            app.exit(0);
            Ok(())
        }
        _ => Err("Unknown menu bar action".into()),
    }
}

#[cfg(target_os = "macos")]
pub fn install(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::{
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
        window::{Effect, EffectState, EffectsBuilder},
        WebviewUrl, WebviewWindowBuilder,
    };

    let panel =
        WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html?menu-bar=1".into()))
            .title("Orka menu bar")
            .inner_size(380.0, 560.0)
            .visible(false)
            .focused(false)
            .decorations(false)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .skip_taskbar(true)
            .always_on_top(true)
            .visible_on_all_workspaces(true)
            .transparent(true)
            .effects(
                EffectsBuilder::new()
                    .effect(Effect::Popover)
                    .state(EffectState::Active)
                    .radius(18.0)
                    .build(),
            )
            .incognito(crate::profiles::current() != "default")
            .build()?;
    let dismissed = std::sync::Arc::new(std::sync::Mutex::new(None::<std::time::Instant>));
    let last_dismissed = dismissed.clone();
    let target = panel.clone();
    panel.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Focused(false)) {
            if let Ok(mut last) = last_dismissed.lock() {
                *last = Some(std::time::Instant::now());
            }
            let _ = target.hide();
        }
    });
    TrayIconBuilder::with_id("orka-menu-bar")
        .icon(tauri::include_image!("icons/menu-bar.png"))
        .icon_as_template(false)
        .tooltip("Orka · Sync and activity")
        .show_menu_on_left_click(false)
        .on_tray_icon_event(move |tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect,
                ..
            } = event
            {
                // Clicking the status item can blur the panel before mouse-up.
                if dismissed.lock().is_ok_and(|last| {
                    last.is_some_and(|last| last.elapsed() < std::time::Duration::from_millis(200))
                }) {
                    return;
                }
                if let Err(error) = toggle(tray.app_handle(), rect) {
                    eprintln!("Unable to open Orka menu bar: {error}");
                }
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn toggle(app: &tauri::AppHandle, rect: tauri::Rect) -> tauri::Result<()> {
    let Some(panel) = app.get_webview_window(LABEL) else {
        return Ok(());
    };
    if panel.is_visible()? {
        return panel.hide();
    }
    let position = rect.position.to_physical::<f64>(1.0);
    let monitor = app
        .monitor_from_point(position.x, position.y)?
        .or(app.primary_monitor()?);
    if let Some(monitor) = monitor {
        let scale = monitor.scale_factor();
        let size = rect.size.to_physical::<f64>(scale);
        let work = monitor.work_area();
        let width = 380.0 * scale;
        let height = 560.0 * scale;
        let inset = 8.0 * scale;
        let x = (position.x + size.width / 2.0 - width / 2.0).clamp(
            work.position.x as f64 + inset,
            (work.position.x as f64 + work.size.width as f64 - width - inset)
                .max(work.position.x as f64 + inset),
        );
        let y = (position.y + size.height + inset).clamp(
            work.position.y as f64 + inset,
            (work.position.y as f64 + work.size.height as f64 - height - inset)
                .max(work.position.y as f64 + inset),
        );
        panel.set_position(tauri::PhysicalPosition::new(x, y))?;
    }
    panel.show()?;
    panel.set_focus()
}
