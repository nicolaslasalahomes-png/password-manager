/**
 * Email HTML → a locked-down iframe document, with image handling modelled on
 * the business console's email viewer:
 *
 * - `cid:` inline images are swapped for data: URLs (fetched from Gmail).
 * - Remote images are blocked by a CSP until the user presses "Load images",
 *   so tracking pixels don't fire on open. On desktop the images are then
 *   fetched by Rust (`fetch_image`) and inlined, which also fixes `http://`
 *   and hotlink-protected images that the webview can't load itself.
 * - The email's own scripts never run: they're stripped, and the CSP only
 *   allows our one nonce'd helper script (link interception + height).
 */

import { isDesktop } from './desktop'

const REMOTE_RE = /^https?:\/\//i
const MAX_REMOTE_IMAGES = 80
const FETCH_CONCURRENCY = 6

/** Unique remote <img> URLs in the email, in document order. */
export function listRemoteImageUrls(html: string): string[] {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const urls = new Set<string>()
  doc.querySelectorAll('img[src]').forEach((img) => {
    const src = img.getAttribute('src')?.trim() ?? ''
    if (REMOTE_RE.test(src)) urls.add(src)
  })
  return Array.from(urls)
}

/** True when the email references remote content the CSP will block. */
export function hasRemoteContent(html: string): boolean {
  if (listRemoteImageUrls(html).length > 0) return true
  return /(background\s*=\s*["']?https?:|url\(\s*["']?https?:)/i.test(html)
}

async function fetchOne(url: string): Promise<string | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const res = await invoke<{ mime: string; base64: string }>('fetch_image', { url })
    return `data:${res.mime};base64,${res.base64}`
  } catch (err) {
    console.warn('[email-images] fetch failed', url, err)
    return null
  }
}

/**
 * Fetch remote images through Rust. Returns url → data: URL for the ones that
 * worked; failures fall back to the browser loading the URL directly (the CSP
 * allows it once images are switched on).
 */
export async function fetchRemoteImages(urls: string[]): Promise<Record<string, string>> {
  if (!isDesktop()) return {}
  const queue = urls.slice(0, MAX_REMOTE_IMAGES)
  const out: Record<string, string> = {}
  const worker = async () => {
    for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
      const dataUrl = await fetchOne(url)
      if (dataUrl) out[url] = dataUrl
    }
  }
  await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, worker))
  return out
}

export interface BuildOptions {
  /** contentId (no angle brackets) → data: URL */
  cidImages: Record<string, string>
  /** remote url → data: URL, from fetchRemoteImages */
  remoteImages: Record<string, string>
  allowRemote: boolean
  nonce: string
}

export function buildEmailDocument(html: string, opts: BuildOptions): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')

  doc
    .querySelectorAll('script, iframe, frame, frameset, object, embed, applet, base, meta[http-equiv]')
    .forEach((el) => el.remove())
  doc.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name)
    }
  })

  doc.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src')?.trim() ?? ''
    if (/^cid:/i.test(src)) {
      const cid = decodeURIComponent(src.slice(4)).replace(/^<|>$/g, '')
      const dataUrl = opts.cidImages[cid]
      if (dataUrl) img.setAttribute('src', dataUrl)
    } else if (REMOTE_RE.test(src) && opts.remoteImages[src]) {
      img.setAttribute('src', opts.remoteImages[src])
    }
    // srcset would bypass the inlined src with a remote fetch; drop it.
    img.removeAttribute('srcset')
  })

  const remote = opts.allowRemote ? ' https: http:' : ''
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${opts.nonce}'`,
    `img-src data: blob:${remote}`,
    `style-src 'unsafe-inline'${remote}`,
    `font-src data:${remote}`,
  ].join('; ')

  const head = `<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<base target="_blank">
<style>
  html, body { margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 16px; color: #1f2937; background: #ffffff; word-wrap: break-word; }
  img { max-width: 100%; height: auto; }
  table { max-width: 100% !important; }
  a { color: #2563eb; }
</style>`

  const script = doc.createElement('script')
  script.setAttribute('nonce', opts.nonce)
  script.textContent = HELPER_SCRIPT
  doc.body.appendChild(script)

  // Keep the email's own <head> styles and <body> attributes (bgcolor etc.);
  // ours go first so the CSP applies before anything else is parsed.
  return `<!DOCTYPE html>
<html>
<head>
${head}
${doc.head.innerHTML}
</head>
${doc.body.outerHTML}
</html>`
}

const HELPER_SCRIPT = `
  document.addEventListener('click', function(e) {
    var a = e.target && e.target.closest ? e.target.closest('a') : null;
    if (a && a.href) {
      e.preventDefault();
      e.stopPropagation();
      try { parent.postMessage({ type: 'keyring:open-url', url: a.href }, '*'); } catch (err) {}
    }
  }, true);
  function reportHeight() {
    var h = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    try { parent.postMessage({ type: 'keyring:height', height: h }, '*'); } catch (err) {}
  }
  window.addEventListener('load', reportHeight);
  setTimeout(reportHeight, 50);
  setTimeout(reportHeight, 300);
  setTimeout(reportHeight, 1000);
  document.querySelectorAll('img').forEach(function(img) {
    img.addEventListener('load', reportHeight);
    img.addEventListener('error', reportHeight);
  });
`

export function newNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
