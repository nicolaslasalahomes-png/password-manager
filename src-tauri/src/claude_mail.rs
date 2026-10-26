//! KEY-MAIL-1: a read-only mail connection for Claude on this Mac.
//!
//! Nicolas (26 Oct 2026): Keyring has all his Gmail accounts combined, so Claude
//! should read mail through Keyring instead of screenshots of its window. This
//! serves the accounts the Gmail watch already holds (gmail_watch.rs) to a
//! local client (scripts/keyring-mail.mjs), never to the network:
//!
//!   - Listens on 127.0.0.1 only, on a random port, for as long as the app runs.
//!   - Every request needs the bearer token in ~/.config/keyring-claude/mail.json
//!     (dir 700, file 600, rewritten with a fresh token on every launch,
//!     removed on exit). Host must be 127.0.0.1/localhost:<port> and there must
//!     be no Origin header, so a web page cannot reach it (DNS rebinding, CSRF).
//!   - GET only, and only the READ paths in `checked_claude_url`: search, a
//!     message, its attachments, threads, drafts, labels, profile. Never
//!     modify, trash, send or anything that writes.
//!   - Off unless the Settings switch is on (the app tells Rust at start-up),
//!     and only while the watch is armed: nothing after a sign-out or while the
//!     email code is owed.
//!   - Each request is logged (time, account, path; no content) to
//!     ~/.config/keyring-claude/access.log, and Settings shows the count.

use std::fs;
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::gmail_watch::{self, GmailWatch, GMAIL_BASE};

#[derive(Default, Clone)]
pub struct ClaudeMail {
    inner: Arc<Inner>,
}

#[derive(Default)]
struct Inner {
    enabled: AtomicBool,
    running: AtomicBool,
    requests: AtomicU64,
    last_access_ms: AtomicU64,
}

#[derive(Serialize)]
pub struct ClaudeMailStatus {
    pub enabled: bool,
    pub running: bool,
    pub requests: u64,
    pub last_access_ms: u64,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config/keyring-claude"))
}

/// URL-encoded query value: what encodeURIComponent produces, nothing that could split the query.
fn ok_value(v: &str, max: usize) -> bool {
    !v.is_empty()
        && v.len() <= max
        && v.bytes().all(|b| b.is_ascii_alphanumeric() || b"%-_.!~*'()+".contains(&b))
}

fn ok_id(v: &str, max: usize) -> bool {
    !v.is_empty() && v.len() <= max && v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Check every query pair against `allowed(key, value)`; at most 20 pairs.
fn query_ok(q: Option<&str>, allowed: impl Fn(&str, &str) -> bool) -> bool {
    match q {
        None => true,
        Some(q) => {
            let pairs: Vec<&str> = q.split('&').collect();
            pairs.len() <= 20
                && pairs.iter().all(|p| matches!(p.split_once('='), Some((k, v)) if allowed(k, v)))
        }
    }
}

fn format_ok(k: &str, v: &str) -> bool {
    match k {
        "format" => matches!(v, "full" | "metadata" | "minimal"),
        "metadataHeaders" => ok_value(v, 64),
        _ => false,
    }
}

/// The only Gmail reads Claude may make. Returns the full URL.
///   /profile, /labels
///   /messages?q=&maxResults=&pageToken=&labelIds=&includeSpamTrash=
///   /messages/<id>?format=full|metadata|minimal[&metadataHeaders=..]
///   /messages/<id>/attachments/<attachmentId>
///   /threads/<id>?format=..[&metadataHeaders=..]
///   /drafts?q=&maxResults=&pageToken=
///   /drafts/<id>?format=full|metadata|minimal
pub fn checked_claude_url(path: &str) -> Result<String, String> {
    let bad = || format!("Path not allowed: {path}");
    let (p, q) = match path.split_once('?') {
        Some((p, q)) => (p, Some(q)),
        None => (path, None),
    };
    if path.contains("..") || path.contains('#') || !p.starts_with('/') {
        return Err(bad());
    }
    let segs: Vec<&str> = p[1..].split('/').collect();
    let list_ok = |k: &str, v: &str| match k {
        "q" => ok_value(v, 1000),
        "maxResults" => !v.is_empty() && v.len() <= 3 && v.bytes().all(|b| b.is_ascii_digit()),
        "pageToken" => ok_id(v, 256),
        _ => false,
    };
    let ok = match segs.as_slice() {
        ["profile"] | ["labels"] => q.is_none(),
        ["messages"] => query_ok(q, |k, v| {
            list_ok(k, v)
                || (k == "labelIds" && ok_id(v, 64))
                || (k == "includeSpamTrash" && matches!(v, "true" | "false"))
        }),
        ["messages", id] | ["threads", id] | ["drafts", id] => {
            ok_id(id, 64) && q.is_some() && query_ok(q, format_ok)
        }
        ["messages", id, "attachments", att] => ok_id(id, 64) && ok_id(att, 2048) && q.is_none(),
        ["drafts"] => query_ok(q, list_ok),
        _ => false,
    };
    if ok {
        Ok(format!("{GMAIL_BASE}{path}"))
    } else {
        Err(bad())
    }
}

/// Constant-time equality, so the token cannot be guessed byte by byte from timings.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
}

/// Pull a query parameter (already URL-encoded) out of a request URL.
fn param<'a>(url: &'a str, key: &str) -> Option<&'a str> {
    url.split_once('?')?.1.split('&').find_map(|p| p.strip_prefix(key)?.strip_prefix('='))
}

fn decode(v: &str) -> String {
    let b = v.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' if i + 2 < b.len() => {
                match u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or("zz"), 16) {
                    Ok(x) => {
                        out.push(x);
                        i += 3;
                        continue;
                    }
                    Err(_) => out.push(b'%'),
                }
            }
            b'+' => out.push(b' '),
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn log_access(account: &str, path: &str) {
    let Some(d) = dir() else { return };
    let line = format!("{} {} {}\n", now_ms() / 1000, account, path);
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).mode(0o600).open(d.join("access.log")) {
        let _ = f.write_all(line.as_bytes());
    }
}

/// Write mail.json (port + token), owner-only, atomically.
fn write_handle(port: u16, token: &str) -> Result<(), String> {
    let d = dir().ok_or("no HOME")?;
    fs::DirBuilder::new().recursive(true).mode(0o700).create(&d).map_err(|e| e.to_string())?;
    let tmp = d.join("mail.json.tmp");
    let body = serde_json::json!({ "port": port, "token": token, "pid": std::process::id() }).to_string();
    {
        let mut f = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)
            .map_err(|e| e.to_string())?;
        f.write_all(body.as_bytes()).map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, d.join("mail.json")).map_err(|e| e.to_string())
}

/// Remove the handle so a stale port/token is never left behind.
pub fn remove_handle() {
    if let Some(d) = dir() {
        let _ = fs::remove_file(d.join("mail.json"));
    }
}

fn reply(req: tiny_http::Request, status: u16, body: String) {
    let ct = tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).expect("static header");
    let _ = req.respond(tiny_http::Response::from_string(body).with_status_code(status).with_header(ct));
}

fn err(req: tiny_http::Request, status: u16, msg: &str) {
    reply(req, status, serde_json::json!({ "error": msg }).to_string());
}

fn handle(req: tiny_http::Request, state: &ClaudeMail, watch: &GmailWatch, port: u16, token: &str) {
    let header = |name: &str| {
        req.headers()
            .iter()
            .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
            .map(|h| h.value.as_str().to_string())
    };
    let host_ok = matches!(header("Host"), Some(h) if h == format!("127.0.0.1:{port}") || h == format!("localhost:{port}"));
    if *req.method() != tiny_http::Method::Get || !host_ok || header("Origin").is_some() {
        return err(req, 403, "forbidden");
    }
    let auth_ok = header("Authorization")
        .map(|a| same(a.as_bytes(), format!("Bearer {token}").as_bytes()))
        .unwrap_or(false);
    if !auth_ok {
        return err(req, 401, "bad token");
    }
    if !state.inner.enabled.load(Ordering::SeqCst) {
        return err(req, 403, "Claude mail access is switched off in Keyring Settings");
    }
    let url = req.url().to_string();
    let route = url.split('?').next().unwrap_or("");
    match route {
        "/accounts" => {
            let list: Vec<_> = watch
                .accounts_with_email()
                .into_iter()
                .map(|(id, email)| serde_json::json!({ "id": id, "email": email }))
                .collect();
            if list.is_empty() {
                return err(req, 409, "Keyring holds no Gmail accounts right now: open Keyring and unlock it");
            }
            reply(req, 200, serde_json::Value::Array(list).to_string())
        }
        "/gmail" => {
            let (Some(account), Some(path)) = (param(&url, "account"), param(&url, "path")) else {
                return err(req, 400, "needs account and path");
            };
            let (account, path) = (decode(account), decode(path));
            let gmail_url = match checked_claude_url(&path) {
                Ok(u) => u,
                Err(e) => return err(req, 400, &e),
            };
            state.inner.requests.fetch_add(1, Ordering::SeqCst);
            state.inner.last_access_ms.store(now_ms(), Ordering::SeqCst);
            log_access(&account, &path);
            match gmail_watch::get_url_blocking(watch, &account, &gmail_url) {
                Ok(r) => reply(req, r.status, r.body),
                Err(e) => err(req, 502, &e),
            }
        }
        _ => err(req, 404, "not found"),
    }
}

/// Start the server for the life of the app. Errors are logged, never fatal.
pub fn start(state: ClaudeMail, watch: GmailWatch) {
    let server = match tiny_http::Server::http("127.0.0.1:0") {
        Ok(s) => s,
        Err(e) => {
            log::warn!("[claude-mail] could not listen: {e}");
            return;
        }
    };
    let port = match server.server_addr().to_ip() {
        Some(a) => a.port(),
        None => return,
    };
    let token: String = {
        use rand::RngCore;
        let mut b = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut b);
        b.iter().map(|x| format!("{x:02x}")).collect()
    };
    if let Err(e) = write_handle(port, &token) {
        log::warn!("[claude-mail] could not write the handle: {e}");
        return;
    }
    state.inner.running.store(true, Ordering::SeqCst);
    let server = Arc::new(server);
    std::thread::spawn(move || {
        for req in server.incoming_requests() {
            let (state, watch, token) = (state.clone(), watch.clone(), token.clone());
            // One thread per request: a slow Gmail call must not hold up the next one.
            std::thread::spawn(move || handle(req, &state, &watch, port, &token));
        }
    });
}

fn require_main(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == gmail_watch::ALLOWED_WINDOW {
        Ok(())
    } else {
        Err("Not allowed from this window".into())
    }
}

#[tauri::command]
pub fn claude_mail_set_enabled(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, ClaudeMail>,
    enabled: bool,
) -> Result<(), String> {
    require_main(&window)?;
    state.inner.enabled.store(enabled, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn claude_mail_status(state: tauri::State<'_, ClaudeMail>) -> ClaudeMailStatus {
    ClaudeMailStatus {
        enabled: state.inner.enabled.load(Ordering::SeqCst),
        running: state.inner.running.load(Ordering::SeqCst),
        requests: state.inner.requests.load(Ordering::SeqCst),
        last_access_ms: state.inner.last_access_ms.load(Ordering::SeqCst),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_only_reads() {
        for good in [
            "/profile",
            "/labels",
            "/messages?q=from%3Ajustin%20newer_than%3A2d&maxResults=20",
            "/messages?q=has%3Aattachment&pageToken=0123abc&labelIds=INBOX&includeSpamTrash=false",
            "/messages/18c2abcDEF09?format=full",
            "/messages/18c2abc?format=metadata&metadataHeaders=Subject&metadataHeaders=From",
            "/messages/18c2abc/attachments/ANGjdJ8-x_y",
            "/threads/18c2abc?format=full",
            "/drafts",
            "/drafts?maxResults=10",
            "/drafts/r-123456789?format=full",
        ] {
            assert!(checked_claude_url(good).is_ok(), "should allow {good}");
        }
        for bad in [
            "/messages/abc/modify",
            "/messages/abc/trash",
            "/messages/abc/untrash",
            "/messages/send",
            "/messages/batchModify",
            "/messages/abc?format=raw",
            "/messages/abc",
            "/drafts/send",
            "/drafts/abc",
            "/threads/abc/modify",
            "/settings/filters",
            "/messages?q=x&pageToken=a/b",
            "/messages?q=a&b",
            "/messages?q=a#x",
            "/messages/../profile?format=full",
            "/profile?x=1",
            "/history?startHistoryId=1",
            "https://evil.example/profile",
            "profile",
            "",
        ] {
            assert!(checked_claude_url(bad).is_err(), "should refuse {bad}");
        }
        assert!(checked_claude_url("/labels").unwrap().starts_with(GMAIL_BASE));
    }

    #[test]
    fn token_compare_and_params() {
        assert!(same(b"Bearer abc", b"Bearer abc"));
        assert!(!same(b"Bearer abc", b"Bearer abd"));
        assert!(!same(b"Bearer abc", b"Bearer abcd"));
        let url = "/gmail?account=acc-1&path=%2Fmessages%3Fq%3Dfrom%253Ajustin";
        assert_eq!(param(url, "account"), Some("acc-1"));
        assert_eq!(decode(param(url, "path").unwrap()), "/messages?q=from%3Ajustin");
        assert_eq!(decode("a+b%2"), "a b%2");
    }
}
