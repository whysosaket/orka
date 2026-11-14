use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};

// A window-scoped navigation guard, not persisted draft or account state.
#[derive(Default)]
pub struct SettingsCloseGuard(pub AtomicBool);

#[tauri::command]
pub fn guard_settings_close(state: tauri::State<SettingsCloseGuard>, enabled: bool) {
    state.0.store(enabled, Ordering::SeqCst);
}

#[cfg(target_os = "macos")]
pub fn install_quit_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};

    // The native Quit item calls AppKit's terminate: directly, bypassing
    // ExitRequested. Preserve the standard menu, but route Quit through Tauri.
    let menu = Menu::default(app)?;
    if let Some(submenu) = menu.items()?.first().and_then(|item| item.as_submenu()) {
        submenu.insert(
            &MenuItem::with_id(
                app,
                "orka-check-for-updates",
                "Check for Updates…",
                true,
                None::<&str>,
            )?,
            1,
        )?;
    }
    let quit_text = PredefinedMenuItem::quit(app, None)?.text()?;
    for item in menu.items()? {
        if let Some(submenu) = item.as_submenu() {
            for (index, item) in submenu.items()?.iter().enumerate() {
                if let Some(predefined) = item.as_predefined_menuitem() {
                    if predefined.text()? == quit_text {
                        submenu.remove(predefined)?;
                        submenu.insert(
                            &MenuItem::with_id(
                                app,
                                "orka-quit",
                                &quit_text,
                                true,
                                Some("CmdOrCtrl+Q"),
                            )?,
                            index,
                        )?;
                    }
                }
            }
        }
    }
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        if event.id() == "orka-quit" {
            app.exit(0);
        } else if event.id() == "orka-check-for-updates" {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
                let _ = window.emit("check-for-updates", ());
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub fn finish_settings_close(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    quit: bool,
) -> Result<(), String> {
    app.state::<SettingsCloseGuard>()
        .0
        .store(false, Ordering::SeqCst);
    if quit {
        app.exit(0);
        Ok(())
    } else {
        window.close().map_err(|error| error.to_string())
    }
}

pub fn request(app: &tauri::AppHandle, action: &str) -> bool {
    app.state::<SettingsCloseGuard>().0.load(Ordering::SeqCst)
        && app
            .emit_to("main", "settings-close-requested", action)
            .is_ok()
}
