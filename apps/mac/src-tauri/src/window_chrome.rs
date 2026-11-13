use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(target_os = "macos")]
use tauri::Manager;

#[derive(Default)]
pub struct WindowControls(AtomicBool);

#[tauri::command]
pub fn set_sidebar_collapsed(
    window: tauri::Window,
    state: tauri::State<WindowControls>,
    collapsed: bool,
) -> Result<(), String> {
    state.0.store(collapsed, Ordering::Relaxed);
    position(&window).map_err(|error| error.to_string())
}

pub fn position(window: &tauri::Window) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSWindow, NSWindowButton, NSWindowStyleMask};
        use objc2_foundation::NSPoint;

        let target = window.clone();
        window.run_on_main_thread(move || {
            let Ok(pointer) = target.ns_window() else {
                return;
            };
            // The retained Tauri window keeps this pointer alive on AppKit's main thread.
            let native = unsafe { &*(pointer as *const NSWindow) };
            if native.styleMask().contains(NSWindowStyleMask::FullScreen) {
                return;
            }
            let [Some(close), Some(minimize), Some(zoom)] = [
                NSWindowButton::CloseButton,
                NSWindowButton::MiniaturizeButton,
                NSWindowButton::ZoomButton,
            ]
            .map(|kind| native.standardWindowButton(kind)) else {
                return;
            };
            // AppKit owns these ancestor views for the lifetime of the retained window.
            let Some(titlebar) = (unsafe { close.superview().and_then(|view| view.superview()) })
            else {
                return;
            };
            let control = close.frame();
            let height = control.origin.y + control.size.height / 2.0 + 34.0;
            let mut frame = titlebar.frame();
            frame.size.height = height;
            frame.origin.y = native.frame().size.height - height;
            titlebar.setFrame(frame);

            let origin = close.frame().origin.x;
            let width = zoom.frame().origin.x + zoom.frame().size.width - origin;
            let left = if target.state::<WindowControls>().0.load(Ordering::Relaxed) {
                (64.0 - width) / 2.0
            } else {
                // Sidebar padding (12) plus navigation row padding (10).
                22.0
            };
            for button in [close, minimize, zoom] {
                let frame = button.frame();
                button.setFrameOrigin(NSPoint::new(left + frame.origin.x - origin, frame.origin.y));
            }
        })?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = window;
    Ok(())
}
