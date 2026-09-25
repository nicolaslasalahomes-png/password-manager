//! Open a URL in the user's default browser.
//!
//! Used by the 2FA popover's "Open link" button. The popover is platform-
//! agnostic by design — we don't try to route URLs into specific Chrome
//! profiles or Arc spaces because this user has a single browser (Opera)
//! with all 6 Google accounts signed in there. For Google-owned URLs the
//! JS side appends `?authuser={email}` so Google's account chooser
//! pre-selects the right account.

#[tauri::command]
pub fn open_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;
    app.shell()
        .open(url, None)
        .map_err(|e| format!("Could not open URL in browser: {e}"))
}
