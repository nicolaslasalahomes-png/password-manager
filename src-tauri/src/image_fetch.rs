//! Fetch a remote email image from Rust and hand it back as base64.
//!
//! Used by the inbox "Load images" button. Fetching here instead of letting
//! the email iframe load the URL directly means: no CORS, no mixed-content
//! blocks on `http://` images, no Referer leak, and the sender's server only
//! sees a request when the user asks for images.
//!
//! Guard rails: http/https only, every hop (redirects included) must resolve
//! to a public IP (an email can't make us probe the LAN or localhost), 10s
//! timeout, 8 MB cap, and the bytes must actually be an image.

use std::io::Read;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::time::Duration;

use base64::Engine;
use serde::Serialize;

const MAX_BYTES: u64 = 8 * 1024 * 1024;
const MAX_REDIRECTS: usize = 5;
const USER_AGENT: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

#[derive(Serialize)]
pub struct FetchedImage {
    mime: String,
    base64: String,
}

fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            !(v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast()
                || v4.is_documentation()
                || o[0] == 0
                || (o[0] == 100 && (64..=127).contains(&o[1])) // CGNAT
                || (o[0] == 198 && (o[1] == 18 || o[1] == 19))) // benchmarking
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public(IpAddr::V4(v4));
            }
            let seg0 = v6.segments()[0];
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (seg0 & 0xfe00) == 0xfc00 // unique local
                || (seg0 & 0xffc0) == 0xfe80) // link local
        }
    }
}

/// Resolve `host:port` and refuse unless EVERY address is public. The HTTP
/// client connects only to addresses returned here, so a DNS answer can't
/// change between the check and the connection (no rebinding to the LAN).
fn resolve_public(netloc: &str) -> std::io::Result<Vec<SocketAddr>> {
    let addrs: Vec<SocketAddr> = netloc.to_socket_addrs()?.collect();
    if addrs.is_empty() || !addrs.iter().all(|a| is_public(a.ip())) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!("{netloc} is not a public address"),
        ));
    }
    Ok(addrs)
}

fn check_url(raw: &str) -> Result<url::Url, String> {
    let u = url::Url::parse(raw).map_err(|e| format!("bad url: {e}"))?;
    if u.scheme() != "http" && u.scheme() != "https" {
        return Err("only http/https images can be fetched".into());
    }
    let host = u.host_str().ok_or("url has no host")?;
    let port = u.port_or_known_default().unwrap_or(443);
    let netloc = match u.host() {
        Some(url::Host::Ipv6(v6)) => format!("[{v6}]:{port}"),
        _ => format!("{host}:{port}"),
    };
    resolve_public(&netloc).map_err(|e| e.to_string())?;
    Ok(u)
}

fn sniff_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF8") {
        Some("image/gif")
    } else if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.starts_with(b"BM") {
        Some("image/bmp")
    } else if bytes.starts_with(b"\x00\x00\x01\x00") {
        Some("image/x-icon")
    } else {
        None
    }
}

fn fetch_blocking(raw: String) -> Result<FetchedImage, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(10))
        .redirects(0)
        .resolver(resolve_public)
        .user_agent(USER_AGENT)
        .build();

    let mut current = raw;
    for _ in 0..=MAX_REDIRECTS {
        let u = check_url(&current)?;
        let resp = match agent.get(u.as_str()).set("Accept", "image/*,*/*;q=0.5").call() {
            Ok(r) => r,
            Err(ureq::Error::Status(code, r)) if (300..400).contains(&code) => r,
            Err(ureq::Error::Status(code, _)) => return Err(format!("HTTP {code}")),
            Err(e) => return Err(format!("fetch failed: {e}")),
        };
        if (300..400).contains(&resp.status()) {
            let loc = resp.header("Location").ok_or("redirect without Location")?;
            current = u.join(loc).map_err(|e| format!("bad redirect: {e}"))?.to_string();
            continue;
        }

        let declared = resp
            .content_type()
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        let mut bytes = Vec::new();
        resp.into_reader()
            .take(MAX_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| format!("read failed: {e}"))?;
        if bytes.len() as u64 > MAX_BYTES {
            return Err("image larger than 8 MB".into());
        }
        let mime = if declared.starts_with("image/") {
            declared
        } else {
            sniff_mime(&bytes).ok_or("response is not an image")?.to_string()
        };
        return Ok(FetchedImage {
            mime,
            base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        });
    }
    Err("too many redirects".into())
}

#[tauri::command]
pub async fn fetch_image(url: String) -> Result<FetchedImage, String> {
    tauri::async_runtime::spawn_blocking(move || fetch_blocking(url))
        .await
        .map_err(|e| format!("fetch task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_public_and_non_http() {
        assert!(check_url("http://127.0.0.1/a.png").is_err());
        assert!(check_url("http://localhost/a.png").is_err());
        assert!(check_url("http://192.168.1.1/a.png").is_err());
        assert!(check_url("http://[::1]/a.png").is_err());
        assert!(check_url("http://169.254.169.254/latest").is_err());
        assert!(check_url("file:///etc/passwd").is_err());
        assert!(check_url("data:image/png;base64,AAAA").is_err());
    }

    #[test]
    fn sniffs_common_formats() {
        assert_eq!(sniff_mime(b"\x89PNG\r\n\x1a\n"), Some("image/png"));
        assert_eq!(sniff_mime(b"\xff\xd8\xff\xe0"), Some("image/jpeg"));
        assert_eq!(sniff_mime(b"<html>"), None);
    }
}

#[cfg(test)]
mod live_tests {
    use super::*;

    /// Hits the network; run with `cargo test --lib image_fetch -- --ignored`.
    #[test]
    #[ignore]
    fn fetches_real_images() {
        let https = fetch_blocking(
            "https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png".into(),
        )
        .unwrap();
        assert_eq!(https.mime, "image/png");
        // Plain http + redirect to https.
        let http = fetch_blocking("http://www.google.com/favicon.ico".into()).unwrap();
        assert!(http.mime.starts_with("image/"), "{}", http.mime);
        assert!(fetch_blocking("https://www.google.com/".into()).is_err());
    }
}
