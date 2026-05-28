// Prevents additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[cfg(target_os = "macos")]
mod macos_focus {
    use objc2::{class, msg_send, runtime::AnyObject};

    /// Returns true iff the currently frontmost application is the one with
    /// the given bundle identifier.
    pub fn is_app_frontmost(expected_bundle: &str) -> bool {
        unsafe {
            let workspace_class = class!(NSWorkspace);
            let workspace: *mut AnyObject = msg_send![workspace_class, sharedWorkspace];
            if workspace.is_null() {
                return false;
            }
            let app: *mut AnyObject = msg_send![workspace, frontmostApplication];
            if app.is_null() {
                return false;
            }
            let bundle_id: *mut AnyObject = msg_send![app, bundleIdentifier];
            if bundle_id.is_null() {
                return false;
            }
            let utf8: *const i8 = msg_send![bundle_id, UTF8String];
            if utf8.is_null() {
                return false;
            }
            let cstr = std::ffi::CStr::from_ptr(utf8);
            cstr.to_str()
                .map(|s| s == expected_bundle)
                .unwrap_or(false)
        }
    }

    /// Equivalent of `[NSApp deactivate]` — gives focus back to the previous
    /// app without hiding any of our windows. The crucial difference from
    /// tauri's `app.hide()` (which calls `[NSApp hide:]` and ALSO hides
    /// all windows): deactivate only changes focus.
    pub fn deactivate_app() {
        unsafe {
            let app_class = class!(NSApplication);
            let app: *mut AnyObject = msg_send![app_class, sharedApplication];
            if app.is_null() {
                return;
            }
            let _: () = msg_send![app, deactivate];
        }
    }
}

const BUNDLE_ID: &str = "com.nicolassut.keyring";

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

/// In-memory session state shared between windows.
/// The DEK lives in Rust process memory (never serialized to disk) so the
/// quick-add window can grab it from the main window without serializing
/// secret material through the OS clipboard, env, or files.
struct SessionState {
    dek: Mutex<Option<Vec<u8>>>,
    /// Was Keyring the frontmost app right BEFORE the popover was shown?
    /// If true, the user was working inside Keyring (main + sidebar etc),
    /// so we let macOS focus management run normally on popover close.
    /// If false, the user pressed the hotkey from inside another app
    /// (Lovable, browser, ...) — we explicitly deactivate so focus returns
    /// to that app instead of macOS auto-promoting main.
    keyring_was_frontmost_before_popover: AtomicBool,
    /// Manual mirror of main's visibility — Tauri's is_visible() doesn't
    /// always reflect what we expect right after a programmatic hide.
    main_currently_visible: AtomicBool,
    /// Timestamp of the most recent popover activity (open or close). Used
    /// to gate the Reopen handler — macOS fires Reopen as a side effect of
    /// the popover lifecycle and we don't want that to bring main forward.
    popover_activity_at: Mutex<Option<Instant>>,
}

impl Default for SessionState {
    fn default() -> Self {
        Self {
            dek: Mutex::new(None),
            keyring_was_frontmost_before_popover: AtomicBool::new(false),
            main_currently_visible: AtomicBool::new(true),
            popover_activity_at: Mutex::new(None),
        }
    }
}

const REOPEN_GATE_MS: u64 = 500;

#[tauri::command]
fn set_session_dek(state: tauri::State<'_, SessionState>, dek: Vec<u8>) {
    if let Ok(mut guard) = state.dek.lock() {
        *guard = Some(dek);
    }
}

#[tauri::command]
fn get_session_dek(state: tauri::State<'_, SessionState>) -> Option<Vec<u8>> {
    state.dek.lock().ok().and_then(|g| g.clone())
}

#[tauri::command]
fn clear_session_dek(state: tauri::State<'_, SessionState>) {
    if let Ok(mut guard) = state.dek.lock() {
        // Zero the bytes before dropping for hygiene.
        if let Some(buf) = guard.as_mut() {
            for b in buf.iter_mut() {
                *b = 0;
            }
        }
        *guard = None;
    }
}

/// Called by the JS hotkey handler right before showing the popover.
/// Snapshots whether Keyring was frontmost (so we can decide on close
/// whether to return focus to the previous app), and stamps popover-
/// activity to suppress the Reopen event macOS fires as a side effect.
#[tauri::command]
fn record_main_visibility(state: tauri::State<'_, SessionState>) {
    #[cfg(target_os = "macos")]
    let frontmost = macos_focus::is_app_frontmost(BUNDLE_ID);
    #[cfg(not(target_os = "macos"))]
    let frontmost = true;
    state
        .keyring_was_frontmost_before_popover
        .store(frontmost, Ordering::SeqCst);

    if let Ok(mut guard) = state.popover_activity_at.lock() {
        *guard = Some(Instant::now());
    }
}

/// Called from JS on popover dismiss. Hides the popover, then chooses what
/// to do with focus:
///   - Keyring was frontmost when popover opened → just hide popover,
///     macOS focuses the next Keyring window (main) like the user expects.
///   - Keyring was NOT frontmost (user was in another app) → call
///     [NSApp deactivate] so the previously frontmost app gets focus back
///     and main stays exactly where it was (not promoted, not hidden).
#[tauri::command]
fn handle_popover_close(app: tauri::AppHandle, state: tauri::State<'_, SessionState>) {
    if let Ok(mut guard) = state.popover_activity_at.lock() {
        *guard = Some(Instant::now());
    }

    if let Some(popover) = app.get_webview_window("quick-add") {
        let _ = popover.hide();
    }

    let was_frontmost = state
        .keyring_was_frontmost_before_popover
        .load(Ordering::SeqCst);
    if was_frontmost {
        return; // user was inside Keyring — let macOS pick the next window
    }

    #[cfg(target_os = "macos")]
    macos_focus::deactivate_app();
}

/// Bring the main window to the front. Used by tray clicks and global hotkey.
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        if let Some(state) = app.try_state::<SessionState>() {
            state.main_currently_visible.store(true, Ordering::SeqCst);
        }
    }
}

#[tauri::command]
fn show_window(app: tauri::AppHandle) {
    show_main_window(&app);
}

#[tauri::command]
fn hide_window(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SessionState::default())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // System tray (menubar on macOS)
            let show_item = MenuItem::with_id(app, "show", "Show Keyring", true, None::<&str>)?;
            let lock_item = MenuItem::with_id(app, "lock", "Lock vault", true, None::<&str>)?;
            let settings_item = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
            let separator = tauri::menu::PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit Keyring", true, None::<&str>)?;

            let tray_menu = Menu::with_items(
                app,
                &[&show_item, &lock_item, &settings_item, &separator, &quit_item],
            )?;

            let _tray = TrayIconBuilder::with_id("main")
                .tooltip("Keyring")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "lock" => {
                        show_main_window(app);
                        let _ = app.emit("tray://lock", ());
                    }
                    "settings" => {
                        show_main_window(app);
                        let _ = app.emit("tray://settings", ());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            show_window,
            hide_window,
            set_session_dek,
            get_session_dek,
            clear_session_dek,
            record_main_visibility,
            handle_popover_close
        ])
        .on_window_event(|window, event| {
            // Close button hides the window (like macOS apps), doesn't quit.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                if window.label() == "main" {
                    if let Some(state) = window.app_handle().try_state::<SessionState>() {
                        state.main_currently_visible.store(false, Ordering::SeqCst);
                    }
                }
                api.prevent_close();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // macOS fires Reopen on dock-click AND, annoyingly, as a side
            // effect of dismissing the popover window. We only want to act
            // on the dock-click case — so we ignore Reopen events fired
            // within REOPEN_GATE_MS of a popover dismissal.
            if let tauri::RunEvent::Reopen { has_visible_windows, .. } = event {
                if has_visible_windows {
                    return;
                }
                if let Some(state) = app.try_state::<SessionState>() {
                    let recent_popover_activity = state
                        .popover_activity_at
                        .lock()
                        .ok()
                        .and_then(|g| *g)
                        .map(|t| t.elapsed() < Duration::from_millis(REOPEN_GATE_MS))
                        .unwrap_or(false);
                    if recent_popover_activity {
                        return;
                    }
                }
                show_main_window(app);
            }
        });
}
