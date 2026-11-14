use crate::{db, projects, sync};
use serde_json::{json, Value};
use tauri::Manager;

pub const LABEL: &str = "menu-bar";
const WIDTH: f64 = 360.0;

pub fn allows_command(command: &str) -> bool {
    [
        "menu_bar_snapshot",
        "menu_bar_action",
        "menu_bar_resize",
        "sync_now",
    ]
    .contains(&command)
}

pub(crate) fn resize_height(label: &str, height: f64) -> db::Result<f64> {
    if label != LABEL {
        return Err("Only the menu bar can resize its panel".into());
    }
    if !height.is_finite() {
        return Err("Invalid menu bar height".into());
    }
    Ok(height.clamp(120.0, 480.0).ceil())
}

#[cfg(target_os = "macos")]
pub(crate) fn resized_frame(
    mut frame: objc2_foundation::NSRect,
    height: f64,
    work: Option<objc2_foundation::NSRect>,
) -> objc2_foundation::NSRect {
    let top = frame.origin.y + frame.size.height;
    frame.size.width = WIDTH;
    frame.size.height = height;
    if let Some(work) = work {
        frame.size.height = height.min((work.size.height - 16.0).max(1.0));
        frame.origin.x = frame.origin.x.clamp(
            work.origin.x + 8.0,
            (work.origin.x + work.size.width - WIDTH - 8.0).max(work.origin.x + 8.0),
        );
        frame.origin.y = (top - frame.size.height).clamp(
            work.origin.y + 8.0,
            (work.origin.y + work.size.height - frame.size.height - 8.0).max(work.origin.y + 8.0),
        );
    } else {
        frame.origin.y = top - height;
    }
    frame
}

#[tauri::command]
pub fn menu_bar_resize(window: tauri::WebviewWindow, height: f64) -> db::Result<()> {
    let height = resize_height(window.label(), height)?;
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::NSWindow;
        let target = window.clone();
        window
            .run_on_main_thread(move || {
                let Ok(pointer) = target.ns_window() else {
                    return;
                };
                // AppKit uses bottom-left coordinates; change frame once to keep the top anchored.
                let native = unsafe { &*(pointer as *const NSWindow) };
                let work = native.screen().map(|screen| screen.visibleFrame());
                native.setFrame_display(resized_frame(native.frame(), height, work), true);
            })
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    window
        .set_size(tauri::LogicalSize::new(WIDTH, height))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn menu_bar_snapshot() -> db::Result<Value> {
    let db = db::open()?;
    let running = db::daemon_running()?;
    snapshot(&db, running)
}

pub(crate) fn snapshot(db: &rusqlite::Connection, running: bool) -> db::Result<Value> {
    let onboarding = crate::onboarding::snapshot(db)?["active"] == true;
    let projects = db::rows(
        db,
        &format!(
            "SELECT json_object('pending',(SELECT count(*) FROM outbox WHERE project=p.id),\
             'issues',(SELECT count(*) FROM outbox WHERE project=p.id AND error IS NOT NULL)+(SELECT count(*) FROM conflicts WHERE project=p.id)+(SELECT count(*) FROM errors WHERE source=p.id OR substr(source,1,length(p.id)+1)=p.id||':' OR source IN (SELECT id FROM resources WHERE project=p.id)))\
             FROM projects p WHERE {} AND json_extract(p.value,'$.removedAt') IS NULL AND CASE WHEN json_type(p.value,'$.sources')='array' THEN EXISTS(SELECT 1 FROM json_each(p.value,'$.sources') WHERE json_extract(json_each.value,'$.removedAt') IS NULL AND coalesce(json_extract(json_each.value,'$.path'),'')<>'') ELSE coalesce(json_extract(p.value,'$.path'),'')<>'' END",
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
    let account_issues: u64 = db
        .query_row(
            "SELECT count(*) FROM errors WHERE source LIKE 'history:unattributed:%'",
            [],
            |row| row.get::<_, i64>(0).map(|count| count as u64),
        )
        .map_err(|error| error.to_string())?;
    let status = db::get(db, "sync")?;
    let issues = (project_issues + account_issues).max(u64::from(
        status["error"]
            .as_str()
            .is_some_and(|error| !error.is_empty()),
    ));
    Ok(json!({
        "user":db::get(db,"user")?, "onboarding":onboarding,
        "running":running,
        "sync":status, "progress":sync::current_progress(db,running)?,
        "projectCount":projects.len(), "pending":pending, "issues":issues
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
    use objc2_app_kit::{
        NSAppearance, NSAppearanceCustomization, NSAppearanceNameDarkAqua, NSWindow,
    };
    use tauri::{
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
        window::{Effect, EffectState, EffectsBuilder},
        WebviewUrl, WebviewWindowBuilder,
    };

    let panel =
        WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html?menu-bar=1".into()))
            .title("Orka menu bar")
            .inner_size(WIDTH, 260.0)
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
                    .effect(Effect::HudWindow)
                    .state(EffectState::Active)
                    .radius(18.0)
                    .build(),
            )
            .incognito(crate::profiles::current() != "default")
            .build()?;
    let appearance = NSAppearance::appearanceNamed(unsafe { NSAppearanceNameDarkAqua });
    let pointer = panel.ns_window()?;
    // Setup runs on AppKit's main thread; the retained panel owns this window.
    let native = unsafe { &*(pointer as *const NSWindow) };
    native.setAppearance(appearance.as_deref());
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
pub fn open_overview(app: &tauri::AppHandle) -> tauri::Result<()> {
    if let Some(rect) = app
        .tray_by_id("orka-menu-bar")
        .map(|tray| tray.rect())
        .transpose()?
        .flatten()
    {
        return toggle(app, rect);
    }
    if let Some(panel) = app.get_webview_window(LABEL) {
        panel.center()?;
        panel.show()?;
        panel.set_focus()?;
    }
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
        let panel_size = panel.outer_size()?.to_logical::<f64>(panel.scale_factor()?);
        let width = panel_size.width * scale;
        let height = panel_size.height * scale;
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
