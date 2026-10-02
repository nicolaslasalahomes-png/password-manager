//! KEY-2FA-2: keep watching Gmail for 2FA codes while the vault is locked.
//!
//! Nicolas's rule (List 71, N55): "While the vault is locked yes, while its
//! 2FA locked no". So:
//!   - Ordinary vault lock (idle auto-lock, Lock pressed): the app keeps
//!     polling Gmail and popping fresh codes.
//!   - The account 2FA lock (signed out, or the email code owed after a
//!     fresh sign-in or app launch): no polling and no Gmail tokens held.
//!
//! How: while the vault is unlocked, the main window decrypts each linked
//! account's refresh token and arms this module with it. The tokens then live
//! ONLY here, in Rust process memory: never written to disk, never handed back
//! to any webview. While locked, the main window asks for read-only Gmail
//! calls by account id and path (`gmail_watch_get`); Rust adds the access
//! token itself. Only three read paths are allowed (profile, history,
//! one message). No new hosts: Gmail's API and Google's token endpoint are
//! the same ones the app already calls.
//!
//! Wiped (bytes zeroed) on: `gmail_watch_wipe` (sign-out, email-code lock),
//! a re-arm for a different user, and app exit. Nothing survives a quit.

use std::collections::HashMap;
use std::io::Read;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

const GMAIL_BASE: &str = "https://gmail.googleapis.com/gmail/v1/users/me";
const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);
/// Same 30 s safety margin as the JS side (oauth.ts refreshAccessToken).
const EXPIRY_MARGIN: Duration = Duration::from_secs(30);
/// Cap on a single Gmail reply (a full message with inline parts).
const MAX_BODY_BYTES: u64 = 25 * 1024 * 1024;
/// Only the main window runs the poller.
pub const ALLOWED_WINDOW: &str = "main";

/// A secret string whose bytes are zeroed when dropped.
pub struct Secret(String);

impl Secret {
    pub fn new(s: String) -> Self {
        Secret(s)
    }
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl Drop for Secret {
    fn drop(&mut self) {
        // SAFETY: writing zero bytes keeps the String valid UTF-8.
        unsafe {
            for b in self.0.as_bytes_mut() {
                std::ptr::write_volatile(b, 0);
            }
        }
    }
}

struct Account {
    refresh: Secret,
    access: Option<(Secret, Instant)>,
}

struct Armed {
    user_id: String,
    client_id: String,
    client_secret: Secret,
    accounts: HashMap<String, Account>,
    /// Bumped on every arm/wipe so an in-flight refresh can tell its result
    /// belongs to a state that no longer exists.
    generation: u64,
}

#[derive(Default, Clone)]
pub struct GmailWatch {
    inner: Arc<Mutex<Option<Armed>>>,
    generation: Arc<Mutex<u64>>,
}

#[derive(Deserialize)]
pub struct ArmAccount {
    pub id: String,
    pub refresh_token: String,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct GmailReply {
    pub status: u16,
    pub body: String,
}

impl GmailWatch {
    fn next_generation(&self) -> u64 {
        let mut g = self.generation.lock().unwrap_or_else(|e| e.into_inner());
        *g += 1;
        *g
    }

    /// Replace the armed set. Keeps a cached access token only when the
    /// refresh token for that account is unchanged and the user is the same.
    pub fn arm(
        &self,
        user_id: String,
        client_id: String,
        client_secret: String,
        accounts: Vec<ArmAccount>,
    ) {
        let generation = self.next_generation();
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let mut old = guard.take();
        let mut next = HashMap::new();
        for a in accounts {
            let keep_access = old
                .as_mut()
                .filter(|o| o.user_id == user_id)
                .and_then(|o| o.accounts.remove(&a.id))
                .filter(|prev| prev.refresh.expose() == a.refresh_token)
                .and_then(|mut prev| prev.access.take());
            next.insert(
                a.id,
                Account {
                    refresh: Secret::new(a.refresh_token),
                    access: keep_access,
                },
            );
        }
        // `old` (and every secret in it) is zeroed as it drops here.
        drop(old);
        *guard = Some(Armed {
            user_id,
            client_id,
            client_secret: Secret::new(client_secret),
            accounts: next,
            generation,
        });
    }

    /// Drop and zero everything.
    pub fn wipe(&self) {
        self.next_generation();
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        *guard = None;
    }

    /// Ids of the armed accounts (no secrets).
    pub fn account_ids(&self) -> Vec<String> {
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let mut ids: Vec<String> = guard
            .as_ref()
            .map(|a| a.accounts.keys().cloned().collect())
            .unwrap_or_default();
        ids.sort();
        ids
    }

    #[cfg(test)]
    pub fn is_armed(&self) -> bool {
        self.inner
            .lock()
            .map(|g| g.is_some())
            .unwrap_or(false)
    }

    /// A still-valid cached access token, or what is needed to refresh one.
    fn token_or_refresh_material(
        &self,
        account_id: &str,
    ) -> Result<Result<Secret, (Secret, String, Secret, u64)>, String> {
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let armed = guard.as_ref().ok_or("Gmail watch is not armed")?;
        let acct = armed
            .accounts
            .get(account_id)
            .ok_or("Account is not armed")?;
        if let Some((tok, exp)) = &acct.access {
            if Instant::now() < *exp {
                return Ok(Ok(Secret::new(tok.expose().to_string())));
            }
        }
        Ok(Err((
            Secret::new(acct.refresh.expose().to_string()),
            armed.client_id.clone(),
            Secret::new(armed.client_secret.expose().to_string()),
            armed.generation,
        )))
    }

    fn store_access(&self, account_id: &str, generation: u64, token: &str, expires: Instant) {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(armed) = guard.as_mut() {
            if armed.generation != generation {
                return; // wiped or re-armed meanwhile: discard
            }
            if let Some(acct) = armed.accounts.get_mut(account_id) {
                acct.access = Some((Secret::new(token.to_string()), expires));
            }
        }
    }

    fn forget_access(&self, account_id: &str) {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(acct) = guard.as_mut().and_then(|a| a.accounts.get_mut(account_id)) {
            acct.access = None;
        }
    }
}

/// The only Gmail reads allowed through the watch. Returns the full URL.
///   /profile
///   /history?startHistoryId=<digits>&historyTypes=messageAdded
///   /messages/<id>?format=full
pub fn checked_gmail_url(path: &str) -> Result<String, String> {
    let bad = || format!("Path not allowed: {path}");
    let (p, q) = match path.split_once('?') {
        Some((p, q)) => (p, Some(q)),
        None => (path, None),
    };
    if p == "/profile" && q.is_none() {
        return Ok(format!("{GMAIL_BASE}{path}"));
    }
    if p == "/history" {
        let q = q.ok_or_else(bad)?;
        let mut start = false;
        for pair in q.split('&') {
            match pair.split_once('=') {
                Some(("startHistoryId", v))
                    if !start && !v.is_empty() && v.len() <= 32 && v.bytes().all(|b| b.is_ascii_digit()) =>
                {
                    start = true
                }
                Some(("historyTypes", "messageAdded")) => {}
                _ => return Err(bad()),
            }
        }
        if !start {
            return Err(bad());
        }
        return Ok(format!("{GMAIL_BASE}{path}"));
    }
    if let Some(id) = p.strip_prefix("/messages/") {
        let id_ok = !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric());
        if id_ok && q == Some("format=full") {
            return Ok(format!("{GMAIL_BASE}{path}"));
        }
    }
    Err(bad())
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout(HTTP_TIMEOUT).build()
}

fn read_body(resp: ureq::Response) -> String {
    let mut s = String::new();
    let _ = resp.into_reader().take(MAX_BODY_BYTES).read_to_string(&mut s);
    s
}

enum Refreshed {
    Ok(Secret, Instant),
    Reauth,
    Failed(String),
}

fn refresh_blocking(refresh: &Secret, client_id: &str, client_secret: &Secret) -> Refreshed {
    let res = agent().post(TOKEN_ENDPOINT).send_form(&[
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh.expose()),
        ("client_id", client_id),
        ("client_secret", client_secret.expose()),
    ]);
    match res {
        Ok(resp) => {
            let body = Secret::new(read_body(resp));
            let parsed: serde_json::Value = match serde_json::from_str(body.expose()) {
                Ok(v) => v,
                Err(e) => return Refreshed::Failed(format!("token reply unreadable: {e}")),
            };
            let tok = parsed.get("access_token").and_then(|v| v.as_str());
            let secs = parsed.get("expires_in").and_then(|v| v.as_u64()).unwrap_or(3600);
            match tok {
                Some(t) => {
                    let life = Duration::from_secs(secs).saturating_sub(EXPIRY_MARGIN);
                    Refreshed::Ok(Secret::new(t.to_string()), Instant::now() + life)
                }
                None => Refreshed::Failed("token reply had no access_token".into()),
            }
        }
        Err(ureq::Error::Status(400, r)) => {
            if read_body(r).contains("invalid_grant") {
                Refreshed::Reauth
            } else {
                Refreshed::Failed("token refresh failed (400)".into())
            }
        }
        Err(ureq::Error::Status(code, _)) => Refreshed::Failed(format!("token refresh failed ({code})")),
        Err(e) => Refreshed::Failed(format!("token refresh failed: {e}")),
    }
}

fn gmail_get_blocking(url: &str, token: &Secret) -> Result<GmailReply, String> {
    let auth = Secret::new(format!("Bearer {}", token.expose()));
    match agent().get(url).set("Authorization", auth.expose()).call() {
        Ok(resp) => {
            let status = resp.status();
            Ok(GmailReply { status, body: read_body(resp) })
        }
        Err(ureq::Error::Status(code, r)) => Ok(GmailReply { status: code, body: read_body(r) }),
        Err(e) => Err(format!("Gmail request failed: {e}")),
    }
}

/// One read-only Gmail call for an armed account. Refreshes the access token
/// as needed and retries once on 401. A dead refresh token comes back as
/// status 401 with body "REAUTH_REQUIRED".
pub fn get_blocking(watch: &GmailWatch, account_id: &str, path: &str) -> Result<GmailReply, String> {
    let url = checked_gmail_url(path)?;
    for attempt in 0..2 {
        let token = match watch.token_or_refresh_material(account_id)? {
            Ok(tok) => tok,
            Err((refresh, client_id, client_secret, generation)) => {
                match refresh_blocking(&refresh, &client_id, &client_secret) {
                    Refreshed::Ok(tok, exp) => {
                        watch.store_access(account_id, generation, tok.expose(), exp);
                        tok
                    }
                    Refreshed::Reauth => {
                        return Ok(GmailReply { status: 401, body: "REAUTH_REQUIRED".into() })
                    }
                    Refreshed::Failed(msg) => return Err(msg),
                }
            }
        };
        let reply = gmail_get_blocking(&url, &token)?;
        if reply.status == 401 && attempt == 0 {
            watch.forget_access(account_id);
            continue;
        }
        return Ok(reply);
    }
    unreachable!("loop returns on the second attempt")
}

fn require_main(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == ALLOWED_WINDOW {
        Ok(())
    } else {
        Err("Not allowed from this window".into())
    }
}

#[tauri::command]
pub fn gmail_watch_arm(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, GmailWatch>,
    user_id: String,
    client_id: String,
    client_secret: String,
    accounts: Vec<ArmAccount>,
) -> Result<(), String> {
    require_main(&window)?;
    state.arm(user_id, client_id, client_secret, accounts);
    Ok(())
}

#[tauri::command]
pub fn gmail_watch_wipe(state: tauri::State<'_, GmailWatch>) {
    state.wipe();
}

#[tauri::command]
pub fn gmail_watch_accounts(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, GmailWatch>,
) -> Result<Vec<String>, String> {
    require_main(&window)?;
    Ok(state.account_ids())
}

#[tauri::command]
pub async fn gmail_watch_get(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, GmailWatch>,
    account_id: String,
    path: String,
) -> Result<GmailReply, String> {
    require_main(&window)?;
    let watch = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || get_blocking(&watch, &account_id, &path))
        .await
        .map_err(|e| format!("gmail task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn acct(id: &str, tok: &str) -> ArmAccount {
        ArmAccount { id: id.into(), refresh_token: tok.into() }
    }

    #[test]
    fn allows_only_the_three_read_paths() {
        assert!(checked_gmail_url("/profile").is_ok());
        assert!(checked_gmail_url("/history?startHistoryId=123&historyTypes=messageAdded").is_ok());
        assert!(checked_gmail_url("/messages/18c2abcDEF09?format=full").is_ok());

        for bad in [
            "/messages/abc/modify",
            "/messages/abc/trash",
            "/messages/abc?format=raw",
            "/messages/abc",
            "/messages?q=in:inbox",
            "/messages/abc/attachments/x",
            "/messages/../profile?format=full",
            "/history",
            "/history?startHistoryId=12x&historyTypes=messageAdded",
            "/history?startHistoryId=1&labelId=SPAM",
            "/history?startHistoryId=1&startHistoryId=2",
            "/profile?x=1",
            "/drafts",
            "https://evil.example/profile",
            "",
        ] {
            assert!(checked_gmail_url(bad).is_err(), "should refuse {bad}");
        }
        assert!(checked_gmail_url("/profile").unwrap().starts_with(GMAIL_BASE));
    }

    #[test]
    fn arm_then_wipe_holds_nothing() {
        let w = GmailWatch::default();
        assert!(!w.is_armed());
        w.arm("u1".into(), "cid".into(), "sec".into(), vec![acct("a", "r1"), acct("b", "r2")]);
        assert!(w.is_armed());
        assert_eq!(w.account_ids(), vec!["a".to_string(), "b".to_string()]);
        w.wipe();
        assert!(!w.is_armed());
        assert!(w.account_ids().is_empty());
        assert!(get_blocking(&w, "a", "/profile").is_err());
    }

    #[test]
    fn rearm_keeps_access_only_for_same_user_and_token() {
        let w = GmailWatch::default();
        w.arm("u1".into(), "cid".into(), "sec".into(), vec![acct("a", "r1"), acct("b", "r2")]);
        let gen = w.inner.lock().unwrap().as_ref().unwrap().generation;
        let later = Instant::now() + Duration::from_secs(600);
        w.store_access("a", gen, "at-a", later);
        w.store_access("b", gen, "at-b", later);

        // Same user; a's token unchanged, b's refresh token replaced.
        w.arm("u1".into(), "cid".into(), "sec".into(), vec![acct("a", "r1"), acct("b", "r2-new")]);
        assert!(matches!(w.token_or_refresh_material("a").unwrap(), Ok(t) if t.expose() == "at-a"));
        assert!(w.token_or_refresh_material("b").unwrap().is_err());

        // A different user never inherits anything.
        w.arm("u2".into(), "cid".into(), "sec".into(), vec![acct("a", "r1")]);
        assert!(w.token_or_refresh_material("a").unwrap().is_err());
    }

    #[test]
    fn refresh_result_from_a_wiped_state_is_discarded() {
        let w = GmailWatch::default();
        w.arm("u1".into(), "cid".into(), "sec".into(), vec![acct("a", "r1")]);
        let stale_gen = w.inner.lock().unwrap().as_ref().unwrap().generation;
        w.wipe();
        w.arm("u1".into(), "cid".into(), "sec".into(), vec![acct("a", "r1")]);
        w.store_access("a", stale_gen, "late", Instant::now() + Duration::from_secs(600));
        assert!(w.token_or_refresh_material("a").unwrap().is_err());
    }

    #[test]
    fn unknown_account_is_refused() {
        let w = GmailWatch::default();
        w.arm("u1".into(), "cid".into(), "sec".into(), vec![acct("a", "r1")]);
        assert!(get_blocking(&w, "zzz", "/profile").is_err());
    }
}
