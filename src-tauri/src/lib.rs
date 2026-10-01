// Prevents additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

mod browser;
mod image_fetch;
mod oauth;

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

    /// Send Keyring to the background via the same keystroke the user
    /// would press themselves (Cmd+H = Hide Application). This is the
    /// most reliable way we've found — `[NSApp deactivate]` doesn't
    /// always take effect in newer macOS versions, and `[NSApp hide:]`
    /// works but is brittle when invoked from non-event-loop contexts.
    pub fn hide_app_via_keystroke() {
        let _ = std::process::Command::new("osascript")
            .args([
                "-e",
                "tell application \"System Events\" to keystroke \"h\" using command down",
            ])
            .spawn();
    }
}

/// macOS biometric (Touch ID) Keychain access.
///
/// Stores the vault DEK in a `kSecClassGenericPassword` item gated by a
/// `biometryCurrentSet` access-control policy and `WhenUnlockedThisDeviceOnly`
/// accessibility. Reading it triggers a fresh Touch ID prompt every time;
/// changing the enrolled fingerprints invalidates the item. The master
/// password (and the highDek) are NEVER stored here.
#[cfg(target_os = "macos")]
mod macos_biometric {
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::boolean::CFBoolean;
    use core_foundation::data::CFData;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::CFString;
    use core_foundation_sys::base::CFTypeRef;
    use core_foundation_sys::data::CFDataRef;
    use core_foundation_sys::dictionary::CFDictionaryRef;
    use core_foundation_sys::error::CFErrorRef;
    use core_foundation_sys::string::CFStringRef;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send, msg_send_id};
    use std::ptr;

    type OSStatus = i32;

    const ERR_SEC_SUCCESS: OSStatus = 0;
    const ERR_SEC_ITEM_NOT_FOUND: OSStatus = -25300;
    const ERR_SEC_USER_CANCELED: OSStatus = -128;
    const ERR_SEC_AUTH_FAILED: OSStatus = -25293;
    const ERR_SEC_INTERACTION_NOT_ALLOWED: OSStatus = -25308;

    /// kSecAccessControlBiometryCurrentSet — invalidated if the enrolled set of
    /// fingerprints changes.
    const BIOMETRY_CURRENT_SET: usize = 1 << 3;
    /// LAPolicyDeviceOwnerAuthenticationWithBiometrics.
    const LA_POLICY_BIOMETRICS: isize = 1;

    extern "C" {
        fn SecItemAdd(attributes: CFDictionaryRef, result: *mut CFTypeRef) -> OSStatus;
        fn SecItemCopyMatching(query: CFDictionaryRef, result: *mut CFTypeRef) -> OSStatus;
        fn SecItemDelete(query: CFDictionaryRef) -> OSStatus;
        fn SecAccessControlCreateWithFlags(
            allocator: CFTypeRef,
            protection: CFTypeRef,
            flags: usize,
            error: *mut CFErrorRef,
        ) -> CFTypeRef;

        static kSecClass: CFStringRef;
        static kSecClassGenericPassword: CFStringRef;
        static kSecAttrService: CFStringRef;
        static kSecAttrAccount: CFStringRef;
        static kSecValueData: CFStringRef;
        static kSecReturnData: CFStringRef;
        static kSecReturnAttributes: CFStringRef;
        static kSecMatchLimit: CFStringRef;
        static kSecMatchLimitOne: CFStringRef;
        static kSecAttrAccessControl: CFStringRef;
        static kSecAttrAccessibleWhenUnlockedThisDeviceOnly: CFStringRef;
        static kSecUseAuthenticationUI: CFStringRef;
        static kSecUseAuthenticationUISkip: CFStringRef;
        static kSecUseOperationPrompt: CFStringRef;
    }

    /// Borrow a static (get-rule) CFStringRef constant as a CFType for building
    /// query/attribute dictionaries.
    unsafe fn k(r: CFStringRef) -> CFType {
        CFType::wrap_under_get_rule(r as CFTypeRef)
    }

    fn map_status(status: OSStatus) -> String {
        match status {
            ERR_SEC_USER_CANCELED => "Touch ID was cancelled".to_string(),
            ERR_SEC_AUTH_FAILED => "Touch ID authentication failed".to_string(),
            ERR_SEC_ITEM_NOT_FOUND => "No Touch ID credential is stored".to_string(),
            other => format!("Keychain error {}", other),
        }
    }

    /// True iff this Mac can evaluate biometrics (has Touch ID and it's set up).
    pub fn available() -> bool {
        unsafe {
            let ctx: Retained<AnyObject> = msg_send_id![class!(LAContext), new];
            let mut error: *mut AnyObject = ptr::null_mut();
            let can: bool = msg_send![&*ctx, canEvaluatePolicy: LA_POLICY_BIOMETRICS, error: &mut error];
            can
        }
    }

    /// Store `secret` under (service, account) with biometric access control.
    /// Delete-then-add so a re-enable overwrites cleanly.
    pub fn store(service: &str, account: &str, secret: &[u8]) -> Result<(), String> {
        unsafe {
            let _ = delete(service, account);

            let mut err: CFErrorRef = ptr::null_mut();
            let access = SecAccessControlCreateWithFlags(
                ptr::null(),
                kSecAttrAccessibleWhenUnlockedThisDeviceOnly as CFTypeRef,
                BIOMETRY_CURRENT_SET,
                &mut err,
            );
            if access.is_null() {
                return Err("Could not create a biometric access policy".to_string());
            }
            let access_cf = CFType::wrap_under_create_rule(access);

            let service_cf = CFString::new(service);
            let account_cf = CFString::new(account);
            let data_cf = CFData::from_buffer(secret);

            let pairs: [(CFType, CFType); 5] = [
                (k(kSecClass), k(kSecClassGenericPassword)),
                (k(kSecAttrService), service_cf.as_CFType()),
                (k(kSecAttrAccount), account_cf.as_CFType()),
                (k(kSecValueData), data_cf.as_CFType()),
                (k(kSecAttrAccessControl), access_cf),
            ];
            let dict = CFDictionary::from_CFType_pairs(&pairs);

            let mut result: CFTypeRef = ptr::null_mut();
            let status = SecItemAdd(dict.as_concrete_TypeRef(), &mut result);
            if !result.is_null() {
                let _ = CFType::wrap_under_create_rule(result);
            }
            if status != ERR_SEC_SUCCESS {
                return Err(map_status(status));
            }
            Ok(())
        }
    }

    /// Retrieve the secret, triggering a Touch ID prompt (item has biometric ACL).
    pub fn retrieve(service: &str, account: &str, prompt: &str) -> Result<Vec<u8>, String> {
        unsafe {
            let service_cf = CFString::new(service);
            let account_cf = CFString::new(account);
            let prompt_cf = CFString::new(prompt);

            let pairs: [(CFType, CFType); 6] = [
                (k(kSecClass), k(kSecClassGenericPassword)),
                (k(kSecAttrService), service_cf.as_CFType()),
                (k(kSecAttrAccount), account_cf.as_CFType()),
                (k(kSecReturnData), CFBoolean::true_value().as_CFType()),
                (k(kSecMatchLimit), k(kSecMatchLimitOne)),
                (k(kSecUseOperationPrompt), prompt_cf.as_CFType()),
            ];
            let dict = CFDictionary::from_CFType_pairs(&pairs);

            let mut result: CFTypeRef = ptr::null_mut();
            let status = SecItemCopyMatching(dict.as_concrete_TypeRef(), &mut result);
            if status != ERR_SEC_SUCCESS {
                return Err(map_status(status));
            }
            if result.is_null() {
                return Err("Keychain returned no data".to_string());
            }
            let data = CFData::wrap_under_create_rule(result as CFDataRef);
            Ok(data.bytes().to_vec())
        }
    }

    /// Whether an item exists for (service, account). Uses `...UISkip` so it
    /// NEVER prompts — even an item that would require auth reports as present.
    pub fn exists(service: &str, account: &str) -> bool {
        unsafe {
            let service_cf = CFString::new(service);
            let account_cf = CFString::new(account);
            let pairs: [(CFType, CFType); 6] = [
                (k(kSecClass), k(kSecClassGenericPassword)),
                (k(kSecAttrService), service_cf.as_CFType()),
                (k(kSecAttrAccount), account_cf.as_CFType()),
                (k(kSecReturnAttributes), CFBoolean::true_value().as_CFType()),
                (k(kSecMatchLimit), k(kSecMatchLimitOne)),
                (k(kSecUseAuthenticationUI), k(kSecUseAuthenticationUISkip)),
            ];
            let dict = CFDictionary::from_CFType_pairs(&pairs);
            let mut result: CFTypeRef = ptr::null_mut();
            let status = SecItemCopyMatching(dict.as_concrete_TypeRef(), &mut result);
            if !result.is_null() {
                let _ = CFType::wrap_under_create_rule(result);
            }
            status == ERR_SEC_SUCCESS || status == ERR_SEC_INTERACTION_NOT_ALLOWED
        }
    }

    /// Remove the item. errSecItemNotFound is treated as success (already gone).
    pub fn delete(service: &str, account: &str) -> Result<(), String> {
        unsafe {
            let service_cf = CFString::new(service);
            let account_cf = CFString::new(account);
            let pairs: [(CFType, CFType); 3] = [
                (k(kSecClass), k(kSecClassGenericPassword)),
                (k(kSecAttrService), service_cf.as_CFType()),
                (k(kSecAttrAccount), account_cf.as_CFType()),
            ];
            let dict = CFDictionary::from_CFType_pairs(&pairs);
            let status = SecItemDelete(dict.as_concrete_TypeRef());
            if status == ERR_SEC_SUCCESS || status == ERR_SEC_ITEM_NOT_FOUND {
                Ok(())
            } else {
                Err(map_status(status))
            }
        }
    }
}

/// Non-macOS stub: Touch ID is unavailable, everything degrades gracefully.
#[cfg(not(target_os = "macos"))]
mod macos_biometric {
    pub fn available() -> bool {
        false
    }
    pub fn store(_service: &str, _account: &str, _secret: &[u8]) -> Result<(), String> {
        Err("Touch ID is only available on macOS".to_string())
    }
    pub fn retrieve(_service: &str, _account: &str, _prompt: &str) -> Result<Vec<u8>, String> {
        Err("Touch ID is only available on macOS".to_string())
    }
    pub fn exists(_service: &str, _account: &str) -> bool {
        false
    }
    pub fn delete(_service: &str, _account: &str) -> Result<(), String> {
        Ok(())
    }
}

const BUNDLE_ID: &str = "com.nicolassut.keyring";

/// Keychain service name for biometric items. One item per Supabase user id.
const KEYCHAIN_SERVICE: &str = BUNDLE_ID;

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
    /// The latest 2FA popover payload (JSON), parked by the main window
    /// before it opens the popover so a popover that starts listening late
    /// can still pull it (KEY-2FA-1). Process memory only; cleared on close.
    two_fa_payload: Mutex<Option<String>>,
}

impl Default for SessionState {
    fn default() -> Self {
        Self {
            dek: Mutex::new(None),
            keyring_was_frontmost_before_popover: AtomicBool::new(false),
            main_currently_visible: AtomicBool::new(true),
            popover_activity_at: Mutex::new(None),
            two_fa_payload: Mutex::new(None),
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

// ── Biometric (Touch ID) commands ───────────────────────────────────────────

#[tauri::command]
fn biometric_available() -> bool {
    macos_biometric::available()
}

#[tauri::command]
fn biometric_store(account: String, secret: Vec<u8>) -> Result<(), String> {
    macos_biometric::store(KEYCHAIN_SERVICE, &account, &secret)
}

#[tauri::command]
fn biometric_retrieve(account: String) -> Result<Vec<u8>, String> {
    macos_biometric::retrieve(KEYCHAIN_SERVICE, &account, "Unlock your Keyring vault")
}

#[tauri::command]
fn biometric_exists(account: String) -> bool {
    macos_biometric::exists(KEYCHAIN_SERVICE, &account)
}

#[tauri::command]
fn biometric_delete(account: String) -> Result<(), String> {
    macos_biometric::delete(KEYCHAIN_SERVICE, &account)
}

/// Called by the JS hotkey handler right before showing the popover.
/// Decides whether the user "was in main" — i.e., whether to return focus
/// to main on popover close instead of pushing Keyring to the background.
///
/// The check is: Keyring is currently the frontmost app AND main window
/// is visible. By the time JS runs after a hotkey fires, Tauri has often
/// already activated us, so frontmost == Keyring isn't enough on its own.
/// Combining with `main_currently_visible` (manually tracked via the
/// CloseRequested handler) catches the case where Tauri auto-activated
/// us but main isn't actually on screen — that's the user-was-elsewhere
/// scenario.
#[tauri::command]
fn record_main_visibility(state: tauri::State<'_, SessionState>) {
    #[cfg(target_os = "macos")]
    let frontmost_is_us = macos_focus::is_app_frontmost(BUNDLE_ID);
    #[cfg(not(target_os = "macos"))]
    let frontmost_is_us = true;

    let main_visible = state.main_currently_visible.load(Ordering::SeqCst);
    let user_was_in_main = frontmost_is_us && main_visible;

    state
        .keyring_was_frontmost_before_popover
        .store(user_was_in_main, Ordering::SeqCst);

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

    let was_in_main = state
        .keyring_was_frontmost_before_popover
        .load(Ordering::SeqCst);
    if was_in_main {
        return; // user was inside main — let macOS focus main as normal
    }

    // User was in another app. Defensively re-hide main and send Keyring
    // to background via Cmd+H — most reliable way to give focus back.
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.hide();
    }
    #[cfg(target_os = "macos")]
    macos_focus::hide_app_via_keystroke();
}

/// KEY-2FA-1: park / read / clear the 2FA popover payload. See
/// src/lib/twoFactorPopoverController.ts for the handshake.
#[tauri::command]
fn set_2fa_payload(payload: String, state: tauri::State<'_, SessionState>) {
    if let Ok(mut guard) = state.two_fa_payload.lock() {
        *guard = Some(payload);
    }
}

#[tauri::command]
fn get_2fa_payload(state: tauri::State<'_, SessionState>) -> Option<String> {
    state.two_fa_payload.lock().ok().and_then(|g| g.clone())
}

#[tauri::command]
fn clear_2fa_payload(state: tauri::State<'_, SessionState>) {
    if let Ok(mut guard) = state.two_fa_payload.lock() {
        *guard = None;
    }
}

/// KEY-2FA-1: keep the Gmail poller on time while Keyring sits hidden in the
/// tray. macOS App Nap coalesces timers of hidden apps and WebKit throttles
/// timers of hidden pages (measured ingest lag 55-236 s on a 10 s poll).
#[cfg(target_os = "macos")]
mod macos_background {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send, msg_send_id, sel};

    /// NSActivityUserInitiatedAllowingIdleSystemSleep: opts the app out of
    /// App Nap but still lets the Mac sleep. Held for the process lifetime.
    pub fn opt_out_of_app_nap() {
        const OPTIONS: u64 = 0x00FF_FFFF & !(1u64 << 20);
        unsafe {
            let info: Retained<AnyObject> = msg_send_id![class!(NSProcessInfo), processInfo];
            let reason: Retained<AnyObject> = msg_send_id![
                class!(NSString),
                stringWithUTF8String: c"Keyring watches Gmail for 2FA codes".as_ptr()
            ];
            let token: Retained<AnyObject> =
                msg_send_id![&*info, beginActivityWithOptions: OPTIONS, reason: &*reason];
            std::mem::forget(token);
        }
    }

    /// Hidden-page DOM timer throttling and visibility-based process
    /// suppression are separate from `backgroundThrottling` (which sets
    /// inactiveSchedulingPolicy). WKPreferences SPI, each guarded by
    /// respondsToSelector so a WebKit without them is a no-op.
    pub unsafe fn unthrottle_hidden_page(webview: *mut AnyObject) {
        if webview.is_null() {
            return;
        }
        let config: *mut AnyObject = msg_send![webview, configuration];
        if config.is_null() {
            return;
        }
        let prefs: *mut AnyObject = msg_send![config, preferences];
        if prefs.is_null() {
            return;
        }
        let responds = |s: objc2::runtime::Sel| -> bool { msg_send![prefs, respondsToSelector: s] };
        if responds(sel!(_setHiddenPageDOMTimerThrottlingEnabled:)) {
            let _: () = msg_send![prefs, _setHiddenPageDOMTimerThrottlingEnabled: false];
        }
        if responds(sel!(_setHiddenPageDOMTimerThrottlingAutoIncreases:)) {
            let _: () = msg_send![prefs, _setHiddenPageDOMTimerThrottlingAutoIncreases: false];
        }
        if responds(sel!(_setPageVisibilityBasedProcessSuppressionEnabled:)) {
            let _: () = msg_send![prefs, _setPageVisibilityBasedProcessSuppressionEnabled: false];
        }
    }
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
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            #[cfg(target_os = "macos")]
            {
                macos_background::opt_out_of_app_nap();
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.with_webview(|wv| unsafe {
                        macos_background::unthrottle_hidden_page(
                            wv.inner() as *mut objc2::runtime::AnyObject,
                        );
                    });
                }
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
            handle_popover_close,
            biometric_available,
            biometric_store,
            biometric_retrieve,
            biometric_exists,
            biometric_delete,
            oauth::start_google_oauth,
            browser::open_url,
            image_fetch::fetch_image,
            set_2fa_payload,
            get_2fa_payload,
            clear_2fa_payload
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
