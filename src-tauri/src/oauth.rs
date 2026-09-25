//! Google OAuth 2.0 PKCE loopback flow.
//!
//! Tauri-only side: we spin up a one-shot HTTP server on 127.0.0.1:<random>,
//! open the user's system browser to Google's consent screen, and block until
//! the redirect comes back with the `code` parameter. Then we return
//! { code, code_verifier, redirect_uri } to the JS layer, which exchanges the
//! code for tokens itself. We never touch the refresh token in Rust — it goes
//! straight into the encrypted Supabase row from JS.
//!
//! Why PKCE + public client (no embedded client secret):
//! - Native apps are public clients per RFC 8252.
//! - PKCE binds the code to a per-flow secret so an attacker intercepting the
//!   loopback redirect can't exchange the code without the verifier.

use base64::Engine as _;
use rand::RngCore;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::time::Duration;

const LISTEN_DEADLINE_SECS: u64 = 300; // 5 min window for the user to consent
const SUCCESS_HTML: &str = "<!doctype html><html><head><meta charset=\"utf-8\"><title>Keyring</title><style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0a0a0c;color:#fafafa;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}div{text-align:center}h1{font-weight:600;font-size:18px}p{color:#a3a3a3;font-size:14px;margin-top:8px}</style></head><body><div><h1>Keyring linked your account.</h1><p>You can close this tab and return to Keyring.</p></div></body></html>";
const ERROR_HTML: &str = "<!doctype html><html><head><meta charset=\"utf-8\"><title>Keyring</title></head><body><h1>Authorization failed.</h1><p>Return to Keyring and try again.</p></body></html>";

#[derive(Serialize)]
pub struct OAuthResult {
    pub code: String,
    pub code_verifier: String,
    pub redirect_uri: String,
}

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Generate a 32-byte PKCE code verifier + its S256 challenge.
fn make_pkce() -> (String, String) {
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    let verifier = b64url(&buf);
    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    let challenge = b64url(&hasher.finalize());
    (verifier, challenge)
}

fn make_state() -> String {
    let mut buf = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut buf);
    b64url(&buf)
}

/// Run the full PKCE loopback dance. Blocks the calling task for up to 5
/// minutes; resolves the moment Google hits the loopback redirect.
#[tauri::command]
pub async fn start_google_oauth(
    app: tauri::AppHandle,
    client_id: String,
    scopes: String,
) -> Result<OAuthResult, String> {
    if client_id.trim().is_empty() {
        return Err(
            "VITE_GOOGLE_OAUTH_CLIENT_ID is not set. Add your Google Cloud OAuth client id to .env.local and rebuild."
                .to_string(),
        );
    }

    let (verifier, challenge) = make_pkce();
    let state = make_state();

    // Bind to a kernel-chosen port so we never collide.
    let server = tiny_http::Server::http("127.0.0.1:0")
        .map_err(|e| format!("Could not bind loopback listener: {e}"))?;
    let port = server.server_addr().to_ip().map(|a| a.port()).ok_or_else(|| {
        "Loopback listener has no IP address (this should never happen)".to_string()
    })?;
    let redirect_uri = format!("http://127.0.0.1:{port}/cb");

    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("response_type", "code")
        .append_pair("client_id", &client_id)
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("scope", &scopes)
        .append_pair("state", &state)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        // offline + consent = refresh token issued every time
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent")
        .finish();
    let auth_url = format!("https://accounts.google.com/o/oauth2/v2/auth?{query}");

    // Open the system browser via tauri-plugin-shell. We rely on the user's
    // default browser (Opera in this user's setup) being able to handle https URLs.
    {
        use tauri_plugin_shell::ShellExt;
        app.shell()
            .open(auth_url.clone(), None)
            .map_err(|e| format!("Could not open browser: {e}"))?;
    }

    // Run the blocking accept loop on a worker so we don't pin the tokio runtime.
    let expected_state = state.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let deadline = std::time::Instant::now() + Duration::from_secs(LISTEN_DEADLINE_SECS);
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                return Err("OAuth window expired (5 minutes). Try again.".to_string());
            }
            let req = match server.recv_timeout(remaining) {
                Ok(Some(req)) => req,
                Ok(None) => continue,
                Err(e) => return Err(format!("Loopback listener error: {e}")),
            };
            // Parse ?code=&state= from the request URL.
            let url_str = req.url().to_string();
            let parsed = url::Url::parse(&format!("http://127.0.0.1{url_str}"))
                .map_err(|e| format!("Bad redirect URL: {e}"))?;
            let mut code: Option<String> = None;
            let mut state_in: Option<String> = None;
            let mut oauth_err: Option<String> = None;
            for (k, v) in parsed.query_pairs() {
                match k.as_ref() {
                    "code" => code = Some(v.into_owned()),
                    "state" => state_in = Some(v.into_owned()),
                    "error" => oauth_err = Some(v.into_owned()),
                    _ => {}
                }
            }
            // Ignore favicon / unrelated paths.
            if parsed.path() != "/cb" {
                let _ = req.respond(
                    tiny_http::Response::from_string("Not found").with_status_code(404),
                );
                continue;
            }
            if let Some(err) = oauth_err {
                let _ = req.respond(
                    tiny_http::Response::from_string(ERROR_HTML)
                        .with_header(
                            "Content-Type: text/html; charset=utf-8".parse::<tiny_http::Header>().unwrap(),
                        )
                        .with_status_code(400),
                );
                return Err(format!("Google returned error: {err}"));
            }
            let Some(code) = code else {
                let _ = req.respond(tiny_http::Response::from_string(ERROR_HTML).with_status_code(400));
                return Err("Missing `code` in redirect".to_string());
            };
            if state_in.as_deref() != Some(expected_state.as_str()) {
                let _ = req.respond(tiny_http::Response::from_string(ERROR_HTML).with_status_code(400));
                return Err("OAuth state mismatch (possible CSRF). Try again.".to_string());
            }
            let resp = tiny_http::Response::from_string(SUCCESS_HTML).with_header(
                "Content-Type: text/html; charset=utf-8".parse::<tiny_http::Header>().unwrap(),
            );
            let _ = req.respond(resp);
            return Ok(code);
        }
    })
    .await
    .map_err(|e| format!("OAuth task failed to join: {e}"))??;

    Ok(OAuthResult {
        code: result,
        code_verifier: verifier,
        redirect_uri,
    })
}
